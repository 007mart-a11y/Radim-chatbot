// netlify/functions/search.mjs
import fs from "node:fs";
import path from "node:path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": ALLOW_ORIGIN,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
  });
}

function readLocalFile(relPath) {
  try {
    const p = path.join(process.cwd(), relPath);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    return "";
  }
}

function extractPageBlock(fullText, url) {
  if (!fullText || !url) return null;
  const cleanUrl = url.replace(/\/$/, ""); 
  const lines = fullText.split('\n');
  let startIdx = -1;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("=== PAGE") && lines[i+1]?.includes(cleanUrl)) {
      startIdx = fullText.indexOf(lines[i]);
      break;
    }
  }

  if (startIdx === -1) return null;
  const next = fullText.indexOf("\n==============================\n=== PAGE", startIdx + 20);
  const end = next === -1 ? fullText.length : next;
  return fullText.slice(startIdx, end).trim();
}

function scoreBonusForQuery(chunkText, query) {
  const t = String(chunkText || "").toLowerCase();
  const q = String(query || "").toLowerCase();
  let bonus = 0;

  if (t.includes("2026")) bonus += 2.0;
  if (t.includes("2025")) bonus += 1.5;
  if (t.includes("2024")) bonus += 0.7;
  if (t.includes("pozbývá platnosti") || t.includes("zrušuje se")) bonus -= 1.0;

  return bonus;
}

async function vectorSearch(query, n = 15) {
  const r = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ query, max_num_results: Math.min(n, 50) }),
  });
  const res = await r.json();
  return Array.isArray(res?.data) ? res.data : [];
}

async function answerWithModel(userQuery, contextText) {
  const body = {
    model: "gpt-4o", 
    messages: [
      {
        role: "system",
        content: "Jsi AI asistent obce Radim. Odpovídej česky a věcně.\n" +
                 "PRAVIDLA:\n" +
                 "1) Používej POUZE dodaný KONTEXT. Pokud jsou tam různé roky, vyber NEJNOVĚJŠÍ.\n" +
                 "2) Ke každé informaci VŽDY doplň URL odkaz, který najdeš v kontextu u daného textu.\n" +
                 "3) Odkazy vypisuj ve formátu: (Zdroj: https://...).\n" +
                 "4) Pokud odpověď neznáš, napiš: „Tato informace není v dostupných podkladech obce Radim uvedena.“"
      },
      {
        role: "user",
        content: `KONTEXT (obsahuje texty a URL):\n${contextText}\n\nDOTAZ:\n${userQuery}`
      }
    ],
    temperature: 0.1,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json();
  return json.choices?.[0]?.message?.content || "";
}

// Funkce pro vytažení odkazů z textu odpovědi
function extractLinks(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const matches = text.match(urlRegex) || [];
  return [...new Set(matches)];
}

export default async (req) => {
  try {
    if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
    if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

    const body = await req.json().catch(() => ({}));
    const userQuery = String(body?.message || "").trim();
    if (!userQuery) return jsonResponse(200, { ok: true, answer: "" });

    const fullText = readLocalFile("knowledge/99_FULL_obec_radim.txt");
    const results = await vectorSearch(userQuery, 15);

    const ranked = results
      .map(r => ({ ...r, _score2: (r.score || 0) + scoreBonusForQuery(r.content?.[0]?.text, userQuery) }))
      .sort((a, b) => b._score2 - a._score2);

    const topSnippets = ranked.slice(0, 10);
    const pageBlocks = [];
    
    for (const sn of topSnippets) {
      const text = sn.content?.[0]?.text || "";
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        const block = extractPageBlock(fullText, urlMatch[0]);
        if (block) pageBlocks.push(block);
      }
    }

    // Kombinujeme bloky z FULL a snippety (aby fungovaly i PDF bez FULL záznamu)
    const finalContext = [
      ...new Set(pageBlocks.slice(0, 3)),
      ...topSnippets.map(s => `SOUBOR: ${s.filename}\nTEXT: ${s.content[0].text}`)
    ].join("\n\n---\n\n");

    const answer = await answerWithModel(userQuery, finalContext);
    const links = extractLinks(answer);

    return jsonResponse(200, { 
      ok: true, 
      answer, 
      links 
    });

  } catch (e) {
    return jsonResponse(500, { error: "Server error", details: e.message });
  }
};