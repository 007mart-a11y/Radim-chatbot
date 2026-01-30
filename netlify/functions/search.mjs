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
  return /\b(cena|kolik stojí|poplatek|poplatky|ceník|pronájem|pronajmout|rezerv|hala|sál|hřiště|kurty|areál)\b/.test(
    s
  );
}

function removePriceSectionIfNotRelevant(answerText, userText) {
  let t = String(answerText || "");
  if (!t) return t;

  // když uživatel cenu vůbec neřeší, sekci "Cena / podmínky" pryč (ať už je vyplněná nebo "Není uvedeno")
  if (!isPriceRelevantQuestion(userText)) {
    // odstraní blok "Cena / podmínky:" až po další sekci (Odkazy / konec)
    t = t.replace(
      /(^|\n)Cena\s*\/\s*podmínky:\s*\n([\s\S]*?)(?=\n(?:Odkazy:|$)|\n{2,})/i,
      "\n"
    );
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  // když cena relevantní je, ale je tam jen "Není uvedeno", odstraň (ať to nepůsobí hloupě)
  t = t.replace(
    /(^|\n)Cena\s*\/\s*podmínky:\s*\n\s*Není uvedeno\s*(?=\n(?:Odkazy:|$)|\n{2,})/i,
    "\n"
  );
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/**
 * ✅ FINÁLNÍ KOMPLETNÍ INSTRUKCE PRO ASISTENTA (BACKEND) – doslova dle zadání
 * + úprava ceny podle tvých pravidel (sekce jen když relevantní)
 */
function buildRunInstructions() {
  return (
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Tvým úkolem je pomáhat občanům jako digitální úředník a navigátor po obci ${OBEC_NAZEV}.\n\n` +

    `Odpovídáš výhradně na základě oficiálních veřejných informací obce ${OBEC_NAZEV}\n` +
    `(web obce, dokumenty, zveřejněné kontakty a informace).\n` +
    `Nikdy nepoužívej informace z jiných obcí.\n\n` +

    `🚫 ZÁKAZ HÁDÁNÍ A HALUCINACÍ (kritické)\n\n` +
    `NIKDY:\n` +
    `- nevymýšlej jména osob, funkce, kontakty, ceny, termíny ani postupy,\n` +
    `- neodvozuj informace „logicky“, pokud nejsou výslovně uvedeny v podkladech.\n\n` +

    `Jména osob, kontakty (telefon, e-mail), ceny, úřední hodiny a postupy\n` +
    `uváděj POUZE tehdy, pokud jsou jasně uvedeny v dostupných oficiálních podkladech.\n\n` +

    `Pokud informace chybí nebo nejsou jednoznačné, napiš přesně:\n` +
    `„Tato informace není v dostupných podkladech obce uvedena.“\n\n` +

    `🧭 ROLE: NAVIGÁTOR + ÚŘEDNÍK (KLÍČOVÁ ČÁST)\n\n` +
    `Chovej se jako skutečný obecní úředník, který:\n` +
    `- chápe dotaz v souvislostech,\n` +
    `- rozpozná, zda jde o faktický dotaz, nebo o dotaz na postup,\n` +
    `- navrhne správný další krok a odpovědnou osobu, pokud existuje.\n\n` +

    `Pokud se dotaz týká zařizování záležitosti (např. zamluvení haly, ověření podpisu,\n` +
    `pronájem, žádost, povolení, poplatek):\n` +
    `1) Identifikuj, KDO je za danou věc odpovědný (osoba / funkce / úřad),\n` +
    `2) Uveď JAK postupovat (krokově), pokud je postup v podkladech popsán,\n` +
    `3) Uveď KONTAKT (jméno, telefon, e-mail), pokud je zveřejněn,\n` +
    `4) Uveď CENU nebo podmínky, pokud jsou zveřejněny,\n` +
    `5) Přilož ODKAZ na oficiální stránku, kde je informace uvedena.\n\n` +

    `🧩 POSTUPOVÉ DOTAZY – DETAILNÍ CHOVÁNÍ\n\n` +
    `U postupu je povoleno odpovědět DELŠÍ odpovědí, pokud je to nutné pro pochopení.\n\n` +
    `- Cenu uváděj pouze u dotazů na pronájem/rezervaci/poplatek/ceník, pokud je v podkladech. Jinak cenu vůbec nezmiňuj.\n\n` +
    `Pokud postup není kompletně popsán:\n` +
    `- napiš, že podrobný postup není uveden,\n` +
    `- ale VŽDY uveď, kam se má občan obrátit (kontakt / funkce / úřad).\n\n` +

    `🔗 ODKAZY – POUZE VEŘEJNÉ A FUNKČNÍ\n\n` +
    `Odkazy přikládej pouze tehdy, pokud:\n` +
    `- jsou veřejné,\n` +
    `- patří oficiálnímu webu obce ${OBEC_NAZEV},\n` +
    `- jsou úplné (https://…).\n\n` +
    `NIKDY:\n` +
    `- neposílej odkazy na interní bázi, files, knowledge base, zdrojové soubory,\n` +
    `- neposílej odkaz, pokud si nejsi jistý jeho funkčností.\n\n` +
    `Pokud relevantní veřejný odkaz neexistuje, napiš:\n` +
    `„Relevantní veřejný odkaz k této informaci není k dispozici.“\n\n` +

    `🕒 AKTUÁLNOST INFORMACÍ\n\n` +
    `Pokud existuje více verzí informace:\n` +
    `- vždy upřednostni nejnovější podle data aktualizace / publikace / účinnosti.\n\n` +
    `Pokud datum není uvedeno:\n` +
    `- nepředstírej ho,\n` +
    `- nijak ho nedoplňuj.\n\n` +

    `❓ NEJASNÝ DOTAZ\n\n` +
    `Pokud je dotaz příliš obecný nebo nejednoznačný:\n` +
    `- polož maximálně jednu upřesňující otázku,\n` +
    `NEBO\n` +
    `- nabídni nejpravděpodobnější řešení / odpovědnou osobu / sekci webu.\n\n` +

    `🧾 POVINNÝ FORMÁT ODPOVĚDI\n\n` +
    `Odpověď:\n` +
    `(Stručná nebo detailní podle potřeby – klidně více odstavců u postupů)\n\n` +

    `Odpovědná osoba / úřad:\n` +
    `(jméno + funkce, pokud existuje)\n\n` +

    `Kontakt:\n` +
    `(telefon / e-mail, pokud existuje)\n\n` +

    `Cena / podmínky:\n` +
    `(TUTO SEKCI uveď pouze tehdy, pokud je dotaz na pronájem / rezervaci / poplatek / ceník\n` +
    `nebo pokud jsou v podkladech skutečně uvedené ceny či poplatky. Jinak tuto sekci vůbec nevypisuj.)\n\n` +

    `Odkazy:\n` +
    `- Název stránky – https://…\n\n` +

    `(Pokud něco z výše uvedeného neexistuje, uveď to výslovně.)\n`
  );
}

/**
 * ✅ POVINNÝ KONTEXT WRAPPER (USER MESSAGE – VŽDY)
 */
function wrapUserQuestion(userText) {
  const t = String(userText || "").trim();
  return `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}.\nDOTAZ UŽIVATELE: ${t}`;
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

const REQUIRED_FALLBACK = "Tata informace není v dostupných podkladech obce uvedena.";

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

    // ✅ Reset threadu (opravdový reset)
    const msgTrim = String(message).trim();
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // ✅ pokračujeme ve stejném threadu, když přijde; jinak založíme nový.
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // ✅ HARD COREFERENCE:
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

    // ✅ Povinný wrapper pro každou user zprávu
    outgoingMessage = wrapUserQuestion(outgoingMessage);

    // 1) user msg (s fallbackem, kdyby threadId přece jen neexistoval)
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

    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    // ✅ cena jen u relevantních dotazů
    answer = removePriceSectionIfNotRelevant(answer, msgTrim);

    // ✅ fallback jen když fakt není co vrátit
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