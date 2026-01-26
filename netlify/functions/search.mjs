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
 * Čištění citací a "bordelu" z File Search.
 * - smaže:  apod.
 * - smaže tokeny jako 6:0 (ale NESMAŽE časy typu 16:00)
 */
function stripCitations(text) {
  return String(text || "")
    // typické file_search citace
    .replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "")
    // někdy se objeví samotné tokeny typu 6:0 (jednociferné za dvojtečkou)
    .replace(/\b\d+:\d\b/g, "")
    // markdown ** (často zbytečné v úředním tónu)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isListRequest(userMessage) {
  const m = String(userMessage || "").toLowerCase();
  return (
    m.includes("vypiš") ||
    m.includes("vypsat") ||
    m.includes("všechny") ||
    m.includes("seznam") ||
    m.includes("výčet") ||
    m.includes("co je vyvěšeno") ||
    m.includes("co je na úřední desce") ||
    m.includes("co je na uredni desce") ||
    m.includes("jaké dokumenty") ||
    m.includes("jake dokumenty") ||
    m.includes("jaké vyhlášky") ||
    m.includes("jake vyhlasky") ||
    m.includes("jaké akce") ||
    m.includes("jake akce")
  );
}

/**
 * Jemný postprocess:
 * - neničí seznamy
 * - nemaže URL a řádky s názvem/datem
 * - odstraní jen opravdu typické "meta kecy"
 * - u běžných odpovědí podrží max 5 vět, ale u výpisů NE
 */
function postProcessAnswer(answerRaw, userMessage) {
  let t = String(answerRaw || "").trim();

  // Základní úklid whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // Meta věty – jen nejhorší, a jen když NEobsahují URL (abychom neodstřelili odkaz)
  const metaRegexes = [
    /(^|\n)\s*(v dostupných (dokumentech|podkladech)[^.\n]*[.\n])/gi,
    /(^|\n)\s*(v oficiálních (dokumentech|podkladech)[^.\n]*[.\n])/gi,
    /(^|\n)\s*(bohužel[^.\n]*nenašel[^.\n]*[.\n])/gi,
  ];

  for (const re of metaRegexes) {
    t = t.replace(re, (m) => (m.includes("http") ? m : "\n"));
  }

  // Nikdy neukončuj URL tečkou/čárkou
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");

  // Oprav "nedopsané číslování" na konci (typ: "2." bez obsahu)
  //  - odstraní trailing řádek typu "2." nebo "2. " apod.
  t = t.replace(/\n?\s*\d+\.\s*$/g, "").trim();

  // Pokud je to výpis / seznam, NEomezuj na 5 vět.
  const listMode = isListRequest(userMessage);

  // U běžných odpovědí: max 5 vět (ale necháme odrážky)
  const hasBullets = /(^|\n)\s*([-•]|\d+\.)\s+/.test(t);

  if (!listMode && !hasBullets) {
    const sentences = t
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length > 5) t = sentences.slice(0, 5).join(" ");
  }

  // Soft limit, aby se to nerozjelo na 50k znaků (ale nechá to dlouhé výpisy)
  const HARD_LIMIT = 9000;
  if (t.length > HARD_LIMIT) {
    t = t.slice(0, HARD_LIMIT).trim();
    // dočistit případný rozseknutý poslední řádek
    t = t.replace(/\n[^\n]*$/g, "").trim() + "\n…";
  }

  // Kdyby to zůstalo prázdné, vrať původní
  return t || String(answerRaw || "").trim() || "Bez odpovědi.";
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
    const listMode = isListRequest(message);

    // ✅ One-file režim + kontext + odkazy + výjimka pro výpisy
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague). ` +
      `Časové výrazy ("dnes", "zítra", "příští týden", "minulý měsíc") vykládej vzhledem k tomuto datu.\n\n` +

      `Jsi oficiální AI asistent obce Radim a odpovídáš jako pracovník obecního úřadu.\n` +
      `Smíš používat pouze informace z oficiálního dokumentu ve znalostní bázi, který odpovídá FULL obsahu webu obce (99_FULL_obec_radim.txt).\n` +
      `Nic nedoplňuj z domněnek. Neimprovizuj.\n\n` +

      `KONTEXT (kritické):\n` +
      `- Navazující dotazy ("a ten", "který", "nejnovější", "pošli odkaz") vždy vyhodnocuj v kontextu předchozí otázky v tomto vlákně.\n` +
      `- "Nejnovější" posuzuj vždy v rámci tématu, o kterém se právě mluví (např. úřední deska / vyhlášky / zpravodaj / zápisy), ne jako obecnou novinku na webu.\n\n` +

      `ODKAZY (kritické):\n` +
      `- Pokud se dotaz týká dokumentu, vyhlášky, zápisu, zasedání, formuláře, zpravodaje, územního plánu, oznámení, úřední desky nebo jakékoli informace "na webu", vždy se pokus dohledat a uvést PŘÍMÝ ODKAZ na konkrétní stránku nebo soubor.\n` +
      `- Přímý odkaz uveď i tehdy, pokud o něj uživatel výslovně nepožádá.\n` +
      `- Pokud existuje více odkazů, uveď pouze nejrelevantnější/nejaktuálnější.\n` +
      `- URL nikdy neukončuj tečkou ani čárkou.\n\n` +

      `AKTUÁLNOST:\n` +
      `- Vždy preferuj nejnovější platnou zmínku k tématu v rámci dokumentu.\n` +
      `- Starší informace uváděj jen pokud novější neexistuje.\n` +
      `- Historii uváděj pouze pokud se uživatel výslovně ptá na minulost.\n` +
      `- Pokud odpověď vychází z časově omezené informace, uveď datum/období.\n\n` +

      `DOTAZY "JAK…":\n` +
      `- Pokud se uživatel ptá "jak se přihlásit/jak postupovat/co mám udělat", odpověz pouze dostupnými kontaktními údaji a/nebo oficiálním odkazem z dokumentu. Bez návodu.\n\n` +

      `NEJASNÝ DOTAZ:\n` +
      `- Pokud dotaz nedává smysl nebo vypadá jako překlep, polož jednu krátkou upřesňující otázku.\n\n` +

      `STYL:\n` +
      `- Česky, úředně, věcně.\n` +
      (listMode
        ? `- Uživatel žádá výpis/seznam: napiš přehledný seznam všech relevantních položek; každá položka musí mít název + datum/období (pokud je) + přímý odkaz (pokud je).\n`
        : `- Maximálně 5 vět, případně krátké odrážky.\n`) +
      `- Žádné emoji, žádný marketing.\n\n` +

      `ZÁKAZY:\n` +
      `- Neuváděj technické detaily (AI, systém, databáze, scraping).\n` +
      `- Nepsat metakomenty typu "v dokumentech jsem nenašel". Pokud informace chybí, řekni to jednou stručně.\n` +
      `- Nepoužívej doporučení ("doporučuji", "můžete", "je možné").\n`;

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
    const timeoutMs = 60_000;

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

    // Pokud i po tom všem zůstane prázdno:
    if (!answer) answer = "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}