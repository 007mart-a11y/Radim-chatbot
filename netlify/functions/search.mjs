import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "Method not allowed" }),
        { status: 405 }
      );
    }

    const body = await req.json();

    if (!body.message || typeof body.message !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing message" }),
        { status: 400 }
      );
    }

    const thread = await client.beta.threads.create();

    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: body.message,
    });

    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // čekání na dokončení
    let status;
    do {
      await new Promise((r) => setTimeout(r, 800));
      const check = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = check.status;
    } while (status === "queued" || status === "in_progress");

    if (status !== "completed") {
      return new Response(
        JSON.stringify({ ok: false, error: "Run failed", status }),
        { status: 500 }
      );
    }

    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data.find((m) => m.role === "assistant");

    return new Response(
      JSON.stringify({
        ok: true,
        answer: answer?.content?.[0]?.text?.value || "Bez odpovědi",
      }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server error",
        details: err.message,
      }),
      { status: 500 }
    );
  }
}
