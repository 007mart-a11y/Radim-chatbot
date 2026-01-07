import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Only POST allowed" }),
        { status: 405 }
      );
    }

    const { message } = await req.json();

    if (!message) {
      return new Response(
        JSON.stringify({ error: "No message provided" }),
        { status: 400 }
      );
    }

    // 1️⃣ vytvoření threadu
    const thread = await openai.beta.threads.create();

    // 2️⃣ přidání zprávy uživatele
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // 3️⃣ spuštění asistenta (TVŮJ ASSISTANT_ID)
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
    });

    // 4️⃣ čekání na dokončení
    let runStatus;
    do {
      await new Promise((r) => setTimeout(r, 500));
      runStatus = await openai.beta.threads.runs.retrieve(
        thread.id,
        run.id
      );
    } while (runStatus.status === "queued" || runStatus.status === "in_progress");

    if (runStatus.status !== "completed") {
      return new Response(
        JSON.stringify({ error: "Run failed", status: runStatus.status }),
        { status: 500 }
      );
    }

    // 5️⃣ NAČTENÍ ODPOVĚDI ASISTENTA (TO TADY CELÝ DEN CHYBĚLO)
    const messages = await openai.beta.threads.messages.list(thread.id);

    const assistantMessage = messages.data.find(
      (m) => m.role === "assistant"
    );

    const text =
      assistantMessage?.content?.[0]?.text?.value ||
      "Asistent nevrátil žádnou odpověď.";

    return new Response(
      JSON.stringify({ reply: text }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Internal error",
        details: err.message,
      }),
      { status: 500 }
    );
  }
};
