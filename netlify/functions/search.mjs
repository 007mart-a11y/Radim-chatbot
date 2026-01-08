import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const body = await req.json();

    if (!body.message || !body.message.trim()) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing message" }),
        { status: 400 }
      );
    }

    const message = body.message.trim();
    const assistantId = process.env.ASSISTANT_ID;

    if (!assistantId) {
      throw new Error("ASSISTANT_ID missing in env vars");
    }

    // vytvoření threadu
    const thread = await client.beta.threads.create();

    // zpráva uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // run asistenta
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // čekání na dokončení
    let status = run.status;
    let finalRun = run;

    while (status !== "completed" && status !== "failed") {
      await new Promise((r) => setTimeout(r, 500));
      finalRun = await client.beta.threads.runs.retrieve(
        thread.id,
        run.id
      );
      status = finalRun.status;
    }

    if (status === "failed") {
      throw new Error("Run failed");
    }

    // odpověď asistenta
    const messages = await client.beta.threads.messages.list(thread.id);
    const answer =
      messages.data.find((m) => m.role === "assistant")?.content?.[0]?.text
        ?.value || "Bez odpovědi.";

    return new Response(
      JSON.stringify({ ok: true, answer }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
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
