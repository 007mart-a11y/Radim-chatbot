// scripts/full_radim_build_and_upload.mjs
// CURRENT-first knowledge build for Radim
// - crawls web -> pages + documents index
// - builds ONE main "current" file: knowledge/10_CURRENT_obec_radim.txt
// - builds archive index only (no full old text): knowledge/90_ARCHIVE_INDEX_obec_radim.txt
// - extracts text from selected PDFs into the CURRENT file (only recent / important PDFs)
//
// Requirements: Node 18+, deps: jsdom, pdf-parse
//   npm i jsdom pdf-parse
//
// Env:
//   SITE_BASE_URL=https://www.obec-radim.cz
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=...
//
// Crawl:
//   MAX_PAGES=450 (default)
//   CONCURRENCY=3 (default)
//   REQUEST_TIMEOUT_MS=25000 (default)
//
// Current/Archive logic:
//   CURRENT_CUTOFF_DAYS=730 (default)  // 2 roky "aktuální"
//   CURRENT_MAX_PDF_TEXT=40 (default)  // kolik PDF vytáhnout textem do CURRENT
//   PDFTEXT_MAX_BYTES=8000000 (default) // 8 MB
//   PDFTEXT_MAX_CHARS_PER_PDF=60000 (default)
//
// Upload/Cleanup:
//   CLEANUP_OLD=1 (default) | 0
//   KEEP_LATEST=3 (default) // keep last N "10_CURRENT" builds in vector store (safety)

import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "450", 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY ?? "3", 10));
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "25000", 10);

const CURRENT_CUTOFF_DAYS = parseInt(process.env.CURRENT_CUTOFF_DAYS ?? "730", 10);
const CURRENT_MAX_PDF_TEXT = parseInt(process.env.CURRENT_MAX_PDF_TEXT ?? "40", 10);
const PDFTEXT_MAX_BYTES = parseInt(process.env.PDFTEXT_MAX_BYTES ?? "8000000", 10);
const PDFTEXT_MAX_CHARS_PER_PDF = parseInt(process.env.PDFTEXT_MAX_CHARS_PER_PDF ?? "60000", 10);

const CLEANUP_OLD = (process.env.CLEANUP_OLD ?? "1") !== "0";
const KEEP_LATEST = parseInt(process.env.KEEP_LATEST ?? "3", 10);

// Output
const OUT_DIR = "knowledge";
const CURRENT_PREFIX = "10_CURRENT_obec_radim";
const ARCHIVE_PREFIX = "90_ARCHIVE_INDEX_obec_radim";
const CURRENT_FILE = `${CURRENT_PREFIX}.txt`;
const ARCHIVE_FILE = `${ARCHIVE_PREFIX}.txt`;

// OpenAI headers (vector stores)
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

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
    // prefer canonical (no /seniori/)
    u.pathname = u.pathname.replace(/^\/seniori\//, "/");
    // drop tracking
    const drop = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","kshow"];
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

function isDownloadDoc(url) {
  const u = String(url || "");
  return /\.(pdf|doc|docx|xls|xlsx|odt|ods|ppt|pptx|rtf|txt|csv|zip)(\?.*)?$/i.test(u) || /e_download\.php/i.test(u);
}
function isPdfUrl(u) {
  const s = String(u || "");
  return /\.pdf(\?.*)?$/i.test(s) || (/e_download\.php/i.test(s) && /original=.*\.pdf/i.test(s));
}

function stripWeirdWhitespace(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

function isoToCz(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y,m,d] = iso.split("-");
  return `${d}. ${m}. ${y}`;
}

function classifyDocType(titleOrUrl) {
  const s = (titleOrUrl || "").toLowerCase();
  if (s.includes("vyhláška") || s.includes("obecně závazná vyhláška") || s.includes("ozv")) return "VYHLÁŠKA";
  if (s.includes("nařízení")) return "NAŘÍZENÍ";
  if (s.includes("zpravodaj")) return "ZPRAVODAJ";
  if (s.includes("úřední deska") || s.includes("uredni-deska") || s.includes("záměr") || s.includes("zamer")) return "ÚŘEDNÍ_DESKA";
  if (s.includes("rozpočet") || s.includes("rozpočt") || s.includes("rozpoct")) return "ROZPOČET";
  if (s.includes("poplatek") || s.includes("odpad") || s.includes("psů") || s.includes("psu")) return "POPLATKY_ODPADY";
  return "DOKUMENT";
}

function pickTitle(doc) {
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1) return h1;
  const t = doc.querySelector("title")?.textContent?.trim();
  return t || "";
}

function cleanText(text) {
  let t = stripWeirdWhitespace(text);
  // remove very short noisy lines
  const lines = t.split("\n").map((x) => x.trim());
  const out = [];
  for (const ln of lines) {
    if (!ln) { if (out[out.length-1] !== "") out.push(""); continue; }
    if (ln.length === 1) continue;
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractMainTextFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // remove noise
  for (const sel of ["script","style","noscript","svg","form","nav","header","footer","aside",".navbar",".menu",".breadcrumbs",".breadcrumb",".search",".vyhledavani",".cookie",".gdpr",".pagination",".pager",".sidebar",".right",".left",".gallery",".fotogalerie"]) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }

  const candidates = ["main","#content",".content",".page-content",".text",".article",".article-text",".detail",".detail-text",".module-content"];
  let node = null;
  for (const sel of candidates) {
    const n = doc.querySelector(sel);
    if (n && (n.textContent || "").trim().length > 250) { node = n; break; }
  }
  if (!node) node = doc.body;

  const title = pickTitle(doc);

  const bodyText = doc.body?.textContent || "";
  const published =
    bodyText.match(/Vyvěšeno:\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i)?.[0]?.trim() ||
    bodyText.match(/Vytvořeno:\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i)?.[0]?.trim() ||
    "";

  return { title, published, cleaned: cleanText(node?.textContent || "") };
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

    if (isProbablyBinary(nu) && !isPdfUrl(nu)) return;
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
  const ct = r.headers.get("content-type") || "";
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

function nowIso() {
  return new Date().toISOString();
}
function cutoffDateIso() {
  const ms = Date.now() - CURRENT_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function isRecentIsoDate(iso) {
  const c = cutoffDateIso();
  if (!iso) return false;
  return iso >= c;
}
function guessItemDate({ url, title, published, content }) {
  return (
    findDateInText(published || "") ||
    findDateInText(url || "") ||
    findDateInText(title || "") ||
    findDateInText((content || "").slice(0, 1200)) ||
    null
  );
}

function isImportantPageUrl(url) {
  return /\/(urad|aktualne|aktuality|uredni-deska|kalendar-akci|povinne-informace|czech-point|skladka-bioodpadu|poplatky|odpady|kontakty)\b/i.test(url || "");
}

function isImportantDoc(d) {
  const t = String(d?.type || "");
  const s = `${d?.title || ""} ${d?.url || ""} ${d?.foundOn || ""}`.toLowerCase();
  if (t.includes("VYHLÁŠKA") || t.includes("NAŘÍZENÍ")) return true;
  if (t.includes("POPLATKY_ODPADY") || t.includes("ROZPOČET") || t.includes("ÚŘEDNÍ_DESKA")) return true;
  if (s.includes("poplatek") || s.includes("odpad") || s.includes("psů") || s.includes("psu")) return true;
  return false;
}

async function buildCrawl() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const startUrl = normalizeUrl(SITE_BASE_URL + "/");
  const queue = [startUrl];
  const seen = new Set();

  const pages = [];
  const pageHashSeen = new Set();
  const documents = new Map();

  let processed = 0;

  async function worker() {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      if (pages.length >= MAX_PAGES) return;

      const url = next;
      if (seen.has(url)) continue;
      seen.add(url);

      if (looksLikeLoginOrAdmin(url)) continue;
      if (looksLikeGalleryHeavy(url)) continue;
      if (isProbablyBinary(url) && !isPdfUrl(url)) continue;

      try {
        const r = await fetchWithTimeout(url, {
          redirect: "follow",
          headers: { "User-Agent": "RadimCrawler/CURRENT-1.0" },
        });

        if (!r.ok) { processed++; continue; }

        if (isPdfUrl(url)) {
          if (!documents.has(url)) {
            documents.set(url, {
              url,
              title: path.basename(new URL(url).pathname),
              date: findDateInText(url),
              type: classifyDocType(url),
              foundOn: "",
            });
          }
          processed++;
          continue;
        }

        if (!isHtmlResponse(r)) { processed++; continue; }

        const html = await r.text();
        processed++;

        const { links, downloads } = extractLinksAndDownloads(html, url);
        for (const u of links) if (!seen.has(u)) queue.push(u);

        for (const d of downloads) {
          const prev = documents.get(d.url);
          if (!prev) documents.set(d.url, d);
          else {
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
        const important = isImportantPageUrl(url) || cleaned.length > 600;

        if (!important && cleaned.length < 250) continue;

        const contentKey = sha1(`${title}\n${cleaned}`.slice(0, 20000));
        if (pageHashSeen.has(contentKey)) continue;
        pageHashSeen.add(contentKey);

        pages.push({
          url,
          title: title || "",
          published: published || "",
          content: cleaned,
        });

        if (processed % 40 === 0) await sleep(120);
      } catch {
        // ignore
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const docs = Array.from(documents.values()).map((d) => ({
    ...d,
    url: normalizeUrl(d.url),
    foundOn: normalizeUrl(d.foundOn || ""),
  }));

  return { pages, docs, seenCount: seen.size, processed };
}

/* ============================
   PDF text extraction (CURRENT)
   ============================ */

async function fetchPdfBuffer(url) {
  const r = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { "User-Agent": "RadimCrawler/PDFTEXT-1.0" },
  });
  if (!r.ok) throw new Error(`PDF fetch failed ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function extractPdfText(url) {
  const buf = await fetchPdfBuffer(url);
  if (buf.length > PDFTEXT_MAX_BYTES) throw new Error(`PDF too large: ${buf.length} bytes`);
  const parsed = await pdfParse(buf);
  let text = stripWeirdWhitespace(parsed?.text || "");
  if (text.length < 200) throw new Error("PDF has no extractable text (likely scanned)");
  if (text.length > PDFTEXT_MAX_CHARS_PER_PDF) text = text.slice(0, PDFTEXT_MAX_CHARS_PER_PDF) + "\n\n[ZKRÁCENO]";
  return text;
}

/* ============================
   Build CURRENT + ARCHIVE
   ============================ */

function sortByDateDesc(a, b) {
  const da = a.date || "";
  const db = b.date || "";
  if (da && db) return db.localeCompare(da);
  if (da && !db) return -1;
  if (!da && db) return 1;
  return (a.title || "").localeCompare(b.title || "");
}

async function buildCurrentAndArchive({ pages, docs }) {
  const cutoff = cutoffDateIso();

  // Enrich page dates
  const pagesEnriched = pages.map((p) => ({
    ...p,
    date: guessItemDate(p),
  }));

  // Recent pages = date >= cutoff OR very important evergreen pages (kontakty, povinné info, bioodpad)
  const evergreen = (url) =>
    /\/(urad\/kontakty|urad\/povinne-informace|urad\/czech-point|urad\/skladka-bioodpadu)\b/i.test(url || "");

  const currentPages = pagesEnriched
    .filter((p) => evergreen(p.url) || (p.date && isRecentIsoDate(p.date)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.url.localeCompare(b.url));

  const archivePages = pagesEnriched
    .filter((p) => !evergreen(p.url) && p.date && !isRecentIsoDate(p.date))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.url.localeCompare(b.url));

  // Docs dates
  const docsEnriched = docs.map((d) => ({
    ...d,
    date: d.date || findDateInText(d.title || "") || findDateInText(d.url || "") || null,
    type: d.type || classifyDocType(`${d.title} ${d.url}`),
  }));

  const importantDocs = docsEnriched.filter(isImportantDoc);

  const currentDocs = importantDocs
    .filter((d) => (d.date && isRecentIsoDate(d.date)) || (!d.date && /vyhl|poplat|odpad|ps/i.test((d.title || "") + " " + d.url)))
    .sort(sortByDateDesc);

  const archiveDocs = importantDocs
    .filter((d) => d.date && !isRecentIsoDate(d.date))
    .sort(sortByDateDesc);

  // Pick PDFs for text extraction (CURRENT only)
  const pdfCandidates = currentDocs.filter((d) => d.url && isPdfUrl(d.url)).slice(0, CURRENT_MAX_PDF_TEXT);

  const pdfTextBlocks = [];
  for (const d of pdfCandidates) {
    const meta = [
      `------------------------------`,
      `PDF_TITLE: ${(d.title || "").replace(/\s+/g, " ").trim()}`,
      `PDF_TYPE: ${d.type || ""}`,
      `PDF_DATE: ${d.date || ""} (${isoToCz(d.date)})`,
      `PDF_URL: ${d.url}`,
      `FOUND_ON: ${d.foundOn || ""}`,
      `TEXT:`,
    ].join("\n");

    try {
      const txt = await extractPdfText(d.url);
      pdfTextBlocks.push(`${meta}\n${txt}\n`);
    } catch (e) {
      pdfTextBlocks.push(`${meta}\n[NELZE EXTRAHOVAT TEXT] ${e?.message || String(e)}\n`);
    }
    await sleep(40);
  }

  const currentHeader = [
    `${CURRENT_PREFIX}`,
    `Vygenerováno: ${nowIso()}`,
    `Zdroj: ${SITE_BASE_URL}`,
    `CUT_OFF (aktuální od): ${cutoff} (${isoToCz(cutoff)})`,
    ``,
    `Tento soubor je určen pro odpovědi na AKTUÁLNÍ dotazy (2026 a poslední ~2 roky) + důležité evergreen stránky (kontakty, Czech POINT, bioodpad).`,
    `Starší věci jsou v ARCHIVE INDEX (90_ARCHIVE_INDEX...).`,
    ``,
    `==============================`,
    `=== CURRENT DOCUMENTS (vyhlášky / poplatky / odpady / úřední deska)`,
    `Formát: TYPE | DATE | TITLE | URL | FOUND_ON`,
    ``,
  ].join("\n");

  let currentDocsBlock = "";
  for (const d of currentDocs) {
    currentDocsBlock += `${d.type} | ${d.date || ""} | ${(d.title || "").replace(/\s+/g, " ").trim()} | ${d.url} | ${d.foundOn || ""}\n`;
  }

  const currentPagesHeader = [
    ``,
    `==============================`,
    `=== CURRENT PAGES (${currentPages.length})`,
    `Formát: DATE | TITLE | URL`,
    ``,
  ].join("\n");

  let currentPagesBlock = "";
  for (const p of currentPages) {
    currentPagesBlock += `${p.date || ""} | ${(p.title || "").replace(/\s+/g, " ").trim()} | ${p.url}\n`;
  }

  const pdfHeader = [
    ``,
    `==============================`,
    `=== PDF TEXT (aktuální vybrané PDF: ${pdfTextBlocks.length})`,
    `Pozn.: Pokud je PDF sken bez textové vrstvy, bude zde hláška.`,
    ``,
  ].join("\n");

  const currentFinal =
    currentHeader +
    currentDocsBlock.trim() +
    "\n" +
    currentPagesHeader +
    currentPagesBlock.trim() +
    "\n" +
    pdfHeader +
    pdfTextBlocks.join("\n");

  const archiveHeader = [
    `${ARCHIVE_PREFIX}`,
    `Vygenerováno: ${nowIso()}`,
    `Zdroj: ${SITE_BASE_URL}`,
    `CUT_OFF (aktuální od): ${cutoff} (${isoToCz(cutoff)})`,
    ``,
    `ARCHIVNÍ INDEX – starší položky (bez plného obsahu). Používej jen když se uživatel ptá na historii/staré vyhlášky.`,
    ``,
    `==============================`,
    `=== ARCHIVE DOCUMENTS`,
    `Formát: TYPE | DATE | TITLE | URL | FOUND_ON`,
    ``,
  ].join("\n");

  let archiveDocsBlock = "";
  for (const d of archiveDocs) {
    archiveDocsBlock += `${d.type} | ${d.date || ""} | ${(d.title || "").replace(/\s+/g, " ").trim()} | ${d.url} | ${d.foundOn || ""}\n`;
  }

  const archivePagesHeader = [
    ``,
    `==============================`,
    `=== ARCHIVE PAGES`,
    `Formát: DATE | TITLE | URL`,
    ``,
  ].join("\n");

  let archivePagesBlock = "";
  for (const p of archivePages.slice(0, 500)) {
    archivePagesBlock += `${p.date || ""} | ${(p.title || "").replace(/\s+/g, " ").trim()} | ${p.url}\n`;
  }

  const archiveFinal = archiveHeader + archiveDocsBlock.trim() + "\n" + archivePagesHeader + archivePagesBlock.trim() + "\n";

  const currentPath = path.join(OUT_DIR, CURRENT_FILE);
  const archivePath = path.join(OUT_DIR, ARCHIVE_FILE);

  await fs.writeFile(currentPath, currentFinal, "utf-8");
  await fs.writeFile(archivePath, archiveFinal, "utf-8");

  console.log("CURRENT written:", currentPath);
  console.log("ARCHIVE written:", archivePath);

  return { currentPath, archivePath };
}

/* ============================
   OpenAI upload + cleanup
   ============================ */

async function oaiFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...OPENAI_BETA_HEADER,
    ...(options.headers || {}),
  };
  const r = await fetch(url, { ...options, headers });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
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

async function listAllVectorStoreFiles(limit = 100) {
  const all = [];
  let after = null;
  while (true) {
    const url =
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=${limit}` + (after ? `&after=${after}` : "");
    const page = await oaiFetch(url, { method: "GET" });
    const data = page?.data || [];
    all.push(...data);
    if (!page?.has_more) break;
    const last = data[data.length - 1];
    if (!last?.id) break;
    after = last.id;
  }
  return all;
}

async function getFileMeta(fileId) {
  return await oaiFetch(`https://api.openai.com/v1/files/${fileId}`, { method: "GET" });
}

async function deleteVectorStoreFile(vsFileId) {
  return await oaiFetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${vsFileId}`, { method: "DELETE" });
}

async function cleanupCurrentBuilds() {
  const items = await listAllVectorStoreFiles(100);
  const indexed = [];
  for (const it of items) {
    const vsId = it?.id;
    const fileId = it?.file_id || it?.file?.id;
    if (!vsId || !fileId) continue;
    let filename = it?.file?.filename || it?.file?.name || "";
    if (!filename) {
      try {
        const meta = await getFileMeta(fileId);
        filename = meta?.filename || "";
      } catch {}
    }
    const created_at = it?.created_at || 0;
    indexed.push({ vsId, fileId, filename, created_at });
  }

  const matched = indexed.filter((x) => x.filename.startsWith(CURRENT_PREFIX));
  matched.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const toDelete = matched.slice(Math.max(KEEP_LATEST, 0));
  console.log(`CURRENT builds in store: ${matched.length}, keep: ${Math.min(KEEP_LATEST, matched.length)}, delete: ${toDelete.length}`);

  for (const d of toDelete) {
    console.log("Deleting old CURRENT:", d.filename, d.vsId);
    await deleteVectorStoreFile(d.vsId);
  }
}

export async function main() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

  console.log("== RADIM CURRENT BUILD ==");
  console.log("SITE:", SITE_BASE_URL);
  console.log("VECTOR_STORE_ID:", VECTOR_STORE_ID);

  const { pages, docs, seenCount, processed } = await buildCrawl();
  console.log("Crawl done. Pages:", pages.length, "Docs:", docs.length, "Seen:", seenCount, "Processed:", processed);

  const { currentPath, archivePath } = await buildCurrentAndArchive({ pages, docs });

  // sanity
  const st1 = await fs.stat(currentPath);
  if (st1.size < 10_000) throw new Error(`CURRENT file too small (${st1.size} bytes)`);
  const st2 = await fs.stat(archivePath);
  if (st2.size < 2_000) console.log("WARN: ARCHIVE small, ok.");

  console.log("Uploading CURRENT...");
  const currentFileId = await uploadFileToOpenAI(currentPath);
  console.log("Uploaded CURRENT file_id:", currentFileId);
  const vsA = await attachToVectorStore(currentFileId);
  console.log("Attached CURRENT vs_file_id:", vsA?.id || "(no id)");

  console.log("Uploading ARCHIVE INDEX...");
  const archiveFileId = await uploadFileToOpenAI(archivePath);
  console.log("Uploaded ARCHIVE file_id:", archiveFileId);
  const vsB = await attachToVectorStore(archiveFileId);
  console.log("Attached ARCHIVE vs_file_id:", vsB?.id || "(no id)");

  if (CLEANUP_OLD) await cleanupCurrentBuilds();

  console.log("DONE ✅");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Build failed:", e);
    process.exit(1);
  });
}