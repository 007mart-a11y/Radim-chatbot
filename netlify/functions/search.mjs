// netlify/functions/search.mjs (v6 - SIMPLE + ROBUST + #debug)
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, history?: {role:"user"|"assistant", content:string}[] }
// Response: { ok:true, answer:string, links:string[], debug?: {...} }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

const OBEC = "Radim";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    // vyhoď tracking
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].forEach(k => x.searchParams.delete(k));
    // seniors pryč
    x.pathname = x.pathname.replace(/^\/seniori\//, "/");
    return x.toString();
  } catch {
    return String(u || "").replace("https://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
  }
}

function extractLinks(text) {
  const s = String(text || "");
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    let u = m[0].replace(/[),.;]+$/g, "");
    if (!u.includes("obec-radim.cz")) continue;
    out.add(normalizeUrl(u));
  }
  return Array.from(out);
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...OPENAI_BETA_HEADER,
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }
  return json ?? {};
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

// Sloučíme dotaz do 1 stringu = stabilní
function buildQuery(userQ) {
  const q = String(userQ || "").trim();
  const extra =
    /bioodpad|skladka|hřbitov|parcela|kn\s*699/i.test(q) ? " skládka bioodpadu parcela KN 699 hřbitov" :
    /odpad|poplatek|vyhl[aá]šk/i.test(q) ? " obecně závazná vyhláška článek sazba splatnost Kč PDF" :
    /úřední hodiny|kontakty|telefon|email|datov[aá]\s*schr[aá]nk/i.test(q) ? " povinné informace kontakty úřední hodiny" :
    "";
  return `${q} obec ${OBEC}${extra}`.trim();
}

async function vectorSearch(vectorStoreId, queryString, apiKey, maxNumResults = 30) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: queryString,                 // !!! STRING, ne pole
        rewrite_query: true,
        max_num_results: maxNumResults,
        // score_threshold radši nízko/žádný – nebudeme si uřezávat výsledky
        ranking_options: { ranker: "auto", score_threshold: 0.0 },
      }),
    },
    apiKey
  );
}

function pickTop(searchJson, limit = 14) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const score = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.length > 40)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  // lehký dedupe
  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const k = (r.filename || "") + "::" + r.text.slice(0, 160);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function systemPrompt(isQuote) {
  return [
    `Jsi AI asistent obce ${OBEC}.`,
    `Odpovídej POUZE podle poskytnutého KONTEXTU. Nevymýšlej fakta.`,
    `Když údaj v kontextu není, napiš přesně: "${HARD_FALLBACK}"`,
    `Vždy přidej odkaz, pokud je v kontextu URL na stránku nebo PDF.`,
    `Nikdy nepoužívej odkazy se "/seniori/".`,
    isQuote ? `Uživatel chce citaci: zkopíruj max 2 věty PŘESNĚ z kontextu (bez parafráze).` : ``,
  ].filter(Boolean).join("\n");
}

function buildContext(chunks) {
  // Nezbytečně dlouhé – ale dostatečné
  const cap = 5000;
  let ctx = `KONTEXT (oficiální podklady obce ${OBEC}):\n\n`;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score ${Number(c.score || 0).toFixed(3)})\n${t}\n\n`;
  });
  return ctx.trim();
}

async function generateAnswer(apiKey, userQ, contextBlock, history, temperature = 0.1) {
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];

  const input = [
    { role: "system", content: systemPrompt(/(cituj|odcituj|zkopiruj|max\s*2\s*vety)/i.test(userQ)) },
    ...safeHistory.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 1800),
    })),
    { role: "user", content: `${contextBlock}\n\nDOTAZ:\n${userQ}` },
  ];

  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature,
        input,
      }),
    },
    apiKey
  );

  // vytáhni text
  const parts = [];
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) parts.push(resp.output_text.trim());
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && c?.text) parts.push(String(c.text));
        if (c?.type === "text" && c?.text) parts.push(String(c.text));
      }
    }
    if (item?.type === "output_text" && item?.text) parts.push(String(item.text));
  }

  return parts.join("\n").trim();
}

function cleanAnswer(a) {
  let s = String(a || "").trim();
  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  // seniors odkazy pryč
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s || s === "Bez odpovědi") return "";
  return s;
}

function isBad(ans) {
  const a = String(ans || "").trim();
  if (!a) return true;
  if (a === "Bez odpovědi") return true;
  // rozbité hodiny "od  do ."
  if (/od\s+do\s+\./i.test(a)) return true;
  return false;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    if (!apiKey) return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return json(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    let message = body?.message;
    if (!message || typeof message !== "string") return json(400, { ok: false, error: "Missing message" });

    const raw = message.trim();
    const debugMode = raw.toLowerCase().startsWith("#debug");
    const userQ = debugMode ? raw.replace(/^#debug\s*/i, "").trim() : raw;

    const queryString = buildQuery(userQ);

    // 1) Vector search
    const search = await vectorSearch(vectorStoreId, queryString, apiKey, 34);

    // 2) Pick top chunks
    const chunks = pickTop(search, debugMode ? 18 : 14);

    if (!chunks.length) {
      return json(200, { ok: true, answer: HARD_FALLBACK, links: [], ...(debugMode ? { debug: { queryString, chunks: [] } } : {}) });
    }

    const contextBlock = buildContext(chunks);

    // 3) Generate answer
    let answer = await generateAnswer(apiKey, userQ, contextBlock, body?.history, 0.1);
    answer = cleanAnswer(answer);

    // 4) Retry if garbage
    if (isBad(answer)) {
      const retryCtx = contextBlock + `\n\nDODATEK: Odpověz konkrétně a přilož odkaz ze zdrojů. Pokud údaj chybí, vrať fallback větu doslova.`;
      let retry = await generateAnswer(apiKey, userQ, retryCtx, body?.history, 0.0);
      retry = cleanAnswer(retry);
      answer = isBad(retry) ? HARD_FALLBACK : retry;
    }

    // 5) Links from chunks + answer
    const links = Array.from(new Set([
      ...chunks.flatMap(c => extractLinks(c.text)),
      ...extractLinks(answer),
    ])).slice(0, 12);

    const resp = { ok: true, answer, links };

    if (debugMode) {
      resp.debug = {
        queryString,
        top: chunks.slice(0, 8).map((c) => ({
          file: c.filename,
          score: Number(c.score || 0).toFixed(3),
          preview: (c.text || "").slice(0, 220).replace(/\s+/g, " ").trim(),
          links: extractLinks(c.text).slice(0, 4),
        })),
      };
    }

    return json(200, resp);
  } catch (e) {
    return json(500, { ok: false, error: "Server error", details: e?.message || String(e) });
  }
}