// netlify/functions/chat.js
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST" }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };
    }

    const SYSTEM_PROMPT = `
Jsi oficiální virtuální asistent obce Radim (okres Jičín).
Odpovídáš česky, slušně, věcně a přehledně.

ZÁKLADNÍ INFORMACE:
- Obec: Radim (okres Jičín)
- Starostka: Zdeňka Stříbrná
- Pomáháš s informacemi o úřadu, úředních hodinách, kontaktech,
  obecních akcích, hlášeních, historii obce a orientaci na webu obce.

PRAVIDLA:
- Když si nejsi jistý/á, řekni to a doporuč ověřit na webu obce nebo na OÚ.
- Nevymýšlej si konkrétní data, vyhlášky ani termíny.
- Odpovídej stručně, ideálně v bodech.
`;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({ error: data }) };
    }

    const reply = data?.choices?.[0]?.message?.content || "Bez odpovědi.";
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e) }) };
  }
};