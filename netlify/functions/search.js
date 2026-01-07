import OpenAI from "openai";

export default async (request, context) => {
  try {
    const url = new URL(request.url);
    let q = url.searchParams.get("q");

    // podporujeme i POST { "q": "..." }
    if (!q && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      q = body?.q;
    }

    if (!q) {
      return new Response(JSON.stringify({ error: "Missing query ?q=" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `Odpověz jako Asistent obce Radim na dotaz: ${q}`,
    });

    return new Response(JSON.stringify({ answer: resp.output_text || "" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err?.message || "Server error" }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    );
  }
};
