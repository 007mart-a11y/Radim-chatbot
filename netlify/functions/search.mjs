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

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
  }

  return json ?? {};
}

/* ===============================
   Extractors
================================ */

function extractLatestAssistantText(messagesJson) {
  const data = messagesJson?.data || [];
  const assistantMsgs = data.filter((m) => m.role === "assistant");

  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return assistantMsgs[0].content
    .map((c) => (c.type === "text" ? c.text.value : ""))
    .join("\n\n")
    .trim();
}

function cleanAnswer(text) {
  if (!text) return "";

  let t = text;

  // odstranit file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // ořez interpunkce za URL
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/* ===============================
   Thread helpers
================================ */

async function ensureThreadId(incoming, apiKey) {
  if (incoming?.startsWith("thread_")) {
    try {
      await api(`/threads/${incoming}`, {}, apiKey);
      return incoming;
    } catch {}
  }

  const created = await api("/threads", { method: "POST" }, apiKey);
  return created.id;
}

async function addUserMessage(threadId, message, apiKey) {
  await api(
    `/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: message }),
    },
    apiKey
  );
}

/* ===============================
   Run instructions
================================ */

function buildRunInstructions() {
  const today = new Date().toLocaleDateString("cs-CZ");

  return `
Jsi oficiální asistent obce Radim.
Dnes je ${today}.

Pracuješ výhradně s dokumenty:
- 00_PEOPLE_obec_radim.txt
- 99_FULL_obec_radim.txt

PRAVIDLA:
- Dotazy na osoby, funkce, vedení, starostu/starostku: vždy nejprve PEOPLE.
- Pokud osoba nebo funkce není v PEOPLE ani ve FULL, řekni to otevřeně.
- Nevymýšlej jména, funkce, částky ani odkazy.
- Pokud je k dispozici přesný odkaz ve zdrojích, uveď ho.
- Pokud není, použij navigaci (Sekce → Podsekce → Název).
- Odpovídej lidsky, věcně, stručně, jako pracovník úřadu.
- Když si nejsi jistý, vysvětli to a nabídni další krok.

Styl odpovědi:
1–3 věty odpověď
Kontakt: (pokud existuje)
Odkaz nebo Cesta: (pokud existuje)
Krátká nabídka pomoci.
`;
}

/* ===============================
   Handler
================================ */

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

    if (!apiKey || !assistantId) {
      return jsonResponse(500, { ok: false, error: "Missing env vars" });
    }

    const body = await req.json();
    const message = body?.message;

    if (!message) {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    // reset
    if (message.trim().toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    const threadId = await ensureThreadId(body.thread_id, apiKey);

    await addUserMessage(threadId, message, apiKey);

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

    const started = Date.now();
    while (Date.now() - started < 45000) {
      await sleep(600);
      const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
      if (check.status === "completed") break;
    }

    const messages = await api(`/threads/${threadId}/messages?limit=20`, {}, apiKey);
    let answer = cleanAnswer(extractLatestAssistantText(messages));

    if (!answer) answer = REQUIRED_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: String(err),
    });
  }
}