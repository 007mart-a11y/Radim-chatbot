import OpenAI from "openai";

const json = (statusCode, bodyObj) =>
  new Response(JSON.stringify(bodyObj), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });

export default async (request) => {
  try {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "Use POST" });
    }

    const { message } = await request.json().catch(() => ({}));
    if (!message || typeof message !== "string") {
      return json(400, { ok: false, error: "Missing 'message' (string)" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID = process.env.ASSISTANT_ID;

    if (!OPENAI_API_KEY) return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!ASSISTANT_ID) return json(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) thread
    const thread = await client.beta.threads.create();

    // 2) message from user
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // 3) run assistant (File Search je nastavený u asistenta v OpenAI UI)
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID,
    });

    // 4) poll
    let status = run.status;
    let last;
    for (let i = 0; i < 60; i++) {
      last = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = last.status;
      if (status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(status)) {
        return json(500, { ok: false, error: `Run ${status}`, details: last });
      }
      await new Promise((r) => setTimeout(r, 700));
    }

    if (status !== "completed") {
      return json(504, { ok: false, error: "Timeout waiting for assistant" });
    }

    // 5) read last assistant message
    const msgs = await client.beta.threads.messages.list(thread.id, { limit: 20 });
    const assistantMsg = msgs.data.find((m) => m.role === "assistant");

    const text =
      assistantMsg?.content?.[0]?.type === "text"
        ? assistantMsg.content[0].text.value
        : "Tuto informaci nemám v dostupných podkladech.";

    return json(200, { ok: true, answer: text });
  } catch (e) {
    return json(500, {
      ok: false,
      error: e?.message || String(e),
    });
  }
};
