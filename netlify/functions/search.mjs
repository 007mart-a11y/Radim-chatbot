// netlify/functions/search.mjs (v7 - SIMPLE + NEWEST-YEAR FILTER)
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
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = s.replace(/【[^】]*†[^】]*】/g, "");
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function normalizeCz(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function intent(q) {
  const t = normalizeCz(q);
  return {
    pdfish: /(vyhlask|narizen|poplatek|odpad|psy|psu|castka|sazba|splatnost|ucinnost|cl\.|clanek|odstavec|kč|kc|pdf)/i.test(t),
    dog: /(poplatek.*(psu|psy)|za\s+psa|pes\b)/i.test(t),
    waste: /(odpad|odpadu|popelnic|komunal)/i.test(t),
  };
}

function isDebugQuestion(q) {
  return String(q || "").trim().toLowerCase().startsWith("#debug");
}
function stripDebugPrefix(q) {
  return String(q || "").trim().replace(/^#debug\s*/i, "").trim();
}

// ---------- year extraction (deterministic newest) ----------
function extractYearFromTextOrUrl(s) {
  const txt = String(s || "");
  // prefer "original=2026..." or "/2026" etc
  let m = txt.match(/original=.*?(20\d{2})/i);
  if (m) return parseInt(m[1], 10);

  // "účinnost ... 2026", "ze dne 1. prosince 2025" etc
  m = txt.match(/\b(20\d{2})\b/g);
  if (!m) return null;

  // vezmi nejvyšší rok z výskytů
  const years = m.map((x) => parseInt(x, 10)).filter((n) => n >= 2000 && n <= 2099);
  if (!years.length) return null;
  return Math.max(...years);
}

function filterNewestByYear(chunks) {
  // vrátí: { pickedYear, filteredChunks, candidateYears }
  const years = chunks
    .map((c) => extractYearFromTextOrUrl(`${c.filename}\n${c.text}`))
    .filter((y) => Number.isFinite(y));

  const candidateYears = Array.from(new Set(years)).sort((a, b) => b - a);
  if (!candidateYears.length) {
    return { pickedYear: null, filteredChunks: chunks, candidateYears: [] };
  }

  const pickedYear = candidateYears[0];

  // nech jen chunky, které ten pickedYear obsahují (nebo aspoň nemají žádný rok)
  const filtered = chunks.filter((c) => {
    const y = extractYearFromTextOrUrl(`${c.filename}\n${c.text}`);
    if (!y) return true;          // bez roku necháme jako doplněk
    return y === pickedYear;      // starší pryč
  });

  // bezpečnost: kdyby filtr osekal moc, vrať radši původní
  if (filtered.length < 5 && chunks.length >= 5) {
    return { pickedYear, filteredChunks: chunks, candidateYears };
  }

  return { pickedYear, filteredChunks: filtered, candidateYears };
}

// ---------- OpenAI ----------
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
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        rewrite_query: true,
        max_num_results: 40,
        ranking_options: { ranker: "auto", score_threshold: 0.06 },
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

function pickTopChunks(searchJson, limit = 18) {
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
    const key = (r.filename || "") + "::" + r.text.slice(0, 240);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function buildContext(chunks, pickedYear) {
  let ctx = `KONTEXT (oficiální podklady obce ${OBEC})\n`;
  ctx += `Pravidla: odpovídej jen z kontextu. Když tam údaj není, napiš přesně: "${HARD_FALLBACK}".\n`;
  ctx += `Vždy přidej odkaz, pokud je v kontextu.\n`;
  if (pickedYear) ctx += `DŮLEŽITÉ: V kontextu existuje více verzí. Preferuj nejnovější rok: ${pickedYear}.\n`;
  ctx += `---\n\n`;

  const cap = 5200;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score:${(c.score || 0).toFixed(3)})\n${t}\n\n---\n\n`;
  });

  return ctx.trim();
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

    const it = intent(userQ);

    // jednoduché rozšíření dotazu (string) – hlavně pro vyhlášky
    const expandedQuery =
      `${userQ}\n` +
      `obec Radim\n` +
      (it.pdfish ? `vyhláška účinnost sazba splatnost částka Kč článek odstavec\n` : ``) +
      (it.dog ? `místní poplatek ze psů vyhláška original=2026\n` : ``) +
      (it.waste ? `odpadové hospodářství místní poplatek original=2026\n` : ``);

    const search = await vectorSearch(vectorStoreId, expandedQuery, apiKey);
    let chunks = pickTopChunks(search, it.pdfish ? 22 : 16);

    if (!chunks.length) {
      return json(200, { ok: true, answer: HARD_FALLBACK, links: [] });
    }

    // ✅ KLÍČ: když jde o poplatky/vyhlášky, drž jen nejnovější rok
    let pickedYear = null;
    let candidateYears = [];
    if (it.pdfish) {
      const filtered = filterNewestByYear(chunks);
      pickedYear = filtered.pickedYear;
      candidateYears = filtered.candidateYears;
      chunks = filtered.filteredChunks;
    }

    const contextBlock = buildContext(chunks, pickedYear);
    let answer = await generateAnswer(userQ, contextBlock, apiKey);
    answer = cleanAnswer(answer);

    if (!answer || answer === "Bez odpovědi") answer = HARD_FALLBACK;

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
        pdfish: it.pdfish,
        picked_year: pickedYear,
        candidate_years: candidateYears.slice(0, 6),
        chunks: chunks.length,
        top_files: Array.from(new Set(filenames)).slice(0, 10),
        top_links: links.slice(0, 10),
      };
      return json(200, { ok: true, answer, links, debug: dbg });
    }

    return json(200, { ok: true, answer, links });
  } catch (err) {
    // i při chybě vrať answer, ať frontend nepadá do "Bez odpovědi"
    return json(200, {
      ok: false,
      answer: HARD_FALLBACK,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
};