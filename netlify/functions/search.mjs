// netlify/functions/search.mjs (v8 - simple + 2-pass retrieval for fees/PDF)
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
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isPdfish(q) {
  const t = normalizeCzech(q);
  return /(vyhlask|narizen|poplatek|odpad|psy|psu|sazba|splatnost|ucinnost|cl\.|clanek|odstavec|kc|kč|pdf)/i.test(
    t
  );
}

async function oaiFetch(path, options, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...OPENAI_BETA_HEADER,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const txt = await res.text();
  let json = {};
  try {
    json = JSON.parse(txt);
  } catch {}

  if (!res.ok) throw new Error(json?.error?.message || txt);
  return json;
}

function flattenChunk(it) {
  const arr = Array.isArray(it?.content) ? it.content : [];
  return arr
    .map((c) => c?.text || c?.text?.value || "")
    .filter(Boolean)
    .join("\n");
}

function extractResponseText(resp) {
  if (!resp) return "";
  if (resp.output_text) return String(resp.output_text).trim();

  const out = [];
  for (const item of resp.output || []) {
    for (const c of item.content || []) {
      if (c?.text) out.push(c.text);
      if (c?.text?.value) out.push(c.text.value);
    }
  }
  return out.join("\n").trim();
}

function pickTopTextChunks(searchJson, limit = 18) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  return items
    .map((it) => flattenChunk(it))
    .filter((t) => t && t.length > 60)
    .slice(0, limit);
}

// Preferuj chunky, kde je částka (Kč) pro dotazy “kolik”
function reorderForAmounts(chunks, userQ) {
  const t = normalizeCzech(userQ);
  const wantsAmount = /(kolik|castka|sazba|kc|kč|poplatek)/i.test(t);
  if (!wantsAmount) return chunks;

  const withKc = [];
  const rest = [];
  for (const c of chunks) {
    if (/\b\d[\d\s]*\s*(kč|kc)\b/i.test(c) || /Sazba poplatku/i.test(c)) withKc.push(c);
    else rest.push(c);
  }
  return [...withKc, ...rest];
}

function extractPdfLinksFromText(text) {
  const s = String(text || "");
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    const u = m[0].replace(/[),.;]+$/g, "");
    if (u.includes("obec-radim.cz") && (u.includes("e_download.php") || u.toLowerCase().includes(".pdf"))) {
      out.add(u);
    }
  }
  return Array.from(out);
}

export default async function handler(req) {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!apiKey || !vectorStoreId)
      return jsonResponse(500, { ok: false, error: "Missing env vars" });

    const body = await req.json();
    const message = body?.message;

    if (!message)
      return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQ = String(message).trim();
    const pdfish = isPdfish(userQ);

    // 1) pass: normální search
    const s1 = await oaiFetch(
      `/vector_stores/${vectorStoreId}/search`,
      {
        method: "POST",
        body: JSON.stringify({
          query: userQ,
          max_num_results: pdfish ? 60 : 45,
          rewrite_query: false,
        }),
      },
      apiKey
    );

    let chunks = pickTopTextChunks(s1, pdfish ? 22 : 16);

    // 2) pass: zacílený search pro vyhlášky/poplatky (přitáhne PDF_TEXT chunky)
    if (pdfish) {
      const q2 = `${userQ} Sazba poplatku Kč Čl. splatnost účinnost vyhláška`;
      const s2 = await oaiFetch(
        `/vector_stores/${vectorStoreId}/search`,
        {
          method: "POST",
          body: JSON.stringify({
            query: q2,
            max_num_results: 60,
            rewrite_query: false,
          }),
        },
        apiKey
      );

      const chunks2 = pickTopTextChunks(s2, 18);
      chunks = [...chunks, ...chunks2];
    }

    // dedupe (podle prvních 200 znaků)
    const seen = new Set();
    chunks = chunks.filter((c) => {
      const key = c.slice(0, 200);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    chunks = reorderForAmounts(chunks, userQ).slice(0, pdfish ? 26 : 18);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, links: [] });
    }

    const context = chunks.join("\n\n---\n\n");

    // vycucni PDF linky (když existují)
    const pdfLinks = extractPdfLinksFromText(context).slice(0, 6);

    const sys =
      "Odpovídej pouze podle KONTEXTU. " +
      `Pokud odpověď není v kontextu, napiš přesně: ${HARD_FALLBACK}. ` +
      "Pokud je v kontextu částka (Kč), uveď ji přesně. " +
      "Pokud je v kontextu odkaz na PDF, přilož ho.";

    const resp = await oaiFetch(
      `/responses`,
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.1,
          input: [
            { role: "system", content: sys },
            { role: "user", content: `KONTEXT:\n${context}\n\nDOTAZ:\n${userQ}` },
          ],
        }),
      },
      apiKey
    );

    let answer = extractResponseText(resp);
    if (!answer) answer = HARD_FALLBACK;

    // Když model zapomene přidat linky, doplníme je “technicky”
    if (pdfLinks.length && !answer.includes("http")) {
      answer += `\n\nOdkaz na PDF:\n` + pdfLinks.join("\n");
    }

    return jsonResponse(200, { ok: true, answer, links: pdfLinks });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}