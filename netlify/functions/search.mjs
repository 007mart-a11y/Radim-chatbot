// netlify/functions/search.mjs
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC = "Radim";

// měkký fallback (nepřísný vyhledávač, ale bez halucinací u citací)
const FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

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

function canonUrl(u) {
  let s = String(u || "");
  s = s.replace("https://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
  s = s.replace("http://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
  s = s.replace("/seniori/", "/");
  return s;
}

function canonAllUrlsInText(t) {
  // přepíše /seniori/ odkazy v celém textu
  return String(t || "").replace(/https?:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
}

function isQuoteRequest(q) {
  const s = normalizeCzech(q);
  return (
    s.includes("zkopiruj") ||
    s.includes("cituj") ||
    s.includes("presnou vetu") ||
    s.includes("doslova") ||
    s.includes("max 2 vety") ||
    s.includes("clanek") ||
    s.includes("odstavec")
  );
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

function pickTopChunks(searchJson, limit = 14) {
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
      text: canonAllUrlsInText(text).slice(0, 3800),
    });

    if (out.length >= limit) break;
  }
  return out;
}

function buildContextBlock(chunks) {
  // “sekce” – model se líp chytí
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC} (výběr relevantních částí):\n`;
  ctx += `Dnes: ${todayCZ()}\n`;
  ctx += `---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] SOUBOR: ${c.filename || "soubor"} | score: ${c.score ?? "?"}\n`;
    ctx += `${c.text}\n`;
    ctx += `---\n`;
  });
  return ctx.trim();
}

function systemPrompt(quoteMode) {
  // Nechci “striktní vyhledávač”, ale současně žádné výmysly.
  // U citací: musí to být doslova z kontextu.
  return (
    `Jsi užitečný a přirozený AI asistent obce ${OBEC}.\n` +
    `Odpovídáš POUZE podle poskytnutého kontextu (úryvky ze souborů obce: 00_LATEST, 99_FULL, 30_PDF_TEXT, people).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Pokud to v kontextu není, řekni to lidsky a stručně.\n\n` +
    `DŮLEŽITÉ:\n` +
    `- ODKAZY vždy uváděj bez /seniori/ (používej standardní web www.obec-radim.cz).\n` +
    `- U částek z vyhlášek preferuj PDF_TEXT (30_PDF_TEXT...), pokud je v kontextu.\n\n` +
    (quoteMode
      ? `REŽIM CITACE:\n` +
        `Uživatel chce citaci / přesnou větu. Vrať max 2 věty DOSLOVA z kontextu.\n` +
        `Přidej i “Kde to je:” (např. článek/odstavec), jen pokud to je v citovaném textu nebo hned vedle v kontextu.\n` +
        `Když přesnou větu v kontextu nenajdeš, napiš jen: "${FALLBACK}".\n\n`
      : ``) +
    `Styl: věcně, stručně, ale užitečně.`
  );
}

function extractResponseText(resp) {
  // robustně vytáhnout text z Responses API
  const out = Array.isArray(resp?.output) ? resp.output : [];
  let acc = "";

  for (const item of out) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && c.text) acc += (acc ? "\n" : "") + c.text;
      }
    }
  }

  // fallback – některé varianty vrací output_text přímo
  if (!acc && typeof resp?.output_text === "string") acc = resp.output_text;

  return String(acc || "").trim();
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace typu 【…†…】 (když by to někdy model vyplivl)
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // sjednotit odkazy (vyhodit /seniori/)
  s = canonAllUrlsInText(s);

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

function answerHasOnlyFallback(ans) {
  const s = normalizeCzech(ans);
  return !s || s === normalizeCzech(FALLBACK);
}

function verifyQuoteExists(answer, contextBlock) {
  // jednoduchá ochrana: pokud model tvrdí citaci v uvozovkách, musí existovat v kontextu
  // (zabrání halucinacím “citace”)
  const quotes = [];
  const re = /"([^"]{10,400})"/g;
  let m;
  while ((m = re.exec(answer)) !== null) quotes.push(m[1]);

  if (!quotes.length) return true; // když necituje v uvozovkách, nebrzdíme
  const ctx = String(contextBlock || "");
  return quotes.every((q) => ctx.includes(q));
}

async function generateAnswer({ userMessage, contextBlock, quoteMode }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: quoteMode ? 0.0 : 0.2,
        input: [
          { role: "system", content: systemPrompt(quoteMode) },
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
        ],
      }),
    },
    apiKey
  );

  return extractResponseText(resp) || FALLBACK;
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
    const q3 = `${userQ} obec ${OBEC}`;

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: [q1, q2, q3],
        maxNumResults: 22,
        rewriteQuery: true,
        scoreThreshold: 0.12,
      },
      apiKey
    );

    const chunks = pickTopChunks(search, 14);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 2) ODPOVĚĎ (citace režim jen když uživatel chce doslovno)
    const quoteMode = isQuoteRequest(userQ);
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, quoteMode }, apiKey);
    answer = cleanAnswer(answer);

    // 3) Ochrany proti nesmyslům
    // a) když chtěl citaci a citace neexistuje v kontextu -> fallback
    if (quoteMode && !verifyQuoteExists(answer, contextBlock)) {
      answer = FALLBACK;
    }

    // b) když model neodpověděl nic
    if (!answer || answerHasOnlyFallback(answer)) {
      // v “normálním” režimu zkus 1x retry s více instrukcí, ať to nepadá do ticha
      if (!quoteMode) {
        answer = await generateAnswer(
          { userMessage: userQ + "\n\nOdpověz konkrétně podle kontextu. Když je v kontextu kontakt/částka, uveď ji.", contextBlock, quoteMode: false },
          apiKey
        );
        answer = cleanAnswer(answer);
        if (!answer) answer = FALLBACK;
      } else {
        answer = FALLBACK;
      }
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}