// netlify/functions/search.mjs
// Node 18+ Netlify Function
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC = "Radim";

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
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
  // remove kshow params from visible urls
  s = s.replace(/https?:\/\/[^\s)]+/g, (m) => stripKshow(stripSenior(m)));
  return s;
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // IMPORTANT for vector stores in assistants v2
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
    err.details = json || text;
    throw err;
  }
  return json ?? {};
}

// POST /v1/vector_stores/{id}/search
async function vectorSearch({ vectorStoreId, query, maxNumResults = 24, rewriteQuery = true, scoreThreshold = 0.08 }, apiKey) {
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

function pickTopChunks(searchJson, { maxChunks = 14, maxCharsTotal = 14000 } = {}) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const out = [];

  // Prefer these filenames if present
  const priority = (fn) => {
    const f = String(fn || "").toLowerCase();
    if (f.startsWith("10_current_")) return 0;
    if (f.includes("people")) return 1;
    if (f.startsWith("30_pdf_text_")) return 2;
    if (f.startsWith("00_latest_")) return 3;
    if (f.startsWith("99_full_")) return 4;
    if (f.startsWith("90_archive_")) return 9;
    return 6;
  };

  // flatten chunks from results; keep filename+score
  const flat = [];
  for (const it of items) {
    const filename = it?.filename || "";
    const score = typeof it?.score === "number" ? it.score : 0;
    const chunks = Array.isArray(it?.content) ? it.content : [];
    const text = chunks
      .map((c) => (c?.type === "text" ? c?.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) continue;

    flat.push({
      filename,
      score,
      prio: priority(filename),
      text,
    });
  }

  // sort: priority, score desc
  flat.sort((a, b) => a.prio - b.prio || (b.score - a.score));

  // keep unique-ish by filename first, but allow multiple if relevant
  let total = 0;
  for (const x of flat) {
    const snippet = x.text.slice(0, 2400);
    if (!snippet) continue;
    if (total + snippet.length > maxCharsTotal) continue;

    out.push({
      filename: x.filename,
      score: x.score,
      text: snippet,
    });

    total += snippet.length;
    if (out.length >= maxChunks) break;
  }

  return out;
}

function buildContextBlock(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC} (výběr relevantních úryvků):\n---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${typeof c.score === "number" ? c.score.toFixed(3) : "?"})\n`;
    ctx += `${fixLinksInText(c.text)}\n---\n`;
  });
  return ctx.trim();
}

function systemPrompt() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC}.\n` +
    `Rok je 2026. Nikdy netvrď, že něco probíhá/je aktuální, pokud je to zjevně v minulosti.\n\n` +
    `Pracuj PŘEDEVŠÍM s aktuálním souborem 10_CURRENT_* a složkou people.\n` +
    `ARCHIVE (90_*) používej jen pokud se uživatel ptá výslovně na historii/starší verze.\n\n` +
    `Odpovídej přirozeně a užitečně (ne jako vyhledávač), ale bez vymýšlení.\n` +
    `Pokud odpověď nejde z kontextu doložit, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Formát:\n` +
    `- 1–6 krátkých bodů nebo 1–4 věty\n` +
    `- Potom "Odkazy:" a 1–3 přímé odkazy (bez /seniori/)\n\n` +
    `Citace:\n` +
    `- Pokud uživatel chce přesnou citaci (1–2 věty), cituj jen když je citovaný text přímo v kontextu.\n` +
    `- Když přesná citace v kontextu není, řekni to a dej odkaz na dokument.\n`
  );
}

function userWantsQuote(q) {
  const s = normalizeCzech(q);
  return /\b(cituj|citace|zkopiruj|presnou vetu|přesnou větu|odcituj)\b/.test(s);
}

// Responses API output parsing (robust)
function extractResponseText(respJson) {
  // Newer Responses format often includes output_text at top-level convenience; but keep fallback parsing.
  if (typeof respJson?.output_text === "string" && respJson.output_text.trim()) return respJson.output_text.trim();

  const out = Array.isArray(respJson?.output) ? respJson.output : [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      const text = item.content
        .map((c) => (c?.type === "output_text" ? c.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
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
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
        ],
      }),
    },
    apiKey
  );

  const text = extractResponseText(resp);
  return text || HARD_FALLBACK;
}

function cleanAnswer(t) {
  let s = String(t || "");

  // Remove file_search citation tokens if any
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // Normalize seniors links + remove kshow
  s = fixLinksInText(s);

  // whitespace
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
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // Multi-query presearch (helps a LOT)
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec Radim`;
    const q4 = userWantsQuote(userQ) ? `${userQ} článek odstavec vyhláška` : `${userQ} vyhláška`;

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: [q1, q2, q3, q4],
        maxNumResults: 28,
        rewriteQuery: true,
        scoreThreshold: 0.08,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, { maxChunks: 14, maxCharsTotal: 14000 });

    if (!chunks.length) return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });

    const contextBlock = buildContextBlock(chunks);

    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);

    // If model starts to “blábolit obecně”, slam fallback.
    const bad = /(pravděpodobně|nejsem si jist|zkuste|doporučuji kontaktovat(?!.*Odkazy:))/i.test(answer);
    if (bad) answer = HARD_FALLBACK;

    // Ensure it never returns empty
    if (!answer.trim()) answer = HARD_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}