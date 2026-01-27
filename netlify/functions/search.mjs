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
  } catch {}

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
 * Minimum cleaning – beze změn
 */
function cleanAnswer(text) {
  let t = String(text || "");

  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,]+/g, "$1");
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * Minimal URL normalization – beze změn
 */
function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");
  u = u.replace(/^https?:\/\/https:\/\//i, "https://");
  u = u.replace(/^https?:\/\/http:\/\//i, "http://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");
  u = u.replace(/\.pd$/i, ".pdf");
  u = u.replace(/([^:]\/)\/+/g, "$1");

  return u;
}

function normalizeUrlsInText(text) {
  let t = String(text || "");
  if (!t) return t;

  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;
  t = t.replace(re, (m) => normalizeSingleUrl(m));

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce Radim.\n\n` +
    `Odpovídáš výhradně na základě dokumentu: 99_FULL_obec_radim.txt.\n\n` +
    `Styl: úřední, věcný, stručný.\n`
  );
}

/* =========================================================
   ✅ “Once and for all” fix: subject anchoring (coreference)
   ========================================================= */

/**
 * Získá posledních N zpráv z threadu a vrátí je seřazené od nejstarší k nejnovější,
 * včetně role + textu (jen textové části).
 */
async function getRecentMessagesRaw(threadId, apiKey, limit = 12) {
  const messages = await api(`/threads/${threadId}/messages?limit=${limit}`, {}, apiKey);
  const data = Array.isArray(messages?.data) ? messages.data : [];
  if (!data.length) return [];

  const ordered = [...data].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  const turns = [];
  for (const m of ordered) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (!Array.isArray(m.content) || !m.content.length) continue;

    const parts = m.content
      .map((c) => (c?.type === "text" ? c.text?.value : ""))
      .filter(Boolean);

    const text = parts.join("\n\n").trim();
    if (!text) continue;

    turns.push({ role: m.role, text });
  }
  return turns;
}

/**
 * Najde “poslední subjekt”, ke kterému se uživatel pravděpodobně odkazuje:
 * - preferuje poslední konkrétní OSOBU (jméno příjmení s velkými písmeny)
 * - jinak poslední ORGANIZACI (TJ/SDH/Spolek/Sokol apod.)
 *
 * Vrací string nebo "".
 */
function extractLastSubjectFromTurns(turns) {
  const combined = turns.map((t) => t.text).join("\n\n");

  // 1) Organizace/role (silné kotvy)
  const orgPatterns = [
    /\bTJ\s+Sokol\s+Radim\b/gi,
    /\bSokol\b/gi,
    /\bSDH\s+Radim\b/gi,
    /\bObec\s+Radim\b/gi,
    /\bObecní\s+úřad\s+Radim\b/gi,
    /\bKulturní\s+výbor\b/gi,
    /\bSportovní\s+výbor\b/gi,
    /\bFinanční\s+výbor\b/gi,
    /\bKontrolní\s+výbor\b/gi,
  ];

  // 2) Osoba: dvě slova s velkým písmenem (CZ diakritika) – konzervativní
  // Zachytí např. "Štěpánka Kořínková", "Zdeňka Stříbrná"
  const personRegex =
    /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

  // Projdeme od konce (nejnovější zmínky)
  for (let i = turns.length - 1; i >= 0; i--) {
    const txt = turns[i].text;

    // osobní jméno
    const people = [...txt.matchAll(personRegex)].map((m) => `${m[1]} ${m[2]}`);
    if (people.length) {
      // vrať poslední jméno z té zprávy
      return people[people.length - 1];
    }

    // organizace
    for (const re of orgPatterns) {
      const m = txt.match(re);
      if (m && m.length) {
        // vrať “normalizovanou” podobu poslední shody
        return m[m.length - 1].replace(/\s+/g, " ").trim();
      }
    }
  }

  // fallback: z celého kontextu (kdyby byly zprávy krátké)
  const peopleAll = [...combined.matchAll(personRegex)].map((m) => `${m[1]} ${m[2]}`);
  if (peopleAll.length) return peopleAll[peopleAll.length - 1];

  for (const re of orgPatterns) {
    const m = combined.match(re);
    if (m && m.length) return m[m.length - 1].replace(/\s+/g, " ").trim();
  }

  return "";
}

/**
 * Rozpozná, že dotaz je “referenční” (zájmena / “na ni/něj/její/jeho/tomu/té”),
 * a zároveň neobsahuje explicitní jméno/organizaci → potřebuje kotvu.
 */
function shouldAnchorSubject(userMessage) {
  const s = String(userMessage || "").toLowerCase();

  // reference triggers (CZ)
  const hasPronoun =
    /\b(na\s+ni|na\s+něj|na\s+ně|na\s+něho|na\s+něm|na\s+něm|na\s+to|její|jeho|jí|mu|něj|ní|tomu|těm|té|toho|tamto|ten|ta|to)\b/.test(
      s
    );

  // “kdo”, “kontakt”, “email”, “telefon” často padají na úřad bez kotvy
  const isContactAsk = /\b(email|e-mail|mail|telefon|kontakt|zavolat|volat)\b/.test(s);

  // pokud už zpráva obsahuje nějaké velké jméno (2 slova) nebo “TJ Sokol”, kotva netřeba
  const alreadyHasName =
    /\b[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\b/.test(
      userMessage
    ) || /\bTJ\s+Sokol\s+Radim\b/i.test(userMessage);

  return (hasPronoun || isContactAsk) && !alreadyHasName;
}

/**
 * Přidá explicitní kotvu “Dotaz se týká: SUBJECT.” před dotaz.
 * Tím se odstraní “útěk” modelu na obec/úřad.
 */
function applySubjectAnchor(userMessage, subject) {
  const msg = String(userMessage || "").trim();
  const sub = String(subject || "").trim();
  if (!msg) return msg;
  if (!sub) return msg;

  return `Dotaz se týká: ${sub}.\n\n${msg}`;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return jsonResponse(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!assistantId) return jsonResponse(500, { ok: false, error: "Missing ASSISTANT_ID" });

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    // THREAD
    let threadId = body?.thread_id;
    if (!threadId || !threadId.startsWith("thread_")) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      threadId = created.id;
    }

    // ✅ “Once and for all” subject anchoring:
    // Získej poslední zprávy, vytáhni subjekt, a pokud dotaz používá zájmena,
    // připiš kotvu "Dotaz se týká: …"
    const turns = await getRecentMessagesRaw(threadId, apiKey, 12);
    const lastSubject = extractLastSubjectFromTurns(turns);

    let outgoingMessage = message.trim();
    if (shouldAnchorSubject(outgoingMessage) && lastSubject) {
      outgoingMessage = applySubjectAnchor(outgoingMessage, lastSubject);
    }

    // USER MESSAGE
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: outgoingMessage,
        }),
      },
      apiKey
    );

    // RUN
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: buildRunInstructions(),
          temperature: 0.1,
        }),
      },
      apiKey
    );

    // POLL
    const started = Date.now();
    while (true) {
      if (Date.now() - started > 45_000) {
        return jsonResponse(504, { ok: false, error: "Timeout" });
      }

      await sleep(650);
      const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);

      if (check.status === "completed") break;
      if (check.status !== "queued" && check.status !== "in_progress") {
        return jsonResponse(500, { ok: false, error: "Run failed", status: check.status });
      }
    }

    // READ
    const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
    let answer = extractLatestAssistantText(messages);

    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    if (!answer) {
      answer =
        "Tuto informaci bohužel nemám k dispozici v oficiálních podkladech obce Radim.";
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