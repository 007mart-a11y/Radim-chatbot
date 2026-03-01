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

// 🧠 CHIRURGICKÁ EXTRAKCE: Stránka po stránce (100% spolehlivost)
async function extractMegaFacts(pages) {
    console.log("\n🧠 CHIRURGICKÁ EXTRAKCE: Procházím web STRÁNKU PO STRÁNCE.");
    console.log("Tohle chvíli zabere, ale zaručí to, že nám už žádný Karban ani ceník neuteče...\n");
    if (!OPENAI_API_KEY) return;
    
    // Zúžíme to jen na stránky, které mají v URL kontakt, úřad, spolky, služby, areál atd.
    const relevantPages = pages.filter(p => 
        p.url.includes('/urad/') || 
        p.url.includes('/organizace-a-spolky/') || 
        p.url.includes('/sluzby') ||
        p.url.includes('/kontakt') ||
        p.url === SITE_BASE_URL
    );

    let allFacts = { vedeni_obce_a_urad: [], spolky_a_organizace: [], sluzby_ceniky_pronajmy: [] };

    const systemPrompt = `Jsi pečlivý datový analytik. Tvojí jedinou prací je přečíst text konkrétní stránky a vytáhnout z něj TVRDÁ DATA.
Vrať POUZE validní JSON s klíči (všechny musí být pole objektů):
{
  "vedeni_obce_a_urad": [{"jmeno": "...", "funkce": "...", "telefon": "...", "email": "..."}],
  "spolky_a_organizace": [{"nazev_spolku": "...", "vedeni_nebo_kontakt": "...", "poznamka": "..."}],
  "sluzby_ceniky_pronajmy": [{"sluzba_nebo_areal": "...", "cena_nebo_poplatek": "...", "spravce_kontakt": "..."}]
}
PRAVIDLA:
1. Hledej jména, telefony, ceny pronájmů (hala, hřiště, klubovna), poplatky (pes, odpad), úřední hodiny.
2. Pokud najdeš správce (např. Lukáš Karban), zapiš ho i s telefonem k dané službě/areálu.
3. Pokud na stránce žádná taková data nejsou, vrať prostě prázdná pole. Nevymýšlej si.`;

    // Projedeme relevantní stránky jednu po druhé
    for (const page of relevantPages) {
        if (page.content.length < 150) continue; // Ignorujeme prázdné stránky
        
        console.log(`   ⏳ Doluji data ze stránky: ${page.title}`);
        try {
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    response_format: { type: "json_object" },
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: `Stránka: ${page.title}\nText:\n${page.content.slice(0, 4000)}` }
                    ],
                    temperature: 0
                })
            });
            
            const json = await response.json();
            const extracted = JSON.parse(json.choices[0].message.content);
            
            // Bezpečné sloučení dat (pokud to OpenAI vrátilo jako pole)
            if (Array.isArray(extracted.vedeni_obce_a_urad)) allFacts.vedeni_obce_a_urad.push(...extracted.vedeni_obce_a_urad);
            if (Array.isArray(extracted.spolky_a_organizace)) allFacts.spolky_a_organizace.push(...extracted.spolky_a_organizace);
            if (Array.isArray(extracted.sluzby_ceniky_pronajmy)) allFacts.sluzby_ceniky_pronajmy.push(...extracted.sluzby_ceniky_pronajmy);
            
            // Malá pauza, ať nás OpenAI nezablokuje za moc rychlých dotazů (Rate limiting)
            await sleep(400); 
        } catch (e) {
            console.error(`   ❌ Chyba AI analýzy na stránce ${page.title}: ${e.message}`);
        }
    }

    // Uložíme finální mistrovské dílo
    try {
        await fs.mkdir("netlify/functions", { recursive: true });
        await fs.writeFile("netlify/functions/core_facts.json", JSON.stringify(allFacts, null, 2));
        console.log("\n✅ Detailní AI databáze (včetně správců a ceníků) úspěšně vytvořena a uložena do core_facts.json!");
    } catch (e) { console.error("❌ Nelze uložit core_facts.json", e); }
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
            if (content.length > 50) {
                pages.push({ url, title, content });
                process.stdout.write(`\r🔍 Staženo HTML stránek: ${pages.length} `);
            }

        } catch (e) { /* tichý skip chyb */ }
    }
    console.log("\n✅ Crawl HTML dokončen.");
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
    console.log("🚀 STARTUJE HYBRIDNÍ CRAWL A CHIRURGICKÁ AI EXTRAKCE...");
    let { pages, docs } = await startCrawl();
    
    // Nová přesná analýza stránky po stránce
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
    
    console.log("\n📄 Zpracovávám PDF vyhlášky...");
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

    console.log("\n🔄 Synchronizuji s OpenAI Vector Store...");
    await syncWithOpenAI(path.join(OUT_DIR, CURRENT_FILE), path.join(OUT_DIR, ARCHIVE_FILE));
    console.log("🎯 HOTOVO. Architektura kompletně zaktualizována.");
}

main().catch(console.error);