import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Použij POST" }),
    };
  }

  try {
    const { message } = JSON.parse(event.body);

    // vytvoření threadu
    const thread = await client.beta.threads.create();

    // zpráva od uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // spuštění asistenta (!!! TADY SE POUŽÍVÁ ZNALOSTNÍ BÁZE !!!)
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
    });

    // čekání na dokončení
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await client.beta.threads.runs.retrieve(thread.id, run.id);
    } while (status.status !== "completed");

    // načtení odpovědi
    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data.find(m => m.role === "assistant");

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: answer.content[0].text.value,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Chyba serveru",
      }),
    };
  }
}
