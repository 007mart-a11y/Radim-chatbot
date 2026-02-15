// netlify/functions/search.mjs  (v3)
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string, links?: string[] }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

// Vector Store endpoints (assistants v2 header is needed for some orgs/accounts)
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

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
  // chceme vždy canonical "klasický web", bez /seniori/
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
    let u = m[0];
    u = u.replace(/[),.;]+$/g, ""); // trim trailing punctuation
    u = stripSeniors(u);
    if (u.includes("obec-radim.cz")) out.add(u);
  }
  return Array.from(out);
}

function isQuoteRequest(q) {
  const t = normalizeCzech(q);
  return /(odcituj|cituj|zkopiruj|presnou vetu|presne dve vety|max 2 vety|citace)/i.test(t);
}

function isLatestIntent(q) {
  const t = normalizeCzech(q);
  return /(nejnovejs|posledn|aktualn|dnes|k datu|uredni desce|vyvesen|platn|vyhlask)/i.test(t);
}

function isPeopleIntent(q) {
  const t = normalizeCzech(q);
  return /(kdo je|starost|mistostarost|tajemnik|kontakt|telefon|email|e-mail|predseda|predsedkyne)/i.test(t);
}

function isPdfHeavyIntent(q) {
  const t = normalizeCzech(q);
  return /(vyhlask|poplatek|odpad|psy|psu|castka|sazba|splatnost|cl\.|clanek|odstavec|pdf)/i.test(t);
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

/**
 * Vector Store Search
 * POST /v1/vector_stores/{vector_store_id}/search
 */
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 24, rewriteQuery = true, scoreThreshold = 0.12 },
  apiKey
) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: rewriteQuery,
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
  const text = chunks
    .map((c) => (c?.type === "text" ? c?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

function scoreBoost(filename, userQ) {
  const f = (filename || "").toLowerCase();
  const latest = isLatestIntent(userQ);
  const people = isPeopleIntent(userQ);
  const pdfish = isPdfHeavyIntent(userQ);

  // základní boosty (jemné, ne “tvrdé”)
  let b = 0;

  // People
  if (people && f.includes("people")) b += 0.18;

  // Latest
  if (latest && f.includes("00_latest")) b += 0.18;

  // PDF_TEXT (citace / částky)
  if (pdfish && f.includes("30_pdf_text")) b += 0.22;

  // Full je univerzální
  if (f.includes("99_full")) b += 0.06;

  return b;
}

function pickTopChunks(searchJson, userQ, limit = 16) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  const out = [];

  // přepočítej skóre + boost
  const ranked = items
    .map((it) => {
      const filename = getFilename(it);
      const base = typeof it?.score === "number" ? it.score : 0;
      const boosted = base + scoreBoost(filename, userQ);
      const text = flattenChunkText(it);
      return { filename, base, score: boosted, text };
    })
    .filter((x) => x.text && x.text.length > 40)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  // sběr, dedupe podobných kusů
  const seen = new Set();
  for (const r of ranked) {
    const key = (r.filename || "") + "::" + r.text.slice(0, 120);
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

function buildContextBlock(chunks, userQ) {
  // “chytré” navedení: krátká mapa + potom úryvky
  const wantsQuote = isQuoteRequest(userQ);

  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (výběr relevantních úryvků):\n`;
  ctx += `Dnes je ${todayCZ()}.\n`;
  ctx += `Pozn.: Odkazy uváděj bez "/seniori/".\n`;
  ctx += `\n---\n`;

  // mapa zdrojů (pomáhá modelu “přemýšlet”)
  const srcCounts = {};
  for (const c of chunks) {
    const f = (c.filename || "").toLowerCase();
    const k =
      f.includes("00_latest") ? "LATEST" :
      f.includes("30_pdf_text") ? "PDF_TEXT" :
      f.includes("people") ? "PEOPLE" :
      f.includes("99_full") ? "FULL" :
      "OTHER";
    srcCounts[k] = (srcCounts[k] || 0) + 1;
  }
  ctx += `Zdroje v kontextu: ${Object.entries(srcCounts).map(([k,v]) => `${k}:${v}`).join("  ")}\n`;
  if (wantsQuote) {
    ctx += `Uživatel chce CITACI: zkopíruj max 2 věty PŘESNĚ z kontextu (neparafrázuj) a napiš, odkud jsou (soubor + čl./odst.).\n`;
  }
  ctx += `---\n`;

  chunks.forEach((c, i) => {
    // u citací necháme víc textu
    const cap = wantsQuote ? 5200 : 3200;
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${t}\n`;
    ctx += `---\n`;
  });

  return ctx.trim();
}

function systemPrompt() {
  // žádné “striktní sračky”, ale zároveň bez halucinací
  return (
    `Jsi užitečný a pečlivý AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej POUZE podle poskytnutého kontextu (úryvky z oficiálních podkladů obce).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Když odpověď v kontextu není, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Pravidla:\n` +
    `- Buď stručný a praktický (1–6 bodů).\n` +
    `- U částek a poplatků vždy uveď datum/platnost pokud je v kontextu.\n` +
    `- U dokumentů dávej přímý odkaz ke stažení (e_download / evt_file) pokud existuje.\n` +
    `- Nikdy nedávej odkazy se "/seniori/" – vždy použij klasickou verzi webu.\n` +
    `- Pokud uživatel chce citaci, zkopíruj max 2 věty PŘESNĚ z kontextu (bez parafráze).\n`
  );
}

function extractResponseText(resp) {
  // robustní parsování Responses API
  // vrací string i když je struktura jiná
  const out = [];

  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    out.push(resp.output_text.trim());
  }

  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && c?.text) out.push(String(c.text));
        if (c?.type === "text" && c?.text) out.push(String(c.text));
      }
    }
    // některé účty vrací i “output_text” v jiných itemech
    if (item?.type === "output_text" && item?.text) out.push(String(item.text));
  }

  return out.join("\n").trim();
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // oprav seniors odkazy
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

function shouldFallback(answer) {
  const a = normalizeCzech(answer);
  if (!a) return true;
  // když model ujede do obecných keců bez dat
  if (/(doporucuji navstivit|doporučuji navštívit|zkuste se podivat|nejsem si jist|pravdepodobne|obecne plati)/i.test(answer)) {
    return true;
  }
  return false;
}

function minimalQuoteSanity(answer, userQ) {
  // nechceme substring-check, ale nechceme ani haluz
  if (!isQuoteRequest(userQ)) return true;

  // když chce citaci, trváme na tom že odpověď obsahuje uvozovky
  const hasQuotes = /[„"].+?[“"]/.test(answer) || /".+?"/.test(answer);
  if (!hasQuotes) return false;

  // ať to není prázdné
  if (answer.length < 40) return false;

  return true;
}

async function generateAnswer({ userMessage, contextBlock, temperature = 0.15 }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature,
        input: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
        ],
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

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    const wantsQuote = isQuoteRequest(userQ);
    const latestIntent = isLatestIntent(userQ);
    const pdfIntent = isPdfHeavyIntent(userQ);

    // 1) SEARCH (víc výsledků pro citace)
    const maxNumResults = wantsQuote ? 36 : (pdfIntent ? 30 : 22);
    const scoreThreshold = wantsQuote ? 0.08 : 0.12;

    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = latestIntent ? `${userQ} vyvěšeno účinnost` : `${userQ} obec Radim`;
    const q4 = pdfIntent ? `${userQ} článek odstavec sazba splatnost` : null;

    const queries = [q1, q2, q3].filter(Boolean);
    if (q4) queries.push(q4);

    const search = await vectorSearch(
      {
        vectorStoreId,
        query: queries,
        maxNumResults,
        rewriteQuery: true,
        scoreThreshold,
      },
      apiKey
    );

    // 2) Pick chunks (rerank/boost)
    const chunkLimit = wantsQuote ? 22 : (pdfIntent ? 18 : 14);
    const chunks = pickTopChunks(search, userQ, chunkLimit);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [] });
    }

    // 3) Build context
    const contextBlock = buildContextBlock(chunks, userQ);

    // 4) Generate answer (citace: teplota níž)
    const temperature = wantsQuote ? 0.0 : 0.15;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, temperature }, apiKey);
    answer = cleanAnswer(answer);

    // 5) Soft fallback rules (NE paralyzující)
    if (shouldFallback(answer) || !minimalQuoteSanity(answer, userQ)) {
      // ještě 1 pokus: přitvrdit navádění (lepší pro “kdo je starosta” / “kolik je poplatek”)
      const retryBlock =
        contextBlock +
        `\n\nPOZOR: Odpověz prosím konkrétně. Pokud jde o částku, uveď přesnou částku a odkaz. ` +
        `Pokud jde o osobu (starosta/starostka), uveď jméno + telefon + email, pokud jsou v kontextu.`;

      let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryBlock, temperature }, apiKey);
      retry = cleanAnswer(retry);

      // fallback až když je to fakt marný
      if (!retry || shouldFallback(retry) || (wantsQuote && !minimalQuoteSanity(retry, userQ))) {
        answer = HARD_FALLBACK;
      } else {
        answer = retry;
      }
    }

    // 6) Links: z kontextu + z odpovědi (bez seniors)
    const links = Array.from(
      new Set([
        ...chunks.flatMap((c) => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 12);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId, links });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}