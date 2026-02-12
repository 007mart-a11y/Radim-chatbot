// netlify/functions/search.mjs
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }  // thread_id držíme jen kvůli kompatibilitě (tady není nutný)
// Response: { ok:true, answer:string, thread_id:string }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

// tvrdý fallback text – přesně jak chceš
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
 * query: string or string[]
 * max_num_results: 1..50
 * rewrite_query: boolean
 * ranking_options: { ranker, score_threshold }
 */
async function vectorSearch({ vectorStoreId, query, maxNumResults = 12, rewriteQuery = true, scoreThreshold = 0.15 }, apiKey) {
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
          score_threshold: scoreThreshold,
        },
      }),
    },
    apiKey
  );
}

function pickTopChunks(searchJson, limit = 10) {
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
      text: text.slice(0, 2400), // bezpečně krátké
    });

    if (out.length >= limit) break;
  }

  return out;
}

function buildContextBlock(chunks) {
  // Kontext je “citovatelný” – model uvidí přesně ty pasáže
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (výběr relevantních úryvků):\n`;
  ctx += `---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${c.text}\n`;
    ctx += `---\n`;
  });
  return ctx.trim();
}

function systemPrompt() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš POUZE z poskytnutého kontextu (úryvky z oficiálních podkladů).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Když odpověď z kontextu nejde jednoznačně doložit, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `Styl:\n` +
    `- stručně a věcně (1–6 bodů nebo 1–4 věty)\n` +
    `- pokud jde o “kdy / kde / jak” → dej jasný postup\n` +
    `- pokud je dotaz nejasný → polož 1 doplňující otázku (ale jen když to fakt pomůže)\n`
  );
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  // Responses API – jednoduché, rychlé, bez magie Assistants
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        input: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
        ],
      }),
    },
    apiKey
  );

  // vytáhnout text
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

  // úklid whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
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

    // 1) PŘEDVYHLEDÁVÁNÍ (multi-query)
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec Radim`;

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: [q1, q2, q3],
        maxNumResults: 18,
        rewriteQuery: true,
        scoreThreshold: 0.15,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, 10);

    // když nic rozumného – tvrdý fallback
    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 2) ODPOVĚĎ jen z kontextu
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);

    // vynucení fallbacku, když model začne “radit obecně”
    // (můžeš si tu později přidat další zakázané fráze)
    const bad = /(doporučuji kontaktovat|nejsem si jist|pravděpodobně|mohlo by|zkuste)/i.test(answer);
    if (bad) answer = HARD_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}