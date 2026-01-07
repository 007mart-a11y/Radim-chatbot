export default async (request) => {
  try {
    const { message } = await request.json();
    if (!message?.trim()) {
      return Response.json({ reply: "Napište prosím dotaz." }, { status: 200 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

    if (!apiKey) {
      return Response.json({ reply: "Chybí OPENAI_API_KEY v Netlify Environment variables." }, { status: 200 });
    }
    if (!vectorStoreId) {
      return Response.json({ reply: "Chybí OPENAI_VECTOR_STORE_ID v Netlify Environment variables." }, { status: 200 });
    }

    const system = `
Jsi virtuální asistent obce Radim u Jičína.
PRAVIDLA:
1) Odpovídej jen z informací nalezených pomocí file_search (znalostní báze obce Radim).
2) Když informaci nenajdeš nebo si nejsi jistý, NEHÁDEJ. Napiš, že to v podkladech nemáš, a pošli relevantní odkaz (nebo doporuč kontakt na úřad).
3) Když se uživatel ptá "kde najdu ...", primárně pošli odkaz.
4) Buď stručný, věcný, profesionální. Piš česky.
`.trim();

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: message }
        ],
        tools: [
          { type: "file_search", vector_store_ids: [vectorStoreId] }
        ],
        temperature: 0.2
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return Response.json({ reply: `Chyba OpenAI: ${JSON.stringify(data)}` }, { status: 200 });
    }

    const reply = data?.output_text || "Nemám odpověď.";
    return Response.json({ reply }, { status: 200 });

  } catch (e) {
    return Response.json({ reply: `Server error: ${String(e)}` }, { status: 200 });
  }
};
