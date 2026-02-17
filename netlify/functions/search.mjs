// netlify/functions/search.mjs (v6 - 2-stage retrieval, newest-first, simple)
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string }
// Response: { ok:true, answer:string, debug?:object }

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

function normalizeCz(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function extractUrls(text) {
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

function guessYearFromAny(s) {
  const t = String(s || "");
  const m = t.match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : 0;
}

function guessDateIsoFromAny(s) {
  // dd.mm.yyyy => yyyy-mm-dd
  const t = String(s || "");
  const m = t.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})\b/);
  if (!m) return "";
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function isVyhlaskaQuery(q) {
  const t = normalizeCz(q);
  return /(vyhlask|obecne zavaz|ozv|narizen|poplatek|odpady|odpad|psy|psu|sazba|splatnost|k[cč]|castka)/i.test(t);
}
function isPeopleQuery(q) {
  const t = normalizeCz(q);
  return /(kdo je|kontakt|telefon|email|e-mail|starost|mistostarost|vede|predsed|jednatel)/i.test(t);
}

function cleanAnswerText(t) {
  let s = String(t || "");
  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = s.replace(/【[^】]*†[^】]*】/g, "");
  // seniors odkazy pryč
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");
  // zbytečný whitespace
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

async function vectorSearch({ vectorStoreId, query, maxNumResults, scoreThreshold }, apiKey) {
  // OpenAI v2 vector store search podporuje query jako string
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        rewrite_query: true,
        max_num_results: maxNumResults,
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

/**
 * Stage 1 ranking: přísně upřednostnit nejnovější vyhlášky / relevantní URL / klíčová slova.
 * Vybíráme TOP 2 "source buckets" (filename).
 */
function rankStage1Items(items, userQ) {
  const qNorm = normalizeCz(userQ);
  const wantVyhl = isVyhlaskaQuery(userQ);
  const wantPeople = isPeopleQuery(userQ);

  const scored = items
    .map((it) => {
      const filename = getFilename(it);
      const text = flattenChunkText(it);
      const base = typeof it?.score === "number" ? it.score : 0;

      const urls = extractUrls(text);
      const urlBlob = urls.join(" ");

      // klíčová slova match (hrubý)
      const tNorm = normalizeCz(text).slice(0, 6000);
      let kw = 0;
      for (const w of qNorm.split(" ").filter(Boolean)) {
        if (w.length < 3) continue;
        if (tNorm.includes(w)) kw += 0.02;
      }

      // newest bias
      const year = Math.max(
        guessYearFromAny(filename),
        guessYearFromAny(urlBlob),
        guessYearFromAny(text)
      );

      const dateIso = guessDateIsoFromAny(text) || guessDateIsoFromAny(urlBlob);
      const dateBoost = dateIso ? 0.08 : 0;

      // typové boosty
      let boost = 0;
      const f = (filename || "").toLowerCase();

      if (wantPeople && f.includes("people")) boost += 0.35;
      if (wantVyhl && f.includes("30_pdf_text")) boost += 0.35;
      if (wantVyhl && f.includes("99_full")) boost += 0.10;

      // pokud dotaz je vyhláška/poplatek a chunk obsahuje "sazba", "kč", "čl."
      if (wantVyhl && /(sazba|kč|kc|splatnost|cl\.|čl\.|odst\.)/i.test(text)) boost += 0.18;

      // penalizace účetních věcí, pokud se na ně neptej
      if (!/(rozvaha|ucetni|zaverecny|vykaz)/i.test(qNorm)) {
        if (/(rozvaha|vykaz zisku|pasiva|aktiva|rozpoctove zmeny|rozpis rozpoctu)/i.test(tNorm)) boost -= 0.35;
      }

      // rok: 2026 > 2025 > ...
      const yearBoost = year >= 2026 ? 0.45 : year === 2025 ? 0.30 : year === 2024 ? 0.18 : year ? 0.08 : 0;

      const score = base + boost + kw + yearBoost + dateBoost;

      return {
        filename,
        base,
        score,
        year,
        dateIso,
        text,
        urls,
      };
    })
    .filter((x) => x.text && x.text.length > 60)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

function pickTopSourceBuckets(stage1Scored, maxBuckets = 2) {
  // bucket = filename. Bereme nejlepší soubory podle max score v souboru.
  const byFile = new Map();
  for (const it of stage1Scored) {
    const key = it.filename || "UNKNOWN";
    const prev = byFile.get(key);
    if (!prev || it.score > prev.score) byFile.set(key, { filename: key, score: it.score, year: it.year });
  }
  const buckets = Array.from(byFile.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
  return buckets.slice(0, maxBuckets).map((b) => b.filename);
}

function pickStage2Chunks(stage1Scored, allowedFilenames, userQ, limit = 18) {
  const qNorm = normalizeCz(userQ);
  const words = qNorm.split(" ").filter((w) => w.length >= 3);

  const filtered = stage1Scored
    .filter((x) => allowedFilenames.includes(x.filename))
    .map((x) => {
      const tNorm = normalizeCz(x.text).slice(0, 7000);
      let hardMatch = 0;
      for (const w of words) if (tNorm.includes(w)) hardMatch += 1;
      const hardBoost = Math.min(0.25, hardMatch * 0.03);
      return { ...x, score2: x.score + hardBoost };
    })
    .sort((a, b) => (b.score2 || 0) - (a.score2 || 0));

  const out = [];
  const seen = new Set();
  for (const x of filtered) {
    const key = x.filename + "::" + x.text.slice(0, 220);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filename: x.filename, score: Number(x.score2.toFixed(3)), text: x.text });
    if (out.length >= limit) break;
  }
  return out;
}

function systemPrompt(userQ) {
  return (
    `Jsi AI asistent obce ${OBEC}. Odpovídej POUZE podle poskytnutého KONTEXTU.\n` +
    `Nevymýšlej fakta. Pokud údaj není v kontextu, napiš přesně: "${HARD_FALLBACK}".\n\n` +
    `Přísná pravidla:\n` +
    `- U poplatků/vyhlášek vždy uveď částku (Kč) + odkaz na konkrétní vyhlášku/PDF, pokud je v kontextu.\n` +
    `- Pokud je v kontextu více vyhlášek, preferuj nejnovější (rok 2026 > 2025 > ...; účinnost/vyvěšeno).\n` +
    `- V odpovědi vždy přidej minimálně 1 relevantní odkaz z kontextu (pokud existuje).\n` +
    `- Nikdy nepoužívej odkazy se "/seniori/".\n`
  );
}

function buildContext(chunks) {
  let body = `KONTEXT (oficiální podklady obce ${OBEC})\n---\n`;
  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > 5200) t = t.slice(0, 5200) + "\n[ZKRÁCENO]";
    body += `[#${i + 1}] ${c.filename} (score ${c.score})\n${t}\n---\n`;
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

function isBadAnswer(ans) {
  const a = String(ans || "").trim();
  if (!a) return true;
  if (a === "Bez odpovědi") return true;
  // typická “dutá” odpověď
  if (/Tato informace není v dostupných podkladech/i.test(a) && a.length < 90) return false; // fallback je ok
  // když tvrdí, že v kontextu není částka, ale v kontextu je "Kč" → špatně
  return false;
}

async function generateAnswer({ userQ, contextBlock }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.1,
        input: [
          { role: "system", content: systemPrompt(userQ) },
          { role: "user", content: `${contextBlock}\n\nDOTAZ:\n${userQ}` },
        ],
      }),
    },
    apiKey
  );
  return extractResponseText(resp);
}

function buildWideQuery(userQ) {
  // jednoduché query expansion, ale bez překombinování
  const q = userQ.trim();
  const n = normalizeCz(q);

  // přidej synonymum pro bioodpad / skládka
  let extra = "";
  if (/(bioodpad|skladka|kompost)/i.test(n)) extra = " skládka bioodpadu parcela KN kde je otevřeno";
  if (/(odpad|poplatek|vyhlask|ozv)/i.test(n)) extra = " sazba Kč splatnost čl. odst. účinnost vyvěšeno";
  if (/(pes|psy|psu)/i.test(n)) extra += " místní poplatek ze psů sazba Kč splatnost článek";

  return `${q} | ${n} | obec ${OBEC}${extra ? " | " + extra : ""}`;
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

    const isDebug = raw.trim().toLowerCase().startsWith("#debug");
    const userQ = raw.replace(/^#debug\s*/i, "").trim();

    // STAGE 1: široké hledání
    const wideQuery = buildWideQuery(userQ);
    const stage1 = await vectorSearch(
      {
        vectorStoreId,
        query: wideQuery,
        maxNumResults: 90,
        scoreThreshold: 0.05,
      },
      apiKey
    );

    const items = Array.isArray(stage1?.data) ? stage1.data : [];
    const stage1Scored = rankStage1Items(items, userQ);

    if (!stage1Scored.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, ...(isDebug ? { debug: { stage1: 0 } } : {}) });
    }

    // předvýběr 2 nejlepších zdrojů (souborů)
    const topFiles = pickTopSourceBuckets(stage1Scored, 2);

    // STAGE 2: úzký výběr chunků jen z top souborů
    const chunks = pickStage2Chunks(stage1Scored, topFiles, userQ, isVyhlaskaQuery(userQ) ? 22 : 18);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, ...(isDebug ? { debug: { topFiles, chunks: 0 } } : {}) });
    }

    const contextBlock = buildContext(chunks);

    let answer = await generateAnswer({ userQ, contextBlock }, apiKey);
    answer = cleanAnswerText(answer);

    // nikdy nevracej "Bez odpovědi"
    if (!answer || answer === "Bez odpovědi") answer = HARD_FALLBACK;

    // když model mele nesmysl, radši fallback než halucinace
    if (isBadAnswer(answer)) answer = HARD_FALLBACK;

    // Debug přidáme jako objekt (frontend si to může zobrazit nebo ignorovat)
    const debug = isDebug
      ? {
          wideQuery,
          topFiles,
          topChunks: chunks.slice(0, 6).map((c) => ({ file: c.filename, score: c.score, urls: extractUrls(c.text).slice(0, 3) })),
        }
      : undefined;

    return jsonResponse(200, { ok: true, answer, ...(isDebug ? { debug } : {}) });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}