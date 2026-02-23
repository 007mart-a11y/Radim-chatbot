import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const MAX_PAGES = 300; 
const CURRENT_MAX_PAGES_TO_STORE = 150; 
const CURRENT_MAX_PDF_TEXT = 20;

const OUT_DIR = "knowledge";
const CURRENT_FILE = "10_CURRENT_obec_radim.txt";
const ARCHIVE_FILE = "90_ARCHIVE_INDEX_obec_radim.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(url) {
    try {
        const u = new URL(url, SITE_BASE_URL);
        u.hash = "";
        return u.toString();
    } catch (e) {
        return url;
    }
}

async function getLlmSummary(text, title) {
    if (!OPENAI_API_KEY) return "[AI Summary přeskočeno]";
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Authorization": `Bearer ${OPENAI_API_KEY}` 
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Jsi expert na obec Radim. Vytáhni fakta, jména, částky a termíny. Piš stručně." },
                    { role: "user", content: `Dokument: ${title}\nText: ${text.slice(0, 8000)}` }
                ],
                temperature: 0
            })
        });
        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) {
        return `[Chyba analýzy]`;
    }
}

async function startCrawl() {
    const queue = [normalizeUrl(SITE_BASE_URL)];
    const seen = new Set();
    const pages = [];
    const docs = new Map();

    while (queue.length > 0 && pages.length < MAX_PAGES) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);

        try {
            console.log(`🔍 Crawl: ${url}`);
            const res = await fetch(url);
            const html = await res.text();
            const dom = new JSDOM(html);
            const doc = dom.window.document;

            // Odstranění balastu (menu, patičky atd.)
            doc.querySelectorAll("script, style, nav, footer, .menu, .footer").forEach(el => el.remove());

            doc.querySelectorAll("a[href]").forEach(a => {
                const href = a.getAttribute("href");
                const fullUrl = normalizeUrl(href);
                if (!fullUrl.startsWith(SITE_BASE_URL)) return;

                if (fullUrl.toLowerCase().endsWith(".pdf")) {
                    docs.set(fullUrl, { url: fullUrl, title: a.textContent.trim() || path.basename(fullUrl) });
                } else if (!seen.has(fullUrl)) {
                    queue.push(fullUrl);
                }
            });

            const title = doc.querySelector("title")?.textContent || "";
            const content = (doc.querySelector("main") || doc.body).textContent.replace(/\s+/g, ' ').trim();
            pages.push({ url, title, content });

        } catch (e) {
            console.error(`❌ Error ${url}: ${e.message}`);
        }
    }
    return { pages, docs: Array.from(docs.values()) };
}

async function syncWithOpenAI(currentPath, archivePath) {
    if (!OPENAI_API_KEY || !VECTOR_STORE_ID) return;
    const headers = { 
        "Authorization": `Bearer ${OPENAI_API_KEY}`, 
        "OpenAI-Beta": "assistants=v2" 
    };

    const filesResponse = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { headers });
    const storeFiles = await filesResponse.json();

    for (const f of storeFiles.data || []) {
        const meta = await fetch(`https://api.openai.com/v1/files/${f.id}`, { headers }).then(r => r.json());
        if (meta.filename?.includes("10_CURRENT") || meta.filename?.includes("90_ARCHIVE")) {
            await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${f.id}`, { method: "DELETE", headers });
        }
    }

    const upload = async (filePath) => {
        const formData = new FormData();
        formData.append("purpose", "assistants");
        const fileData = await fs.readFile(filePath);
        formData.append("file", new Blob([fileData]), path.basename(filePath));

        const fileObj = await fetch("https://api.openai.com/v1/files", { 
            method: "POST", 
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, 
            body: formData 
        }).then(r => r.json());

        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { 
            method: "POST", 
            headers: { ...headers, "Content-Type": "application/json" }, 
            body: JSON.stringify({ file_id: fileObj.id }) 
        });
    };

    await upload(currentPath);
    await upload(archivePath);
}

async function main() {
    const { pages, docs } = await startCrawl();
    let currentTxt = `EXPERTNÍ ZNALOSTNÍ BÁZE OBCE RADIM - AKTUALIZACE ${new Date().toLocaleDateString()}\n\n`;

    currentTxt += `### SEKCE 1: DŮLEŽITÉ DOKUMENTY A VYHLÁŠKY\n`;
    for (const d of docs.slice(0, CURRENT_MAX_PDF_TEXT)) {
        console.log(`📝 Analýza PDF: ${d.title}`);
        try {
            const res = await fetch(d.url);
            const pdfData = await pdfParse(Buffer.from(await res.arrayBuffer()));
            const summary = await getLlmSummary(pdfData.text, d.title);
            currentTxt += `DOKUMENT: ${d.title}\nZDROJ: ${d.url}\nSHRNUTÍ: ${summary}\n---\n`;
            await sleep(300);
        } catch (e) {
            console.log("PDF skip");
        }
    }

    currentTxt += `\n### SEKCE 2: OBSAH WEBU A NAVIGACE\n`;
    pages.slice(0, CURRENT_MAX_PAGES_TO_STORE).forEach(p => {
        currentTxt += `TÉMA: ${p.title}\nADRESA: ${p.url}\nTEXT: ${p.content.slice(0, 1500)}\n---\n`;
    });

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, CURRENT_FILE), currentTxt);
    await fs.writeFile(path.join(OUT_DIR, ARCHIVE_FILE), docs.map(d => `${d.title}: ${d.url}`).join("\n"));

    await syncWithOpenAI(path.join(OUT_DIR, CURRENT_FILE), path.join(OUT_DIR, ARCHIVE_FILE));
    console.log("🎯 HOTOVO. ASISTENT JE AKTUALIZOVÁN.");
}

main().catch(console.error);