// netlify/functions/search.mjs (v4)
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string, history?: Array<{role:"user"|"assistant", content:string}> }
// Response: { ok:true, answer:string, thread_id:string, links?: string[] }
//
// Cíl v4:
// - stabilní citace z PDF_TEXT (bez halucinací)
// - lepší “navazování” na kontext (history + thread summary)
// - lepší dotazy do Vector Store: kombinace (userQ + poslední userQ + normalized + hinty typu "vyhláška poplatek ze psů")
// - tvrdá kontrola: když je citace požadovaná, MUSÍ být doslovně z kontextu (jinak fallback)
// - ořez a normalizace odkazu (bez /seniori/)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";
const MODEL = "gpt-4.1-mini";

// Assistants v2 header (pro vector stores i responses)
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
    u = u.replace(/[),.;]+$/g, "");
    u = stripSeniors(u);
    if (u.includes("obec-radim.cz")) out.add(u);
  }
  return Array.from(out);
}

function isQuoteRequest(q) {
  const t = normalizeCzech(q);
  return /(odcituj|cituj|zkopiruj|zkopíruj|presnou vetu|přesnou větu|max 2 vety|max 2 věty|presne dve vety|přesně dvě věty|citace|doslova)/i.test(
    t
  );
}

function isLatestIntent(q) {
  const t = normalizeCzech(q);
  return /(nejnovejs|posledn|aktualn|dnes|k datu|uredni desce|vyvesen|platn|ucinn|účinn)/i.test(t);
}

function isPeopleIntent(q) {
  const t = normalizeCzech(q);
  return /(kdo je|starost|mistostarost|tajemnik|kontakt|telefon|email|e-mail|datova schranka|datová schránka)/i.test(
    t
  );
}

function isPdfHeavyIntent(q) {
  const t = normalizeCzech(q);
  return /(vyhlask|nařizen|narizen|poplatek|odpad|psy|psu|castka|částka|sazba|splatnost|cl\.|čl\.|clanek|článek|odstavec|pdf)/i.test(
    t
  );
}

function isDocAsk(q) {
  // chce “pošli vyhlášku / pdf / odkaz”
  const t = normalizeCzech(q);
  return /(posli|pošli|odkaz|pdf|ke stazeni|ke stažení|vyhlask|vyhlášk|narizen|nařízení)/i.test(t);
}

// ---------- OpenAI ----------
async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...OPENAI_BETA_HEADER,
      ...(body ? { "Content-Type": "application/json" } : {}),
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

// Vector Store Search
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 30, rewriteQuery = true, scoreThreshold = 0.1 },
  apiKey
) {
  // OpenAI API umožňuje query jako string; některé účty snesou i array.
  // Aby to bylo kompatibilní všude: pošli string, ale “slepený” z více dotazů.
  const q = Array.isArray(query) ? query.filter(Boolean).join("\n") : String(query || "");

  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: q,
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

  let b = 0;

  // People
  if (people && f.includes("people")) b += 0.25;

  // Latest
  if (latest && f.includes("00_latest")) b += 0.25;

  // PDF_TEXT (citace / částky)
  if (pdfish && f.includes("30_pdf_text")) b += 0.35;

  // Full je univerzální
  if (f.includes("99_full")) b += 0.08;

  return b;
}

function pickTopChunks(searchJson, userQ, limit = 18) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
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

  const out = [];
  const seen = new Set();

  for (const r of ranked) {
    const key = (r.filename || "") + "::" + r.text.slice(0, 180);
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

function compactHistory(history, maxTurns = 6) {
  // posledních maxTurns USER/ASSISTANT zpráv (jen text)
  const arr = Array.isArray(history) ? history : [];
  const cleaned = arr
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content);

  if (!cleaned.length) return [];
  return cleaned.slice(-maxTurns);
}

function buildHistoryBlock(historyItems) {
  if (!historyItems?.length) return "";
  let s = `\n\nKONTEXT KONVERZACE (poslední zprávy):\n`;
  for (const m of historyItems) {
    const tag = m.role === "user" ? "UŽIVATEL" : "ASISTENT";
    const c = m.content.length > 900 ? m.content.slice(0, 900) + " …" : m.content;
    s += `- ${tag}: ${c}\n`;
  }
  return s.trim();
}

function buildContextBlock(chunks, userQ, historyBlock) {
  const wantsQuote = isQuoteRequest(userQ);
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (relevantní úryvky):\n`;
  ctx += `Dnes je ${todayCZ()}.\n`;
  ctx += `Pozn.: Odkazy uváděj bez "/seniori/".\n`;

  if (historyBlock) {
    ctx += `\n${historyBlock}\n`;
  }

  ctx += `\n---\n`;

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
    ctx +=
      `Uživatel chce CITACI: zkopíruj max 2 věty DOSLOVA z kontextu níže (neparafrázuj).\n` +
      `- Pokud v kontextu přesná věta není, napiš jen: "${HARD_FALLBACK}"\n` +
      `- Přidej 1 řádek: Zdroj: <soubor> + čl./odst. (pokud je v textu).\n`;
  }

  ctx += `---\n`;

  chunks.forEach((c, i) => {
    const cap = wantsQuote ? 9000 : 3500;
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${t}\n`;
    ctx += `---\n`;
  });

  return ctx.trim();
}

function systemPrompt() {
  return (
    `Jsi pečlivý AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej POUZE podle poskytnutého kontextu (úryvky z oficiálních podkladů obce).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Když odpověď v kontextu není, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Pravidla:\n` +
    `- Buď stručný a praktický (1–8 bodů).\n` +
    `- U částek a poplatků vždy uveď částku a splatnost/účinnost, pokud je v kontextu.\n` +
    `- Pokud jde o dokument (vyhláška/nařízení), dej přímý odkaz ke stažení, pokud je v kontextu.\n` +
    `- Nikdy nedávej odkazy se "/seniori/" – vždy použij klasickou verzi webu.\n` +
    `- Pokud uživatel chce citaci, zkopíruj max 2 věty DOSLOVA z kontextu.\n`
  );
}

function extractResponseText(resp) {
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
    if (item?.type === "output_text" && item?.text) out.push(String(item.text));
  }

  return out.join("\n").trim();
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // pryč samotné “6:0” tokeny apod.
  s = s.replace(/\b\d+\s*:\s*\d+\b/g, "");

  // oprav seniors odkazy
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

function shouldFallback(answer) {
  const a = normalizeCzech(answer);
  if (!a) return true;

  // obecné řeči
  if (
    /(doporucuji navstivit|doporučuji navštívit|zkuste se podivat|zkuste se podívat|nejsem si jist|pravdepodobne|pravděpodobně|obecne plati|obecně platí)/i.test(
      answer
    )
  ) {
    return true;
  }

  // “odpověď” bez konkrétní informace u typických dotazů
  if (answer.length < 20) return true;

  return false;
}

/**
 * ✅ Kritické: při žádosti o citaci nechceme HALUCINACE.
 * Ověříme, že věty v uvozovkách se opravdu nachází v poskytnutém kontextu.
 */
function quoteAnswerIsGrounded(answer, contextBlock) {
  // vybereme texty v uvozovkách (české i běžné)
  const quotes = [];
  const re = /[„"]([^“"]{10,500})[“"]/g;
  let m;
  while ((m = re.exec(answer))) {
    const q = (m[1] || "").trim();
    if (q) quotes.push(q);
  }
  if (!quotes.length) return false;

  const ctx = String(contextBlock || "");
  // každá citovaná věta (nebo její začátek) musí být v kontextu
  for (const q of quotes) {
    const needle = q.length > 120 ? q.slice(0, 120) : q;
    if (!ctx.includes(needle)) return false;
  }
  return true;
}

async function generateAnswer({ userMessage, contextBlock, temperature = 0.15 }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
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

// ---------- Handler ----------
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

    // ---- history support (front-end posílá posledních pár zpráv) ----
    const hist = compactHistory(body?.history, 6);
    const historyBlock = buildHistoryBlock(hist);

    // “navázání”: poslední user message (když user píše třeba "tohle je staré")
    const lastUser = [...hist].reverse().find((m) => m.role === "user" && m.content && m.content !== userQ)?.content || "";

    const wantsQuote = isQuoteRequest(userQ);
    const latestIntent = isLatestIntent(userQ);
    const peopleIntent = isPeopleIntent(userQ);
    const pdfIntent = isPdfHeavyIntent(userQ);
    const docAsk = isDocAsk(userQ);

    // ---- Queries do Vector Store (lepší recall) ----
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = lastUser ? `${lastUser}\n${userQ}` : null;

    // hinty (zvyšují recall pro specifické dokumenty)
    const hints = [];
    if (pdfIntent) hints.push(`${userQ} vyhláška článek sazba splatnost PDF`);
    if (latestIntent) hints.push(`${userQ} vyvěšeno účinnost poslední`);
    if (peopleIntent) hints.push(`${userQ} kontakty starostka telefon email`);
    if (docAsk) hints.push(`${userQ} e_download.php evt_file.php`);
    // super důležitý: poplatky
    const tnorm = normalizeCzech(userQ);
    if (/(poplatek).*(pes|psu|psy)/i.test(tnorm)) hints.push(`místní poplatek ze psů obec Radim vyhláška sazba poplatku`);
    if (/(poplatek).*(odpad)/i.test(tnorm)) hints.push(`místní poplatek za obecní systém odpadového hospodářství obec Radim vyhláška výše poplatku`);

    const queries = [q1, q2, q3, ...hints].filter(Boolean);

    // ---- SEARCH ----
    const maxNumResults = wantsQuote ? 60 : (pdfIntent ? 45 : 28);
    const scoreThreshold = wantsQuote ? 0.06 : (pdfIntent ? 0.09 : 0.11);

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

    // ---- Pick chunks ----
    const chunkLimit = wantsQuote ? 26 : (pdfIntent ? 20 : 16);
    const chunks = pickTopChunks(search, userQ, chunkLimit);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, links: [] });
    }

    // ---- Build context ----
    const contextBlock = buildContextBlock(chunks, userQ, historyBlock);

    // ---- Generate answer ----
    const temperature = wantsQuote ? 0.0 : 0.12;
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, temperature }, apiKey);
    answer = cleanAnswer(answer);

    // ---- Quote enforcement ----
    if (wantsQuote) {
      // musí to být grounded v kontextu
      if (!quoteAnswerIsGrounded(answer, contextBlock)) {
        // retry s tvrdším instrukčním doplněním
        const retryBlock =
          contextBlock +
          `\n\nPOZOR: U citace MUSÍŠ kopírovat věty DOSLOVA z kontextu výše. Pokud je nenajdeš, vrať pouze: "${HARD_FALLBACK}"`;

        let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryBlock, temperature: 0.0 }, apiKey);
        retry = cleanAnswer(retry);

        if (!quoteAnswerIsGrounded(retry, retryBlock)) {
          answer = HARD_FALLBACK;
        } else {
          answer = retry;
        }
      }
    } else {
      // ---- Soft fallback ----
      if (shouldFallback(answer)) {
        const retryBlock =
          contextBlock +
          `\n\nPOZOR: Odpověz prosím konkrétně.\n` +
          `- Pokud jde o částku, uveď přesnou částku + splatnost/účinnost a přímý odkaz (pokud je v kontextu).\n` +
          `- Pokud jde o osobu, uveď jméno + telefon + email (pokud je v kontextu).\n` +
          `- Pokud data nejsou v kontextu, vrať přesně: "${HARD_FALLBACK}"`;

        let retry = await generateAnswer({ userMessage: userQ, contextBlock: retryBlock, temperature }, apiKey);
        retry = cleanAnswer(retry);

        if (!retry || shouldFallback(retry)) {
          answer = HARD_FALLBACK;
        } else {
          answer = retry;
        }
      }
    }

    // ---- Links: z kontextu + z odpovědi ----
    const links = Array.from(
      new Set([
        ...chunks.flatMap((c) => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 14);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId, links });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}