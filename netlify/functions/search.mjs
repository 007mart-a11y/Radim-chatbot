// netlify/functions/search.mjs
// SIMPLE STABLE VERSION
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

const HARD_FALLBACK =
  "Tato informace není v dostupných podkladech obce Radim uvedena.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function oaiFetch(path, { method = "GET", body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...OPENAI_BETA_HEADER,
      "Content-Type": "application/json",
    },
    body,
  });

  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(json?.error?.message || text || "OpenAI error");
  }

  return json;
}

function flattenChunks(data) {
  const items = Array.isArray(data?.data) ? data.data : [];

  return items
    .map((it) => {
      const filename =
        it?.filename || it?.file?.filename || it?.file?.name || "soubor";

      const text = (it?.content || [])
        .map((c) => (c?.type === "text" ? c?.text : ""))
        .join("\n")
        .trim();

      return { filename, score: it?.score || 0, text };
    })
    .filter((x) => x.text && x.text.length > 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function buildContext(chunks) {
  let ctx = "OFICIÁLNÍ PODKLADY OBCE RADIM:\n\n";

  chunks.forEach((c, i) => {
    ctx += `--- ZDROJ ${i + 1}: ${c.filename}\n`;
    ctx += c.text.slice(0, 6000);
    ctx += "\n\n";
  });

  return ctx;
}

function extractAnswer(resp) {
  const out = [];

  if (typeof resp?.output_text === "string") {
    out.push(resp.output_text);
  }

  const output = Array.isArray(resp?.output) ? resp.output : [];

  for (const item of output) {
    if (item?.type === "message") {
      for (const c of item.content || []) {
        if (c?.type === "output_text" && c?.text) {
          out.push(c.text);
        }
      }
    }
  }

  return out.join("\n").trim();
}

export default async function handler(req) {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST")
      return jsonResponse(405, { ok: false });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey || !vectorStoreId)
      return jsonResponse(500, { ok: false, error: "Missing ENV" });

    const body = await req.json();
    const message = body?.message?.trim();

    if (!message)
      return jsonResponse(400, { ok: false, error: "Missing message" });

    // 1️⃣ Vector search
    const search = await oaiFetch(
      `/vector_stores/${vectorStoreId}/search`,
      {
        method: "POST",
        body: JSON.stringify({
          query: message,
          max_num_results: 40,
          rewrite_query: true,
        }),
      },
      apiKey
    );

    const chunks = flattenChunks(search);

    if (!chunks.length) {
      return jsonResponse(200, {
        ok: true,
        answer: HARD_FALLBACK,
        thread_id: `thread_${Date.now()}`,
      });
    }

    const context = buildContext(chunks);

    // 2️⃣ Model answer
    const response = await oaiFetch(
      `/responses`,
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0,
          input: [
            {
              role: "system",
              content:
                "Odpovídej pouze podle poskytnutého kontextu. Nevymýšlej informace. Pokud údaj není v kontextu, vrať přesně: " +
                HARD_FALLBACK,
            },
            {
              role: "user",
              content:
                context +
                "\n\nDOTAZ:\n" +
                message +
                "\n\nOdpověz stručně a uveď odkaz pokud existuje.",
            },
          ],
        }),
      },
      apiKey
    );

    const answer = extractAnswer(response) || HARD_FALLBACK;

    return jsonResponse(200, {
      ok: true,
      answer,
      thread_id: `thread_${Date.now()}`,
    });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: err.message,
    });
  }
}