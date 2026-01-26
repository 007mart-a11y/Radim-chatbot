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

// Canonical web
const CANONICAL_ORIGIN = "https://www.obec-radim.cz";

// Optional allowed extra origins (munipolis for Radim) — pokud nechceš, smaž řádek.
const ALLOWED_EXTRA_ORIGINS = new Set(["https://obec-radim.munipolis.cz"]);

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
 * Vezme poslední assistant zprávu podle created_at.
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
 * Dotazy na seznam / výpis (u nich nepoužívat limit 5 vět).
 */
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
    m.includes("jake akce") ||
    m.includes("vypiš vše") ||
    m.includes("vypsat vše")
  );
}

/**
 * Relevance guard: spolek vs úřad.
 * Cíl: u sokola/SDH apod. necpat úřad jako kontakt, pokud existuje přímý kontakt organizace.
 */
function buildRelevanceBlock(userMessage) {
  const msg = String(userMessage || "").toLowerCase();

  const isSokol = msg.includes("sokol");
  const isSdh = msg.includes("sdh") || msg.includes("hasič") || msg.includes("hasic");
  const isZahr = msg.includes("zahrádk") || msg.includes("zahradk");
  const isOrg = isSokol || isSdh || isZahr || msg.includes("spolek");

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

  if (isOrg && !askingOffice) {
    return (
      `RELEVANCE (kritické):\n` +
      `- Dotaz míří na organizaci/spolek (např. TJ Sokol / SDH / Zahrádkáři), nikoli na obecní úřad.\n` +
      `- Pokud existuje přímý kontakt organizace ve zdroji, uveď pouze tento přímý kontakt.\n` +
      `- Neuváděj starostku ani kontakty obecního úřadu jako "fallback", pokud přímý kontakt organizace existuje.\n`
    );
  }

  return "";
}

/**
 * URL helpers
 */
function fixCommonUrlTypos(text) {
  let t = String(text || "");
  // časté: chybí tečka před cz
  t = t.replace(/https?:\/\/(www\.)?obec-radimcz\b/gi, CANONICAL_ORIGIN);
  return t;
}

function toAbsoluteRadimUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return CANONICAL_ORIGIN + s;
  return null;
}

function stripTrailingPunctuationFromUrls(text) {
  return String(text || "").replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");
}

function normalizeUrlsInText(text) {
  let t = fixCommonUrlTypos(text);
  t = stripTrailingPunctuationFromUrls(t);

  // převod relativních odkazů "/urad/..." na plné URL (jen Radim)
  // Pozor: nechceme rozbít běžný text s lomítky, tak jen ty, co vypadají jako URL cesta.
  t = t.replace(
    /(^|\s)(\/(urad|aktualne|obec|seniori|organizace-a-spolky|uredni-deska|kalendar-akci|e_download\.php)[^\s)\]]*)/gi,
    (m, pre, path) => `${pre}${CANONICAL_ORIGIN}${path}`
  );

  // bezpečnost: vyhoď jen úplně nesmyslné URL, ale NEodstraňuj radim + munipolis
  const urlRegex = /\bhttps?:\/\/[^\s)\]]+/gi;
  const found = t.match(urlRegex) || [];

  for (const raw of found) {
    const cleaned = raw.replace(/[)\]]+$/g, "");
    let ok = false;
    try {
      const u = new URL(cleaned);
      ok = u.origin === CANONICAL_ORIGIN || ALLOWED_EXTRA_ORIGINS.has(u.origin);
    } catch {
      ok = false;
    }
    if (!ok) {
      // smaž jen ten token
      t = t.replace(raw, "");
    }
  }

  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Čištění citací z File Search + šetrné úpravy bez ničení URL.
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // odstranit file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // opatrně odstranit tokeny typu "6:0" / "12:3" (jednociferné za dvojtečkou)
  // (nechává časy typu 16:00)
  t = t.replace(/\b\d{1,3}:\d\b/g, "");

  // markdown bold
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");

  // prázdné markdown odkazy [text]()
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // pryč řádky "Odkaz:" bez URL
  t = t.replace(/^\s*Odkaz:\s*$/gim, "");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // normalizace URL (typo + relativní -> absolutní)
  t = normalizeUrlsInText(t);

  return t.trim();
}

/**
 * Limit 5 vět – ALE NIKDY nesmí odstranit odkazy.
 * Strategie:
 * - pokud v odpovědi jsou URL, vytáhneme je, zkrátíme text bez URL, a URL přidáme nakonec.
 */
function limitTo5SentencesPreserveLinks(answer, userMessage) {
  const listMode = isListRequest(userMessage);
  const hasBullets = /(^|\n)\s*([-•]|\d+\.)\s+/.test(answer);

  if (listMode || hasBullets) return answer;

  // najdi URL
  const urlRegex = /\bhttps?:\/\/[^\s)\]]+/gi;
  const urls = Array.from(new Set(answer.match(urlRegex) || []));

  // text bez URL (abychom nerezali uprostřed linku)
  let textNoUrls = answer.replace(urlRegex, "").replace(/\s{2,}/g, " ").trim();

  const sentences = textNoUrls
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let shortened = textNoUrls;
  if (sentences.length > 5) shortened = sentences.slice(0, 5).join(" ");

  // pokud byly URL, přidej je na konec
  if (urls.length) {
    const linksBlock = urls.map((u) => u.replace(/[)\].,]+$/g, "")).join("\n");
    // když je text prázdný, vrať jen linky
    if (!shortened) return linksBlock;
    return `${shortened}\n\n${linksBlock}`.trim();
  }

  return shortened || answer;
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

    // ✅ ZÁSADNÍ: jednoduché instrukce, ale tvrdé na "fakta jen s odkazem"
    // (bez pobízení k opakování staré odpovědi z chatu jako faktu)
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague).\n\n` +
      `Jsi oficiální AI asistent obce Radim a odpovídáš jako pracovník obecního úřadu.\n` +
      `Používej výhradně informace z jediného zdroje: 99_FULL_obec_radim.txt. Neimprovizuj.\n\n` +

      `KONTEXT:\n` +
      `- Navazující dotazy vyhodnocuj v kontextu předchozích zpráv v tomto vlákně.\n` +
      `- "Nejnovější" vždy vztahuj k právě řešenému tématu.\n\n` +

      `PRAVIDLO PRO FAKTA (kritické):\n` +
      `- Pokud uvádíš konkrétní jméno osoby, telefon, e-mail, datum dokumentu nebo konkrétní dokument, vždy přidej 1 přímý odkaz na stránku/soubor, kde je to uvedeno.\n` +
      `- Pokud odkaz ve zdroji nenajdeš, nepřidávej domněnky a použij přesně větu:\n` +
      `"Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim."\n\n` +

      `ODKAZY:\n` +
      `- Pokud je k tématu dostupný přímý odkaz, uveď jej.\n` +
      `- URL kopíruj přesně ze zdrojů. Neukončuj URL tečkou ani čárkou.\n\n` +

      `VÝKLAD DOTAZŮ:\n` +
      `- "kdo vede" / "vedení" organizace = předseda/předsedkyně a členové výboru (pokud jsou ve zdroji).\n` +
      `- U organizací vždy preferuj přímý kontakt organizace, pokud existuje.\n\n` +

      `STYL:\n` +
      `- Úředně a věcně. Bez pozdravů a bez upozornění typu "ověřte si to".\n` +
      (listMode
        ? `- Uživatel chce výpis/seznam: napiš přehledný seznam všech relevantních položek (název + datum/období + přímý odkaz, pokud existuje).\n`
        : `- Max 5 vět, případně krátké odrážky.\n`) +
      `\n` +

      (relevanceBlock ? relevanceBlock + "\n" : "") +

      `ZÁKAZY:\n` +
      `- Neuváděj technické detaily (AI, scraping, databáze).\n` +
      `- Nepoužívej doporučení ("doporučuji", "můžete", "je možné").\n`;

    // Thread
    let threadId = body?.thread_id;
    if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // 1) user message
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: String(message).trim() }),
      },
      apiKey
    );

    // 2) run — nízká teplota = méně halucinací
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: runInstructions,
          temperature: 0.1,
          top_p: 1,
        }),
      },
      apiKey
    );

    // 3) poll
    const started = Date.now();
    const timeoutMs = 45_000;

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

    // 4) read messages
    const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);

    // clean without destroying links
    answer = cleanAnswer(answer);

    // limit without cutting links
    answer = limitTo5SentencesPreserveLinks(answer, message);

    // fallback
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