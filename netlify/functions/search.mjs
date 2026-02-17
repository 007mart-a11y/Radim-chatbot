// netlify/functions/search.mjs
// SIMPLE + SMART v1 (history + 2-pass link retrieval + #debug)
// Node 18+
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BETA_HEADER = { "OpenAI-Beta": "assistants=v2" };

const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

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
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
  return json;
}

function normalizeCz(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function detectIntent(q) {
  const t = normalizeCz(q);
  return {
    wantsLink: /(odkaz|link|pošli\s*odkaz|posli\s*odkaz|odkazy|pdf|vyhlask)/i.test(t),
    isDogFee: /(pes|psy|psu|poplatek\s*ze\s*psu)/i.test(t),
    isWasteFee: /(odpad|odvoz\s*odpadu|poplatek\s*za\s*odpad|odpadoveho\s*hospodarstvi)/i.test(t),
    isQuote: /(cituj|ocituj|zkopiruj|max\s*2\s*vety|přesn)/i.test(t),
  };
}

function extractUrls(text) {
  const s = String(text || "");
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    let u = m[0].replace(/[),.;]+$/g, "");
    // normalize seniors
    u = u.replace("https://www.obec-radim.cz/seniori/", "https://www.obec-radim.cz/");
    if (u.includes("obec-radim.cz")) out.add(u);
  }
  return Array.from(out);
}

function flattenChunks(searchJson) {
  const items = Array.isArray(searchJson?.data) ? searchJson.data : [];
  return items
    .map((it) => {
      const filename = it?.filename || it?.file?.filename || it?.file?.name || "soubor";
      const text = (Array.isArray(it?.content) ? it.content : [])
        .map((c) => (c?.type === "text" ? c?.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      const score = typeof it?.score === "number" ? it.score : 0;
      return { filename, score, text };
    })
    .filter((x) => x.text && x.text.length > 50)
    .sort((a, b) => b.score - a.score);
}

function uniqByText(list, limit) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const key = (x.filename || "") + "::" + x.text.slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

function buildQueries(userQ, history) {
  const it = detectIntent(userQ);

  // pokud user napsal jen "pošli odkaz", vezmeme poslední smysluplný dotaz z historie
  const shortFollowup = normalizeCz(userQ).length < 28 && it.wantsLink;

  let lastUser = "";
  if (Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h?.role === "user" && typeof h?.content === "string") {
        const c = h.content.trim();
        if (c && !/^(pošli|posli)\s*odkaz/i.test(normalizeCz(c))) {
          lastUser = c;
          break;
        }
      }
    }
  }

  const baseQ = shortFollowup && lastUser ? `${lastUser} (uživatel chce odkaz)` : userQ;

  const qs = new Set();
  qs.add(baseQ);

  // Synonyma / rozšíření – hlavně pro “odvoz odpadu”
  if (it.isWasteFee) {
    qs.add(`${baseQ} místní poplatek za obecní systém odpadového hospodářství sazba Kč`);
    qs.add(`obecně závazná vyhláška Radim poplatek odpad 750 Kč`);
  }
  if (it.isDogFee) {
    qs.add(`${baseQ} obecně závazná vyhláška poplatek ze psů sazba 150 Kč čl. 4`);
    qs.add(`obec radim vyhláška poplatek ze psů 2026 150 Kč`);
  }

  // když chce link, přidej cíleně “PDF_URL”
  if (it.wantsLink) {
    qs.add(`${baseQ} PDF_URL`);
    qs.add(`${baseQ} FOUND_ON`);
  }

  return Array.from(qs).slice(0, 6);
}

async function vectorSearch(vectorStoreId, query, apiKey, maxNumResults = 60) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: true,
      }),
    },
    apiKey
  );
}

function buildContext(chunks, urlHints) {
  const cap = 7000;

  let ctx = `OFICIÁLNÍ PODKLADY OBCE RADIM (výběr relevantních částí):\n\n`;

  if (urlHints?.length) {
    ctx += `DŮLEŽITÉ ODKAZY (z podkladů):\n`;
    for (const u of urlHints.slice(0, 12)) ctx += `- ${u}\n`;
    ctx += `\n`;
  }

  chunks.forEach((c, i) => {
    let t = c.text || "";
    if (t.length > cap) t = t.slice(0, cap) + "\n[ZKRÁCENO]";
    ctx += `--- ZDROJ ${i + 1}: ${c.filename} (score ${c.score.toFixed(3)})\n${t}\n\n`;
  });

  return ctx.trim();
}

function extractAnswer(resp) {
  const out = [];

  if (typeof resp?.output_text === "string" && resp.output_text.trim()) out.push(resp.output_text.trim());

  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if ((c?.type === "output_text" || c?.type === "text") && c?.text) out.push(String(c.text));
      }
    }
  }

  return out.join("\n").trim();
}

function cleanAnswer(text) {
  let s = String(text || "");

  // remove file-search citations like 【...†...】
  s = s.replace(/【[^】]*†[^】]*】/g, "");

  // seniors link normalize
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\//g, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

async function generateAnswer({ userQ, history, context, debug }, apiKey) {
  const it = detectIntent(userQ);

  const sys =
    `Odpovídej POUZE podle poskytnutého kontextu.\n` +
    `Nevymýšlej informace. Pokud údaj není v kontextu, vrať přesně: "${HARD_FALLBACK}".\n` +
    `Pokud existuje relevantní odkaz (URL) v kontextu, vždy ho uveď.\n` +
    (it.isQuote ? `Pokud uživatel žádá citaci, zkopíruj max 2 věty přesně z kontextu.\n` : ``) +
    (debug ? `DEBUG je zapnutý – na konec přidej řádek "ZDROJE: ZDROJ 1, ZDROJ 2..." podle toho, co jsi použil.\n` : ``);

  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

  const input = [
    { role: "system", content: sys },
    ...safeHistory.map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content || "").slice(0, 1800),
    })),
    { role: "user", content: `${context}\n\nDOTAZ:\n${userQ}` },
  ];

  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        input,
      }),
    },
    apiKey
  );

  return extractAnswer(resp);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing VECTOR_STORE_ID" });

    const body = await req.json().catch(() => ({}));
    let message = body?.message;
    const history = Array.isArray(body?.history) ? body.history : [];

    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const raw = message.trim();
    const debug = raw.toLowerCase().startsWith("#debug");
    const userQ = debug ? raw.replace(/^#debug\s*/i, "").trim() : raw;

    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_${Date.now()}`;

    const it = detectIntent(userQ);
    const queries = buildQueries(userQ, history);

    // 1) hlavní search (více dotazů)
    let merged = [];
    for (const q of queries) {
      const s = await vectorSearch(vectorStoreId, q, apiKey, 70);
      merged.push(...flattenChunks(s));
    }

    // vyber top chunky
    let chunks = uniqByText(merged, 22);

    // 2) pokud je to vyhláška / chce link, uděláme 2. pass na dohledání PDF_URL / FOUND_ON
    if (it.wantsLink || it.isDogFee || it.isWasteFee) {
      const linkQs = [];
      if (it.isDogFee) linkQs.push("original=mistni-poplatek-ze-psu", "poplatek ze psů PDF_URL", "vyhláška poplatek ze psů PDF_URL");
      if (it.isWasteFee) linkQs.push("odpadového hospodářství PDF_URL", "poplatek za obecní systém odpadového hospodářství PDF_URL", "sazba poplatku 750 Kč PDF_URL");
      if (!linkQs.length) linkQs.push(`${userQ} PDF_URL`);

      let linkMerged = [];
      for (const q of linkQs.slice(0, 4)) {
        const s2 = await vectorSearch(vectorStoreId, q, apiKey, 40);
        linkMerged.push(...flattenChunks(s2));
      }

      const linkChunks = uniqByText(linkMerged, 8);
      chunks = uniqByText([...chunks, ...linkChunks], 26);
    }

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: HARD_FALLBACK, thread_id: threadId, debug: debug ? { queries } : undefined });
    }

    // URL hints: vyber URL z chunků (a tím dáš modelu "co linknout" i když částka je v jiném chunku)
    const urlHints = Array.from(new Set(chunks.flatMap((c) => extractUrls(c.text))));

    const context = buildContext(chunks, urlHints);

    let answer = await generateAnswer({ userQ, history, context, debug }, apiKey);
    answer = cleanAnswer(answer);

    if (!answer) answer = HARD_FALLBACK;

    // když model vrátil fallback, ale my máme v kontextu jasné "Sazba ... Kč", zkusíme ještě 1x (krátký retry)
    if (answer === HARD_FALLBACK) {
      const retry = await generateAnswer(
        {
          userQ: `${userQ}\n\nPOZOR: V kontextu zkontroluj řádky se 'Sazba poplatku' a částkami 'Kč'. Pokud jsou, odpověz z nich.`,
          history,
          context,
          debug,
        },
        apiKey
      );
      const cleaned = cleanAnswer(retry);
      if (cleaned && cleaned !== HARD_FALLBACK) answer = cleaned;
    }

    const resp = { ok: true, answer, thread_id: threadId };

    if (debug) {
      resp.debug = {
        queries,
        urlHints: urlHints.slice(0, 12),
        topChunks: chunks.slice(0, 10).map((c, i) => ({
          idx: i + 1,
          filename: c.filename,
          score: Number(c.score.toFixed(3)),
          preview: c.text.slice(0, 180).replace(/\s+/g, " ").trim(),
        })),
      };
    }

    return jsonResponse(200, resp);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}