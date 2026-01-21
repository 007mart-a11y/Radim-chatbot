// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID
// Request JSON: { message: string, thread_id?: string, debug?: boolean }
// Response JSON: { ok: true, answer: string, thread_id: string, raw_answer?: string } | { ok:false, error, details? }

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
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function getCzechTodayString() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    weekday: "long",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  return fmt.format(now);
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

function extractAssistantText(messagesListJson) {
  const data = messagesListJson?.data || [];
  const assistantMsg = data.find((m) => m.role === "assistant");
  if (!assistantMsg?.content?.length) return "Bez odpovědi";

  const parts = assistantMsg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.length ? parts.join("\n\n") : "Bez odpovědi";
}

// Čištění: citace z file_search + markdown bold, ale NESAHAJ na časy
function sanitizeAnswer(text) {
  let t = String(text || "");

  // OpenAI citace: 
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  // i bez †
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*】/g, "");
  // hranaté/kulaté varianty
  t = t.replace(/\[\s*\d+\s*:\s*\d+\s*(?:†[^\]]*)?\]/g, "");
  t = t.replace(/\(\s*\d+\s*:\s*\d+\s*(?:†[^)]*)?\)/g, "");

  // pryč zbytky "†source"
  t = t.replace(/†\s*source/gi, "");

  // pryč markdown bold **něco**
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");

  // uhladit whitespace
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.trim();

  // oprava URL: odstraní trailing interpunkci za URL
  t = t.replace(/(https?:\/\/[^\s<>"']+?)([)\],.;:!?]+)(?=\s|$)/g, "$1");

  return t;
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

    const debug = !!body?.debug;

    // ✅ RUN instructions (jako Chomutice), ale pro RADIM + jasná priorita CORE
    const todayStr = getCzechTodayString();

    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague).\n` +
      `Když uživatel použije "dnes/zítra/včera/příští týden", vykládej to vůči tomuto datu.\n\n` +
      `Jsi oficiální asistent obce Radim.\n` +
      `PRIORITA ZDROJŮ: 1) 00_CORE (vždy rozhoduje) 2) LIVE 3) STATICKÁ/ARCHIV.\n` +
      `Když je dotaz na kontakty/úřední hodiny/vedení obce, vždy použij údaje z 00_CORE.\n` +
      `U úředních hodin odpověz přímo a konkrétně.\n\n` +
      `DŮLEŽITÉ (RADIM, z CORE): Úřední hodiny jsou pouze ve středu 16:00–19:00.\n` +
      `Nezmiňuj technické detaily (AI, crawling, scraping). Odpovídej věcně česky.\n` +
      `Odkazy piš bez tečky na konci URL.`;

    // Thread
    let threadId = body?.thread_id;
    if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // 1) User message
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: message }),
      },
      apiKey
    );

    // 2) Run + instructions
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistant_id: assistantId, instructions: runInstructions }),
      },
      apiKey
    );

    // 3) Poll
    const started = Date.now();
    const timeoutMs = 25_000;

    while (true) {
      if (Date.now() - started > timeoutMs) {
        return jsonResponse(504, { ok: false, error: "Timeout waiting for response" });
      }

      await sleep(800);

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

    // 4) Read messages
    const messages = await api(`/threads/${threadId}/messages?limit=20`, {}, apiKey);
    const raw_answer = extractAssistantText(messages);
    const answer = sanitizeAnswer(raw_answer) || "Bez odpovědi";

    return jsonResponse(200, debug ? { ok: true, answer, raw_answer, thread_id: threadId } : { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}