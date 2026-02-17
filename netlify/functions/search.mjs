// netlify/functions/search.mjs
// Jednoduchá stabilní verze
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC = "Radim";
const FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function oaiFetch(path, body, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new Error(json?.error?.message || text);
  }

  return json;
}

function extractChunks(data) {
  if (!Array.isArray(data?.data)) return [];

  return data.data
    .map(item => {
      const text = (item?.content || [])
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n")
        .trim();

      return {
        score: item.score || 0,
        text,
        filename: item.filename || ""
      };
    })
    .filter(x => x.text.length > 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25); // vezmeme 25 nejlepších
}

function buildContext(chunks) {
  let ctx = `OFICIÁLNÍ PODKLADY OBCE ${OBEC}\n\n`;

  chunks.forEach((c, i) => {
    ctx += `--- ZDROJ ${i + 1}: ${c.filename}\n`;
    ctx += c.text.slice(0, 4000); // omezíme délku chunku
    ctx += "\n\n";
  });

  return ctx;
}

function extractLinks(text) {
  const re = /(https?:\/\/[^\s<>()"]+)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) {
    out.add(m[0]);
  }
  return Array.from(out);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey || !vectorStoreId) {
      return jsonResponse(500, { ok: false, error: "Missing env vars" });
    }

    const body = await req.json();
    const message = body?.message?.trim();

    if (!message) {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const debug = message.startsWith("#debug");
    const cleanMessage = message.replace(/^#debug\s*/i, "");

    // 🔎 1️⃣ VECTOR SEARCH
    const search = await oaiFetch(
      `/vector_stores/${vectorStoreId}/search`,
      {
        query: cleanMessage,
        max_num_results: 50,   // ✅ API LIMIT
        rewrite_query: true
      },
      apiKey
    );

    const chunks = extractChunks(search);

    if (!chunks.length) {
      return jsonResponse(200, {
        ok: true,
        answer: FALLBACK,
        thread_id: null,
        links: []
      });
    }

    const context = buildContext(chunks);

    // 🤖 2️⃣ MODEL
    const response = await oaiFetch(
      `/responses`,
      {
        model: "gpt-4.1-mini",
        temperature: 0.1,
        input: [
          {
            role: "system",
            content:
              `Jsi AI asistent obce ${OBEC}. ` +
              `Odpovídej pouze podle poskytnutého kontextu. ` +
              `Nevymýšlej. Pokud údaj není uveden, napiš přesně: "${FALLBACK}". ` +
              `Pokud je v kontextu částka nebo konkrétní údaj, uveď ho přesně.`
          },
          {
            role: "user",
            content: context + "\n\nDOTAZ:\n" + cleanMessage
          }
        ]
      },
      apiKey
    );

    const answer =
      response?.output_text ||
      (response?.output?.[0]?.content?.[0]?.text) ||
      FALLBACK;

    const links = [
      ...extractLinks(answer),
      ...chunks.flatMap(c => extractLinks(c.text))
    ].slice(0, 10);

    return jsonResponse(200, {
      ok: true,
      answer: answer.trim(),
      thread_id: null,
      links,
      debug: debug ? { chunks } : undefined
    });

  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}