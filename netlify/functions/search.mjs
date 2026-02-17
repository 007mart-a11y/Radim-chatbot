// netlify/functions/search.mjs
// Stable + deterministic fee extraction (odpad/psi)
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
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
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

  const text = await res.text().catch(() => "");
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}

  if (!res.ok) {
    throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
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
        score: typeof item?.score === "number" ? item.score : 0,
        text,
        filename: item?.filename || item?.file?.filename || ""
      };
    })
    .filter(x => x.text && x.text.length > 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

function extractLinks(text) {
  const re = /(https?:\/\/[^\s<>()"]+)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(String(text || "")))) out.add(m[1]);
  return Array.from(out);
}

function pickBestUrl(allText, preferRegexList) {
  const urls = extractLinks(allText);
  for (const re of preferRegexList) {
    const hit = urls.find(u => re.test(u));
    if (hit) return hit;
  }
  return urls[0] || null;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function looksLikeFeeQuery(qNorm) {
  return /(poplatek|kolik se plati|kolik je|sazba|odvoz odpadu|odpad)/i.test(qNorm);
}
function isWasteFee(qNorm) {
  return /(odpad|odpadoveho|odvoz odpadu|komunalni)/i.test(qNorm);
}
function isDogFee(qNorm) {
  return /(pes|psu|ze psu|poplatek ze psu)/i.test(qNorm);
}

// Deterministic extraction from chunk texts
function extractFeeFromText(allText, mode /*"waste"|"dog"*/) {
  const t = String(allText || "");

  // Sazba: "Sazba poplatku ... činí 750 Kč." nebo "Sazba poplatku za kalendářní rok činí 750 Kč."
  const sazbaRe = /Sazba\s+poplatku[^.\n]{0,120}činí\s+([0-9][0-9 .]*)\s*Kč/i;

  // Splatnost: "splatný nejpozději do 31. března"
  const splatRe = /Poplatek\s+je\s+splatn[ýa]\s+nejpozději\s+do\s+([0-9]{1,2}\.\s*[0-9]{1,2}\.|[0-9]{1,2}\.\s*[a-zá-ž]+)\s*([0-9]{4})?/i;

  // U odpadu chceme, aby se to vážilo k odpadovému hospodářství
  if (mode === "waste") {
    const mustContain = /(odpadov[ée]ho\s+hospod[áa]řstv[ií]|obecn[ií]\s+syst[ée]m\s+odpad)/i;
    if (!mustContain.test(t)) {
      // ale: někdy chunk se sazbou neobsahuje "odpadové hospodářství" – tak povolíme, pokud je v textu zároveň PDF_URL s odpadovym hosp.
      const hasWastePdfUrl = /PDF_URL:\s*https?:\/\/[^\n]*odpadoveho-hospodarstvi/i.test(t) || /original=.*odpadoveho-hospodarstvi/i.test(t);
      if (!hasWastePdfUrl) return null;
    }
  }

  // U psů to může být víc verzí (100 Kč staré, 150 Kč nové).
  // Zkusíme nejdřív chytit blok, kde se v okolí objevuje 2025/2026 (novější).
  const blocks = t.split(/={10,}|\n-{3,}\n/g); // hrubé bloky
  const scored = blocks
    .map(b => {
      const mS = b.match(sazbaRe);
      if (!mS) return null;
      const amount = mS[1].replace(/\s+/g, "").replace(/\./g, "");
      const yearScore = /2026/.test(b) ? 3 : /2025/.test(b) ? 2 : /2024/.test(b) ? 1 : 0;
      const modeScore =
        mode === "waste"
          ? (/odpadov/i.test(b) || /odpadov[ée]ho\s+hospod/i.test(b) ? 3 : 0)
          : (/ps[ůu]/i.test(b) || /ze\s+ps/i.test(b) ? 3 : 0);
      return { amount, block: b, score: yearScore + modeScore };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const spl = best.block.match(splatRe);
  const splatnost = spl ? `${spl[1]}${spl[2] ? " " + spl[2] : ""}` : null;

  // Link: preferujeme konkrétní PDF, pak stránku úřední desky
  const url = pickBestUrl(best.block + "\n" + t, mode === "waste"
    ? [
        /original=.*odpadoveho-hospodarstvi/i,
        /obsah521_1\.pdf/i,
        /\/urad\/uredni-deska\/.*odpadoveho-hospodarstvi/i
      ]
    : [
        /original=.*poplatek-ze-psu/i,
        /\/urad\/uredni-deska\/.*poplatku-ze-psu/i
      ]
  );

  return {
    amount: best.amount,
    splatnost,
    url
  };
}

function buildContext(chunks) {
  let ctx = `OFICIÁLNÍ PODKLADY OBCE ${OBEC}\n\n`;
  chunks.forEach((c, i) => {
    ctx += `--- ZDROJ ${i + 1}: ${c.filename} (score ${c.score.toFixed(3)})\n`;
    // omez chunk, ať to není gigant a model se neztratí
    ctx += c.text.slice(0, 3500);
    ctx += "\n\n";
  });
  return ctx;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    if (!apiKey || !vectorStoreId) return jsonResponse(500, { ok: false, error: "Missing env vars" });

    const body = await req.json().catch(() => ({}));
    const rawMessage = body?.message?.trim();
    if (!rawMessage) return jsonResponse(400, { ok: false, error: "Missing message" });

    const debug = rawMessage.toLowerCase().startsWith("#debug");
    const message = rawMessage.replace(/^#debug\s*/i, "").trim();
    const qNorm = normalize(message);

    // 1) search
    const search = await oaiFetch(
      `/vector_stores/${vectorStoreId}/search`,
      {
        query: message,
        max_num_results: 50, // ✅ hard limit
        rewrite_query: true,
      },
      apiKey
    );

    const chunks = extractChunks(search);
    if (!chunks.length) {
      return jsonResponse(200, { ok: true, answer: FALLBACK, thread_id: null, links: [], debug: debug ? { chunks } : undefined });
    }

    const allText = chunks.map(c => c.text).join("\n\n---\n\n");

    // ✅ 2) deterministic path for poplatky (odpad/psi)
    if (looksLikeFeeQuery(qNorm)) {
      if (isWasteFee(qNorm)) {
        const fee = extractFeeFromText(allText, "waste");
        if (fee?.amount) {
          const lines = [];
          lines.push(`Poplatek za obecní systém odpadového hospodářství činí **${fee.amount} Kč** za kalendářní rok.`);
          if (fee.splatnost) lines.push(`Splatnost: nejpozději do **${fee.splatnost}**.`);
          if (fee.url) lines.push(`Zdroj: ${fee.url}`);
          return jsonResponse(200, {
            ok: true,
            answer: lines.join("\n"),
            thread_id: null,
            links: Array.from(new Set([...(fee.url ? [fee.url] : []), ...extractLinks(allText)])).slice(0, 10),
            debug: debug ? { chunks } : undefined
          });
        }
      }

      if (isDogFee(qNorm)) {
        const fee = extractFeeFromText(allText, "dog");
        if (fee?.amount) {
          const lines = [];
          lines.push(`Poplatek ze psů činí **${fee.amount} Kč** za kalendářní rok (za 1 psa).`);
          if (fee.splatnost) lines.push(`Splatnost: nejpozději do **${fee.splatnost}**.`);
          if (fee.url) lines.push(`Zdroj: ${fee.url}`);
          return jsonResponse(200, {
            ok: true,
            answer: lines.join("\n"),
            thread_id: null,
            links: Array.from(new Set([...(fee.url ? [fee.url] : []), ...extractLinks(allText)])).slice(0, 10),
            debug: debug ? { chunks } : undefined
          });
        }
      }
    }

    // 3) model fallback for everything else
    const context = buildContext(chunks);
    const resp = await oaiFetch(
      `/responses`,
      {
        model: "gpt-4.1-mini",
        temperature: 0.1,
        input: [
          {
            role: "system",
            content:
              `Jsi AI asistent obce ${OBEC}. Odpovídej pouze podle poskytnutého kontextu. ` +
              `Nevymýšlej. Pokud údaj není uveden, napiš přesně: "${FALLBACK}". ` +
              `Pokud je v kontextu odkaz (URL), přilož ho.`
          },
          { role: "user", content: `${context}\nDOTAZ:\n${message}` }
        ],
      },
      apiKey
    );

    const answer = (resp?.output_text || "").trim() || FALLBACK;

    const links = Array.from(new Set([
      ...extractLinks(answer),
      ...extractLinks(allText),
    ])).slice(0, 10);

    return jsonResponse(200, {
      ok: true,
      answer,
      thread_id: null,
      links,
      debug: debug ? { chunks } : undefined,
    });

  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}