// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID
// Request JSON: { message: string, thread_id?: string }
// Response JSON: { ok: true, answer: string, thread_id: string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function api(path, { method = "GET", body, headers = {} } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    // ✅ důležité pro spolehlivý fallback
    err.status = res.status;
    err.path = path;
    err.method = method;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

/**
 * Vezme poslední assistant zprávu podle created_at.
 */
function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];
  const assistantMsgs = data.filter(
    (m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length
  );

  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  const parts = msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.join("\n\n");
}

/**
 * Vezme text z message.content (jen textové části).
 */
function extractMessageText(messageObj) {
  if (!messageObj || !Array.isArray(messageObj.content) || !messageObj.content.length) return "";
  const parts = messageObj.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

/**
 * Minimum cleaning:
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // odstranit tečku/čárku za URL
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");

  // zrušit prázdné markdown odkazy
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * Minimal URL normalization
 */
function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");
  u = u.replace(/^https?:\/\/https:\/\//i, "https://");
  u = u.replace(/^https?:\/\/http:\/\//i, "http://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");

  // oprav chybějící tečku
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");

  // občas useknuté .pdf
  u = u.replace(/\.pd$/i, ".pdf");

  // dvojité //
  u = u.replace(/([^:]\/)\/+/g, "$1");

  return u;
}

function normalizeUrlsInText(text) {
  let t = String(text || "");
  if (!t) return t;

  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;
  t = t.replace(re, (m) => normalizeSingleUrl(m));

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/**
 * Run instructions (nepřepisuju promptovou filozofii, jen minimální).
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu: 99_FULL_obec_radim.txt.\n\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
}

/* =========================================================
   ✅ HARD COREFERENCE: přepis zájmen -> explicitní osoba
   - bere kontext z posledních zpráv USER+ASSISTANT
   ========================================================= */

const PERSON_REGEX =
  /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

function pickLastPersonFromText(text) {
  const t = String(text || "");
  const matches = [...t.matchAll(PERSON_REGEX)].map((m) => `${m[1]} ${m[2]}`);

  // Odfiltruj nejčastější ne-osoby
  const filtered = matches.filter((name) => {
    const n = name.toLowerCase();
    if (n.startsWith("obec ")) return false;
    if (n.startsWith("obecní ")) return false;
    if (n.includes("obecní úřad")) return false;
    return true;
  });

  return filtered.length ? filtered[filtered.length - 1] : "";
}

function messageAlreadyContainsPersonName(msg) {
  return PERSON_REGEX.test(String(msg || ""));
}

function isContactQuestion(msg) {
  const s = String(msg || "").toLowerCase();
  return /\b(email|e-mail|mail|telefon|kontakt|zavolat|volat)\b/.test(s);
}

function hasPronounReference(msg) {
  const s = String(msg || "").toLowerCase();
  return /\b(na\s+ni|na\s+něj|na\s+ně|na\s+něho|její|jeho|jí|mu|něj|ní|tomu|té|toho|ta|ten|to)\b/.test(
    s
  );
}

function rewriteToExplicitPersonQuestion(original, personName) {
  const q = String(original || "").trim();
  const p = String(personName || "").trim();
  if (!q || !p) return q;

  const wantsEmail = /\b(email|e-mail|mail)\b/i.test(q);
  const wantsPhone = /\b(telefon|kontakt|zavolat|volat)\b/i.test(q);

  if (wantsEmail && wantsPhone) return `Jaký je e-mail a telefon na ${p}?`;
  if (wantsEmail) return `Jaký je e-mail na ${p}?`;
  if (wantsPhone) return `Jaký je telefon na ${p}?`;

  return `Dotaz se týká osoby ${p}: ${q}`;
}

/**
 * Najde "nejnovější osobu" z posledních N zpráv (user+assistant).
 * Důležité: procházíme OD NEJNOVĚJŠÍCH k nejstarším.
 */
async function getLastReferencedPersonFromThread(threadId, apiKey, limit = 12) {
  try {
    const messages = await api(`/threads/${threadId}/messages?limit=${limit}`, {}, apiKey);
    const data = Array.isArray(messages?.data) ? messages.data : [];
    if (!data.length) return "";

    // data je typicky nejnovější první – pro jistotu seřadíme dle created_at desc
    const orderedDesc = [...data].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    for (const m of orderedDesc) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const txt = extractMessageText(m);
      if (!txt) continue;
      const p = pickLastPersonFromText(txt);
      if (p) return p;
    }

    return "";
  } catch {
    return "";
  }
}

/**
 * ✅ Spolehlivé zajištění threadu:
 * - když je incoming thread_id neplatný (404), vytvoří nový.
 */
async function ensureThreadId(incomingThreadId, apiKey) {
  let threadId = incomingThreadId;

  if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
    const created = await api("/threads", { method: "POST" }, apiKey);
    return created.id;
  }

  try {
    // ověření existence threadu
    await api(`/threads/${threadId}`, {}, apiKey);
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return created.id;
    }
    // jiné chyby necháme propadnout (ať víme, že je problém jinde)
    throw e;
  }
}

/**
 * ✅ Spolehlivé přidání zprávy do threadu s jednorázovým fallbackem při 404.
 */
async function addUserMessageWithFallback(threadId, content, apiKey) {
  try {
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content }),
      },
      apiKey
    );
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      const newThreadId = created.id;

      await api(
        `/threads/${newThreadId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "user", content }),
        },
        apiKey
      );

      return newThreadId;
    }
    throw e;
  }
}

/* =========================================================
   ✅ SAFETY GUARD: anti-historie + anti-"doporučuji kontaktovat"
   ========================================================= */

const REQUIRED_FALLBACK =
  "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";

function wantsCurrentInfo(userMsg) {
  const s = String(userMsg || "").toLowerCase();
  return /\b(aktu(á|a)ln(ě|i)|kdo\s+vede|vede\s+kdo|kdo\s+je|spr(á|a)vce|spravuje|veden(í|i)|p(ř|r)edsed|m(í|i)stop(ř|r)edsed|zodpov(ě|e)dn|na\s+starosti)\b/.test(
    s
  );
}

function containsHistoricalSignals(answer) {
  const t = String(answer || "");
  return (
    /\b(19\d{2}|20\d{2})\b/.test(t) ||
    /\b(v\s+roce|roku|od\s+roku|do\s+roku|byla\s+zvolen|byl\s+zvolen|zvolen[ay]?|působil|zastával|vystřídal|dlouholet[ýá])\b/i.test(
      t
    )
  );
}

function containsForbiddenRecommend(answer) {
  const t = String(answer || "").toLowerCase();
  return /\b(doporu(č|c)uji\s+kontaktovat|obra(ť|t)te\s+se|pro\s+p(ř|r)esn(é|e)\s+informace\s+doporu(č|c)uji|kontaktujte)\b/.test(
    t
  );
}

function shouldForceFallback(userMsg, answer) {
  if (wantsCurrentInfo(userMsg) && containsHistoricalSignals(answer)) return true;
  if (containsForbiddenRecommend(answer)) return true;
  return false;
}

/* =========================================================
   ✅ SOFT FALLBACK: (JEDINÁ ZMĚNA)
   - fallback dáme jen když je odpověď prázdná
   - nebo když je tak nekonkrétní, že v ní není žádný fakt
   ========================================================= */

function hasFactualContent(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  // jméno osoby (2 slova s velkým písmenem)
  if (/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+/.test(t))
    return true;

  // telefon / email / url
  if (/\b(\+?\d[\d\s]{7,}\d)\b/.test(t)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(t)) return true;
  if (/\bhttps?:\/\/\S+/i.test(t)) return true;

  // role a „tvrdá“ slova, která znamenají, že tam něco je
  if (
    /\b(předsedkyn|předsed|místopředsed|správc|veden|výbor|rada|pokladn|jednatel|kontakt)\b/i.test(t)
  )
    return true;

  return false;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!assistantId) return jsonResponse(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    // ✅ Variant A: pokračujeme ve stejném threadu, když přijde; jinak založíme nový.
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // ✅ HARD COREFERENCE (ponecháno):
    let outgoingMessage = String(message).trim();

    const needRewrite =
      isContactQuestion(outgoingMessage) &&
      hasPronounReference(outgoingMessage) &&
      !messageAlreadyContainsPersonName(outgoingMessage);

    if (needRewrite) {
      const lastPerson = await getLastReferencedPersonFromThread(threadId, apiKey, 12);
      if (lastPerson) {
        outgoingMessage = rewriteToExplicitPersonQuestion(outgoingMessage, lastPerson);
      }
    }

    // 1) user msg (s fallbackem, kdyby threadId přece jen neexistoval)
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    // 2) run
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: buildRunInstructions(),
          temperature: 0.1,
          top_p: 1,
        }),
      },
      apiKey
    );

    // 3) poll
    const started = Date.now();
    const timeoutMs = 45_000;

    while (true) {
      if (Date.now() - started > timeoutMs) {
        return jsonResponse(504, { ok: false, error: "Timeout waiting for response" });
      }

      await sleep(650);

      const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
      const status = check.status;

      if (status === "queued" || status === "in_progress") continue;

      if (status === "requires_action") {
        return jsonResponse(501, {
          ok: false,
          error: "Run requires action (tool call not handled in function).",
          status,
        });
      }

      if (status !== "completed") {
        return jsonResponse(500, { ok: false, error: "Run failed", status });
      }

      break;
    }

    // 4) read messages
    const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);

    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    // ✅ SAFETY GUARD (po cleanu, před fallbackem) — BEZE ZMĚNY
    if (shouldForceFallback(outgoingMessage, answer)) {
      answer = REQUIRED_FALLBACK;
    }

    // ✅ SOFT fallback (JEDINÁ změna proti tvé verzi)
    // - pokud odpověď není prázdná a obsahuje fakta, NEPŘEPISUJEME ji fallbackem
    // - fallback dáme jen při prázdné/nekonkrétní odpovědi
    const trimmed = String(answer || "").trim();
    const tooVague = trimmed.length < 40 && !hasFactualContent(trimmed);

    if (!trimmed || tooVague) {
      answer = REQUIRED_FALLBACK;
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}