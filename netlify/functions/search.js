import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");

    if (!body.question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ answer: "Chybí dotaz" })
      };
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: body.question
    });

    const answer =
      response.output_text ||
      "Nenalezena odpověď ve znalostní bázi.";

    return {
      statusCode: 200,
      body: JSON.stringify({ answer })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ answer: "Interní chyba serveru" })
    };
  }
}
