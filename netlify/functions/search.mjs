export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "Method not allowed" }),
        { status: 405 }
      );
    }

    const body = await req.json();

    if (!body.message) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing message" }),
        { status: 400 }
      );
    }

    const response = await fetch("https://api.openai.com/v1/threads/runs", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id: process.env.ASSISTANT_ID,
        thread: {
          messages: [
            {
              role: "user",
              content: body.message
            }
          ]
        }
      })
    });

    const data = await response.json();

    return new Response(
      JSON.stringify({ ok: true, data }),
      { status: 200 }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server error",
        details: err.message
      }),
      { status: 500 }
    );
  }
}
