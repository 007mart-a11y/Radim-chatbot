import fs from "fs";
import path from "path";
import crypto from "crypto";
import cheerio from "cheerio";
import pdfParse from "pdf-parse";

const ROOT = "https://www.obec-radim.cz";
const START_URLS = [
  `${ROOT}/`,
  `${ROOT}/urad/`,
  `${ROOT}/urad/uzemni-a-rozvojovy-plan/`
];

const OUT_PATH = path.join(process.cwd(), "kb", "kb.json");
const MAX_PAGES = 80;
const MAX_PDFS = 40;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cleanText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function chunkText(text) {
  const t = cleanText(text);
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + CHUNK_SIZE);
    const piece = t.slice(i, end);
    chunks.push(piece);
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
    if (end === t.length) break;
  }
  return chunks;
}

function isSameHost(url) {
  try {
    const u = new URL(url);
    return u.host === new URL(ROOT).host;
  } catch {
    return false;
  }
}

function normalizeUrl(u) {
  try {
    const url = new URL(u, ROOT);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "RadimChatbotKB/1.0 (+github actions)" }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "RadimChatbotKB/1.0 (+github actions)" }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return null;
  return await res.text();
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const u = normalizeUrl(new URL(href, baseUrl).toString());
    if (!u) return;
    if (!isSameHost(u)) return;
    links.add(u);
  });

  return [...links];
}

function extractPageText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();

  const title = cleanText($("title").text());
  const h1 = cleanText($("h1").first().text());
  const mainText = cleanText($("main").text() || $("body").text());

  const combined = cleanText(
    `${title ? `Název: ${title}\n` : ""}${h1 ? `Nadpis: ${h1}\n` : ""}\n${mainText}`
  );

  return combined.slice(0, 40000);
}

function findPdfLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const pdfs = new Set();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const u = normalizeUrl(new URL(href, baseUrl).toString());
    if (!u) return;
    if (!isSameHost(u)) return;
    if (u.toLowerCase().includes("download.php") || u.toLowerCase().endsWith(".pdf")) {
      pdfs.add(u);
    }
  });
  return [...pdfs];
}

async function crawl() {
  const queue = [...START_URLS];
  const seen = new Set();
  const pages = [];
  const pdfLinks = new Set();

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let html = null;
    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }
    if (!html) continue;

    const text = extractPageText(html);
    if (text && text.length > 200) pages.push({ url, text });

    for (const p of findPdfLinks(html, url)) pdfLinks.add(p);
    for (const link of extractLinks(html, url)) {
      if (!seen.has(link)) queue.push(link);
    }
  }

  return { pages, pdfs: [...pdfLinks].slice(0, MAX_PDFS) };
}

async function parsePdf(url) {
  try {
    const buf = await fetchBuffer(url);
    const data = await pdfParse(buf);
    const text = cleanText(data.text || "");
    if (text.length < 200) return null;
    return { url, text: text.slice(0, 80000) };
  } catch {
    return null;
  }
}

async function buildKb() {
  const { pages, pdfs } = await crawl();
  const chunks = [];

  for (const p of pages) {
    const parts = chunkText(p.text);
    parts.forEach((part, idx) => {
      chunks.push({
        id: `web-${sha1(p.url)}-${idx + 1}`,
        source: `Web obce Radim – ${p.url.replace(ROOT, "") || "/"}`,
        url: p.url,
        text: part
      });
    });
  }

  for (const pdfUrl of pdfs) {
    const parsed = await parsePdf(pdfUrl);
    if (!parsed) continue;
    const parts = chunkText(parsed.text);
    parts.forEach((part, idx) => {
      chunks.push({
        id: `pdf-${sha1(pdfUrl)}-${idx + 1}`,
        source: "Dokument (PDF) z webu obce Radim",
        url: pdfUrl,
        text: part
      });
    });
  }

  ensureDir(path.dirname(OUT_PATH));
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify({ generated_at: new Date().toISOString(), chunks }, null, 2),
    "utf8"
  );

  console.log(`KB built: ${chunks.length} chunks`);
}

buildKb().catch((e) => {
  console.error(e);
  process.exit(1);
});
