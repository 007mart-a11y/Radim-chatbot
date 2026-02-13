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

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function deSeniorizeLinks(s) {
  return String(s || "").replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/");
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

// -------- Vector Search --------
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 28, rewriteQuery = true, scoreThreshold = 0.10 },
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
        ranking_options: { ranker: "auto", score_threshold: scoreThreshold },
      }),
    },
    apiKey
  );
}

function flattenChunks(searchJson) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const out = [];
  for (const it of items) {
    const filename = it?.filename || it?.file?.filename || "";
    const score = typeof it?.score === "number" ? it.score : 0;
    const contentArr = Array.isArray(it?.content) ? it.content : [];
    const text = contentArr
      .map((c) => (c?.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) continue;
    out.push({ filename, score, text });
  }
  return out;
}

function boostScore(filename, baseScore) {
  const f = (filename || "").toLowerCase();
  let boost = 0;
  if (f.includes("00_latest")) boost += 0.22;
  if (f.includes("30_pdf_text")) boost += 0.30;
  if (f.includes("00_people")) boost += 0.28;
  if (f.includes("99_full")) boost += 0.10;
  return baseScore + boost;
}

function isLawFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(vyhlask|ozv|pravni predpis|mistni poplatek|poplatek|odpad|odpady|pes|psi|psu|psů)\b/.test(s);
}
function wantsExactQuote(q) {
  const s = normalizeCzech(q);
  return /\b(zkopiruj|cituj|presnou vetu|doslovn|odstavec|clanek)\b/.test(s);
}

function pickContext(chunks, userQ, limitChars = 16000) {
  const sorted = [...chunks].sort(
    (a, b) => boostScore(b.filename, b.score) - boostScore(a.filename, a.score)
  );

  let ordered = sorted;
  if (isLawFeeQuestion(userQ)) {
    const pdf = sorted.filter((c) => (c.filename || "").toLowerCase().includes("30_pdf_text"));
    const latest = sorted.filter((c) => (c.filename || "").toLowerCase().includes("00_latest"));
    const rest = sorted.filter(
      (c) =>
        !(c.filename || "").toLowerCase().includes("30_pdf_text") &&
        !(c.filename || "").toLowerCase().includes("00_latest")
    );
    ordered = [...pdf, ...latest, ...rest];
  }

  const seen = new Set();
  let total = 0;
  const blocks = [];

  for (const c of ordered) {
    const snippet = c.text.slice(0, 2600);
    const sig = `${c.filename}::${snippet.slice(0, 240)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);

    const b = `[#] ${c.filename || "soubor"} (score:${c.score.toFixed(3)})\n${snippet}\n`;
    if (total + b.length > limitChars) break;
    blocks.push(b);
    total += b.length;
  }

  return deSeniorizeLinks(blocks.join("\n---\n").trim());
}

function systemPrompt(userQ) {
  const quoteMode = wantsExactQuote(userQ);
  return (
    `Jsi chytrý, praktický AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej primárně z poskytnutého kontextu (LATEST/FULL/PDF_TEXT/PEOPLE).\n` +
    `Nevymýšlej fakta. Pokud se odpověď nedá doložit z kontextu, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    (quoteMode
      ? `Uživatel chce DOSLOVNOU citaci: vrať max 2 věty doslova z kontextu a nic navíc.\n`
      : `Dej stručnou odpověď + na konci 1–3 relevantní odkazy (ne seniorské).\n`)
  );
}

async function generateAnswer({ userQ, contextText }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        input: [
          { role: "system", content: systemPrompt(userQ) },
          { role: "user", content: `KONTEXT:\n${contextText}\n\nDOTAZ:\n${userQ}` },
        ],
      }),
    },
    apiKey
  );

  // ✅ správné čtení pro Responses API
  const text = String(resp?.output_text || "").trim();
  return deSeniorizeLinks(text);
}

function cleanAnswer(t) {
  let s = String(t || "");
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = deSeniorizeLinks(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.trim();
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const threadId = `thread_local_${Date.now()}`;

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQ = message.trim();

    // 1) předvyhledávání
    const queries = [
      userQ,
      normalizeCzech(userQ),
      `${userQ} obec Radim`,
      isLawFeeQuestion(userQ) ? `${userQ} článek odstavec výše poplatku` : null,
    ].filter(Boolean);

    const search = await vectorSearch(
      { vectorStoreId, query: queries, maxNumResults: 28, rewriteQuery: true, scoreThreshold: 0.10 },
      apiKey
    );

    const chunks = flattenChunks(search);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: body?.thread_id || threadId });
    }

    const contextText = pickContext(chunks, userQ, 16000);

    // 2) odpověď
    let answer;
    try {
      answer = await generateAnswer({ userQ, contextText }, apiKey);
    } catch (e) {
      // ✅ když OpenAI spadne, UI nesmí vidět “Bez odpovědi”
      return jsonResponse(200, {
        ok: true,
        answer: HARD_FALLBACK,
        thread_id: body?.thread_id || threadId,
      });
    }

    answer = cleanAnswer(answer);

    if (!answer) answer = HARD_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: body?.thread_id || threadId });
  } catch (err) {
    // i tady radši vrať fallback než nic (kvůli UI)
    return jsonResponse(200, {
      ok: true,
      answer: HARD_FALLBACK,
      thread_id: body?.thread_id || threadId,
    });
  }
}