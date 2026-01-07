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
        body: JSON.stringify({ error: "Chybí dotaz" })
      };
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: message,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [process.env.VECTOR_STORE_ID]
        }
      ]
    });

    const outputText =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "";

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer: outputText,
        raw: response
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message
      })
    };
  }
}
