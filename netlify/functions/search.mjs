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
 * ✅ Vezmi poslední assistant zprávu podle created_at.
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
 * Čištění citací z File Search + drobné úpravy.
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // tokeny typu 6:0 (ale ne časy 16:00)
  t = t.replace(/\b\d{1,3}:\d\b/g, "");

  // markdown **bold**
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");

  // oprava překlepů domény
  t = t.replace(/https?:\/\/(www\.)?obec-radimcz\b/gi, "https://www.obec-radim.cz");

  // odstranit tečku/čárku za URL
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");

  // zrušit prázdné markdown odkazy: [text]()
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // odstranit řádky typu "Odkaz:" bez URL
  t = t.replace(/^\s*Odkaz:\s*$/gim, "");
  t = t.replace(/^\s*Odkaz:\s*(Odkaz na tuto informaci není[^]*?)$/gim, "");

  // odstranit "Více informací je k dispozici..." pokud není URL v okolí (často to generuje blbě)
  // (necháme to, jen když se v tom řádku vyskytuje http)
  t = t
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      const lower = s.toLowerCase();
      const looksLikeFiller =
        lower.startsWith("více informací je k dispozici") ||
        lower.startsWith("více informací najdete") ||
        lower.startsWith("podrobnosti jsou k dispozici");
      if (looksLikeFiller && !s.includes("http")) return false;
      return true;
    })
    .join("\n");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t.trim();
}

/**
 * Výpisy: u nich nepoužívej limit 5 vět.
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
    m.includes("jake akce")
  );
}

/**
 * Relevance guard: spolek vs úřad (silnější, jasnější).
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
      `- Dotaz míří na spolek/organizaci, nikoli na obecní úřad.\n` +
      `- Neuváděj starostku ani kontakty obecního úřadu.\n` +
      `- Pokud uživatel chce kontakt, uveď pouze kontakty dané organizace nalezené ve zdrojích.\n`
    );
  }

  return "";
}

function limitTo5SentencesIfNeeded(answer, userMessage) {
  const listMode = isListRequest(userMessage);
  const hasBullets = /(^|\n)\s*([-•]|\d+\.)\s+/.test(answer);

  if (listMode || hasBullets) return answer;

  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length > 5) return sentences.slice(0, 5).join(" ");
  return answer;
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
    const relevanceBlock = buildRelevanceBlock(message);

    // ✅ Tady je hlavní oprava: synonyma ("vede" = předseda) + osoba napříč výskyty + odkazy bez bullshit labelů.
    const runInstructions =
      `Dnes je ${todayStr} (časová zóna: Europe/Prague).\n\n` +
      `Jsi oficiální AI asistent obce Radim a odpovídáš jako pracovník obecního úřadu.\n` +
      `Používej výhradně informace z jediného zdroje: 99_FULL_obec_radim.txt.\n` +
      `Neimprovizuj.\n\n` +

      `KONTEXT:\n` +
      `- Navazující dotazy vyhodnocuj v kontextu předchozích zpráv v tomto vlákně.\n` +
      `- "Nejnovější" vždy vztahuj k právě řešenému tématu.\n\n` +

      `INTELIGENCE (kritické):\n` +
      `- Pokud se uživatel ptá "kdo vede" / "kdo je ve vedení" organizace, považuj to za dotaz na předsedu/předsedkyni a výbor (vedení).\n` +
      `- Pokud už znáš předsedu/předsedkyni z dřívější odpovědi v tomto vlákně, použij to a přidej případně další členy vedení, pokud jsou ve zdrojích.\n` +
      `- Pokud se uživatel ptá na telefon/e-mail osoby, projdi všechny relevantní výskyty této osoby ve zdrojích (může být ve více rolích).\n` +
      `- Pokud se osoba vyskytuje ve více rolích a kontakty se liší, polož 1 krátkou upřesňující otázku (např. "Myslíte ji ve spojení s TJ Sokol, nebo s obecním výborem?").\n` +
      `- Nikdy netvrď "kontakt není uveden", pokud je u některého výskytu osoby kontakt uveden.\n\n` +

      `ODKAZY:\n` +
      `- Pokud je ve zdrojích přímý odkaz na stránku nebo soubor k tématu, uveď jej.\n` +
      `- URL kopíruj přesně ze zdrojů.\n` +
      `- Nepiš "Odkaz:" pokud za tím nebude skutečná URL.\n\n` +

      `STYL:\n` +
      `- Úředně, věcně, bez pozdravů a bez upozornění typu "ověřte si to".\n` +
      `- Max 5 vět, případně krátké odrážky. U výpisů/seznamů může být delší seznam.\n\n` +
      (relevanceBlock ? relevanceBlock + "\n" : "") +

      `POKUD INFORMACE CHYBÍ:\n` +
      `- Řekni přesně jen tuto větu a nic dalšího:\n` +
      `"Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim."\n\n` +

      `ZÁKAZY:\n` +
      `- Neuváděj technické detaily. Nepoužívej doporučení ("doporučuji", "můžete", "je možné").\n`;

    // Thread
    let threadId = body?.thread_id;
    if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // 1) user msg
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: String(message).trim() }),
      },
      apiKey
    );

    // 2) run (stabilnější = méně náhodné blbosti)
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: runInstructions,
          temperature: 0.2,
          top_p: 1,
        }),
      },
      apiKey
    );

    // 3) poll (rychle)
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

    answer = cleanAnswer(answer);
    answer = limitTo5SentencesIfNeeded(answer, message);

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