// netlify/functions/search.mjs (v4 STABLE)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function stripSeniors(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/^\/seniori\//, "/");
    return u.toString();
  } catch {
    return url;
  }
}

function extractLinks(text) {
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(text || ""))) {
    let u = m[0].replace(/[),.;]+$/g, "");
    u = stripSeniors(u);
    if (u.includes("obec-radim.cz")) out.add(u);
  }
  return Array.from(out);
}

async function oaiFetch(path, { method = "GET", body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2",
      "Content-Type": "application/json",
    },
    body,
  });

  const txt = await res.text();
  const json = txt ? JSON.parse(txt) : {};

  if (!res.ok) {
    throw new Error(json?.error?.message || txt);
  }

  return json;
}

async function vectorSearch(vectorStoreId, query, apiKey) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: 30,
        rewrite_query: true,
      }),
    },
    apiKey
  );
}

function flattenText(it) {
  return (it?.content || [])
    .map(c => c?.text || "")
    .join("\n")
    .trim();
}

function buildContext(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE RADIM:\n---\n`;

  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename}\n`;
    ctx += c.text.slice(0, 6000);
    ctx += `\n---\n`;
  });

  return ctx;
}

function systemPrompt() {
  return `
Jsi AI asistent obce Radim.

Odpovídej výhradně podle poskytnutého kontextu.
Nevymýšlej informace.
U částek a vyhlášek vždy uveď konkrétní čísla a odkaz pokud existuje.
Nikdy nepoužívej /seniori/ odkazy.
Pokud informace v kontextu není, napiš přesně:
"Tato informace není v dostupných podkladech obce Radim uvedena."
`;
}

function extractResponseText(resp) {
  if (resp?.output_text) return resp.output_text.trim();

  const parts = [];
  for (const item of resp?.output || []) {
    for (const c of item?.content || []) {
      if (c?.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    const body = await req.json();
    const message = body?.message?.trim();
    const previousResponseId = body?.response_id || null;
    const lastPdfUrl = body?.last_pdf_url || null;

    if (!message) return jsonResponse(400, { ok: false, error: "Missing message" });

    // 🔎 SEARCH
    const search = await vectorSearch(vectorStoreId, message, apiKey);

    const chunks = (search?.data || [])
      .map(it => ({
        filename: it.filename || "soubor",
        text: flattenText(it),
        score: it.score || 0
      }))
      .filter(c => c.text.length > 60)
      .sort((a,b) => b.score - a.score)
      .slice(0, 18);

    if (!chunks.length) {
      return jsonResponse(200, {
        ok: true,
        answer: HARD_FALLBACK,
      });
    }

    const context = buildContext(chunks);

    // 🤖 GENERATE
    const response = await oaiFetch(
      `/responses`,
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.15,
          previous_response_id: previousResponseId || undefined,
          input: [
            { role: "system", content: systemPrompt() },
            { role: "user", content: context + "\n\nDOTAZ:\n" + message }
          ],
        }),
      },
      apiKey
    );

    let answer = extractResponseText(response);
    if (!answer) answer = HARD_FALLBACK;

    answer = answer.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

    const links = Array.from(
      new Set([
        ...chunks.flatMap(c => extractLinks(c.text)),
        ...extractLinks(answer),
      ])
    ).slice(0, 12);

    return jsonResponse(200, {
      ok: true,
      answer,
      response_id: response.id,
      last_pdf_url: links.find(l => l.includes(".pdf")) || lastPdfUrl || null,
      links
    });

  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: err.message
    });
  }
}