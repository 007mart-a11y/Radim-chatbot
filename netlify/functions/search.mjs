// netlify/functions/search.mjs
// Node 18+
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

// Vector Store Search
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 30, rewriteQuery = true, scoreThreshold = 0.1 },
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
          score_threshold: scoreThreshold,
        },
      }),
    },
    apiKey
  );
}

function isQuoteRequest(q) {
  const s = normalizeCzech(q);
  return /\b(cituj|zcopyruj|zkopiruj|presnou vetu|presny text|doslova|max\s*\d+\s*vety|clanek|odstavec)\b/.test(s);
}

function isDogFee(q) {
  const s = normalizeCzech(q);
  return /\b(poplatek)\b/.test(s) && /\b(pes|psy|psu|psů)\b/.test(s);
}

function isWasteFee(q) {
  const s = normalizeCzech(q);
  return /\b(poplatek)\b/.test(s) && /\b(odpad|odpadu|odpadoveho|odpadového)\b/.test(s);
}

function isBylawLike(q) {
  const s = normalizeCzech(q);
  return /\b(vyhlaska|vyhlasky|obecne zavazna|ozv|narizeni|pravni predpis)\b/.test(s);
}

function wantsLatest(q) {
  const s = normalizeCzech(q);
  return /\b(nejnovejsi|nejnovější|posledni|poslední|aktualni|aktuální|dnes)\b/.test(s);
}

function looksLikePeople(q) {
  const s = normalizeCzech(q);
  return /\b(starosta|starostka|mistostarosta|mistostarostka|predseda|predsedkyne|tajemnik|spravce|správce|kontakt)\b/.test(s);
}

function scoreNum(x) {
  return typeof x === "number" ? x : 0;
}

function pickTopChunks(searchJson, userQ, limit = 14) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  if (!items.length) return [];

  const qQuote = isQuoteRequest(userQ);
  const qDog = isDogFee(userQ);
  const qWaste = isWasteFee(userQ);
  const qBylaw = isBylawLike(userQ);

  // preferuj PDFTEXT pro vyhlášky / poplatky / citace
  const preferPdfText = qQuote || qBylaw || qDog || qWaste;

  const expanded = [];
  for (const it of items) {
    const filename = it?.filename || "";
    const score = scoreNum(it?.score);
    const chunks = Array.isArray(it?.content) ? it.content : [];

    const text = chunks
      .map((c) => (c?.type === "text" ? c?.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) continue;

    const isPdfText = /30_PDF_TEXT_/i.test(filename);
    const isLatest = /00_LATEST_/i.test(filename);
    const isPeople = /00_PEOPLE_/i.test(filename);

    let boost = 0;
    if (preferPdfText && isPdfText) boost += 0.25;
    if (wantsLatest(userQ) && isLatest) boost += 0.2;
    if (looksLikePeople(userQ) && isPeople) boost += 0.2;

    // penalizuj územní plán / OUP pro poplatky
    if ((qDog || qWaste || qBylaw || qQuote) && /oup|uzemni plan|územní plán/i.test(filename)) boost -= 0.35;

    expanded.push({
      filename,
      score,
      boosted: score + boost,
      text,
    });
  }

  expanded.sort((a, b) => (b.boosted || 0) - (a.boosted || 0));

  // Context budget (abychom nepřestřelili tokens)
  const maxChars = preferPdfText ? 32000 : 24000;
  const out = [];
  let used = 0;

  for (const e of expanded) {
    // u PDFTEXT dovol delší úryvek, ať se tam vejde věta pro citaci
    const perItemLimit = /30_PDF_TEXT_/i.test(e.filename) ? 9000 : 4500;

    const slice = e.text.slice(0, perItemLimit).trim();
    if (!slice) continue;

    const nextCost = slice.length + 200;
    if (out.length >= limit) break;
    if (used + nextCost > maxChars && out.length >= 6) break; // aspoň něco nechat

    out.push({
      filename: e.filename,
      score: e.score,
      text: slice,
    });
    used += nextCost;
  }

  return out;
}

function buildContextBlock(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (relevantní úryvky):\n---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${c.text}\n---\n`;
  });
  return ctx.trim();
}

function systemPrompt(userQ) {
  const quoteMode = isQuoteRequest(userQ);

  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `Pravidla:\n` +
    `- Odpovídej POUZE z poskytnutého kontextu.\n` +
    `- Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `- Když to z kontextu nejde doložit, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Styl:\n` +
    `- stručně a věcně (1–8 bodů nebo 1–6 vět)\n` +
    `- když jde o postup, napiš kroky\n` +
    `- datum vždy DD. MM. RRRR (pokud v kontextu je)\n\n` +
    (quoteMode
      ? `Speciální režim citace:\n- Pokud uživatel chce citaci/„přesnou větu“, cituj MAX 2 věty DOSLOVA z kontextu.\n- Pokud v kontextu přesná věta není, vrať fallback.\n\n`
      : "")
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
          { role: "system", content: systemPrompt(userMessage) },
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
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

function forceNonSeniorUrls(t) {
  // všechno /seniori/ přesměruj na klasiku
  return String(t || "")
    .replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/")
    .replace(/https:\/\/obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/");
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace ve formátu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // nepouštěj ven názvy interních souborů jako „odkazy“
  s = s.replace(/^\s*-\s*00_PEOPLE_[^\n]+\n?/gim, "");
  s = s.replace(/^\s*00_PEOPLE_[^\n]+\n?/gim, "");

  s = forceNonSeniorUrls(s);

  // úklid whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
}

function badGeneralAdvice(answer) {
  // jemné – jen očividné kecy
  return /(pravděpodobně|mohlo by|nejsem si jist|zkuste si dohledat)/i.test(answer);
}

function buildQueries(userQ) {
  const q = String(userQ || "").trim();
  const n = normalizeCzech(q);

  const queries = [
    q,
    n,
    `${q} obec Radim`,
  ];

  // ROUTING pro poplatky/vyhlášky → donutit retrieval do PDFTEXT a správných dokumentů
  if (isDogFee(q) || (isBylawLike(q) && /ps/i.test(n))) {
    queries.push(
      "místní poplatek ze psů Radim vyhláška článek sazba",
      "2026 mistni poplatek ze psu Radim",
      "obsah520_1 poplatek ze psů 150"
    );
  }

  if (isWasteFee(q) || (isBylawLike(q) && /odpad/i.test(n))) {
    queries.push(
      "místní poplatek za obecní systém odpadového hospodářství Radim vyhláška sazba",
      "2026 mistni poplatek odpad Radim",
      "obsah521_1 poplatek odpad částka"
    );
  }

  if (isQuoteRequest(q)) {
    queries.push(`${q} citace`, `${q} přesná věta`, `${q} článek odstavec`);
  }

  if (looksLikePeople(q)) {
    queries.push("starosta obce Radim kontakt", "starostka Radim telefon email");
  }

  if (wantsLatest(q)) {
    queries.push("00_LATEST Radim úřední deska nejnovější", "nejnovější vyvěšeno Radim úřední deska");
  }

  // odduplikuj
  return Array.from(new Set(queries.map((x) => x.trim()).filter(Boolean)));
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

    // 1) PŘEDVYHLEDÁVÁNÍ (smarter multi-query)
    const queries = buildQueries(userQ);

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: queries,
        maxNumResults: 40,
        rewriteQuery: true,
        scoreThreshold: 0.1,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, userQ, 14);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 2) ODPOVĚĎ jen z kontextu
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);

    if (badGeneralAdvice(answer)) answer = HARD_FALLBACK;

    // poslední jistota: žádné seniors odkazy
    answer = forceNonSeniorUrls(answer);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}