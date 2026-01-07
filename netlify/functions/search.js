import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handler(event) {
  try {
    const { message } = JSON.parse(event.body || "{}");

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ answer: "Chybí dotaz." })
      };
    }

    // 1️⃣ vytvoření threadu
    const thread = await client.beta.threads.create();

    // 2️⃣ přidání zprávy uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

    // 3️⃣ spuštění asistenta (TEN S KNOWLEDGE BASE)
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID
    });

    // 4️⃣ čekání na dokončení
    let status = run.status;
    let finalRun = run;

    while (status !== "completed") {
      await new Promise(r => setTimeout(r, 800));
      finalRun = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = finalRun.status;

      if (status === "failed") {
        throw new Error("Run failed");
      }
    }

    // 5️⃣ načtení odpovědi
    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data[0].content[0].text.value;

    return {
      statusCode: 200,
      body: JSON.stringify({ answer })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        answer: "Interní chyba serveru",
        error: err.message
      })
    };
  }
}
