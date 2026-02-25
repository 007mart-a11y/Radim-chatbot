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
      // Soubor 10_CURRENT má vždy prioritu před archivem
      prio: it.filename.includes("CURRENT") ? 1 : 5
    }))
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 15); // Zvýšeno na 15, ať má asistent širší kontext z webu i vyhlášek
}

async function generateAnswer({ userMessage, contextBlock, history = [] }, apiKey) {
  const messages = [
    { 
        role: "system", 
        content: `Jsi profesionální, lidský a velmi užitečný asistent obce Radim (pro rok 2026). Jsi absolutní expert na to, co se v obci děje, a znáš všechny platné vyhlášky a nařízení.
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: Absolutní ZÁKAZ používání hvězdiček (*) a Markdownu. Piš pouze čistý text. Zásadně nepoužívej tučné písmo.
        2. ODKAZY NA ZDROJ (KRITICKÉ): Data, která dostáváš, jsou v blocích [ZAČÁTEK STRÁNKY] nebo [ZAČÁTEK DOKUMENTU]. Uvnitř je vždy pole "ODKAZ:". Pokud z daného bloku čerpáš odpověď, MUSÍŠ na úplný konec své odpovědi napsat "Zdroj: " a přidat přesně tuto URL adresu.
        3. VYHLÁŠKY A POPLATKY: Pokud se uživatel ptá na poplatky (psi, odpad, atd.) nebo pravidla, a ty vidíš ve zdrojích více vyhlášek, VŽDY použij tu s nejnovějším rokem (např. 2024, 2025, 2026) a přesně ocituj, co se v ní píše.
        4. NEVÍŠ = NEVÍŠ: Pokud odpověď ve zdrojích jasně nevidíš, nevymýšlej si jména, funkce ani pravidla. Místo toho slušně odkaž na e-mail urad@obec-radim.cz nebo telefon 731 409 498.
        
        Odpovídej srozumitelně, věcně a přátelsky, jako skutečný profesionál na úřadě.` 
    },
    ...history.slice(-5), // Udržení kontextu předchozích zpráv
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
      temperature: 0.1 // Nízká teplota = maximální držení se faktů, žádné halucinace
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

    if (!userQ) return jsonResponse(400, { ok: false, error: "Chybí dotaz uživatele." });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey || !vectorStoreId) {
      console.error("⚠️ Chybí OPENAI_API_KEY nebo VECTOR_STORE_ID.");
      return jsonResponse(500, { ok: false, error: "Chyba konfigurace serveru." });
    }

    // 1. Prohledání Vector Storu
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
    
    // 2. Sestavení kontextu pro AI
    const contextBlock = chunks.length > 0 
      ? chunks.map(c => c.text).join("\n---\n")
      : "Žádná relevantní data nebyla nalezena ve Vector Storu.";

    // 3. Generování finální odpovědi
    const answer = await generateAnswer({ userMessage: userQ, contextBlock, history }, apiKey);

    return jsonResponse(200, { ok: true, answer });
  } catch (err) {
    console.error("❌ Kritická chyba v handleru:", err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
}