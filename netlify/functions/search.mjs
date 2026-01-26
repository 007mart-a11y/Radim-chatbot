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

// === Site guard (Radim) ===
const CANONICAL_HOST = "www.obec-radim.cz";
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

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
 * - smaže citace typu 
 * - smaže tokeny typu 6:0 (ale NESMAŽE časy typu 16:00)
 * - smaže markdown **
 */
function stripCitations(text) {
  return String(text || "")
    .replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "")
    // smaž jen tokeny typu "6:0" nebo "12:3" (jednociferné za dvojtečkou) – časy 16:00 zůstanou
    .replace(/\b\d{1,3}:\d\b/g, "")
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
 * === URL helpers ===
 * - opraví nejčastější překlepy domény
 * - odstraní trailing tečky/čárky z URL
 * - vyhodí/vrátí jen URL z obec-radim.cz (aby model necucal nesmysly)
 */
function fixCommonUrlTypos(text) {
  let t = String(text || "");

  // nejčastější: chybí tečka před cz
  t = t.replace(/https?:\/\/www\.obec-radimcz\b/gi, CANONICAL_ORIGIN);
  t = t.replace(/https?:\/\/obec-radimcz\b/gi, CANONICAL_ORIGIN);

  // někdy to slepí "radim.cz/urad" bez lomítka apod. – necháváme, tohle je jen doména
  return t;
}

function stripTrailingPunctuationFromUrls(text) {
  return String(text || "").replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");
}

function normalizeRadimUrls(text) {
  // 1) opravy překlepů
  let t = fixCommonUrlTypos(text);

  // 2) odstranit tečky/čárky za url
  t = stripTrailingPunctuationFromUrls(t);

  // 3) zkontrolovat URL a nechat jen bezpečné
  //    (když model vymyslí něco mimo, radši to odstraníme)
  const urlRegex = /\bhttps?:\/\/[^\s)\]]+/gi;
  const found = t.match(urlRegex) || [];

  for (const raw of found) {
    const cleaned = raw.replace(/[)\]]+$/g, ""); // kdyby to končilo závorkou z věty
    let ok = false;

    try {
      const u = new URL(cleaned);
      // povol jen obec-radim.cz (a případně munipolis pro radim, pokud chceš)
      ok = u.host === CANONICAL_HOST;
    } catch {
      ok = false;
    }

    if (!ok) {
      // vyhoď jen tu URL, nic dalšího
      t = t.replace(raw, "").replace(/\n{3,}/g, "\n\n");
    }
  }

  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

  // základní whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // Meta věty – jen nejhorší, a jen když NEobsahují URL
  const metaRegexes = [
    /(^|\n)\s*(v dostupných (dokumentech|podkladech)[^.\n]*[.\n])/gi,
    /(^|\n)\s*(v oficiálních (dokumentech|podkladech)[^.\n]*[.\n])/gi,
    /(^|\n)\s*(bohužel[^.\n]*nenašel[^.\n]*[.\n])/gi,
  ];

  for (const re of metaRegexes) {
    t = t.replace(re, (m) => (m.includes("http") ? m : "\n"));
  }

  // Oprav "nedopsané číslování" na konci (typ: "2." bez obsahu)
  t = t.replace(/\n?\s*\d+\.\s*$/g, "").trim();

  // URL: opravy překlepů + validace domény + odstranění teček
  t = normalizeRadimUrls(t);

  const listMode = isListRequest(userMessage);

  // Limit 5 vět jen když to není seznam a nejsou odrážky
  const hasBullets = /(^|\n)\s*([-•]|\d+\.)\s+/.test(t);

  if (!listMode && !hasBullets) {
    const sentences = t
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 5) t = sentences.slice(0, 5).join(" ");
  }

  // Soft hard-limit
  const HARD_LIMIT = 9000;
  if (t.length > HARD_LIMIT) {
    t = t.slice(0, HARD_LIMIT).trim();
    t = t.replace(/\n[^\n]*$/g, "").trim() + "\n…";
  }

  return t || String(answerRaw || "").trim() || "Bez odpovědi.";
}

export default async function handler(req) {
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

    const todayStr = getCzechTodayString();
    const listMode = isListRequest(message);

    // Instrukce: co nejvíc “profi úřad” + povinné odkazy + kontext
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague). ` +
      `Časové výrazy ("dnes", "zítra", "příští týden", "minulý měsíc") vykládej vzhledem k tomuto datu.\n\n` +

      `Jsi oficiální AI asistent obce Radim a odpovídáš jako pracovník obecního úřadu.\n` +
      `Smíš používat pouze informace z jediného oficiálního dokumentu ve znalostní bázi (99_FULL_obec_radim.txt).\n` +
      `Nic nedoplňuj z domněnek. Neimprovizuj.\n\n` +

      `KONTEXT (kritické):\n` +
      `- Navazující dotazy ("a ten", "který", "nejnovější", "pošli odkaz") vždy vyhodnocuj v kontextu předchozí otázky v tomto vlákně.\n` +
      `- "Nejnovější" posuzuj vždy v rámci tématu (úřední deska / vyhlášky / zpravodaj / zápisy), ne jako obecnou novinku na webu.\n\n` +

      `ODKAZY (kritické):\n` +
      `- Pokud se dotaz týká dokumentu, vyhlášky, zápisu, zasedání, formuláře, zpravodaje, územního plánu, oznámení, úřední desky nebo informace "na webu", vždy uveď PŘÍMÝ ODKAZ na konkrétní stránku nebo soubor.\n` +
      `- Odkaz uveď i tehdy, když o něj uživatel výslovně nepožádá.\n` +
      `- URL kopíruj přesně ze zdrojů, nikdy je nepřepisuj ručně.\n` +
      `- URL nikdy neukončuj tečkou ani čárkou.\n\n` +

      `AKTUÁLNOST:\n` +
      `- Vždy preferuj nejnovější platnou zmínku k tématu v rámci dokumentu.\n` +
      `- Starší informace uváděj jen pokud novější neexistuje.\n` +
      `- Historii uváděj pouze pokud se uživatel výslovně ptá na minulost.\n` +
      `- Pokud odpověď vychází z časově omezené informace, uveď datum/období.\n\n` +

      `DOTAZY "JAK…":\n` +
      `- Pokud se uživatel ptá "jak se přihlásit/jak postupovat/co mám udělat", odpověz pouze kontaktními údaji a/nebo oficiálním odkazem z dokumentu. Bez návodu.\n\n` +

      `NEJASNÝ DOTAZ:\n` +
      `- Pokud dotaz nedává smysl nebo vypadá jako překlep, polož jednu krátkou upřesňující otázku.\n\n` +

      `STYL:\n` +
      `- Česky, úředně, věcně.\n` +
      (listMode
        ? `- Uživatel žádá výpis/seznam: napiš přehledný seznam všech relevantních položek; každá položka musí mít název + datum/období (pokud je) + přímý odkaz (pokud je).\n`
        : `- Maximálně 5 vět, případně krátké odrážky.\n`) +
      `- Žádné emoji, žádný marketing.\n\n` +

      `POKUD INFORMACE CHYBÍ:\n` +
      `- Řekni to jednou stručně bez metakomentářů.\n\n` +

      `ZÁKAZY:\n` +
      `- Neuváděj technické detaily (AI, systém, databáze, scraping).\n` +
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

    // Když by to i tak bylo prázdné:
    if (!answer) {
      answer = "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";
    }

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}