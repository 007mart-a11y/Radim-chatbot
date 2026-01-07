import fs from "fs";
import path from "path";

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // pryč diakritika
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreChunk(query, chunkText) {
  const q = normalizeText(query);
  const t = normalizeText(chunkText);
  if (!q || !t) return 0;

  const words = q.split(" ").filter(w => w.length >= 3);
  if (!words.length) return 0;

  let score = 0;
  for (const w of words) {
    if (t.includes(w)) score += 1;
  }
  return score;
}

function loadKB() {
  const kbPath = path.join(process.cwd(), "kb", "kb.json");
  const raw = fs.readFileSync(kbPath, "utf8");
  return JSON.parse(raw);
}

function retrieveTopChunks(kb, query, topK = 6) {
  const chunks = Array.isArray(kb?.chunks) ? kb.chunks : [];
  const scored = chunks
    .map(c => ({
      ...c,
      _score: scoreChunk(query, c.text || "")
    }))
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);

  return scored;
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST" }) };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").trim();
    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };
    }

    // 1) Načti KB
    let kb;
    try {
      kb = loadKB();
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "KB not found or invalid. Expected kb/kb.json in site root.",
          details: String(e)
        })
      };
    }

    // 2) Najdi relevantní úryvky
    const hits = retrieveTopChunks(kb, message, 6);

    const context =
      hits.length
        ? hits
            .map(
              (h, i) =>
                `ZDROJ ${i + 1}: ${h.source || "Neznámý zdroj"}\nURL: ${h.url || "—"}\nTEXT:\n${h.text || ""}`
            )
            .join("\n\n---\n\n")
        : "NENALEZEN ŽÁDNÝ RELEVANTNÍ ZDROJ V DOSTUPNÝCH PODKLADECH.";

    const sourcesList =
      hits.length
        ? hits
            .map(h => `- ${h.source || "Zdroj"}${h.url ? `: ${h.url}` : ""}`)
            .join("\n")
        : "";

    const systemPrompt = `
Jsi oficiální virtuální asistent obce Radim (okres Jičín).

Pravidla:
- Odpovídej česky, slušně, věcně a stručně.
- Odpovídej POUZE na základě "Znalostního kontextu" níže.
- Pokud odpověď v kontextu není, napiš to narovinu a doporuč kontaktovat obecní úřad nebo dohledat na webu obce.
- Nevymýšlej si konkrétní termíny, vyhlášky ani čísla.
- Na konec vždy přidej sekci "Zdroje:".
`;

    const userPrompt = `DOTAZ OBČANA:\n${message}\n\nZNALOSTNÍ KONTEXT (výňatky z webu/PDF):\n${context}\n\nPoužité zdroje (pro sekci Zdroje):\n${sourcesList || "(žádné relevantní zdroje nenalezeny)"}`;

    // 3) Zavolej OpenAI
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({ error: data }) };
    }

    let reply = data?.choices?.[0]?.message?.content || "Omlouvám se, odpověď se nepodařilo získat.";

    // 4) Pojistka: když model zapomene zdroje, doplníme je
    if (!reply.toLowerCase().includes("zdroje:")) {
      reply += `\n\nZdroje:\n${sourcesList || "- (žádné relevantní zdroje nenalezeny)"}`;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e) }) };
  }
}
