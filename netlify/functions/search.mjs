import OpenAI from "openai";

export const handler = async (event) => {
  try {
    const { message } = JSON.parse(event.body || "{}");

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "Missing message" }),
      };
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const assistantId = process.env.ASSISTANT_ID;

    if (!assistantId) {
      throw new Error("ASSISTANT_ID is not set");
    }

    // 1️⃣ vytvoříme thread
    const thread = await client.beta.threads.create();

    // 2️⃣ pošleme zprávu
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // 3️⃣ spustíme run
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // 4️⃣ počkáme na dokončení
    let status = run.status;

    while (status !== "completed" && status !== "failed") {
      await new Promise((r) => setTimeout(r, 500));
      const updatedRun = await client.beta.threads.runs.retrieve(
        thread.id,
        run.id
      );
      status = updatedRun.status;
    }

    if (status === "failed") {
      throw new Error("Run failed");
    }

    // 5️⃣ přečteme odpověď
    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data.find(
      (m) => m.role === "assistant"
    )?.content[0]?.text?.value;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        answer: answer || "Bez odpovědi",
      }),
    };
  } catch (err) {
    console.error("SEARCH ERROR:", err);

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err.message,
      }),
    };
  }
};
