// netlify/functions/search.mjs
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
      prio: it.filename.includes("CURRENT") ? 1 : 5
    }))
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 15);
}

async function generateAnswer({ userMessage, contextBlock, history = [] }, apiKey) {
  const messages = [
    { 
        role: "system", 
        content: `Jsi profesionální, lidský a velmi užitečný asistent obce Radim (pro rok 2026). Jsi absolutní expert na to, co se v obci děje.
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: Absolutní ZÁKAZ používání hvězdiček (*) a Markdownu. Piš pouze čistý text. Zásadně nepoužívej tučné písmo.
        2. ODKAZY NA ZDROJ: Data jsou v blocích [ZAČÁTEK...]. Uvnitř je pole "ODKAZ:". Pokud z bloku čerpáš, VŽDY na konec odpovědi napiš "Zdroj: " a přidej tuto URL.
        3. ŘEŠENÍ ROZPORŮ (AKTUÁLNOST): Pokud v dodaných datech vidíš různé údaje k jedné věci (např. různé ceny za psy, odpad, vodu, nebo dvě různé vyhlášky), VŽDY logicky vyhodnoť kontext a použij to, co je aktuální pro současnost. Zastaralé dokumenty (např. z let 2023, 2024) ignoruj. Pokud vidíš platný text bez roku a starý text s rokem, přednost má ten nový platný text.
        4. NEVÍŠ = NEVÍŠ: Pokud odpověď jasně nevidíš, nevymýšlej si. Slušně odkaž na urad@obec-radim.cz nebo 731 409 498.
        
        Odpovídej srozumitelně, věcně a přátelsky, jako skutečný profesionál na úřadě.` 
    },
    ...history.slice(-5),
    { role: "user", content: `DODANÁ DATA Z WEBU A DOKUMENTŮ:\n${contextBlock}\n\nOTÁZKA UŽIVATELE: ${userMessage}` }
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
      headers: { 
        "Authorization": `Bearer ${apiKey}`, 
        "OpenAI-Beta": "assistants=v2", 
        "Content-Type": "application/json" 
      },
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