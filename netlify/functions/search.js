import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async (req) => {
  try {
    const body = JSON.parse(req.body || "{}");
    const userMessage = body.message;

    if (!userMessage) {
      return new Response(
        JSON.stringify({ reply: "Chybí dotaz." }),
        { status: 400 }
      );
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "Jsi oficiální asistent obce Radim. Odpovídej stručně, věcně a česky."
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const text =
      response.output_text ||
      "Omlouvám se, nenašel jsem odpověď.";

    return new Response(
      JSON.stringify({ reply: text }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({
        reply: "Interní chyba serveru.",
        error: err.message
      }),
      { status: 500 }
    );
  }
};
