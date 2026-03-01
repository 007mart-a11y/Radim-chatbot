import fs from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? "https://www.obec-radim.cz").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

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
                    { role: "system", content: "Jsi analytik. Vytáhni z tohoto dokumentu klíčová pravidla, poplatky a roky. Zaměř se hlavně na částky a povinnosti." },
                    { role: "user", content: `Název: ${title}\nText: ${text.slice(0, 8000)}` }
                ],
                temperature: 0
            })
        });
        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) { return `[Chyba analýzy PDF]`; }
}

// 🧠 MEGA-EXTRAKCE: Náš nový "Zlatý důl" na data
async function extractMegaFacts(pages) {
    console.log("🧠 MEGA-EXTRAKCE: Skenuji úřad, spolky a ceníky pro dokonalou databázi...");
    if (!OPENAI_API_KEY) return;
    
    // Filtrujeme jen stránky, kde je šance na reálná tvrdá data (žádné aktuality a fotogalerie)
    const relevantPages = pages.filter(p => 
        p.url.includes('/urad/') || 
        p.url.includes('/organizace-a-spolky/') || 
        p.url.includes('/kontakt') || 
        p.url === SITE_BASE_URL
    );

    let combinedText = relevantPages.map(p => `--- STRÁNKA: ${p.title} ---\n${p.content}`).join("\n\n");
    // Ořízneme to na 80 000 znaků, ať to LLM zvládne chroustat rychle a levně
    if (combinedText.length > 80000) combinedText = combinedText.slice(0, 80000);

    const systemPrompt = `Jsi špičkový datový analytik. Tvým úkolem je vytěžit z dodaného textu webu obce Radim detailní databázi.
Vrať POUZE validní JSON přesně v této struktuře:
{
  "vedeni_obce_a_urad": [
    {"jmeno": "...", "funkce": "...", "telefon": "...", "email": "..."}
  ],
  "spolky_a_organizace": [
    {"nazev_spolku": "...", "vedeni_nebo_kontakt": "...", "poznamka_nebo_zamereni": "..."}
  ],
  "sluzby_ceniky_pronajmy": [
    {"sluzba_nebo_poplatek": "...", "cena_nebo_vyse": "...", "spravce_kontakt": "..."}
  ]
}
PRAVIDLA:
1. Vyhledej všechny kontakty na úřad, starostu, hasiče, sokol, kroužky atd.
2. Speciálně vyhledej informace o PRONÁJMU HALY (kdo ji spravuje, telefon, cena).
3. Pokud najdeš poplatky (pes, odpad), vlož je do sluzby_ceniky_pronajmy.
4. Co nenajdeš, nevyplňuj, nevymýšlej si.`;

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: combinedText }
                ],
                temperature: 0.1
            })
        });
        const json = await response.json();
        const facts = json.choices[0].message.content;
        
        await fs.mkdir("netlify/functions", { recursive: true });
        await fs.writeFile("netlify/functions/core_facts.json", facts);
        console.log("✅ Mega-databáze úspěšně vytvořena a uložena do core_facts.json!");
    } catch (e) { console.error("❌ Chyba MEGA-extrakce:", e.message); }
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
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("text/html")) continue;

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
            
            if (content.length > 20000) content = content.slice(0, 20000) + " ... [ZBYTEK ZKRÁCEN]";
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
        console.log(`📤 Nahrávám Vector Store: ${path.basename(filePath)}...`);
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
    console.log("🚀 STARTUJE HYBRIDNÍ CRAWL...");
    let { pages, docs } = await startCrawl();
    
    // Tady proběhne ta magie s těžbou kontaktů a ceníků!
    await extractMegaFacts(pages);

    docs.sort((a, b) => {
        const getYear = (str) => { const m = str.match(/(20\d{2})/); return m ? parseInt(m[1]) : 0; };
        const yearA = Math.max(getYear(a.title), getYear(a.url));
        const yearB = Math.max(getYear(b.title), getYear(b.url));
        const isVyhlaskaA = a.title.toLowerCase().includes('vyhl') || a.title.toLowerCase().includes('narizeni');
        const isVyhlaskaB = b.title.toLowerCase().includes('vyhl') || b.title.toLowerCase().includes('narizeni');
        let scoreA = yearA + (isVyhlaskaA && yearA >= 2023 ? 10000 : 0);
        let scoreB = yearB + (isVyhlaskaB && yearB >= 2023 ? 10000 : 0);
        return scoreB - scoreA; 
    });
    
    let currentTxt = `EXPERTNÍ ZNALOSTNÍ BÁZE OBCE RADIM\nAKTUALIZACE: ${new Date().toLocaleDateString()}\n\n`;
    currentTxt += `==================================================\n### SEKCE 1: DŮLEŽITÉ VYHLÁŠKY A DOKUMENTY\n==================================================\n\n`;
    for (const d of docs.slice(0, CURRENT_MAX_PDF_TEXT)) {
        try {
            const res = await fetch(d.url);
            const pdfData = await pdfParse(Buffer.from(await res.arrayBuffer()));
            const summary = await getLlmSummary(pdfData.text, d.title);
            currentTxt += `[ZAČÁTEK DOKUMENTU]\nNÁZEV: ${d.title}\nODKAZ: ${d.url}\nOBSAH A PRAVIDLA:\n${summary}\n[KONEC DOKUMENTU]\n\n`;
            await sleep(300);
        } catch (e) { }
    }

    currentTxt += `==================================================\n### SEKCE 2: KOMPLETNÍ OBSAH WEBU A NAVIGACE\n==================================================\n\n`;
    pages.slice(0, CURRENT_MAX_PAGES_TO_STORE).forEach(p => {
        currentTxt += `[ZAČÁTEK STRÁNKY]\nNÁZEV: ${p.title}\nODKAZ: ${p.url}\nOBSAH:\n${p.content}\n[KONEC STRÁNKY]\n\n`;
    });

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, CURRENT_FILE), currentTxt);
    await fs.writeFile(path.join(OUT_DIR, ARCHIVE_FILE), docs.map(d => `${d.title}: ${d.url}`).join("\n"));

    console.log("🔄 Synchronizuji s OpenAI Vector Store...");
    await syncWithOpenAI(path.join(OUT_DIR, CURRENT_FILE), path.join(OUT_DIR, ARCHIVE_FILE));
    console.log("🎯 HOTOVO.");
}

main().catch(console.error);