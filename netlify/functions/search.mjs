// netlify/functions/search.mjs (v6 - SIMPLE, retrieval-first, robust, #debug)
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string, history?: {role:"user"|"assistant", content:string}[] }
// Response: { ok:true, answer:string, thread_id:string, links?: string[], debug?: any }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

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

function stripSeniors(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/^\/seniori\//, "/");
    return u.toString();
  } catch {
    return String(url || "").replace("https://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
  }
}

function extractLinks(text) {
  const s = String(text || "");
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    let u = m[0].replace(/[),.;]+$/g, "");
    u = stripSeniors(u);
    if (u.includes("obec-radim.cz")) out.add(u);
  }
  return Array.from(out);
}

function isQuoteRequest(q) {
  const t = normalizeCzech(q);
  return /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t);
}

function isPdfIntent(q) {
  const t = normalizeCzech(q);
  return /(vyhlask|narizen|poplatek|odpad|psy|psu|castka|sazba|splatnost|cl\.|clanek|odstavec|pdf)/i.test(t);
}

function isPeopleIntent(q) {
  const t = normalizeCzech(q);
  return /(kdo je|starost|mistostarost|kontakt|telefon|email|e-mail)/i.test(t);
}

function isAccountingQuery(q) {
  const t = normalizeCzech(q);
  return /(rozvaha|ucetni|ucetnict|zaverecny ucet|vykaz)/i.test(t);
}

function isAccountingNoise(text) {
  const t = normalizeCzech(text).slice(0, 5000);
  return /(rozvaha|pasiva|aktiva|ucetni obdobi|synteticky ucet|brutto|netto|korekce|uzemni samospravne celky|vykaz)/i.test(t);
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...OPENAI_BETA_HEADER,
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

async function vectorSearch({ vectorStoreId, query, maxNumResults, scoreThreshold }, apiKey) {
  // IMPORTANT: query MUST be a STRING (ne array)
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

function getFilename(it) {
  return it?.filename || it?.file?.filename || it?.file?.name || "";
}

function flattenChunkText(it) {
  const chunks = Array.isArray(it?.content) ? it.content : [];
  return chunks
    .map((c) => (c?.type === "text" ? c?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pickChunks(searchJson, userQ, limit = 20) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];

  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const score = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.length > 60)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const seen = new Set();

  for (const r of ranked) {
    // odfiltruj účetní bordel, pokud dotaz není účetní
    if (!isAccountingQuery(userQ) && isAccountingNoise(r.text)) continue;

    const key = (r.filename || "") + "::" + r.text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      filename: r.filename,
      score: Number.isFinite(r.score) ? Number(r.score.toFixed(3)) : null,
      text: r.text,
    });
    if (out.length >= limit) break;
  }

  return out;
}

function systemPrompt(userQ) {
  const quote = isQuoteRequest(userQ);
  const pdf = isPdfIntent(userQ);
  const people = isPeopleIntent(userQ);

  return (
    `Jsi AI asistent obce ${OBEC}. Odpovídej POUZE podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Pokud informace v kontextu není, odpověz přesně: "${HARD_FALLBACK}"\n\n` +
    `Pravidla:\n` +
    `- Odpověz stručně (1–8 bodů).\n` +
    `- VŽDY přilož odkaz, pokud je v kontextu (stránka nebo PDF).\n` +
    `- Nepoužívej odkazy se "/seniori/".\n` +
    (pdf ? `- U vyhlášek/poplatků najdi částku + článek/odstavec a přilož odkaz na PDF.\n` : ``) +
    (people ? `- U kontaktů uveď jméno + telefon + email, pokud jsou v kontextu, a přilož odkaz na zdroj.\n` : ``) +
    (quote
      ? `- Uživatel chce citaci: zkopíruj max 2 věty PŘESNĚ z kontextu (bez parafráze) a připiš (Zdroj: soubor, čl./odst.).\n`
      : ``)
  );
}

function buildContext(chunks, userQ) {
  const quote = isQuoteRequest(userQ);

  // větší cap pro citace
  const cap = quote ? 8000 : 4500;

  let ctx =
    `KONTEXT – OFICIÁLNÍ PODKLADY OBCE ${OBEC}\n` +
    `Pozn.: odkazy uváděj bez "/seniori/".\n` +
    `---\n`;

  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${t}\n---\n`;
  });

  return ctx.trim();
}

function extractResponseText(resp) {
  const out = [];
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) out.push(resp.output_text.trim());

  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if ((c?.type === "output_text" || c?.type === "text") && c?.text) out.push(String(c.text));
      }
    }
    if (item?.type === "output_text" && item?.text) out.push(String(item.text));
  }

  return out.join("\n").trim();
}

function cleanAnswer(t) {
  let s = String(t || "");
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function isBadAnswer(a) {
  const s = String(a || "").trim();
  if (!s) return true;
  if (s === "Bez odpovědi") return true;
  if (/od\s+do\s+\./i.test(s)) return true; // "od  do ."
  return false;
}

async function generateAnswer({ userMessage, contextBlock, history, temperature }, apiKey) {
  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

  const input = [
    { role: "system", content: systemPrompt(userMessage) },
    ...safeHistory.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 2000),
    })),
    { role: "user", content: `${contextBlock}\n\nDOTAZ:\n${userMessage}` },
  ];

  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature,
        input,
      }),
    },
    apiKey
  );

  return extractResponseText(resp);
}

// Query expansion => JEDEN string (ne pole)
function buildQueryString(userQ) {
  const q = userQ.trim();
  const qNorm = normalizeCzech(q);
  const pdf = isPdfIntent(q);
  const quote = isQuoteRequest(q);

  let extra = ` obec ${OBEC}`;
  if (pdf) extra += ` vyhláška poplatek částka Kč článek odstavec sazba splatnost`;
  if (quote) extra += ` přesná citace dvě věty`;
  return `${q}\n${qNorm}\n${extra}`.trim();
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
    const rawMessage = body?.message;

    if (!rawMessage || typeof rawMessage !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const debug = rawMessage.trim().startsWith("#debug");
    const userQ = rawMessage.trim().replace(/^#debug\s*/i, "").trim();

    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;
    const history = Array.isArray(body?.history) ? body.history : null;

    const quote = isQuoteRequest(userQ);
    const pdf = isPdfIntent(userQ);

    // SEARCH
    const queryString = buildQueryString(userQ);
    const maxNumResults = quote ? 70 : pdf ? 60 : 45;
    const scoreThreshold = quote ? 0.04 : 0.07;

    const search = await vectorSearch(
      { vectorStoreId, query: queryString, maxNumResults, scoreThreshold },
      apiKey
    );

    // CHUNKS
    const chunkLimit = quote ? 28 : pdf ? 24 : 20;
    const chunks = pickChunks(search, userQ, chunkLimit);

    if (!chunks.length) {
      return jsonResponse(200, {
        ok: true,
        answer: HARD_FALLBACK,
        thread_id: threadId,
        links: [],
        ...(debug ? { debug: { queryString, maxNumResults, scoreThreshold, chunks: [] } } : {}),
      });
    }

    const contextBlock = buildContext(chunks, userQ);

    // GENERATE
    const temperature = quote ? 0.0 : 0.1;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, history, temperature }, apiKey);
    answer = cleanAnswer(answer);

    if (isBadAnswer(answer)) {
      const retryCtx =
        contextBlock +
        `\n\nDODATEK: Odpověz konkrétně. Pokud je v kontextu odkaz, přilož ho. Pokud údaj chybí, vrať fallback větu doslova.`;
      let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryCtx, history, temperature }, apiKey);
      retry = cleanAnswer(retry);
      answer = isBadAnswer(retry) ? HARD_FALLBACK : retry;
    }

    const links = Array.from(
      new Set([
        ...chunks.flatMap((c) => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 12);

    return jsonResponse(200, {
      ok: true,
      answer,
      thread_id: threadId,
      links,
      ...(debug
        ? {
            debug: {
              vectorStoreId,
              queryString,
              maxNumResults,
              scoreThreshold,
              picked: chunks.map((c) => ({
                file: c.filename,
                score: c.score,
                preview: (c.text || "").slice(0, 240),
              })),
            },
          }
        : {}),
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}
