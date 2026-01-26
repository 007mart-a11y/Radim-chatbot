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

  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  const parts = msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.join("\n\n");
}

/**
 * Minimum cleaning:
 * - odstraní file_search citace 【x:y†...】
 * - opraví známý překlep domény obec-radimcz
 * - odstraní tečku/čárku na konci URL
 * - odstraní prázdné markdown odkazy [text]()
 *
 * NIC DALŠÍHO – žádné mazání vět/řádků.
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // oprava překlepů domény
  t = t.replace(/https?:\/\/(www\.)?obec-radimcz\b/gi, "https://www.obec-radim.cz");

  // odstranit tečku/čárku za URL
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");

  // zrušit prázdné markdown odkazy: [text]()
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * ✅ Finální normalizace URL pro obec Radim:
 * - opraví "obec-radimcz" (bez tečky)
 * - doplní https:// pokud chybí
 * - sjednotí na https://www.obec-radim.cz
 * - odstraní trailing tečky/čárky za URL
 */
function normalizeRadimLinks(text) {
  let t = String(text || "");

  // 1) oprav nejčastější překlep domény všude (i bez protokolu)
  t = t.replace(/\bobec-radimcz\b/gi, "www.obec-radim.cz");
  t = t.replace(/\bwww\.obec-radimcz\b/gi, "www.obec-radim.cz");

  // 2) doplň https:// když je tam "www.obec-radim.cz/..." bez protokolu
  t = t.replace(/\bwww\.obec-radim\.cz(\/[^\s)\]]*)?/gi, (m) => `https://${m}`);

  // 3) doplň https:// když je tam "obec-radim.cz/..." bez protokolu
  //    (a rovnou přepni na www)
  t = t.replace(/\bobec-radim\.cz(\/[^\s)\]]*)?/gi, (m) => `https://www.${m}`);

  // 4) sjednoť protokol a www
  t = t.replace(/https?:\/\/obec-radim\.cz/gi, "https://www.obec-radim.cz");
  t = t.replace(/https?:\/\/www\.obec-radim\.cz/gi, "https://www.obec-radim.cz");

  // 5) zahoď tečky/čárky za URL (když to vznikne po úpravách)
  t = t.replace(/(https:\/\/www\.obec-radim\.cz[^\s)\]]+)[\.,]+/g, "$1");

  // 6) whitespace cleanup
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * Krátký prompt, který funguje.
 * Pozn.: Tohle je INSTRUCTIONS pro run (přebije blbosti v UI, pokud tam něco je).
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu: 99_FULL_obec_radim.txt.\n\n` +
    `Zásady:\n` +
    `- Neimprovizuj a nevymýšlej informace, které nejsou ve zdroji.\n` +
    `- Můžeš logicky shrnout informace, které jsou ve zdroji obsaženy (např. "vede"/"vedení" = předseda/předsedkyně + výbor, pokud je ve zdroji uveden).\n` +
    `- Pokud je osoba ve více rolích, použij nejnovější platnou informaci.\n` +
    `- Pokud je u osoby kontakt uveden alespoň na jednom místě ve zdroji, považuj jej za dostupný.\n\n` +
    `Odkazy:\n` +
    `- Pokud je ve zdroji přímý odkaz na relevantní stránku nebo soubor, uveď jej.\n` +
    `- URL kopíruj přesně ze zdroje, URL nikdy neukončuj tečkou.\n\n` +
    `Styl:\n` +
    `- Úřední, věcný, stručný.\n` +
    `- Bez upozornění, bez řečí o AI.\n\n` +
    `Pokud informace ve zdroji skutečně není, odpověz přesně:\n` +
    `"Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim."\n`
  );
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

    // Thread: pokud přijde thread_id, pokračujeme; jinak založíme nový
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

    // 2) run
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: buildRunInstructions(),
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

    answer = cleanAnswer(answer);
    answer = normalizeRadimLinks(answer);

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