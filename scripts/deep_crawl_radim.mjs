// scripts/deep_crawl_radim.mjs
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";

const BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const MAX_PAGES = Number(process.env.DEEP_MAX_PAGES || 350);

const OUT_FILE =
  process.env.OUT_FILE || "knowledge/01_STATIC_SITE_obec_radim.txt";

// Rozumné minimum textu – ať neukládáme prázdné layouty
const MIN_TEXT_LEN = Number(process.env.MIN_TEXT_LEN || 200);

// Timeouty + User-Agent (některé obecní weby to řeší)
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (compatible; RadimCrawler/1.0; +https://www.obec-radim.cz)";

const visited = new Set();
const queue = [BASE_URL];

let output = [];
let savedPages = 0;
let processed = 0;
let skipped = 0;

console.log("🚀 CRAWLER STARTED", { BASE_URL, MAX_PAGES });

function normalizeUrl(href) {
  try {
    const u = new URL(href, BASE_URL);
    u.hash = ""; // zahodit #kotvy
    return u.href;
  } catch {
    return null;
  }
}

function shouldSkipUrl(url) {
  if (!url) return true;

  // Jen v rámci domény
  if (!url.startsWith(BASE_URL)) return true;

  // Admin / fotogalerie / systémové věci
  if (url.includes("/admin")) return true;
  if (url.includes("/fotogalerie")) return true;

  // systémové php endpointy
  if (url.includes("evt_image.php")) return true;
  if (url.includes("evt_file.php")) return true;
  if (url.includes("core/tpl/update.php")) return true;

  // soubory dle přípony (když se objeví v href)
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|doc|docx|xls|xlsx|zip|rar)$/i.test(url))
    return true;

  return false;
}

async function fetchHTML(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml")) {
      throw new Error(`Non-HTML content-type: ${ct || "unknown"}`);
    }

    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractText(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // pryč balast
  doc
    .querySelectorAll(
      "script, style, nav, footer, header, noscript, svg, form"
    )
    .forEach((e) => e.remove());

  // občas jsou opakované bloky v aside
  doc.querySelectorAll("aside").forEach((e) => e.remove());

  const text = (doc.body?.textContent || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();

  return text;
}

function extractLinks(html) {
  const dom = new JSDOM(html);
  const links = [...dom.window.document.querySelectorAll("a")]
    .map((a) => (a.getAttribute("href") || "").trim())
    .filter((href) => href && href !== "#" && !href.startsWith("javascript:"))
    // tel/mailto a různé pseudo odkazy
    .filter((href) => !href.startsWith("mailto:") && !href.startsWith("tel:"))
    .filter((href) => !href.startsWith("+420")) // telefon jako "odkaz"
    .map((href) => normalizeUrl(href))
    .filter((u) => u && !shouldSkipUrl(u));

  return links;
}

function addToQueue(urls) {
  for (const u of urls) {
    if (!u) continue;
    if (visited.has(u)) continue;
    queue.push(u);
  }
}

while (queue.length && processed < MAX_PAGES) {
  const url = queue.shift();
  if (!url) continue;
  if (visited.has(url)) continue;

  visited.add(url);

  const idx = processed + 1;
  console.log(`🔍 [${idx}/${MAX_PAGES}] Crawling: ${url}`);

  try {
    const html = await fetchHTML(url);
    const text = extractText(html);

    if (text.length >= MIN_TEXT_LEN) {
      output.push(`\n=== PAGE: ${url} ===\n${text}\n`);
      savedPages++;
    }

    const links = extractLinks(html);
    addToQueue(links);

    processed++;
  } catch (err) {
    skipped++;
    console.warn(`⚠️ Skip: ${url} - ${err.message}`);
    processed++; // počítáme i pokusy, ať to drží limit
  }
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, output.join("\n"), "utf8");

console.log("✅ STATIC SITE RADIM DONE");
console.log("Saved pages:", savedPages);
console.log("Processed:", processed, "Skipped:", skipped);
console.log("Queue left:", queue.length);
console.log("📁 Output:", OUT_FILE);