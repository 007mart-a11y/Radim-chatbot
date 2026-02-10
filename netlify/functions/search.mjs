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
    if (t && t.length > 500) {
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

  // bloky:
  // === PAGE
  // URL: ...
  // TITLE: ...
  // CONTENT:
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
  return /\b(minule|loni|vloni|archiv|historie|predchozi|předchozi|v roce|rok 2023|rok 2024|2023|2024)\b/.test(s);
}

// ============================================
// ✅ PEOPLE parser (z tvého formátu)
// ============================================

function parsePeople(peopleText) {
  const idx = []; // { org, role, alias[], name, tel, email, resp }
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

  // jednoduché skórování: role/alias/org výskyt
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

    // specifické dotazy
    if (/\b(sokol)\b/.test(q) && /sokol/.test(org)) score += 4;
    if (/\b(starostk|starosta)\b/.test(q) && /starostk/.test(role)) score += 6;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 5 ? best : null;
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
// ✅ Odpověď builder (kratší, bez duplicit)
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
    if (uniq.length) {
      blocks.push(`Odkazy:\n- ${uniq.join("\n- ")}`);
    }
  }

  return blocks.join("\n\n").trim();
}

// ============================================
// ✅ Deterministické dotazy (IQ +50)
// ============================================

function isKontaktyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(kontakt|kontakty|telefon|email|e-mail|mail|datova schranka|datova schrank|ico|ičo|banka|ucet|účet|adresa)\b/.test(s);
}

function isUredniHodinyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(uredni hodiny|úřední hodiny|kdy ma urad otevreno|oteviraci doba|kdy je otevreno)\b/.test(s);
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
  return /\b(poplatek.*psa|poplatek.*psy|poplatek ze psu|poplatek ze psů|pes|psy)\b/.test(s) && /\b(poplatek|kolik)\b/.test(s);
}

function extractContactsFromKontaktyPage(content) {
  const phones = [...content.matchAll(/\+420\s?\d{3}\s?\d{3}\s?\d{3}|\b\d{3}\s?\d{3}\s?\d{3}\b/g)]
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const emails = [...content.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((m) => m[0].trim())
    .filter(Boolean);

  // adresa
  const addrLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\bRadim\s+\d+,\s*\d{3}\s*\d{2}\s*Radim\b/i.test(l)) || "";

  // úřední hodiny – často "Středa 16:00–19:00"
  const hoursLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => normalizeCzech(l).includes("streda") && /\d{1,2}:\d{2}/.test(l)) || "";

  return {
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    addrLine,
    hoursLine,
  };
}

function getKontaktySourceText() {
  // primárně /urad/kontakty/
  const p1 = getPageContentByUrl(KEY_LINKS.kontakty);
  if (p1) return p1;

  // fallback: homepage často obsahuje kontakty/box
  const p2 = getPageContentByUrl(KEY_LINKS.homepage);
  if (p2) return p2;

  // fallback search
  const p3 = getPageContentByUrl(KEY_LINKS.hledani);
  if (p3) return p3;

  return null;
}

function makeKontaktyAnswerShort() {
  const src = getKontaktySourceText();
  if (!src) return null;

  const { phones, emails, addrLine } = extractContactsFromKontaktyPage(src);

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

  const { hoursLine } = extractContactsFromKontaktyPage(src);

  let hours = "";
  if (hoursLine) {
    const cleaned = hoursLine.replace(/\s+/g, " ").trim();
    hours = `Úřední hodiny: ${cleaned.replace(/^[-–•]\s*/, "")}`;
  } else {
    hours = `Úřední hodiny jsou uvedeny na stránce kontaktů.`;
  }

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

  const kontakty = makeKontaktyAnswerShort();
  // krátký kontakt jen když se ptá na skládku (dává smysl)
  const src = getKontaktySourceText();
  let contact = "";
  if (src) {
    const { phones, emails } = extractContactsFromKontaktyPage(src);
    const p = phones?.[0] ? `Telefon: ${phones[0]}` : "";
    const e = emails?.[0] ? `E-mail: ${emails[0]}` : "";
    contact = [p, e].filter(Boolean).join(", ");
  }

  return formatAnswer({
    answer: `${where} ${nonstop}`.trim(),
    contact,
    links: [bioUrl],
  });
}

function makeEventsAnswerShort(q) {
  const latest = getLatestItems();
  if (!latest?.length) {
    return formatAnswer({
      answer: "V podkladech nejsou uvedeny žádné aktuální/budoucí akce.",
      links: [KEY_LINKS.kalendar],
    });
  }

  const onlyFuture = !wantsHistory(q);
  const t0 = todayISO();

  // bereme primárně PAGE, které jsou typicky kalendář/aktuality
  let items = latest
    .filter((it) => it.url && (it.kind === "PAGE" || it.kind === "DOC"))
    .filter((it) => {
      if (!onlyFuture) return true;
      if (!it.date) return true;
      return it.date >= t0;
    });

  // pro dotazy "pro děti" zkus prioritizovat dětské
  const s = normalizeCzech(q);
  const wantsKids = /\b(deti|děti|pro deti|pro děti|karneval|tabor|tábor)\b/.test(s);
  if (wantsKids) {
    const kids = items.filter((it) => /děti|deti|karneval|tábor|tabor/i.test((it.title || "") + " " + (it.type || "")));
    if (kids.length) items = kids;
  }

  items = items.slice(0, 8);

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
    const title = (it.title || it.type || it.url).trim();
    return `- ${d ? `${d} — ` : ""}${title}\n  ${it.url}`;
  });

  return formatAnswer({
    answer: `Aktuální položky:\n${lines.join("\n")}`,
    links: [KEY_LINKS.kalendar],
  });
}

function makeStatsAnswerShort() {
  // homepage má statistické údaje – taháme z FULL stránky homepage
  const content = getPageContentByUrl(KEY_LINKS.homepage);
  if (!content) return null;

  const txt = content.replace(/\s+/g, " ").trim();

  // rozloha: "Rozloha: 10,38 km²" apod.
  const areaM = txt.match(/\brozloh[aay]\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)\s*km\s*[²2]/i);
  // obyvatelé: "Počet obyvatel: 440" apod.
  const popM = txt.match(/\bpočet\s+obyvatel\s*[:\-]?\s*([0-9]{2,6})\b/i);

  const parts = [];
  if (popM?.[1]) parts.push(`Počet obyvatel: ${popM[1]}`);
  if (areaM?.[1]) parts.push(`Rozloha: ${areaM[1].replace(",", ".")} km²`);

  if (!parts.length) {
    return formatAnswer({
      answer: "Statistické údaje jsou uvedeny na hlavní stránce obce.",
      links: [KEY_LINKS.homepage],
    });
  }

  return formatAnswer({
    answer: parts.join("\n"),
    links: [KEY_LINKS.homepage],
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

function makeDogFeeAnswerMaybeFromDocs() {
  const docs = getDocs();
  if (!docs?.length) return null;

  // najdi nejnovější vyhlášku ze psů
  const hits = docs
    .filter((d) => /poplatk.*ps/i.test(d.title) || /psu|psů/i.test(d.title))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 3);

  if (!hits.length) return null;

  // pokus: někdy je částka přímo v HTML stránce úřední desky (ne v PDF)
  // najdeme případnou stránku úřední desky podle názvu v PAGES
  let amount = "";
  const pages = getPages();
  if (pages) {
    for (const it of hits) {
      // pokud v title existuje stránka na úřední desce v pages textu, zkus vytáhnout částku
      // (heuristika: projdeme pár relevantních page URL, kde je "vyhlaska" a "psu")
      for (const [url, content] of pages.entries()) {
        if (!/uredni-deska|vyhlask/i.test(url)) continue;
        if (!/psu|psů/i.test(url + " " + content)) continue;

        const m = content.match(/\b(\d{2,4})\s*Kč\b/i);
        if (m?.[1]) {
          amount = `${m[1]} Kč`;
          break;
        }
      }
      if (amount) break;
    }
  }

  const best = hits[0];
  const dd = best.date ? best.date.split("-").reverse().join(". ") : "";

  if (amount) {
    return formatAnswer({
      answer: `Poplatek za psa: ${amount} (dle vyhlášky${dd ? `, vyvěšeno ${dd}` : ""}).`,
      links: [best.url, KEY_LINKS.uredniDeska],
    });
  }

  // bezpečný fallback: pošli vyhlášku bez částky (ať se to nevymýšlí)
  return formatAnswer({
    answer: `Vyhláška k místnímu poplatku ze psů${dd ? ` (vyvěšeno ${dd})` : ""}:`,
    links: [best.url, KEY_LINKS.uredniDeska],
  });
}

function makeSimpleContactFallback() {
  return formatAnswer({
    answer: "Tato informace není v dostupných podkladech obce uvedena.",
    contact: "Telefon: +420 731 409 498, E-mail: urad@obec-radim.cz",
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
  const toks = s.split(" ").filter((t) => t.length >= 3 && !["kde", "jak", "kdy", "kolik", "proc", "proč", "kter", "ktery", "ktera", "ktere", "jake", "jaky", "jaka", "jake", "dnes", "ted", "teď"].includes(t));
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
      if (hay.includes(t)) score += 1;
      // bonus za více výskytů
      const re = new RegExp(`\\b${t}\\b`, "g");
      const matches = hay.match(re);
      if (matches?.length) score += Math.min(3, matches.length);
    }
    // boost pro “úřední deska / úřad / obec / organizace”
    if (/\/urad\//.test(url)) score += 3;
    if (/\/aktualne\//.test(url)) score += 2;
    if (/\/organizace-a-spolky\//.test(url)) score += 2;

    if (score >= 6) scored.push({ url, score, content });
  }

  scored.sort((a, b) => b.score - a.score);

  const out = [];
  for (const it of scored.slice(0, limit)) {
    const raw = String(it.content || "").trim();
    // zkrátit výřez
    const snippet = raw.length > 1400 ? raw.slice(0, 1400) + "…" : raw;
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

  const parts = msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.join("\n\n");
}

function cleanAnswer(text) {
  let t = String(text || "");

  // odstraň citace file_search
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  // oprava URL teček
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // hard canonical fixes
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
    `Odpověď:\n- 1–6 krátkých odrážek / 1–4 věty (žádné dlouhé romány)\n\n` +
    `Kontakt: (jen pokud je potřeba něco řešit s konkrétní osobou/úřadem)\n` +
    `Odkazy: (max 3 odkazy)\n\n` +

    `ZÁKAZY:\n` +
    `- Neopakuj kontakt 2×.\n` +
    `- Neuváděj "Odpovědná osoba / úřad" pokud to není jasně uvedeno.\n` +
    `- Pokud informace v podkladech není, napiš jen: "Tato informace není v dostupných podkladech obce uvedena." a dej odkaz na kontakty.\n`
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

  // kanonické linky
  answer = answer.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);

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

    // ✅ 0) PEOPLE (rychlé dotazy na vedení / kdo vede sokol / starostka)
    const person = peopleLookup(msgTrim);
    if (person) {
      const contactParts = [];
      if (person.tel && !/neni uvedeno/i.test(person.tel)) contactParts.push(`Tel: ${person.tel}`);
      if (person.email && !/neni uvedeno/i.test(person.email)) contactParts.push(`E-mail: ${person.email}`);

      return jsonResponse(200, {
        ok: true,
        answer: formatAnswer({
          answer: `${person.role}: ${person.name}${person.org ? ` (${person.org})` : ""}`,
          contact: contactParts.join(", "),
          links: [KEY_LINKS.kontakty].filter(Boolean), // u lidí často není přímý link v people – necháme kontakty obce
        }),
        thread_id: threadId,
      });
    }

    // ✅ 1) Deterministické dotazy
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
      const a = makeDogFeeAnswerMaybeFromDocs();
      if (a) return jsonResponse(200, { ok: true, answer: a, thread_id: threadId });
      // když nic nenajde, minimálně odkaz na úřední desku
      return jsonResponse(200, {
        ok: true,
        answer: formatAnswer({
          answer: "Vyhláška k poplatku ze psů není v dostupných podkladech jednoznačně dohledatelná.",
          links: [KEY_LINKS.uredniDeska],
        }),
        thread_id: threadId,
      });
    }

    // Speciální úřední dotazy – pokud není v podkladech, vrať aspoň kontakt (ne zeď)
    if (isSignatureVerifyQuestion(msgTrim) || isComplaintQuestion(msgTrim)) {
      return jsonResponse(200, { ok: true, answer: makeSimpleContactFallback(), thread_id: threadId });
    }

    // ✅ 2) Kontextové podklady pro LLM
    const snippets = pickRelevantPageSnippets(msgTrim, 3);

    // ✅ 3) Fallback na Assistants (pro zbytek)
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
      answer = makeSimpleContactFallback();
    }

    // poslední pojistka proti “akcím 2 roky zpět” v LLM fallbacku:
    if (isEventsQuestion(msgTrim) && !wantsHistory(msgTrim)) {
      // pokud odpověď obsahuje jen staré roky, radši vrať kalendář link
      const s = normalizeCzech(answer);
      if (/\b(2023|2024)\b/.test(s) && !/\b(2026|2025)\b/.test(s)) {
        answer = formatAnswer({
          answer: "V podkladech nejsou uvedeny žádné aktuální/budoucí akce.",
          links: [KEY_LINKS.kalendar],
        });
      }
    }

    // kanonické linky
    answer = answer.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
