// netlify/functions/chat.js
const fs = require("fs");
const path = require("path");

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreEntry(qNorm, entry) {
  const hay = " " + qNorm + " ";
  let score = 0;
  for (const kw of entry.keywords || []) {
    const k = " " + normalize(kw) + " ";
    if (k.trim().length < 2) continue;
    if (hay.includes(k)) score += 3;
  }
  // bonus za shodu v titulku
  const t = normalize(entry.title || "");
  if (t && qNorm && t.includes(qNorm)) score += 2;
  return score;
}

function isWhereQuestion(qNorm) {
  return (
    qNorm.includes("kde najdu") ||
    qNorm.includes("kde je") ||
    qNorm.includes("kde sehnat") ||
    qNorm.includes("kde") ||
    qNorm.includes("odkaz") ||
    qNorm.includes("link")
  );
}

function loadKB() {
  const kbPath = path.join(__dirname, "..", "..", "kb", "kb.json");
  const raw = fs.readFileSync(kbPath, "utf-8");
  return JSON.parse(raw);
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const question = (body.message || "").toString().trim();
    if (!question) return { statusCode: 200, headers, body: JSON.stringify({ reply: "Napište prosím dotaz." }) };

    const kb = loadKB();
    const qNorm = normalize(question);

    // 1) Nejprve zkusíme „Šéfbot light“: přesná odpověď nebo odkaz
    const entries = (kb.entries || []).slice();
    const scored = entries
      .map((e) => ({ e, score: scoreEntry(qNorm, e) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const top = scored.slice(0, 4).filter(x => x.score > 0);

    // vysoká jistota -> odpověz rovnou + odkaz
    if (best && best.score >= 3) {
      const reply =
        `${best.e.answer}\n` +
        `\n📎 Oficiální odkaz: ${best.e.url}`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    // dotaz „kde najdu…“ -> pošli nejlepší odkaz i při střední shodě
    if (isWhereQuestion(qNorm) && best && best.score >= 1) {
      const reply =
        `Najdete to tady:\n` +
        `📎 ${best.e.title}: ${best.e.url}`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    // 2) Fallback přes AI, ale jen s našimi podklady + přísná pravidla
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const fallback =
        (best && best.e && best.e.url)
          ? `Nevidím nastavený OPENAI_API_KEY. Zkuste prosím tento oficiální odkaz: ${best.e.url}`
          : `Nevidím nastavený OPENAI_API_KEY. Zkuste prosím web obce: ${kb.site}`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply: fallback }) };
    }

    const contextLines = top.length
      ? top.map(x => `- ${x.e.title}\n  Odpověď/poznámka: ${x.e.answer}\n  Odkaz: ${x.e.url}`).join("\n")
      : `- Oficiální web: ${kb.site}`;

    const system = `
Jsi „Virtuální asistent obce Radim“. Odpovídáš profesionálně, stručně a pouze z poskytnutých podkladů (CONTEXT).
Pravidla:
1) Pokud je odpověď v CONTEXTu, odpověz přesně.
2) Pokud si nejsi jistý / v CONTEXTu to není, nehádej: napiš, že to nemáš potvrzené, a pošli nejrelevantnější odkaz z CONTEXTu (nebo web obce).
3) Když se uživatel ptá „kde najdu…“, odpověz primárně odkazem.
4) Do odpovědi vždy přidej odkaz, pokud existuje relevantní stránka.
`.trim();

    const messages = [
      { role: "system", content: system },
      { role: "user", content: `CONTEXT:\n${contextLines}\n\nDOTAZ: ${question}` }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.2
      })
    });

    const data = await r.json();
    if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: data }) };

    const reply = data?.choices?.[0]?.message?.content || "Bez odpovědi.";
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e) }) };
  }
};
