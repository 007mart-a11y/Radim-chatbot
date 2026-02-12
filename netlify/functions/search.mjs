// netlify/functions/search.mjs
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request:  { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

// tvrdý fallback text – přesně jak chceš
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

// důležité: vector store / assistants v2 header (pro search endpointy)
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

// ---------- helpers ----------
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
  { vectorStoreId, query, maxNumResults = 22, rewriteQuery = true, scoreThreshold = 0.12 },
  apiKey
) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...OPENAI_BETA_HEADER,
      },
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

// ---------- query expansion ----------
function buildQueryPack(userQ) {
  const q = String(userQ || "").trim();
  const qNorm = normalizeCzech(q);

  // “intent hints” – hlavně poplatky/odpady/vyhlášky
  const hints = [];
  const n = qNorm;

  const isFees =
    /\b(poplatek|poplatky|sazba|castka|cena|kolik se plati|kolik stoji)\b/.test(n) ||
    /\b(pes|psu|odpad|odpady|bioodpad)\b/.test(n);

  const isDecree =
    /\b(vyhlaska|ozv|narizeni|uredni deska|usneseni|zverejneno|vyveseno)\b/.test(n);

  if (isFees) {
    hints.push("místní poplatek", "sazba", "částka", "vyhláška", "OZV", "odpadové hospodářství", "poplatek ze psů");
  }
  if (/\bpes|psu|psů\b/.test(n)) {
    hints.push("místní poplatek ze psů", "OZV poplatek ze psů", "vyhláška poplatek ze psů");
  }
  if (/\bodpad|odpady\b/.test(n)) {
    hints.push("poplatek za obecní systém odpadového hospodářství", "OZV odpad", "vyhláška odpadové hospodářství");
  }
  if (isDecree) {
    hints.push("úřední deska", "vyhláška", "nařízení");
  }

  // prefer PDF text souborů: přidej dotazy, které “trefí” PDFTEXT soubor
  // (v PDFTEXT souboru jsou hlavičky typu PDF_TYPE / PDF_URL / CONTENT)
  const pdfBias = [
    `${q} PDF_URL`,
    `${q} PDF_TYPE`,
    `${q} CONTENT`,
    `${q} VYHLÁŠKA`,
    `${q} NAŘÍZENÍ`,
    `${q} OZV`,
  ];

  // prefer LATEST soubor (obsahuje “LATEST”, “DOC |”, “PAGE |”)
  const latestBias = [
    `${q} DOC |`,
    `${q} PAGE |`,
    `${q} LATEST`,
    `${q} úřední deska`,
  ];

  const expanded = [
    q,
    qNorm,
    `${q} obec Radim`,
    ...pdfBias,
    ...latestBias,
    ...hints.map((h) => `${q} ${h}`),
  ];

  // odduplikace + limit
  const seen = new Set();
  const out = [];
  for (const x of expanded) {
    const s = String(x || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 16) break;
  }
  return out;
}

// ---------- chunk picking / ranking ----------
function filePriority(filename) {
  const f = String(filename || "").toLowerCase();
  // nejdřív PDF texty (částky a pravidla), pak LATEST, pak FULL
  if (f.includes("30_pdf_text_obec_radim")) return 0;
  if (f.includes("00_latest_obec_radim")) return 1;
  if (f.includes("99_full_obec_radim")) return 2;
  // people file nebo ostatní
  if (f.includes("people") || f.includes("00_people")) return 3;
  return 4;
}

function pickTopChunks(searchJson, limit = 12) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const all = [];

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

    all.push({
      filename,
      score,
      text,
      prio: filePriority(filename),
    });
  }

  // řazení: priority souboru, pak score desc
  all.sort((a, b) => {
    if (a.prio !== b.prio) return a.prio - b.prio;
    const sa = typeof a.score === "number" ? a.score : -1;
    const sb = typeof b.score === "number" ? b.score : -1;
    return sb - sa;
  });

  // “1 soubor = max 3 chunky” (aby to nebylo celé z jednoho místa)
  const perFileCount = new Map();
  const out = [];
  for (const c of all) {
    const key = c.filename || "unknown";
    const n = perFileCount.get(key) || 0;
    if (n >= 3) continue;
    perFileCount.set(key, n + 1);

    out.push({
      filename: c.filename,
      score: c.score,
      text: c.text.slice(0, 2600), // bezpečně krátké
    });
    if (out.length >= limit) break;
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

// ---------- prompts ----------
function systemPromptAnswer() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš POUZE z poskytnutého kontextu (úryvky z oficiálních podkladů obce).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Pokud odpověď nelze z kontextu JEDNOZNAČNĚ doložit, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `Styl:\n` +
    `- stručně a věcně\n` +
    `- pokud jde o částky/poplatky: uveď přesnou sazbu a podmínky (pokud jsou v kontextu)\n` +
    `- pokud je dotaz nejasný a v kontextu je více možností: polož 1 doplňující otázku\n`
  );
}

// audit prompt – tvrdě zkontroluje oporu v kontextu
function systemPromptAudit() {
  return (
    `Jsi kontrolor (audit) odpovědi AI asistenta obce ${OBEC_NAZEV}.\n` +
    `Dostaneš: (1) kontext, (2) návrh odpovědi.\n` +
    `Úkol: rozhodni, zda je odpověď plně podložená kontextem.\n` +
    `Pokud NE, vrať přesně: "${HARD_FALLBACK}".\n` +
    `Pokud ANO, vrať původní odpověď beze změn.\n` +
    `Zakázáno: dohady, obecné rady, domýšlení.\n`
  );
}

// ---------- model calls ----------
async function responsesCall({ system, user }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
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

  return text || "";
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  const draft = await responsesCall(
    {
      system: systemPromptAnswer(),
      user: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}`,
    },
    apiKey
  );

  // audit: buď vrátí stejnou odpověď, nebo HARD_FALLBACK
  const audited = await responsesCall(
    {
      system: systemPromptAudit(),
      user: `KONTEXT:\n${contextBlock}\n\nNÁVRH ODPOVĚDI:\n${draft}`,
    },
    apiKey
  );

  return audited || HARD_FALLBACK;
}

// ---------- post-processing ----------
function cleanAnswer(t) {
  let s = String(t || "");

  // pryč se zbytky citací ve formátu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // úklid whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
}

function extractUrlsFromText(text, max = 3) {
  const s = String(text || "");
  const urls = s.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    const clean = u.replace(/[),.;]+$/g, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function ensureLinks(answer, contextBlock) {
  const a = String(answer || "").trim();
  if (!a || a === HARD_FALLBACK) return a;

  const existing = extractUrlsFromText(a, 10);
  if (existing.length) return a; // už má odkazy

  // zkus vytáhnout URL z kontextu (v PDFTEXT máme PDF_URL / přímé linky)
  const ctxUrls = extractUrlsFromText(contextBlock, 3);
  if (!ctxUrls.length) return a;

  return `${a}\n\nOdkazy:\n- ${ctxUrls.join("\n- ")}`.trim();
}

function looksBad(answer) {
  const a = String(answer || "");
  // tyhle fráze nechceme (když se objeví, je to skoro vždy “halucinace”)
  return /(doporučuji kontaktovat|nejsem si jist|pravděpodobně|mohlo by|zkuste|obecně platí)/i.test(a);
}

// ---------- handler ----------
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

    // RESET (kompatibilita)
    if (userQ.toLowerCase() === "reset") {
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: `thread_local_${Date.now()}` });
    }

    // 1) PŘEDVYHLEDÁVÁNÍ (chytřejší multi-query)
    const queryPack = buildQueryPack(userQ);

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: queryPack,
        maxNumResults: 26,
        rewriteQuery: true,
        scoreThreshold: 0.12,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, 12);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 2) ODPOVĚĎ jen z kontextu + audit opory
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);

    // extra bezpečnost: pokud to vypadá jako obecné kecy → fallback
    if (looksBad(answer)) answer = HARD_FALLBACK;

    // 3) doplnění odkazů, když nejsou v odpovědi
    answer = ensureLinks(answer, contextBlock);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}