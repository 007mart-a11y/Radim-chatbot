import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

// BEZPEČNÉ LIMITY
const MAX_PAGES = 350; 
const CURRENT_MAX_PAGES_TO_STORE = 350; 
const CURRENT_MAX_PDF_TEXT = 40;

const OUT_DIR = "knowledge";
const CURRENT_FILE = "10_CURRENT_obec_radim.txt";
const ARCHIVE_FILE = "90_ARCHIVE_INDEX_obec_radim.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(url) {
    try {
        const u = new URL(url, SITE_BASE_URL);
        u.hash = "";
        if (u.search.includes('ftresult')) u.search = ""; 
        
        // ZAKÁZANÉ PŘÍPONY - ochrání před stahováním "bordelu" a obřích souborů
        const ext = u.pathname.split('.').pop().toLowerCase();
        const badExts = ['zip', 'rar', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'gif', 'mp4'];
        if (badExts.includes(ext)) return null; 

        return u.toString();
    } catch (e) { return null; }
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
                    { role: "system", content: "Jsi právní a datový analytik obce. Z tohoto dokumentu (zejména pokud jde o vyhlášku či nařízení) vytáhni to hlavní, o čem je, klíčová pravidla, poplatky a roky." },
                    { role: "user", content: `Název: ${title}\nText: ${text.slice(0, 8000)}` }
                ],
                temperature: 0
            })
        });
        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) { return `[Chyba analýzy PDF]`; }
}

async function startCrawl() {
    const queue = [SITE_BASE_URL];
    const seen = new Set();
    const pages = [];
    const docs = new Map();

    while (queue.length > 0 && pages.length < MAX_PAGES) {
        const url = queue.shift();
        if (!url || seen.has(url)) continue;
        seen.add(url);

        try {
            const res = await fetch(url);
            
            // TVRDÝ MANTINEL: Zpracujeme jen to, co je skutečně HTML stránka (nebo PDF přeskočíme k pozdější analýze)
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("text/html")) {
                continue;
            }

            console.log(`🔍 Crawl: ${url}`);
            const html = await res.text();
            const dom = new JSDOM(html);
            const doc = dom.window.document;

            doc.querySelectorAll("a[href]").forEach(a => {
                const href = a.getAttribute("href");
                const fullUrl = normalizeUrl(href);
                if (!fullUrl || !fullUrl.startsWith(SITE_BASE_URL)) return;

                if (fullUrl.includes('evt_image.php') || fullUrl.includes('fotogalerie')) return;

                if (fullUrl.toLowerCase().endsWith(".pdf")) {
                    docs.set(fullUrl, { url: fullUrl, title: a.textContent.trim() || path.basename(fullUrl) });
                } else if (!seen.has(fullUrl)) {
                    queue.push(fullUrl);
                }
            });

            doc.querySelectorAll("script, style, nav, footer, .menu, .footer, iframe").forEach(el => el.remove());
            doc.querySelectorAll("p, div, h1, h2, h3, h4, li, br").forEach(el => el.insertAdjacentHTML('afterend', ' '));

            const title = doc.querySelector("title")?.textContent.replace(/\s+/g, ' ').trim() || "";
            let content = (doc.querySelector("main") || doc.body).textContent.replace(/\s+/g, ' ').trim();
            
            // MANTINEL: Oříznutí extrémně dlouhých textů (zabrání obřím souborům)
            if (content.length > 20000) {
                content = content.slice(0, 20000) + " ... [ZBYTEK STRÁNKY ZKRÁCEN]";
            }

            if (content.length > 50) pages.push({ url, title, content });

        } catch (e) { console.error(`❌ Error ${url}: ${e.message}`); }
    }
    return { pages, docs: Array.from(docs.values()) };
}

async function syncWithOpenAI(currentPath, archivePath) {
    if (!OPENAI_API_KEY || !VECTOR_STORE_ID) return;
    const headers = { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" };

    const vsRes = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { headers });
    const storeFiles = await vsRes.json();

    for (const f of storeFiles.data || []) {
        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${f.id}`, { method: "DELETE", headers });
        await fetch(`https://api.openai.com/v1/files/${f.id}`, { method: "DELETE", headers }); 
    }

    const upload = async (filePath) => {
        console.log(`📤 Nahrávám: ${path.basename(filePath)}...`);
        const formData = new FormData();
        formData.append("purpose", "assistants");
        formData.append("file", new Blob([await fs.readFile(filePath)], { type: "text/plain" }), path.basename(filePath));

        const uploadRes = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: formData });
        const fileObj = await uploadRes.json();

        await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileObj.id }) });
    };

    await upload(currentPath);
    await upload(archivePath);
}

async function main() {
    console.log("🚀 STARTUJE CHYTRÝ CRAWL S OCHRANOU PROTI BORDELU...");
    let { pages, docs } = await startCrawl();
    
    // 🧠 CHYTRÉ ŘAZENÍ PDF: VYHLÁŠKY A ROKY 2023-2026 MAJÍ ABSOLUTNÍ PŘEDNOST
    docs.sort((a, b) => {
        const getYear = (str) => { const m = str.match(/(20\d{2})/); return m ? parseInt(m[1]) : 0; };
        const yearA = Math.max(getYear(a.title), getYear(a.url));
        const yearB = Math.max(getYear(b.title), getYear(b.url));
        
        const isVyhlaskaA = a.title.toLowerCase().includes('vyhl') || a.title.toLowerCase().includes('narizeni');
        const isVyhlaskaB = b.title.toLowerCase().includes('vyhl') || b.title.toLowerCase().includes('narizeni');

        let scoreA = yearA;
        if (isVyhlaskaA && yearA >= 2023) scoreA += 10000; // Brutální priorita pro vyhlášky od 2023

        let scoreB = yearB;
        if (isVyhlaskaB && yearB >= 2023) scoreB += 10000;

        return scoreB - scoreA; 
    });
    
    let currentTxt = `EXPERTNÍ ZNALOSTNÍ BÁZE OBCE RADIM\nAKTUALIZACE: ${new Date().toLocaleDateString()}\n\n`;
    
    currentTxt += `==================================================\n### SEKCE 1: DŮLEŽITÉ VYHLÁŠKY A DOKUMENTY\n==================================================\n\n`;
    for (const d of docs.slice(0, CURRENT_MAX_PDF_TEXT)) {
        console.log(`📝 Analýza PDF: ${d.title}`);
        try {
            const res = await fetch(d.url);
            const pdfData = await pdfParse(Buffer.from(await res.arrayBuffer()));
            const summary = await getLlmSummary(pdfData.text, d.title);
            currentTxt += `[ZAČÁTEK DOKUMENTU]\nNÁZEV: ${d.title}\nODKAZ: ${d.url}\nOBSAH A PRAVIDLA:\n${summary}\n[KONEC DOKUMENTU]\n\n`;
            await sleep(300);
        } catch (e) { console.log("PDF skip"); }
    }

    currentTxt += `==================================================\n### SEKCE 2: KOMPLETNÍ OBSAH WEBU A NAVIGACE\n==================================================\n\n`;
    pages.slice(0, CURRENT_MAX_PAGES_TO_STORE).forEach(p => {
        currentTxt += `[ZAČÁTEK STRÁNKY]\nNÁZEV: ${p.title}\nODKAZ: ${p.url}\nOBSAH:\n${p.content}\n[KONEC STRÁNKY]\n\n`;
    });

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, CURRENT_FILE), currentTxt);
    await fs.writeFile(path.join(OUT_DIR, ARCHIVE_FILE), docs.map(d => `${d.title}: ${d.url}`).join("\n"));

    console.log("🔄 Synchronizuji čistá data s OpenAI...");
    await syncWithOpenAI(path.join(OUT_DIR, CURRENT_FILE), path.join(OUT_DIR, ARCHIVE_FILE));
    console.log("🎯 HOTOVO. ASISTENT JE PLNĚ NABITÝ ČISTÝMI DATY.");
}

main().catch(console.error);