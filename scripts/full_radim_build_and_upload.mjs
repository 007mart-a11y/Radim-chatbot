import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const OUT_DIR = "knowledge";
const FULL_FILE = "99_FULL_obec_radim.txt";
const PDF_FILE = "30_PDF_TEXT_obec_radim.txt";

const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

// Slova v URL, která okamžitě přeskakujeme (šetří stovky MB)
const FORBIDDEN = ['fotogalerie', 'foto', 'kalendar', 'ax_kalendar', 'rajce.idnes', 'zmena-vzhledu', 'struktura-stranek', 'anketa'];

const clean = (t) => t.replace(/\s\s+/g, ' ').replace(/\n+/g, '\n').trim();

async function cleanupStore() {
    console.log(`🧹 Čistím OpenAI úložiště...`);
    try {
        const res = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER }
        });
        const json = await res.json();
        for (const file of (json.data || [])) {
            await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${file.id}`, {
                method: "DELETE", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...OPENAI_BETA_HEADER }
            });
            await fetch(`https://api.openai.com/v1/files/${file.id}`, {
                method: "DELETE", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
            });
        }
    } catch (e) { console.error("Chyba při mazání:", e.message); }
}

async function upload(fileName) {
    const filePath = path.join(OUT_DIR, fileName);
    const formData = new FormData();
    formData.append("purpose", "assistants");
    formData.append("file", new Blob([await fs.readFile(filePath)]), fileName);
    
    const res = await fetch("https://api.openai.com/v1/files", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: formData
    });
    const file = await res.json();
    await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", ...OPENAI_BETA_HEADER },
        body: JSON.stringify({ file_id: file.id })
    });
    console.log(`✅ ${fileName} nahrán.`);
}

async function crawl() {
    const queue = [SITE_BASE_URL + "/"];
    const visited = new Set();
    const pdfs = new Map();
    let content = `OBEC RADIM - DATA ${new Date().toLocaleDateString()}\n`;

    console.log("🚀 Startuju inteligentní crawl...");

    while (queue.length > 0 && visited.size < 100) { // Max 100 stránek stačí na vše podstatné
        const url = queue.shift();
        if (visited.has(url) || url.includes('#') || FORBIDDEN.some(w => url.toLowerCase().includes(w))) continue;
        visited.add(url);

        try {
            const res = await fetch(url);
            const contentType = res.headers.get("content-type");
            if (!contentType || !contentType.includes("text/html")) continue;

            const html = await res.text();
            if (html.length > 300000) continue; // Ignoruj obří stránky (balast)

            const dom = new JSDOM(html);
            const doc = dom.window.document;

            // Odstranění technického smetí
            doc.querySelectorAll("script, style, nav, footer, header, .menu, .sidebar, .calendar, #kal_table, .noprint").forEach(el => el.remove());
            
            const main = doc.querySelector("#content, #main, article") || doc.body;
            const txt = clean(main.textContent);

            if (txt.length > 100) {
                content += `\n\n[ZDROJ: ${url}]\n${txt}\n---`;
                console.log(`  📄 OK: ${url}`);
            }

            doc.querySelectorAll("a[href]").forEach(a => {
                const href = a.getAttribute("href");
                if (!href) return;
                const norm = new URL(href, url).toString().split('#')[0];
                if (norm.startsWith(SITE_BASE_URL)) {
                    if (norm.toLowerCase().endsWith(".pdf")) pdfs.set(norm, a.textContent.trim());
                    else if (!visited.has(norm)) queue.push(norm);
                }
            });
        } catch (e) { console.log(`  ⚠️ Chyba na: ${url}`); }
    }
    await fs.writeFile(path.join(OUT_DIR, FULL_FILE), content);
    return Array.from(pdfs.entries());
}

async function processPdfs(docs) {
    let pdfContent = "TEXTY Z PDF DOKUMENTŮ\n";
    for (const [url, title] of docs) {
        try {
            const res = await fetch(url);
            const data = await pdfParse(Buffer.from(await res.arrayBuffer()));
            pdfContent += `\n\n[PDF: ${title} | ${url}]\n${clean(data.text)}\n---`;
            console.log(`  📎 PDF: ${url.split('/').pop()}`);
        } catch (e) { }
    }
    await fs.writeFile(path.join(OUT_DIR, PDF_FILE), pdfContent);
}

async function main() {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const pdfs = await crawl();
    await processPdfs(pdfs);
    await cleanupStore();
    await upload(FULL_FILE);
    await upload(PDF_FILE);
    console.log("✨ HOTOVO. Teď to bude fungovat.");
}

main().catch(console.error);