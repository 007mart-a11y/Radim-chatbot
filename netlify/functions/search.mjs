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

// 🧠 PŘEDVYHLEDÁVÁNÍ (Query Expansion) - Geniální trik pro Vector Store
async function expandQuery(userMessage, apiKey) {
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Jsi expert na vyhledávání. Uživatel se ptá na něco ohledně obce. Napiš 5-8 klíčových slov (včetně synonym), která by se mohla vyskytovat v oficiálních dokumentech k tomuto tématu. Vrať POUZE ta slova oddělená mezerou. Např. pro 'hala' vrať 'hala sportovní areál tělocvična pronájem správce ceník'." },
          { role: "user", content: userMessage }
        ],
        temperature: 0.1
      })
    });
    const json = await res.json();
    const expanded = json.choices?.[0]?.message?.content || userMessage;
    console.log(`🔍 Rozšířený dotaz pro Vector Store: ${expanded}`);
    return expanded;
  } catch (e) {
    return userMessage; // Když to selže, hledá aspoň to původní
  }
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
  
  // 1. NAČTENÍ MEGA-DATABÁZE (Tady si načte ten obří JSON z nového crawleru)
  let coreFactsBlock = "";
  try {
      const factsObj = require("./core_facts.json");
      coreFactsBlock = `\n--- EXPERTNÍ DATABÁZE OBCE (TYTO ÚDAJE JSOU 100% PŘESNÉ A MAJÍ ABSOLUTNÍ PŘEDNOST) ---\n${JSON.stringify(factsObj, null, 2)}\n-------------------------------------------------\n`;
  } catch(e) {
      console.log("⚠️ Informace: core_facts.json zatím nenalezen, jede se bez něj.");
  }

  const messages = [
    { 
        role: "system", 
        content: `Jsi profesionální asistent obce Radim (pro rok 2026).
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: ZÁKAZ používání hvězdiček (*) a Markdownu. Piš jen čistý text bez tučného písma.
        2. ODKAZY NA ZDROJ A TVRDÁ DATA: 
           - Odpovědi ber PRIMÁRNĚ z "EXPERTNÍ DATABÁZE OBCE" (zde odkaz dávat nemusíš, nebo dej odkaz na úřad).
           - Pokud hledáš ve "DODANÝCH DATECH Z WEBU", VŽDY k odpovědi připoj přesný odkaz ve tvaru "Zdroj: [URL]".
        3. HALUCINACE A MANIPULACE: Pokud uživatel tvrdí něco, co v datech NENÍ, zdvořile ho OPRAV. NIKDY si nevymýšlej!
        4. NEVÍŠ = NEVÍŠ: Pokud odpověď jasně nevidíš v Databázi ani ve Vector Storu, odkaž na úřad (urad@obec-radim.cz).
        5. AKCE 2026: Pokud v datech nevidíš žádné budoucí akce s přesným datem, absolutně ZAKAZUJI si jakékoliv vymýšlet. Napiš, že v kalendáři na webu aktuálně žádné potvrzené nejsou.
        
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

    // 🚀 ZAPOJENÍ PŘEDVYHLEDÁVÁNÍ (Tady se to děje!)
    const expandedQuery = await expandQuery(userQ, apiKey);

    const searchRes = await fetch(`${OPENAI_BASE_URL}/vector_stores/${vectorStoreId}/search`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "OpenAI-Beta": "assistants=v2", "Content-Type": "application/json" },
      body: JSON.stringify({ query: expandedQuery, max_num_results: 20 }) // Hledá podle rozšířeného dotazu
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