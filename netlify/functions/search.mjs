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
  sportAreal: "https://www.obec-radim.cz/organizace-a-spolky/sokolove/sportovni-areal/",
  sokol: "https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/",
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
  // ✅ nejčastější reálná cesta
  "knowledge/people/00_PEOPLE_obec_radim.txt",
  "public/knowledge/people/00_PEOPLE_obec_radim.txt",
  // fallbacky
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
  if (now - _cache.loadedAt < 10 * 60 * 1000 && (_cache.fullText || _cache.latestText || _cache.peopleText)) {
    return;
  }

  _cache.fullText = null;
  _cache.latestText = null;
  _cache.peopleText = null;
  _cache.pages = null;
  _cache.docs = null;
  _cache.latestItems = null;
  _cache.peopleIndex = null;

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
// ✅ LATEST parser (pro akce / úřední desku / aktuality)
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
  return /\b(minule|loni|vloni|archiv|historie|predchozi|předchozi|v roce|rok|2023|2024)\b/.test(s);
}

// ============================================
// ✅ PEOPLE parser (z tvého formátu)
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

  for (let raw of lines) {
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
    if (nameM) {
      current.name = nameM[1].trim();
      continue;
    }
    const telM = line.match(/^\[TEL\]\s*(.+)$/i);
    if (telM) {
      current.tel = telM[1].trim();
      continue;
    }
    const emailM = line.match(/^\[EMAIL\]\s*(.+)$/i);
    if (emailM) {
      current.email = emailM[1].trim();
      continue;
    }
    const respM = line.match(/^\[RESP\]\s*(.+)$/i);
    if (respM) {
      current.resp = respM[1].trim();
      continue;
    }
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

  let best = null;
  let bestScore = 0;

  for (const p of idx) {
    let score = 0;
    const org = normalizeCzech(p.org);
    const role = normalizeCzech(p.role);

    if (org && q.includes(org)) score += 3;
    if (role && q.includes(role)) score += 4;

    for (const a of p.alias || []) {
      if (a && q.includes(a)) score += 5;
    }

    // dotazy sokol / hasici / starosta
    if (/\b(sokol)\b/.test(q) && /sokol/.test(org)) score += 5;
    if (/\b(hasic|hasiči|sdh)\b/.test(q) && /sdh/.test(org)) score += 5;
    if (/\b(starostk|starosta)\b/.test(q) && /starostk/.test(role)) score += 8;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 6 ? best : null;
}

// ============================================
// ✅ URL normalizace / bezpečnost
// ============================================

function isAllowedDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const allowed = new Set(["obec-radim.cz", "www.obec-radim.cz", "zsradim.cz", "www.zsradim.cz"]);
    return allowed.has(host);
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
  u = u.replace(/\/\/www\.obec-radimcz/gi, "//www.obec-radim.cz");
  u = u.replace(/\/\/obec-radimcz/gi, "//obec-radim.cz");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");
  u = u.replace(/(\d+)html(\b|\/|\?|#)/gi, "$1.html$2");
  u = u.replace(/([^:]\/)\/+/g, "$1");

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
    if (!isAllowedDomain(fixed)) return "";
    return fixed.replace(/[)\]}>,.;:!?]+$/g, "");
  });

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

// ============================================
// ✅ Odpověď builder (kratší, bez duplicit, max 3 linky)
// ============================================

function formatAnswer({ answer, contact, links }) {
  const blocks = [];

  const a = String(answer || "").trim();
  if (a) blocks.push(`Odpověď:\n${a}`);

  const c = String(contact || "").trim();
  if (c) blocks.push(`Kontakt:\n${c}`);

  const ls = Array.isArray(links) ? links.filter(Boolean) : [];
  if (ls.length) {
    const uniq = [];
    const seen = new Set();
    for (const raw of ls) {
      const u = normalizeSingleUrl(raw);
      if (!u) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      uniq.push(u);
      if (uniq.length >= 3) break;
    }
    if (uniq.length) blocks.push(`Odkazy:\n- ${uniq.join("\n- ")}`);
  }

  return blocks.join("\n\n").trim();
}

// ============================================
// ✅ Deterministické dotazy
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
  return /\b(bioodpad|skladka bioodpadu|kam s bioodpadem|zeleny odpad|kompost)\b/.test(s);
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
  return /\b(podnet|podnět|stiznost|stížnost|navrh|návrh|zadost|žádost)\b/.test(s);
}

function isBudgetFinanceQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(rozpocet|rozpočet|hospodareni|hospodaření|finance|zaverecny ucet|závěrečný účet|rozpoctove opatreni|rozpočtové opatření)\b/.test(s);
}

function isDogFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(poplatek|kolik)\b/.test(s) && /\b(pes|psy|psu|psů)\b/.test(s);
}

function isHallRentQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(pronajem|pronájem|hala|sportovni hala|sportovní hala|rezervace)\b/.test(s);
}

function isSokolApplicationQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(prihlask|přihlášk)\b/.test(s) && /\b(sokol)\b/.test(s);
}

function isFireKidsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(hasi(c|či)|sdh)\b/.test(s) && /\b(krouzek|kroužek|mladez|mládež|deti|děti)\b/.test(s);
}

function extractContactsFromText(content) {
  const phones = [...String(content || "").matchAll(/\+420\s?\d{3}\s?\d{3}\s?\d{3}|\b\d{3}\s?\d{3}\s?\d{3}\b/g)]
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const emails = [...String(content || "").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((m) => m[0].trim())
    .filter(Boolean);

  const hoursLine =
    String(content || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => normalizeCzech(l).includes("streda") && /\d{1,2}:\d{2}/.test(l)) || "";

  const addrLine =
    String(content || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\bRadim\s+\d+,\s*\d{3}\s*\d{2}\s*Radim\b/i.test(l)) || "";

  return {
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    hoursLine,
    addrLine,
  };
}

function getKontaktySourceText() {
  const p1 = getPageContentByUrl(KEY_LINKS.kontakty);
  if (p1) return p1;
  const p2 = getPageContentByUrl(KEY_LINKS.homepage);
  if (p2) return p2;
  const p3 = getPageContentByUrl(KEY_LINKS.hledani);
  if (p3) return p3;
  return null;
}

function kontaktyCompactLine() {
  const src = getKontaktySourceText();
  if (!src) return "Telefon: +420 731 409 498, E-mail: urad@obec-radim.cz";
  const { phones, emails } = extractContactsFromText(src);
  const p = phones?.[0] ? `Telefon: ${phones[0]}` : "Telefon: +420 731 409 498";
  const e = emails?.[0] ? `E-mail: ${emails[0]}` : "E-mail: urad@obec-radim.cz";
  return `${p}, ${e}`;
}

function makeKontaktyAnswerShort() {
  const src = getKontaktySourceText();
  if (!src) return null;

  const { phones, emails, addrLine } = extractContactsFromText(src);
  const parts = [];
  if (addrLine) parts.push(`Adresa: ${addrLine}`);
  if (phones?.[0]) parts.push(`Telefon: ${phones[0]}`);
  if (emails?.[0]) parts.push(`E-mail: ${emails[0]}`);

  return formatAnswer({
    answer: parts.length ? parts.join("\n") : "Kontakty jsou uvedeny na webu obce.",
    links: [KEY_LINKS.kontakty],
  });
}

function makeUredniHodinyAnswerShort() {
  const src = getKontaktySourceText();
  if (!src) return null;

  const { hoursLine } = extractContactsFromText(src);
  const hours = hoursLine ? `Úřední hodiny: ${hoursLine.replace(/\s+/g, " ").trim()}` : "Úřední hodiny jsou uvedeny na stránce kontaktů.";

  return formatAnswer({
    answer: hours,
    links: [KEY_LINKS.kontakty],
  });
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

  return formatAnswer({
    answer: `${where} ${nonstop}`.trim(),
    contact: kontaktyCompactLine(),
    links: [bioUrl],
  });
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

  if (!parts.length) {
    return formatAnswer({ answer: "Statistické údaje jsou uvedeny na hlavní stránce obce.", links: [KEY_LINKS.homepage] });
  }

  return formatAnswer({ answer: parts.join("\n"), links: [KEY_LINKS.homepage] });
}

function makeEventsAnswerShort(q) {
  const latest = getLatestItems();
  const t0 = todayISO();
  const onlyFuture = !wantsHistory(q);

  if (!latest?.length) {
    return formatAnswer({
      answer: "Seznam akcí najdete v kalendáři obce.",
      links: [KEY_LINKS.kalendar],
    });
  }

  let items = latest.filter((it) => it.url);

  if (onlyFuture) {
    items = items.filter((it) => !it.date || it.date >= t0);
  }

  const s = normalizeCzech(q);
  const wantsKids = /\b(deti|děti|karneval|tabor|tábor)\b/.test(s);
  if (wantsKids) {
    const kids = items.filter((it) => /děti|deti|karneval|tábor|tabor/i.test((it.title || "") + " " + (it.type || "")));
    if (kids.length) items = kids;
  }

  items = items.slice(0, 6);

  if (!items.length) {
    return formatAnswer({
      answer: onlyFuture ? "V podkladech nejsou uvedeny žádné aktuální/budoucí akce." : "V podkladech nejsou uvedeny žádné akce.",
      links: [KEY_LINKS.kalendar],
    });
  }

  const lines = items.map((it) => {
    const d = it.date ? it.date.split("-").reverse().join(". ") : "";
    const title = (it.title || it.type || "").trim() || "Položka";
    return `- ${d ? `${d} — ` : ""}${title}\n  ${it.url}`;
  });

  return formatAnswer({
    answer: `Aktuální položky:\n${lines.join("\n")}`,
    links: [KEY_LINKS.kalendar],
  });
}

function makeBudgetAnswerShort() {
  const docs = getDocs();
  if (!docs?.length) return null;

  const hits = docs
    .filter((d) => /rozpočet|rozpočt|rozpoct|závěrečný účet|zaverecny ucet|rozpočtové opatření|rozpoctove opatreni/i.test(d.title + " " + d.type))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 6);

  if (!hits.length) {
    return formatAnswer({
      answer: "Rozpočet a související dokumenty jsou zveřejněny na úřední desce.",
      links: [KEY_LINKS.uredniDeska],
    });
  }

  const lines = hits.map((d) => {
    const dd = d.date ? d.date.split("-").reverse().join(". ") : "";
    return `- ${dd ? `${dd} — ` : ""}${d.title}\n  ${d.url}`;
  });

  return formatAnswer({
    answer: `Nejnovější dokumenty k rozpočtu/hospodaření:\n${lines.join("\n")}`,
    links: [KEY_LINKS.uredniDeska],
  });
}

function findDocByKeywords(keywords) {
  const docs = getDocs();
  if (!docs?.length) return null;

  const keys = keywords.map(normalizeCzech);
  const scored = docs
    .map((d) => {
      const hay = normalizeCzech(`${d.type} ${d.title} ${d.url}`);
      let score = 0;
      for (const k of keys) if (hay.includes(k)) score += 2;
      return { d, score };
    })
    .filter((x) => x.score >= 4);

  scored.sort((a, b) => b.score - a.score || (b.d.date || "").localeCompare(a.d.date || ""));
  return scored[0]?.d || null;
}

function makeSokolApplicationAnswer() {
  const doc = findDocByKeywords(["přihláška", "sokol", "tj sokol radim"]);
  if (!doc) {
    return formatAnswer({
      answer: "Přihlášku do TJ Sokol Radim najdete v dokumentech u Sokola (pokud je zveřejněná).",
      links: [KEY_LINKS.sokol],
    });
  }
  return formatAnswer({
    answer: "Přihláška do TJ Sokol Radim:",
    links: [doc.url, KEY_LINKS.sokol],
  });
}

function findDogFeeAmountFromPages() {
  const pages = getPages();
  if (!pages) return "";

  // prohledej jen relevantní stránky (úřední deska / vyhlášky / poplatek ze psů)
  const candidates = [];
  for (const [url, content] of pages.entries()) {
    const hay = normalizeCzech(url + " " + content);
    if (!/psu|psů|poplatek/.test(hay)) continue;
    if (!/uredni-deska|vyhlask|vyhlášk|ozv|obecne zavazna vyhlaska|obecně závazná vyhláška/i.test(url + " " + content)) continue;
    candidates.push({ url, content });
  }

  for (const c of candidates) {
    // typicky bývá “... činí 150 Kč ...”
    const m1 = c.content.match(/\bčiní\s*(\d{2,4})\s*Kč\b/i);
    if (m1?.[1]) return `${m1[1]} Kč`;
    // fallback: první rozumná částka v Kč
    const m2 = c.content.match(/\b(\d{2,4})\s*Kč\b/i);
    if (m2?.[1]) return `${m2[1]} Kč`;
  }
  return "";
}

function makeDogFeeAnswer() {
  const docs = getDocs();
  if (!docs?.length) return null;

  const hits = docs
    .filter((d) => /psu|psů|poplatk.*ps/i.test(d.title + " " + d.type))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 5);

  if (!hits.length) return null;

  const best = hits[0];
  const dd = best.date ? best.date.split("-").reverse().join(". ") : "";

  const amount = findDogFeeAmountFromPages();

  if (amount) {
    return formatAnswer({
      answer: `Poplatek za psa: ${amount} ročně (dle vyhlášky${dd ? `, vyvěšeno ${dd}` : ""}).`,
      links: [best.url, KEY_LINKS.uredniDeska],
    });
  }

  // bezpečný fallback: pošli vyhlášku bez částky, nic nevymýšlej
  return formatAnswer({
    answer: `Vyhláška k místnímu poplatku ze psů${dd ? ` (vyvěšeno ${dd})` : ""}:`,
    links: [best.url, KEY_LINKS.uredniDeska],
  });
}

function makeHallRentAnswer() {
  // 1) zkus vytáhnout z relevantní stránky sportovního areálu
  const p = getPageContentByUrl(KEY_LINKS.sportAreal) || getPageContentByUrl(KEY_LINKS.sportAreal + "kde-sportujeme/");
  const s = String(p || "");
  const m = s.match(/\b(\d{2,4})\s*Kč\s*(?:\/|za)\s*hod/i); // 250 Kč/hod
  const amount = m?.[1] ? `${m[1]} Kč/hod` : "";

  // 2) kontakt na správce areálu z PEOPLE (Lukáš Karban)
  const person = peopleLookup("správce areálu sokol");
  const contact = person?.tel ? `Tel: ${person.tel}` : "";

  if (amount) {
    return formatAnswer({
      answer: `Pronájem sportovní haly: ${amount}. Rezervace přes správce sportovního areálu.`,
      contact,
      links: [KEY_LINKS.sportAreal],
    });
  }

  // když částka není v textu (nebo FULL chybí), pořád vrať správného člověka
  if (person?.tel) {
    return formatAnswer({
      answer: "Pronájem sportovní haly vyřizuje správce sportovního areálu.",
      contact,
      links: [KEY_LINKS.sportAreal],
    });
  }

  return formatAnswer({
    answer: "Pronájem sportovní haly je uveden u sportovního areálu; pro rezervaci kontaktujte obecní úřad.",
    contact: kontaktyCompactLine(),
    links: [KEY_LINKS.sportAreal, KEY_LINKS.kontakty],
  });
}

function makeSimpleContactFallback() {
  return formatAnswer({
    answer: "Tato informace není v dostupných podkladech obce uvedena.",
    contact: kontaktyCompactLine(),
    links: [KEY_LINKS.kontakty],
  });
}

// ============================================
// ✅ Kontext pro LLM (vybere top stránky z FULL)
// ============================================

function tokenize(q) {
  const s = normalizeCzech(q)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stop = new Set(["kde","jak","kdy","kolik","proc","proč","kter","ktery","ktera","ktere","jake","jaky","jaka","dnes","ted","teď","mi","me","to","se","na"]);
  const toks = s.split(" ").filter((t) => t.length >= 3 && !stop.has(t));
  return [...new Set(toks)];
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
      if (hay.includes(t)) score += 2;
      const re = new RegExp(`\\b${t}\\b`, "g");
      const matches = hay.match(re);
      if (matches?.length) score += Math.min(4, matches.length);
    }
    if (/\/urad\//.test(url)) score += 3;
    if (/\/aktualne\//.test(url)) score += 2;
    if (/\/organizace-a-spolky\//.test(url)) score += 2;

    if (score >= 10) scored.push({ url, score, content });
  }

  scored.sort((a, b) => b.score - a.score);

  const out = [];
  for (const it of scored.slice(0, limit)) {
    const raw = String(it.content || "").trim();
    const snippet = raw.length > 1600 ? raw.slice(0, 1600) + "…" : raw;
    out.push({ url: it.url, snippet });
  }
  return out;
}

// ============================================
// ✅ LLM část (fallback) – s lepšími instrukcemi
// ============================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path_} failed: ${msg}`);
    err.status = res.status;
    err.path = path_;
    err.method = method;
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
  const parts = msg.content.map((c) => (c?.type === "text" ? c.text?.value : "")).filter(Boolean);
  return parts.join("\n\n");
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
    `Odpovídáš výhradně z oficiálních podkladů obce (web, dokumenty, úřední deska).\n` +
    `Nevymýšlej fakta, čísla ani jména.\n` +
    `Dnes je ${nowIso.split("-").reverse().join(". ")}.\n\n` +

    `PRAVIDLA ČASU:\n` +
    `- Pokud se uživatel ptá na AKCE / co je plánované / co je aktuálně: uváděj pouze aktuální a budoucí.\n` +
    `- Starší akce uváděj jen pokud si je uživatel výslovně vyžádá (historie/archiv).\n` +
    `${wantsOld ? `- Uživatel chce historii: můžeš uvést i starší položky.\n` : ""}\n` +

    `STRUKTURA ODPOVĚDI (KRÁTKÁ):\n` +
    `Odpověď:\n- 1–6 krátkých odrážek / 1–4 věty\n\n` +
    `Kontakt: uveď jen když je potřeba někoho kontaktovat\n` +
    `Odkazy: max 3\n\n` +

    `ZÁKAZY:\n` +
    `- Neopakuj kontakty ani odkazy.\n` +
    `- Neuváděj "Odpovědná osoba / úřad".\n` +
    `- Pokud něco není v podkladech, napiš přesně: "Tato informace není v dostupných podkladech obce uvedena." a dej odkaz na kontakty.\n`
  );
}

function wrapUserQuestion(userText, contextSnippets) {
  const t = String(userText || "").trim();
  let ctx = "";
  if (Array.isArray(contextSnippets) && contextSnippets.length) {
    ctx += `\n\nKONTEXTOVÉ PODKLADY (výřezy z webu obce):\n`;
    for (const s of contextSnippets.slice(0, 3)) {
      ctx += `\n[${s.url}]\n${s.snippet}\n`;
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
    await api(
      `/threads/${threadId}/messages`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "user", content }) },
      apiKey
    );
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      const newThreadId = created.id;

      await api(
        `/threads/${newThreadId}/messages`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "user", content }) },
        apiKey
      );

      return newThreadId;
    }
    throw e;
  }
}

async function runAssistant({ threadId, assistantId, apiKey, instructions }) {
  const run = await api(
    `/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        instructions,
        temperature: 0.1,
        top_p: 1,
      }),
    },
    apiKey
  );

  const started = Date.now();
  const timeoutMs = 45_000;

  while (true) {
    if (Date.now() - started > timeoutMs) return { ok: false, error: "Timeout waiting for response" };
    await sleep(650);
    const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
    const status = check.status;
    if (status === "queued" || status === "in_progress") continue;
    if (status !== "completed") return { ok: false, error: "Run failed", status };
    break;
  }

  const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
  let answer = extractLatestAssistantText(messages);

  answer = cleanAnswer(answer);
  answer = normalizeUrlsInText(answer);

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

    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // --------- 0) PEOPLE routy (tvrdě) ----------
    // “kdo je starosta/starostka”
    if (/\b(starosta|starostka)\b/i.test(normalizeCzech(msgTrim))) {
      const p = peopleLookup("starostka obce");
      if (p?.name) {
        const contact = p.tel && !/neni uvedeno/i.test(p.tel) ? `Tel: ${p.tel}` : kontaktyCompactLine();
        return jsonResponse(200, {
          ok: true,
          answer: formatAnswer({
            answer: `Starostka obce Radim: ${p.name}.`,
            contact,
            links: [KEY_LINKS.kontakty],
          }),
          thread_id: threadId,
        });
      }
      // když PEOPLE chybí, aspoň kontakty
      return jsonResponse(200, { ok: true, answer: makeSimpleContactFallback(), thread_id: threadId });
    }

    // “kdo vede sokol”
    if (/\b(sokol)\b/i.test(normalizeCzech(msgTrim)) && /\b(kdo|vede|predsed|předsed)\b/.test(normalizeCzech(msgTrim))) {
      const p = peopleLookup("sokol předsedkyně");
      if (p?.name) {
        const contactParts = [];
        if (p.tel && !/neni uvedeno/i.test(p.tel)) contactParts.push(`Tel: ${p.tel}`);
        if (p.email && !/neni uvedeno/i.test(p.email)) contactParts.push(`E-mail: ${p.email}`);
        return jsonResponse(200, {
          ok: true,
          answer: formatAnswer({
            answer: `TJ Sokol Radim vede ${p.role}: ${p.name}.`,
            contact: contactParts.join(", "),
            links: [KEY_LINKS.sokol],
          }),
          thread_id: threadId,
        });
      }
      // fallback: aspoň sokol rozcestník + kontakt na obec
      return jsonResponse(200, {
        ok: true,
        answer: formatAnswer({
          answer: "Vedení TJ Sokol Radim je uvedeno v podkladech obce.",
          contact: kontaktyCompactLine(),
          links: [KEY_LINKS.sokol],
        }),
        thread_id: threadId,
      });
    }

    // “kdo vede kroužek hasiči / mládež”
    if (isFireKidsQuestion(msgTrim)) {
      const p = peopleLookup("sdh vedouci hasicskeho krouzku");
      if (p?.name) {
        const contact = p.tel && !/neni uvedeno/i.test(p.tel) ? `Tel: ${p.tel}` : "";
        return jsonResponse(200, {
          ok: true,
          answer: formatAnswer({
            answer: `Hasičský kroužek (SDH Radim) vede: ${p.name}.`,
            contact,
            links: [KEY_LINKS.homepage],
          }),
          thread_id: threadId,
        });
      }
      return jsonResponse(200, { ok: true, answer: makeSimpleContactFallback(), thread_id: threadId });
    }

    // --------- 1) Deterministické dotazy ----------
    if (isBioodpadQuestion(msgTrim)) {
      const a = makeBioodpadAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isUredniHodinyQuestion(msgTrim)) {
      const a = makeUredniHodinyAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isKontaktyQuestion(msgTrim)) {
      const a = makeKontaktyAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isStatsQuestion(msgTrim)) {
      const a = makeStatsAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isEventsQuestion(msgTrim)) {
      const a = makeEventsAnswerShort(msgTrim);
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isBudgetFinanceQuestion(msgTrim)) {
      const a = makeBudgetAnswerShort();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isDogFeeQuestion(msgTrim)) {
      const a = makeDogFeeAnswer();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
      return jsonResponse(200, {
        ok: true,
        answer: formatAnswer({ answer: "Vyhláška k poplatku ze psů není v dostupných podkladech dohledatelná.", links: [KEY_LINKS.uredniDeska] }),
        thread_id: threadId,
      });
    }

    if (isHallRentQuestion(msgTrim)) {
      const a = makeHallRentAnswer();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    if (isSokolApplicationQuestion(msgTrim)) {
      const a = makeSokolApplicationAnswer();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
    }

    // úřední úkony – nezeď, ale kontakty + úřední hodiny
    if (isSignatureVerifyQuestion(msgTrim) || isComplaintQuestion(msgTrim)) {
      const hours = makeUredniHodinyAnswerShort();
      const ans = formatAnswer({
        answer: "Vyřizuje Obecní úřad Radim. Doporučuji domluvit se telefonicky nebo přijít v úředních hodinách.",
        contact: kontaktyCompactLine(),
        links: [KEY_LINKS.kontakty],
      });
      return jsonResponse(200, { ok: true, answer: hours ? `${ans}\n\n${hours}` : ans, thread_id: threadId });
    }

    // --------- 2) Pokud NEMÁŠ lokální knowledge, nežeň LLM do zdi ----------
    loadAllLocal();
    const hasLocal = Boolean(_cache.fullText || _cache.latestText || _cache.peopleText);

    // --------- 3) Kontext + LLM fallback ----------
    const snippets = pickRelevantPageSnippets(msgTrim, 3);
    const outgoingMessage = wrapUserQuestion(msgTrim, snippets);
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    const r = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildRunInstructions({ userQ: msgTrim }),
    });

    let answer = r.ok ? r.answer : "";
    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    if (!answer) {
      // když nemáš local knowledge, aspoň nedej "nic"
      answer = hasLocal ? makeSimpleContactFallback() : formatAnswer({
        answer: "Tuto informaci se mi nepodařilo dohledat v podkladech. Napište prosím na obecní úřad.",
        contact: kontaktyCompactLine(),
        links: [KEY_LINKS.kontakty],
      });
    }

    // poslední pojistka proti “akcím 2 roky zpět”
    if (isEventsQuestion(msgTrim) && !wantsHistory(msgTrim)) {
      const s = normalizeCzech(answer);
      const hasOld = /\b(2023|2024)\b/.test(s);
      const hasNew = /\b(2026|2025)\b/.test(s);
      if (hasOld && !hasNew) {
        answer = formatAnswer({
          answer: "V podkladech nejsou uvedeny žádné aktuální/budoucí akce.",
          links: [KEY_LINKS.kalendar],
        });
      }
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
