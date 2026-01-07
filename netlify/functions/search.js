import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const question = body.question;

    if (!question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ answer: "Chybí dotaz." })
      };
    }

    // 1️⃣ vytvoř thread
    const thread = await client.beta.threads.create();

    // 2️⃣ přidej zprávu uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: question
    });

    // 3️⃣ spusť asistenta (TEN MÁ ZNALOSTNÍ BÁZI)
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID
    });

    // 4️⃣ počkej na dokončení
    let status;
    do {
      await new Promise(r => setTimeout(r, 500));
      const check = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = check.status;
    } while (status !== "completed");

    // 5️⃣ vezmi odpověď asistenta
    const messages = await client.beta.threads.messages.list(thread.id);
    const last = messages.data[0].content[0].text.value;

    return {
      statusCode: 200,
      body: JSON.stringify({ answer: last })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ answer: "Interní chyba serveru." })
    };
  }
}
