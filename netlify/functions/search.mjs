// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const REQUIRED_FALLBACK =
  "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";

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
    err.status = res.status;
    throw err;
  }

  return json ?? {};
}

/* ======================= helpers ======================= */

function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];
  const assistantMsgs = data.filter(
    (m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length
  );
  if (!assistantMsgs.length) return "";
  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return assistantMsgs[0].content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean)
    .join("\n\n");
}

function cleanAnswer(text) {
  let t = String(text || "");
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/* ======================= URL normalization ======================= */

function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;
  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^https?:\/\/https?:\/\//i, "https://");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");
  u = u.replace(/\.pd$/i, ".pdf");
  u = u.replace(/([^:]\/)\/+/g, "$1");
  return u;
}

function normalizeUrlsInText(text) {
  return String(text || "").replace(
    /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi,
    (m) => normalizeSingleUrl(m)
  );
}

/* ======================= instructions ======================= */

function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu 99_FULL_obec_radim.txt.\n\n` +
    `Pokud nelze jednoznačně určit aktuální osobu (např. kdo vede / spravuje),\n` +
    `uveď tuto skutečnost a nabídni nejlepší dostupný kontakt ze zdroje,\n` +
    `pokud existuje. Historické informace nikdy nevydávej jako aktuální.\n\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
}

/* ======================= guards ======================= */

function wantsCurrentInfo(msg) {
  return /\b(kdo\s+vede|kdo\s+je|spravuje|aktu(á|a)ln)\b/i.test(msg);
}

function containsHistoricalSignals(answer) {
  return /\b(19\d{2}|20\d{2})\b|\b(v\s+roce|byl[a]?\s+zvolen)\b/i.test(answer);
}

function shouldForceFallback(userMsg, answer) {
  if (wantsCurrentInfo(userMsg) && containsHistoricalSignals(answer)) return true;
  return false;
}

/* ======================= SOFT fallback ======================= */

function hasFactualContent(text) {
  if (!text) return false;
  if (/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(text)) return true;
  if (/\b(předsed|správc|TJ\s+Sokol|kontakt|telefon|email)\b/i.test(text)) return true;
  return false;
}

/* ======================= handler ======================= */

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    const body = await req.json();
    const message = String(body?.message || "").trim();

    // 🔁 RESET THREAD
    if (message.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, {
        ok: true,
        answer: "Resetováno.",
        thread_id: created.id,
      });
    }

    // nový thread
    const thread = await api("/threads", { method: "POST" }, apiKey);
    const threadId = thread.id;

    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: message }),
      },
      apiKey
    );

    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: buildRunInstructions(),
          temperature: 0.1,
        }),
      },
      apiKey
    );

    while (true) {
      await sleep(600);
      const r = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
      if (r.status === "completed") break;
    }

    const messages = await api(`/threads/${threadId}/messages?limit=20`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);

    answer = normalizeUrlsInText(cleanAnswer(answer));

    if (shouldForceFallback(message, answer)) {
      answer = REQUIRED_FALLBACK;
    }

    if (!answer || !hasFactualContent(answer)) {
      answer = REQUIRED_FALLBACK;
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}