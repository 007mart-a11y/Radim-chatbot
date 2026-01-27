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
    throw new Error(`${method} ${path} failed: ${msg}`);
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
 * Minimum cleaning
 */
function cleanAnswer(text) {
  let t = String(text || "");

  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * Minimal URL normalization (už máš)
 */
function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");
  u = u.replace(/^https?:\/\/https:\/\//i, "https://");
  u = u.replace(/^https?:\/\/http:\/\//i, "http://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");
  u = u.replace(/\.pd$/i, ".pdf");
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
 * Instructions – nechávám jednoduché, ale doplním jednu jedinou větu pro kontakty.
 * (Neřešíme tady "AI kecy" apod., jen to, aby nepletlo osobu s obcí.)
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu: 99_FULL_obec_radim.txt.\n\n` +
    `DŮLEŽITÉ: Pokud se uživatel ptá na kontakt KONKRÉTNÍ OSOBY, odpovídej pouze kontaktem této osoby, ne kontaktem obce/úřadu.\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
}

/* =========================================================
   ✅ "Tvrdé" držení subjektu: thread metadata + přepis zájmen
   ========================================================= */

/**
 * Thread metadata (persistuje mezi dotazy)
 */
async function getThreadMetadata(threadId, apiKey) {
  try {
    const th = await api(`/threads/${threadId}`, {}, apiKey);
    return th?.metadata || {};
  } catch {
    return {};
  }
}

async function updateThreadMetadata(threadId, apiKey, patch) {
  try {
    await api(
      `/threads/${threadId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: patch }),
      },
      apiKey
    );
  } catch {
    // ignore
  }
}

/**
 * Najdi jména osob v textu (konzervativně: dvě slova s velkým písmenem, CZ diakritika)
 */
const PERSON_REGEX =
  /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

const PERSON_BLACKLIST = new Set([
  "Obec Radim",
  "Obecní úřad",
  "Obecní Úřad",
  "Obecní úřad Radim",
  "Obec Radim 8",
]);

function extractPersonCandidates(text) {
  const t = String(text || "");
  const matches = [...t.matchAll(PERSON_REGEX)].map((m) => `${m[1]} ${m[2]}`);

  // odfiltruj běžné “ne-osoby”
  const filtered = matches.filter((name) => !PERSON_BLACKLIST.has(name));
  return filtered;
}

function pickLastPerson(text) {
  const people = extractPersonCandidates(text);
  if (!people.length) return "";
  return people[people.length - 1];
}

/**
 * Rozpoznání kontakt otázky a zájmen
 */
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

/**
 * Přepiš dotaz "na ni/na něj" na explicitní dotaz s osobou.
 * To je ten "tvrdý" fix, aby uživatelé nebyli zmatení.
 */
function rewritePronounContactQuestion(original, personName) {
  const q = String(original || "").trim();
  const p = String(personName || "").trim();
  if (!q || !p) return q;

  // pokud už uživatel jméno obsahuje, nepřepisuj
  if (q.toLowerCase().includes(p.toLowerCase())) return q;

  const wantsEmail = /\b(email|e-mail|mail)\b/i.test(q);
  const wantsPhone = /\b(telefon|kontakt|zavolat|volat)\b/i.test(q);

  if (wantsEmail && wantsPhone) {
    return `Jaký je e-mail a telefon na ${p}?`;
  }
  if (wantsEmail) {
    return `Jaký je e-mail na ${p}?`;
  }
  if (wantsPhone) {
    return `Jaký je telefon na ${p}?`;
  }

  // obecný fallback
  return `Dotaz se týká osoby ${p}: ${q}`;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!assistantId) return jsonResponse(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    // THREAD
    let threadId = body?.thread_id;
    if (!threadId || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // ✅ 1) vytáhni last_person z metadata
    const md = await getThreadMetadata(threadId, apiKey);
    const lastPerson = typeof md?.last_person === "string" ? md.last_person : "";

    // ✅ 2) tvrdý přepis zájmen u kontaktových dotazů
    let outgoingMessage = String(message).trim();

    if (isContactQuestion(outgoingMessage) && hasPronounReference(outgoingMessage) && lastPerson) {
      outgoingMessage = rewritePronounContactQuestion(outgoingMessage, lastPerson);
    }

    // USER MESSAGE
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: outgoingMessage }),
      },
      apiKey
    );

    // RUN
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

    // POLL
    const started = Date.now();
    while (true) {
      if (Date.now() - started > 45_000) {
        return jsonResponse(504, { ok: false, error: "Timeout" });
      }

      await sleep(650);
      const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);

      if (check.status === "completed") break;
      if (check.status !== "queued" && check.status !== "in_progress") {
        return jsonResponse(500, { ok: false, error: "Run failed", status: check.status });
      }
    }

    // READ
    const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);

    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    if (!answer) {
      answer =
        "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";
    }

    // ✅ 3) po odpovědi aktualizuj last_person (persistuje pro další dotaz)
    // (tohle je "jednou provždy" – další dotaz už ví, kdo je "ona")
    const detectedPerson = pickLastPerson(answer);
    if (detectedPerson) {
      await updateThreadMetadata(threadId, apiKey, { ...(md || {}), last_person: detectedPerson });
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