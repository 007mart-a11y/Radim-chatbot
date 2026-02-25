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
      prio: (it.filename.includes("people") || it.filename.includes("CORE")) ? 0 : 
            it.filename.includes("CURRENT") ? 1 : 5
    }))
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 12); 
}

async function generateAnswer({ userMessage, contextBlock, history = [] }, apiKey) {
  const messages = [
    { 
        role: "system", 
        content: `Jsi oficiální, lidský a velmi užitečný asistent obce Radim (pro rok 2026). Jsi expert na to, co se v obci děje.
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: Absolutní ZÁKAZ používání hvězdiček (*) a Markdownu. Piš pouze čistý text. Pro zdůraznění můžeš výjimečně použít VELKÁ PÍSMENA. Nepoužívej tučné písmo.
        2. ODKAZY: Pokud najdeš odpověď ve zdrojových datech, VŽDY se podívej na pole "ODKAZ:" v daném bloku a přidej tuto URL adresu na konec své odpovědi ve tvaru "Zdroj: [odkaz]".
        3. STARÉ VS. NOVÉ: Pokud ve zdrojích vidíš více vyhlášek nebo dat (např. o poplatcích), VŽDY použij tu s nejnovějším datem a staré ignoruj.
        4. NEVÍŠ = NEVÍŠ: Pokud odpověď ve zdrojích jasně nevidíš, nevymýšlej si. Místo toho slušně odkaž na urad@obec-radim.cz nebo telefon 731 409 498.
        
        Odpovídej stručně, srozumitelně a přátelsky, jako místní znalec.` 
    },
    ...history.slice(-5),
    { role: "user", content: `DATA Z WEBU A DOKUMENTŮ:\n${contextBlock}\n\nOTÁZKA: ${userMessage}` }
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
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
      ? chunks.map(c => `[Zdroj: ${c.filename}]\n${c.text}`).join("\n---\n")
      : "Žádná relevantní data nebyla nalezena ve Vector Storu.";

    const answer = await generateAnswer({ userMessage: userQ, contextBlock, history }, apiKey);

    return jsonResponse(200, { ok: true, answer });
  } catch (err) {
    console.error("❌ Kritická chyba:", err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
}