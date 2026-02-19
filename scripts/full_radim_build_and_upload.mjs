// scripts/radim_crawl_build_and_upload.mjs
import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const OUT_DIR = process.env.OUT_DIR ?? "knowledge";

const FILE_WEB_CURRENT   = "01_WEB_TEXT_CURRENT.txt";
const FILE_INDEX_ALL     = "02_DOWNLOADS_INDEX_ALL.txt";
const FILE_DOCS_CURRENT  = "03_DOCS_CONTENT_CURRENT.txt";

const MAX_PAGES = Number(process.env.MAX_PAGES ?? 250);
const MAX_DOCS_FULLTEXT = Number(process.env.MAX_DOCS_FULLTEXT ?? 80);
const RECENT_MONTHS = Number(process.env.RECENT_MONTHS ?? 18);

// Pokud chceš natvrdo roky: "2025,2026" (prázdné = AUTO)
const INCLUDE_YEARS = (process.env.INCLUDE_YEARS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(n => Number.isFinite(n));

const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

const now = new Date();
const cutoff = new Date(now);
cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS);

const clean = (t) =>
  (t ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    if (!url.pathname.includes(".") && !url.pathname.endsWith("/")) {
      url.pathname = url.pathname + "/";
    }
    return url.toString();
  } catch {
    return u;
  }
}

function extractDateFromText(text) {
  const t = (text ?? "").toString();

  // 4. 12. 2025 / 04.12.2025
  const m1 = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (m1) {
    const d = Number(m1[1]), mo = Number(m1[2]) - 1, y = Number(m1[3]);
    const dt = new Date(y, mo, d);
    if (!isNaN(dt.getTime())) return dt;
  }

  // ISO 2025-12-04
  const m2 = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    const dt = new Date(`${m2[1]}-${m2[2]}-${m2[3]}T00:00:00`);
    if (!isNaN(dt.getTime())) return dt;
  }

  return null;
}

function extractYearHints(text) {
  const years = new Set();
  const m = (text ?? "").match(/\b(20\d{2})\b/g);
  if (m) m.forEach(y => years.add(Number(y)));
  return [...years].filter(n => Number.isFinite(n));
}

function isRecentByDate(dt) {
  if (!dt) return false;
  if (INCLUDE_YEARS.length) return INCLUDE_YEARS.includes(dt.getFullYear());
  return dt >= cutoff;
}

function isRecentByHints(hintsYears) {
  if (!hintsYears?.length) return false;
  if (INCLUDE_YEARS.length) return hintsYears.some(y => INCLUDE_YEARS.includes(y));

  const y = now.getFullYear();
  return hintsYears.some(yy => yy === y || yy === y - 1);
}

// Heuristika “archiv / historie”
function looksHistorical(url, text) {
  const u = String(url || "").toLowerCase();
  const t = String(text || "").toLowerCase();

  const badUrl = [
    "/archiv",
    "archiv",
    "kronika",
    "histor",
    "zpravodaj",
    "fotogalerie",
    "galerie",
    "minulé",
    "rok-20", // často archivní ročníky
  ].some(p => u.includes(p));

  const badText = [
    "archiv",
    "starší",
    "minulé ročníky",
    "proběhlo",
    "proběhla",
    "konalo se",
    "v roce 201",
    "v roce 2020",
    "v roce 2021",
    "v roce 2022",
    "v roce 2023",
  ].some(p => t.includes(p));

  return badUrl || badText;
}

function undatedButOkAsCurrent(url, text) {
  // pokud je stránka bez data a bez roků, chceme ji brát jako CURRENT,
  // ale ne pokud zjevně vypadá historicky/archivně
  if (looksHistorical(url, text)) return false;
  return true;
}

function isDocUrl(fullUrl) {
  const u = String(fullUrl || "").toLowerCase();
  return (
    /\.(pdf|docx|doc|rtf)$/i.test(u) ||
    u.includes("download.php") ||
    u.includes("e_download.php") ||
    u.includes("evt_file.php") ||
    u.includes("file.php")
  );
}

// ------------------------------------------------------------------
// SAFE DETACH (nechává CORE/PEOPLE a cokoliv dalšího, maže jen 01/02/03)
// ------------------------------------------------------------------

async function listVectorStoreFiles(limit = 100) {
  const url = `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER },
  });
  const json = await res.json().catch(() => ({}));
  return Array.isArray(json.data) ? json.data : [];
}

async function getFilenameFromItem(item) {
  const fileId = item?.file_id || item?.file?.id;
  const directName = item?.file?.filename || item?.filename;

  if (directName) return { filename: directName, fileId };

  if (!fileId) return { filename: "", fileId };

  const r = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  const j = await r.json().catch(() => ({}));
  return { filename: j?.filename || "", fileId };
}

function shouldDetach(filename) {
  return (
    filename === FILE_WEB_CURRENT ||
    filename === FILE_INDEX_ALL ||
    filename === FILE_DOCS_CURRENT
  );
}

async function detachManagedFromVectorStore() {
  console.log("🧹 Detachuji jen spravované soubory (01/02/03)...");
  const items = await listVectorStoreFiles(100);

  for (const item of items) {
    const { filename } = await getFilenameFromItem(item);
    if (!filename) continue;
    if (!shouldDetach(filename)) continue;

    await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER },
    });

    console.log(`  🗑️ detached: ${filename}`);
  }
}

async function uploadToVectorStore(filename) {
  const filePath = path.join(OUT_DIR, filename);
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([await fs.readFile(filePath)]), filename);

  const up = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const file = await up.json();
  if (!file?.id) throw new Error(`Upload failed: ${filename} => ${JSON.stringify(file)}`);

  const attach = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...OPENAI_BETA_HEADER,
    },
    body: JSON.stringify({ file_id: file.id }),
  });

  const attached = await attach.json().catch(() => ({}));
  if (!attached?.id) throw new Error(`Attach failed: ${filename} => ${JSON.stringify(attached)}`);

  console.log(`✅ Uploaded+attached: ${filename}`);
}

// ------------------------------------------------------------------
// CRAWL
// ------------------------------------------------------------------

const FORBIDDEN_URL_PARTS = [
  "rajce.idnes",
  "zmena-vzhledu",
  "month=",
  "year=",
  "date=",
  "login",
  "/admin",
  "mapa-webu",
];

async function crawl() {
  const queue = [normalizeUrl(SITE_BASE_URL + "/")];
  const visited = new Set();
  const docLinks = new Map();

  let webCurrent =
    `WEB OBCE RADIM – AKTUÁLNÍ + NEDATOVANÉ STRÁNKY\n` +
    `GENEROVÁNO: ${now.toISOString()}\n` +
    `RECENT_MONTHS=${RECENT_MONTHS} INCLUDE_YEARS=${INCLUDE_YEARS.join(",") || "AUTO"}\n` +
    `CUTOFF=${cutoff.toISOString()}\n`;

  console.log("🚀 Crawl webu: aktuální + nedatované stránky, index dokumentů...");

  while (queue.length && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url) break;

    const uLower = url.toLowerCase();
    if (visited.has(url)) continue;
    if (FORBIDDEN_URL_PARTS.some(p => uLower.includes(p))) continue;

    visited.add(url);

    try {
      const res = await fetch(url);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) continue;

      const html = await res.text();
      if (html.length > 350_000) continue;

      const dom = new JSDOM(html);
      const doc = dom.window.document;

      doc.querySelectorAll("script, style, nav, footer, header, #header, #footer, .noprint, .sidebar")
        .forEach(el => el.remove());

      const main = doc.querySelector("#content, #main, article, .content") || doc.body;
      const mainText = clean(main.textContent);

      const wholeText = doc.body.textContent || "";
      const dt = extractDateFromText(wholeText);
      const yearHints = extractYearHints(wholeText);

      const hasAnyDateOrYear = Boolean(dt) || (yearHints && yearHints.length > 0);

      // NOVÁ LOGIKA:
      // - recent podle data/hints
      // - NEBO nedatované (bez dt i bez years) bereme jako current, pokud to nevypadá historicky
      const pageIsCurrent =
        isRecentByDate(dt) ||
        isRecentByHints(yearHints) ||
        (!hasAnyDateOrYear && undatedButOkAsCurrent(url, mainText));

      if (pageIsCurrent && mainText.length > 120) {
        webCurrent +=
          `\n\n=== PAGE\n` +
          `URL: ${url}\n` +
          `DATE: ${dt ? dt.toISOString().slice(0,10) : ""}\n` +
          `YEARS: ${yearHints.join(",")}\n` +
          `CONTENT:\n${mainText}\n`;
        console.log(`  📄 current: ${url.replace(SITE_BASE_URL, "") || "/"}`);
      }

      // odkazy
      doc.querySelectorAll("a[href]").forEach(a => {
        const href = a.getAttribute("href");
        if (!href) return;

        let fullUrl;
        try {
          fullUrl = normalizeUrl(new URL(href, url).toString());
        } catch {
          return;
        }

        if (!fullUrl.startsWith(SITE_BASE_URL)) return;

        const linkText = clean(a.textContent);
        const around = clean(a.closest("tr, li, .item, .box, .row")?.textContent || "");
        const meta = clean(around.replace(linkText, ""));

        if (isDocUrl(fullUrl)) {
          const dt2 = extractDateFromText(meta) || extractDateFromText(around) || dt;
          const yearHints2 = extractYearHints(meta + " " + around);
          if (!docLinks.has(fullUrl)) {
            docLinks.set(fullUrl, {
              title: linkText || "(bez názvu)",
              meta,
              source: url,
              date: dt2,
              yearHints: yearHints2,
            });
          }
        } else {
          if (!visited.has(fullUrl)) queue.push(fullUrl);
        }
      });
    } catch (e) {
      console.log(`  ⚠️ fetch fail: ${url}`);
    }
  }

  // INDEX všech dokumentů
  let indexAll =
    `INDEX DOKUMENTŮ (VŠE)\n` +
    `GENEROVÁNO: ${now.toISOString()}\n` +
    `RECENT_MONTHS=${RECENT_MONTHS} INCLUDE_YEARS=${INCLUDE_YEARS.join(",") || "AUTO"}\n\n`;

  const docsSorted = [...docLinks.entries()].sort((a, b) => {
    const da = a[1].date?.getTime?.() ?? 0;
    const db = b[1].date?.getTime?.() ?? 0;
    return db - da;
  });

  for (const [u, m] of docsSorted) {
    const d = m.date ? m.date.toISOString().slice(0,10) : "";
    const years = (m.yearHints || []).join(",");
    const recent = isRecentByDate(m.date) || isRecentByHints(m.yearHints);

    indexAll +=
      `=== DOC\nTITLE: ${m.title}\nDATE: ${d}\nRECENT: ${recent ? "yes" : "no"}\nYEARS: ${years}\nMETA: ${m.meta}\nURL: ${u}\nFOUND_ON: ${m.source}\n\n`;
  }

  // FULLTEXT jen pro aktuální dokumenty
  console.log(`📎 Dokumentů celkem: ${docLinks.size}. FULLTEXT jen pro aktuální (limit ${MAX_DOCS_FULLTEXT})...`);

  let docsCurrent =
    `FULLTEXT DOKUMENTŮ – POUZE AKTUÁLNÍ\n` +
    `GENEROVÁNO: ${now.toISOString()}\n` +
    `CUTOFF: ${cutoff.toISOString()}\n` +
    `RECENT_MONTHS=${RECENT_MONTHS} INCLUDE_YEARS=${INCLUDE_YEARS.join(",") || "AUTO"}\n\n`;

  let countFull = 0;

  for (const [u, m] of docsSorted) {
    if (countFull >= MAX_DOCS_FULLTEXT) break;

    const recent = isRecentByDate(m.date) || isRecentByHints(m.yearHints);
    if (!recent) continue;

    try {
      const res = await fetch(u);
      const buf = Buffer.from(await res.arrayBuffer());
      const cType = (res.headers.get("content-type") || "").toLowerCase();

      let txt = "";

      if (cType.includes("pdf") || u.toLowerCase().includes(".pdf")) {
        txt = (await pdfParse(buf)).text;
      } else if (cType.includes("officedocument") || u.toLowerCase().includes(".docx")) {
        txt = (await mammoth.extractRawText({ buffer: buf })).value;
      } else {
        // fallback podle URL
        if (u.toLowerCase().includes(".pdf")) txt = (await pdfParse(buf)).text;
        if (u.toLowerCase().includes(".docx")) txt = (await mammoth.extractRawText({ buffer: buf })).value;
      }

      txt = clean(txt);
      if (txt.length < 50) continue;

      const d = m.date ? m.date.toISOString().slice(0,10) : "";
      docsCurrent +=
        `=== DOC\nTITLE: ${m.title}\nDATE: ${d}\nURL: ${u}\nFOUND_ON: ${m.source}\nMETA: ${m.meta}\nCONTENT:\n${txt}\n\n`;

      countFull++;
      console.log(`  ✅ fulltext: ${m.title.slice(0, 70)}`);
    } catch (e) {
      console.log(`  ❌ fail doc: ${m.title} (${e?.message || e})`);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, FILE_WEB_CURRENT), webCurrent, "utf8");
  await fs.writeFile(path.join(OUT_DIR, FILE_INDEX_ALL), indexAll, "utf8");
  await fs.writeFile(path.join(OUT_DIR, FILE_DOCS_CURRENT), docsCurrent, "utf8");

  console.log("📝 Hotovo: vygenerované 3 soubory do knowledge/.");
}

async function main() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

  await crawl();

  await detachManagedFromVectorStore();
  await uploadToVectorStore(FILE_WEB_CURRENT);
  await uploadToVectorStore(FILE_INDEX_ALL);
  await uploadToVectorStore(FILE_DOCS_CURRENT);

  console.log("✨ MISE SPLNĚNA: aktuální + nedatované stránky jsou ve 01_WEB_TEXT_CURRENT.txt, PEOPLE/CORE zůstávají.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});