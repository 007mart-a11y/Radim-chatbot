import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        status: 405,
      });
    }

    const { message } = await req.json();
    if (!message) {
      return new Response(JSON.stringify({ error: "No message" }), {
        status: 400,
      });
    }

    // 1️⃣ Thread
    const thread = await openai.beta.threads.create();

    // 2️⃣ User message
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // 3️⃣ RUN – POVOLEN FILE SEARCH (TO JE TEN ROZDÍL)
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
      tools: [{ type: "file_search" }],
    });

    // 4️⃣ Wait
    let status;
    do {
      await new Promise((r) => setTimeout(r, 500));
      status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    } while (status.status === "queued" || status.status === "in_progress");

    if (status.status !== "completed") {
      return new Response(
        JSON.stringify({ error: "Run failed", status: status.status }),
        { status: 500 }
      );
    }

    // 5️⃣ Get assistant reply
    const messages = await openai.beta.threads.messages.list(thread.id);

    const assistantMsg = messages.data.find(
      (m) => m.role === "assistant"
    );

    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Asistent nevrátil žádnou odpověď.";

    return new Response(JSON.stringify({ reply }), { status: 200 });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
};
