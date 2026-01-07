import OpenAI from "openai";

export default async (req, context) => {
  try {
    const query =
      req.queryStringParameters?.q ||
      JSON.parse(req.body || "{}")?.q;

    if (!query) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing query" }),
      };
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `Odpověz jako Asistent obce Radim na dotaz: ${query}`,
    });

    const text =
      response.output_text ||
      "Omlouvám se, odpověď se nepodařilo získat.";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        answer: text,
      }),
    };
  } catch (err) {
    console.error("FUNCTION ERROR:", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: err.message || "Unknown server error",
      }),
    };
  }
};
