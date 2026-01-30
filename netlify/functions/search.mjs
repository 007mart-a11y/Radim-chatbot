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

// Jediný fallback (bez překlepů)
const REQUIRED_FALLBACK = "Tato informace není v dostupných podkladech obce uvedena.";

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
    const err = new Error(`${method} ${path} failed: ${msg}`);
    err.status = res.status;
    err.path = path;
    err.method = method;
    err.details = json || text;
    throw err;
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
 * Vezme text z message.content (jen textové části).
 */
function extractMessageText(messageObj) {
  if (!messageObj || !Array.isArray(messageObj.content) || !messageObj.content.length) return "";
  const parts = messageObj.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

/**
 * Minimum cleaning:
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace pryč (uživateli je neukazujeme)
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // odstranit tečku/čárku/středník atd. za URL
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");

  // zrušit prázdné markdown odkazy
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // pryč otravných hlášek, které nechceš
  t = t.replace(/Relevantní veřejný odkaz k této informaci není k dispozici\.\s*/gi, "");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * ✅ Whitelist domén – nepustíme ven vymyšlené URL
 */
function isAllowedDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    const allowed = new Set([
      "obec-radim.cz",
      "www.obec-radim.cz",
      "zsradim.cz",
      "www.zsradim.cz",
    ]);

    return allowed.has(host);
  } catch {
    return false;
  }
}

/**
 * Minimal URL normalization
 */
function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");
  u = u.replace(/^https?:\/\/https:\/\//i, "https://");
  u = u.replace(/^https?:\/\/http:\/\//i, "http://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");

  // oprav chybějící tečku v doméně
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");

  // občas useknuté .pdf
  u = u.replace(/\.pd$/i, ".pdf");

  // dvojité //
  u = u.replace(/([^:]\/)\/+/g, "$1");

  return u;
}

/**
 * ✅ Normalize URLs + vyhoď všechny nepovolené domény
 */
function normalizeUrlsInText(text) {
  let t = String(text || "");
  if (!t) return t;

  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;

  t = t.replace(re, (m) => {
    const fixed = normalizeSingleUrl(m);
    if (!isAllowedDomain(fixed)) return "";
    return fixed.replace(/[)\]}>,.;:!?]+$/g, "");
  });

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}

/* =========================================================
   ✅ Cena / podmínky: relevance + backend stripper
   ========================================================= */

function isPriceRelevantQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(cena|kolik stojí|poplatek|poplatky|ceník|pronájem|pronajmout|rezerv|hala|sál|hřiště|kurty|areál)\b/.test(
    s
  );
}

function removePriceSectionIfNotRelevant(answerText, userText) {
  let t = String(answerText || "");
  if (!t) return t;

  if (!isPriceRelevantQuestion(userText)) {
    t = t.replace(
      /(^|\n)Cena\s*\/\s*podmínky:\s*\n([\s\S]*?)(?=\n(?:Odkazy:|$)|\n{2,})/i,
      "\n"
    );
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  t = t.replace(
    /(^|\n)Cena\s*\/\s*podmínky:\s*\n\s*Není uvedeno\s*(?=\n(?:Odkazy:|$)|\n{2,})/i,
    "\n"
  );
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/* =========================================================
   ✅ BLBUVZDORNÝ GUARD: hlídej jen osobní údaje / ceny
   (NE bioodpad, kontejnery, kde co je...)
   ========================================================= */

function containsFileSearchCitations(rawText) {
  const t = String(rawText || "");
  return /【\s*\d+\s*:\s*\d+\s*†[^】]*】/g.test(t);
}

function outputContainsPersonName(text) {
  const t = String(text || "");
  return /\b[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\b/.test(t);
}

function outputContainsPhoneOrEmail(text) {
  const t = String(text || "");
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(t);
  const hasPhone = /\b(\+?\d[\d\s]{7,}\d)\b/.test(t);
  return hasEmail || hasPhone;
}

function outputContainsMoney(text) {
  const t = String(text || "");
  return /\b\d{1,6}\s*(kč|czk|,-|kč\/h|kč\/hod|kč\/hodinu)\b/i.test(t);
}

// jen kontakty / vedení / osobní údaje – tady hlídáme halucinace
function isContactSensitiveQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(starost|místostarost|mayor|vedení obce|tajemník|zastupitel|kontakt|telefon|e-?mail|email|úřední hodiny|hodin)\b/.test(
    s
  );
}

/* =========================================================
   ✅ RETRY: query expansion (pomůže retrieveru)
   ========================================================= */

function expandQueryHints(userText) {
  const s = String(userText || "").toLowerCase();
  const hints = [];

  // odpady/bioodpad
  if (/\b(bio|bioodpad|kompost|větve|tráva|odpad|odpady|tříděn|kontejner|sběrný|skládka)\b/.test(s)) {
    hints.push(
      "bioodpad",
      "BIO",
      "kompost",
      "kompostárna",
      "kontejner na bio",
      "větve",
      "tráva",
      "sběrný dvůr",
      "kontejnery",
      "třídění odpadu",
      "svoz odpadu",
      "komunální odpad",
      "poplatek za odpady",
      "OZV",
      "vyhláška",
      "místní poplatek"
    );
  }

  // hala/pronájem
  if (/\b(hala|sál|pronájem|rezerv|zamluvit|areál|hřiště|kurty)\b/.test(s)) {
    hints.push("pronájem", "rezervace", "sál", "hala", "areál", "správce", "ceník");
  }

  // podpis/ověření
  if (/\b(podpis|ověř|ověření|legalizace)\b/.test(s)) {
    hints.push("ověření podpisu", "legalizace", "Czech POINT", "obecní úřad", "úřední hodiny");
  }

  return hints.length ? `\nKLÍČOVÁ SLOVA PRO VYHLEDÁNÍ: ${hints.join(", ")}\n` : "";
}

/**
 * ✅ FINÁLNÍ instrukce – méně “povinných sekcí”, ale stále úřední styl
 * (Cena jen když relevantní, odkazy jen když existují.)
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Pomáháš občanům jako digitální úředník a navigátor.\n\n` +

    `Odpovídej výhradně na základě oficiálních veřejných informací obce ${OBEC_NAZEV} (web obce, dokumenty, zveřejněné kontakty).\n` +
    `Nikdy nepoužívej informace z jiných obcí.\n\n` +

    `KRITICKÉ:\n` +
    `- Nevymýšlej jména, kontakty, ceny, termíny ani postupy.\n` +
    `- Když informace v podkladech není, použij přesně: "${REQUIRED_FALLBACK}"\n` +
    `- Nezmiňuj interní bázi/files/knowledge base.\n\n` +

    `Postupové dotazy (jak něco zařídit): napiš krokově postup + kdo to řeší + kontakt (pokud je v podkladech).\n` +
    `Cenu uváděj jen u dotazů na pronájem/rezervaci/poplatky/ceník a jen pokud je v podkladech.\n\n` +

    `ODKAZY:\n` +
    `- Sekci "Odkazy" vypiš jen pokud máš reálný veřejný odkaz (https://...) na web obce nebo ZŠ.\n` +
    `- Pokud odkaz nemáš, sekci "Odkazy" vůbec nevypisuj.\n\n` +

    `Formát drž přirozeně úřední. U jednoduchých faktů stačí 2–6 vět.\n`
  );
}

/**
 * ✅ POVINNÝ KONTEXT WRAPPER (vždy) + mapování starosta/starostka = mayor
 */
function wrapUserQuestion(userText, mode = "normal") {
  const t = String(userText || "").trim();
  const lower = t.toLowerCase();
  const mayorHint =
    /\b(starosta|starostku|starostka|mayor)\b/.test(lower)
      ? `POZNÁMKA: Dotaz na "starosta/starostka" ber jako dotaz na vedení obce (mayor) v obci ${OBEC_NAZEV}.`
      : "";

  const retryHint = mode === "retry" ? expandQueryHints(t) : "";

  return (
    `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}. Nepoužívej informace z jiných obcí.\n` +
    (mayorHint ? `${mayorHint}\n` : "") +
    (retryHint ? `${retryHint}` : "") +
    `DOTAZ UŽIVATELE: ${t}`
  );
}

/* =========================================================
   ✅ HARD COREFERENCE: přepis zájmen -> explicitní osoba
   ========================================================= */

const PERSON_REGEX =
  /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

function pickLastPersonFromText(text) {
  const t = String(text || "");
  const matches = [...t.matchAll(PERSON_REGEX)].map((m) => `${m[1]} ${m[2]}`);

  const filtered = matches.filter((name) => {
    const n = name.toLowerCase();
    if (n.startsWith("obec ")) return false;
    if (n.startsWith("obecní ")) return false;
    if (n.includes("obecní úřad")) return false;
    return true;
  });

  return filtered.length ? filtered[filtered.length - 1] : "";
}

function messageAlreadyContainsPersonName(msg) {
  return PERSON_REGEX.test(String(msg || ""));
}

function isContactQuestion(msg) {
  const s = String(msg || "").toLowerCase();
  return /\b(email|e-mail|mail|telefon|kontakt|zavolat|volat)\b/.test(s);
}

function hasPronounReference(msg) {
  const s = String(msg || "").toLowerCase();
  return /\b(na\s+ni|na\s+něj|na\s+ně|na\s+něho|její|jeho|jí|mu|něj|ní|tomu|té|toho|ta|ten|to)\b/.test(
    s
  );
}

function rewriteToExplicitPersonQuestion(original, personName) {
  const q = String(original || "").trim();
  const p = String(personName || "").trim();
  if (!q || !p) return q;

  const wantsEmail = /\b(email|e-mail|mail)\b/i.test(q);
  const wantsPhone = /\b(telefon|kontakt|zavolat|volat)\b/i.test(q);

  if (wantsEmail && wantsPhone) return `Jaký je e-mail a telefon na ${p}?`;
  if (wantsEmail) return `Jaký je e-mail na ${p}?`;
  if (wantsPhone) return `Jaký je telefon na ${p}?`;

  return `Dotaz se týká osoby ${p}: ${q}`;
}

async function getLastReferencedPersonFromThread(threadId, apiKey, limit = 12) {
  try {
    const messages = await api(`/threads/${threadId}/messages?limit=${limit}`, {}, apiKey);
    const data = Array.isArray(messages?.data) ? messages.data : [];
    if (!data.length) return "";

    const orderedDesc = [...data].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    for (const m of orderedDesc) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const txt = extractMessageText(m);
      if (!txt) continue;
      const p = pickLastPersonFromText(txt);
      if (p) return p;
    }

    return "";
  } catch {
    return "";
  }
}

/**
 * ✅ ensure thread
 */
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

async function addUserMessageWithFallback(threadId, content, apiKey) {
  try {
    await api(
      `/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content }),
      },
      apiKey
    );
    return threadId;
  } catch (e) {
    if (e?.status === 404) {
      const created = await api("/threads", { method: "POST" }, apiKey);
      const newThreadId = created.id;

      await api(
        `/threads/${newThreadId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "user", content }),
        },
        apiKey
      );

      return newThreadId;
    }
    throw e;
  }
}

/**
 * Spustí run + vrátí raw odpověď
 */
async function runAssistantOnce(threadId, assistantId, apiKey, wrappedMessage) {
  // user message
  threadId = await addUserMessageWithFallback(threadId, wrappedMessage, apiKey);

  // run
  const run = await api(
    `/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        instructions: buildRunInstructions(),
        temperature: 0.0,
        top_p: 1,
      }),
    },
    apiKey
  );

  // poll
  const started = Date.now();
  const timeoutMs = 45_000;

  while (true) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timeout waiting for response");
    }
    await sleep(650);

    const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
    const status = check.status;

    if (status === "queued" || status === "in_progress") continue;

    if (status === "requires_action") {
      const e = new Error("Run requires action (tool call not handled).");
      e.status = 501;
      throw e;
    }

    if (status !== "completed") {
      const e = new Error(`Run failed: ${status}`);
      e.status = 500;
      throw e;
    }

    break;
  }

  const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
  const answerRaw = extractLatestAssistantText(messages);

  return { threadId, answerRaw };
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

    const msgTrim = String(message).trim();

    // Reset threadu
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // ensure thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // HARD COREFERENCE (jen pro kontaktové dotazy)
    let outgoingMessage = msgTrim;
    const needRewrite =
      isContactQuestion(outgoingMessage) &&
      hasPronounReference(outgoingMessage) &&
      !messageAlreadyContainsPersonName(outgoingMessage);

    if (needRewrite) {
      const lastPerson = await getLastReferencedPersonFromThread(threadId, apiKey, 12);
      if (lastPerson) outgoingMessage = rewriteToExplicitPersonQuestion(outgoingMessage, lastPerson);
    }

    // 1) první pokus (normal)
    const wrapped1 = wrapUserQuestion(outgoingMessage, "normal");
    let { threadId: t1, answerRaw: a1 } = await runAssistantOnce(threadId, assistantId, apiKey, wrapped1);
    threadId = t1;

    // BLBUVZDORNÝ GUARD jen pro kontakty/ceny (ne pro bioodpad!)
    const contactSensitive = isContactSensitiveQuestion(msgTrim);
    const priceSensitive = isPriceRelevantQuestion(msgTrim);

    const hasCitations1 = containsFileSearchCitations(a1);
    const hasName1 = outputContainsPersonName(a1);
    const hasContact1 = outputContainsPhoneOrEmail(a1);
    const hasMoney1 = outputContainsMoney(a1);

    // Pokud je to kontaktová otázka a vyplivl jméno/kontakt bez citací, raději fallback a zkus retry
    let shouldRetry = false;

    if (contactSensitive && (hasName1 || hasContact1) && !hasCitations1) shouldRetry = true;
    if (priceSensitive && hasMoney1 && !hasCitations1) shouldRetry = true;

    // čistý text pro posouzení fallbacku
    let answer1 = normalizeUrlsInText(cleanAnswer(a1));
    answer1 = removePriceSectionIfNotRelevant(answer1, msgTrim);

    // pokud vypadá jako fallback nebo prázdno, zkus retry s query-expansion
    if (!answer1 || answer1 === REQUIRED_FALLBACK) shouldRetry = true;

    // 2) retry pokus s rozšířeným kontextem (synonyma) – jen když je to potřeba
    let finalAnswerRaw = a1;

    if (shouldRetry) {
      const wrapped2 = wrapUserQuestion(outgoingMessage, "retry");
      const { threadId: t2, answerRaw: a2 } = await runAssistantOnce(threadId, assistantId, apiKey, wrapped2);
      threadId = t2;
      finalAnswerRaw = a2;
    }

    // finální guard (po retry) – zase jen pro kontakty/ceny
    const hasCitationsF = containsFileSearchCitations(finalAnswerRaw);
    const hasNameF = outputContainsPersonName(finalAnswerRaw);
    const hasContactF = outputContainsPhoneOrEmail(finalAnswerRaw);
    const hasMoneyF = outputContainsMoney(finalAnswerRaw);

    if (contactSensitive && (hasNameF || hasContactF) && !hasCitationsF) {
      return jsonResponse(200, { ok: true, answer: REQUIRED_FALLBACK, thread_id: threadId });
    }
    if (priceSensitive && hasMoneyF && !hasCitationsF) {
      return jsonResponse(200, { ok: true, answer: REQUIRED_FALLBACK, thread_id: threadId });
    }

    // finální cleaning
    let answer = normalizeUrlsInText(cleanAnswer(finalAnswerRaw));
    answer = removePriceSectionIfNotRelevant(answer, msgTrim);

    if (!answer) answer = REQUIRED_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    const status = err?.status || 500;
    return jsonResponse(status, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
