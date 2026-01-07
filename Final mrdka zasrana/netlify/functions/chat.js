import fs from "fs";
import path from "path";

/* =========================
   Pomocné funkce
========================= */

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreChunk(query, text) {
  const q = normalizeText(query);
  const t = normalizeText(text);
  if (!q || !t) return 0;

  const words = q.split(" ").filter(w => w.length >= 3);
  let score = 0;
  for (const w of words) {
    if (t.includes(w)) score++;
  }
  return score;
}

function loadKB() {
  const kbPath = path.join(process.cwd(), "kb", "kb.json");
  const raw = fs.readFileSync(kbPath, "utf8");
  return JSON.parse(raw);
}

function findRelevantChunks(kb, query, limit = 6) {
  const chunks = Array.isArray(kb?.chunks) ? kb.chunks : [];
  return chunks
    .map(c => ({ ...c, _score: scoreChunk(query, c.text || "") }))
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

/* =========================
   Netlify Function
========================= */

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

    // ===== Načtení KB =====
    let kb;
    try {
      kb = loadKB();
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Knowledge base not available." })
      };
    }

    // ===== Relevantní obsah =====
    const hits = findRelevantChunks(kb, message, 6);

    const context = hits.length
      ? hits.map((h, i) =>
          `ZDROJ ${i + 1}:\n${h.text}\nODKAZ: ${h.url || "neuveden"}`
        ).join("\n\n---\n\n")
      : "Žádné relevantní informace nebyly nalezeny.";

    const sources = hits.length
      ? hits.map(h => `- ${h.url || h.source || "oficiální web obce"}`).join("\n")
      : "- oficiální web obce Radim";

    /* =========================
       SYSTEM PROMPT – KLÍČOVÁ ČÁST
    ========================= */

    const systemPrompt = `
Jsi oficiální virtuální asistent obce Radim (okres Jičín).

Pravidla odpovídání:
- Odpovídej česky, stručně, slušně a úředním stylem.
- Pokud máš informaci přesně a je součástí znalostního kontextu, odpověz konkrétně.
- Pokud si informací nejsi jistý nebo není výslovně uvedena v datech, neodhaduj.
- V takovém případě vždy vysvětli, kde občan informaci najde, a pošli přímý odkaz.
- Pokud se uživatel ptá „kde najdu…“, „odkaz“, „link“, vždy odpověz odkazem.
- U územního plánu, programu rozvoje a oficiálních dokumentů vždy nabídni přímý odkaz na stránku nebo PDF, pokud je k dispozici.
- Nevymýšlej si konkrétní termíny, vyhlášky ani částky.
- Na konec odpovědi vždy přidej sekci „Zdroje:“.
`;

    const userPrompt = `
DOTAZ OBČANA:
${message}

ZNALOSTNÍ KONTEXT (výňatky z oficiálních zdrojů):
${context}
`;

    // ===== OpenAI =====
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
        temperature: 0.1
      })
    });

    const data = await r.json();
    let reply = data?.choices?.[0]?.message?.content || "Omlouvám se, odpověď se nepodařilo získat.";

    // pojistka na zdroje
    if (!reply.toLowerCase().includes("zdroje")) {
      reply += `\n\nZdroje:\n${sources}`;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Interní chyba serveru." })
    };
  }
}
