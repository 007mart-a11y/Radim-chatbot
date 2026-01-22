// scripts/deep_crawl_radim_B.mjs
// Node 18+ (nativní fetch). Doporučeno: npm i jsdom
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const OUT_DIR = process.env.OUT_DIR || "public/knowledge";
const OUT_TXT = process.env.OUT_TXT || path.join(OUT_DIR, "01_STATIC_SITE_obec_radim.txt");
const OUT_INDEX = process.env.OUT_INDEX || path.join(OUT_DIR, "02_LINK_INDEX_obec_radim.json");

const MAX_PAGES = Number(process.env.MAX_PAGES || 600);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 20000);

// Co přesně nechceme tahat (můžeš doplnit)
const SKIP_URL_RE = new RegExp(
  [
    "/fotogalerie",
    "/galerie",
    "/vyhledavani",
    "/print",
    "/rss",
    "/sitemap",
    "/admin",
    "/cookie",
    "/gdpr",
    // často měnící se sekce – dle potřeby:
    "/uredni-deska",      // jestli chceš vynechat úřední desku, nech; jinak smaž
    "/aktuality",         // jestli chceš vynechat aktuality, nech; jinak smaž
    "/kalendar-akci",     // jestli chceš vynechat akce, nech; jinak smaž
    "/obecni-spravodaj",  // zpravodaj
  ].join("|"),
  "i"
);

// Soubory – nelezeme “dovnitř”, jen evidujeme a validujeme
const FILE_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|csv|rtf|zip)$/i;

// Často rozbíjející odkazy na tomto webu
function shouldSkipUrl(u) {
  const s = String(u);
  if (!s.startsWith(SITE_BASE_URL)) return true;
  if (SKIP_URL_RE.test(s)) return true;
  // typicky nepotřebné / duplicitní
  if (s.includes("download.php")) return false; // necháme jako resource
  if (s.includes("modules/")) return true;      // bývá galerie / interní modul
  if (s.includes("#")) return false;            // anchor je ok (pro index)
  return false;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    // jen stejné domény (ať neleze ven)
    if (u.origin !== new URL(SITE_BASE_URL).origin) return null;

    // uklidit tracking
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(k => u.searchParams.delete(k));

    // sjednotit: bez koncové tečky apod.
    return u.toString().replace(/\.+$/g, "");
  } catch {
    return null;
  }
}

// jemný timeout wrapper
async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal, redirect: "follow" });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/** =========================
 *  VALIDACE ODKAZŮ (B)
 *  - cache pro rychlost
 *  - HEAD -> fallback GET
 *  - ukládá status + finalUrl
 *  ========================= */
const validateCache = new Map();
async function validateUrl(url) {
  if (validateCache.has(url)) return validateCache.get(url);

  const prom = (async () => {
    // u anchor odkazů validujeme jen “base” bez hashe
    const base = url.split("#")[0];

    try {
      // 1) zkus HEAD
      let r = await fetchWithTimeout(base, { method: "HEAD" });
      if (r.status === 405 || r.status === 403) {
        // 2) fallback GET (bez stahování velkých věcí – ale u PDF to stejně může být velké)
        r = await fetchWithTimeout(base, { method: "GET" });
      }
      const finalUrl = r.url || base;
      const status = r.status || 0;

      // považuj 200-399 za OK
      const ok = status >= 200 && status < 400;
      return { ok, status, finalUrl };
    } catch (e) {
      return { ok: false, status: 0, finalUrl: base, error: String(e?.message || e) };
    }
  })();

  validateCache.set(url, prom);
  return prom;
}

/** =========================
 *  EXTRAKCE OBSAHU
 *  - odřízne menu/footer/script/style
 *  - zkusí najít hlavní content
 *  ========================= */
function pickMain(document) {
  const selectors = [
    "main",
    "#content",
    ".content",
    ".page-content",
    "article",
    ".container article",
    ".container",
    "body",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent && el.textContent.trim().length > 200) return el;
  }
  return document.body;
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sectionFromUrl(u) {
  try {
    const p = new URL(u).pathname.split("/").filter(Boolean);
    if (!p.length) return "Úvod";
    // první segment = sekce
    return p[0].replace(/-/g, " ");
  } catch {
    return "Úvod";
  }
}

/** =========================
 *  CRAWL
 *  ========================= */
const visited = new Set();
const queue = [SITE_BASE_URL + "/"];
const pages = [];      // obsah pro TXT
const linkIndex = [];  // strukturovaný JSON index

async function processPage(url) {
  if (visited.has(url)) return;
  visited.add(url);

  // skip pravidla
  if (shouldSkipUrl(url)) return;

  const isFile = FILE_EXT_RE.test(url.split("#")[0]) || url.includes("download.php");
  if (isFile) {
    // soubory neparsujeme, jen evidujeme (validace později při sběru linků z page)
    return;
  }

  let html = "";
  let status = 0;
  let finalUrl = url;

  try {
    const r = await fetchWithTimeout(url, { method: "GET" });
    status = r.status || 0;
    finalUrl = r.url || url;

    if (status >= 400) {
      // stránka je špatná, ale necháme ji v indexu jako ARCHIVED/ERROR
      linkIndex.push({
        type: "page",
        url,
        finalUrl,
        status,
        ok: false,
        section: sectionFromUrl(url),
        title: null,
        text: null,
        links: [],
        files: [],
        note: "HTTP error",
      });
      return;
    }

    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      // není HTML, bereme jako resource
      linkIndex.push({
        type: "resource",
        url,
        finalUrl,
        status,
        ok: status >= 200 && status < 400,
        section: sectionFromUrl(url),
        title: null,
        text: null,
        links: [],
        files: [],
      });
      return;
    }

    html = await r.text();
  } catch (e) {
    linkIndex.push({
      type: "page",
      url,
      finalUrl,
      status: 0,
      ok: false,
      section: sectionFromUrl(url),
      title: null,
      text: null,
      links: [],
      files: [],
      note: "Fetch failed: " + String(e?.message || e),
    });
    return;
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;

  // odstraň rušivé věci
  document.querySelectorAll("script,style,noscript,svg").forEach(n => n.remove());

  const title = cleanText(document.querySelector("h1")?.textContent || document.title || "");
  const main = pickMain(document);

  // posbírej odkazy
  const links = [];
  const files = [];

  main.querySelectorAll("a[href]").forEach(a => {
    const text = cleanText(a.textContent).slice(0, 140);
    const hrefRaw = a.getAttribute("href");
    const abs = normalizeUrl(hrefRaw, finalUrl);
    if (!abs) return;

    // filtr sekcí / duplicit
    if (shouldSkipUrl(abs) && !abs.includes("#") && !FILE_EXT_RE.test(abs) && !abs.includes("download.php")) return;

    const base = abs.split("#")[0];
    const isFileLink = FILE_EXT_RE.test(base) || base.includes("download.php");

    if (isFileLink) {
      files.push({ text: text || "(soubor)", url: abs });
    } else {
      links.push({ text: text || "(odkaz)", url: abs });
      // přidej do fronty jen base bez anchoru
      if (!visited.has(base) && !shouldSkipUrl(base)) queue.push(base);
    }
  });

  // z textu vyhoď menu-like opakující se věci tím, že bereš jen MAIN
  const text = cleanText(main.textContent);

  // pro TXT: krátká “hlavička” + body + linky
  pages.push({
    url: finalUrl,
    title: title || "(bez názvu)",
    section: sectionFromUrl(finalUrl),
    text,
    links,
    files,
  });

  linkIndex.push({
    type: "page",
    url,
    finalUrl,
    status,
    ok: true,
    section: sectionFromUrl(finalUrl),
    title: title || null,
    textPreview: text.slice(0, 500),
    links,
    files,
  });
}

async function worker() {
  while (queue.length && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url) break;
    await processPage(url);
  }
}

async function run() {
  ensureDir(OUT_DIR);

  // crawl paralelně
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // =========================
  // VALIDACE ODKAZŮ (B)
  // validujeme jen to, co budeme posílat lidem
  // =========================
  const allToValidate = new Set();
  for (const p of pages) {
    p.links.forEach(l => allToValidate.add(l.url));
    p.files.forEach(f => allToValidate.add(f.url));
    allToValidate.add(p.url);
  }

  const list = Array.from(allToValidate);
  // batch validace (omezeně paralelně)
  const V = 12;
  for (let i = 0; i < list.length; i += V) {
    const chunk = list.slice(i, i + V);
    const res = await Promise.all(chunk.map(u => validateUrl(u)));
    // nic – cache se naplní
    void res;
  }

  // promítnout validaci do struktur
  for (const p of pages) {
    const vPage = await validateUrl(p.url);
    p.valid = vPage;

    for (const l of p.links) {
      l.valid = await validateUrl(l.url);
      // když 404, označ jako archivní – asistent pak nebude tvrdit “aktuální”
      if (!l.valid.ok) l.archived = true;
    }
    for (const f of p.files) {
      f.valid = await validateUrl(f.url);
      if (!f.valid.ok) f.archived = true;
    }
  }

  for (const it of linkIndex) {
    const v = await validateUrl(it.finalUrl || it.url);
    it.valid = v;
    if (!v.ok) it.archived = true;

    if (Array.isArray(it.links)) {
      for (const l of it.links) {
        l.valid = await validateUrl(l.url);
        if (!l.valid.ok) l.archived = true;
      }
    }
    if (Array.isArray(it.files)) {
      for (const f of it.files) {
        f.valid = await validateUrl(f.url);
        if (!f.valid.ok) f.archived = true;
      }
    }
  }

  // =========================
  // VÝSTUP: TXT pro vector store
  // =========================
  let out = "";
  out += `# OBEC RADIM – STATICKÝ KONTEXT (deep crawl)\n`;
  out += `# Generováno: ${new Date().toISOString()}\n\n`;

  // seřadit dle sekce + title
  pages.sort((a, b) => (a.section || "").localeCompare(b.section || "") || (a.title || "").localeCompare(b.title || ""));

  for (const p of pages) {
    // když stránka 404, nedávej text, jen poznámku
    const ok = p.valid?.ok !== false;

    out += `---\n`;
    out += `## ${p.title}\n`;
    out += `Sekce: ${p.section}\n`;
    out += `URL: ${p.url}\n`;
    if (!ok) out += `Poznámka: ARCHIVNÍ / nedostupné (HTTP ${p.valid?.status || "?"})\n`;
    out += `\n`;

    if (ok && p.text) {
      // omez délku, aby to nebylo gigantické; zbytek stejně pokryje index + další stránky
      const trimmed = p.text.length > 12000 ? p.text.slice(0, 12000) + "\n…(zkráceno)\n" : p.text;
      out += trimmed + "\n\n";
    }

    if ((p.links?.length || 0) > 0) {
      out += `Odkazy na podstránky:\n`;
      for (const l of p.links.slice(0, 60)) {
        const label = l.text && l.text !== "(odkaz)" ? l.text : "odkaz";
        const suffix = l.archived ? " [ARCHIVNÍ]" : "";
        out += `- ${label}: ${l.url}${suffix}\n`;
      }
      out += `\n`;
    }

    if ((p.files?.length || 0) > 0) {
      out += `Soubory / formuláře:\n`;
      for (const f of p.files.slice(0, 60)) {
        const label = f.text && f.text !== "(soubor)" ? f.text : "soubor";
        const suffix = f.archived ? " [ARCHIVNÍ]" : "";
        out += `- ${label}: ${f.url}${suffix}\n`;
      }
      out += `\n`;
    }
  }

  fs.writeFileSync(OUT_TXT, out, "utf8");

  // =========================
  // VÝSTUP: JSON index pro přesné odkazy
  // =========================
  fs.writeFileSync(OUT_INDEX, JSON.stringify({ generatedAt: new Date().toISOString(), site: SITE_BASE_URL, items: linkIndex }, null, 2), "utf8");

  console.log("DONE");
  console.log("Visited:", visited.size);
  console.log("Queue left:", queue.length);
  console.log("OUT_TXT:", OUT_TXT);
  console.log("OUT_INDEX:", OUT_INDEX);
}

run().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});