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

// Vector Stores + Assistants v2 endpoints require this
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

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

async function oaiFetch(
  path,
  { method = "GET", headers = {}, body } = {},
  apiKey,
  { beta = false } = {}
) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(beta ? OPENAI_BETA_HEADER : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
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

// ---------------- Vector Store search ----------------

async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 30, rewriteQuery = true, scoreThreshold = 0.10 },
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
    apiKey,
    { beta: true } // ✅ MUST
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

function isLawFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(vyhlask|ozv|pravni predpis|mistni poplatek|poplatek|odpad|odpady|pes|psi|psu|psů)\b/.test(s);
}
function wantsExactQuote(q) {
  const s = normalizeCzech(q);
  return /\b(zkopiruj|cituj|presnou vetu|doslovn|odstavec|clanek)\b/.test(s);
}

function boostScore(filename, baseScore) {
  const f = (filename || "").toLowerCase();
  let boost = 0;
  if (f.includes("30_pdf_text")) boost += 0.35;   // důležité pro vyhlášky
  if (f.includes("00_people")) boost += 0.30;     // starosta, kontakty, funkce
  if (f.includes("00_latest")) boost += 0.20;     // nejnovější
  if (f.includes("99_full")) boost += 0.10;       // zbytek webu
  return baseScore + boost;
}

function pickContext(chunks, userQ, limitChars = 20000) {
  const sorted = [...chunks].sort(
    (a, b) => boostScore(b.filename, b.score) - boostScore(a.filename, a.score)
  );

  // Když jde o vyhlášky/poplatky → preferuj PDF_TEXT + LATEST + PEOPLE
  let ordered = sorted;
  if (isLawFeeQuestion(userQ)) {
    const pdf = sorted.filter((c) => (c.filename || "").toLowerCase().includes("30_pdf_text"));
    const latest = sorted.filter((c) => (c.filename || "").toLowerCase().includes("00_latest"));
    const people = sorted.filter((c) => (c.filename || "").toLowerCase().includes("00_people"));
    const rest = sorted.filter(
      (c) =>
        !(c.filename || "").toLowerCase().includes("30_pdf_text") &&
        !(c.filename || "").toLowerCase().includes("00_latest") &&
        !(c.filename || "").toLowerCase().includes("00_people")
    );
    ordered = [...pdf, ...latest, ...people, ...rest];
  }

  const seen = new Set();
  let total = 0;
  const blocks = [];

  for (const c of ordered) {
    const snippet = c.text.slice(0, 3200);
    const sig = `${c.filename}::${snippet.slice(0, 250)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);

    const b = `[#] ${c.filename || "soubor"} (score:${(c.score ?? 0).toFixed(3)})\n${snippet}\n`;
    if (total + b.length > limitChars) break;
    blocks.push(b);
    total += b.length;
  }

  return deSeniorizeLinks(blocks.join("\n---\n").trim());
}

// ---------------- Answer generation ----------------

function systemPrompt(userQ) {
  const quoteMode = wantsExactQuote(userQ);

  return (
    `Jsi chytrý, praktický AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej primárně z poskytnutého KONTEKSTU (LATEST/FULL/PDF_TEXT/PEOPLE).\n` +
    `Nevymýšlej fakta.\n` +
    `Pokud odpověď nelze doložit z kontextu, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    (quoteMode
      ? `Uživatel chce DOSLOVNOU citaci: vrať max 2 věty doslova z KONTEKSTU, bez omáčky.\n`
      : `Dej věcnou odpověď (1–6 bodů / 1–4 věty) a pokud máš URL v kontextu, přidej 1–3 odkazy.\n`)
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
    apiKey,
    { beta: false }
  );

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

// ---------------- Handler ----------------

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
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    const queries = [
      userQ,
      normalizeCzech(userQ),
      `${userQ} obec Radim`,
      isLawFeeQuestion(userQ) ? `${userQ} vyhláška článek odstavec částka` : null,
    ].filter(Boolean);

    // 1) první pokus (rychlý, threshold)
    let search = await vectorSearch(
      { vectorStoreId, query: queries, maxNumResults: 30, rewriteQuery: true, scoreThreshold: 0.10 },
      apiKey
    );
    let chunks = flattenChunks(search);

    // 2) fallback search (bez thresholdu) – když store OK, tak to něco vrátí skoro vždy
    if (!chunks.length) {
      search = await vectorSearch(
        { vectorStoreId, query: queries, maxNumResults: 50, rewriteQuery: false, scoreThreshold: 0.0 },
        apiKey
      );
      chunks = flattenChunks(search);
    }

    if (!chunks.length) {
      // Tohle znamená: store prázdný / neindexovaný / špatné VECTOR_STORE_ID
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextText = pickContext(chunks, userQ, 20000);

    let answer = await generateAnswer({ userQ, contextText }, apiKey);
    answer = cleanAnswer(answer);
    if (!answer) answer = HARD_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    // NE maskovat: tohle ti konečně ukáže, co se děje
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}