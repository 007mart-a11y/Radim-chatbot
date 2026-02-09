// scripts/full_radim_build_and_upload.mjs
// FULL crawl + clean output + DOCUMENTS index (direct download links)
// + build LATEST file (00_LATEST_...) + upload both to OpenAI Vector Store + cleanup
//
// FIXES:
// - OpenAI-Beta header for vector store ops
// - Robust vector store listing (pagination)
// - Cleanup uses filename from embedded file OR /v1/files fallback
// - Cleanup uses vector-store created_at (not only file created_at)
// - Debug prints so you always see what it thinks is FULL/LATEST
//
// Requirements: Node 18+ (native fetch/FormData/Blob), dependency: jsdom
//   npm i jsdom
//
// Env:
//   SITE_BASE_URL=https://www.obec-radim.cz
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=...
//
//   CLEANUP_OLD=1 (default) | 0
//   KEEP_LATEST=1 (default)          // keep last N FULL files
//
//   // LATEST
//   CLEANUP_OLD_LATEST=1 (default) | 0
//   KEEP_LATEST_LATEST=6 (default)  // keep last N LATEST files
//
//   MAX_PAGES=450 (default)
//   CONCURRENCY=3 (default)
//   REQUEST_TIMEOUT_MS=25000 (default)

import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";

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
function isPdf(url) {
  return /\.pdf(\?.*)?$/i.test(url);
}
function isDownloadDoc(url) {
  return /\.(pdf|doc|docx|xls|xlsx|odt|ods|ppt|pptx|rtf|txt|csv|zip)(\?.*)?$/i.test(url);
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

function stripWeirdWhitespace(s) {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function dedupeAdjacentLines(text) {
  const lines = text.split("\n").map((l) => l.trim());
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
  return crypto.createHash("sha1").update(s).digest("hex");
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

function extractMainTextFromHtml(html, url) {
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

    if (isProbablyBinary(nu) && !isPdf(nu)) return;
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
      return {
        kind: "PAGE",
        date: date || "",
        title: (p.title || "").trim(),
        url: p.url,
        snippet,
      };
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

  const text = header + body.trim() + "\n";
  await fs.writeFile(latestPath, text, "utf-8");
  console.log("LATEST written:", latestPath);
}

// ---------- FULL CRAWLER ----------
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
      if (isProbablyBinary(url) && !isPdf(url)) continue;

      try {
        const r = await fetchWithTimeout(url, {
          redirect: "follow",
          headers: { "User-Agent": "RadimFullCrawler/2.3" },
        });

        if (!r.ok) {
          processed++;
          continue;
        }

        if (isPdf(url)) {
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

        const { title, published, cleaned } = extractMainTextFromHtml(html, url);

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
        // swallow (timeouts etc.)
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

  const finalText = header + docsBlock + pagesBlock;
  await fs.writeFile(outPath, finalText, "utf-8");

  console.log("FULL written:", outPath);
  console.log("Pages:", pages.length, "Docs:", docs.length, "Seen:", seen.size, "Queue left:", queue.length);

  return { pages, docs };
}

// ---------- OpenAI helpers ----------
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

function pickFilenameFromVsItem(it) {
  // Some responses include embedded file object
  // Examples:
  // it.file = { id, filename, ... }
  // Or only file_id -> then need /v1/files
  const embedded = it?.file?.filename || it?.file?.name;
  return embedded || "";
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
  // Prefer vector-store attachment time (it.created_at) for “keep latest in store”
  // Fallback to file meta created_at
  return it?.created_at || fileMetaCreatedAt || 0;
}

async function buildIndexForCleanup(items) {
  // returns [{ vsId, fileId, filename, created_at }]
  const out = [];
  for (const it of items) {
    const vsId = it?.id;
    const fileId = it?.file_id || it?.file?.id;
    if (!vsId || !fileId) continue;

    const filename = await resolveFilename(it);
    let metaCreatedAt = 0;
    if (!filename) {
      // last resort: try meta just for created_at
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

  console.log(`Vector store files (ALL): ${items.length}`);

  const indexed = await buildIndexForCleanup(items);

  // DEBUG (always)
  console.log("== VS FILES DEBUG ==");
  for (const x of indexed) {
    console.log("-", x.filename || "(no-filename)", "| created_at:", x.created_at, "| vsId:", x.vsId, "| fileId:", x.fileId);
  }

  const matched = indexed.filter((x) => matchFn(x.filename));

  matched.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const toDelete = matched.slice(Math.max(keepN, 0));

  console.log(`${prefixName} in store: ${matched.length}, keeping: ${Math.min(keepN, matched.length)}, deleting: ${toDelete.length}`);

  for (const d of toDelete) {
    console.log(`Deleting ${prefixName}:`, d.filename, "| vsId:", d.vsId);
    await deleteVectorStoreFile(d.vsId);
  }
}

// ---------- MAIN ----------
export async function main() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

  const outPath = path.join(OUT_DIR, OUT_FILE);
  const latestPath = path.join(OUT_DIR, LATEST_OUT_FILE);

  console.log("== RADIM FULL + LATEST ==");
  console.log("SITE:", SITE_BASE_URL);
  console.log("FULL OUT:", outPath);
  console.log("LATEST OUT:", latestPath);
  console.log("VECTOR_STORE_ID:", VECTOR_STORE_ID);

  const { pages, docs } = await buildFullKnowledgeFile(outPath);

  const stat = await fs.stat(outPath);
  if (stat.size < 50_000) throw new Error(`FULL file too small (${stat.size} bytes) – refusing upload`);

  await buildLatestFile(latestPath, pages, docs);

  const latestStat = await fs.stat(latestPath);
  if (latestStat.size < 5_000) throw new Error(`LATEST file too small (${latestStat.size} bytes) – refusing upload`);

  console.log("Uploading FULL...");
  const fileId = await uploadFileToOpenAI(outPath);
  console.log("Uploaded FULL file_id:", fileId);

  console.log("Attaching FULL...");
  const vsAttach = await attachToVectorStore(fileId);
  console.log("Attached FULL (vs_file_id):", vsAttach?.id || "(no id)");

  console.log("Uploading LATEST...");
  const latestFileId = await uploadFileToOpenAI(latestPath);
  console.log("Uploaded LATEST file_id:", latestFileId);

  console.log("Attaching LATEST...");
  const vsAttachLatest = await attachToVectorStore(latestFileId);
  console.log("Attached LATEST (vs_file_id):", vsAttachLatest?.id || "(no id)");

  // Cleanup FULL
  if (CLEANUP_OLD) {
    console.log("Cleanup old FULL files (robust)...");
    await cleanupByPrefix("FULL", KEEP_LATEST, isFullName);
  }

  // Cleanup LATEST
  if (CLEANUP_OLD_LATEST) {
    console.log("Cleanup old LATEST files (robust)...");
    await cleanupByPrefix("LATEST", KEEP_LATEST_LATEST, isLatestName);
  }

  console.log("DONE ✅");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("FULL script failed:", e);
    process.exit(1);
  });
}
