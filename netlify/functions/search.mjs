// netlify/functions/search.mjs (v6 - SIMPLE + STABLE NETLIFY HANDLER)
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string }
// Response: { ok:true|false, answer:string, debug?:object, links?:string[] }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

const OBEC = "Radim";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
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

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = s.replace(/【[^】]*†[^】]*】/g, "");

  // seniors odkazy pryč
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
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

async function vectorSearch(vectorStoreId, query, apiKey) {
  // IMPORTANT: query musí být string (ne pole) – pro stabilitu
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        rewrite_query: true,
        max_num_results: 30,
        ranking_options: { ranker: "auto", score_threshold: 0.08 },
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

function pickTopChunks(searchJson, limit = 14) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const score = typeof it?.score === "number" ? it.score : 0;
      const text = flattenChunkText(it);
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.length > 80)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const key = (r.filename || "") + "::" + r.text.slice(0, 220);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function buildContext(chunks) {
  // jednoduchý kontext, žádná magie
  let ctx = `KONTEXT (oficiální podklady obce ${OBEC})\n`;
  ctx += `Pravidla: odpovídej jen z kontextu. Když tam údaj není, napiš přesně: "${HARD_FALLBACK}".\n`;
  ctx += `Vždy přidej odkaz, pokud je v kontextu.\n`;
  ctx += `---\n\n`;

  const cap = 5200;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score:${(c.score || 0).toFixed(3)})\n${t}\n\n---\n\n`;
  });

  return ctx.trim();
}

function isDebugQuestion(q) {
  return String(q || "").trim().toLowerCase().startsWith("#debug");
}

function stripDebugPrefix(q) {
  const s = String(q || "").trim();
  return s.replace(/^#debug\s*/i, "").trim();
}

async function generateAnswer(userQ, contextBlock, apiKey) {
  const system =
    `Jsi AI asistent obce ${OBEC}. ` +
    `Odpovídej stručně a konkrétně. ` +
    `Odpovídej POUZE podle poskytnutého KONTEXTU. ` +
    `Nevymýšlej fakta. ` +
    `Když údaj není v kontextu, napiš přesně: "${HARD_FALLBACK}". ` +
    `Vždy přidej odkaz, pokud je v kontextu.\n`;

  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.1,
        input: [
          { role: "system", content: system },
          { role: "user", content: `${contextBlock}\n\nDOTAZ:\n${userQ}` },
        ],
      }),
    },
    apiKey
  );

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

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, answer: HARD_FALLBACK, error: "Method not allowed" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey) return json(500, { ok: false, answer: HARD_FALLBACK, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return json(500, { ok: false, answer: HARD_FALLBACK, error: "Missing VECTOR_STORE_ID" });

    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      body = {};
    }

    const rawMessage = body?.message;
    if (!rawMessage || typeof rawMessage !== "string") {
      return json(400, { ok: false, answer: HARD_FALLBACK, error: "Missing message" });
    }

    const debug = isDebugQuestion(rawMessage);
    const userQ = debug ? stripDebugPrefix(rawMessage) : rawMessage.trim();
    if (!userQ) return json(200, { ok: true, answer: HARD_FALLBACK });

    // jednoduché query expansion (string)
    const expandedQuery =
      `${userQ}\n` +
      `obec Radim\n` +
      `vyhláška poplatek sazba splatnost Kč\n` +
      `odpad psy bioodpad úřední hodiny kontakty\n`;

    const search = await vectorSearch(vectorStoreId, expandedQuery, apiKey);
    const chunks = pickTopChunks(search, 16);

    if (!chunks.length) {
      return json(200, { ok: true, answer: HARD_FALLBACK, links: [] });
    }

    const contextBlock = buildContext(chunks);
    let answer = await generateAnswer(userQ, contextBlock, apiKey);
    answer = cleanAnswer(answer);

    if (!answer || answer === "Bez odpovědi") answer = HARD_FALLBACK;

    // odkazy: z odpovědi + chunků
    const links = Array.from(
      new Set([
        ...chunks.flatMap((c) => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 12);

    if (debug) {
      const filenames = chunks.map((c) => c.filename || "").filter(Boolean);
      const dbg = {
        q: userQ,
        chunks: chunks.length,
        top_files: Array.from(new Set(filenames)).slice(0, 8),
        top_links: links.slice(0, 8),
      };
      return json(200, { ok: true, answer, links, debug: dbg });
    }

    return json(200, { ok: true, answer, links });
  } catch (err) {
    // DŮLEŽITÉ: i při chybě vrať answer, aby frontend neskončil "Bez odpovědi"
    return json(200, {
      ok: false,
      answer: HARD_FALLBACK,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
};