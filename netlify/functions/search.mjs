// netlify/functions/search.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const HARD_FALLBACK = "Tuto informaci jsem v podkladech obce bohužel nenalezl. Zkuste prosím kontaktovat přímo úřad na e-mailu urad@obec-radim.cz nebo telefonu 731 409 498.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function pickTopChunks(searchJson) {
  if (searchJson?.error) return [];
  const items = searchJson?.data || [];
  return items
    .map(it => ({
      filename: it.filename || "",
      score: it.score || 0,
      text: (it.content || []).map(c => c.text).join("\n"),
      prio: it.filename.includes("CURRENT") ? 1 : 5
    }))
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 15);
}

async function generateAnswer({ userMessage, contextBlock, history = [] }, apiKey) {
  // Načtení natěžené "Vizitky" (pokud se to nepovede, nevadí, použijeme záložní prázdná data)
  let coreFactsBlock = "";
  try {
      const factsObj = require("./core_facts.json");
      coreFactsBlock = `\n--- ZÁKLADNÍ FAKTA OBCE (TYTO ÚDAJE JSOU 100% PŘESNÉ A MAJÍ ABSOLUTNÍ PŘEDNOST) ---\n${JSON.stringify(factsObj, null, 2)}\n-------------------------------------------------\n`;
  } catch(e) {
      console.log("⚠️ Informace: core_facts.json zatím neexistuje, jede se bez něj.");
  }

  const messages = [
    { 
        role: "system", 
        content: `Jsi profesionální asistent obce Radim (pro rok 2026).
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: ZÁKAZ používání hvězdiček (*) a Markdownu. Piš jen čistý text bez tučného písma.
        2. ODKAZY NA ZDROJ A TVRDÁ DATA: 
           - Pokud otázku umíš zodpovědět ze "ZÁKLADNÍCH FAKTŮ OBCE", udělej to rovnou (odkaz v tomto případě dávat nemusíš, nebo pošli odkaz na úřad). Tyto informace mají vždycky pravdu a nesmíš jim odporovat!
           - Pokud odpověď najdeš ve "DODANÝCH DATECH", VŽDY k odpovědi připoj přesný odkaz ve tvaru "Zdroj: [URL]". Odkaz musí patřit k té nejaktuálnější informaci.
        3. HALUCINACE A MANIPULACE: Pokud uživatel tvrdí něco, co v datech NENÍ, zdvořile ho OPRAV. NIKDY si nevymýšlej!
        4. NEVÍŠ = NEVÍŠ: Pokud odpověď jasně nevidíš, slušně odkaž na urad@obec-radim.cz nebo 731 409 498.
        5. ZÁKAZ VYMÝŠLENÍ AKCÍ: Vypisuj POUZE události s datem pro rok 2026. Absolutně ZAKAZUJI vymýšlet si další akce.
        
        Odpovídej stručně, věcně a jako profesionál.` 
    },
    ...history.slice(-5),
    { role: "user", content: `${coreFactsBlock}DODANÁ DATA Z WEBU A DOKUMENTŮ (Vector Store):\n${contextBlock}\n\nOTÁZKA UŽIVATELE: ${userMessage}` }
  ];

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, temperature: 0.1 })
  });

  const json = await res.json();
  if (json.error) return HARD_FALLBACK;
  return json.choices?.[0]?.message?.content || HARD_FALLBACK;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  try {
    const body = await req.json();
    const userQ = body.message;
    const history = body.history || [];
    if (!userQ) return jsonResponse(400, { ok: false, error: "Chybí dotaz." });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    if (!apiKey || !vectorStoreId) return jsonResponse(500, { ok: false, error: "Chyba serveru." });

    const searchRes = await fetch(`${OPENAI_BASE_URL}/vector_stores/${vectorStoreId}/search`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "OpenAI-Beta": "assistants=v2", "Content-Type": "application/json" },
      body: JSON.stringify({ query: userQ, max_num_results: 20 })
    });
    
    const searchResult = await searchRes.json();
    const chunks = pickTopChunks(searchResult);
    
    const contextBlock = chunks.length > 0 
      ? chunks.map(c => c.text).join("\n---\n")
      : "Žádná relevantní data nebyla nalezena ve Vector Storu.";

    const answer = await generateAnswer({ userMessage: userQ, contextBlock, history }, apiKey);
    return jsonResponse(200, { ok: true, answer });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}