import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Use POST" }),
      { status: 405 }
    );
  }

  try {
    const { question } = JSON.parse(req.body);

    const thread = await client.beta.threads.create();

    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: question,
    });

    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // čekání na dokončení
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await client.beta.threads.runs.retrieve(thread.id, run.id);
    } while (status.status !== "completed");

    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data[0].content[0].text.value;

    return new Response(
      JSON.stringify({ answer }),
      { status: 200 }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
};
