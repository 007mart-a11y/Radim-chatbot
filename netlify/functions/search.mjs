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
const OBEC_NAZEV = "Radim";

// Kanonické rozcestníky (jen pro pomoc a fallback)
const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/aktuality/",
  kalendar: "https://www.obec-radim.cz/aktualne/kalendar-akci/",
  bioodpad: "https://www.obec-radim.cz/urad/skladka-bioodpadu/",
  sokol: "https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/",
};

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(path_, { method = "GET", body, headers = {} } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${path_}`, {
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
    const err = new Error(`${method} ${path_} failed: ${msg}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

function extractLatestAssistantText(messagesListJson) {
  const data = Array.isArray(messagesListJson?.data) ? messagesListJson.data : [];
  const assistantMsgs = data.filter((m) => m?.role === "assistant" && Array.isArray(m?.content) && m.content.length);
  if (!assistantMsgs.length) return "";

  assistantMsgs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const msg = assistantMsgs[0];

  return msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean)
    .join("\n\n");
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function todayCZ() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}. ${mm}. ${yyyy}`;
}

function isBioodpadQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(bioodpad|skladka bioodpadu|zeleny odpad|kompost)\b/.test(s);
}
function isKontaktyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(kontakt|kontakty|telefon|e-mail|email|datova schranka|ico|adresa)\b/.test(s);
}
function isUredniHodinyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(uredni hodiny|oteviraci doba|kdy je otevreno|konzultacni|konzultacni hodiny)\b/.test(s);
}
function isEventsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(akce|kalendar|kalendář|program|udalost|událost|co se deje|co se děje)\b/.test(s);
}
function isBudgetFinanceQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(rozpocet|rozpočet|hospodareni|hospodaření|zaverecny ucet|závěrečný účet|rozpoctove opatreni|rozpočtové opatření)\b/.test(s);
}
function isDogFeeQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(poplatek)\b/.test(s) && /\b(pes|psy|psu|psů)\b/.test(s);
}
function isSokolQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(sokol|prihlask|přihlášk|clenska|člensk)\b/.test(s);
}

function cleanAnswer(text) {
  let t = String(text || "");

  // odstranění citací z file_search
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // kanonizace kontaktů (model někdy vyplivne jiné cesty)
  t = t.replace(/https:\/\/www\.obec-radim\.cz\/obec-urad\/kontakty\/?/gi, KEY_LINKS.kontakty);
  t = t.replace(/https:\/\/www\.obec-radim\.cz\/kontakt\/?/gi, KEY_LINKS.kontakty);

  // drobný úklid
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t.trim();
}

function hasAnyUrl(text) {
  return /\bhttps?:\/\/[^\s<>"')\]]+/i.test(String(text || ""));
}

function pickFallbackLink(q) {
  if (isBioodpadQuestion(q)) return KEY_LINKS.bioodpad;
  if (isUredniHodinyQuestion(q) || isKontaktyQuestion(q)) return KEY_LINKS.kontakty;
  if (isEventsQuestion(q)) return KEY_LINKS.kalendar;
  if (isBudgetFinanceQuestion(q) || isDogFeeQuestion(q)) return KEY_LINKS.uredniDeska;
  if (isSokolQuestion(q)) return KEY_LINKS.sokol;
  return KEY_LINKS.homepage;
}

function ensureLinkBlock(answerText, q) {
  let t = String(answerText || "").trim();
  if (!t) return t;

  // když asistent napsal "zde:" a nedal URL, nebo nedal žádný odkaz vůbec → doplň
  if (!hasAnyUrl(t)) {
    const link = pickFallbackLink(q);
    // držme formát krátce a konzistentně
    if (!/^\s*Odkazy\s*:/im.test(t)) {
      t = `${t}\n\nOdkazy:\n- ${link}`;
    } else {
      t = `${t}\n- ${link}`;
    }
  }

  // když jsou v odpovědi duplicitní stejné linky, mírně odduplikuj (jen na úrovni řádků)
  const lines = t.split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const norm = line.trim();
    if (/^\-\s*https?:\/\//i.test(norm)) {
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildInstructions(userQ) {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Odpovídáš výhradně z oficiálních podkladů dostupných přes file_search (web obce, dokumenty, úřední deska).\n` +
    `Nevymýšlej fakta, jména, kontakty ani částky. Pokud něco v podkladech není, napiš přesně:\n` +
    `"Tato informace není v dostupných podkladech obce uvedena."\n\n` +
    `Dnes je ${todayCZ()}.\n\n` +
    `FORMÁT (krátce, bez omáčky):\n` +
    `Odpověď:\n- 1–5 krátkých bodů nebo 1–3 věty.\n\n` +
    `Odkazy:\n- vždy uveď 1–3 přímé odkazy na relevantní stránku/dokument na webu obce (pokud existují).\n\n` +
    `DŮLEŽITÉ:\n` +
    `- Neopakuj stejné odkazy.\n` +
    `- Kontakty uváděj jen když je to nutné (např. domluva na úřadě).\n` +
    `- Když doporučuješ kontaktovat úřad, přidej odkaz na kontakty.\n`
  );
}

function wrapUserMessage(userText) {
  // lehký “hint” pro lepší směrování (nezabíjí to, jen pomáhá)
  return (
    `DOTAZ UŽIVATELE: ${String(userText || "").trim()}\n\n` +
    `Kanonické rozcestníky (pokud se hodí):\n` +
    `- Kontakty: ${KEY_LINKS.kontakty}\n` +
    `- Úřední deska: ${KEY_LINKS.uredniDeska}\n` +
    `- Kalendář akcí: ${KEY_LINKS.kalendar}\n` +
    `- Bioodpad: ${KEY_LINKS.bioodpad}\n`
  );
}

async function ensureThreadId(incomingThreadId, apiKey) {
  let threadId = incomingThreadId;

  if (!threadId || typeof threadId !== "string" || !threadId.startsWith("thread_")) {
    const created = await api("/threads", { method: "POST" }, apiKey);
    return created.id;
  }

  try {
    await api(`/threads/${threadId}`, {}, apiKey);
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return created.id;
    }
    throw e;
  }
}

async function addUserMessage(threadId, content, apiKey) {
  await api(
    `/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content }),
    },
    apiKey
  );
}

async function runAssistant({ threadId, assistantId, apiKey, instructions }) {
  const run = await api(
    `/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        instructions,
        temperature: 0.2,
        top_p: 1,
      }),
    },
    apiKey
  );

  const started = Date.now();
  const timeoutMs = 45_000;

  while (true) {
    if (Date.now() - started > timeoutMs) throw new Error("Timeout waiting for response");
    await sleep(650);

    const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
    if (check.status === "queued" || check.status === "in_progress") continue;
    if (check.status !== "completed") throw new Error(`Run failed: ${check.status}`);
    break;
  }

  const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
  return extractLatestAssistantText(messages);
}

// ============================================
// ✅ Handler
// ============================================

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
    if (!message || typeof message !== "string") return jsonResponse(400, { ok: false, error: "Missing message" });

    const msgTrim = String(message).trim();

    // reset thread
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // send message
    const outgoing = wrapUserMessage(msgTrim);
    await addUserMessage(threadId, outgoing, apiKey);

    // run
    let answer = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildInstructions(msgTrim),
    });

    // clean + ensure link
    answer = cleanAnswer(answer);
    answer = ensureLinkBlock(answer, msgTrim);

    // poslední kanonizace kontaktů
    answer = answer.replace(/https:\/\/www\.obec-radim\.cz\/obec-urad\/kontakty\/?/gi, KEY_LINKS.kontakty);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Server error", details: err?.message || String(err) });
  }
}
