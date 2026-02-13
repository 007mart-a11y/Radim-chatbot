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
  { vectorStoreId, query, maxNumResults = 20, rewriteQuery = true, scoreThreshold = 0.12 },
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

    out.push({
      filename,
      score,
      text,
    });
  }
  return out;
}

// Prefer LATEST / PDF_TEXT / PEOPLE / FULL
function boostScoreByFilename(filename, baseScore) {
  const f = (filename || "").toLowerCase();
  let boost = 0;
  if (f.includes("00_latest")) boost += 0.22;
  if (f.includes("30_pdf_text")) boost += 0.30;
  if (f.includes("00_people")) boost += 0.28;
  if (f.includes("99_full")) boost += 0.10;
  return baseScore + boost;
}

// For “fees / vyhlaska / odpady / psi” strongly prefer PDF_TEXT + LATEST
function isLawFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(vyhlask|ozv|pravni predpis|mistni poplatek|poplatek|odpad|odpady|pes|psi|psu|psů)\b/.test(s);
}
function wantsExactQuote(q) {
  const s = normalizeCzech(q);
  return /\b(zkopiruj|cituj|presnou vetu|doslovn|odstavec|clanek)\b/.test(s);
}

function pickTopContext(chunks, userQ, limitChars = 14000) {
  // sort by boosted score desc
  const sorted = [...chunks].sort((a, b) => boostScoreByFilename(b.filename, b.score) - boostScoreByFilename(a.filename, a.score));

  // If law/fees: force at least some PDF_TEXT / LATEST in the front if present
  const preferLaw = isLawFeeQuestion(userQ);
  let ordered = sorted;

  if (preferLaw) {
    const pdf = sorted.filter((c) => (c.filename || "").toLowerCase().includes("30_pdf_text"));
    const latest = sorted.filter((c) => (c.filename || "").toLowerCase().includes("00_latest"));
    const rest = sorted.filter(
      (c) =>
        !(c.filename || "").toLowerCase().includes("30_pdf_text") &&
        !(c.filename || "").toLowerCase().includes("00_latest")
    );
    ordered = [...pdf, ...latest, ...rest];
  }

  const used = [];
  let total = 0;

  const seenSig = new Set();
  for (const c of ordered) {
    const snippet = c.text.slice(0, 2600);
    const sig = `${c.filename}::${snippet.slice(0, 200)}`;
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);

    const block = `[#] ${c.filename || "soubor"} (score:${c.score.toFixed(3)})\n${snippet}\n`;
    if (total + block.length > limitChars) break;
    used.push(block);
    total += block.length;
  }

  return used.join("\n---\n").trim();
}

function extractUrls(text) {
  const set = new Set();
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let m;
  while ((m = re.exec(String(text || "")))) set.add(m[0]);
  return [...set];
}

function normalizeLinksToNonSenior(url) {
  // force non-senior version
  return String(url || "").replace("https://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
}

function cleanAnswer(t) {
  let s = String(t || "");

  // remove file_search citation brackets
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // de-seniorize links in body
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
}

function systemPrompt(userQ, allowedLinks) {
  const quoteMode = wantsExactQuote(userQ);

  return (
    `Jsi chytrý a praktický AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej primárně z poskytnutého kontextu (oficiální podklady obce: LATEST/FULL/PDF_TEXT/PEOPLE).\n` +
    `Když něco není v kontextu dohledatelné, normálně to přiznej a napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `POKYNY K ODPOVĚDI:\n` +
    `- buď věcný, ale "lidský" (ne vyhledávač)\n` +
    `- u částek a vyhlášek dej přesné číslo + kde je uvedeno (článek/odstavec) pokud to kontext obsahuje\n` +
    (quoteMode
      ? `- uživatel chce DOSLOVNOU citaci: vrať max 2 věty doslova z kontextu (nic navíc)\n`
      : `- dej stručné shrnutí + na konci 1–3 odkazy\n`) +
    (allowedLinks.length
      ? `\nPOVOLENÉ ODKAZY (používej ideálně tyto):\n- ${allowedLinks.slice(0, 12).join("\n- ")}\n`
      : "")
  );
}

async function generateAnswer({ userMessage, contextText, allowedLinks }, apiKey) {
  // Responses API: nejjednodušší je číst output_text (oficiální způsob).  [oai_citation:1‡OpenAI Developers](https://developers.openai.com/api/docs/)
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5-mini",
        temperature: 0.25,
        input: [
          { role: "system", content: systemPrompt(userMessage, allowedLinks) },
          {
            role: "user",
            content:
              `KONTEXT (výběr relevantních úryvků):\n` +
              `${contextText}\n\n` +
              `DOTAZ UŽIVATELE:\n${userMessage}\n`,
          },
        ],
      }),
    },
    apiKey
  );

  const text = String(resp?.output_text || "").trim();
  return text || HARD_FALLBACK;
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

    // Multi-query presearch (lepší recall)
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec Radim`;
    const q4 = isLawFeeQuestion(userQ) ? `${userQ} článek odstavec výše poplatku` : null;
    const queries = [q1, q2, q3, q4].filter(Boolean);

    const search = await vectorSearch(
      { vectorStoreId, query: queries, maxNumResults: 28, rewriteQuery: true, scoreThreshold: 0.10 },
      apiKey
    );

    const chunks = flattenChunks(search);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextText = pickTopContext(chunks, userQ, 15000);
    const allowedLinks = extractUrls(contextText).map(normalizeLinksToNonSenior);

    let answer = await generateAnswer({ userMessage: userQ, contextText, allowedLinks }, apiKey);
    answer = cleanAnswer(answer);

    // nikdy nenechat prázdnou odpověď
    if (!answer) answer = HARD_FALLBACK;

    // když model začne mlžit, jemně ho zarazíme (ale ne “striktně”)
    if (/(pravděpodobně|nejsem si jist|mohlo by|zkuste)/i.test(answer)) {
      // pokud to není jasně opřené o kontext, radši fallback
      answer = HARD_FALLBACK;
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}