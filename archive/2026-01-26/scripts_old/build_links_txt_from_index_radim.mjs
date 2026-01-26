// scripts/build_links_txt_from_index_radim.mjs
// Vytvoří přehledný TXT soubor s odkazy z 02_LINK_INDEX_obec_radim.json

import fs from "node:fs";
import path from "node:path";

const BASE_DIR = "knowledge";
const INPUT = path.join(BASE_DIR, "02_LINK_INDEX_obec_radim.json");
const OUTPUT = path.join(BASE_DIR, "03_LINKS_obec_radim.txt");

if (!fs.existsSync(INPUT)) {
  console.error("Chybí vstupní soubor:", INPUT);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const items = Array.isArray(data.items) ? data.items : [];

let out = "";
out += "OBEC RADIM – PŘEHLED ODKAZŮ\n";
out += "Generováno: " + new Date().toISOString() + "\n\n";

const bySection = new Map();

for (const it of items) {
  if (!it.url) continue;
  const section = it.section || "Ostatní";

  if (!bySection.has(section)) bySection.set(section, []);
  bySection.get(section).push(it);
}

for (const [section, list] of bySection) {
  out += "==============================\n";
  out += section.toUpperCase() + "\n";
  out += "==============================\n\n";

  for (const it of list) {
    const title = it.title || "(bez názvu)";
    const url = it.url;
    const archived = it.archived ? " [ARCHIVNÍ]" : "";

    out += `- ${title}\n`;
    out += `  ${url}${archived}\n`;

    if (Array.isArray(it.files) && it.files.length) {
      out += "  Soubory:\n";
      for (const f of it.files) {
        out += `   • ${f.text || "soubor"}: ${f.url}${f.archived ? " [ARCHIVNÍ]" : ""}\n`;
      }
    }

    out += "\n";
  }
}

fs.writeFileSync(OUTPUT, out, "utf8");

console.log("HOTOVO");
console.log("Vytvořen soubor:", OUTPUT);