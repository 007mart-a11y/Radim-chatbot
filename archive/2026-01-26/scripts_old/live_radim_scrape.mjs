// scripts/live_radim_scrape.mjs
// Node 18+ (nativní fetch). Doporučeno: npm i jsdom
// Vytvoří 10_LIVE_obec_radim.txt (serverless do /tmp, lokálně do public/knowledge)
// Obsah: AKTUALITY + KALENDÁŘ AKCÍ + ÚŘEDNÍ DESKA (STRUCTURED items)

import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import fs from "node:fs/promises";
import path from "node:path";

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const LIVE_FILE_PATH =
  process.env.LIVE_FILE_PATH ||
  (process.env.NETLIFY ? "/tmp/knowledge/10_LIVE_obec_radim.txt" : "public/knowledge/10_LIVE_obec_radim.txt");

function absUrl(p) {
  if (/^https?:\/\//i.test(p)) return p;
  return `${SITE_BASE_URL.replace(/\/$/, "")}/${String(p).replace(/^\//, "")}`;
}

async function ensureDirForFile(filepath) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": "live-radim-scraper/2.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) throw new Error(`Non-HTML (${ct}) ${url}`);
  return await res.text();
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseCzDateToYear(text) {
  // vezme první 4 čísla jako rok, když existuje
  const m = String(text || "").match(/\b(20\d{2}|19\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function guessDateFromItemText(t) {
  // hrubě: najdi datum typu 1. 2. 2026 / 01.01.2026 / 1.1.2026
  const m = String(t || "").match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (!m) return null;
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const yyyy = m[3];
  return `${dd}.${mm}.${yyyy}`;
}

function uniqueByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.url || it.title;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function scrapeListGeneric({ title, url, pickers, type }) {
  const html = await fetchHtml(url);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // zkus najít položky podle selectorů (weby se liší; proto více pickerů)
  let nodes = [];
  for (const sel of pickers.itemSelectors) {
    const found = Array.from(doc.querySelectorAll(sel));
    if (found.length) {
      nodes = found;
      break;
    }
  }

  // fallback: všechny odkazy v hlavním obsahu
  if (!nodes.length) {
    const main = doc.querySelector("main") || doc.querySelector("#content") || doc.body;
    nodes = Array.from(main.querySelectorAll("a[href]")).slice(0, 80);
  }

  const items = nodes
    .map((node) => {
      // title
      let a = node.matches?.("a[href]") ? node : node.querySelector?.("a[href]");
      if (!a) a = node.querySelector?.("a");
      const href = a?.getAttribute?.("href") || node.getAttribute?.("href") || "";
      const u = href ? absUrl(href) : "";

      let rawTitle = cleanText(a?.textContent || node.textContent || "");
      rawTitle = rawTitle.replace(/\s*\(\s*\d+\s*\)\s*$/, "").trim(); // (12) apod.
      if (!rawTitle) return null;

      // date (pokud najdeme)
      const nodeText = cleanText(node.textContent || "");
      const date = guessDateFromItemText(nodeText) || guessDateFromItemText(rawTitle) || null;
      const year = date ? parseCzDateToYear(date) : parseCzDateToYear(nodeText);

      return {
        type,
        title: rawTitle.slice(0, 200),
        date,
        year,
        url: u,
      };
    })
    .filter(Boolean);

  return {
    sectionTitle: title,
    sourceUrl: url,
    items: uniqueByUrl(items),
  };
}

function markStatusForEvents(items) {
  // Bez spolehlivého parsování času z webu radši jen: pokud rok < aktuální rok => ARCHIV
  const nowYear = new Date().getFullYear();
  return items.map((it) => {
    const y = it.year;
    let status = "NEZNÁMÉ";
    if (y && y < nowYear) status = "PROBĚHLÁ/ARCHIV";
    if (y && y === nowYear) status = "AKTUÁLNÍ";
    if (y && y > nowYear) status = "PLÁNOVANÁ";
    return { ...it, status };
  });
}

function markStatusForNews(items) {
  const nowYear = new Date().getFullYear();
  return items.map((it) => {
    const y = it.year;
    let status = "AKTUÁLNÍ";
    if (y && y < nowYear) status = "ARCHIV";
    return { ...it, status };
  });
}

function markStatusForBoard(items) {
  // Úřední deska: když neumíme platnost -> aspoň aktuální/archiv podle roku, jinak NEZNÁMÉ
  const nowYear = new Date().getFullYear();
  return items.map((it) => {
    const y = it.year;
    let status = "NEZNÁMÉ";
    if (y && y < nowYear) status = "ARCHIV";
    if (y && y >= nowYear) status = "AKTUÁLNÍ";
    return { ...it, status };
  });
}

function renderSection({ sectionTitle, sourceUrl, items }) {
  let out = "";
  out += `================================\n${sectionTitle.toUpperCase()}\n================================\n`;
  out += `Zdroj: ${sourceUrl}\n\n`;

  if (!items.length) {
    out += `- (Žádné položky nebyly nalezeny.)\n\n`;
    return out;
  }

  for (const it of items.slice(0, 200)) {
    out += `- Titulek: ${it.title}\n`;
    if (it.date) out += `  Datum: ${it.date}\n`;
    if (it.year) out += `  Rok: ${it.year}\n`;
    if (it.status) out += `  Stav: ${it.status}\n`;
    if (it.url) out += `  Odkaz: ${it.url}\n`;
    out += `\n`;
  }

  return out;
}

async function main() {
  const updatedIso = process.env.LIVE_UPDATED_AT_ISO || new Date().toISOString();
  const updatedPrague = process.env.LIVE_UPDATED_AT_PRAGUE || "";

  const head =
    `LIVE_DATA — OBEC RADIM\n` +
    `Aktualizováno (ISO): ${updatedIso}\n` +
    (updatedPrague ? `Aktualizováno (Europe/Prague): ${updatedPrague}\n` : "") +
    `Web: ${SITE_BASE_URL}\n\n` +
    `Poznámka: Tento soubor obsahuje živá data (aktuality, kalendář akcí, úřední deska).\n` +
    `Při rozporu má přednost CORE (00_CORE_obec_radim.txt).\n\n`;

  const news = await scrapeListGeneric({
    title: "Aktuality",
    url: absUrl("/aktualne/aktuality/"),
    type: "aktualita",
    pickers: {
      itemSelectors: [
        "main a[href*='/aktualne/aktuality/']",
        ".content a[href*='/aktualne/aktuality/']",
        "a[href*='/aktualne/aktuality/']",
      ],
    },
  });

  const events = await scrapeListGeneric({
    title: "Kalendář akcí",
    url: absUrl("/aktualne/kalendar-akci/"),
    type: "akce",
    pickers: {
      itemSelectors: [
        "main a[href*='/aktualne/kalendar-akci/']",
        ".content a[href*='/aktualne/kalendar-akci/']",
        "a[href*='/aktualne/kalendar-akci/']",
      ],
    },
  });

  const board = await scrapeListGeneric({
    title: "Úřední deska",
    url: absUrl("/urad/uredni-deska/"),
    type: "uredni_deska",
    pickers: {
      itemSelectors: [
        "main a[href*='/urad/uredni-deska/']",
        ".content a[href*='/urad/uredni-deska/']",
        "a[href*='/urad/uredni-deska/']",
      ],
    },
  });

  news.items = markStatusForNews(news.items);
  events.items = markStatusForEvents(events.items);
  board.items = markStatusForBoard(board.items);

  const out =
    head +
    renderSection(news) +
    renderSection(events) +
    renderSection(board);

  await ensureDirForFile(LIVE_FILE_PATH);
  await fs.writeFile(LIVE_FILE_PATH, out, "utf8");

  console.log("LIVE SCRAPE DONE");
  console.log("Wrote:", LIVE_FILE_PATH);
  console.log("Bytes:", Buffer.byteLength(out, "utf8"));
}

main().catch((e) => {
  console.error("LIVE SCRAPE FAILED:", e?.stack || e?.message || e);
  process.exit(1);
});