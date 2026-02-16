// netlify/functions/search.mjs (v5.1 - retrieval-first, FIXED query + debug)
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

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
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
    debug: /(^|\s)#debug(\s|$)/i.test(q),
    quote: /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t),
    latest: /(nejnovejs|posledn|aktualn|dnes|k\s*datu|uredni\s*desce|vyvesen|ucinn|platn)/i.test(t),
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|castka|sazba|splatnost|cl\.|clanek|odstavec|pdf)/i.test(t),
    people: /(kdo\s*je|starost|mistostarost|kontakt|telefon|email|e-mail|predsed|tajemnik)/i.test(t),
  };
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

// --- Vector store search ---
// IMPORTANT: query must be string (stable). We join expansions into one query text.
async function vectorSearch({ vectorStoreId, queryText, maxNumResults, scoreThreshold }, apiKey) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: queryText,
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
  const t = normalizeCzech(text).slice(0, 6000);
  return /(rozvaha|vykaz zisku|pasiva|aktiva|uctetni obdobi|synteticky ucet|brutto|netto|korekce|uzemni samospravne celky)/i.test(t);
}

function scoreBoost(filename, userQ, chunkText) {
  const f = (filename || "").toLowerCase();
  const it = intent(userQ);
  let b = 0;

  if (it.pdfish && f.includes("30_pdf_text")) b += 0.35;
  if (it.latest && f.includes("00_latest")) b += 0.28;
  if (it.people && f.includes("people")) b += 0.28;
  if (f.includes("99_full")) b += 0.08;

  // penalizace účetnictví, pokud se na něj nikdo neptá
  if (!/(rozvaha|ucetni|vykaz|zaverecny ucet)/i.test(normalizeCzech(userQ))) {
    if ((f.includes("30_pdf_text") || f.includes("99_full")) && isAccountingNoise(chunkText)) b -= 0.35;
  }

  return b;
}

function pickTopChunks(searchJson, userQ, limit) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];

  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const base = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      const boosted = base + scoreBoost(filename, userQ, text);
      return { filename, base, score: boosted, text };
    })
    .filter((x) => x.text && x.text.length > 60)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const key = (r.filename || "") + "::" + r.text.slice(0, 240);
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
    `Jsi AI asistent obce ${OBEC_NAZEV}. Odpovídej pouze podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Když údaj není v kontextu, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Pravidla odpovědi:\n` +
    `- Stručně, prakticky (1–8 bodů).\n` +
    `- Vždy přidej odkaz, pokud je v kontextu (URL na stránku nebo PDF).\n` +
    `- U částek a poplatků uveď částku + platnost/účinnost, pokud je uvedena.\n` +
    `- Nikdy nepoužívej odkazy se "/seniori/".\n` +
    (it.quote
      ? `- Uživatel chce CITACI: zkopíruj max 2 věty přesně z kontextu (bez parafráze) a připiš: (Zdroj: <soubor>, čl./odst.).\n`
      : ``)
  );
}

function buildBigContext(chunks, userQ) {
  const it = intent(userQ);

  const srcCounts = {};
  for (const c of chunks) {
    const f = (c.filename || "").toLowerCase();
    const k =
      f.includes("00_latest") ? "LATEST" :
      f.includes("30_pdf_text") ? "PDF_TEXT" :
      f.includes("people") ? "PEOPLE" :
      f.includes("99_full") ? "FULL" : "OTHER";
    srcCounts[k] = (srcCounts[k] || 0) + 1;
  }

  const explain = [
    `KONTEXT – OFICIÁLNÍ PODKLADY OBCE ${OBEC_NAZEV}`,
    `Dnes: ${todayCZ()}`,
    `Zdroje v kontextu: ${Object.entries(srcCounts).map(([k,v]) => `${k}:${v}`).join("  ")}`,
    `Pozn.: odkazy uváděj bez "/seniori/".`,
    ``,
    `INSTRUKCE K DOTAZU:`,
    it.pdfish
      ? `- Dotaz na vyhlášku/poplatek: hledej primárně v PDF_TEXT, vytáhni konkrétní čl./odst. a dej odkaz na PDF.`
      : it.latest
      ? `- Dotaz na nejnovější informace: preferuj LATEST a uváděj datum + odkaz.`
      : it.people
      ? `- Dotaz na kontakty/osoby: vrať jméno + tel + email (pokud jsou v kontextu) a odkaz na zdrojovou stránku.`
      : `- Vrať konkrétní odpověď včetně odkazu, pokud existuje.`,
    it.quote ? `- U citace dodrž max 2 věty, přesně okopírovat.` : ``,
    `---`,
  ].filter(Boolean).join("\n");

  const cap = it.quote ? 7000 : 4500;

  let body = "";
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    body += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n${t}\n---\n`;
  });

  return `${explain}\n${body}`.trim();
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
  if (/od\s+do\s+\./i.test(a)) return true;
  if (/(doporucuji navstivit|doporučuji navštívit|zkuste se podivat|nejsem si jist|pravdepodobne|obecne plati)/i.test(a)) return true;
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

function buildQueryText(userQ) {
  const it = intent(userQ);
  const q = userQ.replace(/#debug/gi, "").trim();
  const qNorm = normalizeCzech(q);

  const parts = [
    q,
    qNorm,
    `${q} obec ${OBEC_NAZEV}`,
  ];

  if (it.pdfish) parts.push(`${q} vyhláška článek odstavec sazba splatnost částka Kč`);
  if (it.latest) parts.push(`${q} vyvěšeno datum účinnost`);

  // one final string:
  return parts.filter(Boolean).join("\n");
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
    const it = intent(userQ);

    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;
    const history = Array.isArray(body?.history) ? body.history : null;

    // SEARCH
    const queryText = buildQueryText(userQ);

    // Aggressive retrieval so it NEVER returns 0 unless VS is wrong/empty
    const maxNumResults = it.quote ? 60 : it.pdfish ? 50 : 36;
    const scoreThreshold = it.quote ? 0.02 : 0.04;

    const search = await vectorSearch(
      { vectorStoreId, queryText, maxNumResults, scoreThreshold },
      apiKey
    );

    const chunkLimit = it.quote ? 30 : it.pdfish ? 24 : 20;
    const chunks = pickTopChunks(search, userQ, chunkLimit);

    if (!chunks.length) {
      const payload = { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [] };
      if (it.debug) payload.debug = { note: "No chunks from vector search", maxNumResults, scoreThreshold, queryText };
      return jsonResponse(200, payload);
    }

    const contextBlock = buildBigContext(chunks, userQ);

    const temperature = it.quote ? 0.0 : 0.1;
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

    const payload = { ok: true, answer, thread_id: threadId, links };

    if (it.debug) {
      payload.debug = {
        vectorStoreId,
        maxNumResults,
        scoreThreshold,
        queryTextPreview: queryText.slice(0, 400),
        returned: Array.isArray(search?.data) ? search.data.length : 0,
        picked: chunks.map((c) => ({ file: c.filename, score: c.score, preview: (c.text || "").slice(0, 120) })),
      };
    }

    return jsonResponse(200, payload);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}