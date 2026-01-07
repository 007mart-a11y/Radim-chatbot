import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async (req) => {
  try {
    const { message } = JSON.parse(req.body);

    // 1️⃣ vytvoříme response přes Assistant + File Search
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: message,
      tools: [{ type: "file_search" }],
      metadata: {
        assistant_id: process.env.OPENAI_ASSISTANT_ID
      }
    });

    // 2️⃣ VYTÁHNEME TEXT SPRÁVNĚ
    let answer = "";

    for (const item of response.output) {
      if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "output_text") {
            answer += part.text;
          }
        }
      }
    }

    // 3️⃣ KDYŽ NIC NENAJDE → ŘEKNE NEVÍM
    if (!answer.trim()) {
      answer = "Tuto informaci nemám ve znalostní bázi obce Radim.";
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: answer })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Chyba serveru"
      })
    };
  }
};
