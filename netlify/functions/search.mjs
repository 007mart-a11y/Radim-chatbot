// netlify/functions/search.mjs
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
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

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // důležité pro vector stores / assistants v2 věci
      "OpenAI-Beta": "assistants=v2",
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

async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 18, rewriteQuery = true, scoreThreshold = 0.15 },
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

function isPdfFocusedQuestion(q) {
  const s = normalizeCzech(q);
  return (
    /(vyhlask|vyhlášk|ozv|narizen|nařízení|poplatek|mistni poplatek|odpad|psi|psu|psů|pes|splatnost|sazba|uhrada|platba)/.test(s)
  );
}

function looksLikeLinkQuestion(q) {
  const s = normalizeCzech(q);
  return /(odkaz|link|pdf|ke stazeni|ke stažení|stahnout|stáhnout)/.test(s);
}

function extractTextFromSearchItem(it) {
  const chunks = Array.isArray(it?.content) ? it.content : [];
  const text = chunks
    .map((c) => (c?.type === "text" ? c?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

function filenameOf(it) {
  // různá pole podle API; ber všechno co jde
  return it?.filename || it?.file?.filename || it?.file?.name || "";
}

function pickTopChunks(searchJson, limit = 10, prefer = null) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];

  const mapped = items
    .map((it) => {
      const filename = filenameOf(it);
      const score = typeof it?.score === "number" ? it.score : 0;
      const text = extractTextFromSearchItem(it);
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.trim().length > 40);

  // prefer = "pdf" nebo "latest" nebo null
  mapped.sort((a, b) => {
    const ap = preferScore(a.filename, prefer);
    const bp = preferScore(b.filename, prefer);
    if (bp !== ap) return bp - ap;
    return (b.score || 0) - (a.score || 0);
  });

  return mapped.slice(0, limit).map((x) => ({ ...x, text: x.text.slice(0, 2600) }));
}

function preferScore(filename, prefer) {
  const f = (filename || "").toLowerCase();
  if (!prefer) return 0;
  if (prefer === "pdf") {
    if (f.includes("30_pdf_text")) return 3;
    if (f.includes("00_latest")) return 2;
    if (f.includes("99_full")) return 1;
    return 0;
  }
  if (prefer === "latest") {
    if (f.includes("00_latest")) return 3;
    if (f.includes("30_pdf_text")) return 2;
    if (f.includes("99_full")) return 1;
    return 0;
  }
  return 0;
}

function buildContextBlock(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (použij výhradně tyto úryvky):\n---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${c.score ?? "?"})\n`;
    ctx += `${c.text}\n---\n`;
  });
  return ctx.trim();
}

function extractUrlsFromContext(contextBlock, max = 3) {
  const urls = new Set();
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  const matches = String(contextBlock || "").match(re) || [];
  for (const u of matches) {
    // nechceme 20 odkazů, jen relevantní (typicky e_download / uredni_deska / kontakt)
    if (!/obec-radim\.cz/i.test(u)) continue;
    if (/\.jpg|\.png|\.gif|facebook\.com/i.test(u)) continue;
    urls.add(u.replace(/[),.]+$/g, ""));
    if (urls.size >= max) break;
  }
  return Array.from(urls);
}

function systemPrompt() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš POUZE z poskytnutého kontextu (úryvky z oficiálních podkladů).\n` +
    `Nevymýšlej fakta, jména, částky ani kontakty.\n` +
    `Když odpověď z kontextu nejde jednoznačně doložit, napiš přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `Formát:\n` +
    `Odpověď: 1–6 krátkých bodů NEBO 1–4 věty.\n` +
    `Odkazy: 1–3 přímé odkazy, pokud jsou v kontextu dostupné.\n\n` +
    `Zakázáno:\n` +
    `- obecné rady typu "doporučuji kontaktovat", pokud to není přímo v kontextu\n` +
    `- odhadování, pravděpodobně, nejspíš, apod.\n`
  );
}

async function generateAnswer({ userMessage, contextBlock, urlHints }, apiKey) {
  const promptUser =
    `${contextBlock}\n\n` +
    `DOTAZ UŽIVATELE:\n${userMessage}\n\n` +
    `POVINNOST:\n` +
    `- pokud odpovídáš, opři to o konkrétní větu/údaj z kontextu\n` +
    `- pokud je dotaz na vyhlášku/poplatek a v kontextu je PDF text, použij ho\n` +
    `- do sekce Odkazy dej jen tyto nalezené URL (vyber max 3):\n${urlHints.map((u) => `- ${u}`).join("\n")}\n`;

  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.15,
        input: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: promptUser },
        ],
      }),
    },
    apiKey
  );

  const out = Array.isArray(resp?.output) ? resp.output : [];
  const msg = out.find((x) => x?.type === "message");
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const text = content
    .map((c) => (c?.type === "output_text" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || HARD_FALLBACK;
}

function cleanAnswer(t) {
  let s = String(t || "");
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.trim();
}

function looksBad(answer) {
  if (!answer) return true;
  const a = String(answer);

  // zakázané fráze / obecné kecy
  if (/(doporučuji kontaktovat|nejsem si jist|pravděpodobně|mohlo by|zkuste|obvykle se)/i.test(a)) return true;

  // pokud to není fallback, chceme aspoň nějakou "kotvu" (číslo/datum/URL/tel/email)
  if (a !== HARD_FALLBACK) {
    const hasAnchor =
      /\b\d{1,3}\s?(kč|Kč)\b/.test(a) ||
      /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b/.test(a) ||
      /\bhttps?:\/\/\S+/i.test(a) ||
      /\b\d{3}\s?\d{3}\s?\d{3}\b/.test(a) ||
      /\b\S+@\S+\.\S+\b/.test(a);

    if (!hasAnchor) return true;
  }

  return false;
}

function ensureLinks(answer, urlHints) {
  let t = String(answer || "").trim();
  if (!t || t === HARD_FALLBACK) return t;

  const hasLinksSection = /\bOdkazy\s*:/i.test(t);
  const hasAnyUrl = /\bhttps?:\/\/[^\s<>"')\]]+/i.test(t);

  const pick = (urlHints || []).slice(0, 3);
  if (!pick.length) return t;

  if (!hasAnyUrl) {
    t += `\n\nOdkazy:\n` + pick.map((u) => `- ${u}`).join("\n");
    return t.trim();
  }

  // už nějaké URL má → jen přidej sekci Odkazy, pokud chybí
  if (!hasLinksSection) {
    t += `\n\nOdkazy:\n` + pick.map((u) => `- ${u}`).join("\n");
  }

  return t.trim();
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

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // ===== 1) Search pass A (široké) =====
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec Radim`;
    const prefer = isPdfFocusedQuestion(userQ) ? "pdf" : "latest";

    const searchA = await vectorSearch(
      {
        vectorStoreId,
        query: [q1, q2, q3],
        maxNumResults: 24,
        rewriteQuery: true,
        scoreThreshold: 0.12,
      },
      apiKey
    );

    let chunksA = pickTopChunks(searchA, 12, prefer);

    if (!chunksA.length) return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId });

    // ===== 2) Search pass B (zacílení podle tématu) =====
    // když jde o vyhlášky/poplatky/linky, přidej cílené dotazy
    const focusQueries = [];
    if (isPdfFocusedQuestion(userQ)) {
      focusQueries.push(
        `vyhláška ${OBEC_NAZEV} ${userQ}`,
        `místní poplatek ${OBEC_NAZEV} ${userQ}`,
        `e_download.php ${OBEC_NAZEV} ${userQ}`
      );
    }
    if (looksLikeLinkQuestion(userQ)) {
      focusQueries.push(`PDF odkaz ${OBEC_NAZEV} ${userQ}`, `ke stažení ${OBEC_NAZEV} ${userQ}`);
    }

    let chunks = chunksA;

    if (focusQueries.length) {
      const searchB = await vectorSearch(
        {
          vectorStoreId,
          query: focusQueries,
          maxNumResults: 24,
          rewriteQuery: true,
          scoreThreshold: 0.10,
        },
        apiKey
      );
      const chunksB = pickTopChunks(searchB, 10, "pdf");

      // merge + dedupe by (filename + first 120 chars)
      const seen = new Set();
      const merged = [];
      for (const c of [...chunksB, ...chunksA]) {
        const key = `${c.filename}::${c.text.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(c);
        if (merged.length >= 12) break;
      }
      chunks = merged;
    }

    const contextBlock = buildContextBlock(chunks);
    const urlHints = extractUrlsFromContext(contextBlock, 3);

    // ===== 3) Answer =====
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, urlHints }, apiKey);
    answer = cleanAnswer(answer);

    // ===== 4) Hard guardrail =====
    if (looksBad(answer)) answer = HARD_FALLBACK;
    answer = ensureLinks(answer, urlHints);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}