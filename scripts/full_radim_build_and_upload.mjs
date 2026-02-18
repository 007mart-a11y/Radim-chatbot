import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// ---------- KONFIGURACE ----------
const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const OUT_DIR = "knowledge";
const FULL_FILE = "99_FULL_obec_radim.txt";
const PDF_FILE = "30_PDF_TEXT_obec_radim.txt";

const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

// ---------- POMOCNÉ FUNKCE ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(u, base = SITE_BASE_URL) {
    try {
        const url = new URL(u, base);
        url.hash = "";
        return url.toString();
    } catch { return null; }
}

function cleanText(text) {
    return text.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
}

// ---------- CRAWLER LOGIC ----------
async function crawl() {
    const queue = [SITE_BASE_URL + "/"];
    const visited = new Set();
    const pages = [];
    const docs = new Map();

    console.log("🚀 Startujeme crawl...");

    while (queue.length > 0 && visited.size < 400) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);

        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) continue;

            const html = await res.text();
            const dom = new JSDOM(html);
            const doc = dom.window.document;

            // 1. Vytažení textu (snížený práh na 100 znaků pro krátké info o odpadech)
            const content = cleanText(doc.body.textContent);
            if (content.length > 100) {
                pages.push({ url, title: doc.title, content });
            }

            // 2. Sběr odkazů a PDF
            doc.querySelectorAll("a[href]").forEach(a => {
                const norm = normalizeUrl(a.getAttribute("href"), url);
                if (!norm || !norm.startsWith(SITE_BASE_URL)) return;

                if (norm.toLowerCase().endsWith(".pdf")) {
                    docs.set(norm, { url: norm, title: a.textContent.trim() });
                } else if (!visited.has(norm)) {
                    queue.push(norm);
                }
            });

            if (visited.size % 20 === 0) console.log(`  Prohledáno ${visited.size} stránek...`);
        } catch (e) { console.log(`  ⚠️ Přeskočeno (chyba): ${url}`); }
    }

    // Uložení stránek
    let fullTxt = `FULL CRAWL RADIM - ${new Date().toLocaleDateString()}\n\n`;
    pages.forEach(p => {
        fullTxt += `=== PAGE\nURL: ${p.url}\nTITLE: ${p.title}\nCONTENT:\n${p.content}\n\n`;
    });
    await fs.writeFile(path.join(OUT_DIR, FULL_FILE), fullTxt);

    return Array.from(docs.values());
}

async function processPdfs(docs) {
    console.log(`📄 Zpracovávám ${docs.length} PDF dokumentů...`);
    let pdfTxt = `PDF TEXTY RADIM - AKTUALIZACE ${new Date().toLocaleDateString()}\n\n`;

    for (const d of docs) {
        // Filtrujeme jen důležité (odpady, vyhlášky, pes)
        const lowTitle = d.title.toLowerCase() + d.url.toLowerCase();
        if (!["odpad", "vyhlášk", "pes", "poplat", "sazeb", "ozv"].some(k => lowTitle.includes(k))) continue;

        try {
            const res = await fetch(d.url);
            const buf = Buffer.from(await res.arrayBuffer());
            const data = await pdfParse(buf);
            
            // Rozsekáme text na kusy a ke každému dáme URL (aby AI neztrácela odkaz)
            const text = cleanText(data.text);
            const chunks = text.match(/.{1,2000}/g) || [];
            
            pdfTxt += `=== PDF DOCUMENT\nURL: ${d.url}\nTITLE: ${d.title}\n`;
            chunks.forEach(c => pdfTxt += `[ZDROJ: ${d.url}] ${c}\n`);
            pdfTxt += `\n`;
            console.log(`  ✅ PDF hotovo: ${d.title.slice(0, 30)}...`);
        } catch { console.log(`  ❌ PDF selhalo: ${d.url}`); }
    }
    await fs.writeFile(path.join(OUT_DIR, PDF_FILE), pdfTxt);
}

// ---------- OPENAI OPERACE ----------
async function cleanupStore() {
    console.log("🧹 Čistím Vector Store před nahráním...");
    const res = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER }
    });
    const { data } = await res.json();
    
    for (const file of (data || [])) {
        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${file.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER }
        });
    }
}

async function uploadFile(fileName) {
    const filePath = path.join(OUT_DIR, fileName);
    const stats = await fs.stat(filePath);
    if (stats.size < 500) return; // Prázdné soubory nenahrávat

    const formData = new FormData();
    formData.append("purpose", "assistants");
    formData.append("file", new Blob([await fs.readFile(filePath)]), fileName);

    const res = await fetch("https://api.openai.com/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData
    });
    const file = await res.json();

    await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
        method: "POST",
        headers: { 
            Authorization: `Bearer ${OPENAI_API_KEY}`, 
            "Content-Type": "application/json",
            ...OPENAI_BETA_HEADER 
        },
        body: JSON.stringify({ file_id: file.id })
    });
    console.log(`  ⬆️ Soubor ${fileName} nahrán a připojen.`);
}

// ---------- HLAVNÍ BĚH ----------
async function main() {
    try {
        await fs.mkdir(OUT_DIR, { recursive: true });
        const docs = await crawl();
        await processPdfs(docs);
        await cleanupStore();
        await uploadFile(FULL_FILE);
        await uploadFile(PDF_FILE);
        console.log("✨ Vše hotovo a aktuální!");
    } catch (e) { console.error("💥 Kritická chyba:", e); }
}

main();