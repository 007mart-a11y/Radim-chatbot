// netlify/functions/search.mjs
// Node 18+, ESM

import fs from "node:fs";
import path from "node:path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

// (volitelně) omez CORS na svůj web, jinak nech "*"
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
  const p = path.join(process.cwd(), relPath);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

/**
 * Najde celý "PAGE" blok v 99_FULL podle URL
 * FULL formát:
 * ==============================
 * === PAGE
 * URL: https://...
 * TITLE: ...
 * PUBLISHED: ...
 * DOWNLOADS:
 * ...
 * CONTENT:
 * ...
 */
function extractPageBlock(fullText, url) {
  if (!fullText || !url) return null;

  const marker = `=== PAGE\nURL: ${url}\n`;
  const start = fullText.indexOf(marker);
  if (start === -1) return null;

  const next = fullText.indexOf("\n==============================\n=== PAGE", start + 10);
  const end = next === -1 ? fullText.length : next;
  return fullText.slice(start, end).trim();
}

function extractPageUrlFromSnippet(snippet) {
  const s = String(snippet || "");

  // 1) preferuj "=== PAGE URL: ..."
  const m = s.match(/===\s*PAGE\s*URL:\s*(https?:\/\/[^\s]+)\s*/i);
  if (m?.[1]) return cleanupUrl(m[1]);

  // 2) jinak první URL v textu
  const u = s.match(/https?:\/\/[^\s]+/);
  if (u?.[0]) return cleanupUrl(u[0]);

  return null;
}

function cleanupUrl(u) {
  return String(u || "").replace(/[)\],.]+$/, "");
}

function isDebugMessage(message) {
  return String(message || "").trim().toLowerCase().startsWith("#debug");
}

function stripDebugPrefix(message) {
  return String(message || "").replace(/^#debug\s*/i, "").trim();
}

function normalizeWhitespace(t) {
  return String(t || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeSnippet(text, max = 900) {
  const t = normalizeWhitespace(text);
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function scoreBonusForQuery(chunkText, query) {
  // jednoduchá heuristika: bonus za shodu slov + bonus za "Čl. 4 / Sazba / poplatek / Kč / parcela / bioodpad"
  const t = String(chunkText || "").toLowerCase();
  const q = String(query || "").toLowerCase();

  let bonus = 0;

  const keywords = [
    "poplatek",
    "sazba",
    "kč",
    "čl.",
    "vyhláška",
    "účinnost",
    "parcela",
    "kn",
    "bioodpad",
    "skládka",
    "hřbit",
    "sběr",
    "svoz",
    "odpad",
  ];

  for (const k of keywords) {
    if (q.includes(k) && t.includes(k)) bonus += 0.03;
  }

  // bonus za novější roky, pokud jde o poplatky
  if (q.includes("poplatek") || q.includes("vyhláš")) {
    if (t.includes("2026")) bonus += 0.06;
    if (t.includes("2025")) bonus += 0.04;
    if (t.includes("2024")) bonus += 0.02;
  }

  return bonus;
}

async function oaiFetch(pathname, body) {
  const r = await fetch(`https://api.openai.com${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
      "openai-beta": "assistants=v2",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!r.ok) {
    const msg =
      (json && (json.error?.message || json.message)) ||
      `OpenAI error ${r.status}`;
    throw new Error(msg);
  }

  return json;
}

async function vectorSearch(query, maxNumResults = 12) {
  // IMPORTANT: OpenAI limit max_num_results <= 50
  const n = Math.max(1, Math.min(Number(maxNumResults) || 12, 50));

  const res = await oaiFetch(`/v1/vector_stores/${VECTOR_STORE_ID}/search`, {
    query,
    max_num_results: n,
  });

  // res.data[]: { file_id, filename, score, content:[{type:"text", text:"..."}] }
  return Array.isArray(res?.data) ? res.data : [];
}

function buildContextFromResults(results, userQuery, fullText) {
  // 1) seřaď s malým bonusem heuristiky
  const ranked = results
    .map((r) => {
      const chunkText = r?.content?.[0]?.text || "";
      const bonus = scoreBonusForQuery(chunkText, userQuery);
      return { ...r, _score2: (r?.score || 0) + bonus };
    })
    .sort((a, b) => (b._score2 || 0) - (a._score2 || 0));

  // 2) vyber krátké úryvky
  const topSnippets = ranked.slice(0, 10).map((r) => {
    const text = r?.content?.[0]?.text || "";
    return {
      filename: r?.filename || "",
      score: r?._score2 ?? r?.score ?? 0,
      text,
    };
  });

  // 3) pokud snippet ukazuje na PAGE URL, vytáhni celý PAGE blok (max 3)
  const pageBlocks = [];
  const pageLinks = [];
  for (const sn of topSnippets) {
    const url = extractPageUrlFromSnippet(sn.text);
    if (!url) continue;
    const block = extractPageBlock(fullText, url);
    if (block) {
      pageBlocks.push(block);
      pageLinks.push(url);
    }
  }

  // unikátní page blocks (podle URL řádku)
  const uniqBlocks = [];
  const seen = new Set();
  for (const b of pageBlocks) {
    const m = b.match(/^=== PAGE\nURL:\s*(https?:\/\/[^\s]+)\s*$/m);
    const key = m?.[1] || b.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqBlocks.push(b);
  }

  const pageContext = uniqBlocks.slice(0, 3).join("\n\n---\n\n");

  const snippetContext = topSnippets
    .slice(0, 8)
    .map((sn, i) => {
      return `[#${i + 1}] FILE: ${sn.filename}\nSCORE: ${sn.score.toFixed(
        3
      )}\nTEXT:\n${safeSnippet(sn.text, 1200)}`;
    })
    .join("\n\n---\n\n");

  return {
    pageContext: pageContext ? `DŮLEŽITÉ (celé stránky z webu obce):\n${pageContext}` : "",
    snippetContext: snippetContext ? `DALŠÍ NÁLEZY (úryvky):\n${snippetContext}` : "",
    pageLinks: Array.from(new Set(pageLinks)).slice(0, 10),
    usedSnippets: topSnippets,
  };
}

async function answerWithModel(userQuery, contextText) {
  // Použijeme Responses API (jednoduché). Když bys chtěl Assistants, dá se přepnout.
  const body = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Jsi AI asistent obce Radim. Odpovídej česky, stručně a věcně.\n" +
              "Pravidla:\n" +
              "1) Odpovídej VÝHRADNĚ z poskytnutého kontextu. Neimprovizuj.\n" +
              "2) Pokud jsou v kontextu různé verze vyhlášek/poplatků, preferuj nejnovější (novější rok, novější účinnost, novější vyvěšení).\n" +
              "3) Když odpověď v kontextu není, napiš přesně: „Tato informace není v dostupných podkladech obce Radim uvedena.“\n" +
              "4) Když odpověď je, uveď i relevantní odkaz (URL), ideálně na konkrétní stránku nebo stažení dokumentu.\n" +
              "5) Nezmiňuj interní technické věci (vector store, file_search, chunk apod.).\n",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `DOTAZ:\n${userQuery}\n\n` +
              `KONTEXT:\n${contextText}\n`,
          },
        ],
      },
    ],
    temperature: 0.2,
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg =
      (json && (json.error?.message || json.message)) ||
      `OpenAI error ${r.status}`;
    throw new Error(msg);
  }

  // responses output parsing
  const out = json?.output || [];
  let answer = "";
  for (const item of out) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && c?.text) answer += c.text;
    }
  }
  return normalizeWhitespace(answer);
}

function extractLinksFromText(t) {
  const s = String(t || "");
  const links = s.match(/https?:\/\/[^\s)]+/g) || [];
  return Array.from(new Set(links.map(cleanupUrl))).slice(0, 12);
}

export default async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return jsonResponse(200, { ok: true });
    }
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    if (!OPENAI_API_KEY) {
      return jsonResponse(500, {
        ok: false,
        error: "Missing OPENAI_API_KEY",
      });
    }
    if (!VECTOR_STORE_ID) {
      return jsonResponse(500, {
        ok: false,
        error: "Missing VECTOR_STORE_ID",
      });
    }

    const body = await req.json().catch(() => ({}));
    const rawMessage = body?.message ?? "";
    const debug = isDebugMessage(rawMessage);

    const userQuery = debug ? stripDebugPrefix(rawMessage) : String(rawMessage || "").trim();
    if (!userQuery) {
      return jsonResponse(200, { ok: true, answer: "", thread_id: null });
    }

    // načti FULL lokálně (pro page block extraction)
    // cesta odpovídá tvému repu: /knowledge/99_FULL_obec_radim.txt
    const fullText = readLocalFile("knowledge/99_FULL_obec_radim.txt");

    // 1) Vector search (top N)
    const results = await vectorSearch(userQuery, 14);

    // 2) postprocess + page-block extraction
    const ctx = buildContextFromResults(results, userQuery, fullText);

    const finalContext = [
      ctx.pageContext,
      ctx.snippetContext,
    ]
      .filter(Boolean)
      .join("\n\n====================\n\n");

    // 3) odpověď modelem
    const answer = await answerWithModel(userQuery, finalContext);

    // links: kombinace (a) linky z answer (b) pageLinks z FULL
    const links = Array.from(
      new Set([...(ctx.pageLinks || []), ...extractLinksFromText(answer)])
    ).slice(0, 12);

    // pokud je odpověď prázdná (někdy model vrátí nic), vrať "Bez odpovědi"
    const safeAnswer = answer || "Bez odpovědi";

    const payload = {
      ok: true,
      answer: safeAnswer,
      thread_id: null,
      links,
    };

    if (debug) {
      payload.debug = {
        top_files: results.slice(0, 10).map((r) => ({
          filename: r.filename,
          score: r.score,
        })),
        used_page_links: ctx.pageLinks,
        used_snippets: ctx.usedSnippets.slice(0, 6).map((s) => ({
          filename: s.filename,
          score: s.score,
          text: safeSnippet(s.text, 500),
        })),
        page_context_preview: safeSnippet(ctx.pageContext, 1200),
      };
    }

    return jsonResponse(200, payload);
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: String(e?.message || e),
    });
  }
};