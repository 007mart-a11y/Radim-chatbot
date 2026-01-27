// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID

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

function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];
  const assistantMsgs = data.filter(
    (m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length
  );

  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  return msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean)
    .join("\n\n");
}

function cleanAnswer(text) {
  let t = String(text || "");
  t = t.replace(/【[^】]*】/g, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n` +
    `Odpovídáš výhradně na základě dokumentu 99_FULL_obec_radim.txt.\n` +
    `Pokud dotaz míří na vedení, správu nebo odpovědnost a existují související aktuální údaje,\n` +
    `uveď je shrnujícím způsobem, i když pojem z dotazu není použit doslovně.\n` +
    `Historické informace nikdy nepoužívej jako aktuální.\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
}

// jednoduchá detekce „faktické odpovědi“
function hasFactualContent(text) {
  if (!text) return false;
  return /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(text)
    || /\b(předsed|místopředsed|správc|veden|výbor)\b/i.test(text);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    const body = await req.json();
    const message = body?.message;

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
          temperature: 0.2,
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
    let answer = cleanAnswer(extractLatestAssistantText(messages));

    // ✅ SOFT FALLBACK
    if (!answer || !hasFactualContent(answer)) {
      answer = "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}