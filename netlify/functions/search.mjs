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

// (volitelné) lokální fallback – kdybys chtěl do contextu natvrdo přidat CORE/PEOPLE z repa
function readLocalFile(relPath) {
  try {
    const p = path.join(process.cwd(), relPath);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function scoreBonusForQuery(snippetText, filename = "") {
  const t = String(snippetText || "").toLowerCase();
  const f = String(filename || "").toLowerCase();
  let bonus = 0;

  // roky – preferuj nejnovější
  if (t.includes("2026")) bonus += 2.0;
  if (t.includes("2025")) bonus += 1.5;
  if (t.includes("2024")) bonus += 0.7;
  if (t.includes("pozbývá platnosti") || t.includes("zrušuje se")) bonus -= 1.0;

  // preferuj CORE/PEOPLE v rankingu
  if (f.includes("00_core")) bonus += 2.0;
  if (f.includes("00_people")) bonus += 1.8;

  return bonus;
}

async function vectorSearch(query, n = 15) {
  const r = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ query, max_num_results: Math.min(n, 50) }),
    }
  );

  const res = await r.json().catch(() => ({}));
  return Array.isArray(res?.data) ? res.data : [];
}

// --- URL FIX LAYER ---------------------------------------------------------

function stripTrailingJunk(u) {
  return String(u)
    .trim()
    .replace(/[)\].,;:!?]+$/g, "")
    .replace(/[】》〉»]+$/g, "")
    .replace(/["'`]+$/g, "");
}

function safeDecodeOnce(u) {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function normalizeUrl(u) {
  if (!u) return "";
  let s = stripTrailingJunk(u);

  s = s.replace(/&amp;/g, "&");
  s = s.replace(/\\\//g, "/");
  s = s.replace(/\s+/g, "");

  for (let i = 0; i < 2; i++) {
    const dec = safeDecodeOnce(s);
    if (dec === s) break;
    s = dec;
  }

  s = s.replace(/%7c/g, "%7C");
  return s;
}

function urlVariants(u) {
  const s = normalizeUrl(u);
  if (!s) return [];

  const out = new Set();
  out.add(s);

  if (s.includes("://www.")) out.add(s.replace("://www.", "://"));
  else if (s.includes("://")) out.add(s.replace("://", "://www."));

  if (s.includes("%7C")) out.add(s.replace(/%7C/g, "|"));
  if (s.includes("|")) out.add(s.replace(/\|/g, "%7C"));

  out.add(stripTrailingJunk(s));
  return [...out];
}

async function fetchStatus(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; RadimBot/1.0)",
      },
    });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

async function validateAndFixUrl(u) {
  const variants = urlVariants(u);
  if (!variants.length) return "";

  const first = variants[0];
  const stFirst = await fetchStatus(first);
  if (stFirst && stFirst !== 404) return first;

  for (let i = 1; i < variants.length; i++) {
    const st = await fetchStatus(variants[i]);
    if (st && st !== 404) return variants[i];
  }

  return first;
}

function extractLinks(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const matches = String(text || "").match(urlRegex) || [];
  return [...new Set(matches.map(normalizeUrl))].filter(Boolean);
}

// --- MODEL ----------------------------------------------------------------

async function answerWithModel(userQuery, contextText) {
  const body = {
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "Jsi AI asistent obce Radim. Odpovídej česky a věcně.\n" +
          "PRAVIDLA:\n" +
          "1) Používej POUZE dodaný KONTEXT. Pokud jsou tam různé roky, vyber NEJNOVĚJŠÍ.\n" +
          "2) Ke každé odpovědi přidej minimálně jeden zdrojový odkaz, který je V KONTEXTU.\n" +
          "3) Odkaz vypiš ve formátu: (Zdroj: https://...)\n" +
          "4) Pokud odpověď neznáš, napiš přesně: „Tato informace není v dostupných podkladech obce Radim uvedena.“",
      },
      {
        role: "user",
        content: `KONTEXT (obsahuje texty a URL):\n${contextText}\n\nDOTAZ:\n${userQuery}`,
      },
    ],
    temperature: 0.1,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  return json.choices?.[0]?.message?.content || "";
}

// --- HANDLER --------------------------------------------------------------

export default async (req) => {
  try {
    if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
    if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

    const body = await req.json().catch(() => ({}));
    const userQuery = String(body?.message || "").trim();
    if (!userQuery) return jsonResponse(200, { ok: true, answer: "" });

    const results = await vectorSearch(userQuery, 18);

    const ranked = results
      .map((r) => {
        const snippetText = r.content?.[0]?.text || "";
        const filename = r.filename || "";
        return { ...r, _score2: (r.score || 0) + scoreBonusForQuery(snippetText, filename) };
      })
      .sort((a, b) => b._score2 - a._score2);

    const topSnippets = ranked.slice(0, 10);

    // Kontext = jen to, co přišlo z vector store (CORE/PEOPLE už tam jsou)
    let finalContext = topSnippets
      .map((s) => {
        const text = s.content?.[0]?.text || "";
        return `SOUBOR: ${s.filename || "(unknown)"}\nTEXT:\n${text}`;
      })
      .join("\n\n---\n\n");

    // (volitelné) přidat lokální CORE/PEOPLE natvrdo ještě před snippety
    // Pokud chceš 100% jistotu, odkomentuj:
    /*
    const core = readLocalFile("knowledge/00_CORE_obec_radim.txt");
    const people = readLocalFile("knowledge/people/00_PEOPLE_obec_radim.txt");
    finalContext =
      (core ? `SOUBOR: 00_CORE_obec_radim.txt\nTEXT:\n${core}\n\n---\n\n` : "") +
      (people ? `SOUBOR: 00_PEOPLE_obec_radim.txt\nTEXT:\n${people}\n\n---\n\n` : "") +
      finalContext;
    */

    let answer = await answerWithModel(userQuery, finalContext);

    // URL fix + 404 fix
    const rawLinks = extractLinks(answer);
    const fixedLinks = [];
    for (const l of rawLinks.slice(0, 6)) {
      fixedLinks.push(await validateAndFixUrl(l));
    }

    for (let i = 0; i < Math.min(rawLinks.length, fixedLinks.length); i++) {
      if (rawLinks[i] && fixedLinks[i] && rawLinks[i] !== fixedLinks[i]) {
        answer = answer.split(rawLinks[i]).join(fixedLinks[i]);
      }
    }

    return jsonResponse(200, {
      ok: true,
      answer,
      links: fixedLinks.filter(Boolean),
    });
  } catch (e) {
    return jsonResponse(500, { error: "Server error", details: e?.message || String(e) });
  }
};