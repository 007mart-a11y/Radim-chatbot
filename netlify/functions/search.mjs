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
const ALT_HOST = "obec-radim.cz";
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

// Povolené domény pro odkazy (aby model necucal nesmysly)
const ALLOWED_HOSTS = new Set([
  CANONICAL_HOST,
  ALT_HOST,
  "obec-radim.munipolis.cz",
]);

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
 * Heuristika: kdy vyžadujeme odkaz (i když uživatel nenapíše "odkaz")
 */
function linkRequired(userMessage, answerText = "") {
  const m = String(userMessage || "").toLowerCase();
  const a = String(answerText || "").toLowerCase();

  const keywords = [
    "odkaz",
    "link",
    "na webu",
    "web",
    "úřední des",
    "uredni des",
    "vyhlášk",
    "vyhlask",
    "zápis",
    "usnesen",
    "zasedán",
    "zasedan",
    "formul",
    "zpravodaj",
    "územní plán",
    "uzemni plan",
    "czech point",
    "e-podatelna",
    "podatelna",
    "munipolis",
    "kontakt",
    "kontakty",
    "úřední hodiny",
    "uredni hodiny",
    "sokol",
    "sdh",
    "hasič",
    "hasiči",
    "spolek",
  ];

  // Když odpověď obsahuje kontakty, chceme taky zdrojovou stránku
  const looksLikeContacts =
    a.includes("telefon") || a.includes("e-mail") || a.includes("datová schránka") || a.includes("datova schranka");

  return keywords.some((k) => m.includes(k)) || looksLikeContacts;
}

/**
 * === ORG/ÚŘAD relevance ===
 * U spolků zabráníme cpaní kontaktu na úřad/starostku, pokud se uživatel neptá na úřad.
 */
function buildRelevanceBlock(userMessage) {
  const msg = String(userMessage || "").toLowerCase();

  const isSokol = msg.includes("sokol") || msg.includes("tj sokol") || msg.includes("t j sokol");
  const isSDH = msg.includes("sdh") || msg.includes("hasič") || msg.includes("hasic");
  const isOtherOrg = msg.includes("spolek") || msg.includes("zahrádk") || msg.includes("zahradk");

  const askingOffice =
    msg.includes("obecní úřad") ||
    msg.includes("obecni urad") ||
    msg.includes("úřad") ||
    msg.includes("urad") ||
    msg.includes("úřední hodiny") ||
    msg.includes("uredni hodiny") ||
    msg.includes("datová schránka") ||
    msg.includes("datova schranka") ||
    msg.includes("e-podatelna") ||
    msg.includes("podatelna") ||
    msg.includes("czech point");

  // Spolek dotaz má přednost – pokud to není dotaz na úřad
  if ((isSokol || isSDH || isOtherOrg) && !askingOffice) {
    return (
      `RELEVANCE (kritické):\n` +
      `- Dotaz míří na spolek/organizaci, nikoli na obecní úřad.\n` +
      `- Neuváděj kontakt na obecní úřad ani starostku, pokud se uživatel neptá přímo na úřad.\n` +
      `- Uveď pouze přímé kontakty na daný spolek/organizaci a relevantní oficiální odkaz.\n`
    );
  }

  return "";
}

/**
 * === URL helpers ===
 * - opraví nejčastější překlepy domény (obec-radimcz -> obec-radim.cz)
 * - povolí obec-radim.cz i www.obec-radim.cz + munipolis
 * - odstraní trailing tečky/čárky z URL
 * - normalizuje ALT_HOST -> CANONICAL_HOST
 */
function stripTrailingPunctuationFromUrls(text) {
  return String(text || "").replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");
}

function repairHostTypos(urlStr) {
  let s = String(urlStr || "");

  // obec-radimcz -> obec-radim.cz
  s = s.replace(/https?:\/\/(www\.)?obec-radimcz\b/gi, "https://www.obec-radim.cz");

  // slepené "obec-radim.czurad" -> "obec-radim.cz/urad"
  s = s.replace(/https?:\/\/(www\.)?obec-radim\.cz(?=[a-z])/gi, (m0) => `${m0}/`);

  // občas bez www, necháme projít, ale později zkanonizujeme
  return s;
}

function normalizeOneUrlToken(token) {
  let t = stripTrailingPunctuationFromUrls(repairHostTypos(token)).replace(/[)\]]+$/g, "");

  // Pokud chybí scheme, nedoženu to – radši nechat být (model má dávat https)
  if (!/^https?:\/\//i.test(t)) return null;

  try {
    const u = new URL(t);
    if (!ALLOWED_HOSTS.has(u.host)) return null;

    // zkanonizuj obec-radim.cz -> www.obec-radim.cz
    if (u.host === ALT_HOST) {
      u.host = CANONICAL_HOST;
      return u.toString();
    }

    return u.toString();
  } catch {
    return null;
  }
}

function normalizeAllowedUrlsInText(text) {
  let out = repairHostTypos(stripTrailingPunctuationFromUrls(String(text || "")));

  const urlRegex = /\bhttps?:\/\/[^\s)\]]+/gi;
  const found = out.match(urlRegex) || [];

  for (const raw of found) {
    const normalized = normalizeOneUrlToken(raw);
    if (!normalized) {
      // remove only the URL token
      out = out.replace(raw, "").replace(/\n{3,}/g, "\n\n");
    } else if (normalized !== raw) {
      out = out.replace(raw, normalized);
    }
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Jemný postprocess:
 * - neničí seznamy
 * - nemaže URL a řádky s názvem/datem
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
  t = normalizeAllowedUrlsInText(t);

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

  // Hard-limit
  const HARD_LIMIT = 9000;
  if (t.length > HARD_LIMIT) {
    t = t.slice(0, HARD_LIMIT).trim();
    t = t.replace(/\n[^\n]*$/g, "").trim() + "\n…";
  }

  return t || String(answerRaw || "").trim() || "Bez odpovědi.";
}

function extractFirstUrl(text) {
  const t = String(text || "");
  const m = t.match(/\bhttps?:\/\/[^\s)\]]+/i);
  if (!m) return "";
  const normalized = normalizeOneUrlToken(m[0]);
  return normalized || "";
}

/**
 * 2-pass doplnění odkazu, když chybí.
 * - Vynutí 1 URL, nebo přesnou fallback větu.
 */
async function ensureLinkIfNeeded({ apiKey, assistantId, threadId, userMessage, answerText }) {
  if (!linkRequired(userMessage, answerText)) return answerText;

  // když už URL je, jen normalizuj
  const existingUrl = extractFirstUrl(answerText);
  if (existingUrl) {
    // zajisti, že URL není ukončená tečkou/čárkou a je canonical
    const normalized = normalizeAllowedUrlsInText(answerText);
    return normalized;
  }

  // 2nd pass: požádej o URL / nebo přesnou větu
  const followupInstruction =
    `Doplň k předchozí odpovědi POUZE jeden nejrelevantnější přímý odkaz (URL) z oficiálních podkladů. ` +
    `Pokud v podkladech žádný přímý odkaz není, napiš přesně tuto větu:\n` +
    `"Odkaz na tuto informaci není v oficiálních podkladech uveden."\n` +
    `Nepsat nic dalšího.`;

  // přidej user zprávu (interní) do threadu
  await api(
    `/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        content: followupInstruction,
      }),
    },
    apiKey
  );

  // spusť run (kratší timeout)
  const run2 = await api(
    `/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        instructions:
          `Odpovídej jako pracovník obecního úřadu. Použij pouze informace z 99_FULL_obec_radim.txt. ` +
          `Vrať pouze jednu URL nebo přesnou fallback větu. URL kopíruj přesně ze zdrojů.`,
      }),
    },
    apiKey
  );

  const started = Date.now();
  const timeoutMs = 25_000;

  while (true) {
    if (Date.now() - started > timeoutMs) break;
    await sleep(650);

    const check = await api(`/threads/${threadId}/runs/${run2.id}`, {}, apiKey);
    const status = check.status;
    if (status === "queued" || status === "in_progress") continue;
    if (status !== "completed") break;
    break;
  }

  const messages2 = await api(`/threads/${threadId}/messages?limit=20`, {}, apiKey);
  let tail = extractLatestAssistantText(messages2);
  tail = stripCitations(tail);
  tail = postProcessAnswer(tail, userMessage);

  const url = extractFirstUrl(tail);
  if (url) {
    // připoj URL na konec odpovědi jako "Odkaz: ..."
    return `${answerText}\n\nOdkaz: ${url}`.trim();
  }

  const fallback = `Odkaz na tuto informaci není v oficiálních podkladech uveden.`;
  if (tail.trim() === fallback) {
    return `${answerText}\n\nOdkaz: ${fallback}`.trim();
  }

  // když to selže, aspoň dáme fallback (bez vymýšlení)
  return `${answerText}\n\nOdkaz: ${fallback}`.trim();
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
    const relevanceBlock = buildRelevanceBlock(message);

    // Instrukce: profi úřad + kontext + odkazy + výpisy
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague). ` +
      `Časové výrazy ("dnes", "zítra", "příští týden", "minulý měsíc") vykládej vzhledem k tomuto datu.\n\n` +

      `Jsi oficiální AI asistent obce Radim a odpovídáš jako pracovník obecního úřadu.\n` +
      `Smíš používat pouze informace z jediného oficiálního dokumentu ve znalostní bázi (99_FULL_obec_radim.txt).\n` +
      `Nic nedoplňuj z domněnek. Neimprovizuj.\n\n` +

      (relevanceBlock ? `${relevanceBlock}\n` : "") +

      `KONTEXT (kritické):\n` +
      `- Navazující dotazy ("a ten", "který", "nejnovější", "pošli odkaz") vždy vyhodnocuj v kontextu předchozí otázky v tomto vlákně.\n` +
      `- "Nejnovější" posuzuj vždy v rámci tématu (úřední deska / vyhlášky / zpravodaj / zápisy), ne jako obecnou novinku na webu.\n\n` +

      `ODKAZY (kritické):\n` +
      `- Pokud odpovídáš na informaci z webu nebo dokumentu, vždy uveď přímý odkaz na konkrétní stránku nebo soubor.\n` +
      `- Pokud odpovídáš kontakty (telefon/e-mail/hodiny), uveď také odkaz na stránku, kde jsou tyto kontakty uvedeny.\n` +
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
        ? `- Uživatel žádá výpis/seznam: napiš přehledný seznam všech relevantních položek; každá položka má název + datum/období (pokud je) + přímý odkaz (pokud je).\n`
        : `- Maximálně 5 vět, případně krátké odrážky.\n`) +
      `- Žádné emoji, žádný marketing.\n\n` +

      `POKUD INFORMACE CHYBÍ:\n` +
      `- Použij přesně: "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim."\n\n` +

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

    // 3) Poll run status (trochu rychlejší)
    const started = Date.now();
    const timeoutMs = 55_000;

    while (true) {
      if (Date.now() - started > timeoutMs) {
        return jsonResponse(504, { ok: false, error: "Timeout waiting for response" });
      }

      await sleep(650);

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

    if (!answer) {
      answer = "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";
    }

    // 5) 2-pass doplnění odkazu (pokud je potřeba a chybí)
    answer = await ensureLinkIfNeeded({
      apiKey,
      assistantId,
      threadId,
      userMessage: message,
      answerText: answer,
    });

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}