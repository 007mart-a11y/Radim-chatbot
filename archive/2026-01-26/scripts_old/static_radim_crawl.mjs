// scripts/static_radim_crawl.mjs
// Node 18+ (nativní fetch)
// STATIC = stabilní stránky (bez aktualit, úřední desky, kalendáře, fotogalerie, zpravodaje)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const OUT_DIR = process.env.OUT_DIR || "public/knowledge";

const MAX_PAGES = Number(process.env.STATIC_MAX_PAGES || 500);         // snížené a realistické
const MAX_SEEN = Number(process.env.STATIC_MAX_SEEN || 6000);          // brzda proti nekonečné frontě
const CONCURRENCY = Number(process.env.STATIC_CONCURRENCY || 6);
const TIMEOUT_MS = Number(process.env.STATIC_TIMEOUT_MS || 15000);     // rychlejší fail
const RETRIES = Number(process.env.STATIC_RETRIES || 1);
const MAX_HTML_BYTES = Number(process.env.STATIC_MAX_HTML_BYTES || 1_500_000); // 1.5 MB

// Co do STATIC NESMÍ
const BLOCK_PATHS = [
  "/aktualne/aktuality",
  "/aktualne/kalendar-akci",
  "/urad/uredni-deska",
  "/fotogalerie",
  "/foto",
  "/galerie",
  "/zpravodaj",
  "/hlaseni-rozhlasu",
  "/admin",
  "/wp-admin",
  "/download.php",
];

const BLOCK_QUERY_HINTS = ["?page=", "?pg=", "modules", "download.php", "print=1"];

function absUrl(href) {
  if (!href) return null;
  if (/^mailto:/i.test(href) || /^tel:/i.test(href)) return null;
  if (/^javascript:/i.test(href)) return null;
  try {
    const u = new URL(href, SITE_BASE_URL);
    return u.toString();
  } catch {
    return null;
  }
}

function sameOrigin(url) {
  try {
    const u = new URL(url);
    const b = new URL(SITE_BASE_URL);
    return u.origin === b.origin;
  } catch {
    return false;
  }
}

function shouldBlock(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();

    if (BLOCK_PATHS.some((p) => path.startsWith(p))) return true;
    if (BLOCK_QUERY_HINTS.some((q) => (u.search || "").includes(q))) return true;

    // pokud má URL podezřele moc query parametrů, je to typicky bordel/filtr/listing
    if (u.searchParams && [...u.searchParams.keys()].length > 6) return true;

    return false;
  } catch {
    return true;
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "fbclid"].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": "static-radim-crawler/2.0" },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) throw new Error(`Non-HTML: ${ct}`);

      // ochrana proti obřím stránkám
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_HTML_BYTES) {
        throw new Error(`HTML_TOO_LARGE ${ab.byteLength} bytes`);
      }
      return Buffer.from(ab).toString("utf8");
    } catch (e) {
      if (attempt >= RETRIES) throw e;
      // krátká pauza před retry
      await new Promise((r) => setTimeout(r, 350));
    } finally {
      clearTimeout(t);
    }
  }
}

// Hrubé čištění HTML -> text
function stripHtmlToText(html) {
  let s = String(html || "");

  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // prefer main/content
  const mainMatch =
    s.match(/<main[\s\S]*?<\/main>/i) ||
    s.match(/<div[^>]+class="[^"]*(content|main|page|article)[^"]*"[\s\S]*?<\/div>/i) ||
    null;
  if (mainMatch?.[0]) s = mainMatch[0];

  s = s.replace(/<\/(p|div|li|br|h1|h2|h3|h4|tr|section|article)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");

  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\s+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  // cookie lišty
  const junk = ["Používáme cookies", "Souhlasím", "Nesouhlasím", "Nastavení cookies", "Tento web používá cookies"];
  for (const j of junk) s = s.replaceAll(j, "");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function extractTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m?.[1] || "").replace(/\s+/g, " ").trim() || "Bez názvu";
}

function classifySection(url) {
  const p = new URL(url).pathname.toLowerCase();
  if (p.startsWith("/urad") || p.includes("povinne-informace") || p.includes("e-podatelna")) return "URAD";
  if (p.startsWith("/obec") || p.includes("historie") || p.includes("o-obci")) return "OBEC";
  if (p.includes("spolk") || p.includes("sdh") || p.includes("sokol") || p.includes("organizace")) return "SPOLKY";
  if (p.includes("odpad") || p.includes("bio") || p.includes("skladk") || p.includes("sber") || p.includes("doprava"))
    return "ODPADY";
  return "OSTATNI";
}

function extractLinks(html) {
  const links = [];
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = absUrl(m[1]);
    if (!u) continue;
    if (!sameOrigin(u)) continue;
    const cu = cleanUrl(u);
    if (shouldBlock(cu)) continue;
    links.push(cu);
  }
  return links;
}

function dedupeParagraphs(text) {
  const parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase().replace(/\s+/g, " ").slice(0, 420);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join("\n\n");
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function writeOut(filename, content) {
  const path = `${OUT_DIR}/${filename}`;
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
  console.log("Wrote:", path, "bytes:", Buffer.byteLength(content, "utf8"));
}

async function crawl() {
  const start = cleanUrl(SITE_BASE_URL);
  const queue = [start];
  const seen = new Set([start]);
  const pages = [];

  let processed = 0;
  let kept = 0;
  let lastLog = Date.now();

  async function worker(id) {
    while (pages.length < MAX_PAGES) {
      const url = queue.shift();
      if (!url) {
        // když je fronta prázdná, krátce čekej (kvůli ostatním workerům)
        await new Promise((r) => setTimeout(r, 80));
        if (!queue.length) break;
        continue;
      }

      processed++;

      // progress log (každých ~1s)
      if (Date.now() - lastLog > 1000) {
        lastLog = Date.now();
        console.log(
          `[W${id}] processed=${processed} kept=${kept} queue=${queue.length} seen=${seen.size}`
        );
      }

      let html;
      try {
        html = await fetchHtml(url);
      } catch {
        continue;
      }

      const title = extractTitle(html);
      let text = stripHtmlToText(html);
      if (!text || text.length < 120) continue;

      text = dedupeParagraphs(text);
      const section = classifySection(url);

      pages.push({ url, title, section, text });
      kept++;

      // stop brzda proti nekonečným linkům
      if (seen.size > MAX_SEEN) continue;

      const links = extractLinks(html);
      for (const l of links) {
        if (seen.has(l)) continue;
        if (seen.size >= MAX_SEEN) break;
        seen.add(l);
        queue.push(l);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log("Crawl finished:", { processed, kept, seen: seen.size, leftInQueue: queue.length });
  return pages;
}

function buildFile(pages, sectionName, headerTitle) {
  const now = new Date().toISOString();
  const filtered = pages.filter((p) => p.section === sectionName);

  const blocks = filtered.map((p) => {
    return [
      "=== PAGE",
      `URL: ${p.url}`,
      `TITLE: ${p.title}`,
      `SECTION: ${p.section}`,
      "CONTENT:",
      p.text,
      "",
    ].join("\n");
  });

  return [
    `${headerTitle}`,
    `Vygenerováno: ${now}`,
    `Zdroj: ${SITE_BASE_URL}`,
    "",
    "Tento soubor obsahuje stabilní informace z webu obce Radim.",
    "Proměnlivé sekce (aktuality, úřední deska, kalendář akcí, fotogalerie, zpravodaj) jsou záměrně vynechány.",
    "",
    "==============================",
    "",
    ...blocks,
  ].join("\n");
}

async function main() {
  console.log("STATIC CRAWL start:", SITE_BASE_URL);
  console.log("Settings:", { MAX_PAGES, MAX_SEEN, CONCURRENCY, TIMEOUT_MS, RETRIES });

  const pages = await crawl();
  console.log("Pages kept total:", pages.length);

  await writeOut("01_STATIC_URAD_obec_radim.txt", buildFile(pages, "URAD", "01_STATIC_URAD_obec_radim.txt"));
  await writeOut("01_STATIC_OBEC_obec_radim.txt", buildFile(pages, "OBEC", "01_STATIC_OBEC_obec_radim.txt"));
  await writeOut("01_STATIC_SPOLKY_obec_radim.txt", buildFile(pages, "SPOLKY", "01_STATIC_SPOLKY_obec_radim.txt"));
  await writeOut(
    "01_STATIC_DOPRAVA_ODPADY_obec_radim.txt",
    buildFile(pages, "ODPADY", "01_STATIC_DOPRAVA_ODPADY_obec_radim.txt")
  );
  await writeOut("01_STATIC_OSTATNI_obec_radim.txt", buildFile(pages, "OSTATNI", "01_STATIC_OSTATNI_obec_radim.txt"));

  console.log("STATIC CRAWL DONE");
}

main().catch((e) => {
  console.error("STATIC CRAWL FAILED:", e);
  process.exit(1);
});