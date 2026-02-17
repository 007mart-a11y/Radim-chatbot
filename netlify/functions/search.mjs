// netlify/functions/search.mjs (v6 - simple + robust + #debug)
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

function intent(q) {
  const t = normalizeCzech(q);
  return {
    quote: /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t),
    latest: /(nejnovejs|posledn|aktualn|dnes|k\s*datu|uredni\s*desce|vyvesen|ucinn|platn)/i.test(t),
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|castka|sazba|splatnost|cl\.|clanek|odstavec|pdf|kc)/i.test(t),
    people: /(kdo\s*je|starost|mistostarost|kontakt|telefon|email|e-mail|predsed|tajemnik|urad)/i.test(t),
  };
}

function buildQueries(userQ) {
  const it = intent(userQ);
  const q = userQ.trim();
  const qNorm = normalizeCzech(q);

  const qs = new Set();
  qs.add(q);
  qs.add(qNorm);
  qs.add(`${q} obec ${OBEC_NAZEV}`);

  if (it.pdfish) qs.add(`${q} vyhláška čl. sazba splatnost Kč`);
  if (it.people) qs.add(`${q} kontakt telefon email`);
  if (it.latest) qs.add(`${q} vyvěšeno účinnost datum`);

  return Array.from(qs).slice(0, 4);
}

// --- OpenAI fetch ---
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
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }

  return json ?? {};
}

// --- Vector store search ---
async function vectorSearch({ vectorStoreId, query, maxNumResults, scoreThreshold }, apiKey) {
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
    .map((c) => (c?.type === "text" ? c?.text : (c?.text?.value || "")))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Jednoduchý boost: chceme PDF_TEXT pro vyhlášky/poplatky/částky.
function scoreBoost(filename, userQ) {
  const f = (filename || "").toLowerCase();
  const it = intent(userQ);

  let b = 0;
  if (it.pdfish && f.includes("30_pdf_text")) b += 0.40;
  if (it.latest && f.includes("00_latest")) b += 0.25;
  if (it.people && f.includes("people")) b += 0.25;
  if (f.includes("99_full")) b += 0.08;
  return b;
}

function pickTopChunks(searchJson, userQ, limit) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];

  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const base = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      const score = base + scoreBoost(filename, userQ);
      return { filename, base, score, text };
    })
    .filter((x) => x.text && x.text.length > 60)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const key = (r.filename || "") + "::" + r.text.slice(0, 220);
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
  const it = intent(userQ);
  return (
    `Jsi AI asistent obce ${OBEC_NAZEV}. Odpovídej POUZE podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Pokud údaj v kontextu není, vrať přesně: "${HARD_FALLBACK}"\n\n` +
    `Pravidla:\n` +
    `- Odpověz stručně a konkrétně (1–8 bodů).\n` +
    `- Pokud je v kontextu odkaz (stránka/PDF), vždy ho uveď.\n` +
    `- Nikdy nepoužívej odkazy se "/seniori/".\n` +
    (it.quote
      ? `- Uživatel chce CITACI: zkopíruj max 2 věty PŘESNĚ z kontextu (bez parafráze) a dopiš zdroj (soubor + čl./odst.).\n`
      : ``)
  );
}

function buildContext(chunks, userQ) {
  const it = intent(userQ);
  const cap = it.quote ? 7000 : 4500;

  let ctx = `KONTEXT (oficiální podklady obce ${OBEC_NAZEV}):\n`;
  ctx += `- Dotaz: ${userQ}\n`;
  ctx += `- Instrukce: hledej konkrétní odpověď; pokud jde o poplatky/vyhlášky, preferuj PDF_TEXT.\n`;
  ctx += `- Odkazy vždy bez "/seniori/".\n`;
  ctx += `---\n`;

  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n${t}\n---\n`;
  });

  return ctx.trim();
}

// Extrémně robustní vyzobání textu z Responses API (různé tvary)
function extractResponseText(resp) {
  if (!resp) return "";

  if (typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();

  const out = [];

  const output = Array.isArray(resp.output) ? resp.output : [];
  for (const item of output) {
    // nový tvar
    if (item?.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") out.push(c.text);
        if (c?.type === "output_text" && typeof c?.text?.value === "string") out.push(c.text.value);
        if (c?.type === "text" && typeof c?.text === "string") out.push(c.text);
        if (c?.type === "text" && typeof c?.text?.value === "string") out.push(c.text.value);
      }
    }

    // některé účty vrací přímo
    if (item?.type === "output_text" && typeof item?.text === "string") out.push(item.text);
    if (item?.type === "output_text" && typeof item?.text?.value === "string") out.push(item.text.value);
  }

  return out.join("\n").trim();
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // seniors odkazy
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

function isBadAnswer(ans) {
  const a = String(ans || "").trim();
  if (!a) return true;
  if (a === "Bez odpovědi") return true;
  if (/(^|\n)\s*(od\s+do\s*\.)/i.test(a)) return true; // "od  do ."
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

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    const messageRaw = body?.message;

    if (!messageRaw || typeof messageRaw !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const debugMode = messageRaw.trim().toLowerCase().startsWith("#debug");
    const userQ = debugMode ? messageRaw.replace(/^#debug\s*/i, "").trim() : messageRaw.trim();

    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;
    const history = Array.isArray(body?.history) ? body.history : null;

    const it = intent(userQ);

    // 1) SEARCH
    const queries = buildQueries(userQ);
    const maxNumResults = it.quote ? 60 : it.pdfish ? 50 : 32;
    const scoreThreshold = it.quote ? 0.05 : 0.10;

    const search = await vectorSearch(
      { vectorStoreId, query: queries, maxNumResults, scoreThreshold },
      apiKey
    );

    // 2) CHUNKS
    const chunkLimit = it.quote ? 30 : it.pdfish ? 24 : 18;
    const chunks = pickTopChunks(search, userQ, chunkLimit);

    if (!chunks.length) {
      return jsonResponse(200, {
        ok: true,
        answer: HARD_FALLBACK,
        thread_id: threadId,
        links: [],
        ...(debugMode ? { debug: { queries, picked: [] } } : {}),
      });
    }

    const contextBlock = buildContext(chunks, userQ);

    // 3) GENERATE (low temp)
    const temperature = it.quote ? 0.0 : 0.1;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, history, temperature }, apiKey);
    answer = cleanAnswer(answer);

    // 4) Retry once if empty/bad (a hlavně: nikdy nevracej "Bez odpovědi")
    if (isBadAnswer(answer)) {
      const retryCtx =
        contextBlock +
        `\n\nDODATEK: Pokud v kontextu je částka/konkrétní údaj, napiš ho. Pokud ne, vrať fallback větu doslova.`;
      let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryCtx, history, temperature }, apiKey);
      retry = cleanAnswer(retry);
      answer = isBadAnswer(retry) ? HARD_FALLBACK : retry;
    }

    // 5) Links
    const links = Array.from(
      new Set([
        ...chunks.flatMap((c) => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 12);

    const debug = debugMode
      ? {
          queries,
          picked: chunks.map((c) => ({
            file: c.filename,
            score: c.score,
            preview: String(c.text || "").slice(0, 400),
          })),
          links,
        }
      : undefined;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId, links, ...(debug ? { debug } : {}) });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}