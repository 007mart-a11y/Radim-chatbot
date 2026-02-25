import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

// MAXIMÁLNÍ HLOUBKA A ŠÍŘKA (stažení celého webu)
const MAX_PAGES = 1000; 
const CURRENT_MAX_PAGES_TO_STORE = 1000; 
const CURRENT_MAX_PDF_TEXT = 50;

const OUT_DIR = "knowledge";
const CURRENT_FILE = "10_CURRENT_obec_radim.txt";
const ARCHIVE_FILE = "90_ARCHIVE_INDEX_obec_radim.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(url) {
    try {
        const u = new URL(url, SITE_BASE_URL);
        u.hash = "";
        // Odstranění zbytečných parametrů řazení, ať nečteme stejnou stránku 10x
        if (u.search.includes('ftresult')) u.search = ""; 
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
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Jsi datový analytik. Tvým úkolem je z tohoto PDF vytáhnout přesná fakta, čísla a kontakty. Buď absolutně věcný." },
                    { role: "user", content: `Název dokumentu: ${title}\n\nText dokumentu: ${text.slice(0, 8000)}` }
                ],
                temperature: 0
            })
        });
        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) {
        return `[Chyba analýzy PDF]`;
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

            // 1. ZÍSKÁNÍ ODKAZŮ PŘED SMAZÁNÍM MENU (aby se dostal všude)
            doc.querySelectorAll("a[href]").forEach(a => {
                const href = a.getAttribute("href");
                const fullUrl = normalizeUrl(href);
                if (!fullUrl.startsWith(SITE_BASE_URL)) return;

                // Ignorujeme balastní stránky
                if (fullUrl.includes('evt_image.php') || fullUrl.includes('fotogalerie')) return;

                if (fullUrl.toLowerCase().endsWith(".pdf")) {
                    docs.set(fullUrl, { url: fullUrl, title: a.textContent.trim() || path.basename(fullUrl) });
                } else if (!seen.has(fullUrl)) {
                    queue.push(fullUrl);
                }
            });

            // 2. VYČIŠTĚNÍ BALASTU A ROZŘEZÁNÍ BLOKŮ (ochrana proti slepení textu)
            doc.querySelectorAll("script, style, nav, footer, .menu, .footer, iframe").forEach(el => el.remove());
            // Přidáme mezery za nadpisy a odstavce, aby se slova neslepila k sobě
            doc.querySelectorAll("p, div, h1, h2, h3, h4, li, br").forEach(el => el.insertAdjacentHTML('afterend', ' '));

            const title = doc.querySelector("title")?.textContent.replace(/\s+/g, ' ').trim() || "";
            const content = (doc.querySelector("main") || doc.body).textContent.replace(/\s+/g, ' ').trim();
            
            // Uložíme jen stránky, které mají nějaký skutečný text (delší než 50 znaků)
            if (content.length > 50) {
                pages.push({ url, title, content });
            }

        } catch (e) {
            console.error(`❌ Error ${url}: ${e.message}`);
        }
    }
    return { pages, docs: Array.from(docs.values()) };
}

async function syncWithOpenAI(currentPath, archivePath) {
    if (!OPENAI_API_KEY || !VECTOR_STORE_ID) {
        console.log("⚠️ Chybí OPENAI_API_KEY nebo VECTOR_STORE_ID.");
        return;
    }
    const headers = { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" };

    console.log("🔍 Kontroluji staré soubory ve Vector Store...");
    const vsRes = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { headers });
    const storeFiles = await vsRes.json();

    // Smazání všech starých souborů
    for (const f of storeFiles.data || []) {
        console.log(`🗑️ Odstraňuji starý soubor ${f.id}...`);
        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${f.id}`, { method: "DELETE", headers });
        await fetch(`https://api.openai.com/v1/files/${f.id}`, { method: "DELETE", headers }); 
    }

    const upload = async (filePath) => {
        console.log(`📤 Nahrávám strukturovaný soubor: ${path.basename(filePath)}...`);
        const formData = new FormData();
        formData.append("purpose", "assistants");
        const fileContent = await fs.readFile(filePath);
        formData.append("file", new Blob([fileContent], { type: "text/plain" }), path.basename(filePath));

        const uploadRes = await fetch("https://api.openai.com/v1/files", {
            method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: formData
        });
        const fileObj = await uploadRes.json();

        console.log(`✅ Nahráno (ID: ${fileObj.id}). Připojuji do Vector Store...`);
        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ file_id: fileObj.id })
        });
    };

    await upload(currentPath);
    await upload(archivePath);
}

async function main() {
    console.log("🚀 STARTUJE STRUKTUROVANÝ CRAWL. Tohle vytáhne všechno...");
    const { pages, docs } = await startCrawl();
    
    // Začátek strukturovaného souboru pro dokonalou AI orientaci
    let currentTxt = `EXPERTNÍ ZNALOSTNÍ BÁZE OBCE RADIM\nAKTUALIZACE: ${new Date().toLocaleDateString()}\n`;
    currentTxt += `Tento dokument obsahuje strukturovaná data z oficiálního webu obce. Každá sekce má jasně danou URL adresu pro citaci.\n\n`;
    currentTxt += `==================================================\n`;
    currentTxt += `### SEKCE 1: DŮLEŽITÉ DOKUMENTY A VYHLÁŠKY\n`;
    currentTxt += `==================================================\n\n`;

    for (const d of docs.slice(0, CURRENT_MAX_PDF_TEXT)) {
        console.log(`📝 Analýza PDF: ${d.title}`);
        try {
            const res = await fetch(d.url);
            const pdfData = await pdfParse(Buffer.from(await res.arrayBuffer()));
            const summary = await getLlmSummary(pdfData.text, d.title);
            currentTxt += `[ZAČÁTEK DOKUMENTU]\nNÁZEV: ${d.title}\nODKAZ: ${d.url}\nOBSAH/SHRNUTÍ:\n${summary}\n[KONEC DOKUMENTU]\n\n`;
            await sleep(300);
        } catch (e) { console.log("PDF skip"); }
    }

    currentTxt += `==================================================\n`;
    currentTxt += `### SEKCE 2: KOMPLETNÍ OBSAH WEBU A NAVIGACE\n`;
    currentTxt += `==================================================\n\n`;

    pages.slice(0, CURRENT_MAX_PAGES_TO_STORE).forEach(p => {
        currentTxt += `[ZAČÁTEK STRÁNKY]\nNÁZEV: ${p.title}\nODKAZ: ${p.url}\nOBSAH:\n${p.content}\n[KONEC STRÁNKY]\n\n`;
    });

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, CURRENT_FILE), currentTxt);
    await fs.writeFile(path.join(OUT_DIR, ARCHIVE_FILE), docs.map(d => `${d.title}: ${d.url}`).join("\n"));

    console.log("🔄 Synchronizuji perfektně strukturovaná data s OpenAI...");
    await syncWithOpenAI(path.join(OUT_DIR, CURRENT_FILE), path.join(OUT_DIR, ARCHIVE_FILE));
    console.log("🎯 HOTOVO. ASISTENT MÁ TEĎ V HLAVĚ CELÝ WEB S DOKONALOU STRUKTUROU A ODKAZY.");
}

main().catch(console.error);