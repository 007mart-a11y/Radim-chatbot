// netlify/functions/search.mjs
// Node 18+ Netlify Function
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC = "Radim";

// Ponecháno pro případy, kdy v datech není absolutně nic, ani kontakt
const HARD_FALLBACK = "Tato informace není v dostupných digitálních podkladech obce Radim uvedena. Pro další informace kontaktujte prosím obecní úřad (podatelna@obec-radim.cz).";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function stripSenior(url) {
  return String(url || "").replace("://www.obec-radim.cz/seniori/", "://www.obec-radim.cz/");
}

function stripKshow(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("kshow");
    return u.toString();
  } catch {
    return url;
  }
}

function fixLinksInText(t) {
  let s = String(t || "");
  s = s.replace(/https?:\/\/[^\s)]+/g, (m) => stripKshow(stripSenior(m)));
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

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path} failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

async function vectorSearch({ vectorStoreId, query, maxNumResults = 28, scoreThreshold = 0.05 }, apiKey) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: true,
        ranking_options: { ranker: "auto", score_threshold: scoreThreshold },
      }),
    },
    apiKey
  );
}

function pickTopChunks(searchJson, { maxChunks = 15, maxCharsTotal = 25000 } = {}) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const flat = [];

  const priority = (fn) => {
    const f = String(fn || "").toLowerCase();
    if (f.includes("people")) return 0;       // Kontakty a lidé mají absolutní přednost
    if (f.includes("kontakt")) return 0;
    if (f.startsWith("10_current")) return 1; // Aktuální dění a vyhlášky
    if (f.startsWith("30_pdf_text")) return 2;
    if (f.startsWith("90_archive")) return 9; // Archiv až na konec
    return 5;
  };

  for (const it of items) {
    const filename = it?.filename || "";
    const score = typeof it?.score === "number" ? it.score : 0;
    const chunks = Array.isArray(it?.content) ? it.content : [];
    const text = chunks.map((c) => (c?.type === "text" ? c?.text : "")).filter(Boolean).join("\n").trim();
    if (!text) continue;

    flat.push({ filename, score, prio: priority(filename), text });
  }

  flat.sort((a, b) => a.prio - b.prio || (b.score - a.score));

  let total = 0;
  const out = [];
  for (const x of flat) {
    const snippet = x.text.slice(0, 3500);
    if (total + snippet.length > maxCharsTotal) continue;
    out.push({ filename: x.filename, score: x.score, text: snippet });
    total += snippet.length;
    if (out.length >= maxChunks) break;
  }
  return out;
}

function systemPrompt() {
  return (
    `Jsi oficiální digitální asistent obce Radim (okres Jičín). Aktuální rok je 2026.\n\n` +
    `TVŮJ CÍL: Poskytovat občanům užitečné a lidské odpovědi na základě podkladů. Nejsi jen vyhledávač, jsi pomocník.\n\n` +
    `PRAVIDLA ODPOVĚDÍ:\n` +
    `1. BUĎ PROAKTIVNÍ: Pokud v datech nenajdeš konkrétní detail (např. cenu pronájmu haly nebo jméno vedoucího), NIKDY neodpovídej pouze strohým "informace není v podkladech". Místo toho uživateli poraď, na koho se obrátit (např. TJ Sokol, podatelna, starostka).\n` +
    `2. KONTAKTY: Pokud nevíš přesně, nasměruj uživatele na podatelna@obec-radim.cz nebo tel. +420 493 591 123.\n` +
    `3. STRUKTURA: Odpovídej věcně, ideálně v 1-3 krátkých odstavcích nebo bodech.\n` +
    `4. RELEVANCE ODKAZŮ: V sekci "Odkazy:" uváděj jen ty, které s tématem přímo souvisí. Pokud se někdo ptá na starostu, nedávej mu odkaz na vyhlášku o odpadech.\n\n` +
    `STYL: Profesionální, vstřícný, bez technického žargonu (nepiš názvy souborů jako 10_CURRENT).`
  );
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        input: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: `KONTEXT Z PODKLADŮ:\n${contextBlock}\n\nDOTAZ UŽIVATELE: ${userMessage}` },
        ],
      }),
    },
    apiKey
  );

  if (typeof resp?.output_text === "string") return resp.output_text.trim();
  return HARD_FALLBACK;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    const body = await req.json().catch(() => ({}));
    const userQ = (body?.message || "").trim();
    if (!userQ) return jsonResponse(400, { ok: false, error: "Missing message" });

    const threadId = body?.thread_id || `thread_${Date.now()}`;

    // Vyhledávání s širším záběrem pro lepší zásah lidí/kontaktů
    const search = await vectorSearch({
      vectorStoreId,
      query: [userQ, normalizeCzech(userQ), `${userQ} kontakt starosta sokol`],
    }, apiKey);

    const chunks = pickTopChunks(search);

    if (!chunks.length) {
        return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    let ctx = "ÚRYVKY Z PODKLADŮ:\n";
    chunks.forEach((c, i) => { ctx += `[ZDROJ ${i+1}: ${c.filename}]\n${c.text}\n---\n`; });

    let answer = await generateAnswer({ userMessage: userQ, contextBlock: ctx }, apiKey);
    
    // Čištění od technických značek a normalizace odkazů
    answer = fixLinksInText(answer.replace(/【.*?】/g, ""));

    return jsonResponse(200, { ok: true, answer: answer.trim(), thread_id: threadId });

  } catch (err) {
    console.error(err);
    return jsonResponse(500, { ok: false, error: "Server error", details: err.message });
  }
}