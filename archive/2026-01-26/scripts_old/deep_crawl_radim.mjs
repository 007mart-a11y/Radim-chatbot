/**
 * deep_crawl_radim.mjs
 * Node 18+ (nativní fetch), jsdom
 *
 * Výstupy:
 *  - knowledge/01_STATIC_URAD_obec_radim.txt
 *  - knowledge/01_STATIC_OBEC_obec_radim.txt
 *  - knowledge/01_STATIC_OSTATNI_obec_radim.txt
 *  - knowledge/deep_crawl_report.json
 */

import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- CONFIG ----------------
const BASE = (process.env.SITE_BASE_URL || "https://www.obec-radim.cz").trim().replace(/\/+$/, "");
const MAX_PAGES = Number(process.env.DEEP_MAX_PAGES || 250);
const CONCURRENCY = Math.max(1, Number(process.env.DEEP_CONCURRENCY || 6));
const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve(process.cwd(), "knowledge");

// proměnlivé / bordel sekce – nechceme ve STATIC
const BLOCK_PATH_PARTS = [
  "/aktualne/aktuality",
  "/aktualne/kalendar-akci",
  "/fotogalerie",
  "/obecni-zpravodaj",
  "/napsali-o-nas",
  "/strpky-z-minulosti",
  "/stirpky-z-minulosti",
  "/historicke-fotografie",
  "/historicke",
  "/uredni-deska",                 // Úřední deska = LIVE
  "/urad/uredni-deska",            // jistota
];

// vyloženě spam / nechceme vůbec
const HARD_BLOCK_PARTS = [
  "/admin",
  "/wp-admin",
  "/wp-content",
  "/wp-includes",
  "/mapa-webu",
  "/anketa",
  "download.php",
  "modules/",
  "#",
  "?",
];

// soubory co nechceme tahat jako html stránky
const BLOCK_EXT = [
  ".jpg",".jpeg",".png",".gif",".webp",".svg",
  ".mp4",".mov",".avi",".mp3",".wav",
  ".zip",".rar",".7z",
  ".doc",".docx",".xls",".xlsx",".ppt",".pptx",
];

// povolené hosty = jen obec-radim.cz (+ www)
function isAllowedHost(u) {
  const h = u.hostname.toLowerCase();
  return h === "obec-radim.cz" || h === "www.obec-radim.cz";
}

// normalizace URL
function normalizeUrl(raw) {
  try {
    const u = new URL(raw, BASE);
    // sjednotit host na www (ať nemáš duplikáty)
    if (u.hostname === "obec-radim.cz") u.hostname = "www.obec-radim.cz";
    // vyházet hash
    u.hash = "";
    // sjednotit trailing slash jen u root
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      // necháme trailing slash jen tam, kde to web používá výrazně (Radim ho používá často)
      // ale sjednotíme multiple slashes
      u.pathname = u.pathname.replace(/\/+$/, "/");
    }
    // vyhodit mailto/tel apod.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function looksBlocked(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return true; }

  if (!isAllowedHost(u)) return "outside";
// ✅ WHITELIST: mapa webu musí projít, protože je to rozcestník odkazů
  // (i když jinak /mapa-webu blokujeme kvůli spamu)
  const p = (u.pathname || "").toLowerCase();
  if (p === "/urad/kontakty/mapa-webu/" || p === "/urad/kontakty/mapa-webu") {
    return false;
  }

  
  const lower = urlStr.toLowerCase();

  // tel/mailto vyrobí web někdy jako "https://www.obec-radim.cz/+420..."
  if (/\/\+420/.test(u.pathname)) return "blocked";

  // extensions
  for (const ext of BLOCK_EXT) {
    if (lower.endsWith(ext)) return "blocked";
  }

  // hard blocks (query, download.php, modules, apod.)
  for (const part of HARD_BLOCK_PARTS) {
    if (lower.includes(part)) return "blocked";
  }

  // proměnlivé sekce do STATIC nebereme
  for (const part of BLOCK_PATH_PARTS) {
    if (lower.includes(part)) return "blocked";
  }

  return false;
}

function classifySection(u) {
  const p = u.pathname.toLowerCase();
  if (p.startsWith("/urad")) return "URAD";
  if (p.startsWith("/obec")) return "OBEC";
  return "OSTATNI";
}

// hrubé vyčištění DOM
function cleanDom(document) {
  const killSelectors = [
    "script","style","noscript",
    "header","footer","nav",
    ".breadcrumbs",".breadcrumb",
    ".share",".social",".cookie",".cookies",
    ".gallery",".fotogalerie",
    ".search",".vyhledavani",
    ".pagination",".pager",
  ];
  killSelectors.forEach(sel => document.querySelectorAll(sel).forEach(n => n.remove()));

  // odstranit všechny odkazy, co jsou jen ikonky/bez textu – necháme čistější text
  document.querySelectorAll("a").forEach(a => {
    const t = (a.textContent || "").trim();
    if (!t) return;
    // ok
  });

  return document;
}

// vytažení linků
function extractLinks(document, baseUrl) {
  const links = new Set();
  document.querySelectorAll("a[href]").forEach(a => {
    const href = (a.getAttribute("href") || "").trim();
    if (!href) return;
    // odfiltruj mailto/tel
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const norm = normalizeUrl(href);
    if (!norm) return;
    links.add(norm);
  });
  // taky z inline href v textu (občas to tam je)
  const text = document.body ? document.body.textContent || "" : "";
  const urlMatches = text.match(/https?:\/\/[^\s)]+/g) || [];
  for (const m of urlMatches) {
    const norm = normalizeUrl(m);
    if (norm) links.add(norm);
  }
  return [...links];
}

function extractText(document) {
  const body = document.body;
  if (!body) return "";
  let t = body.textContent || "";
  // normalizace whitespace
  t = t.replace(/\u00A0/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  return t.trim();
}

// speciální ořez pro /urad/ – vyhodit blok Úřední desky
function stripUredniDeskaFromUradIndex(urlObj, text) {
  const p = urlObj.pathname.replace(/\/+$/, "/").toLowerCase();
  if (p !== "/urad/") return text;
  const idx = text.toLowerCase().indexOf("úřední deska");
  if (idx === -1) return text;
  // u /urad/ chceme jen úvodní “dopisu” a zbytek (výpis úřední desky) pryč
  return text.slice(0, idx).trim();
}

// ---------------- CRAWLER ----------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RadimCrawler/1.0; +https://www.obec-radim.cz)"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text/html")) throw new Error(`Not HTML: ${ct}`);
  return await res.text();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function buildFileHeader(sectionName) {
  const now = new Date().toISOString();
  return [
    `01_STATIC_${sectionName}_obec_radim.txt`,
    `Vygenerováno: ${now}`,
    `Zdroj: ${BASE}`,
    ``,
    `Tento soubor obsahuje stabilní informace z webu obce Radim.`,
    `Proměnlivé sekce (aktuality, úřední deska, kalendář akcí, fotogalerie, zpravodaj) jsou záměrně vynechány.`,
    ``,
    `==============================`,
    ``,
  ].join("\n");
}

function pageBlock({ url, title, section, content }) {
  return [
    `=== PAGE`,
    `URL: ${url}`,
    `TITLE: ${title || ""}`,
    `SECTION: ${section}`,
    `CONTENT:`,
    content || "",
    ``,
  ].join("\n");
}

async function crawl() {
  ensureDir(OUT_DIR);

  const report = {
    generated_at: new Date().toISOString(),
    base: BASE,
    max_pages: MAX_PAGES,
    crawled_pages: 0,
    stats: { ok: 0, blocked: 0, outside: 0, skipped: 0, errors: 0 },
    blocked_examples: [],
    outside_examples: [],
    skipped: [],
    errors: []
  };

  // seed: root + úřad + obec (ať se to hned rozběhne správně)
  const seeds = [
  normalizeUrl(BASE + "/"),
  normalizeUrl(BASE + "/urad/"),
  normalizeUrl(BASE + "/urad/kontakty/mapa-webu/"),
].filter(Boolean);

  const queue = [...new Set(seeds)];
  const seen = new Set(queue);

  const pages = {
    URAD: [],
    OBEC: [],
    OSTATNI: [],
  };

  let active = 0;

  async function worker() {
    while (queue.length && report.crawled_pages < MAX_PAGES) {
      const url = queue.shift();
      if (!url) continue;

      const blockReason = looksBlocked(url);
      if (blockReason) {
        if (blockReason === "outside") {
          report.stats.outside++;
          if (report.outside_examples.length < 20) report.outside_examples.push(url);
        } else {
          report.stats.blocked++;
          if (report.blocked_examples.length < 50) report.blocked_examples.push(url);
        }
        continue;
      }

      report.crawled_pages++;
      let html;
      try {
        html = await fetchHtml(url);
      } catch (e) {
        report.stats.errors++;
        report.errors.push({ url, error: String(e?.message || e) });
        continue;
      }

      try {
        const dom = new JSDOM(html);
        const doc = cleanDom(dom.window.document);

        const title = (doc.querySelector("title")?.textContent || "").trim();

        const links = extractLinks(doc, url);
        for (const l of links) {
          const blockR = looksBlocked(l);
          if (blockR) {
            if (blockR === "outside") {
              report.stats.outside++;
              if (report.outside_examples.length < 20) report.outside_examples.push(l);
            } else {
              report.stats.blocked++;
              if (report.blocked_examples.length < 50) report.blocked_examples.push(l);
            }
            continue;
          }
          if (!seen.has(l) && report.crawled_pages + queue.length < MAX_PAGES * 5) {
            seen.add(l);
            queue.push(l);
          }
        }

        let text = extractText(doc);
        const uo = new URL(url);
        text = stripUredniDeskaFromUradIndex(uo, text);

        // minimální relevance: když je to fakt prázdné, neukládej
        if (!text || text.length < 80) {
          report.stats.skipped++;
          report.skipped.push(url);
          continue;
        }

        const section = classifySection(uo);
        pages[section].push({
          url,
          title,
          section,
          content: text
        });

        report.stats.ok++;
      } catch (e) {
        report.stats.errors++;
        report.errors.push({ url, error: String(e?.message || e) });
      }
    }
  }

  // concurrency pool
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    active++;
    try { await worker(); } finally { active--; }
  });
  await Promise.all(workers);

  // write files (overwrite)
  const outURAD = path.join(OUT_DIR, "01_STATIC_URAD_obec_radim.txt");
  const outOBEC = path.join(OUT_DIR, "01_STATIC_OBEC_obec_radim.txt");
  const outOST = path.join(OUT_DIR, "01_STATIC_OSTATNI_obec_radim.txt");

  fs.writeFileSync(outURAD, buildFileHeader("URAD") + pages.URAD.map(pageBlock).join("\n"), "utf8");
  fs.writeFileSync(outOBEC, buildFileHeader("OBEC") + pages.OBEC.map(pageBlock).join("\n"), "utf8");
  fs.writeFileSync(outOST, buildFileHeader("OSTATNI") + pages.OSTATNI.map(pageBlock).join("\n"), "utf8");

  fs.writeFileSync(path.join(OUT_DIR, "deep_crawl_report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({
    generated_at: report.generated_at,
    base: report.base,
    max_pages: report.max_pages,
    crawled_pages: report.crawled_pages,
    stats: report.stats,
    blocked_examples: report.blocked_examples.slice(0, 15),
    outside_examples: report.outside_examples.slice(0, 15),
    skipped: report.skipped.slice(0, 10),
    errors: report.errors.slice(0, 5),
  }, null, 2));
}

crawl().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});