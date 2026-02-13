// netlify/functions/search.mjs
// Node 18+ (Netlify Functions)
// ENV: OPENAI_API_KEY, VECTOR_STORE_ID
// Request: { message: string, thread_id?: string }
// Response: { ok:true, answer:string, thread_id:string } | {ok:false,...}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

// NECHCEME být ultra-striktní, ale když fakt nic není:
const SOFT_FALLBACK =
  "Tuhle informaci jsem v dostupných podkladech obce Radim nenašel. Pošli mi prosím upřesnění (čeho se to týká / jaký dokument), nebo se podívám na nejbližší relevantní dokument/stránku a pošlu odkaz.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
  { vectorStoreId, query, maxNumResults = 30, rewriteQuery = true, scoreThreshold = 0.08 },
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

/** ==============================
 *  Query routing (lehké, chytré)
 *  ============================== */
function detectIntent(q) {
  const s = normalizeCzech(q);

  const isFees =
    /\b(poplatek|poplatky|mistni poplatek|místní poplatek|pes|psy|psu|psů|odpad|odpady)\b/.test(s);

  const isDocs =
    /\b(vyhlaska|vyhláška|ozv|narizeni|nařízení|pdf|dokument|usneseni|usnesení)\b/.test(s);

  const isPeople =
    /\b(kdo je|kdo ma na starost|kontakt|telefon|email|e-mail|starosta|mistostarosta|místostarosta|predseda|předseda|predsedkyne|předsedkyně)\b/.test(
      s
    );

  const isLatest =
    /\b(dnes|aktualne|aktuálně|nejnovejsi|nejnovější|posledni|poslední|co je noveho|úřední deska|uredni deska|kalendar|kalendář|akce|aktuality)\b/.test(
      s
    );

  return { isFees, isDocs, isPeople, isLatest };
}

function buildQueries(userQ) {
  const n = normalizeCzech(userQ);
  const base = [userQ, n, `${userQ} obec Radim`];

  const intent = detectIntent(userQ);

  const targeted = [];
  if (intent.isFees) {
    targeted.push(`${userQ} vyhláška`, `${userQ} sazba`, `${userQ} Kč`, `${userQ} účinnost`, "místní poplatek ze psů Radim vyhláška");
  }
  if (intent.isDocs) {
    targeted.push(`${userQ} PDF`, `${userQ} e_download.php`, `${userQ} úřední deska`);
  }
  if (intent.isPeople) {
    targeted.push(`${userQ} kontakt`, `${userQ} obecní úřad`, `${userQ} funkce`);
  }
  if (intent.isLatest) {
    targeted.push(`${userQ} nejnovější`, `${userQ} 2026`, `${userQ} vyvěšeno`);
  }

  // oddup
  const all = [...base, ...targeted].filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const q of all) {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(q);
  }

  return { queries: uniq, intent };
}

/** ==============================
 *  Chunk selection: víc kontextu + diverzita zdrojů
 *  ============================== */

function scoreOf(it) {
  return typeof it?.score === "number" ? it.score : 0;
}

function getFilename(it) {
  return it?.filename || it?.file?.filename || "";
}

function extractText(it) {
  const chunks = Array.isArray(it?.content) ? it.content : [];
  const text = chunks
    .map((c) => (c?.type === "text" ? c?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

function sourceBucket(filename) {
  const f = (filename || "").toLowerCase();
  if (f.includes("00_latest")) return "LATEST";
  if (f.includes("30_pdf_text")) return "PDFTEXT";
  if (f.includes("people")) return "PEOPLE";
  if (f.includes("99_full")) return "FULL";
  return "OTHER";
}

/**
 * Vybere víc chunků, ale:
 * - udrží limit
 * - přidá diverzitu (LATEST/PDFTEXT/PEOPLE)
 */
function pickDiverseChunks(items, intent, limit = 18) {
  const normalized = items
    .map((it) => {
      const filename = getFilename(it);
      const text = extractText(it);
      return {
        filename,
        bucket: sourceBucket(filename),
        score: scoreOf(it),
        text,
      };
    })
    .filter((x) => x.text && x.text.length > 40);

  // seřadit podle skóre desc
  normalized.sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  const usedSig = new Set();

  function addIfOk(x) {
    const sig = (x.filename + "::" + x.text.slice(0, 180)).toLowerCase();
    if (usedSig.has(sig)) return false;
    usedSig.add(sig);
    out.push({
      filename: x.filename,
      bucket: x.bucket,
      score: x.score,
      text: x.text.slice(0, 3200), // víc kontextu
    });
    return true;
  }

  // 1) “Must-have” bucket minima podle intentu
  const want = {
    LATEST: intent.isLatest ? 4 : 2,
    PDFTEXT: intent.isFees || intent.isDocs ? 4 : 1,
    PEOPLE: intent.isPeople ? 3 : 0,
    FULL: 6,
  };

  // nejdřív naplnit preferované bucket
  const buckets = ["LATEST", "PDFTEXT", "PEOPLE", "FULL"];
  for (const b of buckets) {
    const need = want[b] || 0;
    if (!need) continue;
    for (const x of normalized) {
      if (out.length >= limit) break;
      if (x.bucket !== b) continue;
      if (out.filter((o) => o.bucket === b).length >= need) break;
      addIfOk(x);
    }
  }

  // 2) doplnit z top skóre napříč vším
  for (const x of normalized) {
    if (out.length >= limit) break;
    addIfOk(x);
  }

  return out.slice(0, limit);
}

function buildContextBlock(chunks) {
  let ctx = `KONTEXT Z OFICIÁLNÍCH PODKLADŮ OBCE ${OBEC_NAZEV} (vybrané relevantní úryvky):\n`;
  ctx += `Dnes: ${todayCZ()} (rok 2026)\n`;
  ctx += `---\n`;
  chunks.forEach((c, i) => {
    ctx += `[#${i + 1}] ${c.bucket} | ${c.filename || "soubor"} | score: ${c.score ?? "?"}\n`;
    ctx += `${c.text}\n`;
    ctx += `---\n`;
  });
  return ctx.trim();
}

/** ==============================
 *  Model: “komplexní asistent”
 *  ============================== */

function systemPrompt() {
  return (
    `Jsi užitečný a spolehlivý AI asistent obce ${OBEC_NAZEV}.\n` +
    `Pracuj pouze s poskytnutým KONTEXTEM (úryvky ze zdrojů obce).\n` +
    `Můžeš spojovat informace z více úryvků a domýšlet strukturu odpovědi, ale nevymýšlej fakta, jména ani částky.\n\n` +
    `PRIORITA ZDROJŮ:\n` +
    `- 00_LATEST_* = nejnovější info (úřední deska, aktuality, akce, nové dokumenty)\n` +
    `- 30_PDF_TEXT_* = obsah PDF vyhlášek a dokumentů (čísla/částky ber primárně odsud, pokud jsou uvedené)\n` +
    `- people = role/osoby/kontakty\n` +
    `- 99_FULL_* = obecné stránky a navigace\n\n` +
    `PRAVIDLA:\n` +
    `- Když jsou v kontextu různé částky/údaje: vyber tu, která je v novější položce nebo přímo v textu vyhlášky (PDFTEXT) a uveď datum/účinnost, pokud je.\n` +
    `- Když si nejsi jistý, napiš, co přesně v dokumentu stojí, a přilož odkaz na dokument.\n` +
    `- Odpovídej konkrétně, lidsky, ne úřednický “robot”.\n\n` +
    `FORMÁT:\n` +
    `Odpověď:\n- 1–8 bodů (nebo krátký odstavec + body)\n\n` +
    `Odkazy:\n- 1–5 přímých odkazů (nejrelevantnější)\n`
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
          { role: "system", content: systemPrompt() },
          {
            role: "user",
            content:
              `${contextBlock}\n\n` +
              `DOTAZ UŽIVATELE:\n${userMessage}\n\n` +
              `POKYNY NAVÍC:\n` +
              `- Pokud jde o poplatky, vyhledej v kontextu explicitní částku a uveď ji včetně data/účinnosti, pokud je.\n` +
              `- Pokud jde o osoby/funkce: rozlišuj “starosta obce” vs “starosta SDH” a uveď správnou roli.\n`,
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

  return text || "";
}

/** ==============================
 *  Cleanup: citace + seniors odkazy pryč
 *  ============================== */

function stripCitationsAndFixLinks(t) {
  let s = String(t || "");

  // pryč file_search citace typu 【…†…】
  s = s.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // ZAKÁZAT seniors variantu webu: přepiš https://www.obec-radim.cz/seniori/... -> https://www.obec-radim.cz/...
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/seniori\/+/gi, "https://www.obec-radim.cz/");

  // odstraň dvojité lomítka po úpravách (mimo https://)
  s = s.replace(/https:\/\/www\.obec-radim\.cz\/{2,}/gi, "https://www.obec-radim.cz/");

  // whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s.trim();
}

function hasSomeUsefulAnswer(ans) {
  const s = (ans || "").trim();
  if (!s) return false;
  // když to vyrobí jen “Odpověď:” bez obsahu
  if (/^Odpověď:\s*$/i.test(s)) return false;
  return s.length > 40;
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
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const userQ = message.trim();
    const threadId = (body?.thread_id && String(body.thread_id)) || `thread_local_${Date.now()}`;

    // 1) Query builder
    const { queries, intent } = buildQueries(userQ);

    // 2) Dvě vyhledání: širší + cílenější (nižší threshold pro poplatky/PDF)
    const scoreA = intent.isFees || intent.isDocs ? 0.06 : 0.08;
    const scoreB = intent.isFees || intent.isDocs ? 0.04 : 0.07;

    const searchA = await vectorSearch(
      { vectorStoreId, query: queries.slice(0, 10), maxNumResults: 30, rewriteQuery: true, scoreThreshold: scoreA },
      apiKey
    );

    const searchB = await vectorSearch(
      {
        vectorStoreId,
        query: [
          userQ,
          `${userQ} vyhláška`,
          `${userQ} e_download.php`,
          `${userQ} účinnost`,
          `${userQ} Kč`,
          `${userQ} 2025 2026`,
        ],
        maxNumResults: 30,
        rewriteQuery: true,
        scoreThreshold: scoreB,
      },
      apiKey
    );

    const itemsA = Array.isArray(searchA?.data) ? searchA.data : [];
    const itemsB = Array.isArray(searchB?.data) ? searchB.data : [];

    // spoj + oddup podle filename+first chars
    const merged = [];
    const seen = new Set();
    for (const it of [...itemsA, ...itemsB]) {
      const fn = getFilename(it);
      const tx = extractText(it);
      const key = (fn + "::" + (tx || "").slice(0, 200)).toLowerCase();
      if (!tx) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }

    // 3) Vyber víc kontextu + diverzita zdrojů
    const chunks = pickDiverseChunks(merged, intent, 18);

    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: SOFT_FALLBACK, thread_id: threadId });
    }

    const contextBlock = buildContextBlock(chunks);

    // 4) Model odpověď
    let answer = await generateAnswer({ userMessage: userQ, contextBlock }, apiKey);
    answer = stripCitationsAndFixLinks(answer);

    // 5) Když je odpověď slabá, zkusit ještě jednou s vyšším limitem kontextu (fallback pass)
    if (!hasSomeUsefulAnswer(answer)) {
      const moreChunks = pickDiverseChunks(merged, intent, 24);
      const ctx2 = buildContextBlock(moreChunks);
      answer = await generateAnswer({ userMessage: userQ, contextBlock: ctx2 }, apiKey);
      answer = stripCitationsAndFixLinks(answer);
    }

    if (!hasSomeUsefulAnswer(answer)) answer = SOFT_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}