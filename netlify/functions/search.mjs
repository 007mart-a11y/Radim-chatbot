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

const KEY_LINKS = {
  homepage: "https://www.obec-radim.cz/",
  kontakty: "https://www.obec-radim.cz/urad/kontakty/",
  uredniDeska: "https://www.obec-radim.cz/urad/uredni-deska/",
  aktuality: "https://www.obec-radim.cz/aktualne/",
  kalendar: "https://www.obec-radim.cz/?calendar=&lang=cs",
  hledani: "https://www.obec-radim.cz/?hledej=&lang=cs",
};

const REQUIRED_FALLBACK = "Tato informace není v dostupných podkladech obce uvedena.";

/* =========================================================
   Utils
   ========================================================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function api(pathUrl, { method = "GET", body, headers = {} } = {}, apiKey) {
  const res = await fetch(`${OPENAI_BASE_URL}${pathUrl}`, {
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
    const err = new Error(`${method} ${pathUrl} failed: ${msg}`);
    err.status = res.status;
    err.path = pathUrl;
    err.method = method;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

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

  return parts.join("\n\n").trim();
}

function extractMessageText(messageObj) {
  if (!messageObj || !Array.isArray(messageObj.content) || !messageObj.content.length) return "";
  const parts = messageObj.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function stripInternalLeaks(text) {
  let t = String(text || "");

  t = t.replace(/^\s*Zdroj\s*:\s*.*$/gim, "");
  t = t.replace(/^\s*Zdroje?\s*:\s*.*$/gim, "");

  t = t.replace(/\b\d{2}_[A-Z0-9_]+\.(txt|md)\b/gi, "");
  t = t.replace(/\b99_FULL_[A-Z0-9_]+\b/gi, "");
  t = t.replace(/\b00_PEOPLE_[A-Z0-9_]+\b/gi, "");

  t = t.replace(/\b(knowledge\s*base|vector\s*store|file_search|internal\s*source)\b/gi, "");

  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function cleanAnswer(text) {
  let t = String(text || "");

  // file_search citace
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // whitespace
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // interní úniky
  t = stripInternalLeaks(t);

  // domena bez tecky
  t = t.replace(/obec-radimcz/gi, "obec-radim.cz");

  return t;
}

/* =========================================================
   ✅ URL normalization (100% fix https://https)
   ========================================================= */

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

  // ořez koncové interpunkce
  u = u.replace(/[)\]}>,.;:!?]+$/g, "");

  // ✅ tvrdě: oprav všechny formy zdvojeného schématu (kdekoliv na začátku)
  u = u.replace(/^https?:\/\/https?:\/\//i, "https://");
  u = u.replace(/^http:\/\/https:\/\//i, "https://");
  u = u.replace(/^https:\/\/http:\/\//i, "https://");

  // opakovaně, kdyby to bylo víckrát
  while (/^(https?:\/\/)(https?:\/\/)+/i.test(u)) {
    u = u.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$1");
  }

  // "www.https://"
  u = u.replace(/^www\.(https?:\/\/)/i, "$1");

  // fix domény bez tečky
  u = u.replace(/\/\/www\.obec-radimcz/gi, "//www.obec-radim.cz");
  u = u.replace(/\/\/obec-radimcz/gi, "//obec-radim.cz");
  u = u.replace(/obec-radimcz/gi, "obec-radim.cz");

  // fix chybějící ".html" (…-1html → …-1.html)
  u = u.replace(/(\d+)html(\b|\/|\?|#)/gi, "$1.html$2");

  // fix useknutých koncovek u e_download (např. obsah479_1docx -> obsah479_1.docx)
  u = u.replace(/(obsah\d+_\d+)(docx|pdf)(\b|&|$)/gi, "$1.$2$3");

  // občas useknuté .pdf
  u = u.replace(/\.pd(\b|$)/i, ".pdf$1");

  // dvojité //
  u = u.replace(/([^:]\/)\/+/g, "$1");

  // finální ořez
  u = u.replace(/[)\]}>,.;:!?]+$/g, "");

  return u;
}

function normalizeUrlsInText(text) {
  let t = String(text || "");
  if (!t) return t;

  const re = /\bhttps?:\/\/[^\s<>"'(){}\[\]]+/gi;

  t = t.replace(re, (m) => {
    const fixed = normalizeSingleUrl(m);
    if (!isAllowedDomain(fixed)) return "";
    return fixed;
  });

  // dočisti mezery po vyhozených url
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}

/* =========================================================
   ✅ Deterministické hledání v FULL (DOCUMENTS INDEX)
   ========================================================= */

let _fullCache = null;
let _docsCache = null;

function readFullText() {
  if (_fullCache) return _fullCache;
  try {
    const p = path.join(process.cwd(), "knowledge", "99_FULL_obec_radim.txt");
    if (!fs.existsSync(p)) return "";
    _fullCache = fs.readFileSync(p, "utf-8");
    return _fullCache;
  } catch {
    return "";
  }
}

function parseDocumentsIndex(fullText) {
  if (_docsCache) return _docsCache;

  const t = String(fullText || "");
  const docs = [];
  const start = t.indexOf("=== DOCUMENTS INDEX");
  if (start === -1) {
    _docsCache = docs;
    return docs;
  }

  const slice = t.slice(start);
  const lines = slice.split("\n");

  for (const line of lines) {
    // konec indexu typicky začíná "==============================" nebo "=== PAGES"
    if (line.includes("=== PAGES")) break;
    if (!line.includes("|")) continue;
    if (/Formát položek/i.test(line)) continue;

    // TYPE | DATE | TITLE | URL | FOUND_ON
    const parts = line.split("|").map((x) => x.trim());
    if (parts.length < 5) continue;

    const [type, date, title, url, foundOn] = parts;
    if (!url || !url.startsWith("http")) continue;

    docs.push({
      type: type || "",
      date: date || "",
      title: title || "",
      url: normalizeSingleUrl(url),
      foundOn: normalizeSingleUrl(foundOn),
    });
  }

  _docsCache = docs;
  return docs;
}

function tokenize(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 18);
}

function scoreDoc(doc, tokens) {
  const hay = `${doc.type} ${doc.title} ${doc.foundOn}`.toLowerCase();
  let s = 0;
  for (const tok of tokens) {
    if (tok.length <= 2) continue;
    if (hay.includes(tok)) s += 3;
  }

  // bonusy pro časté intent
  if (tokens.includes("přihláška") || tokens.includes("prihlaska")) {
    if (hay.includes("přihlášk") || hay.includes("prihlask")) s += 6;
  }
  if (tokens.includes("odpad") || tokens.includes("odpadu") || tokens.includes("bioodpad")) {
    if (hay.includes("odpad")) s += 4;
  }
  if (tokens.includes("poplatek") || tokens.includes("poplatky")) {
    if (hay.includes("poplatek") || hay.includes("poplat")) s += 4;
  }
  if (tokens.includes("vyhláška") || tokens.includes("vyhlaska") || tokens.includes("nařízení") || tokens.includes("narizeni")) {
    if (hay.includes("vyhl") || hay.includes("nař") || hay.includes("nariz")) s += 3;
  }

  return s;
}

function findBestDocs(query, limit = 5) {
  const full = readFullText();
  if (!full) return [];
  const docs = parseDocumentsIndex(full);
  if (!docs.length) return [];

  const tokens = tokenize(query);
  const scored = docs
    .map((d) => ({ d, s: scoreDoc(d, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.d);

  return scored;
}

function buildDocHintsBlock(query) {
  const best = findBestDocs(query, 6);
  if (!best.length) return "";

  // jen povolené domény a opravené url
  const lines = best
    .map((d) => {
      const u = normalizeSingleUrl(d.url);
      if (!isAllowedDomain(u)) return null;
      const label = d.title || d.type || "Dokument";
      return `- ${label} — ${u}`;
    })
    .filter(Boolean);

  if (!lines.length) return "";

  return (
    `KANDIDÁTNÍ ODKAZY (použij PŘESNĚ tyto, nevymýšlej jiné):\n` +
    lines.join("\n") +
    `\n`
  );
}

/* =========================================================
   Dotazy
   ========================================================= */

function isPersonRoleQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(kdo\s+je|kdo\s+vede|kdo\s+má\s+na\s+starosti|starosta|starostka|předseda|predseda|kontakt\s+na)\b/.test(
    s
  );
}

function isDocLikeQuestion(userText) {
  const s = String(userText || "").toLowerCase();
  return /\b(vyhlášk|vyhlask|nařízení|narizeni|dokument|ke\s+stažení|ke\s+stazeni|přihlášk|prihlask|poplatek|poplatky|odpad|odpadu|svoz)\b/.test(
    s
  );
}

function looksLikeFallback(answer) {
  const t = String(answer || "").toLowerCase();
  return t.includes("tato informace není v dostupných podkladech obce uvedena");
}

function buildRunInstructions({ mode = "normal" } = {}) {
  const common =
    `Jsi oficiální AI asistent obce ${OBEC_NAZEV}.\n` +
    `Pracuješ výhradně s podklady v asistentovi (00_PEOPLE_obec_radim.txt a 99_FULL_obec_radim.txt).\n` +
    `NEIMPROVIZUJ. Nic nevymýšlej.\n` +
    `NIKDY nevypisuj názvy interních souborů ani "Zdroj: ...".\n` +
    `Odkazy uváděj pouze z podkladů nebo z kandidátních odkazů, které ti poskytnu v dotazu.\n\n` +
    `Priorita zdrojů:\n` +
    `- osoby/funkce: nejdřív PEOPLE, pak FULL\n` +
    `- ostatní: FULL\n\n` +
    `Pokud informace není v podkladech jednoznačně uvedená, napiš přesně:\n` +
    `„${REQUIRED_FALLBACK}“\n\n` +
    `Formát odpovědi:\n` +
    `Odpověď:\n(1–5 vět, věcně)\n\n` +
    `Odpovědná osoba / úřad:\n(jméno+funkce jen pokud existuje, jinak "Obecní úřad Radim")\n\n` +
    `Kontakt:\n(telefon/e-mail jen pokud existuje, jinak "Není uvedeno")\n\n` +
    `Odkazy:\n- Název — https://...\n`;

  if (mode === "hard") {
    return (
      common +
      `\nHARD:\n` +
      `Aktivně dohledávej relevantní pasáž v podkladech.\n` +
      `U dokumentů hledej v DOCUMENTS INDEX a preferuj přímé odkazy ke stažení.\n`
    );
  }

  if (mode === "people_strict") {
    return (
      common +
      `\nPEOPLE-STRICT:\n` +
      `U dotazů na osoby je povinné nejprve odpovědět z PEOPLE.\n` +
      `Pokud údaj v PEOPLE není, teprve pak hledej ve FULL.\n`
    );
  }

  return common;
}

function wrapUserQuestion(userText, hintsBlock = "") {
  const t = String(userText || "").trim();
  return (
    `KONTEXT: Tento chat je pouze pro obec ${OBEC_NAZEV}. Uživatel chce přesnou odpověď a pokud existuje, tak i relevantní veřejný odkaz.\n` +
    (hintsBlock ? `${hintsBlock}\n` : "") +
    `DOTAZ UŽIVATELE: ${t}`
  );
}

/* =========================================================
   Coreference (zájmena -> poslední osoba)
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

/* =========================================================
   Thread helpers
   ========================================================= */

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

async function runAssistant({ threadId, assistantId, apiKey, instructions, temperature = 0 }) {
  const run = await api(
    `/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        instructions,
        temperature,
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
      return { ok: false, error: "Run requires action.", status };
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

/* =========================================================
   Handler
   ========================================================= */

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

    if (msgTrim.toLowerCase() === "reset") {
      const created = await api("/threads", { method: "POST" }, apiKey);
      return jsonResponse(200, { ok: true, answer: "Resetováno.", thread_id: created.id });
    }

    let threadId = await ensureThreadId(body?.thread_id, apiKey);

    // coreference
    let outgoingMessage = msgTrim;
    const needRewrite =
      isContactQuestion(outgoingMessage) &&
      hasPronounReference(outgoingMessage) &&
      !messageAlreadyContainsPersonName(outgoingMessage);

    if (needRewrite) {
      const lastPerson = await getLastReferencedPersonFromThread(threadId, apiKey, 12);
      if (lastPerson) outgoingMessage = rewriteToExplicitPersonQuestion(outgoingMessage, lastPerson);
    }

    // ✅ Kandidátní odkazy pro dokumenty (deterministicky)
    const hints = isDocLikeQuestion(msgTrim) ? buildDocHintsBlock(msgTrim) : "";
    outgoingMessage = wrapUserQuestion(outgoingMessage, hints);

    threadId = await addUserMessageWithFallback(threadId, outgoingMessage, apiKey);

    const mode = isPersonRoleQuestion(msgTrim) ? "people_strict" : "normal";

    // 1) run
    let r = await runAssistant({
      threadId,
      assistantId,
      apiKey,
      instructions: buildRunInstructions({ mode }),
      temperature: 0,
    });

    // 2) fallback -> hard
    if (r.ok && looksLikeFallback(r.answer)) {
      const r2 = await runAssistant({
        threadId,
        assistantId,
        apiKey,
        instructions: buildRunInstructions({ mode: "hard" }),
        temperature: 0,
      });
      if (r2.ok && r2.answer) r = r2;
    }

    let answer = r.ok ? r.answer : "";

    answer = cleanAnswer(answer);
    answer = normalizeUrlsInText(answer);

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
