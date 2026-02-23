// scripts/full_radim_build_and_upload.mjs
// KOMPLETNÍ AI BUILDER PRO OBEC RADIM (VERZE 2026)

import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// --- KONFIGURACE Z PROSTŘEDÍ ---
const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const MAX_PAGES = 450;
const CONCURRENCY = 3;
const CURRENT_MAX_PDF_TEXT = 15; // Počet nejdůležitějších PDF pro AI analýzu

const OUT_DIR = "knowledge";
const CURRENT_FILE = "10_CURRENT_obec_radim.txt";
const ARCHIVE_FILE = "90_ARCHIVE_INDEX_obec_radim.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- POMOCNÉ FUNKCE ---
function sha1(s) { return crypto.createHash("sha1").update(String(s || "")).digest("hex"); }
function normalizeUrl(url) {
    try {
        const u = new URL(url, SITE_BASE_URL);
        u.hash = "";
        return u.toString();
    } catch { return url; }
}

function classifyDocType(titleOrUrl) {
    const s = (titleOrUrl || "").toLowerCase();
    // Identifikace účetního balastu
    if (s.includes("rozvaha") || s.includes("výkaz zisku") || s.includes("příloha k účetní") || s.includes("hospodaření")) return "BALAST_UCETNI";
    if (s.includes("vyhláška") || s.includes("ozv") || s.includes("nařízení")) return "VYHLÁŠKA";
    if (s.includes("poplatek") || s.includes("odpad") || s.includes("psů") || s.includes("voda")) return "POPLATKY_A_SLUZBY";
    if (s.includes("zpravodaj")) return "ZPRAVODAJ";
    return "DOKUMENT";
}

// --- AI ANALÝZA PŘES OPENAI (GPT-4o-mini) ---
async function getLlmSummary(text, title) {
    if (!OPENAI_API_KEY) return "[AI Summary přeskočeno - chybí API klíč]";
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
                    { role: "system", content: "Jsi analytik dokumentů obce Radim. Z textu PDF vytáhni: 1. Hlavní účel dokumentu, 2. Klíčová data/částky/termíny pro občany (např. výše poplatku, datum splatnosti), 3. Platnost (pro rok 2026?). Piš stručně v odrážkách." },
                    { role: "user", content: `Dokument: ${title}\n\nText: ${text.slice(0, 10000)}` }
                ],
                temperature: 0
            })
        });
        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) {
        return `[Chyba AI analýzy: ${e.message}]`;
    }
}

// --- CRAWLER ---
async function fetchWithTimeout(url, ms = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
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
            console.log(`🔍 Prohledávám: ${url}`);
            const res = await fetchWithTimeout(url);
            if (!res || !res.ok) continue;
            const html = await res.text();
            const dom = new JSDOM(html);
            const doc = dom.window.document;

            doc.querySelectorAll("a[href]").forEach(a => {
                const href = a.getAttribute("href");
                const fullUrl = normalizeUrl(href);
                if (!fullUrl.startsWith(SITE_BASE_URL)) return;

                if (fullUrl.toLowerCase().endsWith(".pdf")) {
                    const title = a.textContent.trim() || path.basename(fullUrl);
                    docs.set(fullUrl, {
                        url: fullUrl,
                        title: title,
                        type: classifyDocType(title + fullUrl)
                    });
                } else if (!seen.has(fullUrl)) {
                    queue.push(fullUrl);
                }
            });

            const title = doc.querySelector("title")?.textContent || "";
            const content = (doc.querySelector("main") || doc.body).textContent;
            pages.push({ url, title, content: content.slice(0, 5000).replace(/\s+/g, ' ') });

        } catch (e) {
            console.error(`❌ Chyba u ${url}: ${e.message}`);
        }
    }
    return { pages, docs: Array.from(docs.values()) };
}

// --- OPENAI UPLOAD & CLEANUP ---
async function syncWithOpenAI(currentPath, archivePath) {
    if (!OPENAI_API_KEY || !VECTOR_STORE_ID) return console.log("⚠️ Chybí API/VectorID, nahrávání zrušeno.");
    const headers = { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" };

    console.log("☁️ Synchronizace s OpenAI Vector Store...");

    const filesResponse = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { headers });
    const storeFiles = await filesResponse.json();

    for (const f of storeFiles.data || []) {
        const meta = await fetch(`https://api.openai.com/v1/files/${f.id}`, { headers }).then(r => r.json());
        if (meta.filename?.includes("10_CURRENT") || meta.filename?.includes("90_ARCHIVE")) {
            console.log(`🗑️ Mažu starý soubor: ${meta.filename}`);
            await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${f.id}`, { method: "DELETE", headers });
        }
    }

    const upload = async (filePath) => {
        const formData = new FormData();
        formData.append("purpose", "assistants");
        formData.append("file", new Blob([await fs.readFile(filePath)]), path.basename(filePath));
        const fileObj = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: formData }).then(r => r.json());
        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileObj.id }) });
        console.log(`✅ Nahráno: ${path.basename(filePath)}`);
    };

    await upload(currentPath);
    await upload(archivePath);
}

// --- HLAVNÍ FUNKCE ---
async function main() {
    console.log("🚀 START RADIM AI BUILDER 2026");
    const { pages, docs } = await startCrawl();

    const currentYear = "2026";
    // Prioritizujeme rok 2026 a důležité typy, vynecháme účetní balast
    const priorityDocs = docs.filter(d => 
        (d.title.includes(currentYear) || d.type === "VYHLÁŠKA" || d.type === "POPLATKY_A_SLUZBY") && 
        d.type !== "BALAST_UCETNI"
    );

    let currentTxt = `ZDROJ DAT PRO AI ASISTENTA RADIM - AKTUALIZACE 2026\n\n`;
    currentTxt += `### SEKCE 1: HLAVNÍ VYHLÁŠKY A DOKUMENTY (ANALYZA OBSAHU)\n`;

    for (const d of priorityDocs.slice(0, CURRENT_MAX_PDF_TEXT)) {
        console.log(`📝 Analyzuji PDF přes AI: ${d.title}`);
        try {
            const res = await fetch(d.url);
            const pdfData = await pdfParse(Buffer.from(await res.arrayBuffer()));
            const summary = await getLlmSummary(pdfData.text, d.title);
            currentTxt += `\nTITUL: ${d.title}\nTYP: ${d.type}\nURL: ${d.url}\nSHRNUTÍ PRO OBČANY:\n${summary}\n------------------\n`;
            await sleep(400); 
        } catch (e) {
            currentTxt += `\nTITUL: ${d.title}\nURL: ${d.url}\n[Obsah PDF nelze načíst]\n`;
        }
    }

    currentTxt += `\n### SEKCE 2: AKTUÁLNÍ STRÁNKY WEBU\n`;
    pages.slice(0, 50).forEach(p => {
        currentTxt += `STRÁNKA: ${p.title}\nURL: ${p.url}\nTEXT: ${p.content.slice(0, 400)}...\n\n`;
    });

    let archiveTxt = `INDEX ARCHIVNÍCH A ÚČETNÍCH DOKUMENTŮ\n\n`;
    docs.filter(d => d.type === "BALAST_UCETNI" || !priorityDocs.includes(d)).forEach(d => {
        archiveTxt += `- ${d.title} | TYP: ${d.type} | URL: ${d.url}\n`;
    });

    await fs.mkdir(OUT_DIR, { recursive: true });
    const curPath = path.join(OUT_DIR, CURRENT_FILE);
    const arcPath = path.join(OUT_DIR, ARCHIVE_FILE);
    
    await fs.writeFile(curPath, currentTxt);
    await fs.writeFile(arcPath, archiveTxt);

    console.log("💾 Soubory uloženy na disk.");
    await syncWithOpenAI(curPath, arcPath);
    console.log("🎯 VŠE HOTOVO.");
}

main().catch(console.error);