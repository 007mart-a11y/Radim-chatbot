import fs from "fs";
import path from "path";

export async function handler(event) {
  try {
    const { message } = JSON.parse(event.body || "{}");

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Chybí zpráva uživatele." })
      };
    }

    // ===============================
    // NAČTENÍ KNOWLEDGE BASE
    // ===============================
    let kbText = "";
    try {
      const kbPath = path.join(process.cwd(), "kb", "kb.json");
      const raw = fs.readFileSync(kbPath, "utf8");
      const kb = JSON.parse(raw);

      if (kb.chunks && Array.isArray(kb.chunks)) {
        kbText = kb.chunks
          .slice(0, 15)
          .map(c => `• ${c.text}`)
          .join("\n");
      }
    } catch (e) {
      console.warn("KB se nepodařilo načíst:", e.message);
    }

    // ===============================
    // PROMPT PRO CHATBOTA
    // ===============================
    const systemPrompt = `
Jsi oficiální virtuální asistent obce Radim u Jičína.

Odpovídej:
- česky
- věcně, slušně a srozumitelně
- pouze na základě dostupných informací
- pokud si nejsi jistý, řekni to a doporuč kontaktovat obecní úřad

INFORMACE Z WEBU A DOKUMENTŮ OBCE:
${kbText}
`;

    // ===============================
    // VOLÁNÍ OPENAI
    // ===============================
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.2
      })
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: data.choices?.[0]?.message?.content || "Omlouvám se, odpověď se nepodařilo získat."
      })
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Interní chyba serveru." })
    };
  }
}
