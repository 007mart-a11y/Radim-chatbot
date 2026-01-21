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
  } catch {
    // ignore
  }

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

/**
 * Čistič výstupu asistenta:
 * - odstraní FileSearch citace: 
 * - odstraní tokeny [6:0], (6:0) apod.
 * - odstraní markdown hvězdičky (hlavně **tučně**)
 * - opraví URL s rozbitou interpunkcí na konci
 * - uhladí whitespace
 */
function cleanAssistantText(input) {
  if (!input) return "";
  let t = String(input);

  // 1) Citace z File Search: 【 6:0 † ... 】
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*】/g, "");

  // 2) Tokeny v [] nebo ()
  t = t.replace(/\[\s*\d+\s*:\s*\d+\s*(?:†[^\]]*)?\]/g, "");
  t = t.replace(/\(\s*\d+\s*:\s*\d+\s*(?:†[^)]*)?\)/g, "");

  // 3) „†source“ apod.
  t = t.replace(/†\s*source/gi, "");
  t = t.replace(/\bsource:\s*\d+\s*:\s*\d+\b/gi, "");

  // 4) Markdown hvězdičky: **tučně** => tučně
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");
  // občas model dá *slovo* – odstraníme jen ty „obalovací“ hvězdičky
  t = t.replace(/(^|[\s(])\*(\S[^*]*\S)\*([\s).,!?]|$)/g, "$1$2$3");

  // 5) Oprava URL: odstraní trailing interpunkci za URL
  // např. https://.../).  -> https://.../
  t = t.replace(/(https?:\/\/[^\s<>"']+?)([)\],.;:!?]+)(?=\s|$)/g, "$1");

  // 6) Uhlazení whitespace
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.trim();

  return t;
}

export default async function handler(req) {
  // CORS preflight
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

    // ✅ Runtime datum (Europe/Prague) – do RUN instructions
    const todayStr = getCzechTodayString();

    // Důležité: NEBUĎ přehnaně přísný – ale jasně řekni PRIORITU CORE.
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague).\n` +
      `Při výrazech jako "dnes", "zítra", "včera", "příští víkend", "tento týden" ` +
      `vždy vykládej časové odkazy vzhledem k tomuto datu.\n\n` +
      `Používej znalostní bázi (File Search).\n` +
      `PRIORITA ZDROJŮ: pokud existuje soubor 00_CORE_* (CORE), má přednost při rozporu.\n` +
      `Jinak aktivně hledej i v ostatních souborech (STATIC/LIVE/PDF) a odpověz podle nich.\n` +
      `Neuváděj citace ani značky typu 【…】 nebo 6:0. Odpovídej lidsky a stručně.`;

    // Thread: pokud přijde thread_id, pokračujeme; jinak založíme nový
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
        body: JSON.stringify({
          role: "user",
          content: message,
        }),
      },
      apiKey
    );

    // 2) Run + instructions
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: runInstructions,
        }),
      },
      apiKey
    );

    // 3) Poll run status
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
    let answer = extractAssistantText(messages);
    answer = cleanAssistantText(answer) || "Bez odpovědi.";

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}