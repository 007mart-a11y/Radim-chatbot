// netlify/functions/search.mjs
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const HARD_FALLBACK = "Tuto informaci jsem v podkladech obce nenalezl. Zkuste prosím podatelna@obec-radim.cz.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// POMOCNÁ FUNKCE PRO VÝBĚR NEJLEPŠÍCH DAT
function pickTopChunks(searchJson) {
  // Ochrana, pokud OpenAI vrátí chybu místo dat
  if (searchJson?.error) {
    console.error("❌ OpenAI Vector Search Error:", searchJson.error);
    return [];
  }

  const items = searchJson?.data || [];
  return items
    .map(it => ({
      filename: it.filename || "",
      score: it.score || 0,
      text: (it.content || []).map(c => c.text).join("\n"),
      // KLÍČ: Soubory s lidmi a aktuálními daty mají přednost před archivem
      prio: (it.filename.includes("people") || it.filename.includes("CORE")) ? 0 : 
            it.filename.includes("CURRENT") ? 1 : 5
    }))
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 12); 
}

async function generateAnswer({ userMessage, contextBlock, history = [] }, apiKey) {
  // Tady se tvoří "PAMĚŤ" - posíláme historii i kontext z webu
  const messages = [
    { 
        role: "system", 
        content: `Jsi asistent obce Radim (2026). 
        TVOJE NEJVYŠŠÍ PRIORITA: Pokud v datech najdeš konkrétní osobu pro konkrétní věc (např. Karban pro Sokol/Halu), uváděj PŘÍMO ji. Neposílej lidi na úřad, pokud existuje přímý kontakt.
        DRŽ KONTEXT: Pokud se uživatel ptá zájmeny (to, on, kolik to stojí), dívej se na předchozí zprávy v historii.
        STYL: Piš věcně, tučně zvýrazňuj ceny a jména.` 
    },
    ...history.slice(-5), // Posledních 5 zpráv historie pro paměť
    { role: "user", content: `DATA Z WEBU:\n${contextBlock}\n\nOTÁZKA: ${userMessage}` }
  ];

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "Authorization": `Bearer ${apiKey}` 
    },
    body: JSON.stringify({ 
      model: "gpt-4o-mini", 
      messages, 
      temperature: 0.1 
    })
  });

  const json = await res.json();
  
  if (json.error) {
    console.error("❌ OpenAI Chat Completions Error:", json.error);
    return HARD_FALLBACK;
  }

  return json.choices?.[0]?.message?.content || HARD_FALLBACK;
}

export default async function handler(req) {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  try {
    const body = await req.json();
    const userQ = body.message;
    const history = body.history || []; // Tady musí tvůj frontend posílat historii!

    if (!userQ) {
      return jsonResponse(400, { ok: false, error: "Chybí dotaz uživatele." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey || !vectorStoreId) {
      console.error("⚠️ Chybí OPENAI_API_KEY nebo VECTOR_STORE_ID v nastavení prostředí.");
      return jsonResponse(500, { ok: false, error: "Chyba konfigurace serveru." });
    }

    // 1. Hledáme v OpenAI Vector Storu
    const searchRes = await fetch(`${OPENAI_BASE_URL}/vector_stores/${vectorStoreId}/search`, {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${apiKey}`, 
        "OpenAI-Beta": "assistants=v2", 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ query: userQ, max_num_results: 20 })
    });
    
    const searchResult = await searchRes.json();
    const chunks = pickTopChunks(searchResult);
    
    // Sestavíme textový kontext, nebo vložíme defaultní hlášku
    const contextBlock = chunks.length > 0 
      ? chunks.map(c => `[Zdroj: ${c.filename}]\n${c.text}`).join("\n---\n")
      : "Žádná relevantní data nebyla nalezena ve Vector Storu.";

    // 2. Generujeme odpověď
    const answer = await generateAnswer({ userMessage: userQ, contextBlock, history }, apiKey);

    return jsonResponse(200, { ok: true, answer });
  } catch (err) {
    console.error("❌ Kritická chyba v handleru:", err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
}