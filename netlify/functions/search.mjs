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
 * ➕ NOVÉ: vezme poslední N zpráv (user+assistant) a udělá krátký kontext.
 * Pozn.: Messages API vrací nejnovější jako první → otočíme pro čitelnost.
 */
async function getRecentConversationContext(threadId, apiKey, limit = 8, maxTurns = 4) {
  try {
    const messages = await api(`/threads/${threadId}/messages?limit=${limit}`, {}, apiKey);
    const data = Array.isArray(messages?.data) ? messages.data : [];
    if (!data.length) return "";

    // nejdřív seřadit od nejstarší k nejnovější (kvůli kontextu)
    const ordered = [...data].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    // vyber jen user/assistant a jen textové části
    const turns = [];
    for (const m of ordered) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      if (!Array.isArray(m.content) || !m.content.length) continue;

      const parts = m.content
        .map((c) => (c?.type === "text" ? c.text?.value : ""))
        .filter(Boolean);

      const text = parts.join("\n\n").trim();
      if (!text) continue;

      // zkrať každou zprávu, ať to neexpanduje do nekonečna
      const clipped = text.length > 900 ? text.slice(0, 900) + "…" : text;

      turns.push({ role: m.role, text: clipped });
    }

    if (!turns.length) return "";

    // vezmi posledních maxTurns zpráv (user+assistant dohromady)
    const tail = turns.slice(-maxTurns);

    // formát:
    // Uživatel: ...
    // Radim: ...
    const formatted = tail
      .map((t) => `${t.role === "user" ? "Uživatel" : "Radim"}:\n${t.text}`)
      .join("\n\n");

    return formatted.trim();
  } catch {
    return "";
  }
}

/**
 * Minimum cleaning – beze změn
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
 * Minimal URL normalization – beze změn
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

function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu: 99_FULL_obec_radim.txt.\n\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
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

    // ✅ KONTEXT: poslední zprávy user+assistant (krátký výpis)
    const recentCtx = await getRecentConversationContext(threadId, apiKey, 10, 4);

    const contextualMessage = recentCtx
      ? `KONTEXT POSLEDNÍ KONVERZACE:\n${recentCtx}\n\nNOVÝ DOTAZ UŽIVATELE:\n${message.trim()}`
      : message.trim();

    // USER MESSAGE
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: contextualMessage,
        }),
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

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}