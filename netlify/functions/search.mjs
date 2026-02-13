// netlify/functions/search.mjs
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";
const HARD_FALLBACK = "Tato informace není v dostupných podkladech obce Radim uvedena.";

const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/aktuality/",
  kalendar: "https://www.obec-radim.cz/aktualne/kalendar-akci/",
  bioodpad: "https://www.obec-radim.cz/urad/skladka-bioodpadu/",
  czechPoint: "https://www.obec-radim.cz/urad/czech-point/",
};

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

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
}

function stripSeniorUrl(u) {
  return String(u || "").replace(/^https:\/\/www\.obec-radim\.cz\/seniori\//i, "https://www.obec-radim.cz/");
}

function stripSeniorInText(t) {
  return String(t || "")
    .replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/")
    .replace(/\/seniori\//gi, "/");
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // Vector store endpoints jsou pod assistants=v2
      "OpenAI-Beta": "assistants=v2",
      "Content-Type": body ? "application/json" : undefined,
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path} failed: ${msg}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

/**
 * POST /v1/vector_stores/{id}/search
 */
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 28, rewriteQuery = true, scoreThreshold = 0.05 },
  apiKey
) {
  return await oaiFetch(
    `/vector_stores/${vectorStoreId}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        max_num_results: maxNumResults,
        rewrite_query: rewriteQuery,
        ranking_options: { ranker: "auto", score_threshold: scoreThreshold },
      }),
    },
    apiKey
  );
}

function safeTextFromItem(it) {
  const chunks = Array.isArray(it?.content) ? it.content : [];
  const t = chunks
    .map((c) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return t;
}

function detectBucket(filename = "") {
  const f = String(filename);
  if (/00_LATEST_/i.test(f)) return "LATEST";
  if (/00_?PEOPLE/i.test(f) || /people\//i.test(f)) return "PEOPLE";
  if (/30_PDF_TEXT_/i.test(f)) return "PDFTEXT";
  if (/99_FULL_/i.test(f)) return "FULL";
  return "OTHER";
}

function extractUrls(text) {
  const t = String(text || "");
  const urls = t.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(stripSeniorUrl);
}

function tokenizeForScoring(q) {
  const s = normalizeCzech(q);
  const raw = s
    .replace(/[^a-z0-9á-ž\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    "a","i","v","ve","na","do","z","ze","za","se","si","to","ten","tato","tady","tam","kde","kdy","kolik","jaky","jaka",
    "jak","pro","u","o","od","po","je","jsou","by","byl","byla","byt","mit","mohu","muzete","chci","chceme","prosím","prosim"
  ]);

  const tokens = [];
  for (const w of raw) {
    if (w.length < 3) continue;
    if (stop.has(w)) continue;
    tokens.push(w);
  }
  return Array.from(new Set(tokens)).slice(0, 18);
}

function scoreChunkText(chunkText, tokens) {
  const t = normalizeCzech(chunkText);
  let score = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    // silnější, když se token vyskytuje vícekrát
    const m = t.match(new RegExp(`\\b${tok}\\b`, "g"));
    if (m) score += Math.min(3, m.length); // cap
  }
  return score;
}

function pickBestChunks(items, userQ, limit = 14) {
  const tokens = tokenizeForScoring(userQ);

  const enriched = items
    .map((it) => {
      const filename = it?.filename || "";
      const rawScore = typeof it?.score === "number" ? it.score : 0;
      const text = safeTextFromItem(it);
      const bucket = detectBucket(filename);
      const local = scoreChunkText(text, tokens);
      // kombinace: lokální relevance + score z VS
      const combined = local * 1.2 + rawScore * 6;
      return { filename, bucket, rawScore, local, combined, text };
    })
    .filter((x) => x.text && x.text.length > 40);

  // preferuj lidi u person dotazů
  const nq = normalizeCzech(userQ);
  const wantsPerson =
    /\b(starosta|starostka|mistostarosta|predsed|predsedkyne|kontakt|telefon|email|e-mail|urad|uradni)\b/.test(nq);

  enriched.sort((a, b) => b.combined - a.combined);

  const out = [];
  const seenKey = new Set();

  // 1) když jde o osoby, přitáhni PEOPLE dopředu
  if (wantsPerson) {
    for (const x of enriched) {
      if (x.bucket === "PEOPLE" && out.length < 4) {
        const k = `${x.filename}:${x.text.slice(0, 160)}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        out.push(x);
      }
    }
  }

  // 2) přidej LATEST + PDFTEXT (často vyhlášky / poplatky)
  for (const x of enriched) {
    if ((x.bucket === "LATEST" || x.bucket === "PDFTEXT") && out.length < 10) {
      const k = `${x.filename}:${x.text.slice(0, 160)}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      out.push(x);
    }
  }

  // 3) doplň FULL
  for (const x of enriched) {
    if (out.length >= limit) break;
    const k = `${x.filename}:${x.text.slice(0, 160)}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    out.push(x);
  }

  return out.slice(0, limit).map((x) => ({
    filename: x.filename,
    bucket: x.bucket,
    rawScore: x.rawScore,
    local: x.local,
    text: x.text.slice(0, 4200),
  }));
}

function buildContextBlock(chunks) {
  const groups = { PEOPLE: [], LATEST: [], PDFTEXT: [], FULL: [], OTHER: [] };
  for (const c of chunks) groups[c.bucket || "OTHER"].push(c);

  const order = ["PEOPLE", "LATEST", "PDFTEXT", "FULL", "OTHER"];

  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (výběr relevantních úryvků):\n`;
  ctx += `Dnes: ${todayCZ()}\n`;
  ctx += `---\n`;

  for (const k of order) {
    if (!groups[k].length) continue;
    ctx += `\n### ${k}\n`;
    groups[k].forEach((c, i) => {
      ctx += `[#${k}-${i + 1}] ${c.filename || "soubor"} | vs_score=${c.rawScore ?? "?"} | local=${c.local ?? "?"}\n`;
      ctx += `${stripSeniorInText(c.text)}\n`;
      ctx += `---\n`;
    });
  }

  // link hints z kontextu
  const allUrls = [];
  for (const c of chunks) allUrls.push(...extractUrls(c.text));
  const uniq = [];
  const seen = new Set();
  for (const u of allUrls) {
    const nu = stripSeniorUrl(u);
    if (!seen.has(nu)) {
      seen.add(nu);
      uniq.push(nu);
    }
    if (uniq.length >= 8) break;
  }

  if (uniq.length) {
    ctx += `\nLINK HINTS (přímé odkazy nalezené v podkladech):\n`;
    uniq.forEach((u) => (ctx += `- ${u}\n`));
    ctx += `---\n`;
  }

  return ctx.trim();
}

function systemPrompt(userQ) {
  const nq = normalizeCzech(userQ);
  const wantsQuote = /\b(cituj|citace|zkopiruj|zkopíruj|presnou vetu|přesnou větu|doslova)\b/.test(nq);

  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídej na základě poskytnutého KONTEXTU (úryvky z webu obce, dokumentů a PDF textů).\n` +
    `Buď praktický a užitečný. Nevymýšlej fakta.\n\n` +
    `Když se odpověď z kontextu nedá doložit, napiš přesně: "${HARD_FALLBACK}"\n\n` +
    `Odkazy:\n` +
    `- Vždy uveď 1–3 relevantní odkazy, pokud jsou v kontextu.\n` +
    `- Nikdy neposílej odkazy se segmentem /seniori/ (používej klasický web).\n\n` +
    (wantsQuote
      ? `Uživatel chce CITACI: zkopíruj doslovně max 2 věty z kontextu a uveď, odkud to je (název souboru/sekce).\n\n`
      : ``) +
    `Styl:\n` +
    `- krátce, ale konkrétně (1–6 bodů)\n` +
    `- u poplatků vždy uveď částku + kde je uvedena (článek/odstavec), pokud je to v kontextu\n`
  );
}

async function generateAnswer({ userMessage, contextBlock }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        input: [
          { role: "system", content: systemPrompt(userMessage) },
          { role: "user", content: `${contextBlock}\n\nDOTAZ UŽIVATELE:\n${userMessage}` },
        ],
      }),
    },
    apiKey
  );

  const out = Array.isArray(resp?.output) ? resp.output : [];
  const msg = out.find((x) => x?.type === "message");
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const text = content
    .map((c) => (c?.type === "output_text" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || "";
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč citace file_search typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // normalizuj seniors url
  s = stripSeniorInText(s);

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
}

function hasAnyUrl(text) {
  return /\bhttps?:\/\/[^\s<>"')\]]+/i.test(String(text || ""));
}

function pickFallbackLink(q) {
  const s = normalizeCzech(q);
  if (/\b(bioodpad|skladka|kompost|zeleny odpad)\b/.test(s)) return KEY_LINKS.bioodpad;
  if (/\b(kontakt|telefon|e-mail|email|datova schranka|adresa)\b/.test(s)) return KEY_LINKS.kontakty;
  if (/\b(uredni hodiny|oteviraci doba|czech point|overit|ověřit podpis|ověření)\b/.test(s)) return KEY_LINKS.czechPoint;
  if (/\b(uredni deska|vyhlaska|vyhláška|oznameni|zamer)\b/.test(s)) return KEY_LINKS.uredniDeska;
  if (/\b(akce|kalendar|kalendář|program)\b/.test(s)) return KEY_LINKS.kalendar;
  return KEY_LINKS.homepage;
}

function ensureLinks(answer, contextBlock, userQ) {
  let a = String(answer || "").trim();
  if (!a) return a;

  // pokud odpověď nemá URL, přidej link hints z kontextu
  if (!hasAnyUrl(a)) {
    const urls = extractUrls(contextBlock);
    const uniq = [];
    const seen = new Set();
    for (const u of urls) {
      const nu = stripSeniorUrl(u);
      if (seen.has(nu)) continue;
      seen.add(nu);
      uniq.push(nu);
      if (uniq.length >= 3) break;
    }

    if (uniq.length) {
      a += `\n\nOdkazy:\n` + uniq.map((u) => `- ${u}`).join("\n");
    } else {
      const fb = pickFallbackLink(userQ);
      a += `\n\nOdkazy:\n- ${fb}`;
    }
  }

  // odduplikuj stejné linky po řádcích
  const lines = a.split("\n");
  const out = [];
  const seenLine = new Set();
  for (const line of lines) {
    const l = line.trim();
    if (/^-\s*https?:\/\//i.test(l)) {
      if (seenLine.has(l)) continue;
      seenLine.add(l);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// lehký safety: když model začne blábolit (příliš obecné fráze), radši fallback
function looksBad(answer) {
  const a = normalizeCzech(answer);
  if (!a) return true;
  if (a.includes("bez odpovedi") || a === "bez odpovědi") return true;
  if (/(pravdepodobne|mozna|nejsem si jist|zkuste|doporučuji kontaktovat|nemam pristup)/i.test(answer)) return false; // povolíme
  return false;
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
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_${Date.now()}`;

    // reset
    if (userQ.toLowerCase() === "reset") {
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: `thread_${Date.now()}` });
    }

    // 1) multi-query (chytřeji)
    const nq = normalizeCzech(userQ);
    const tokens = tokenizeForScoring(userQ).join(" ");
    const q1 = userQ;
    const q2 = nq;
    const q3 = `${userQ} obec Radim`;
    const q4 = tokens ? `${tokens} Radim` : `${userQ} Radim`;

    // heuristiky pro lepší zacílení
    const extra = [];
    if (/\b(starosta|starostka|mistostarosta|predsed|predsedkyne|kontakt)\b/.test(nq)) extra.push("00_PEOPLE_obec_radim");
    if (/\b(vyhlaska|vyhláška|poplatek|odpady|pes|psi)\b/.test(nq)) extra.push("30_PDF_TEXT_obec_radim vyhláška poplatek článek");
    if (/\b(uredni deska|oznameni|zamer)\b/.test(nq)) extra.push("00_LATEST_obec_radim úřední deska");
    if (/\b(bioodpad|skladka|kompost)\b/.test(nq)) extra.push("skládka bioodpadu Radim parcela otevřeno");

    const queries = [q1, q2, q3, q4, ...extra].filter(Boolean).slice(0, 8);

    // 2) vector search – nízký threshold, a když nic, tak ještě snížit
    let search = await vectorSearch(
      { vectorStoreId, query: queries, maxNumResults: 30, rewriteQuery: true, scoreThreshold: 0.05 },
      apiKey
    );

    const items = Array.isArray(search?.data) ? search.data : [];
    let chunks = pickBestChunks(items, userQ, 14);

    if (!chunks.length) {
      search = await vectorSearch(
        { vectorStoreId, query: queries, maxNumResults: 35, rewriteQuery: true, scoreThreshold: 0.0 },
        apiKey
      );
      const items2 = Array.isArray(search?.data) ? search.data : [];
      chunks = pickBestChunks(items2, userQ, 14);
    }

    if (!chunks.length) {
      const fb = `${HARD_FALLBACK}\n\nOdkazy:\n- ${pickFallbackLink(userQ)}`;
      return jsonResponse(200, { ok: true, answer: fb, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 3) answer
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = cleanAnswer(answer);

    if (!answer || answer === "Bez odpovědi" || answer === "Bez odpovedi") {
      answer = HARD_FALLBACK;
    }

    // 4) když by to sklouzlo do nesmyslu, radši fallback (ale NEpřísně)
    if (looksBad(answer) && !hasAnyUrl(answer)) {
      answer = HARD_FALLBACK;
    }

    // 5) doplnění odkazů + odstranění /seniori/
    answer = ensureLinks(answer, contextBlock, userQ);
    answer = stripSeniorInText(answer);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}