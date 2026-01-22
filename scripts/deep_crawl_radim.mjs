// scripts/deep_crawl_radim_structured.mjs
// Node 18+ (nativní fetch), bez obrázků a bez aktualit / fotek / zpravodaje.
// Výstup:
//  - knowledge/01_STATIC_SITE_obec_radim.txt  (silně strukturovaný text pro asistenta)
//  - knowledge/20_PDF_LIBRARY_manifest.json   (jen seznam všech PDF odkazů)
//
// ENV (typicky přes příkaz nebo Netlify build):
//   SITE_BASE_URL=https://www.obec-radim.cz
//   OUT_FILE=knowledge/01_STATIC_SITE_obec_radim.txt
//   PDF_MANIFEST=knowledge/20_PDF_LIBRARY_manifest.json
//   MAX_PAGES=900
//   CONCURRENCY=8
//   REQUEST_DELAY_MS=120
//   USER_AGENT="RadimBot/1.0 (+deep crawl)"
//   ONLY_SAME_ORIGIN=true

import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const OUT_FILE = process.env.OUT_FILE || "knowledge/01_STATIC_SITE_obec_radim.txt";
const PDF_MANIFEST = process.env.PDF_MANIFEST || "knowledge/20_PDF_LIBRARY_manifest.json";

const MAX_PAGES = parseInt(process.env.MAX_PAGES || "900", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8", 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "120", 10);
const ONLY_SAME_ORIGIN = String(process.env.ONLY_SAME_ORIGIN ?? "true").toLowerCase() !== "false";
const USER_AGENT = process.env.USER_AGENT || "RadimBot/1.0 (+deep crawl)";

const ORIGIN = new URL(SITE_BASE_URL).origin;

// Nechceme: aktuality, kalendář, fotky, zpravodaj…
const denyPathContains = [
  "/fotogalerie",
  "/galerie",
  "/gallery",
  "/media",
  "/img",
  "/images",
  "/css",
  "/js",
  "/admin",
  "/wp-admin",
  "/login",
  "/user",
  "/account",
  "/cart",
  "/cookies",
  "/sitemap",
  "/aktualne",
  "/aktuality",
  "/kalendar-akci",
  "/kalendar_akci",
  "/zpravodaj",
  "/obecni-zpravodaj",
  "/obecni_zpravodaj"
];

const denyExtensions = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
  ".mp4", ".mov", ".avi", ".mkv",
  ".mp3", ".wav", ".ogg",
  ".zip", ".rar", ".7z"
];

// Tohle je jen pro prioritu, ne filtr
const allowPriorityPathContains = [
  "/organizace",
  "/spolky",
  "/sokol",
  "/hasici",
  "/sdh",
  "/zahradkari",
  "/kontakt",
  "/kontakty",
  "/o-obci",
  "/urad",
  "/uradni-deska",
  "/skolka",
  "/skola",
  "/ms-",
  "/zs-",
  "/sport",
  "/knihovna",
  "/odpady",
  "/vodovod",
  "/kanalizace"
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(u, base = SITE_BASE_URL) {
  try {
    const url = new URL(u, base);

    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (ONLY_SAME_ORIGIN && url.origin !== ORIGIN) return null;

    // pryč hash
    url.hash = "";

    // pryč běžné tracking parametry + print
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((k) => {
      url.searchParams.delete(k);
    });
    if (url.searchParams.has("print")) return null;

    return url.toString();
  } catch {
    return null;
  }
}

function isDenied(urlStr) {
  try {
    const url = new URL(urlStr);
    const p = url.pathname.toLowerCase();

    if (denyPathContains.some((d) => p.includes(d))) return true;
    if (denyExtensions.some((ext) => p.endsWith(ext))) return true;

    // nechceme divné download.php a modules
    if (p.includes("download.php") || p.includes("/modules/")) return true;

    // moc dlouhé query = typicky filtry, bordel
    if ((url.search || "").length > 80) return true;

    return false;
  } catch {
    return true;
  }
}

function scoreUrl(urlStr) {
  let s = 0;
  const u = new URL(urlStr);
  const p = u.pathname.toLowerCase();

  if (allowPriorityPathContains.some((x) => p.includes(x))) s += 50;
  if (p.includes("kontakt")) s += 40;
  if (p.includes("organizace") || p.includes("spolky")) s += 40;
  if (p.includes("sokol") || p.includes("hasici") || p.includes("sdh")) s += 35;
  if (p.includes("skola") || p.includes("skolka") || p.includes("ms-") || p.includes("zs-")) s += 35;

  // root lehce dolů
  if (p === "/" || p === "") s -= 10;

  // kratší URL jako bonus
  s += Math.max(0, 20 - p.length / 10);

  return s;
}

async function fetchHtml(url) {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml")) return null;

  return await res.text();
}

function textClean(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function elText(el) {
  if (!el) return "";
  return textClean(el.textContent || "");
}

function removeJunk(dom) {
  const doc = dom.window.document;
  const selectors = [
    "script", "style", "noscript", "svg",
    "header nav", "nav", "footer",
    ".breadcrumb", ".breadcrumbs",
    ".cookie", ".cookies", "#cookies",
    ".gallery", ".fotogalerie", ".carousel",
    ".menu", ".main-menu", ".site-menu",
    ".search", "form"
  ];
  selectors.forEach((sel) => doc.querySelectorAll(sel).forEach((n) => n.remove()));
}

function extractLinks(dom, baseUrl) {
  const doc = dom.window.document;
  const a = [...doc.querySelectorAll("a[href]")];

  const links = [];
  for (const node of a) {
    const href = node.getAttribute("href");
    if (!href) continue;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    if (href.startsWith("#") || href.startsWith("javascript:")) continue;

    const norm = normalizeUrl(href, baseUrl);
    if (!norm) continue;
    if (isDenied(norm)) continue;

    links.push(norm);
  }
  return [...new Set(links)];
}

// Pozná kontaktní/organizační stránky (spolky, Sokol, hasiči…)
function looksLikeOrgOrContactsPage(urlStr, titleText, bodyText) {
  const p = new URL(urlStr).pathname.toLowerCase();
  const t = (titleText || "").toLowerCase();

  if (p.includes("organizace") || p.includes("spolky")) return true;
  if (p.includes("sokol") || p.includes("hasici") || p.includes("sdh")) return true;
  if (p.includes("kontakt")) return true;
  if (t.includes("kontakt") || t.includes("sokol") || t.includes("hasi")) return true;

  const hasPhone = /(\+420\s*)?\d{3}\s?\d{3}\s?\d{3}/.test(bodyText);
  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(bodyText);
  const hasRole = /(předsed|jednatel|hospodář|starost|místostarost|správce|výbor|členové)/i.test(bodyText);

  return (hasPhone && hasEmail) || (hasPhone && hasRole);
}

function extractContactsEntities(bodyText) {
  const text = bodyText;
  const emails = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []))];

  const phoneRaw = (text.match(/(\+420\s*)?\d{3}\s?\d{3}\s?\d{3}/g) || [])
    .map((x) => x.replace(/\s+/g, " ").trim());
  const phones = [...new Set(phoneRaw)];

  const roleLines = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const roleRe = /(předsed[ay]|jednatel|hospodář|místopředsed[ay]|správce|velitel|pokladn[íy]|tajemník|členové výboru|výbor|kontakt)/i;

  for (const l of lines) {
    if (roleRe.test(l) && l.length < 200) roleLines.push(l);
  }

  return { emails, phones, roleLines: [...new Set(roleLines)] };
}

function pickMainTitle(dom) {
  const doc = dom.window.document;
  const h1 = doc.querySelector("h1");
  if (h1) return elText(h1);
  const title = doc.querySelector("title");
  if (title) return elText(title);
  return "";
}

function extractMainText(dom) {
  const doc = dom.window.document;

  const main =
    doc.querySelector("main") ||
    doc.querySelector("#content") ||
    doc.querySelector(".content") ||
    doc.querySelector(".main") ||
    doc.body;

  const parts = [];
  const walker = doc.createTreeWalker(main, dom.window.NodeFilter.SHOW_ELEMENT);

  const pushLine = (s) => {
    const t = textClean(s);
    if (t) parts.push(t);
  };

  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = (el.tagName || "").toLowerCase();

    if (["h2", "h3", "h4"].includes(tag)) pushLine("\n" + elText(el));
    if (tag === "p") pushLine(elText(el));
    if (tag === "li") pushLine("• " + elText(el));
    if (tag === "table") {
      const rows = [...el.querySelectorAll("tr")].slice(0, 80);
      for (const r of rows) {
        const cells = [...r.querySelectorAll("th,td")].map((c) => elText(c)).filter(Boolean);
        if (cells.length) pushLine(cells.join(" | "));
      }
      pushLine("");
    }
  }

  return textClean(parts.join("\n"));
}

function extractPdfLinks(dom, baseUrl) {
  const doc = dom.window.document;
  const a = [...doc.querySelectorAll("a[href]")];
  const pdfs = [];

  for (const node of a) {
    const href = node.getAttribute("href");
    if (!href) continue;
    const norm = normalizeUrl(href, baseUrl);
    if (!norm) continue;

    const p = new URL(norm).pathname.toLowerCase();
    if (p.endsWith(".pdf")) {
      const label = elText(node) || "";
      pdfs.push({ url: norm, label });
    }
  }

  const m = new Map();
  for (const x of pdfs) m.set(x.url, x);
  return [...m.values()];
}

// Kategorie pro asistenta (aby „chápal význam“)
function categorizeUrl(urlStr) {
  const p = new URL(urlStr).pathname.toLowerCase();

  if (p.includes("/urad/")) return "ÚŘAD A ÚŘEDNÍ INFORMACE";
  if (p.includes("sokol") || p.includes("hasici") || p.includes("sdh") || p.includes("spolek") || p.includes("zahradkari") || p.includes("knihovna"))
    return "SPOLKY A ORGANIZACE";
  if (p.includes("skola") || p.includes("škol") || p.includes("/ms") || p.includes("materska") || p.includes("školka") || p.includes("/zs"))
    return "ŠKOLA A ŠKOLKA";
  if (p.includes("odpady") || p.includes("trideni-odpadu") || p.includes("bioodpad") || p.includes("sberny-dvur") || p.includes("vodovod") || p.includes("kanalizace"))
    return "ODPADY A TECHNICKÉ SLUŽBY";
  if (p.includes("o-obci") || p.includes("historie") || p.includes("pamatky"))
    return "OBCI, HISTORIE A MÍSTA";
  return "OSTATNÍ INFORMACE";
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function run() {
  console.log("DEEP CRAWL RADIM – STRUKTUROVANÁ VERZE");
  console.log("Base:", SITE_BASE_URL);
  console.log("OUT:", OUT_FILE);

  const visited = new Set();
  const queue = [];
  const results = [];
  const pdfLibrary = new Map(); // url -> {url,label,found_on}

  const startUrl = normalizeUrl(SITE_BASE_URL);
  if (!startUrl) throw new Error("Bad SITE_BASE_URL");

  queue.push({ url: startUrl, score: scoreUrl(startUrl) });

  function popNext() {
    queue.sort((a, b) => b.score - a.score);
    return queue.shift();
  }

  function enqueue(url) {
    if (!url) return;
    if (visited.has(url)) return;
    if (queue.some((x) => x.url === url)) return;
    queue.push({ url, score: scoreUrl(url) });
  }

  async function worker(workerId) {
    while (results.length < MAX_PAGES) {
      const item = popNext();
      if (!item) break;

      const url = item.url;
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const html = await fetchHtml(url);
        if (!html) continue;

        const dom = new JSDOM(html);
        removeJunk(dom);

        const title = pickMainTitle(dom);
        const bodyText = extractMainText(dom);
        const pdfs = extractPdfLinks(dom, url);

        pdfs.forEach((p) => {
          if (!pdfLibrary.has(p.url)) {
            pdfLibrary.set(p.url, { ...p, found_on: url });
          }
        });

        const important = looksLikeOrgOrContactsPage(url, title, bodyText);
        const entities = important ? extractContactsEntities(bodyText) : null;
        const category = categorizeUrl(url);

        if (bodyText && bodyText.length > 80) {
          results.push({
            url,
            title,
            text: bodyText,
            important,
            category,
            pdfs,
            entities
          });
        }

        const links = extractLinks(dom, url);
        for (const l of links) {
          if (allowPriorityPathContains.some((x) => new URL(l).pathname.toLowerCase().includes(x))) {
            enqueue(l);
          }
        }
        for (const l of links) enqueue(l);

        if (visited.size % 25 === 0) {
          console.log(`[W${workerId}] visited=${visited.size} saved=${results.length} queue=${queue.length}`);
        }
      } catch (e) {
        // tiché chyby, nechceme padat
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i + 1));
  await Promise.all(workers);

  // seřadit: prioritní napřed, pak podle kategorie a URL
  results.sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    if (a.category !== b.category) return a.category.localeCompare(b.category, "cs");
    return a.url.localeCompare(b.url, "cs");
  });

  const out = [];
  out.push("01_STATIC_SITE_OBEC_RADIM – STRUKTUROVANÉ STABILNÍ INFORMACE");
  out.push(`Vygenerováno: ${new Date().toISOString()}`);
  out.push(`Zdroj: ${SITE_BASE_URL}`);
  out.push("Tento soubor neobsahuje aktuality, kalendář akcí, fotogalerie ani obecní zpravodaj.");
  out.push("Stránky jsou rozděleny do kategorií a každá položka obsahuje URL, název, stručný obsah a případné PDF odkazy.");
  out.push("\n================================================================\n");

  let lastCategory = null;

  for (const r of results) {
    if (r.category !== lastCategory) {
      lastCategory = r.category;
      out.push(`\n######## KATEGORIE: ${r.category}\n`);
    }

    out.push("------------------------------------------------------------");
    out.push(`URL: ${r.url}`);
    if (r.title) out.push(`NÁZEV: ${r.title}`);
    out.push(`TYP STRÁNKY: ${r.important ? "PRIORITNÍ – kontakty / organizace / úřad" : "Standardní informativní stránka"}`);

    if (r.entities) {
      const { phones, emails, roleLines } = r.entities;
      if ((phones?.length || 0) || (emails?.length || 0) || (roleLines?.length || 0)) {
        out.push("VYTAŽENÉ KONTAKTY A ROLE:");
        if (phones?.length) out.push(`- TELEFONY: ${phones.join(", ")}`);
        if (emails?.length) out.push(`- E-MAILY: ${emails.join(", ")}`);
        if (roleLines?.length) {
          out.push("- ROLE / POPIS FUNKCÍ:");
          roleLines.slice(0, 40).forEach((l) => out.push(`  • ${l}`));
        }
      }
    }

    if (r.pdfs && r.pdfs.length) {
      out.push("PDF DOKUMENTY NA TÉTO STRÁNCE:");
      for (const p of r.pdfs) {
        const label = p.label ? p.label.replace(/\s+/g, " ").trim() : "Dokument (bez názvu)";
        out.push(`- ${label} → ${p.url}`);
      }
    }

    out.push("\nTEXT STRÁNKY:");
    out.push(r.text);
    out.push("");
  }

  // uložit text
  ensureDir(OUT_FILE);
  fs.writeFileSync(OUT_FILE, out.join("\n"), "utf-8");

  // PDF manifest (globální seznam všech PDF)
  const pdfArr = [...pdfLibrary.values()].sort((a, b) => a.url.localeCompare(b.url, "cs"));
  ensureDir(PDF_MANIFEST);
  fs.writeFileSync(
    PDF_MANIFEST,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        site: SITE_BASE_URL,
        count: pdfArr.length,
        items: pdfArr
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log("\nDONE");
  console.log("Visited:", visited.size);
  console.log("Saved pages:", results.length);
  console.log("Queue left:", queue.length);
  console.log("OUT:", OUT_FILE);
  console.log("PDF:", PDF_MANIFEST);
}

run().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});