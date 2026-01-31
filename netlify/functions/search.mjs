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

  // file_search citace
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

/* =========================================================
   ✅ Cena / podmínky: relevance + backend stripper
   ========================================================= */

function isPriceRelevantQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(cena|kolik stojí|kolik stoji|poplatek|poplatky|ceník|cenik|pronájem|pronajem|rezerv|hala|sál|sal|hřiště|hriste|kurty|areál|areal)\b/.test(
    s
  );
}

function removePriceSectionIfNotRelevant(answerText, userText) {
  let t = String(answerText || "");
  if (!t) return t;

  // když uživatel cenu vůbec neřeší, sekci "Cena / podmínky" pryč (ať už je vyplněná nebo "Není uvedeno")
  if (!isPriceRelevantQuestion(userText)) {
    t = t.replace(
      /(^|\n)Cena\s*\/\s*podmínky:\s*\n([\s\S]*?)(?=\n(?:Odkazy:|$)|\n{2,})/i,
      "\n"
    );
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  // když cena relevantní je, ale je tam jen "Není uvedeno", odstraň
  t = t.replace(
    /(^|\n)Cena\s*\/\s*podmínky:\s*\n\s*Není uvedeno\s*(?=\n(?:Odkazy:|$)|\n{2,})/i,
    "\n"
  );
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/* =========================================================
   ✅ NAVIGACE PO WEBU (blbuvzdorné odkazy z backendu)
   - přidá odkazy i když je model neuvede
   - když model spadne na fallback u zjevně navigačního dotazu, backend vrátí navigační odpověď
   ========================================================= */

const NAV_LINKS = [
  {
    // Úřední deska – ověřená veřejná stránka (u Radimi běží i "verze pro seniory")
    patterns: [/\b(úřední deska|uredni deska)\b/i],
    links: [["Úřední deska obce Radim", "https://www.obec-radim.cz/seniori/urad/uredni-deska/"]],
  },
  {
    patterns: [/\b(kontakt|kontakty|úřední hodiny|uredni hodiny|telefon|e-?mail|datová schránka|datova schranka)\b/i],
    links: [["Kontakty a úřední hodiny", "https://www.obec-radim.cz/urad/kontakty/"]],
  },
  {
    patterns: [/\b(bioodpad|skládka bioodpadu|skladka bioodpadu|kompost)\b/i],
    links: [["Skládka bioodpadu", "https://www.obec-radim.cz/urad/skladka-bioodpadu/"]],
  },
  {
    patterns: [/\b(sokol|tj\s*sokol)\b/i],
    links: [
      ["TJ Sokol Radim – rozcestník", "https://www.obec-radim.cz/organizace-a-spolky/sokolove/"],
      ["TJ Sokol Radim – kontakty", "https://www.obec-radim.cz/organizace-a-spolky/sokolove/o-nas/kontakty/"],
    ],
  },
  {
    patterns: [/\b(hasič|hasici|sdh|mladí hasiči|mladi hasici|hasičský kroužek|hasicsky krouzek)\b/i],
    links: [["Hasiči – aktuálně o sboru (kontakty)", "https://www.obec-radim.cz/organizace-a-spolky/hasici/aktualne-o-sboru/"]],
  },
  {
    patterns: [/\b(czech\s*point|ověřit podpis|overit podpis|legalizace|vidimace)\b/i],
    links: [["Czech POINT", "https://www.obec-radim.cz/urad/czech-point/"]],
  },
];

function getNavLinksForQuestion(userText) {
  const q = String(userText || "").trim();
  if (!q) return [];
  const out = [];
  for (const rule of NAV_LINKS) {
    if (rule.patterns.some((re) => re.test(q))) {
      for (const l of rule.links) out.push(l);
    }
  }
  // dedupe by url
  const seen = new Set();
  return out.filter(([, url]) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function answerHasAllowedUrl(answer) {
  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;
  const matches = String(answer || "").match(re) || [];
  return matches.some((u) => isAllowedDomain(normalizeSingleUrl(u)));
}

function appendNavLinksIfMissing(answerText, userText) {
  let t = String(answerText || "").trim();
  if (!t) return t;

  const links = getNavLinksForQuestion(userText);
  if (!links.length) return t;

  // pokud už odpověď nějaký povolený URL má, nic nenutíme
  if (answerHasAllowedUrl(t)) return t;

  t += "\n\nOdkazy:\n";
  for (const [label, url] of links) {
    t += `- ${label} – ${url}\n`;
  }
  return t.trim();
}

function isClearlyNavigationQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(odkaz|link|kde najdu|kde je|úřední deska|uredni deska|kontakty|úřední hodiny|uredni hodiny|bioodpad|skládka|sokol|hasič|hasici|czech point|ověřit podpis|overit podpis)\b/.test(
    s
  );
}

function buildNavigationOnlyAnswer(userText) {
  const links = getNavLinksForQuestion(userText);
  if (!links.length) return "";
  let t = `Odpověď:\nRelevantní informace najdete na oficiálním webu obce ${OBEC_NAZEV} zde:\n\nOdkazy:\n`;
  for (const [label, url] of links) {
    t += `- ${label} – ${url}\n`;
  }
  t += `\nOdpovědná osoba / úřad:\nObecní úřad ${OBEC_NAZEV}\n`;
  t += `\nKontakt:\nViz stránka „Kontakty a úřední hodiny“.`;
  return t.trim();
}

/* =========================================================
   ✅ Anti-halucinace: pokud padne jméno, musí existovat veřejný odkaz
   ========================================================= */

const PERSON_REGEX =
  /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

function answerContainsPersonName(answerText) {
  const t = String(answerText || "");
  const matches = [...t.matchAll(PERSON_REGEX)].map((m) => `${m[1]} ${m[2]}`);
  // pokud není žádné "Jméno Příjmení", false
  return matches.length > 0;
}

function enforceNameMustHaveLink(answerText, userText, fallbackText) {
  const a = String(answerText || "").trim();
  if (!a) return a;

  // jméno v odpovědi + žádný povolený URL => buď doplň navigační linky, nebo fallback
  if (answerContainsPersonName(a) && !answerHasAllowedUrl(a)) {
    const withNav = appendNavLinksIfMissing(a, userText);
    // pokud ani po nav doplnění není žádný povolený url (nemáme mapu), radši fallback
    if (!answerHasAllowedUrl(withNav)) return fallbackText;
    return withNav;
  }
  return a;
}

/* =========================================================
   ✅ HARD COREFERENCE: přepis zájmen -> explicitní osoba
   ========================================================= */

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

/**
 * ✅ FINÁLNÍ INSTRUKCE PRO ASISTENTA (BACKEND)
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Tvým úkolem je pomáhat občanům jako digitální úředník a navigátor po obci ${OBEC_NAZEV}.\n\n` +

    `Odpovídáš výhradně na základě oficiálních veřejných informací obce ${OBEC_NAZEV} (web obce, dokumenty, zveřejněné kontakty).\n` +
    `Nikdy nepoužívej informace z jiných obcí.\n\n` +

    `🚫 ZÁKAZ HÁDÁNÍ A HALUCINACÍ (kritické)\n` +
    `NIKDY nevymýšlej jména osob, funkce, kontakty, ceny, termíny ani postupy.\n` +
    `Jména osob, kontakty, úřední hodiny, ceny a postupy uváděj POUZE tehdy, pokud jsou jasně uvedeny v podkladech.\n\n` +

    `Pokud informace chybí nebo nejsou jednoznačné, napiš přesně:\n` +
    `„Tato informace není v dostupných podkladech obce uvedena.“\n\n` +

    `🧭 ROLE: NAVIGÁTOR + ÚŘEDNÍK\n` +
    `Když odpovídáš, mysli jako obecní úředník: rozpoznej, zda jde o fakt, nebo o postup.\n` +
    `U postupových dotazů (rezervace, ověření podpisu, poplatky, žádosti) uveď kroky a kontakt, pokud jsou v podkladech.\n\n` +

    `🔗 ODKAZY (důležité)\n` +
    `Kdykoliv je to možné, připoj relevantní veřejný odkaz na stránku obce, kde je informace uvedena.\n` +
    `Odkazy dávej pouze úplné (https://…) a z oficiálního webu obce.\n` +
    `Nikdy neposílej odkazy na interní bázi / files / knowledge base.\n\n` +

    `🕒 AKTUÁLNOST\n` +
    `Pokud existuje více verzí informace, upřednostni nejnovější podle data publikace/účinnosti. Pokud datum není, nedoplňuj ho.\n\n` +

    `🧾 FORMÁT\n` +
    `Odpověď:\n(stručně, nebo delší u postupů)\n\n` +
    `Odpovědná osoba / úřad:\n(jméno + funkce, pokud existuje)\n\n` +
    `Kontakt:\n(telefon / e-mail, pokud existuje)\n\n` +
    `Odkazy:\n- Název stránky – https://…\n`
  );
}

/**
 * ✅ POVINNÝ KONTEXT WRAPPER (USER MESSAGE – VŽDY)
 */
function wrapUserQuestion(userText) {
  const t = String(userText || "").trim();
  return `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}. Odpovídej jen z podkladů obce ${OBEC_NAZEV}.\nDOTAZ UŽIVATELE: ${t}`;
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

    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // HARD COREFERENCE
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

    // wrapper
    outgoingMessage = wrapUserQuestion(outgoingMessage);

    // 1) user message
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

    // clean + url normalize
    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    // cena jen u relevantních dotazů
    answer = removePriceSectionIfNotRelevant(answer, msgTrim);

    // fallback jen když fakt nic
    if (!answer) answer = REQUIRED_FALLBACK;

    // když model spadl na fallback, ale dotaz je jasně navigační, vrať navigační odpověď s odkazem
    if (answer.trim() === REQUIRED_FALLBACK && isClearlyNavigationQuestion(msgTrim)) {
      const navOnly = buildNavigationOnlyAnswer(msgTrim);
      if (navOnly) answer = navOnly;
    }

    // přidej navigační odkazy, pokud odpověď nemá žádný povolený URL a máme mapu pro dotaz
    answer = appendNavLinksIfMissing(answer, msgTrim);

    // anti-halucinace: jméno musí mít veřejný odkaz, jinak fallback
    answer = enforceNameMustHaveLink(answer, msgTrim, REQUIRED_FALLBACK);

    return jsonResponse(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
