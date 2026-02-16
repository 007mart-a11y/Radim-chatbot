// netlify/functions/search.mjs (v6 - simple + robust quotes)
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
    debug: /^\s*#debug\b/i.test(q),
    quote: /(odcituj|cituj|zkopiruj|max\s*2\s*vety|max\s*dve\s*vety|presnou vetu|citace)/i.test(t),
    latest: /(nejnovejs|posledn|aktualn|dnes|k\s*datu|uredni\s*desce|vyvesen|ucinn|platn)/i.test(t),
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|castka|sazba|splatnost|cl\.|clanek|odstavec|pdf|kc)/i.test(t),
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
    .map((c) => (c?.type === "text" ? c?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// jednoduché boosty podle souboru
function boostScore(filename, userQ) {
  const it = intent(userQ);
  const f = (filename || "").toLowerCase();
  let b = 0;

  if (it.pdfish && f.includes("30_pdf_text")) b += 0.30;
  if (it.latest && f.includes("00_latest")) b += 0.22;
  if (it.people && f.includes("people")) b += 0.22;
  if (f.includes("99_full")) b += 0.06;

  return b;
}

function pickChunks(searchJson, userQ, limit) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const base = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      const score = base + boostScore(filename, userQ);
      return { filename, score, text };
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

function buildQueries(userQ) {
  const it = intent(userQ);
  const q = userQ.replace(/^\s*#debug\s*/i, "").trim();
  const qNorm = normalizeCzech(q);
  const arr = [q, qNorm, `${q} obec ${OBEC_NAZEV}`];

  if (it.pdfish) arr.push(`${q} sazba splatnost čl. 4 Kč`);
  if (it.latest) arr.push(`${q} vyvěšeno účinnost datum`);

  return Array.from(new Set(arr)).slice(0, 4);
}

function splitSentencesCZ(text) {
  // hrubé, ale stabilní: dělí na věty podle . ! ? + nový řádek
  const t = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const parts = t
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  return parts;
}

// Deterministická citace: najdi max 2 věty, které obsahují “Kč” nebo “Sazba poplatku” apod.
function makeQuoteAnswer(chunks, userQ) {
  const q = normalizeCzech(userQ);
  const wantDog = /(psy|psu|psů|pes)/i.test(q);
  const wantWaste = /(odpad|odpadu|odpadove)/i.test(q);

  const needles = [];
  if (wantDog) needles.push("za jednoho psa", "sazba poplatku", "kc");
  if (wantWaste) needles.push("sazba poplatku", "ciní", "kc", "odpad");

  // fallback needle pro “částka”
  needles.push("kc", "sazba poplatku", "ciní");

  for (const c of chunks) {
    const text = c.text || "";
    const sentences = splitSentencesCZ(text);

    const hits = [];
    for (const s of sentences) {
      const ns = normalizeCzech(s);
      const ok =
        needles.some((n) => ns.includes(normalizeCzech(n))) ||
        /(\b\d{1,5}\s*Kč\b|\bKč\b)/i.test(s);
      if (ok) hits.push(s);
      if (hits.length >= 2) break;
    }

    if (hits.length) {
      // max 2 věty, přesně jak jsou
      const quoted = hits.slice(0, 2).map((x) => `„${x.replace(/^["„]|["“]$/g, "")}“`).join("\n");
      return `${quoted}\n(Zdroj: ${c.filename || "soubor"})`;
    }
  }

  return HARD_FALLBACK;
}

function systemPrompt(userQ) {
  const it = intent(userQ);
  return (
    `Jsi AI asistent obce ${OBEC_NAZEV}. Odpovídej pouze podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Pokud odpověď není v kontextu, napiš přesně: "${HARD_FALLBACK}"\n` +
    `Vždy přidej odkaz, pokud je v kontextu.\n` +
    `Nikdy nepoužívej odkazy se "/seniori/".\n` +
    (it.quote ? `Pozn.: citace se řeší mimo model, ty jen odpověz fakticky, pokud se tě na to někdo ptá.\n` : ``)
  );
}

function buildContext(chunks) {
  // držíme to jednoduché, ale “bohaté”
  const cap = 3800;
  let ctx = `KONTEXT (oficiální podklady obce ${OBEC_NAZEV} – úryvky):\n---\n`;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"}\n${t}\n---\n`;
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

  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // pryč “Bez odpovědi”
  if (/^\s*bez odpovědi\s*$/i.test(s.trim())) s = "";

  // seniors odkazy
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function isEmptyOrBad(ans) {
  const a = String(ans || "").trim();
  if (!a) return true;
  if (a === "Bez odpovědi") return true;
  // typické rozbité: "od  do ."
  if (/od\s+do\s+\./i.test(a)) return true;
  return false;
}

async function generateAnswer({ userMessage, contextBlock, history, temperature }, apiKey) {
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];

  const input = [
    { role: "system", content: systemPrompt(userMessage) },
    ...safeHistory.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 1200),
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
        max_output_tokens: 450,
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
    const message = body?.message;
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQRaw = message.trim();
    const it = intent(userQRaw);
    const userQ = userQRaw.replace(/^\s*#debug\s*/i, "").trim();

    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;
    const history = Array.isArray(body?.history) ? body.history : null;

    // 1) RETRIEVAL
    const queries = buildQueries(userQRaw);
    const maxNumResults = it.quote ? 50 : it.pdfish ? 40 : 30;
    const scoreThreshold = it.quote ? 0.05 : 0.10;

    const search = await vectorSearch({ vectorStoreId, query: queries, maxNumResults, scoreThreshold }, apiKey);
    const chunkLimit = it.quote ? 28 : it.pdfish ? 22 : 18;
    const chunks = pickChunks(search, userQRaw, chunkLimit);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [], debug: it.debug ? { queries } : undefined });
    }

    // 2) QUOTES: deterministicky, bez modelu
    if (it.quote) {
      const answer = makeQuoteAnswer(chunks, userQRaw);

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
        debug: it.debug
          ? {
              queries,
              picked: chunks.map((c) => ({ file: c.filename, score: c.score })),
            }
          : undefined,
      });
    }

    // 3) GENERATION (jen pro normální odpovědi)
    const contextBlock = buildContext(chunks);
    const temperature = 0.1;

    let answer = await generateAnswer({ userMessage: userQRaw, contextBlock, history, temperature }, apiKey);
    answer = cleanAnswer(answer);

    // Retry pokud prázdné / rozbité
    if (isEmptyOrBad(answer)) {
      const retryCtx =
        contextBlock +
        `\n\nDODATEK: Odpověz konkrétně a přidej odkaz, pokud je v kontextu. Pokud údaj chybí, vrať fallback větu doslova.`;
      let retry = await generateAnswer({ userMessage: userQRaw, contextBlock: retryCtx, history, temperature }, apiKey);
      retry = cleanAnswer(retry);
      answer = isEmptyOrBad(retry) ? HARD_FALLBACK : retry;
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
      debug: it.debug
        ? {
            queries,
            picked: chunks.map((c) => ({ file: c.filename, score: c.score })),
            links,
          }
        : undefined,
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}
