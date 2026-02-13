// scripts/full_radim_build_and_upload.mjs
// Node 20+ doporučeno (kvůli moderním deps). Node 18 jen se starými verzemi deps.
//
// FULL crawl + LATEST + PDF_TEXT (text z důležitých PDF)
// Upload do OpenAI Vector Store + cleanup
//
// Deps: jsdom, pdf-parse
//   npm i jsdom pdf-parse
//
// Env:
//   SITE_BASE_URL=https://www.obec-radim.cz
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=...
//
// FULL:
//   CLEANUP_OLD=1 (default) | 0
//   KEEP_LATEST=1 (default)
//
// LATEST:
//   CLEANUP_OLD_LATEST=1 (default) | 0
//   KEEP_LATEST_LATEST=6 (default)
//   LATEST_MAX_ITEMS=40 (default)
//
// PDF_TEXT:
//   PDFTEXT_MAX_PDFS=60 (default)
//   PDFTEXT_MAX_BYTES=6000000 (default)         // 6 MB
//   PDFTEXT_MAX_CHARS_PER_PDF=65000 (default)
//   PDFTEXT_CONCURRENCY=2 (default)
//   CLEANUP_OLD_PDFTEXT=1 (default) | 0
//   KEEP_LATEST_PDFTEXT=3 (default)
//
// Crawl:
//   MAX_PAGES=450 (default)
//   CONCURRENCY=3 (default)
//   REQUEST_TIMEOUT_MS=25000 (default)

import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// ---------- ENV ----------
const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const CLEANUP_OLD = (process.env.CLEANUP_OLD ?? "1") !== "0";
const KEEP_LATEST = parseInt(process.env.KEEP_LATEST ?? "1", 10);

const PREFIX = process.env.FULL_PREFIX ?? "99_FULL_obec_radim";
const OUT_DIR = process.env.FULL_OUT_DIR ?? "knowledge";
const OUT_FILE = process.env.FULL_OUT_FILE ?? `${PREFIX}.txt`;

// ---------- LATEST ENV ----------
const LATEST_PREFIX = process.env.LATEST_PREFIX ?? "00_LATEST_obec_radim";
const LATEST_OUT_FILE = process.env.LATEST_OUT_FILE ?? `${LATEST_PREFIX}.txt`;
const LATEST_MAX_ITEMS = parseInt(process.env.LATEST_MAX_ITEMS ?? "40", 10);

const CLEANUP_OLD_LATEST = (process.env.CLEANUP_OLD_LATEST ?? "1") !== "0";
const KEEP_LATEST_LATEST = parseInt(process.env.KEEP_LATEST_LATEST ?? "6", 10);

// ---------- PDF TEXT ENV ----------
const PDFTEXT_PREFIX = process.env.PDFTEXT_PREFIX ?? "30_PDF_TEXT_obec_radim";
const PDFTEXT_OUT_FILE = process.env.PDFTEXT_OUT_FILE ?? `${PDFTEXT_PREFIX}.txt`;
const PDFTEXT_MAX_PDFS = parseInt(process.env.PDFTEXT_MAX_PDFS ?? "60", 10);
const PDFTEXT_MAX_BYTES = parseInt(process.env.PDFTEXT_MAX_BYTES ?? "6000000", 10);
const PDFTEXT_MAX_CHARS_PER_PDF = parseInt(process.env.PDFTEXT_MAX_CHARS_PER_PDF ?? "65000", 10);
const PDFTEXT_CONCURRENCY = Math.max(1, parseInt(process.env.PDFTEXT_CONCURRENCY ?? "2", 10));
const CLEANUP_OLD_PDFTEXT = (process.env.CLEANUP_OLD_PDFTEXT ?? "1") !== "0";
const KEEP_LATEST_PDFTEXT = parseInt(process.env.KEEP_LATEST_PDFTEXT ?? "3", 10);

// ---------- Crawl ----------
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "450", 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY ?? "3", 10));
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "25000", 10);

// Required for vector stores / assistants v2 endpoints
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

// ---------- UTIL ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function absUrl(u, base = SITE_BASE_URL) {
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}
function sameOrigin(url) {
  try {
    const a = new URL(url);
    const b = new URL(SITE_BASE_URL);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    for (const k of drop) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  } catch {
    return url;
  }
}
function isProbablyBinary(url) {
  return /\.(jpg|jpeg|png|webp|gif|svg|mp4|webm|avi|mov|mp3|wav|zip|rar|7z|tar|gz|bz2|exe|dmg)$/i.test(url);
}
function isMailtoOrTel(url) {
  return /^mailto:/i.test(url) || /^tel:/i.test(url);
}
function looksLikeLoginOrAdmin(url) {
  return /\/admin\/?$/i.test(url) || /\/(wp-admin|administrator)\b/i.test(url);
}
function looksLikeGalleryHeavy(url) {
  return /\/fotogalerie\b/i.test(url);
}

// ✅ robustní pdf detekce (URL i parametry)
function looksLikePdfUrl(u) {
  const s = String(u || "");
  if (/\.pdf(\?.*)?$/i.test(s)) return true;

  // e_download.php?file=...pdf
  if (/e_download\.php/i.test(s)) {
    try {
      const url = new URL(s);
      const file = url.searchParams.get("file") || "";
      const orig = url.searchParams.get("original") || "";
      if (/\.pdf$/i.test(orig)) return true;
      if (/\.pdf$/i.test(file)) return true;
      if (/\.pdf/i.test(file)) return true; // někdy je to encoded
    } catch {
      // ignore
      if (/\.pdf/i.test(s)) return true;
    }
  }

  // evt_file.php apod.
  if (/evt_file\.php/i.test(s) && /\.pdf/i.test(s)) return true;

  return false;
}

function isDownloadDoc(url) {
  return (
    /\.(pdf|doc|docx|xls|xlsx|odt|ods|ppt|pptx|rtf|txt|csv|zip)(\?.*)?$/i.test(url) ||
    /e_download\.php/i.test(url) ||
    /evt_file\.php/i.test(url)
  );
}

function stripWeirdWhitespace(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function dedupeAdjacentLines(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim());
  const out = [];
  let prev = "";
  for (const l of lines) {
    if (!l) {
      if (out[out.length - 1] !== "") out.push("");
      prev = "";
      continue;
    }
    if (l === prev) continue;
    out.push(l);
    prev = l;
  }
  return out.join("\n").trim();
}
function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

function findDateInText(s) {
  if (!s) return null;

  let m = s.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

function classifyDocType(titleOrUrl) {
  const s = (titleOrUrl || "").toLowerCase();
  if (s.includes("vyhláška") || s.includes("obecně závazná vyhláška") || s.includes("ozv")) return "VYHLÁŠKA";
  if (s.includes("nařízení")) return "NAŘÍZENÍ";
  if (s.includes("zpravodaj")) return "ZPRAVODAJ";
  if (s.includes("úřední deska") || s.includes("uredni-deska") || s.includes("záměr") || s.includes("zamer"))
    return "ÚŘEDNÍ_DESKA";
  if (s.includes("rozpočet") || s.includes("rozpočt") || s.includes("rozpoct")) return "ROZPOČET";
  if (s.includes("formulář") || s.includes("formular")) return "FORMULÁŘ";
  if (s.includes("svoz") || s.includes("odpady") || s.includes("bioodpad")) return "ODPADY";
  return "DOKUMENT";
}

function isJunkLine(line) {
  const l = (line || "").toLowerCase();
  if (!l) return true;

  const junkExact = new Set([
    "vyhledávání",
    "rozšířené vyhledávání",
    "navigace",
    "obsah",
    "facebook",
    "zjednodušená verze",
    "přepnout na standardní web",
    "nastavení velikosti písma",
    "počet na stránku",
    "řadit podle",
    "nahoru",
    "zpět",
    "<zpět",
  ]);
  if (junkExact.has(l)) return true;

  if (/^(po|út|st|čt|pá|so|ne)$/i.test(line)) return true;
  if (/^\d{1,2}$/.test(line)) return true;

  if (/^(leden|únor|březen|duben|květen|červen|červenec|srpen|září|říjen|listopad|prosinec)$/i.test(line))
    return true;

  if (/^tel\.:$/i.test(line)) return true;
  if (/^e-?mail:$/i.test(line)) return true;

  return false;
}

function cleanText(text) {
  let t = stripWeirdWhitespace(text);
  t = dedupeAdjacentLines(t);

  const lines = t.split("\n").map((l) => l.trim());
  const kept = [];
  for (const line of lines) {
    if (!line) {
      if (kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isJunkLine(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pickTitle(doc) {
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1) return h1;
  const t = doc.querySelector("title")?.textContent?.trim();
  return t || "";
}

function extractMainTextFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  for (const sel of [
    "script",
    "style",
    "noscript",
    "svg",
    "form",
    "nav",
    "header",
    "footer",
    "aside",
    ".navbar",
    ".menu",
    ".breadcrumbs",
    ".breadcrumb",
    ".search",
    ".vyhledavani",
    ".weather",
    ".pocasi",
    ".calendar",
    ".kalendar",
    ".gallery",
    ".fotogalerie",
    ".random-gallery",
    ".sidebar",
    ".right",
    ".left",
    ".cookie",
    ".gdpr",
    ".pagination",
    ".pager",
  ]) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }

  const candidates = [
    "main",
    "#content",
    ".content",
    ".page-content",
    ".text",
    ".article",
    ".article-text",
    ".detail",
    ".detail-text",
    ".module-content",
  ];

  let node = null;
  for (const sel of candidates) {
    const n = doc.querySelector(sel);
    if (n && (n.textContent || "").trim().length > 250) {
      node = n;
      break;
    }
  }
  if (!node) node = doc.body;

  let text = node?.textContent || "";

  text = text.replace(/Aktuální počasí[\s\S]*?(?=\n\n|$)/gi, "");
  text = text.replace(/Kalendář[\s\S]*?(?=\n\n|$)/gi, "");
  text = text.replace(/Náhodná fotogalerie[\s\S]*?(?=\n\n|$)/gi, "");

  const title = pickTitle(doc);

  const bodyText = doc.body?.textContent || "";
  const published =
    bodyText.match(/Vytvořeno:\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i)?.[0]?.trim() ||
    bodyText.match(/Vyvěšeno:\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i)?.[0]?.trim() ||
    "";

  const cleaned = cleanText(text);
  return { title, published, cleaned };
}

function extractLinksAndDownloads(html, currentUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const urls = new Set();
  const downloads = [];

  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href")?.trim();
    if (!href) return;
    if (href.startsWith("#")) return;
    if (isMailtoOrTel(href)) return;

    const u = absUrl(href, currentUrl);
    if (!u) return;
    const nu = normalizeUrl(u);

    if (!sameOrigin(nu)) return;
    if (looksLikeLoginOrAdmin(nu)) return;

    const text = (a.textContent || "").trim();
    const titleAttr = (a.getAttribute("title") || "").trim();

    if (isDownloadDoc(nu)) {
      const guessDate = findDateInText(`${text} ${titleAttr} ${nu}`) || null;
      const type = classifyDocType(`${text} ${titleAttr} ${nu}`);
      downloads.push({
        url: nu,
        title: text || titleAttr || path.basename(new URL(nu).pathname),
        date: guessDate,
        type,
        foundOn: currentUrl,
      });
      return;
    }

    if (isProbablyBinary(nu) && !looksLikePdfUrl(nu)) return;
    urls.add(nu);
  });

  return { links: Array.from(urls), downloads };
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
function isHtmlResponse(r) {
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}
function isPdfResponse(r) {
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/pdf");
}

/* ============================================================
   LATEST helpers
   ============================================================ */

function pickBestDateForPage(p) {
  const d1 = findDateInText(p?.published || "");
  if (d1) return d1;
  const d2 = findDateInText(p?.url || "");
  if (d2) return d2;
  const d3 = findDateInText(p?.title || "");
  if (d3) return d3;
  const sample = (p?.content || "").slice(0, 1500);
  const d4 = findDateInText(sample);
  if (d4) return d4;
  return null;
}

function isLatestPageUrl(url) {
  return /\/(aktualne\/aktuality|aktualne\/kalendar-akci|urad\/uredni-deska|uredni-deska|zpravodaj)\b/i.test(url || "");
}

async function buildLatestFile(latestPath, pages, docs) {
  await fs.mkdir(path.dirname(latestPath), { recursive: true });

  const pageItems = pages
    .filter((p) => isLatestPageUrl(p.url))
    .map((p) => {
      const date = pickBestDateForPage(p);
      const snippet = (p.content || "").split("\n").slice(0, 12).join("\n").trim();
      return { kind: "PAGE", date: date || "", title: (p.title || "").trim(), url: p.url, snippet };
    });

  const docItems = (docs || [])
    .map((d) => ({
      kind: "DOC",
      date: d.date || "",
      type: d.type || "DOKUMENT",
      title: (d.title || "").replace(/\s+/g, " ").trim(),
      url: d.url,
      foundOn: d.foundOn || "",
    }))
    .filter((d) => d.date || /ÚŘEDNÍ_DESKA|VYHLÁŠKA|NAŘÍZENÍ|ZPRAVODAJ|ROZPOČET/i.test(d.type));

  function sortByDateDesc(a, b) {
    const da = a.date || "";
    const db = b.date || "";
    if (da && db) return db.localeCompare(da);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return (a.title || "").localeCompare(b.title || "");
  }

  pageItems.sort(sortByDateDesc);
  docItems.sort(sortByDateDesc);

  const merged = [...pageItems, ...docItems];

  const seen = new Set();
  const final = [];
  for (const it of merged) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    final.push(it);
    if (final.length >= LATEST_MAX_ITEMS) break;
  }

  const header = [
    `${LATEST_PREFIX}`,
    `Vygenerováno: ${new Date().toISOString()}`,
    `Zdroj: ${SITE_BASE_URL}`,
    ``,
    `Tento soubor obsahuje nejnovější položky (aktuality, akce, úřední deska, dokumenty).`,
    `Řazeno od nejnovějších dle nalezeného data (pokud je dostupné).`,
    ``,
    `==============================`,
    `=== LATEST (${final.length})`,
    `Formát: KIND | DATE | TITLE/TYPE | URL | EXTRA`,
    ``,
  ].join("\n");

  let body = "";
  for (const it of final) {
    if (it.kind === "PAGE") {
      const title = (it.title || "").replace(/\s+/g, " ").trim();
      const snippet = (it.snippet || "").trim();
      body += `PAGE | ${it.date || ""} | ${title} | ${it.url} |\n`;
      if (snippet) body += `${snippet}\n`;
      body += `\n`;
    } else {
      body += `DOC | ${it.date || ""} | ${it.type} | ${it.title} | ${it.url} | ${it.foundOn}\n`;
    }
  }

  await fs.writeFile(latestPath, (header + body.trim() + "\n").trim() + "\n", "utf-8");
  console.log("LATEST written:", latestPath);
}

/* ============================================================
   PDF TEXT build (extract text from important PDFs)
   ============================================================ */

function isImportantPdfDoc(d) {
  const t = String(d?.type || "").toUpperCase();
  const s = `${d?.title || ""} ${d?.foundOn || ""} ${d?.url || ""}`.toLowerCase();

  if (t.includes("VYHLÁŠKA") || t.includes("NAŘÍZENÍ") || t.includes("ODPADY")) return true;
  if (t.includes("ÚŘEDNÍ_DESKA") || t.includes("ROZPOČET")) return true;

  if (s.includes("poplatek") || s.includes("odpad") || s.includes("psů") || s.includes("psu") || s.includes("vyhl"))
    return true;

  return false;
}

async function fetchPdfBuffer(url) {
  const r = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { "User-Agent": "RadimFullCrawler/2.5 (pdf)" },
  });
  if (!r.ok) throw new Error(`PDF fetch failed ${r.status}`);

  // ✅ tady je zásadní rozdíl: ověřujeme content-type
  if (!isPdfResponse(r)) {
    const ct = r.headers.get("content-type") || "";
    throw new Error(`Not a PDF by content-type: ${ct}`);
  }

  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function extractPdfTextFromUrl(url) {
  const buf = await fetchPdfBuffer(url);

  if (buf.length > PDFTEXT_MAX_BYTES) throw new Error(`PDF too large: ${buf.length} bytes`);

  const parsed = await pdfParse(buf);
  let text = stripWeirdWhitespace(parsed?.text || "");

  if (text.length < 200) throw new Error("PDF has almost no extractable text (likely scanned image)");

  if (text.length > PDFTEXT_MAX_CHARS_PER_PDF) {
    text = text.slice(0, PDFTEXT_MAX_CHARS_PER_PDF) + "\n\n[ZKRÁCENO]";
  }
  return text;
}

async function buildPdfTextFile(pdfTextPath, docs) {
  await fs.mkdir(path.dirname(pdfTextPath), { recursive: true });

  // kandidáti: primárně URL co vypadají jako PDF, ale když je vyhláška/odpady a je to download,
  // tak to zkusíme taky (a necháme rozhodnout content-type)
  const candidates = (docs || [])
    .filter((d) => d?.url)
    .filter((d) => {
      if (looksLikePdfUrl(d.url)) return true;
      // fallback: vyhláška/odpady přes download linky, které nemají pdf v URL
      if (isImportantPdfDoc(d) && /e_download\.php|evt_file\.php/i.test(d.url)) return true;
      return false;
    })
    .filter(isImportantPdfDoc);

  candidates.sort(
    (a, b) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(a.title || "").localeCompare(String(b.title || ""))
  );

  const uniq = [];
  const seen = new Set();
  for (const d of candidates) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    uniq.push(d);
  }

  const picked = uniq.slice(0, PDFTEXT_MAX_PDFS);

  const header = [
    `${PDFTEXT_PREFIX}`,
    `Vygenerováno: ${new Date().toISOString()}`,
    `Zdroj: ${SITE_BASE_URL}`,
    ``,
    `Tento soubor obsahuje TEXT extrahovaný z vybraných PDF (vyhlášky, nařízení, odpady, poplatky, úřední deska…).`,
    `Pozn.: Pokud je PDF pouze sken bez textové vrstvy, bude zde hláška [NELZE EXTRAHOVAT TEXT].`,
    ``,
    `==============================`,
    `=== PDF TEXT (${picked.length})`,
    ``,
  ].join("\n");

  const results = new Array(picked.length).fill(null);

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= picked.length) return;

      const d = picked[i];
      const meta = [
        `==============================`,
        `PDF_TITLE: ${(d.title || "").replace(/\s+/g, " ").trim()}`,
        `PDF_TYPE: ${d.type || ""}`,
        `PDF_DATE: ${d.date || ""}`,
        `PDF_URL: ${d.url}`,
        `FOUND_ON: ${d.foundOn || ""}`,
        `CONTENT:`,
      ].join("\n");

      try {
        const text = await extractPdfTextFromUrl(d.url);
        results[i] = `${meta}\n${text}\n`;
      } catch (e) {
        results[i] = `${meta}\n[NELZE EXTRAHOVAT TEXT] ${e?.message || String(e)}\n`;
      }

      if (i % 5 === 0) await sleep(50);
    }
  }

  await Promise.all(Array.from({ length: PDFTEXT_CONCURRENCY }, () => worker()));

  const final = (header + results.join("\n") + "\n").trim() + "\n";
  await fs.writeFile(pdfTextPath, final, "utf-8");
  console.log("PDFTEXT written:", pdfTextPath);
}

/* ============================================================
   FULL CRAWLER
   ============================================================ */

async function buildFullKnowledgeFile(outPath) {
  console.log("Building FULL knowledge from:", SITE_BASE_URL);
  console.log("MAX_PAGES:", MAX_PAGES, "CONCURRENCY:", CONCURRENCY);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const startUrl = normalizeUrl(SITE_BASE_URL + "/");
  const queue = [startUrl];
  const seen = new Set();

  const pages = [];
  const pageHashSeen = new Set();
  const documents = new Map();

  let processed = 0;

  async function worker() {
    while (true) {
      if (pages.length >= MAX_PAGES) return;

      const next = queue.shift();
      if (!next) return;

      const url = next;
      if (seen.has(url)) continue;
      seen.add(url);

      if (looksLikeLoginOrAdmin(url)) continue;
      if (looksLikeGalleryHeavy(url)) continue;
      if (isProbablyBinary(url) && !looksLikePdfUrl(url)) continue;

      try {
        const r = await fetchWithTimeout(url, {
          redirect: "follow",
          headers: { "User-Agent": "RadimFullCrawler/2.5" },
        });

        if (!r.ok) {
          processed++;
          continue;
        }

        // ✅ Pokud server vrátí PDF (podle content-type), přidáme mezi docs a dál neparsujeme jako HTML
        if (isPdfResponse(r)) {
          if (!documents.has(url)) {
            documents.set(url, {
              url,
              title: path.basename(new URL(url).pathname) || "dokument.pdf",
              date: findDateInText(url),
              type: classifyDocType(url),
              foundOn: "",
            });
          }
          processed++;
          continue;
        }

        if (!isHtmlResponse(r)) {
          processed++;
          continue;
        }

        const html = await r.text();
        processed++;

        const { links, downloads } = extractLinksAndDownloads(html, url);
        for (const u of links) {
          if (!seen.has(u)) queue.push(u);
        }

        for (const d of downloads) {
          const prev = documents.get(d.url);
          if (!prev) {
            documents.set(d.url, d);
          } else {
            const betterTitle = (prev.title || "").length >= (d.title || "").length ? prev.title : d.title;
            const betterDate = prev.date || d.date || null;
            const betterType = prev.type !== "DOKUMENT" ? prev.type : d.type;
            documents.set(d.url, {
              url: d.url,
              title: betterTitle,
              date: betterDate,
              type: betterType,
              foundOn: prev.foundOn || d.foundOn || "",
            });
          }
        }

        const { title, published, cleaned } = extractMainTextFromHtml(html);

        const important =
          /\/(aktualne|aktuality|urad\/uredni-deska|uredni-deska|kalendar-akci|zpravodaj|urad|obec|organizace-a-spolky|vyhlasky|dokumenty)\b/i.test(
            url
          );

        if (!important && cleaned.length < 250) continue;

        const contentKey = sha1(`${title}\n${cleaned}`.slice(0, 20000));
        if (pageHashSeen.has(contentKey)) continue;
        pageHashSeen.add(contentKey);

        const localDownloads = downloads.slice(0, 60).map((d) => ({
          url: d.url,
          title: d.title,
          date: d.date,
          type: d.type,
        }));

        pages.push({
          url,
          title: title || "",
          published: published || "",
          content: cleaned,
          downloads: localDownloads,
        });

        if (processed % 30 === 0) await sleep(120);
      } catch {
        // ignore
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  pages.sort((a, b) => {
    if (a.url === startUrl) return -1;
    if (b.url === startUrl) return 1;
    return a.url.localeCompare(b.url);
  });

  const docs = Array.from(documents.values());
  docs.sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da && db) return db.localeCompare(da);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  const header = [
    `${PREFIX}`,
    `Vygenerováno: ${new Date().toISOString()}`,
    `Zdroj: ${SITE_BASE_URL}`,
    ``,
    `Tento soubor je FULL crawl webu obce Radim.`,
    `Obsahuje text stránek + INDEX dokumentů ke stažení (přímé odkazy).`,
    ``,
    `==============================`,
    `=== DOCUMENTS INDEX (${docs.length})`,
    `Formát: TYPE | DATE | TITLE | URL | FOUND_ON`,
    ``,
  ].join("\n");

  let docsBlock = "";
  for (const d of docs) {
    docsBlock += `${d.type || "DOKUMENT"} | ${d.date || ""} | ${(d.title || "").replace(/\s+/g, " ").trim()} | ${
      d.url
    } | ${d.foundOn || ""}\n`;
  }

  let pagesBlock = `\n==============================\n=== PAGES (${pages.length})\n\n`;
  for (const p of pages) {
    pagesBlock += `==============================\n=== PAGE\nURL: ${p.url}\n`;
    if (p.title) pagesBlock += `TITLE: ${p.title}\n`;
    if (p.published) pagesBlock += `PUBLISHED: ${p.published}\n`;
    if (p.downloads?.length) {
      pagesBlock += `DOWNLOADS:\n`;
      for (const d of p.downloads) {
        pagesBlock += `- ${d.type || "DOKUMENT"} | ${d.date || ""} | ${d.title || ""} | ${d.url}\n`;
      }
    }
    pagesBlock += `CONTENT:\n${p.content}\n\n`;
  }

  const finalText = (header + docsBlock + pagesBlock).trim() + "\n";
  await fs.writeFile(outPath, finalText, "utf-8");

  console.log("FULL written:", outPath);
  console.log("Pages:", pages.length, "Docs:", docs.length, "Seen:", seen.size, "Queue left:", queue.length);

  return { pages, docs };
}

/* ============================================================
   OpenAI helpers
   ============================================================ */

async function oaiFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...OPENAI_BETA_HEADER,
    ...(options.headers || {}),
  };

  const r = await fetch(url, { ...options, headers });
  const txt = await r.text();

  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {}

  if (!r.ok) {
    const msg = json?.error?.message || txt;
    throw new Error(`OpenAI error ${r.status}: ${msg}`);
  }
  return json ?? txt;
}

async function uploadFileToOpenAI(filepath) {
  const data = await fs.readFile(filepath);
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([data]), path.basename(filepath));

  const file = await oaiFetch("https://api.openai.com/v1/files", { method: "POST", body: form });
  return file.id;
}

async function attachToVectorStore(fileId) {
  return await oaiFetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
}

async function listVectorStoreFilesPage(after = null, limit = 100) {
  const url =
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=${limit}` + (after ? `&after=${after}` : "");
  return await oaiFetch(url, { method: "GET" });
}

async function listAllVectorStoreFiles(limit = 100) {
  const all = [];
  let after = null;

  while (true) {
    const page = await listVectorStoreFilesPage(after, limit);
    const data = page?.data || [];
    all.push(...data);

    if (!page?.has_more) break;

    const last = data[data.length - 1];
    if (!last?.id) break;
    after = last.id;
  }
  return all;
}

async function deleteVectorStoreFile(vsFileId) {
  return await oaiFetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${vsFileId}`, {
    method: "DELETE",
  });
}

async function getFileMeta(fileId) {
  return await oaiFetch(`https://api.openai.com/v1/files/${fileId}`, { method: "GET" });
}

function isFullName(name) {
  return (name || "").startsWith(PREFIX);
}
function isLatestName(name) {
  return (name || "").startsWith(LATEST_PREFIX);
}
function isPdfTextName(name) {
  return (name || "").startsWith(PDFTEXT_PREFIX);
}

function pickFilenameFromVsItem(it) {
  return it?.file?.filename || it?.file?.name || "";
}

async function resolveFilename(it) {
  const embedded = pickFilenameFromVsItem(it);
  if (embedded) return embedded;

  const fid = it?.file_id || it?.file?.id;
  if (!fid) return "";

  try {
    const meta = await getFileMeta(fid);
    return meta?.filename || "";
  } catch {
    return "";
  }
}

function resolveCreatedAt(it, fileMetaCreatedAt) {
  return it?.created_at || fileMetaCreatedAt || 0;
}

async function buildIndexForCleanup(items) {
  const out = [];
  for (const it of items) {
    const vsId = it?.id;
    const fileId = it?.file_id || it?.file?.id;
    if (!vsId || !fileId) continue;

    const filename = await resolveFilename(it);
    let metaCreatedAt = 0;
    if (!filename) {
      try {
        const meta = await getFileMeta(fileId);
        metaCreatedAt = meta?.created_at || 0;
      } catch {}
    }

    const created_at = resolveCreatedAt(it, metaCreatedAt);
    out.push({ vsId, fileId, filename, created_at });
  }
  return out;
}

async function cleanupByPrefix(prefixName, keepN, matchFn) {
  const items = await listAllVectorStoreFiles(100);
  const indexed = await buildIndexForCleanup(items);

  const matched = indexed.filter((x) => matchFn(x.filename));
  matched.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const toDelete = matched.slice(Math.max(keepN, 0));
  console.log(`${prefixName} in store: ${matched.length}, keeping: ${Math.min(keepN, matched.length)}, deleting: ${toDelete.length}`);

  for (const d of toDelete) {
    await deleteVectorStoreFile(d.vsId);
  }
}

/* ============================================================
   MAIN
   ============================================================ */

export async function main() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

  const fullPath = path.join(OUT_DIR, OUT_FILE);
  const latestPath = path.join(OUT_DIR, LATEST_OUT_FILE);
  const pdfTextPath = path.join(OUT_DIR, PDFTEXT_OUT_FILE);

  console.log("== RADIM FULL + LATEST + PDFTEXT ==");
  console.log("SITE:", SITE_BASE_URL);
  console.log("FULL OUT:", fullPath);
  console.log("LATEST OUT:", latestPath);
  console.log("PDFTEXT OUT:", pdfTextPath);
  console.log("VECTOR_STORE_ID:", VECTOR_STORE_ID);

  const { pages, docs } = await buildFullKnowledgeFile(fullPath);

  const stat = await fs.stat(fullPath);
  if (stat.size < 50_000) throw new Error(`FULL file too small (${stat.size} bytes) – refusing upload`);

  await buildLatestFile(latestPath, pages, docs);
  const latestStat = await fs.stat(latestPath);
  if (latestStat.size < 5_000) throw new Error(`LATEST file too small (${latestStat.size} bytes) – refusing upload`);

  console.log("Building PDF TEXT...");
  await buildPdfTextFile(pdfTextPath, docs);

  const pdfTextStat = await fs.stat(pdfTextPath);
  console.log("PDFTEXT size:", pdfTextStat.size, "bytes");
  if (pdfTextStat.size < 20_000) {
    console.log("WARN: PDFTEXT is still small -> znamená to, že většina PDF nemá textovou vrstvu, nebo se nenašly PDF kandidáti.");
  }

  console.log("Uploading FULL...");
  const fileId = await uploadFileToOpenAI(fullPath);
  await attachToVectorStore(fileId);

  console.log("Uploading LATEST...");
  const latestFileId = await uploadFileToOpenAI(latestPath);
  await attachToVectorStore(latestFileId);

  console.log("Uploading PDFTEXT...");
  const pdfTextFileId = await uploadFileToOpenAI(pdfTextPath);
  await attachToVectorStore(pdfTextFileId);

  if (CLEANUP_OLD) await cleanupByPrefix("FULL", KEEP_LATEST, isFullName);
  if (CLEANUP_OLD_LATEST) await cleanupByPrefix("LATEST", KEEP_LATEST_LATEST, isLatestName);
  if (CLEANUP_OLD_PDFTEXT) await cleanupByPrefix("PDFTEXT", KEEP_LATEST_PDFTEXT, isPdfTextName);

  console.log("DONE ✅");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("FULL script failed:", e);
    process.exit(1);
  });
}