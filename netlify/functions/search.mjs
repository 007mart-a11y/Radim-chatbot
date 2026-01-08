import OpenAI from "openai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!assistantId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing ASSISTANT_ID" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    if (!body.message || typeof body.message !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing message" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new OpenAI({ apiKey });

    const thread = await client.beta.threads.create();

    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: body.message,
    });

    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // čekání na dokončení + timeout
    const started = Date.now();
    const timeoutMs = 25_000;

    let status = "queued";
    while (true) {
      if (Date.now() - started > timeoutMs) {
        return new Response(JSON.stringify({ ok: false, error: "Timeout waiting for response" }), {
          status: 504,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await new Promise((r) => setTimeout(r, 800));
      const check = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = check.status;

      if (status === "queued" || status === "in_progress") continue;

      // kdyby assistant chtěl tool-call mimo File Search, radši to vrať jako řízenou chybu
      if (status === "requires_action") {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Run requires action (tool call not handled in function).",
            status,
          }),
          { status: 501, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      break;
    }

    if (status !== "completed") {
      return new Response(JSON.stringify({ ok: false, error: "Run failed", status }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messages = await client.beta.threads.messages.list(thread.id, { limit: 20 });

    // vezmi nejnovější assistant zprávu
    const assistantMsg = messages.data.find((m) => m.role === "assistant");

    // robustní čtení textu (někdy je víc částí)
    let answerText = "Bez odpovědi";
    if (assistantMsg?.content?.length) {
      const parts = assistantMsg.content
        .map((c) => (c?.type === "text" ? c.text?.value : ""))
        .filter(Boolean);
      if (parts.length) answerText = parts.join("\n\n");
    }

    return new Response(JSON.stringify({ ok: true, answer: answerText }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server error",
        details: err?.message || String(err),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
