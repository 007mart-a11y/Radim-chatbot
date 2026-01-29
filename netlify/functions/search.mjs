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
 * Minimum cleaning (neodstraňuj zde odkazy/domény – to dělá normalizeUrlsInText).
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace (uživateli nechceme ukazovat)
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // odstranit tečku/čárku/středník atd. za URL (klikatelnost)
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");

  // zrušit prázdné markdown odkazy
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * ✅ Whitelist domén – nepustíme ven vymyšlené URL mimo povolené domény
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

  // ✅ oprav chybějící tečku v doméně
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

    // 1) zahodit všechno mimo whitelist
    if (!isAllowedDomain(fixed)) return "";

    // 2) pojistka: ořez interpunkce
    return fixed.replace(/[)\]}>,.;:!?]+$/g, "");
  });

  // dočistit mezery po vyhozených URL
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}

/* ==============================
   ✅ HARD ANTI-HALLUCINATION GUARD
   ============================== */

function containsFileSearchCitations(rawText) {
  const t = String(rawText || "");
  return /【\s*\d+\s*:\s*\d+\s*†[^】]*】/g.test(t);
}

function extractUrlsRaw(text) {
  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;
  return (String(text || "").match(re) || []).map(normalizeSingleUrl);
}

function hasAnyAllowedUrl(text) {
  const urls = extractUrlsRaw(text).filter((u) => isAllowedDomain(u));
  return urls.length > 0;
}

function outputContainsPersonName(text) {
  const t = String(text || "");
  // 2 slova s velkým písmenem
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
  // např. "200 Kč", "200,-", "200 CZK", "Kč/h"
  return /\b\d{1,6}\s*(kč|czk|,-|kč\/h|kč\/hod|kč\/hodinu)\b/i.test(t);
}

function isSensitiveQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(starost|místostarost|mayor|vedení obce|tajemník|zastupitel|kontakt|telefon|e-?mail|email|úřední hodiny|hodin|cena|pronájem|rezerv|hala|sál|podpis|ověř|ověření|poplatek|žádost|formulář)\b/.test(
    s
  );
}

/* ==============================
   ✅ LINK VALIDATION (anti-404)
   ============================== */

async function headOk(url, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // HEAD někdy blokují; fallback na GET s Range
    let res = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
    if (res.ok) return true;

    res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-256" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function extractUrls(text) {
  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;
  return (String(text || "").match(re) || []).map(normalizeSingleUrl);
}

async function removeBrokenUrlsFromText(text) {
  let t = String(text || "");
  const urls = Array.from(new Set(extractUrls(t))).filter((u) => isAllowedDomain(u));

  if (!urls.length) return t;

  // Ověř 1–6 URL (šetrně) – víc obvykle nepotřebuješ
  const toCheck = urls.slice(0, 6);
  const okMap = new Map();
  for (const u of toCheck) {
    okMap.set(u, await headOk(u, 3000));
  }

  // odstranit rozbité url
  for (const u of toCheck) {
    if (!okMap.get(u)) {
      const safe = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(safe, "g"), "");
    }
  }

  // dočistit whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/**
 * Pokud sekce "Odkazy:" zůstane bez URL, odstranit ji celou.
 */
function removeEmptyLinksSection(text) {
  let t = String(text || "");
  // najdi blok "Odkazy:" až do konce nebo do prázdné řádky
  // a pokud v něm není žádné http(s)://, tak pryč
  const re = /(^|\n)Odkazy:\s*\n([\s\S]*?)(?=\n{2,}|\n*$)/i;
  const m = t.match(re);
  if (!m) return t;

  const block = m[0];
  const hasUrl = /\bhttps?:\/\//i.test(block);
  if (hasUrl) return t;

  t = t.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/**
 * ✅ FINÁLNÍ instrukce (run instructions) – donucení k postupu + strukturám
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Tvým úkolem je pomáhat občanům jako digitální úředník a navigátor po obci ${OBEC_NAZEV}.\n\n` +

    `Odpovídáš výhradně na základě oficiálních veřejných informací obce ${OBEC_NAZEV} (web obce, dokumenty, zveřejněné kontakty a informace).\n` +
    `Nikdy nepoužívej informace z jiných obcí.\n\n` +

    `KRITICKÁ PRAVIDLA:\n` +
    `1) NIKDY NEHÁDEJ: Jména osob, kontakty, ceny, termíny, úřední hodiny ani postupy uváděj pouze tehdy, pokud jsou výslovně uvedeny v podkladech.\n` +
    `2) Pokud informace není v podkladech, napiš přesně: "${REQUIRED_FALLBACK}"\n` +
    `3) Nikdy nezmiňuj interní zdroje (files, knowledge base, vector store, podklady). Neuváděj odkazy na interní bázi.\n\n` +

    `POSTUPOVÉ DOTAZY (jak něco zařídit – např. hala, ověření podpisu, žádost, poplatky):\n` +
    `- Uveď stručný postup krokově (jen z podkladů).\n` +
    `- Identifikuj odpovědnou osobu/úřad (pokud je v podkladech).\n` +
    `- Uveď kontakt (telefon/e-mail) pouze pokud je v podkladech.\n` +
    `- Cenu uváděj pouze pokud je v podkladech (typicky pronájmy – hala/sál).\n\n` +

    `ODKAZY:\n` +
    `- Sekci "Odkazy" vypiš pouze tehdy, pokud máš aspoň 1 relevantní veřejný odkaz (https://...) na oficiální web obce (nebo ZŠ, pokud je relevantní).\n` +
    `- Pokud žádný veřejný odkaz nemáš, sekci "Odkazy" vůbec nevypisuj.\n` +
    `- Odkazy uváděj jako: "- Název stránky – https://..."\n\n` +

    `FORMÁT ODPOVĚDI DODRŽ PŘESNĚ:\n\n` +
    `Odpověď:\n` +
    `(1–6 vět; u postupů klidně více, pokud je to nutné)\n\n` +
    `Odpovědná osoba / úřad:\n` +
    `(uveď jméno+funkci pouze pokud je v podkladech, jinak napiš "Není uvedeno")\n\n` +
    `Kontakt:\n` +
    `(uveď telefon/e-mail pouze pokud je v podkladech, jinak napiš "Není uvedeno")\n\n` +
    `Cena / podmínky:\n` +
    `(uveď pouze pokud je v podkladech, jinak napiš "Není uvedeno")\n\n` +
    `Odkazy:\n` +
    `- Název stránky – https://...\n`
  );
}

/**
 * ✅ POVINNÝ KONTEXT WRAPPER (USER MESSAGE – VŽDY)
 * + mapování starosta/starostka -> mayor
 */
function wrapUserQuestion(userText) {
  const t = String(userText || "").trim();
  const lower = t.toLowerCase();
  const mayorHint =
    /\b(starosta|starostku|starostka|mayor)\b/.test(lower)
      ? `\nPOZNÁMKA: Dotaz na "starosta/starostka" ber jako dotaz na vedení obce (mayor) a odpověz podle podkladů pro obec ${OBEC_NAZEV}.`
      : "";

  return `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}. Nepoužívej informace z jiných obcí.${mayorHint}\nDOTAZ UŽIVATELE: ${t}`;
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
 * ✅ Spolehlivé zajištění threadu:
 * - když je incoming thread_id neplatný (404), vytvoří nový.
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

/**
 * ✅ Spolehlivé přidání zprávy do threadu s jednorázovým fallbackem při 404.
 */
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

    // ✅ Reset threadu
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // ✅ ensure thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // ✅ HARD COREFERENCE
    let outgoingMessage = msgTrim;

    const needRewrite =
      isContactQuestion(outgoingMessage) &&
      hasPronounReference(outgoingMessage) &&
      !messageAlreadyContainsPersonName(outgoingMessage);

    if (needRewrite) {
      const lastPerson = await getLastReferencedPersonFromThread(threadId, apiKey, 12);
      if (lastPerson) outgoingMessage = rewriteToExplicitPersonQuestion(outgoingMessage, lastPerson);
    }

    // ✅ vždy přidat pevný kontext
    outgoingMessage = wrapUserQuestion(outgoingMessage);

    // 1) user msg
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    // 2) run
    const run = await api(
      `/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions: buildRunInstructions(),
          temperature: 0.0, // ✅ co nejméně kreativity
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
    const answerRaw = extractLatestAssistantText(messages);

    // ✅ HARD ANTI-HALLUCINATION GUARD:
    // Pokud jde o citlivý dotaz a odpověď obsahuje jméno/kontakt/cenu,
    // musí mít aspoň nějaký důkaz (citace) NEBO aspoň jeden veřejný povolený URL.
    // Jinak raději fallback.
    const sensitive = isSensitiveQuestion(msgTrim);
    const hasName = outputContainsPersonName(answerRaw);
    const hasContact = outputContainsPhoneOrEmail(answerRaw);
    const hasMoney = outputContainsMoney(answerRaw);

    const hasCitations = containsFileSearchCitations(answerRaw);
    const hasAllowedUrlRaw = hasAnyAllowedUrl(answerRaw);

    if (sensitive && (hasName || hasContact || hasMoney) && !hasCitations && !hasAllowedUrlRaw) {
      return jsonResponse(200, { ok: true, answer: REQUIRED_FALLBACK, thread_id: threadId });
    }

    // ✅ cleaning + whitelist URL
    let answer = cleanAnswer(answerRaw);
    answer = normalizeUrlsInText(answer);

    // ✅ odstranit rozbité odkazy + odstranit prázdnou sekci Odkazy
    answer = await removeBrokenUrlsFromText(answer);
    answer = removeEmptyLinksSection(answer);

    // ✅ druhá pojistka: když po odfiltrování odkazů zůstane odpověď citlivá s kontakty/jménem/cenou,
    // ale už nemá ani citace (ty jsou pryč) ani žádný URL, raději fallback.
    // (citace jsou pryč, proto hlídáme aspoň URL po validaci)
    const hasAllowedUrlFinal = hasAnyAllowedUrl(answer);
    const hasNameFinal = outputContainsPersonName(answer);
    const hasContactFinal = outputContainsPhoneOrEmail(answer);
    const hasMoneyFinal = outputContainsMoney(answer);

    if (sensitive && (hasNameFinal || hasContactFinal || hasMoneyFinal) && !hasAllowedUrlFinal && !hasCitations) {
      answer = REQUIRED_FALLBACK;
    }

    if (!answer) answer = REQUIRED_FALLBACK;

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
