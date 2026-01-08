import OpenAI from "openai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handler(request, context) {
  try {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Use POST" }, 405);
    }

    const { query } = await request.json().catch(() => ({}));
    if (!query || typeof query !== "string") {
      return json({ ok: false, error: "Missing 'query' (string) in JSON body." }, 400);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return json({ ok: false, error: "Missing OPENAI_API_KEY env var." }, 500);
    if (!assistantId) return json({ ok: false, error: "Missing ASSISTANT_ID env var." }, 500);

    const client = new OpenAI({ apiKey });

    // 1) Create thread
    const thread = await client.beta.threads.create();

    // 2) Add user message
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: query,
    });

    // 3) Run assistant
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // 4) Poll run status
    let status = run.status;
    let lastError = null;

    for (let i = 0; i < 60; i++) { // ~60 * 500ms = 30s max
      const r = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = r.status;
      lastError = r.last_error ?? null;

      if (status === "completed") break;
      if (status === "failed" || status === "cancelled" || status === "expired") break;

      await sleep(500);
    }

    if (status !== "completed") {
      return json(
        {
          ok: false,
          error: "Assistant run did not complete.",
          status,
          last_error: lastError,
        },
        502
      );
    }

    // 5) Read last assistant message
    const msgs = await client.beta.threads.messages.list(thread.id, { limit: 20 });
    const assistantMsg = msgs.data.find((m) => m.role === "assistant");

    const text =
      assistantMsg?.content
        ?.map((c) => (c.type === "text" ? c.text.value : ""))
        .join("\n")
        .trim() || "";

    return json({ ok: true, answer: text });
  } catch (err) {
    // Vždy vrať validní JSON
    return json(
      {
        ok: false,
        error: "Unhandled error in function.",
        details: err?.message ?? String(err),
      },
      500
    );
  }
}
