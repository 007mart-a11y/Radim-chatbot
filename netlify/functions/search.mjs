// netlify/functions/search.mjs
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

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

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path} failed: ${msg}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

/**
 * Vector Store Search
 * POST /v1/vector_stores/{vector_store_id}/search
 */
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 30, rewriteQuery = true, scoreThreshold = 0.0 },
  apiKey
) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: rewriteQuery,
        ranking_options: {
          ranker: "auto",
          score_threshold: scoreThreshold, // důležité: NEškrtit to
        },
      }),
    },
    apiKey
  );
}

function pickTopChunks(searchJson, limit = 14, maxCharsPerFile = 6000) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const out = [];

  for (const it of items) {
    const filename = it?.filename || "";
    const score = typeof it?.score === "number" ? it.score : null;
    const chunks = Array.isArray(it?.content) ? it.content : [];

    const text = chunks
      .map((c) => (c?.type === "text" ? c?.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) continue;

    out.push({
      filename,
      score,
      text: text.slice(0, maxCharsPerFile),
    });

    if (out.length >= limit) break;
  }

  return out;
}

function buildContextBlock(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (výběr relevantních úryvků):\n---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"}${c.score != null ? ` (score: ${c.score.toFixed(3)})` : ""}\n`;
    ctx += `${c.text}\n---\n`;
  });
  return ctx.trim();
}

function systemPrompt() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš primárně z poskytnutého KONTEKSTU (úryvky z oficiálních podkladů obce).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Když odpověď z kontextu nejde spolehlivě doložit, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n` +
    `Aktuální rok je 2026. Informace starší než dnešní datum ber jako historické.\n\n` +
    `Formát:\n` +
    `Odpověď:\n- 1–6 krátkých bodů / nebo 1–4 věty.\n\n` +
    `Odkazy:\n- uveď 1–3 přímé odkazy (pokud jsou v kontextu).`
  );
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        input: [
          { role: "system", content: systemPrompt() },
          {
            role: "user",
            content:
              `${contextBlock}\n\n` +
              `DOTAZ UŽIVATELE:\n${userMessage}\n\n` +
              `POKYNY:\n` +
              `- Odpověz česky.\n` +
              `- Pokud jde o poplatky / vyhlášky: hledej částky přímo v textu (včetně PDF textu).\n` +
              `- Když najdeš částku v kontextu, uveď ji + krátce kde je uvedená.\n`,
          },
        ],
      }),
    },
    apiKey
  );

  const out = Array.isArray(resp?.output) ? resp.output : [];
  const msg = out.find((x) => x?.type === "message");
  const content = Array.isArray(msg?.content) ? msg.content : [];

  const text = content
    .map((c) => (c?.type === "output_text" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || HARD_FALLBACK;
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč se zbytky citací ve formátu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // sjednotit na "klasický web" – bez /seniori/
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // nikdy nevracej prázdno
  if (!s) return HARD_FALLBACK;

  return s;
}

function ensureNotEmptyAnswer(answer) {
  const a = String(answer || "").trim();
  return a ? a : HARD_FALLBACK;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // Multi-query: normální + bez diakritiky + obohacené
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec Radim`;
    const q4 = `${userQ} vyhláška poplatek`;
    const q5 = `${userQ} úřední deska dokument`;

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: [q1, q2, q3, q4, q5],
        maxNumResults: 30,
        rewriteQuery: true,
        scoreThreshold: 0.0,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, 14, 6500);

    // Když nic – vrať fallback (ale NIKDY prázdno)
    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // Odpověď “inteligentně” jen z kontextu
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);
    answer = ensureNotEmptyAnswer(answer);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}