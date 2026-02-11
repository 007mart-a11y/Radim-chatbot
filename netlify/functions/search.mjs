// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID
// Request JSON: { message: string, thread_id?: string }
// Response JSON: { ok: true, answer: string, thread_id: string } | { ok:false, error, details? }

import fs from "node:fs";
import path from "node:path";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

// Kanonické (bezpečné) rozcestníky
const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktualne: "https://www.obec-radim.cz/aktualne/",
  aktuality: "https://www.obec-radim.cz/aktualne/aktuality/",
  kalendar: "https://www.obec-radim.cz/aktualne/kalendar-akci/",
  hledani: "https://www.obec-radim.cz/?hledej=&lang=cs",
};

// ============================================
// ✅ Local knowledge (FULL + LATEST + PEOPLE)
// ============================================

const FULL_FILE_CANDIDATES = [
  "knowledge/99_FULL_obec_radim.txt",
  "public/knowledge/99_FULL_obec_radim.txt",
  "99_FULL_obec_radim.txt",
];

const LATEST_FILE_CANDIDATES = [
  "knowledge/00_LATEST_obec_radim.txt",
  "public/knowledge/00_LATEST_obec_radim.txt",
  "00_LATEST_obec_radim.txt",
];

const PEOPLE_FILE_CANDIDATES = [
  "knowledge/people/00_PEOPLE_obec_radim.txt",
  "public/knowledge/people/00_PEOPLE_obec_radim.txt",
  "knowledge/00_PEOPLE_obec_radim.txt",
  "public/knowledge/00_PEOPLE_obec_radim.txt",
  "00_PEOPLE_obec_radim.txt",
];

let _cache = {
  fullText: null,
  latestText: null,
  peopleText: null,
  loadedAt: 0,
  pages: null,
  docs: null,
  latestItems: null,
  peopleIndex: null,
  urlWhitelist: null,
  kontakty: null,
};

function safeReadText(rel) {
  try {
    const p = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function loadAllLocal() {
  const now = Date.now();
  if (now - _cache.loadedAt < 10 * 60 * 1000 && (_cache.fullText || _cache.latestText || _cache.peopleText)) return;

  _cache.fullText = null;
  _cache.latestText = null;
  _cache.peopleText = null;
  _cache.pages = null;
  _cache.docs = null;
  _cache.latestItems = null;
  _cache.peopleIndex = null;
  _cache.urlWhitelist = null;
  _cache.kontakty = null;

  for (const rel of FULL_FILE_CANDIDATES) {
    const t = safeReadText(rel);
    if (t && t.length > 50_000) {
      _cache.fullText = t;
      break;
    }
  }
  for (const rel of LATEST_FILE_CANDIDATES) {
    const t = safeReadText(rel);
    if (t && t.length > 2000) {
      _cache.latestText = t;
      break;
    }
  }
  for (const rel of PEOPLE_FILE_CANDIDATES) {
    const t = safeReadText(rel);
    if (t && t.length > 300) {
      _cache.peopleText = t;
      break;
    }
  }

  _cache.loadedAt = now;
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================
// ✅ FULL parsers: pages + docs index
// ============================================

function buildPagesIndex(fullText) {
  if (!fullText) return null;

  const pages = new Map();
  const re =
    /=== PAGE[\s\S]*?URL:\s*(.+?)\n(?:TITLE:\s*([\s\S]*?)\n)?(?:PUBLISHED:\s*([\s\S]*?)\n)?[\s\S]*?CONTENT:\n([\s\S]*?)(?=\n={10,}|\n=== PAGE|\s*$)/g;

  let m;
  while ((m = re.exec(fullText))) {
    const url = String(m[1] || "").trim();
    const content = String(m[4] || "").trim();
    if (url && content) pages.set(url, content);
  }
  return pages;
}

function parseDocsIndex(fullText) {
  const docs = [];
  if (!fullText) return docs;

  const m = fullText.match(/=== DOCUMENTS INDEX[\s\S]*?\n([\s\S]*?)(?=\n={10,}|\n=== PAGES|\s*$)/m);
  if (!m || !m[1]) return docs;

  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [type, date, title, url] = parts;
    if (!url?.startsWith("http")) continue;
    docs.push({ type: type || "DOKUMENT", date: date || "", title: title || "", url });
  }
  return docs;
}

function getPages() {
  loadAllLocal();
  if (_cache.pages) return _cache.pages;
  if (!_cache.fullText) return null;
  _cache.pages = buildPagesIndex(_cache.fullText);
  return _cache.pages;
}

function getDocs() {
  loadAllLocal();
  if (_cache.docs) return _cache.docs;
  if (!_cache.fullText) return null;
  _cache.docs = parseDocsIndex(_cache.fullText);
  return _cache.docs;
}

function getPageContentByUrl(url) {
  const pages = getPages();
  if (!pages) return null;
  return pages.get(url) || null;
}

// ============================================
// ✅ LATEST parser
// ============================================

function parseLatestItems(latestText) {
  const items = [];
  const lines = String(latestText || "").split("\n");
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((s) => s.trim());
    const kind = parts[0];
    if (kind !== "PAGE" && kind !== "DOC") continue;

    if (kind === "PAGE") {
      const date = parts[1] || "";
      const title = parts[2] || "";
      const url = parts[3] || "";
      if (url) items.push({ kind, date, title, url });
    } else {
      const date = parts[1] || "";
      const type = parts[2] || "";
      const title = parts[3] || "";
      const url = parts[4] || "";
      if (url) items.push({ kind, date, type, title, url });
    }
  }
  return items;
}

function getLatestItems() {
  loadAllLocal();
  if (_cache.latestItems) return _cache.latestItems;
  if (!_cache.latestText) return null;
  _cache.latestItems = parseLatestItems(_cache.latestText);
  return _cache.latestItems;
}

function wantsHistory(q) {
  const s = normalizeCzech(q);
  return /\b(minule|loni|vloni|archiv|historie|předchoz|predchoz|v roce|rok\s*20\d{2}|20\d{2})\b/.test(s);
}

// ============================================
// ✅ PEOPLE parser (tvůj formát)
// ============================================

function parsePeople(peopleText) {
  const idx = [];
  if (!peopleText) return idx;

  const lines = peopleText.split("\n");
  let currentOrg = null;
  let current = null;

  function pushCurrent() {
    if (!current) return;
    if (current?.name) idx.push(current);
    current = null;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const orgM = line.match(/^\[ORG\]\s*(.+)$/i);
    if (orgM) {
      pushCurrent();
      currentOrg = orgM[1].trim();
      continue;
    }

    const roleM = line.match(/^\-\s*\[ROLE\]\s*(.+)$/i);
    if (roleM) {
      pushCurrent();
      current = { org: currentOrg || "", role: roleM[1].trim(), alias: [], name: "", tel: "", email: "", resp: "" };
      continue;
    }

    if (!current) continue;

    const aliasM = line.match(/^\[ALIAS\]\s*(.+)$/i);
    if (aliasM) {
      current.alias = aliasM[1].split(",").map((x) => normalizeCzech(x.trim())).filter(Boolean);
      continue;
    }

    const nameM = line.match(/^\[NAME\]\s*(.+)$/i);
    if (nameM) { current.name = nameM[1].trim(); continue; }

    const telM = line.match(/^\[TEL\]\s*(.+)$/i);
    if (telM) { current.tel = telM[1].trim(); continue; }

    const emailM = line.match(/^\[EMAIL\]\s*(.+)$/i);
    if (emailM) { current.email = emailM[1].trim(); continue; }

    const respM = line.match(/^\[RESP\]\s*(.+)$/i);
    if (respM) { current.resp = respM[1].trim(); continue; }
  }

  pushCurrent();
  return idx;
}

function getPeopleIndex() {
  loadAllLocal();
  if (_cache.peopleIndex) return _cache.peopleIndex;
  if (!_cache.peopleText) return null;
  _cache.peopleIndex = parsePeople(_cache.peopleText);
  return _cache.peopleIndex;
}

function peopleLookup(query) {
  const idx = getPeopleIndex();
  if (!idx?.length) return null;

  const q = normalizeCzech(query);
  const wantsSokol = /\b(sokol)\b/.test(q);
  const wantsStarosta = /\b(starostk|starosta)\b/.test(q);
  const wantsFire = /\b(hasic|hasič|sdh|mladi hasici|mladí hasiči)\b/.test(q);

  let best = null;
  let bestScore = 0;

  for (const p of idx) {
    let score = 0;
    const org = normalizeCzech(p.org);
    const role = normalizeCzech(p.role);

    if (org && q.includes(org)) score += 3;
    if (role && q.includes(role)) score += 4;
    for (const a of p.alias || []) if (a && q.includes(a)) score += 5;

    if (wantsSokol && /sokol/.test(org)) score += 8;
    if (wantsStarosta && /starostk/.test(role)) score += 10;

    if (wantsFire) {
      if (/sdh|hasi/.test(org)) score += 10;
      if (/sokol/.test(org)) score -= 6;
    }

    if (score > bestScore) { bestScore = score; best = p; }
  }

  // ochrana: když se ptá na hasiči a nemáme jasný match, nevracej náhodnou osobu
  if (wantsFire && bestScore < 8) return null;

  return bestScore >= 6 ? best : null;
}

// ============================================
// ✅ URL normalizace / bezpečnost + WHITELIST
// ============================================

function isAllowedDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return new Set(["obec-radim.cz", "www.obec-radim.cz", "zsradim.cz", "www.zsradim.cz"]).has(host);
  } catch {
    return false;
  }
}

function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^https?:\/\/https?:\/\//i, "https://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");
  u = u.replace(/([^:]\/)\/+/g, "$1");

  // ✅ oprav špatně vypadlý prefix u e_download (file=data%2F... → file=%2Fdata%2F...)
  u = u.replace(/(e_download\.php\?file=)data%2F/gi, "$1%2Fdata%2F");
  // ✅ doplň tečku před příponou (186cs_1pdf → 186cs_1.pdf)
  u = u.replace(/(obsah\d+_\d+)(pdf|docx|xlsx|xls|doc|pptx)(?=(&|$))/gi, "$1.$2");
  u = u.replace(/(\d+cs_?\d*)(pdf|docx|xlsx|xls|doc|pptx)(?=(&|$))/gi, "$1.$2");
  // ✅ oprava .pd → .pdf
  u = u.replace(/\.pd$/i, ".pdf");

  // kanonické opravy
  u = u.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);
  u = u.replace(/https:\/\/www\.obec-radim\.cz\/urad\/?$/gi, KEY_LINKS.kontakty);

  return u;
}

function normalizeUrlsInText(text) {
  let t = String(text || "");
  if (!t) return t;

  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;

  t = t.replace(re, (m) => {
    const fixed = normalizeSingleUrl(m);
    if (!fixed) return "";
    if (!isAllowedDomain(fixed)) return "";
    return fixed.replace(/[)\]}>,.;:!?]+$/g, "");
  });

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function buildUrlWhitelist() {
  loadAllLocal();
  if (_cache.urlWhitelist) return _cache.urlWhitelist;

  const set = new Set();
  const pages = getPages();
  if (pages) for (const url of pages.keys()) set.add(normalizeSingleUrl(url));

  const docs = getDocs();
  if (docs) for (const d of docs) if (d.url) set.add(normalizeSingleUrl(d.url));

  for (const k of Object.values(KEY_LINKS)) set.add(normalizeSingleUrl(k));

  _cache.urlWhitelist = set;
  return set;
}

function filterLinksToWhitelist(text) {
  const allow = buildUrlWhitelist();
  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;

  let out = String(text || "").replace(re, (m) => {
    const fixed = normalizeSingleUrl(m);
    if (!fixed) return "";
    if (!isAllowedDomain(fixed)) return "";
    if (!allow.has(fixed)) return ""; // ✅ žádné halucinované/404 odkazy
    return fixed;
  });

  // uklid duplicitních prázdných řádků
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// ============================================
// ✅ Answer builder (kratší, bez duplicit)
// ============================================

function formatAnswer({ answer, contact, links }) {
  const blocks = [];
  const a = String(answer || "").trim();
  if (a) blocks.push(`Odpověď:\n${a}`);

  const c = String(contact || "").trim();
  if (c) blocks.push(`Kontakt:\n${c}`);

  const ls = Array.isArray(links) ? links.filter(Boolean) : [];
  if (ls.length) {
    const uniq = [...new Set(ls.map((x) => normalizeSingleUrl(x)))].filter(Boolean);
    if (uniq.length) blocks.push(`Odkazy:\n- ${uniq.join("\n- ")}`);
  }

  return blocks.join("\n\n").trim();
}

// ============================================
// ✅ Deterministické klasifikace dotazů
// ============================================

function isKontaktyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(kontakt|kontakty|telefon|email|e-mail|mail|datova schranka|datova schrank|ico|ičo|banka|ucet|účet|adresa)\b/.test(s);
}
function isUredniHodinyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(uredni hodiny|úřední hodiny|kdy ma urad otevreno|oteviraci doba|kdy je otevreno|konzultacni|konzultační)\b/.test(s);
}
function isBioodpadQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(bioodpad|skladka bioodpadu|kam s bioodpadem|zeleny odpad|kompost|skladka)\b/.test(s);
}
function isEventsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(akce|kalendar|kalendář|program|udalost|událost|co se deje|co se děje|pro deti|pro děti)\b/.test(s);
}
function isStatsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(pocet obyvatel|počet obyvatel|obyvatel|rozloha|katastralni vymera|katastrální výměra|statistick|statistik)\b/.test(s);
}
function isSignatureVerifyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(overeni podpisu|ověření podpisu|legalizace)\b/.test(s);
}
function isComplaintQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(podnet|podnět|stiznost|stížnost|navrh|návrh)\b/.test(s);
}
function isBudgetFinanceQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(rozpocet|rozpočet|hospodareni|hospodaření|finance|zaverecny ucet|závěrečný účet|rozpoctove opatreni|rozpočtové opatření)\b/.test(s);
}
function isDogFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(poplatek)\b/.test(s) && /\b(pes|psy|psu|psů)\b/.test(s);
}
function isSokolApplicationQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(prihlask|přihlášk|clenska|člensk)\b/.test(s) && /\b(sokol)\b/.test(s);
}

function extractContactsFromText(content) {
  const phones = [...String(content || "").matchAll(/\+420\s?\d{3}\s?\d{3}\s?\d{3}|\b\d{3}\s?\d{3}\s?\d{3}\b/g)]
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const emails = [...String(content || "").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((m) => m[0].trim())
    .filter(Boolean);

  const addrLine =
    String(content || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\bRadim\s+\d+,\s*\d{3}\s*\d{2}\s*Radim\b/i.test(l)) || "";

  const hoursLine =
    String(content || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => normalizeCzech(l).includes("streda") && /\d{1,2}:\d{2}/.test(l)) || "";

  return { phones: [...new Set(phones)], emails: [...new Set(emails)], addrLine, hoursLine };
}

function getKontaktySourceText() {
  if (_cache.kontakty) return _cache.kontakty;
  const p1 = getPageContentByUrl(KEY_LINKS.kontakty);
  if (p1) return (_cache.kontakty = p1);
  const p2 = getPageContentByUrl(KEY_LINKS.homepage);
  if (p2) return (_cache.kontakty = p2);
  const p3 = getPageContentByUrl(KEY_LINKS.hledani);
  if (p3) return (_cache.kontakty = p3);
  return null;
}

function makeKontaktyAnswerShort() {
  const src = getKontaktySourceText();
  if (!src) return null;

  const { phones, emails, addrLine } = extractContactsFromText(src);
  const parts = [];
  if (addrLine) parts.push(`Adresa: ${addrLine}`);
  if (phones?.[0]) parts.push(`Telefon: ${phones[0]}`);
  if (emails?.[0]) parts.push(`E-mail: ${emails[0]}`);

  return formatAnswer({ answer: parts.join("\n"), links: [KEY_LINKS.kontakty] });
}

function makeUredniHodinyAnswerShort() {
  const src = getKontaktySourceText();
  if (!src) return null;

  const { hoursLine } = extractContactsFromText(src);
  if (hoursLine) {
    return formatAnswer({
      answer: `Úřední hodiny: ${hoursLine.replace(/\s+/g, " ").trim()}`,
      links: [KEY_LINKS.kontakty],
    });
  }

  return formatAnswer({ answer: "Úřední hodiny jsou uvedeny na stránce kontaktů.", links: [KEY_LINKS.kontakty] });
}

function makeBioodpadAnswerShort() {
  const bioUrl = "https://www.obec-radim.cz/urad/skladka-bioodpadu/";
  const content = getPageContentByUrl(bioUrl);
  if (!content) return null;

  const parcel = (content.match(/\bparcele?\s+KN\s+\d+\b/i) || [])[0] || "";
  const zaHrbitovem = /za\s+hřbitovn/i.test(content) ? "za hřbitovní zdí" : "";
  const nonstop = /nepřetržit/i.test(content) ? "Otevřeno nepřetržitě." : "";

  let where = "";
  if (parcel && zaHrbitovem) where = `Nachází se na ${parcel} (k. ú. Radim), ${zaHrbitovem}.`;
  else if (parcel) where = `Nachází se na ${parcel} (k. ú. Radim).`;
  else where = `Umístění je uvedeno na webu obce.`;

  let contact = "";
  const src = getKontaktySourceText();
  if (src) {
    const { phones, emails } = extractContactsFromText(src);
    const p = phones?.[0] ? `Tel: ${phones[0]}` : "";
    const e = emails?.[0] ? `E-mail: ${emails[0]}` : "";
    contact = [p, e].filter(Boolean).join(", ");
  }

  return formatAnswer({ answer: `${where} ${nonstop}`.trim(), contact, links: [bioUrl] });
}

function makeStatsAnswerShort() {
  const content = getPageContentByUrl(KEY_LINKS.homepage);
  if (!content) return null;

  const txt = content.replace(/\s+/g, " ").trim();
  const areaM = txt.match(/\brozloh[aay]\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)\s*km\s*[²2]/i);
  const popM = txt.match(/\bpočet\s+obyvatel\s*[:\-]?\s*([0-9]{2,6})\b/i);

  const parts = [];
  if (popM?.[1]) parts.push(`Počet obyvatel: ${popM[1]}`);
  if (areaM?.[1]) parts.push(`Rozloha: ${areaM[1].replace(",", ".")} km²`);

  if (!parts.length) return formatAnswer({ answer: "Statistické údaje jsou uvedeny na hlavní stránce obce.", links: [KEY_LINKS.homepage] });
  return formatAnswer({ answer: parts.join("\n"), links: [KEY_LINKS.homepage] });
}

function makeEventsAnswerShort(q) {
  const latest = getLatestItems();
  const t0 = todayISO();
  const onlyFuture = !wantsHistory(q);

  if (!latest?.length) {
    return formatAnswer({ answer: "V podkladech nejsou uvedeny žádné aktuální/budoucí akce.", links: [KEY_LINKS.kalendar] });
  }

  let items = latest.filter((it) => it.url);

  // ✅ filtr na dnes/budoucnost
  if (onlyFuture) items = items.filter((it) => !it.date || it.date >= t0);

  // priorita: nejnovější první
  items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const s = normalizeCzech(q);
  const wantsKids = /\b(deti|děti|karneval|tabor|tábor)\b/.test(s);
  if (wantsKids) {
    const kids = items.filter((it) => /děti|deti|karneval|tábor|tabor/i.test((it.title || "") + " " + (it.type || "")));
    if (kids.length) items = kids;
  }

  items = items.slice(0, 6);

  if (!items.length) {
    return formatAnswer({
      answer: onlyFuture
        ? `V podkladech nejsou uvedeny žádné aktuální/budoucí akce (od ${t0.split("-").reverse().join(". ")}).`
        : "V podkladech nejsou uvedeny žádné akce.",
      links: [KEY_LINKS.kalendar],
    });
  }

  const lines = items.map((it) => {
    const d = it.date ? it.date.split("-").reverse().join(". ") : "";
    const title = (it.title || it.type || "Položka").trim();
    return `- ${d ? `${d} — ` : ""}${title}\n  ${it.url}`;
  });

  return formatAnswer({ answer: `Aktuální položky:\n${lines.join("\n")}`, links: [KEY_LINKS.kalendar] });
}

function makeBudgetAnswerShort() {
  const docs = getDocs();
  if (!docs?.length) return null;

  const hits = docs
    .filter((d) => /rozpočet|rozpočt|rozpoct|závěrečný účet|zaverecny ucet|rozpočtové opatření|rozpoctove opatreni/i.test(d.title + " " + d.type))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 6);

  if (!hits.length) return formatAnswer({ answer: "Rozpočet a související dokumenty jsou zveřejněny na úřední desce.", links: [KEY_LINKS.uredniDeska] });

  const lines = hits.map((d) => {
    const dd = d.date ? d.date.split("-").reverse().join(". ") : "";
    return `- ${dd ? `${dd} — ` : ""}${d.title}\n  ${d.url}`;
  });

  return formatAnswer({ answer: `Nejnovější dokumenty k rozpočtu/hospodaření:\n${lines.join("\n")}`, links: [KEY_LINKS.uredniDeska] });
}

function makeDogFeeAnswer() {
  const docs = getDocs();
  if (!docs?.length) return null;

  const hits = docs
    .filter((d) => /poplatk/i.test(d.title) && /\bps(u|ů)\b|\bze ps/i.test(d.title))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 5);

  if (!hits.length) return null;

  let amount = "";
  const pages = getPages();
  if (pages) {
    for (const [url, content] of pages.entries()) {
      if (!/uredni-deska|vyhlask/i.test(url)) continue;
      if (!/psu|psů|poplatek/i.test(url + " " + content)) continue;

      const m1 = content.match(/za\s+jednoho\s+psa[\s\S]{0,120}?\b(\d{2,4})\s*Kč\b/i);
      if (m1?.[1]) { amount = `${m1[1]} Kč`; break; }

      const m2 = content.match(/\b(\d{2,4})\s*Kč\b/i);
      if (m2?.[1]) amount = `${m2[1]} Kč`;
    }
  }

  const best = hits[0];
  const dd = best.date ? best.date.split("-").reverse().join(". ") : "";

  if (amount) {
    return formatAnswer({
      answer: `Poplatek za 1 psa: ${amount} ročně.${dd ? ` (vyvěšeno ${dd})` : ""}`,
      links: [best.url, KEY_LINKS.uredniDeska],
    });
  }

  return formatAnswer({
    answer: `Vyhláška k místnímu poplatku ze psů${dd ? ` (vyvěšeno ${dd})` : ""}:`,
    links: [best.url, KEY_LINKS.uredniDeska],
  });
}

function makeSokolApplicationAnswer() {
  const docs = getDocs();
  if (!docs?.length) return null;

  const hit = docs
    .filter((d) => /přihlášk|prihlask/i.test(d.title) && /sokol/i.test(d.title + " " + d.url))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .at(0);

  if (!hit) {
    return formatAnswer({
      answer: "Přihláška do TJ Sokol Radim není v podkladech dohledatelná jako samostatný soubor.",
      links: ["https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/", KEY_LINKS.kontakty],
    });
  }

  return formatAnswer({
    answer: "Přihláška do TJ Sokol Radim (ke stažení):",
    links: [hit.url, "https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/"],
  });
}

function contactFallbackShort() {
  return formatAnswer({
    answer: "Tato informace není v dostupných podkladech obce uvedena.",
    contact: "Tel: +420 731 409 498, E-mail: urad@obec-radim.cz",
    links: [KEY_LINKS.kontakty],
  });
}

// ============================================
// ✅ Kontext pro LLM: výřezy + relevantní dokumenty
// ============================================

function tokenize(q) {
  const s = normalizeCzech(q).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const stop = new Set(["kde","jak","kdy","kolik","proc","proč","kter","ktery","ktera","ktere","jake","jaky","jaka","dnes","ted","teď","mi","na","do","se","je"]);
  return [...new Set(s.split(" ").filter((t) => t.length >= 3 && !stop.has(t)))];
}

function pickRelevantPageSnippets(question, limit = 3) {
  const pages = getPages();
  if (!pages) return [];

  const toks = tokenize(question);
  if (!toks.length) return [];

  const scored = [];
  for (const [url, content] of pages.entries()) {
    const hay = normalizeCzech(url + " " + content);
    let score = 0;

    for (const t of toks) {
      if (hay.includes(t)) score += 1;
      const re = new RegExp(`\\b${t}\\b`, "g");
      const matches = hay.match(re);
      if (matches?.length) score += Math.min(3, matches.length);
    }

    if (/\/urad\//.test(url)) score += 2;
    if (/\/aktualne\//.test(url)) score += 2;
    if (/\/organizace-a-spolky\//.test(url)) score += 2;

    if (score >= 7) scored.push({ url, score, content });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((it) => {
    const raw = String(it.content || "").trim();
    const snippet = raw.length > 1400 ? raw.slice(0, 1400) + "…" : raw;
    return { url: it.url, snippet };
  });
}

function pickRelevantDocs(question, limit = 3) {
  const docs = getDocs();
  if (!docs?.length) return [];

  const toks = tokenize(question);
  if (!toks.length) return [];

  const scored = [];
  for (const d of docs) {
    const hay = normalizeCzech(`${d.title} ${d.type} ${d.url}`);
    let score = 0;
    for (const t of toks) if (hay.includes(t)) score += 2;
    if (score >= 4) scored.push({ ...d, score });
  }

  scored.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.score - a.score);
  return scored.slice(0, limit);
}

// ============================================
// ✅ OpenAI helpers
// ============================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function api(path_, { method = "GET", body, headers = {} } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path_}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2",
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path_} failed: ${msg}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];
  const assistantMsgs = data.filter((m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length);
  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  return msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean)
    .join("\n\n");
}

function cleanAnswer(text) {
  let t = String(text || "");
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  t = t.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);
  return t.trim();
}

function buildRunInstructions({ userQ }) {
  const nowIso = todayISO();
  const wantsOld = wantsHistory(userQ);

  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš výhradně z podkladů ve file_search. Nic nevymýšlej.\n` +
    `Dnes je ${nowIso.split("-").reverse().join(". ")}.\n\n` +

    `PRAVIDLA ČASU:\n` +
    `- Pokud je dotaz na akce/kalendář/aktuálně/plánované: uváděj jen aktuální a budoucí položky.\n` +
    `- Starší uváděj jen při výslovné žádosti o historii/archiv.\n` +
    (wantsOld ? `- Uživatel chce historii: můžeš uvést i starší položky.\n` : ``) +

    `\nFORMÁT (krátký):\n` +
    `Odpověď:\n- 1–6 krátkých bodů nebo 1–4 věty.\n\n` +
    `Kontakt: jen když je potřeba něco řešit s úřadem/osobou.\n` +
    `Odkazy: max 3 odkazy.\n\n` +

    `ZÁKAZY:\n` +
    `- Neopakuj stejné odkazy.\n` +
    `- Neuváděj "Odpovědná osoba / úřad" jako povinný blok.\n` +
    `- Když to v podkladech není: napiš přesně "Tato informace není v dostupných podkladech obce uvedena." a max odkaz na kontakty.\n`
  );
}

function wrapUserQuestion(userText, contextSnippets, contextDocs) {
  const t = String(userText || "").trim();
  let ctx = "";

  if (Array.isArray(contextSnippets) && contextSnippets.length) {
    ctx += `\n\nKONTEXT (výřezy):\n`;
    for (const s of contextSnippets.slice(0, 3)) ctx += `\n[${s.url}]\n${s.snippet}\n`;
  }

  if (Array.isArray(contextDocs) && contextDocs.length) {
    ctx += `\n\nRELEVANTNÍ DOKUMENTY:\n`;
    for (const d of contextDocs.slice(0, 3)) {
      const dd = d.date ? d.date.split("-").reverse().join(". ") : "";
      ctx += `- ${d.type} | ${dd} | ${d.title} | ${d.url}\n`;
    }
  }

  return `DOTAZ UŽIVATELE: ${t}${ctx}`;
}

async function ensureThreadId(incomingThreadId, apiKey) {
  let threadId = incomingThreadId;
  if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
    const created = await api("/threads", { method: "POST" }, apiKey);
    return created.id;
  }
  try {
    await api(`/threads/${threadId}`, {}, apiKey);
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return created.id;
    }
    throw e;
  }
}

async function addUserMessageWithFallback(threadId, content, apiKey) {
  try {
    await api(`/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content }),
    }, apiKey);
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      const newThreadId = created.id;
      await api(`/threads/${newThreadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content }),
      }, apiKey);
      return newThreadId;
    }
    throw e;
  }
}

async function runAssistant({ threadId, assistantId, apiKey, instructions }) {
  const run = await api(`/threads/${threadId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistant_id: assistantId, instructions, temperature: 0.1, top_p: 1 }),
  }, apiKey);

  const started = Date.now();
  const timeoutMs = 45_000;

  while (true) {
    if (Date.now() - started > timeoutMs) return { ok: false, error: "Timeout waiting for response" };
    await sleep(650);
    const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
    if (check.status === "queued" || check.status === "in_progress") continue;
    if (check.status !== "completed") return { ok: false, error: "Run failed", status: check.status };
    break;
  }

  const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
  let answer = extractLatestAssistantText(messages);
  answer = normalizeUrlsInText(cleanAnswer(answer));
  // ✅ whitelist: žádné odkazy mimo FULL/DOC
  answer = filterLinksToWhitelist(answer);
  return { ok: true, answer };
}

// ============================================
// ✅ Handler
// ============================================

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;
    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!assistantId) return jsonResponse(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const msgTrim = String(message).trim();

    // Reset threadu
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // Thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // ✅ Sokol přihláška deterministicky (nepouštět přes LLM)
    if (isSokolApplicationQuestion(msgTrim)) {
      const a = makeSokolApplicationAnswer();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }

    // ✅ PEOPLE (kdo je starosta / kdo vede sokol / SDH…)
    const person = peopleLookup(msgTrim);
    if (person) {
      const contactParts = [];
      if (person.tel && !/neni uvedeno/i.test(person.tel)) contactParts.push(`Tel: ${person.tel}`);
      if (person.email && !/neni uvedeno/i.test(person.email)) contactParts.push(`E-mail: ${person.email}`);

      const nice = `${person.role}: ${person.name}${person.org ? ` (${person.org})` : ""}`;

      const ans = formatAnswer({
        answer: nice,
        contact: contactParts.length ? contactParts.join(", ") : "",
        links: [KEY_LINKS.kontakty],
      });

      return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(ans), thread_id: threadId });
    }

    // ✅ Deterministické: kontakty/hodiny/bioodpad/statistiky/akce/rozpočet/poplatek za psa
    if (isBioodpadQuestion(msgTrim)) {
      const a = makeBioodpadAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isUredniHodinyQuestion(msgTrim)) {
      const a = makeUredniHodinyAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isKontaktyQuestion(msgTrim)) {
      const a = makeKontaktyAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isStatsQuestion(msgTrim)) {
      const a = makeStatsAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isEventsQuestion(msgTrim)) {
      const a = makeEventsAnswerShort(msgTrim);
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isBudgetFinanceQuestion(msgTrim)) {
      const a = makeBudgetAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });
    }
    if (isDogFeeQuestion(msgTrim)) {
      const a = makeDogFeeAnswer();
      if (a) return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(a), thread_id: threadId });

      const fallback = formatAnswer({
        answer: "Vyhláška k poplatku ze psů není v dostupných podkladech dohledatelná.",
        links: [KEY_LINKS.uredniDeska],
      });

      return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(fallback), thread_id: threadId });
    }

    // úřední věci bez jasných podkladů – nenechat “zeď”
    if (isSignatureVerifyQuestion(msgTrim)) {
      const ans = formatAnswer({
        answer: "Ověření podpisu (legalizaci) řeší obecní úřad. Konkrétní postup/cena nejsou v podkladech uvedeny.",
        links: [KEY_LINKS.kontakty],
      });
      return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(ans), thread_id: threadId });
    }
    if (isComplaintQuestion(msgTrim)) {
      const ans = formatAnswer({
        answer: "Způsob podání podnětu/stížnosti není v podkladech obce uveden. Pro podání využijte kontakty na obecní úřad.",
        links: [KEY_LINKS.kontakty],
      });
      return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(ans), thread_id: threadId });
    }

    // ✅ Kontext pro LLM (výřezy + relevantní dokumenty)
    const snippets = pickRelevantPageSnippets(msgTrim, 3);
    const relDocs = pickRelevantDocs(msgTrim, 3);

    // ✅ Fallback na Assistants
    const outgoingMessage = wrapUserQuestion(msgTrim, snippets, relDocs);
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    const r = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildRunInstructions({ userQ: msgTrim }),
    });

    let answer = r.ok ? r.answer : "";
    answer = normalizeUrlsInText(cleanAnswer(answer));
    answer = filterLinksToWhitelist(answer);

    if (!answer) answer = contactFallbackShort();

    // poslední pojistka: akce nesmí vypsat jen 2023/2024, pokud nechce historii
    if (isEventsQuestion(msgTrim) && !wantsHistory(msgTrim)) {
      const s = normalizeCzech(answer);
      if (/\b(2023|2024)\b/.test(s) && !/\b(2025|2026)\b/.test(s)) {
        answer = formatAnswer({
          answer: "V podkladech nejsou uvedeny žádné aktuální/budoucí akce.",
          links: [KEY_LINKS.kalendar],
        });
      }
    }

    // kanonické linky
    answer = answer.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);

    return jsonResponse(200, { ok: true, answer: filterLinksToWhitelist(answer), thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}
