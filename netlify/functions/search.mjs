// netlify/functions/search.mjs (v10 - two-stage retrieval + big context + debug)
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

function parseIntent(q) {
  const t = normalizeCzech(q);
  return {
    debug: /^\s*#debug\b/i.test(q),
    quote: /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t),
    latest: /(nejnovejs|posledn|aktualn|dnes|k\s*datu|uredni\s*desce|vyvesen|ucinn|platn)/i.test(t),
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|sazba|splatnost|ucinnost|cl\.|clanek|odstavec|kč|kc|pdf)/i.test(t),
    people: /(kdo\s*je|starost|mistostarost|kontakt|telefon|email|e-mail|predsed|tajemnik)/i.test(t),
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

async function vectorSearch({ vectorStoreId, query, maxNumResults, scoreThreshold, rewriteQuery }, apiKey) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: !!rewriteQuery,
        ranking_options: scoreThreshold != null
          ? { ranker: "auto", score_threshold: scoreThreshold }
          : undefined,
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

// účetní bordel – nechceme ho cpát do top kontextu pro běžné dotazy
function isAccountingNoise(text) {
  const t = normalizeCzech(text).slice(0, 6000);
  return /(rozvaha|pasiva|aktiva|synteticky ucet|uctetni obdobi|brutto|netto|korekce|vykaz|zaverecny ucet|rozpoctove opatreni|rozpis rozpoctu)/i.test(t);
}

// === PRE-ANSWER HEURISTICS (lokální “předvyhledání”) ===
function preExtractSignals(chunksText, userQ) {
  const it = parseIntent(userQ);

  const joined = chunksText.join("\n\n");
  const norm = normalizeCzech(joined);

  // částky (Kč)
  const money = [];
  for (const m of joined.matchAll(/\b(\d{1,4}(?:[ \u00a0]?\d{3})*)\s*(Kč|kc)\b/gi)) {
    money.push(m[0].replace(/\s+/g, " ").trim());
    if (money.length >= 8) break;
  }

  // články / odstavce
  const articles = [];
  for (const m of joined.matchAll(/\bčl\.?\s*\d+\b/gi)) {
    articles.push(m[0].replace(/\s+/g, " ").trim());
    if (articles.length >= 6) break;
  }

  // splatnost / účinnost / vyvěšeno (zachytíme “31. března” apod.)
  const dates = [];
  for (const m of joined.matchAll(/\b(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})\b/g)) {
    dates.push(m[1]);
    if (dates.length >= 6) break;
  }

  // kategorie z dotazu (pomůže focusu)
  const keywords = new Set();
  if (/bioodpad|skladka/i.test(norm + " " + normalizeCzech(userQ))) {
    keywords.add("skládka bioodpadu");
    keywords.add("parcela");
    keywords.add("otevřeno");
  }
  if (it.pdfish) {
    keywords.add("vyhláška");
    keywords.add("sazba poplatku");
    keywords.add("splatnost");
    keywords.add("účinnost");
  }
  if (it.people) {
    keywords.add("telefon");
    keywords.add("e-mail");
    keywords.add("kontakt");
    keywords.add("starosta");
    keywords.add("starostka");
  }

  // odkazové signály
  const urls = extractLinks(joined).slice(0, 8);

  return {
    money,
    articles,
    dates,
    keywords: Array.from(keywords),
    urls,
  };
}

// build focused queries for 2nd pass
function buildFocusedQueries(userQ, signals) {
  const it = parseIntent(userQ);
  const base = [];

  // 1) původní dotaz
  base.push(userQ);

  // 2) když jsou peníze/články, přidáme je do dotazu
  if (it.pdfish) {
    const a = signals.articles?.[0] ? ` ${signals.articles[0]}` : "";
    const m = signals.money?.[0] ? ` ${signals.money[0]}` : "";
    base.push(`${userQ} ${OBEC_NAZEV} vyhláška${a}${m} sazba splatnost účinnost`);
    base.push(`${OBEC_NAZEV} ${userQ} Čl. 4 Sazba poplatku Kč`);
  }

  // 3) people intent
  if (it.people) {
    base.push(`${OBEC_NAZEV} ${userQ} telefon email kontakt`);
  }

  // 4) bioodpad intent (zachytí konkrétní stránku)
  const uqN = normalizeCzech(userQ);
  if (uqN.includes("bioodpad") || uqN.includes("skladka")) {
    base.push(`${OBEC_NAZEV} skládka bioodpadu parcela otevřeno`);
    base.push(`skládka bioodpadu Radim hřbitov`);
  }

  // 5) přidáme pár keywordů z pre-extractu
  for (const kw of (signals.keywords || []).slice(0, 4)) {
    base.push(`${userQ} ${kw}`);
  }

  // uniq + limit
  return Array.from(new Set(base)).slice(0, 4);
}

// simple boost & select
function scoreBoost(filename, userQ, chunkText) {
  const f = (filename || "").toLowerCase();
  const it = parseIntent(userQ);

  let b = 0;
  if (it.pdfish && f.includes("30_pdf_text")) b += 0.35;
  if (it.latest && f.includes("00_latest")) b += 0.22;
  if (it.people && f.includes("people")) b += 0.25;
  if (f.includes("99_full")) b += 0.08;

  // penalizace účetnictví pokud dotaz není účetní
  const qn = normalizeCzech(userQ);
  const askingAccounting = /(rozvaha|ucetni|vykaz|zaverecny ucet|rozpocet|rozpoctove opatreni)/i.test(qn);
  if (!askingAccounting && isAccountingNoise(chunkText)) b -= 0.45;

  return b;
}

function pickTopChunksFromSearch(searchJson, userQ, limit) {
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
    const key = `${r.filename}::${r.text.slice(0, 240)}`;
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
  const it = parseIntent(userQ);
  return (
    `Jsi AI asistent obce ${OBEC_NAZEV}. Odpovídej pouze podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Pokud údaj není v kontextu, napiš přesně: "${HARD_FALLBACK}".\n\n` +
    `Pravidla:\n` +
    `- Stručně, prakticky (1–8 bodů).\n` +
    `- Pokud je v kontextu odkaz na stránku nebo PDF, vždy ho uveď.\n` +
    `- Nikdy nepoužívej odkazy se "/seniori/".\n` +
    (it.quote
      ? `- Uživatel chce citaci: zkopíruj max 2 věty přesně z kontextu (bez parafráze) a připiš zdroj.\n`
      : ``)
  );
}

function buildContext(chunks, userQ) {
  const it = parseIntent(userQ);

  // větší cap, ale pořád bezpečný
  const cap = it.quote ? 7000 : it.pdfish ? 5200 : 4200;

  let header = `KONTEXT – OFICIÁLNÍ PODKLADY OBCE ${OBEC_NAZEV}\n`;
  header += `Pozn.: odkazy uváděj bez "/seniori/".\n`;
  header += `---\n`;

  let body = "";
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    body += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n${t}\n---\n`;
  });

  return (header + body).trim();
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

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    const raw = body?.message;
    if (!raw || typeof raw !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const it = parseIntent(raw);
    const userQ = raw.replace(/^\s*#debug\b/i, "").trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;
    const history = Array.isArray(body?.history) ? body.history : null;

    // ===== PASS 1 (broad) =====
    const broad = await vectorSearch(
      {
        vectorStoreId,
        query: userQ,
        maxNumResults: it.pdfish ? 70 : 40,
        scoreThreshold: it.pdfish ? 0.06 : 0.08,
        rewriteQuery: true,
      },
      apiKey
    );

    const broadTop = pickTopChunksFromSearch(broad, userQ, it.pdfish ? 20 : 14);

    if (!broadTop.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [] });
    }

    // ===== PRE-EXTRACT (signals) =====
    const signals = preExtractSignals(broadTop.map((c) => c.text), userQ);

    // ===== PASS 2 (focused) =====
    const focusedQueries = buildFocusedQueries(userQ, signals);

    const focused = await vectorSearch(
      {
        vectorStoreId,
        query: focusedQueries,
        maxNumResults: it.pdfish ? 80 : 45,
        scoreThreshold: it.pdfish ? 0.05 : 0.07,
        rewriteQuery: true,
      },
      apiKey
    );

    const focusedTop = pickTopChunksFromSearch(focused, userQ, it.quote ? 26 : it.pdfish ? 24 : 18);

    // merge: focused first, then a bit of broad (dedupe)
    const merged = [];
    const seen = new Set();
    for (const c of [...focusedTop, ...broadTop]) {
      const key = `${c.filename}::${(c.text || "").slice(0, 260)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
      if (merged.length >= (it.quote ? 28 : it.pdfish ? 26 : 20)) break;
    }

    const contextBlock = buildContext(merged, userQ);

    // ===== GENERATE =====
    const temperature = it.quote ? 0.0 : 0.1;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, history, temperature }, apiKey);
    answer = cleanAnswer(answer);

    // retry once if bad
    if (isBadAnswer(answer)) {
      const retryCtx =
        contextBlock +
        `\n\nDODATEK: Odpověz konkrétně. Pokud je v kontextu odkaz, přilož ho. Pokud údaj chybí, vrať fallback větu doslova.`;
      let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryCtx, history, temperature }, apiKey);
      retry = cleanAnswer(retry);
      answer = isBadAnswer(retry) ? HARD_FALLBACK : retry;
    }

    // links from context + answer
    const links = Array.from(new Set([...merged.flatMap((c) => extractLinks(c.text)), ...extractLinks(answer)])).slice(0, 12);

    // debug payload (only when #debug)
    const debug = it.debug
      ? {
          intent: it,
          focusedQueries,
          signals,
          picked: merged.map((c) => ({ file: c.filename, score: c.score })),
        }
      : undefined;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId, links, ...(debug ? { debug } : {}) });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}