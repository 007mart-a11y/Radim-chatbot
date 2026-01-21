// scripts/live_radim_scrape.mjs
// Vytvoří 10_LIVE_obec_radim.txt (serverless do /tmp, lokálně do public/knowledge)
// Obsah: Aktuality + Kalendář akcí + Úřední deska (z webu obec-radim.cz)
// NOVĚ: používá LIVE_UPDATED_AT_ISO + LIVE_UPDATED_AT_PRAGUE z env (aby byl čas identický s uploaderem)

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://www.obec-radim.cz";
const LIVE_FILE_PATH =
  process.env.LIVE_FILE_PATH ||
  (process.env.NETLIFY ? "/tmp/knowledge/10_LIVE_obec_radim.txt" : "public/knowledge/10_LIVE_obec_radim.txt");

function absUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${SITE_BASE_URL.replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "live-radim-scraper/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) throw new Error(`Non-HTML content-type (${ct}) ${url}`);
  return await res.text();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function takeSection(text, maxChars = 120000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[...ZKRÁCENO kvůli velikosti...]\n";
}

async function buildSection(title, url) {
  const html = await fetchText(url);
  const cleaned = stripHtml(html);
  return `# ${title}\nZdroj: ${url}\n\n${takeSection(cleaned)}\n`;
}

async function ensureDirForFile(filepath) {
  const { dirname } = await import("node:path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(filepath), { recursive: true });
}

async function writeFile(filepath, content) {
  const { writeFile } = await import("node:fs/promises");
  await ensureDirForFile(filepath);
  await writeFile(filepath, content, "utf8");
}

async function main() {
  // identický čas jako z uploaderu (když není, spadne to na lokální teď)
  const updatedIso = process.env.LIVE_UPDATED_AT_ISO || new Date().toISOString();
  const updatedPrague = process.env.LIVE_UPDATED_AT_PRAGUE || "";

  const parts = [];

  parts.push(`# 10_LIVE_obec_radim.txt
Aktualizováno (ISO): ${updatedIso}${updatedPrague ? `\nAktualizováno (Europe/Prague): ${updatedPrague}` : ""}
Web: ${SITE_BASE_URL}

Tento soubor obsahuje živá data (aktuality, akce, úřední deska).
Při rozporu má přednost CORE (00_CORE_obec_radim.txt).
`);

  const sections = [
    { title: "Aktuality", url: absUrl("/aktualne/aktuality/") },
    { title: "Kalendář akcí", url: absUrl("/aktualne/kalendar-akci/") },
    { title: "Úřední deska", url: absUrl("/urad/uredni-deska/") },
  ];

  for (const s of sections) {
    try {
      parts.push(await buildSection(s.title, s.url));
    } catch (e) {
      parts.push(`# ${s.title}\nZdroj: ${s.url}\n\n[CHYBA PŘI NAČÍTÁNÍ] ${e?.message || e}\n`);
    }
    parts.push("\n---\n");
  }

  const output = parts.join("\n");
  await writeFile(LIVE_FILE_PATH, output);

  console.log("LIVE SCRAPE DONE");
  console.log("UpdatedAt ISO:", updatedIso);
  if (updatedPrague) console.log("UpdatedAt Prague:", updatedPrague);
  console.log("Wrote:", LIVE_FILE_PATH);
  console.log("Bytes:", Buffer.byteLength(output, "utf8"));
}

main().catch((e) => {
  console.error("LIVE SCRAPE FAILED:", e);
  process.exit(1);
});