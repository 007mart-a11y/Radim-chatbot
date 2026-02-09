// netlify/functions/search.mjs
// Netlify Functions (Node 18+), OpenAI Assistants v2 přes fetch
// ENV: OPENAI_API_KEY, ASSISTANT_ID
// Request JSON: { message: string, thread_id?: string }
// Response JSON: { ok: true, answer: string, thread_id: string } | { ok:false, error, details? }

import fs from "node:fs";
import path from "node:path";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OBEC_NAZEV = "Radim";

// ✅ nastav si “dnes” (můžeš později udělat dynamicky)
const TODAY_ISO = "2026-02-09"; // YYYY-MM-DD

// Kanonické (bezpečné) rozcestníky
const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/",
  kalendar: "https://www.obec-radim.cz/?calendar=&lang=cs",
  hledani: "https://www.obec-radim.cz/?hledej=&lang=cs",
};

// ============================================
// ✅ Local knowledge (deterministická vrstva)
// ============================================

const FULL_FILE_CANDIDATES = [
  "knowledge/99_FULL_obec_radim.txt",
  "public/knowledge/99_FULL_obec_radim.txt",
  "99_FULL_obec_radim.txt",
];

let _cache = {
  fullText: null,
  loadedAt: 0,
  pages: null,
};

function safeReadText(rel) {
  try {
    const p = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function loadFullText() {
  const now = Date.now();
  if (_cache.fullText && now - _cache.loadedAt < 10 * 60 * 1000) return _cache.fullText;

  for (const rel of FULL_FILE_CANDIDATES) {
    const t = safeReadText(rel);
    if (t && t.length > 50_000) {
      _cache.fullText = t;
      _cache.loadedAt = now;
      _cache.pages = null;
      return t;
    }
  }

  _cache.fullText = null;
  _cache.pages = null;
  _cache.loadedAt = now;
  return null;
}

function buildPagesIndex(fullText) {
  if (!fullText) return null;

  // URL: ...
  // TITLE: ...
  // CONTENT: ...
  const pages = new Map();

  // Pozn.: některé stránky nemají TITLE, tak ho nevyžadujeme
  const re =
    /=== PAGE[\s\S]*?URL:\s*(.+?)\n(?:TITLE:\s*([\s\S]*?)\n)?CONTENT:\n([\s\S]*?)(?=\n={10,}|\n=== PAGE|\s*$)/g;

  let m;
  while ((m = re.exec(fullText))) {
    const url = String(m[1] || "").trim();
    const content = String(m[3] || "").trim();
    if (url && content) pages.set(url, content);
  }
  return pages;
}

function getPages() {
  if (_cache.pages) return _cache.pages;
  const full = loadFullText();
  if (!full) return null;
  _cache.pages = buildPagesIndex(full);
  return _cache.pages;
}

function getPageContentByUrl(url) {
  const pages = getPages();
  if (!pages) return null;
  return pages.get(url) || null;
}

function normalizeCzech(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ============================================
// ✅ Intent detection (hlavní změna)
// ============================================

function isEventsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(akce|kalendar|kalendar akci|program|pro deti|detske|co se kona|co je v radimi|co je noveho|nejnovejsi|aktualne)\b/.test(
    s
  );
}

function isExplicitHistoryQuestion(q) {
  const s = normalizeCzech(q);

  // uživatel chce minulost: "co bylo", "loni", "v roce 2024", "minuly rok", apod.
  if (/\b(co bylo|drive|minule|minuly|loni|predloni|historie|archiv)\b/.test(s)) return true;

  // pokud obsahuje explicitní rok <= 2025 (v době 2026) – bereme jako "historický dotaz"
  const years = [...s.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.some((y) => y <= 2025)) return true;

  return false;
}

function isLatestNewsQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(nejnovejsi|co je noveho|aktualne|posledni|nove na uredni desce)\b/.test(s);
}

// ============================================
// ✅ Deterministické odpovědi (bez LLM)
// ============================================

function isKontaktyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(kontakt|kontakty|telefon|email|e-mail|mail|datova schranka|datova schrank)\b/.test(s);
}

function isUredniHodinyQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(uredni hodiny|kdy ma urad otevreno|oteviraci doba|kdy je otevreno)\b/.test(s);
}

function isBioodpadQuestion(q) {
  const s = normalizeCzech(q);
  return /\b(bioodpad|skladka bioodpadu|kam s bioodpadem|bio odpad|kompost|zeleny odpad)\b/.test(s);
}

function extractContactsFromKontaktyPage(content) {
  const phones = [...content.matchAll(/\+420\s?\d{3}\s?\d{3}\s?\d{3}|\b\d{3}\s?\d{3}\s?\d{3}\b/g)]
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const emails = [...content.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((m) => m[0].trim())
    .filter(Boolean);

  const hoursLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => normalizeCzech(l).startsWith("streda")) || "";

  return {
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    hoursLine,
  };
}

function makeKontaktyAnswer() {
  const kontaktyUrl = KEY_LINKS.kontakty;
  const page = getPageContentByUrl(kontaktyUrl);
  const searchPage = getPageContentByUrl(KEY_LINKS.hledani);

  const src = page || searchPage;
  if (!src) return null;

  const { phones, emails } = extractContactsFromKontaktyPage(src);
  const phone = phones?.[0] || "";
  const email = emails?.[0] || "";

  const contactLines = [];
  if (phone) contactLines.push(`Telefon: ${phone}`);
  if (email) contactLines.push(`E-mail: ${email}`);

  return (
    `Odpověď:\n` +
    `Kontakty na Obecní úřad Radim jsou uvedeny níže.\n\n` +
    `Odpovědná osoba / úřad:\nObecní úřad Radim\n\n` +
    `Kontakt:\n${contactLines.length ? contactLines.join(", ") : "Není uvedeno"}\n\n` +
    `Odkazy:\n- Kontakty a úřední hodiny — ${kontaktyUrl}\n`
  );
}

function makeUredniHodinyAnswer() {
  const kontaktyUrl = KEY_LINKS.kontakty;
  const page = getPageContentByUrl(kontaktyUrl) || getPageContentByUrl(KEY_LINKS.hledani);
  if (!page) return null;

  const { phones, emails, hoursLine } = extractContactsFromKontaktyPage(page);

  let hours = "";
  if (hoursLine) {
    const m = hoursLine.match(/středa\s*:\s*([0-9]{1,2}:[0-9]{2})\s*-\s*([0-9]{1,2}:[0-9]{2})/i);
    if (m) hours = `Úřední hodiny Obecního úřadu Radim jsou ve středu od ${m[1]} do ${m[2]}.`;
    else hours = `Úřední hodiny jsou uvedeny na stránce Kontaktů.`;
  } else {
    hours = `Úřední hodiny jsou uvedeny na stránce Kontaktů.`;
  }

  const phone = phones?.[0] || "";
  const email = emails?.[0] || "";

  const contactLines = [];
  if (phone) contactLines.push(`Telefon: ${phone}`);
  if (email) contactLines.push(`E-mail: ${email}`);

  return (
    `Odpověď:\n${hours}\n\n` +
    `Odpovědná osoba / úřad:\nObecní úřad Radim\n\n` +
    `Kontakt:\n${contactLines.length ? contactLines.join(", ") : "Není uvedeno"}\n\n` +
    `Odkazy:\n- Kontakty a úřední hodiny — ${kontaktyUrl}\n`
  );
}

function makeBioodpadAnswer() {
  const bioUrl = "https://www.obec-radim.cz/urad/skladka-bioodpadu/";
  const content = getPageContentByUrl(bioUrl);
  if (!content) return null;

  const parcel = (content.match(/\bparcele?\s+KN\s+\d+\b/i) || [])[0] || "";
  const zaHrbitovem = /za\s+hřbitovn/i.test(content) ? "za hřbitovní zdí" : "";
  const nonstop = /nepřetržit/i.test(content) ? "V tuto chvíli je skládka otevřena nepřetržitě." : "";

  let where = "";
  if (parcel && zaHrbitovem) where = `Skládka bioodpadu v Radimi se nachází na ${parcel} v k. ú. Radim, ${zaHrbitovem}.`;
  else if (parcel) where = `Skládka bioodpadu v Radimi se nachází na ${parcel} v k. ú. Radim.`;
  else where = `Umístění skládky bioodpadu je uvedeno na webu obce.`;

  const kontakty = makeKontaktyAnswer();
  let contactLine = "Není uvedeno";
  if (kontakty) {
    const m = kontakty.match(/Kontakt:\n([\s\S]*?)\n\nOdkazy:/);
    if (m && m[1]) contactLine = m[1].trim();
  }

  return (
    `Odpověď:\n${where} ${nonstop}`.trim() +
    `\n\nOdpovědná osoba / úřad:\nObecní úřad Radim\n\n` +
    `Kontakt:\n${contactLine}\n\n` +
    `Odkazy:\n- Skládka bioodpadu — ${bioUrl}\n`
  );
}

// ============================================
// ✅ LLM část (Assistants) + tvrdé filtrování
// ============================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
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
    err.path = path_;
    err.method = method;
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
  const parts = msg.content.map((c) => (c?.type === "text" ? c.text?.value : "")).filter(Boolean);
  return parts.join("\n\n");
}

function stripInternalLeaks(text) {
  let t = String(text || "");
  t = t.replace(/^\s*Zdroj\s*:\s*.*$/gim, "");
  t = t.replace(/^\s*Zdroje?\s*:\s*.*$/gim, "");
  t = t.replace(/\b\d{2}_[A-Z0-9_]+\.(txt|md)\b/gi, "");
  t = t.replace(/\b99_FULL_[A-Z0-9_]+\b/gi, "");
  t = t.replace(/\b(knowledge\s*base|vector\s*store|file_search|internal\s*source)\b/gi, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function cleanAnswer(text) {
  let t = String(text || "");
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");
  t = t.replace(/(https?:\/\/[^\s)\]]+)[\.,;:!?]+/g, "$1");
  t = t.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  t = stripInternalLeaks(t);
  return t;
}

function isAllowedDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const allowed = new Set(["obec-radim.cz", "www.obec-radim.cz", "zsradim.cz", "www.zsradim.cz"]);
    return allowed.has(host);
  } catch {
    return false;
  }
}

function normalizeSingleUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return u;

  u = u.replace(/[)\]}>,.;:!?]+$/g, "");
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");
  u = u.replace(/^https?:\/\/https?:\/\//i, "https://");
  u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");

  u = u.replace(/https:\/\/www\.obec-radim\.cz\/hledej=&lang=cs/i, KEY_LINKS.hledani);
  u = u.replace(/https:\/\/www\.obec-radim\.cz\/\?hledej=&lang=cs/i, KEY_LINKS.hledani);
  u = u.replace(/https:\/\/www\.obec-radim\.cz\/\?calendar=&lang=cs/i, KEY_LINKS.kalendar);

  u = u.replace(/\/\/www\.obec-radimcz/gi, "//www.obec-radim.cz");
  u = u.replace(/\/\/obec-radimcz/gi, "//obec-radim.cz");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");

  u = u.replace(/(\d+)html(\b|\/|\?|#)/gi, "$1.html$2");
  u = u.replace(/(obsah\d+_\d+)(pdf|docx|xlsx|xls|doc|pptx)(?=(&|$))/gi, "$1.$2");
  u = u.replace(/(\d+cs_?\d*)(pdf|docx|xlsx|xls|doc|pptx)(?=(&|$))/gi, "$1.$2");
  u = u.replace(/\.pd$/i, ".pdf");
  u = u.replace(/([^:]\/)\/+/g, "$1");

  return u;
}

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

// ============================================
// ✅ “Akce” filtr: nepustit staré roky
// ============================================

function extractYearsFromText(text) {
  const s = String(text || "");
  const years = [...s.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  return [...new Set(years)];
}

function shouldBlockPastEventsAnswer(userQ, answer) {
  // pokud se uživatel explicitně ptá na minulost, neblokujeme
  if (isExplicitHistoryQuestion(userQ)) return false;

  // blokujeme jen pro “akce/nejnovější”
  if (!isEventsQuestion(userQ) && !isLatestNewsQuestion(userQ)) return false;

  // pokud odpověď obsahuje roky výrazně v minulosti, je to podezřelé
  const years = extractYearsFromText(answer);
  if (!years.length) return false;

  // v kontextu 2026 nechceme běžně vracet 2023/2024/2025 jako “plánované”
  return years.some((y) => y <= 2025);
}

function makeNoUpcomingEventsFallback(userQ) {
  // stručná oficiální odpověď + odkazy
  const wantsKids = /\b(deti|detske|pro deti)\b/.test(normalizeCzech(userQ));
  const prefix = wantsKids ? "plánované akce pro děti" : "plánované akce";
  return (
    `Odpověď:\n` +
    `Na webu obce ${OBEC_NAZEV} nejsou k datu ${TODAY_ISO.split("-").reverse().join(". ")} v dostupných podkladech uvedeny žádné ${prefix}.\n\n` +
    `Odpovědná osoba / úřad:\nObecní úřad ${OBEC_NAZEV}\n\n` +
    `Kontakt:\nViz kontakty obce.\n\n` +
    `Odkazy:\n` +
    `- Kalendář akcí — ${KEY_LINKS.kalendar}\n` +
    `- Aktuality — ${KEY_LINKS.aktuality}\n`
  );
}

// ============================================
// ✅ Instructions (hlavní změna: datum + pravidla pro akce)
// ============================================

function buildRunInstructions(userQ) {
  const todayCz = TODAY_ISO.split("-").reverse().join(". ");
  const wantsEvents = isEventsQuestion(userQ) || isLatestNewsQuestion(userQ);
  const allowsHistory = isExplicitHistoryQuestion(userQ);

  let rules =
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Dnes je ${todayCz}.\n` +
    `Odpovídáš výhradně z oficiálních podkladů obce (web, dokumenty, úřední deska) dostupných v nástrojích asistenta.\n` +
    `Nevymýšlej fakta. Pokud údaj není v podkladech, napiš přesně: "Tato informace není v dostupných podkladech obce uvedena."\n\n`;

  if (wantsEvents && !allowsHistory) {
    rules +=
      `PRAVIDLA PRO AKCE / AKTUÁLNÍ INFORMACE:\n` +
      `- Uváděj pouze položky, které jsou aktuální nebo budoucí (nevracej staré akce z let minulých).\n` +
      `- Pokud v podkladech nejsou žádné budoucí akce, napiš to na rovinu a přidej odkazy na kalendář a aktuality.\n\n`;
  }

  rules +=
    `Formát odpovědi (dodrž vždy):\n` +
    `Odpověď:\n...\n\nOdpovědná osoba / úřad:\n...\n\nKontakt:\n...\n\nOdkazy:\n- ... — https://...\n\n` +
    `Odkazy uváděj jen pokud jsou v podkladech a nejlépe přímé (e_download.php apod.).\n`;

  return rules;
}

function wrapUserQuestion(userText) {
  const t = String(userText || "").trim();
  return `KONTEXT: Tento chat slouží výhradně pro obec ${OBEC_NAZEV}.\nDOTAZ UŽIVATELE: ${t}`;
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
    if (status !== "completed") return { ok: false, error: "Run failed", status };
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

    const msgTrim = String(message).trim();

    // Reset threadu
    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    // Thread
    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // ✅ 1) Deterministické FAQ (pokud máme FULL v deployi)
    let deterministic = null;

    if (isBioodpadQuestion(msgTrim)) deterministic = makeBioodpadAnswer();
    else if (isUredniHodinyQuestion(msgTrim)) deterministic = makeUredniHodinyAnswer();
    else if (isKontaktyQuestion(msgTrim)) deterministic = makeKontaktyAnswer();

    if (deterministic) {
      deterministic = normalizeUrlsInText(cleanAnswer(deterministic));
      return jsonResponse(200, { ok: true, answer: deterministic, thread_id: threadId });
    }

    // ✅ 2) Fallback na Assistants (pro zbytek)
    let outgoingMessage = wrapUserQuestion(msgTrim);
    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    const r = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildRunInstructions(msgTrim),
    });

    let answer = r.ok ? r.answer : "";
    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

    if (!answer) answer = "Tato informace není v dostupných podkladech obce uvedena.";

    // ✅ 3) TVRDÝ filtr pro akce/nejnovější: nepustíme staré roky
    if (shouldBlockPastEventsAnswer(msgTrim, answer)) {
      answer = makeNoUpcomingEventsFallback(msgTrim);
      answer = normalizeUrlsInText(cleanAnswer(answer));
      return jsonResponse(200, { ok: true, answer, thread_id: threadId });
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
