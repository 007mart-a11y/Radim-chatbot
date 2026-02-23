// netlify/functions/search.mjs
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";

const HARD_FALLBACK = "Omlouvám se, ale pro tento dotaz nemám v digitálním archivu obce dostatek podkladů. Zkuste prosím kontaktovat obecní úřad přímo na e-mailu podatelna@obec-radim.cz nebo tel. +420 493 591 123.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fixLinksInText(t) {
  let s = String(t || "");
  // Odstranění zbytečných parametrů a úprava URL
  s = s.replace(/https?:\/\/[^\s)]+/g, (m) => {
    try {
      const u = new URL(m);
      u.searchParams.delete("kshow");
      u.pathname = u.pathname.replace("/seniori/", "/");
      return u.toString();
    } catch { return m; }
  });
  return s;
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body,
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  return await res.json();
}

// Chytřejší výběr kousků textu
function pickTopChunks(searchJson) {
  const items = searchJson?.data || [];
  const flat = items.map(it => ({
    filename: it.filename || "",
    score: it.score || 0,
    text: (it.content || []).map(c => c.text).join("\n"),
    // Prioritizace: 10_CURRENT a 00_CORE jsou nejvíc, ARCHIVE nejmíň
    prio: it.filename.includes("00_CORE") ? 0 : 
          it.filename.includes("10_CURRENT") ? 1 : 
          it.filename.includes("90_ARCHIVE") ? 5 : 2
  }));

  // Seřadit podle priority a pak podle shody (score)
  return flat
    .sort((a, b) => a.prio - b.prio || b.score - a.score)
    .slice(0, 10); // Stačí 10 nejlepších pro gpt-4o-mini
}

function systemPrompt() {
  return `Jsi oficiální asistent obce Radim. Aktuální rok je 2026.
  
CÍL: Odpovídej občanům jasně, lidsky a věcně.
ZDROJE: Máš k dispozici úryvky z webu, vyhlášek a interních dokumentů. Některé úryvky obsahují "SHRNUTÍ PRO OBČANY" – to jsou prioritní, ověřené informace z PDF.

PRAVIDLA:
1. Pokud existuje konkrétní cena (voda, odpady, pes) nebo termín, uveď ho TUČNĚ (např. **150 Kč**).
2. Neodkazuj na názvy souborů (nepiš "v souboru 10_CURRENT..."). Místo toho piš "Dle aktuálních informací..." nebo "Podle platné vyhlášky...".
3. Pokud informaci nemáš, neříkej jen "nevím". Nabídni kontakt na podatelnu (podatelna@obec-radim.cz) nebo příslušný spolek (Sokol, Hasiči), pokud se dotaz týká jich.
4. Odpovídej v češtině, stručně, v odrážkách, pokud je informací více.`;
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `KONTEXT (Oficiální dokumentace):\n${contextBlock}\n\nDOTAZ UŽIVATELE: ${userMessage}` }
    ],
    temperature: 0.2, // Nižší teplota = méně vymýšlení
  };

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  return json.choices?.[0]?.message?.content || HARD_FALLBACK;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    const body = await req.json();
    const userQ = body.message;

    if (!userQ) return jsonResponse(400, { error: "No message" });

    // Rozšíření hledání o rok a klíčová slova
    const searchQuery = `${userQ} 2026 aktuální vyhláška poplatky kontakt`;

    const searchResult = await oaiFetch(
      `/vector_stores/${vectorStoreId}/search`,
      {
        method: "POST",
        body: JSON.stringify({
          query: searchQuery,
          max_num_results: 20,
        }),
      },
      apiKey
    );

    const chunks = pickTopChunks(searchResult);
    const contextBlock = chunks.map(c => `[ZDROJ: ${c.filename}]\n${c.text}`).join("\n---\n");

    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    
    // Finální vyčištění
    answer = fixLinksInText(answer.replace(/【.*?】/g, ""));

    return jsonResponse(200, { 
        ok: true, 
        answer: answer.trim(),
        thread_id: body.thread_id || `t_${Date.now()}`
    });

  } catch (err) {
    console.error(err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
}