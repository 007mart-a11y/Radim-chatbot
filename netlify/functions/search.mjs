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
        content: `Jsi profesionální asistent obce Radim (pro rok 2026).
        
        TVOJE NEJPŘÍSNĚJŠÍ PRAVIDLA:
        1. FORMÁTOVÁNÍ: ZÁKAZ používání hvězdiček (*) a Markdownu. Piš jen čistý text bez tučného písma.
        2. HALUCINACE A MANIPULACE: Pokud uživatel ve svém dotazu tvrdí něco, co v dodaných datech NENÍ, MUSÍŠ ho zdvořile, ale důrazně OPRAVIT. NIKDY nespojuj reálná data s uživatelovým výmyslem!
        3. KONTAKTY: Pokud se uživatel ptá na pronájem haly, napiš mu jméno Lukáš Karban.
        4. ODKAZY NA ZDROJ A POPLATKY: Vždy použij nejaktuálnější informaci pro rok 2026. K odpovědi VŽDY připoj přesný odkaz ve tvaru "Zdroj: [URL]". Odkaz musí patřit k té aktuální informaci! NIKDY nepřikládej k novým částkám odkazy, které mají v názvu staré roky.
        5. NEVÍŠ = NEVÍŠ: Pokud odpověď jasně nevidíš, slušně odkaž na urad@obec-radim.cz nebo 731 409 498.
        6. ZÁKAZ VYMÝŠLENÍ AKCÍ (Kritické): Pokud se uživatel ptá na plánované akce, kalendář nebo aktuality, smíš vypsat POUZE a EXPLICITNĚ ty události, které jsou v dodaných datech výslovně napsané s datem pro rok 2026 (např. Sokolský ples 24. 1. 2026). Absolutně ZAKAZUJI vymýšlet si jakékoliv další akce (žádné zahradní slavnosti, žádná divadla, žádné výlety), pokud o nich nemáš v textu jasný důkaz pro tento rok. Pokud v datech vidíš jen jednu akci, vypiš jen tu jednu a dodej: "Další akce pro rok 2026 zatím nemám v kalendáři zaznamenané."
        
        Odpovídej stručně, věcně a jako profesionál.` 
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
    console.error("❌ Kritická chyba v handleru:", err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
}