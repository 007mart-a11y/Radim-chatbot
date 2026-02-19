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
  const t = text ?? "";
  const m1 = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (m1) return new Date(Number(m1[3]), Number(m1[2]) - 1, Number(m1[1]));
  const m2 = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T00:00:00`);
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

function isDocUrl(fullUrl) {
  const u = fullUrl.toLowerCase();
  return (
    /\.(pdf|docx|doc|rtf)$/i.test(u) ||
    u.includes("download.php") ||
    u.includes("file.php")
  );
}

/* ------------------------------------------------------------------ */
/* ---------------- SAFE DETACH (chrání CORE + PEOPLE) -------------- */
/* ------------------------------------------------------------------ */

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

async function listAllVectorStoreFiles() {
  const out = [];
  let after = null;

  while (true) {
    const url =
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=100` +
      (after ? `&after=${encodeURIComponent(after)}` : "");

    const { ok, status, json } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER },
    });

    if (!ok) {
      throw new Error(`List vector store files failed (${status}): ${JSON.stringify(json)}`);
    }

    const data = Array.isArray(json?.data) ? json.data : [];
    out.push(...data);

    // pagination: v2 vrací has_more + last_id (typicky)
    if (!json?.has_more) break;
    const lastId = data.length ? data[data.length - 1].id : null;
    if (!lastId) break;
    after = lastId;
  }

  return out;
}

async function getFilenameFromItem(item) {
  // item.id = vector_store_file_id
  // item.file_id / item.file.id = file_id
  const fileId = item?.file_id || item?.file?.id || "";
  const directName = item?.file?.filename || item?.filename || "";

  if (directName) return { filename: directName, fileId };

  if (!fileId) return { filename: "", fileId: "" };

  const { ok, status, json } = await fetchJson(`https://api.openai.com/v1/files/${fileId}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });

  if (!ok) {
    // i kdyby to selhalo, aspoň vrať prázdno – detach radši neprovádět bez názvu
    console.log(`⚠️ Cannot resolve filename for file_id=${fileId} (${status})`);
    return { filename: "", fileId };
  }

  return { filename: json?.filename || "", fileId };
}

function isProtectedFile(filename) {
  // chráněné vrstvy (nechat navždy)
  return (
    filename.startsWith("00_CORE_") ||
    filename.startsWith("00_PEOPLE_") ||
    filename === "00_CORE_obec_radim.txt" ||
    filename === "00_PEOPLE_obec_radim.txt"
  );
}

function isManagedFile(filename) {
  // jediné soubory, které crawler přepisuje
  return (
    filename === FILE_WEB_CURRENT ||
    filename === FILE_INDEX_ALL ||
    filename === FILE_DOCS_CURRENT
  );
}

async function detachManagedFromVectorStore() {
  console.log("🧹 Detachuji jen spravované soubory (01/02/03) – CORE+PEOPLE zůstává...");

  const items = await listAllVectorStoreFiles();

  for (const item of items) {
    const { filename } = await getFilenameFromItem(item);
    if (!filename) continue;

    if (isProtectedFile(filename)) continue;
    if (!isManagedFile(filename)) continue;

    const delUrl = `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${item.id}`;
    const { ok, status, json } = await fetchJson(delUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER },
    });

    if (!ok) {
      console.log(`⚠️ Detach failed for ${filename} (${status}): ${JSON.stringify(json)}`);
    } else {
      console.log(`  🗑️ detached: ${filename}`);
    }
  }
}

/* ------------------------------------------------------------------ */

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

  const file = await up.json().catch(() => ({}));
  if (!file?.id) throw new Error(`Upload failed for ${filename}: ${JSON.stringify(file)}`);

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
  if (!attach.ok) throw new Error(`Attach failed for ${filename}: ${JSON.stringify(attached)}`);

  console.log(`✅ Uploaded+attached: ${filename}`);
}

/* ------------------------------------------------------------------ */
/* ------------------------------ CRAWL ------------------------------ */
/* ------------------------------------------------------------------ */

async function crawl() {
  const queue = [normalizeUrl(SITE_BASE_URL + "/")];
  const visited = new Set();
  const docLinks = new Map();

  let webCurrent = `WEB OBCE RADIM – AKTUÁLNÍ\nGENEROVÁNO: ${now.toISOString()}\nCUTOFF: ${cutoff.toISOString()}\nINCLUDE_YEARS: ${INCLUDE_YEARS.join(",") || "AUTO"}\n\n`;

  while (queue.length && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const res = await fetch(url);
      if (!res.headers.get("content-type")?.includes("text/html")) continue;

      const html = await res.text();
      const dom = new JSDOM(html);
      const doc = dom.window.document;

      doc.querySelectorAll("script, style, nav, footer, header").forEach(el => el.remove());

      const main = doc.querySelector("#content, article, .content") || doc.body;
      const mainText = clean(main.textContent);

      const dt = extractDateFromText(doc.body.textContent || "");
      const yearHints = extractYearHints(doc.body.textContent || "");

      if ((isRecentByDate(dt) || isRecentByHints(yearHints)) && mainText.length > 120) {
        webCurrent += `\n=== PAGE\nURL: ${url}\nDATE: ${dt?.toISOString().slice(0,10) || ""}\nYEARS: ${yearHints.join(",")}\nCONTENT:\n${mainText}\n`;
      }

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
        const meta = clean(a.closest("tr, li, .item")?.textContent || "");

        if (isDocUrl(fullUrl)) {
          const dt2 = extractDateFromText(meta) || dt;
          const yearHints2 = extractYearHints(meta);

          if (!docLinks.has(fullUrl)) {
            docLinks.set(fullUrl, {
              title: linkText || "(bez názvu)",
              meta,
              source: url,
              date: dt2,
              yearHints: yearHints2,
            });
          }
        } else if (!visited.has(fullUrl)) {
          queue.push(fullUrl);
        }
      });
    } catch {
      // ignore
    }
  }

  let indexAll = `INDEX DOKUMENTŮ (VŠE)\nGENEROVÁNO: ${now.toISOString()}\n\n`;
  let docsCurrent = `FULLTEXT AKTUÁLNÍCH DOKUMENTŮ\nGENEROVÁNO: ${now.toISOString()}\nCUTOFF: ${cutoff.toISOString()}\nINCLUDE_YEARS: ${INCLUDE_YEARS.join(",") || "AUTO"}\n\n`;

  // seřaď dokumenty podle data (nejnovější nahoře)
  const docsSorted = [...docLinks.entries()].sort((a, b) => {
    const da = a[1].date?.getTime?.() ?? 0;
    const db = b[1].date?.getTime?.() ?? 0;
    return db - da;
  });

  let fullCount = 0;

  for (const [u, m] of docsSorted) {
    const recent = isRecentByDate(m.date) || isRecentByHints(m.yearHints);
    const d = m.date?.toISOString().slice(0,10) || "";

    indexAll += `=== DOC\nTITLE: ${m.title}\nDATE: ${d}\nRECENT: ${recent ? "yes" : "no"}\nURL: ${u}\nFOUND_ON: ${m.source}\nMETA: ${m.meta}\n\n`;

    if (!recent) continue;
    if (fullCount >= MAX_DOCS_FULLTEXT) break;

    try {
      const res = await fetch(u);
      const buf = Buffer.from(await res.arrayBuffer());
      let txt = "";

      const lower = u.toLowerCase();
      if (lower.includes(".pdf") || res.headers.get("content-type")?.toLowerCase().includes("pdf")) {
        txt = (await pdfParse(buf)).text;
      } else if (lower.includes(".docx") || res.headers.get("content-type")?.toLowerCase().includes("officedocument")) {
        txt = (await mammoth.extractRawText({ buffer: buf })).value;
      }

      txt = clean(txt);
      if (txt.length < 100) continue;

      docsCurrent += `=== DOC\nTITLE: ${m.title}\nDATE: ${d}\nURL: ${u}\nFOUND_ON: ${m.source}\nMETA: ${m.meta}\nCONTENT:\n${txt}\n\n`;

      fullCount++;
      console.log(`  ✅ fulltext: ${m.title}`);
    } catch {
      // ignore
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, FILE_WEB_CURRENT), webCurrent, "utf8");
  await fs.writeFile(path.join(OUT_DIR, FILE_INDEX_ALL), indexAll, "utf8");
  await fs.writeFile(path.join(OUT_DIR, FILE_DOCS_CURRENT), docsCurrent, "utf8");

  console.log("📝 3 soubory vygenerovány.");
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

  await crawl();

  await detachManagedFromVectorStore();

  await uploadToVectorStore(FILE_WEB_CURRENT);
  await uploadToVectorStore(FILE_INDEX_ALL);
  await uploadToVectorStore(FILE_DOCS_CURRENT);

  console.log("✨ HOTOVO – 01/02/03 aktualizované, CORE+PEOPLE chráněné.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});