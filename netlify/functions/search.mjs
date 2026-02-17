// netlify/functions/search.mjs (v11 - robust retrieval, no array query, never crashes)
// Node 18+
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

function parseIntent(raw) {
  const debug = /^\s*#debug\b/i.test(raw);
  const q = raw.replace(/^\s*#debug\b/i, "").trim();
  const t = normalizeCzech(q);
  return {
    debug,
    q,
    quote: /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t),
    latest: /(nejnovejs|posledn|aktualn|dnes|k\s*datu|uredni\s*desce|vyvesen|ucinn|platn)/i.test(t),
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|sazba|splatnost|ucinnost|cl\.|clanek|odstavec|kč|kc|pdf)/i.test(t),
    people: /(kdo\s*je|starost|mistostarost|kontakt|telefon|email|e-mail|predsed|tajemnik)/i.test(t),
    bio: /(bioodpad|skladka)/i.test(t),
  };
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

async function vectorSearchOne({ vectorStoreId, query, maxNumResults, scoreThreshold }, apiKey) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query, // !!! vždy STRING
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

function isAccountingNoise(text) {
  const t = normalizeCzech(text).slice(0, 7000);
  return /(rozvaha|pasiva|aktiva|synteticky ucet|uctetni obdobi|brutto|netto|korekce|vykaz|zaverecny ucet|rozpoctove opatreni|rozpis rozpoctu)/i.test(
    t
  );
}

function scoreBoost(filename, userQ, chunkText) {
  const f = (filename || "").toLowerCase();
  const it = parseIntent(userQ);

  let b = 0;
  if (it.pdfish && f.includes("30_pdf_text")) b += 0.35;
  if (it.latest && f.includes("00_latest")) b += 0.22;
  if (it.people && f.includes("people")) b += 0.25;
  if (f.includes("99_full")) b += 0.08;

  const askingAccounting = /(rozvaha|ucetni|vykaz|zaverecny ucet|rozpocet|rozpoctove opatreni)/i.test(normalizeCzech(userQ));
  if (!askingAccounting && isAccountingNoise(chunkText)) b -= 0.5;

  return b;
}

function pickTop(searchJson, userQ, limit) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const base = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      const score = base + scoreBoost(filename, userQ, text);
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.length > 80)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const key = `${r.filename}::${r.text.slice(0, 260)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filename: r.filename, score: Number(r.score.toFixed(3)), text: r.text });
    if (out.length >= limit) break;
  }
  return out;
}

// pošleme více dotazů po jednom a sloučíme data
async function searchMany({ vectorStoreId, queries, maxNumResults, scoreThreshold }, apiKey) {
  const merged = [];
  const errors = [];

  for (const q of queries) {
    try {
      const res = await vectorSearchOne({ vectorStoreId, query: q, maxNumResults, scoreThreshold }, apiKey);
      const data = Array.isArray(res?.data) ? res.data : [];
      merged.push(...data);
    } catch (e) {
      errors.push({ q, err: e?.message || String(e) });
    }
  }

  // vrátíme jako “fake searchJson”
  return { data: merged, _errors: errors };
}

// ===== PRE-EXTRACT (rychlá heuristika) =====
function preExtractSignals(texts, userQ) {
  const joined = texts.join("\n\n");

  const money = [];
  for (const m of joined.matchAll(/\b(\d{1,4}(?:[ \u00a0]?\d{3})*)\s*(Kč|kc)\b/gi)) {
    money.push(m[0].replace(/\s+/g, " ").trim());
    if (money.length >= 6) break;
  }

  const articles = [];
  for (const m of joined.matchAll(/\bčl\.?\s*\d+\b/gi)) {
    articles.push(m[0].trim());
    if (articles.length >= 4) break;
  }

  const urls = extractLinks(joined).slice(0, 8);

  return { money, articles, urls };
}

function buildBroadQueries(userQ) {
  const q = userQ.trim();
  const n = normalizeCzech(q);
  return Array.from(new Set([q, n, `${q} obec ${OBEC_NAZEV}`])).slice(0, 3);
}

function buildFocusedQueries(userQ, signals) {
  const it = parseIntent(userQ);
  const out = [userQ];

  if (it.bio) out.push(`${OBEC_NAZEV} skládka bioodpadu parcela otevřeno hřbitov`);
  if (it.pdfish) {
    const a = signals.articles?.[0] ? ` ${signals.articles[0]}` : "";
    const m = signals.money?.[0] ? ` ${signals.money[0]}` : "";
    out.push(`${OBEC_NAZEV} ${userQ} vyhláška${a}${m} sazba splatnost účinnost Kč`);
    out.push(`${OBEC_NAZEV} ${userQ} Čl. 4 sazba poplatku`);
  }
  if (it.people) out.push(`${OBEC_NAZEV} ${userQ} telefon e-mail kontakt`);

  return Array.from(new Set(out)).slice(0, 4);
}

function systemPrompt(userQ) {
  const it = parseIntent(userQ);
  return (
    `Jsi AI asistent obce ${OBEC_NAZEV}. Odpovídej pouze podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Pokud údaj není v kontextu, napiš přesně: "${HARD_FALLBACK}".\n\n` +
    `Pravidla:\n` +
    `- Stručně a prakticky.\n` +
    `- Pokud je v kontextu odkaz na stránku nebo PDF, vždy ho uveď.\n` +
    `- Nikdy nepoužívej odkazy se "/seniori/".\n` +
    (it.quote ? `- U citace: max 2 věty přesně z kontextu.\n` : ``)
  );
}

function buildContext(chunks, userQ) {
  const it = parseIntent(userQ);
  const cap = it.quote ? 7000 : it.pdfish ? 5200 : 4200;

  let body = `KONTEXT – PODKLADY OBCE ${OBEC_NAZEV}\n---\n`;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    body += `[#${i + 1}] ${c.filename} (score:${c.score})\n${t}\n---\n`;
  });
  return body.trim();
}

function extractResponseText(resp) {
  const out = [];
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) out.push(resp.output_text.trim());
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && c?.text) out.push(String(c.text));
        if (c?.type === "text" && c?.text) out.push(String(c.text));
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

function isBadAnswer(ans) {
  const a = String(ans || "").trim();
  if (!a) return true;
  if (a === "Bez odpovědi") return true;
  if (/(od\s+do\s+\.)/i.test(a)) return true;
  return false;
}

async function generateAnswer({ userMessage, contextBlock, history, temperature }, apiKey) {
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
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

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const apiKey = process.env.OPENAI_API_KEY;
  const vectorStoreId = process.env.VECTOR_STORE_ID;

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });
    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    const raw = body?.message;
    if (!raw || typeof raw !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const it = parseIntent(raw);
    const userQ = it.q;
    const history = Array.isArray(body?.history) ? body.history : null;
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // ===== BROAD =====
    const broadQueries = buildBroadQueries(userQ);
    const broadRes = await searchMany(
      { vectorStoreId, queries: broadQueries, maxNumResults: it.pdfish ? 60 : 35, scoreThreshold: it.pdfish ? 0.06 : 0.08 },
      apiKey
    );
    const broadTop = pickTop(broadRes, userQ, it.pdfish ? 18 : 12);

    if (!broadTop.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [], ...(it.debug ? { debug: { broadQueries, broadErrors: broadRes._errors } } : {}) });
    }

    // ===== PRE-EXTRACT =====
    const signals = preExtractSignals(broadTop.map((c) => c.text), userQ);

    // ===== FOCUSED =====
    const focusedQueries = buildFocusedQueries(userQ, signals);
    const focusedRes = await searchMany(
      { vectorStoreId, queries: focusedQueries, maxNumResults: it.pdfish ? 80 : 45, scoreThreshold: it.pdfish ? 0.05 : 0.07 },
      apiKey
    );
    const focusedTop = pickTop(focusedRes, userQ, it.quote ? 24 : it.pdfish ? 22 : 16);

    // merge (focused first) + dedupe
    const merged = [];
    const seen = new Set();
    for (const c of [...focusedTop, ...broadTop]) {
      const key = `${c.filename}::${(c.text || "").slice(0, 260)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
      if (merged.length >= (it.quote ? 26 : it.pdfish ? 24 : 18)) break;
    }

    const contextBlock = buildContext(merged, userQ);

    // ===== ANSWER =====
    const temperature = it.quote ? 0.0 : 0.1;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, history, temperature }, apiKey);
    answer = cleanAnswer(answer);

    if (isBadAnswer(answer)) {
      // retry 1× a pak fallback
      const retryCtx = contextBlock + `\n\nDODATEK: Odpověz konkrétně a přilož odkaz, pokud existuje v kontextu.`;
      let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryCtx, history, temperature }, apiKey);
      retry = cleanAnswer(retry);
      answer = isBadAnswer(retry) ? HARD_FALLBACK : retry;
    }

    const links = Array.from(new Set([...merged.flatMap((c) => extractLinks(c.text)), ...extractLinks(answer)])).slice(0, 12);

    const debug = it.debug
      ? {
          broadQueries,
          focusedQueries,
          signals,
          broadErrors: broadRes._errors,
          focusedErrors: focusedRes._errors,
          picked: merged.map((c) => ({ file: c.filename, score: c.score })),
        }
      : undefined;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId, links, ...(debug ? { debug } : {}) });
  } catch (err) {
    // !!! nikdy nevracej "Bez odpovědi" – vždy fallback text
    const details = err?.message || String(err);
    return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: `thread_local_${Date.now()}`, links: [], debug: { error: details } });
  }
}