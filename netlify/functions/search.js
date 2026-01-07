import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handler(event) {
  try {
    const { message } = JSON.parse(event.body);

    // vytvoří thread
    const thread = await client.beta.threads.create();

    // pošle zprávu uživatele
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

    // spustí asistenta
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID
    });

    // čeká na dokončení
    let status;
    do {
      await new Promise(r => setTimeout(r, 500));
      status = await client.beta.threads.runs.retrieve(thread.id, run.id);
    } while (status.status !== "completed");

    // vezme odpověď
    const messages = await client.beta.threads.messages.list(thread.id);
    const reply = messages.data[0].content[0].text.value;

    return {
      statusCode: 200,
      body: JSON.stringify({ reply })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
