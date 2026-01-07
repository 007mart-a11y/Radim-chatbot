const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "Použij POST." }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const userMessage = body.message;

    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "Chybí dotaz (message)." }),
      };
    }

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Jsi oficiální asistent obce Radim. Odpovídej česky, věcně a stručně." },
        { role: "user", content: userMessage },
      ],
    });

    const text = r.output_text || "Omlouvám se, nenašel jsem odpověď.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "Interní chyba serveru.",
        error: err.message,
      }),
    };
  }
}
