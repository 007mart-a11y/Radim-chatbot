import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function handler(event) {
  try {
    const { question } = JSON.parse(event.body || "{}");

    if (!question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ answer: "Chybí dotaz." }),
      };
    }

    // 1️⃣ vytvoř thread
    const thread = await client.beta.threads.create();

    // 2️⃣ pošli dotaz uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: question,
    });

    // 3️⃣ spusť Assistanta (TEN S FILE SEARCH!)
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
    });

    // 4️⃣ čekej, než doběhne
    let status = run.status;
    let finalRun = run;

    while (status !== "completed") {
      await new Promise((r) => setTimeout(r, 1000));
      finalRun = await client.beta.threads.runs.retrieve(
        thread.id,
        run.id
      );
      status = finalRun.status;

      if (status === "failed") {
        throw new Error("Run failed");
      }
    }

    // 5️⃣ načti odpověď asistenta
    const messages = await client.beta.threads.messages.list(thread.id);
    const last = messages.data.find((m) => m.role === "assistant");

    const answer =
      last?.content?.[0]?.text?.value ||
      "Asistent nenašel odpověď ve znalostní bázi.";

    return {
      statusCode: 200,
      body: JSON.stringify({ answer }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        answer: "Interní chyba serveru",
      }),
    };
  }
}
