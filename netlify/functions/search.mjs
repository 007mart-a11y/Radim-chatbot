// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID
// Request JSON: { message: string, thread_id?: string }
// Response JSON: { ok: true, answer: string, thread_id: string } | { ok:false, error, details? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function getCzechTodayString() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    weekday: "long",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  return fmt.format(now);
}

async function api(path, { method = "GET", body, headers = {} } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2",
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }

  return json ?? {};
}

/**
 * ✅ Neber "první assistant zprávu", ale POSLEDNÍ podle created_at.
 */
function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];

  const assistantMsgs = data.filter(
    (m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length
  );

  if (!assistantMsgs.length) return "Bez odpovědi.";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  const parts = msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.length ? parts.join("\n\n") : "Bez odpovědi.";
}

/**
 * Jemné čištění: odstranění citací z File Search.
 */
function stripCitations(text) {
  return String(text || "")
    .replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Guardrails po odpovědi:
 * - pryč meta kecy ("v dokumentech..."), doporučení ("doporučuji/můžete/je možné")
 * - zkrácení (max 5 vět)
 * - pokud dotaz míří na spolek (Sokol/SDH/Zahrádkáři), vyhodí kontakt na obecní úřad,
 *   protože to model často cpe jako "bezpečný fallback".
 *
 * Pozn.: je to schválně jemné, aby to nebylo "debilní" a neničilo validní odpovědi.
 */
function postProcessAnswer(answerRaw, userMessage) {
  let t = String(answerRaw || "").trim();

  // Pryč typické meta-věty / vycpávky
  const bannedPhrases = [
    /v dostupných dokumentech[^.\n]*[.\n]/gi,
    /v dostupných podkladech[^.\n]*[.\n]/gi,
    /bohužel[^.\n]*nenašel[^.\n]*[.\n]/gi,
    /není (přímo )?uveden[^.\n]*[.\n]/gi,
    /doporučuji[^.\n]*[.\n]/gi,
    /můžete[^.\n]*[.\n]/gi,
    /je možné[^.\n]*[.\n]/gi,
    /obecně[^.\n]*bývá[^.\n]*[.\n]/gi,
  ];
  for (const re of bannedPhrases) t = t.replace(re, "");

  // Pokud jde o spolek/organizaci, vyhoď obecní kontakt (telefon/email/úřední hodiny),
  // protože to má být jen u dotazu na úřad.
  const msg = String(userMessage || "").toLowerCase();
  const isOrg =
    msg.includes("sokol") ||
    msg.includes("t j sokol") ||
    msg.includes("tj sokol") ||
    msg.includes("sdh") ||
    msg.includes("hasič") ||
    msg.includes("zahrádk") ||
    msg.includes("spolek");

  if (isOrg) {
    // Odstraň řádky s obecním kontaktem (jemně, jen když jsou evidentně obecní)
    t = t
      .split("\n")
      .filter((line) => {
        const s = line.toLowerCase();
        if (s.includes("urad@obec-radim.cz")) return false;
        if (s.includes("úřední hodiny")) return false;
        if (s.includes("obecní úřad")) return false;
        // obecní telefon z CORE (aby ho to necpe všude)
        if (s.includes("731 409 498") || s.includes("+420 731 409 498")) return false;
        return true;
      })
      .join("\n")
      .trim();
  }

  // Uklidit prázdné řádky
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  // Zkrácení na max 5 vět (počítáme věty po tečce/!/?, ale necháváme odrážky)
  // Když jsou v textu odrážky, necháme je; jen ořízneme celkovou délku.
  const hasBullets = /(^|\n)\s*[-•]\s+/.test(t);
  if (!hasBullets) {
    const sentences = t
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 5) t = sentences.slice(0, 5).join(" ");
  } else {
    // u odrážek: omez na cca 1200 znaků, aby to nevyplnilo celý chat
    if (t.length > 1200) t = t.slice(0, 1200).trim() + "…";
  }

  // Konečné dočištění
  t = t.replace(/[ \t]+\n/g, "\n").trim();

  // Kdyby to náhodou zůstalo prázdné, nech původní (raději něco než nic)
  return t || String(answerRaw || "").trim() || "Bez odpovědi.";
}

/**
 * Heuristika pro “relevance” instrukce:
 * - Pokud dotaz míří na spolek/organizaci, vynutíme odpověď jen kontakty spolku z CORE
 * - Pokud dotaz je na obecní úřad, povolíme obecní kontakt
 */
function buildRelevanceInstructions(userMessage) {
  const msg = String(userMessage || "").toLowerCase();

  const orgSokol =
    msg.includes("sokol") || msg.includes("tj sokol") || msg.includes("t j sokol");
  const orgSdh = msg.includes("sdh") || msg.includes("hasič");
  const orgZahr = msg.includes("zahrádk");

  const askingOffice =
    msg.includes("obecní úřad") ||
    msg.includes("úřad") ||
    msg.includes("urad") ||
    msg.includes("kontakty úřadu") ||
    msg.includes("úřední hodiny") ||
    msg.includes("datová schránka") ||
    msg.includes("ičo") ||
    msg.includes("e-podatelna") ||
    msg.includes("povinné informace");

  // Spolek má přednost před “úřadem” jen pokud dotaz evidentně míří na spolek
  if (orgSokol && !askingOffice) {
    return `
RELEVANCE (povinné):
- Dotaz míří na TJ Sokol Radim.
- Odpověz pouze kontakty a údaji TJ Sokol Radim z 00_CORE (předsedkyně / místopředseda / jednatel / pokladník apod.).
- Neuváděj kontakt na obecní úřad, úřední hodiny, ani e-mail úřadu, pokud se uživatel neptá přímo na úřad.
- Neuváděj žádné rady ani postup; pouze konkrétní kontakty a případně oficiální odkaz, pokud je ve zdrojích.
`;
  }

  if (orgSdh && !askingOffice) {
    return `
RELEVANCE (povinné):
- Dotaz míří na SDH Radim.
- Odpověz pouze kontakty a údaji SDH Radim z 00_CORE.
- Neuváděj kontakt na obecní úřad, úřední hodiny, ani e-mail úřadu, pokud se uživatel neptá přímo na úřad.
`;
  }

  if (orgZahr && !askingOffice) {
    return `
RELEVANCE (povinné):
- Dotaz míří na Zahrádkářský spolek Radim.
- Odpověz pouze údaji o Zahrádkářském spolku z 00_CORE.
- Neuváděj kontakt na obecní úřad, pokud se uživatel neptá přímo na úřad.
`;
  }

  // default: žádné extra
  return "";
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!assistantId) return jsonResponse(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    // Runtime datum (Europe/Prague)
    const todayStr = getCzechTodayString();

    const relevanceBlock = buildRelevanceInstructions(message);

    // Tohle je KLÍČ: tvrdší instrukce, ale pořád “normální” (ne robot).
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague). ` +
      `Časové výrazy ("dnes", "zítra", "příští týden") vykládej vzhledem k tomuto datu.\n\n` +

      `Jsi oficiální AI asistent obce Radim. Odpovídej pouze z oficiálních podkladů ve File Search.\n` +
      `Priorita zdrojů: 1) 00_CORE — OBEC RADIM, 2) 10_LIVE_obec_radim, 3) 01_STATIC_SITE_obec_radim.\n` +
      `Při rozporu vždy platí 00_CORE.\n\n` +

      `STYL:\n` +
      `- piš česky, úředně a stručně\n` +
      `- max 5 vět nebo krátké odrážky\n` +
      `- žádné emoji, žádný marketing\n\n` +

      `ZÁKAZY:\n` +
      `- nepiš metakomentáře typu "v dokumentech jsem nenašel / není uvedeno"\n` +
      `- nepoužívej doporučení ("doporučuji", "můžete", "je možné") ani obecné rady\n` +
      `- pokud se uživatel ptá "jak postupovat", odpověz pouze konkrétními kontakty/odkazy ze zdrojů, bez návodu\n` +
      `- nezmiňuj scraping/crawling/technické detaily ani názvy souborů\n\n` +

      `KONTAKTY:\n` +
      `- kontakt na obecní úřad uváděj jen tehdy, když se dotaz týká obecního úřadu\n` +
      `- u spolků/organizací používej přímé kontakty těchto subjektů z 00_CORE\n\n` +

      (relevanceBlock ? relevanceBlock + "\n" : "") +

      `ODKAZY:\n` +
      `- URL nikdy neukončuj tečkou ani jiným znakem\n` +
      `- LIVE odkazy jsou aktuální; STATIC odkazy označ jako orientační, pokud to dává smysl.\n`;

    // Thread: pokud přijde thread_id, pokračujeme; jinak založíme nový
    let threadId = body?.thread_id;

    if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // 1) User message
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: String(message).trim(),
        }),
      },
      apiKey
    );

    // 2) Run + instructions
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: runInstructions,
        }),
      },
      apiKey
    );

    // 3) Poll run status
    const started = Date.now();
    const timeoutMs = 45_000;

    while (true) {
      if (Date.now() - started > timeoutMs) {
        return jsonResponse(504, { ok: false, error: "Timeout waiting for response" });
      }

      await sleep(900);

      const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
      const status = check.status;

      if (status === "queued" || status === "in_progress") continue;

      if (status === "requires_action") {
        return jsonResponse(501, {
          ok: false,
          error: "Run requires action (tool call not handled in function).",
          status,
        });
      }

      if (status !== "completed") {
        return jsonResponse(500, { ok: false, error: "Run failed", status });
      }

      break;
    }

    // 4) Read messages
    const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);
    answer = stripCitations(answer);
    answer = postProcessAnswer(answer, message);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}