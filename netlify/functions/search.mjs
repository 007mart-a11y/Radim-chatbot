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

// Kanonické rozcestníky (jen když v odpovědi není žádný link)
const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/aktuality/",
  kalendar: "https://www.obec-radim.cz/aktualne/kalendar-akci/",
  bioodpad: "https://www.obec-radim.cz/urad/skladka-bioodpadu/",
  odpady: "https://www.obec-radim.cz/tema/odpady/",
  sokol: "https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/",
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

function rewriteSeniorsUrls(s) {
  // https://www.obec-radim.cz/seniori/... -> https://www.obec-radim.cz/...
  return String(s || "").replace(/https:\/\/www\.obec-radim\.cz\/seniori\//gi, "https://www.obec-radim.cz/");
}

async function oaiFetch(path, { method = "GET", headers = {}, body } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
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
 * Vector Store Search
 * POST /v1/vector_stores/{vector_store_id}/search
 */
async function vectorSearch(
  { vectorStoreId, query, maxNumResults = 18, rewriteQuery = true, scoreThreshold = 0.12 },
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
        ranking_options: {
          ranker: "auto",
          score_threshold: scoreThreshold,
        },
      }),
    },
    apiKey
  );
}

function isPersonQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(starosta|misto?starosta|zastupitel|zastupitelstvo|rada obce|tajemnik|ucetni|spravce|kontaktni osoba|vede|predseda|predsedkyne|reditel|reditelka|telefon|email|e-mail)\b/.test(
    s
  );
}

function isWhereWhenQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(kde|kdy|otevreno|oteviraci|uredni hodiny|hodiny|provoz|trasa|jak se dostanu|kam)\b/.test(s);
}

function isBioQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(bioodpad|zeleny odpad|kompost|trava|vetve|posekana trava|skladka bio)\b/.test(s);
}

function isPdfQuoteQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(opis|opiš|zkopiruj|zkopíruj|cituj|citace|presnou vetu|přesnou větu|odstavec|clanek|článek)\b/.test(
    s
  );
}

function pickFallbackLink(q) {
  const s = normalizeCzech(q);
  if (isBioQuestion(q)) return KEY_LINKS.bioodpad;
  if (/\b(uredni deska|vyhlaska|vyhláška|oznameni|zamer|záměr|rozpocet|rozpočet)\b/.test(s)) return KEY_LINKS.uredniDeska;
  if (/\b(akce|kalendar|kalendář)\b/.test(s)) return KEY_LINKS.kalendar;
  if (/\b(kontakt|telefon|email|e-mail|datova schranka|adresa|ico)\b/.test(s)) return KEY_LINKS.kontakty;
  return KEY_LINKS.homepage;
}

function hasAnyUrl(text) {
  return /\bhttps?:\/\/[^\s<>"')\]]+/i.test(String(text || ""));
}

function ensureLinkBlock(answer, q) {
  let t = String(answer || "").trim();
  if (!t) return t;

  if (!hasAnyUrl(t)) {
    const link = pickFallbackLink(q);
    t = `${t}\n\nOdkazy:\n- ${link}`;
  } else {
    // když jsou linky, aspoň zajistíme, že je v textu někde "Odkazy:" (čitelnost)
    if (!/^\s*Odkazy\s*:/im.test(t)) {
      // pokud už odpověď má URL “v těle”, nic nelámej – jen přidej “Odkazy” blok s první URL by bylo moc.
      // necháme tak.
    }
  }

  // lehká deduplikace řádků s URL
  const lines = t.split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const norm = line.trim();
    if (/https?:\/\//i.test(norm)) {
      const key = norm.replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pickTopChunksMerged(searchResults, limit = 18) {
  // merge + dedupe: prefer higher score, keep variety (people/pdf/full/latest)
  const items = [];
  for (const r of searchResults) {
    const data = Array.isArray(r?.data) ? r.data : [];
    for (const it of data) items.push(it);
  }

  // normalize to { filename, score, text }
  const normalized = [];
  for (const it of items) {
    const filename = it?.filename || "";
    const score = typeof it?.score === "number" ? it.score : 0;
    const chunks = Array.isArray(it?.content) ? it.content : [];
    const text = chunks
      .map((c) => (c?.type === "text" ? c?.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) continue;

    normalized.push({
      filename,
      score,
      text: rewriteSeniorsUrls(text),
    });
  }

  // sort by score desc
  normalized.sort((a, b) => (b.score || 0) - (a.score || 0));

  // dedupe by hash of beginning text + filename
  const out = [];
  const seen = new Set();

  // small "bucket" preference so people/pdf aren't drowned
  function bucket(fn) {
    const f = (fn || "").toLowerCase();
    if (f.includes("people")) return "A_people";
    if (f.includes("30_pdf_text")) return "B_pdf";
    if (f.includes("00_latest")) return "C_latest";
    if (f.includes("99_full")) return "D_full";
    return "Z_other";
  }

  // interleave by bucket a bit
  const buckets = new Map();
  for (const x of normalized) {
    const b = bucket(x.filename);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(x);
  }

  const bucketOrder = ["A_people", "B_pdf", "C_latest", "D_full", "Z_other"];

  // Round-robin take
  while (out.length < limit) {
    let progressed = false;
    for (const b of bucketOrder) {
      const arr = buckets.get(b) || [];
      if (!arr.length) continue;
      const x = arr.shift();

      const key = `${x.filename}::${x.text.slice(0, 500)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        filename: x.filename,
        score: x.score,
        text: x.text.slice(0, 2800), // držíme chunk rozumně
      });

      progressed = true;
      if (out.length >= limit) break;
    }
    if (!progressed) break;
  }

  return out;
}

function buildContextBlock(chunks) {
  // Více kontextu, ale pořád čitelné
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (vybrané relevantní úryvky):\n---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.filename || "soubor"} (score: ${typeof c.score === "number" ? c.score.toFixed(3) : "?"})\n`;
    ctx += `${c.text}\n---\n`;
  });
  return ctx.trim();
}

function systemPrompt({ quoteMode = false } = {}) {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš přirozeně a užitečně, ale VEŠKERÉ konkrétní údaje (jména, částky, termíny, adresy) musí být doložitelné v poskytnutém kontextu.\n` +
    `Pokud to z kontextu nejde doložit, řekni přesně:\n` +
    `"${HARD_FALLBACK}"\n\n` +
    `Dnes je ${todayCZ()}.\n` +
    `Aktuální rok je 2026. Informace s minulým datem ber jako historické a napiš to.\n\n` +
    `POVINNÉ:\n` +
    `- Na konci uveď sekci "Odkazy:" a 1–3 přímé odkazy z kontextu (URL).\n` +
    `- Nikdy neposílej odkazy se /seniori/ (použij standardní web).\n\n` +
    (quoteMode
      ? `REŽIM CITACE:\n- Uživatel chce opsat přesnou část. Opiš max. 1–2 věty (krátká citace) a uveď, kde to je (např. článek/odstavec), pokud to v kontextu je.\n`
      : `STYL:\n- stručně, ale “normálně chytré” (1–6 bodů nebo krátký odstavec)\n- když dotaz směřuje na postup, dej kroky\n- když je dotaz o osobě (starosta apod.), preferuj info z people úryvků\n`) +
    `\nZAKÁZÁNO:\n- nevymýšlet, nehádát, nedoplňovat mimo kontext\n`
  );
}

async function generateAnswer({ userMessage, contextBlock, quoteMode }, apiKey) {
  const resp = await oaiFetch(
    `/responses`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        input: [
          { role: "system", content: systemPrompt({ quoteMode }) },
          {
            role: "user",
            content:
              `${contextBlock}\n\n` +
              `DOTAZ UŽIVATELE:\n${rewriteSeniorsUrls(userMessage)}\n\n` +
              `Instrukce: odpověz pouze z kontextu. Pokud v kontextu nejsou žádné relevantní údaje, použij přesně fallback větu.`,
          },
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

  return text || HARD_FALLBACK;
}

function cleanAnswer(t) {
  let s = String(t || "");

  // pryč file_search citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // pryč /seniori/
  s = rewriteSeniorsUrls(s);

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
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
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // === 1) ADAPTIVNÍ PARAMETRY RETRIEVALU ===
    const personQ = isPersonQuestion(userQ);
    const whereWhenQ = isWhereWhenQuestion(userQ);
    const bioQ = isBioQuestion(userQ);
    const quoteMode = isPdfQuoteQuestion(userQ);

    // jemnější threshold pro "kde/kdy"
    const baseThreshold = whereWhenQ ? 0.06 : 0.12;

    // === 2) MULTI-QUERY (boost people / pdf / synonyma) ===
    const q1 = userQ;
    const q2 = normalizeCzech(userQ);
    const q3 = `${userQ} obec ${OBEC_NAZEV}`;

    const queriesMain = [q1, q2, q3];

    const queriesPeople = personQ
      ? [
          `00_PEOPLE obec ${OBEC_NAZEV} ${userQ}`,
          `people ${OBEC_NAZEV} ${userQ}`,
          `funkce osoba ${OBEC_NAZEV} ${userQ}`,
        ]
      : [];

    const queriesBio = bioQ
      ? [
          "skládka bioodpadu Radim kde",
          "posekaná tráva Radim kam",
          "větve bioodpad Radim",
          "kompost zelený odpad Radim",
          "bioodpad otevřeno Radim",
        ]
      : [];

    const queriesPdf = quoteMode
      ? [
          `${userQ} 150 Kč`,
          `místní poplatek ze psů článek odstavec`,
          `výše poplatku ze psů Radim`,
          `místní poplatek odpadové hospodářství částka`,
        ]
      : [];

    // === 3) 2–3 SEARCH CALLS, pak merge ===
    const results = [];

    // hlavní search
    results.push(
      await vectorSearch(
        {
          vectorStoreId,
          query: queriesMain,
          maxNumResults: quoteMode ? 28 : 22,
          rewriteQuery: true,
          scoreThreshold: baseThreshold,
        },
        apiKey
      )
    );

    // people boost
    if (queriesPeople.length) {
      results.push(
        await vectorSearch(
          {
            vectorStoreId,
            query: queriesPeople,
            maxNumResults: 18,
            rewriteQuery: true,
            scoreThreshold: Math.max(baseThreshold, 0.06),
          },
          apiKey
        )
      );
    }

    // bio boost
    if (queriesBio.length) {
      results.push(
        await vectorSearch(
          {
            vectorStoreId,
            query: queriesBio,
            maxNumResults: 18,
            rewriteQuery: true,
            scoreThreshold: 0.05,
          },
          apiKey
        )
      );
    }

    // pdf quote boost
    if (queriesPdf.length) {
      results.push(
        await vectorSearch(
          {
            vectorStoreId,
            query: queriesPdf,
            maxNumResults: 28,
            rewriteQuery: true,
            scoreThreshold: 0.05,
          },
          apiKey
        )
      );
    }

    const chunks = pickTopChunksMerged(results, quoteMode ? 22 : 18);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: ensureLinkBlock(HARD_FALLBACK, userQ), thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // === 4) GENERACE ODPOVĚDI (normální, ne “striktní vyhledávač”) ===
    let answer = await generateAnswer({ userMessage: userQ, contextBlock, quoteMode }, apiKey);
    answer = cleanAnswer(answer);

    // když model začne plácat úplně mimo, vrať fallback (jemně, ne agresivně)
    const looksVeryGeneric =
      answer.length > 900 &&
      /(obecně|standardně|záleží|typicky|doporučuje se|zpravidla|nelze jednoznačně)/i.test(answer);

    if (looksVeryGeneric) answer = HARD_FALLBACK;

    // doplnění odkazu, když by žádný nebyl
    answer = ensureLinkBlock(answer, userQ);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}