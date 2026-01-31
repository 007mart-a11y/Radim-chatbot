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

// Kanonické (bezpečné) rozcestníky – pomáhá navigaci i když uživatel neví kam kliknout
const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/",
  kalendar: "https://www.obec-radim.cz/?calendar=&lang=cs",
  hledani: "https://www.obec-radim.cz/?hledej=&lang=cs",
};

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
 * Odstraní úniky interních zdrojů / názvů souborů a lehce dočistí text.
 */
function stripInternalLeaks(text) {
  let t = String(text || "");

  // typicky: "Zdroj: 00_PEOPLE_obec_radim.txt" apod.
  t = t.replace(/^\s*Zdroj\s*:\s*.*$/gim, "");
  t = t.replace(/^\s*Zdroje?\s*:\s*.*$/gim, "");

  // odstraň zmínky interních souborů (00_*, 99_FULL_*, *.txt) pokud se objeví v textu
  t = t.replace(/\b\d{2}_[A-Z0-9_]+\.(txt|md)\b/gi, "");
  t = t.replace(/\b99_FULL_[A-Z0-9_]+\b/gi, "");

  // odstraň zmínky "knowledge base", "vector store" apod.
  t = t.replace(/\b(knowledge\s*base|vector\s*store|file_search|internal\s*source)\b/gi, "");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/**
 * Minimum cleaning:
 */
function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // odstranit tečku/čárku/středník atd. za URL (klikatelnost)
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");

  // zrušit prázdné markdown odkazy
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // interní úniky
  t = stripInternalLeaks(t);

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
 * Robustní opravy URL (řeší přesně tvoje ukázky):
 * - obec-radimcz -> obec-radim.cz (i s www)
 * - -1html / -2html -> -1.html / -2.html
 * - subjekt-...-2html -> subjekt-...-2.html
 */
function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  // ořež koncovou interpunkci
  u = u.replace(/[)\]}>,.;:!?]+$/g, "");

  // někdy se objeví "www.https://..."
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");

  // zdvojené schéma
  u = u.replace(/^https?:\/\/https:\/\//i, "https://");
  u = u.replace(/^https?:\/\/http:\/\//i, "http://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");

  // fix domény bez tečky
  u = u.replace(/\/\/www\.obec-radimcz/gi, "//www.obec-radim.cz");
  u = u.replace(/\/\/obec-radimcz/gi, "//obec-radim.cz");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");

  // fix chybějící ".html" (typicky "...-1html" nebo "...-2html")
  // jen pokud je to na konci cesty nebo před ?query
  u = u.replace(/(\d+)html(\b|\/|\?|#)/gi, "$1.html$2");

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

    // mimo whitelist -> pryč
    if (!isAllowedDomain(fixed)) return "";

    // finální ořez interpunkce
    return fixed.replace(/[)\]}>,.;:!?]+$/g, "");
  });

  // dočistit mezery po vyhozených URL
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}

/* =========================================================
   ✅ Cena / podmínky: relevance + backend stripper
   ========================================================= */

function isPriceRelevantQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(cena|kolik stojí|kolik stoji|poplatek|poplatky|ceník|cenik|pronájem|pronajem|pronajmout|rezerv|hala|sál|sal|hřiště|hriste|kurty|areál|areal)\b/.test(
    s
  );
}

function removePriceSectionIfNotRelevant(answerText, userText) {
  let t = String(answerText || "");
  if (!t) return t;

  // když uživatel cenu neřeší, sekci pryč
  if (!isPriceRelevantQuestion(userText)) {
    t = t.replace(
      /(^|\n)Cena\s*\/\s*podmínky:\s*\n([\s\S]*?)(?=\n(?:Odkazy:|$)|\n{2,})/i,
      "\n"
    );
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  // když je relevantní, ale jen "Není uvedeno", pryč
  t = t.replace(
    /(^|\n)Cena\s*\/\s*podmínky:\s*\n\s*Není uvedeno\s*(?=\n(?:Odkazy:|$)|\n{2,})/i,
    "\n"
  );
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * ✅ FINÁLNÍ INSTRUKCE PRO ASISTENTA
 */
function buildRunInstructions({ hardSearch = false } = {}) {
  const base =
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Tvým úkolem je pomáhat občanům jako digitální úředník a navigátor po webu obce ${OBEC_NAZEV}.\n\n` +

    `Odpovídáš výhradně na základě oficiálních veřejných informací obce ${OBEC_NAZEV} (web obce, dokumenty, úřední deska).\n` +
    `Nikdy nepoužívej informace z jiných obcí.\n\n` +

    `🚫 ZÁKAZ HÁDÁNÍ A HALUCINACÍ\n` +
    `Nevymýšlej jména, kontakty, ceny, termíny ani postupy.\n` +
    `Jména a kontakty uváděj jen pokud jsou v podkladech.\n\n` +

    `🔒 INTERNÍ ZDROJE\n` +
    `NIKDY nevypisuj názvy interních souborů, indexů nebo zdrojů (např. 00_*.txt, 99_FULL_*, "Zdroj: ...").\n` +
    `Uživatel má vidět jen odpověď + veřejné odkazy na web obce.\n\n` +

    `🧭 NAVIGACE\n` +
    `Tvůj cíl je, aby uživatel vždy dostal:\n` +
    `- krátkou jasnou odpověď,\n` +
    `- kdo je odpovědný (úřad / funkce),\n` +
    `- kontakt (pokud existuje),\n` +
    `- a hlavně relevantní ODKAZ na správnou stránku nebo dokument.\n\n` +

    `Kanonické rozcestníky (používej přesně tyto URL, když jsou relevantní):\n` +
    `- Kontakty: ${KEY_LINKS.kontakty}\n` +
    `- Úřední deska: ${KEY_LINKS.uredniDeska}\n` +
    `- Aktuality: ${KEY_LINKS.aktuality}\n` +
    `- Kalendář: ${KEY_LINKS.kalendar}\n` +
    `- Hledání: ${KEY_LINKS.hledani}\n\n` +

    `Pokud se uživatel ptá na vyhlášku / nařízení / dokument (např. odpady, psi, poplatky):\n` +
    `- najdi konkrétní položku v podkladech,\n` +
    `- uveď název dokumentu,\n` +
    `- a přilož PŘÍMÝ ODKAZ ke stažení (pokud existuje) nebo odkaz na stránku na úřední desce.\n\n` +

    `Pokud informace chybí nebo není jednoznačná, napiš přesně:\n` +
    `„Tato informace není v dostupných podkladech obce uvedena.“\n\n` +

    `🧾 FORMÁT ODPOVĚDI\n` +
    `Odpověď:\n(stručně, případně krokově u postupu)\n\n` +
    `Odpovědná osoba / úřad:\n(jméno+funkce jen pokud existuje, jinak "Obecní úřad Radim")\n\n` +
    `Kontakt:\n(telefon/e-mail jen pokud existuje, jinak "Není uvedeno")\n\n` +
    `Odkazy:\n- Název stránky nebo dokumentu – https://…\n`;

  const hard =
    `\n` +
    `🧠 DODATEČNÁ INSTRUKCE (HARD SEARCH)\n` +
    `Před odpovědí AKTIVNĚ vyhledej v podkladech relevantní část.\n` +
    `U typických dotazů (úřední hodiny, odpady, poplatky, úřední deska, vyhlášky) hledej i na stránkách typu "Kontakty", "Úřední deska", "Hledání" a v dokumentech.\n` +
    `Pokud je v podkladech uveden konkrétní odkaz, použij jej.\n`;

  return hardSearch ? base + hard : base;
}

/**
 * ✅ POVINNÝ KONTEXT WRAPPER (USER MESSAGE – VŽDY)
 */
function wrapUserQuestion(userText) {
  const t = String(userText || "").trim();
  return `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}. Uživatel chce navigaci po webu obce a relevantní veřejné odkazy.\nDOTAZ UŽIVATELE: ${t}`;
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

const REQUIRED_FALLBACK = "Tato informace není v dostupných podkladech obce uvedena.";

function looksLikeFallback(answer) {
  const t = String(answer || "").toLowerCase();
  return t.includes("tato informace není v dostupných podkladech obce uvedena");
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
        temperature: 0.1,
        top_p: 1,
      }),
    },
    apiKey
  );

  const started = Date.now();
  const timeoutMs = 45_000;

  while (true) {
    if (Date.now() - started > timeoutMs) {
      return { ok: false, error: "Timeout waiting for response" };
    }

    await sleep(650);

    const check = await api(`/threads/${threadId}/runs/${run.id}`, {}, apiKey);
    const status = check.status;

    if (status === "queued" || status === "in_progress") continue;

    if (status === "requires_action") {
      return {
        ok: false,
        error: "Run requires action (tool call not handled in function).",
        status,
      };
    }

    if (status !== "completed") {
      return { ok: false, error: "Run failed", status };
    }

    break;
  }

  const messages = await api(`/threads/${threadId}/messages?limit=50`, {}, apiKey);
  let answer = extractLatestAssistantText(messages);

  answer = cleanAnswer(answer);
  answer = normalizeUrlsInText(answer);

  return { ok: true, answer };
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

    // Reset threadu
    const msgTrim = String(message).trim();
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // Thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // Coreference
    let outgoingMessage = msgTrim;
    const needRewrite =
      isContactQuestion(outgoingMessage) &&
      hasPronounReference(outgoingMessage) &&
      !messageAlreadyContainsPersonName(outgoingMessage);

    if (needRewrite) {
      const lastPerson = await getLastReferencedPersonFromThread(threadId, apiKey, 12);
      if (lastPerson) {
        outgoingMessage = rewriteToExplicitPersonQuestion(outgoingMessage, lastPerson);
      }
    }

    // Wrapper
    outgoingMessage = wrapUserQuestion(outgoingMessage);

    // 1) add msg
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    // 2) run (normal)
    let r = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildRunInstructions({ hardSearch: false }),
    });

    // 3) retry (hard search) když to vypadá na falešný fallback
    if (r.ok && looksLikeFallback(r.answer)) {
      const r2 = await runAssistant({
        threadId,
        assistantId,
        apiKey,
        instructions: buildRunInstructions({ hardSearch: true }),
      });

      if (r2.ok && r2.answer && !looksLikeFallback(r2.answer)) {
        r = r2;
      } else if (r2.ok && r2.answer) {
        // když i hard search fallbackuje, necháme odpověď, ale pořád ji dočistíme níž
        r = r2;
      }
    }

    let answer = r.ok ? r.answer : "";

    // finální úklid + cena sekce
    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);
    answer = removePriceSectionIfNotRelevant(answer, msgTrim);

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
