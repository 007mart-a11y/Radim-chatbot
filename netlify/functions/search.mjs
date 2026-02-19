// netlify/functions/search.mjs
import fs from "node:fs";
import path from "node:path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// optional debug: return snippets + routing in response
const DEBUG = String(process.env.DEBUG_SEARCH || "").toLowerCase() === "1";

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": ALLOW_ORIGIN,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
  });
}

function readLocalFile(relPath) {
  try {
    const p = path.join(process.cwd(), relPath);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/* -------------------- FILE LAYERS (tvá struktura) -------------------- */

const FILE_CORE = "00_CORE_obec_radim.txt";
const FILE_PEOPLE = "00_PEOPLE_obec_radim.txt";
const FILE_WEB_CURRENT = "01_WEB_TEXT_CURRENT.txt";
const FILE_DOWNLOADS_INDEX = "02_DOWNLOADS_INDEX_ALL.txt";
const FILE_DOCS_CURRENT = "03_DOCS_CONTENT_CURRENT.txt";

function normName(s) {
  return String(s || "").toLowerCase();
}

function isFile(filename, target) {
  const f = normName(filename);
  const t = normName(target);
  // někdy filename může být jen část / bez cesty
  return f.includes(t);
}

/* -------------------- QUERY ROUTING -------------------- */

function isPeopleQuery(q) {
  const t = normName(q);
  return (
    t.includes("starost") ||
    t.includes("místostarost") ||
    t.includes("mistostarost") ||
    t.includes("zastupitel") ||
    t.includes("radní") ||
    t.includes("radni") ||
    t.includes("tajemník") ||
    t.includes("tajemnik") ||
    t.includes("účetní") ||
    t.includes("ucetni") ||
    t.includes("kontakt") ||
    t.includes("telefon") ||
    t.includes("email") ||
    t.includes("e-mail") ||
    t.includes("kdo je") ||
    t.includes("vedení") ||
    t.includes("vedeni")
  );
}

function isFeesOrDocsQuery(q) {
  const t = normName(q);
  return (
    t.includes("poplatek") ||
    t.includes("sazba") ||
    t.includes("vyhláška") ||
    t.includes("vyhlaska") ||
    t.includes("obecně závazná") ||
    t.includes("obecne zavazna") ||
    t.includes("odpad") ||
    t.includes("pes") ||
    t.includes("stočné") ||
    t.includes("stocne") ||
    t.includes("vodné") ||
    t.includes("vodne") ||
    t.includes("cena") ||
    t.includes("kolik") ||
    t.includes("platí") ||
    t.includes("plati")
  );
}

function isLatestWebQuery(q) {
  const t = normName(q);
  return (
    t.includes("aktuálně") ||
    t.includes("aktualne") ||
    t.includes("poslední") ||
    t.includes("posledni") ||
    t.includes("nejnovější") ||
    t.includes("nejnovejsi") ||
    t.includes("kalendář") ||
    t.includes("kalendar") ||
    t.includes("akce") ||
    t.includes("událost") ||
    t.includes("udalost") ||
    t.includes("rozhlas") ||
    t.includes("hlášení") ||
    t.includes("hlaseni") ||
    t.includes("úřední deska") ||
    t.includes("uredni deska")
  );
}

function routeQuery(q) {
  if (isPeopleQuery(q)) return "PEOPLE";
  if (isFeesOrDocsQuery(q)) return "DOCS";
  if (isLatestWebQuery(q)) return "LATEST_WEB";
  return "GENERAL";
}

/* -------------------- SEARCH -------------------- */

async function vectorSearch(query, n = 30) {
  const r = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ query, max_num_results: Math.min(n, 50) }),
  });

  const res = await r.json().catch(() => ({}));
  return Array.isArray(res?.data) ? res.data : [];
}

function scoreBonusForQuery(snippetText, filename = "", route = "GENERAL") {
  const t = normName(snippetText);
  const f = normName(filename);
  let bonus = 0;

  // roky – preferuj nejnovější
  if (t.includes("2026")) bonus += 2.0;
  if (t.includes("2025")) bonus += 1.5;
  if (t.includes("2024")) bonus += 0.7;
  if (t.includes("pozbývá platnosti") || t.includes("pozbyva platnosti") || t.includes("zrušuje se") || t.includes("zrusi se")) {
    bonus -= 1.0;
  }

  // route-aware boost
  if (route === "PEOPLE") {
    if (f.includes("00_people")) bonus += 4.0;
    if (f.includes("00_core")) bonus += 1.0;
    // ostatní vrstvy při people dotazu spíš škodí
    if (f.includes("03_docs") || f.includes("02_downloads") || f.includes("01_web")) bonus -= 1.2;
  }

  if (route === "DOCS") {
    if (f.includes("03_docs")) bonus += 3.5;
    if (f.includes("02_downloads")) bonus += 1.5; // index může pomoct najít link
    if (f.includes("00_core")) bonus += 0.8;
    if (f.includes("00_people")) bonus -= 0.8;
  }

  if (route === "LATEST_WEB") {
    if (f.includes("01_web")) bonus += 3.0;
    if (f.includes("00_core")) bonus += 1.0;
    if (f.includes("03_docs")) bonus -= 0.5;
  }

  if (route === "GENERAL") {
    if (f.includes("00_core")) bonus += 2.0;
    if (f.includes("01_web")) bonus += 1.0;
    if (f.includes("00_people")) bonus += 0.5;
  }

  return bonus;
}

function filterByRoute(results, route) {
  const out = [];

  for (const r of results) {
    const fn = r.filename || "";

    if (route === "PEOPLE") {
      // primárně people, sekundárně core
      if (isFile(fn, FILE_PEOPLE) || isFile(fn, "00_people")) out.push(r);
      else if (isFile(fn, FILE_CORE) || isFile(fn, "00_core")) out.push(r);
    } else if (route === "DOCS") {
      // primárně obsah dokumentů, sekundárně index, terciálně core
      if (isFile(fn, FILE_DOCS_CURRENT) || isFile(fn, "03_docs")) out.push(r);
      else if (isFile(fn, FILE_DOWNLOADS_INDEX) || isFile(fn, "02_downloads")) out.push(r);
      else if (isFile(fn, FILE_CORE) || isFile(fn, "00_core")) out.push(r);
    } else if (route === "LATEST_WEB") {
      // primárně web current, sekundárně core
      if (isFile(fn, FILE_WEB_CURRENT) || isFile(fn, "01_web")) out.push(r);
      else if (isFile(fn, FILE_CORE) || isFile(fn, "00_core")) out.push(r);
    } else {
      // GENERAL: ber všechno, ale bez extrémního balastu
      out.push(r);
    }
  }

  // fallback: když filtr vyhodí všechno, vrať původní
  return out.length ? out : results;
}

/* -------------------- URL FIX -------------------- */

function stripTrailingJunk(u) {
  return String(u)
    .trim()
    .replace(/[)\].,;:!?]+$/g, "")
    .replace(/[】》〉»]+$/g, "")
    .replace(/["'`]+$/g, "");
}

function safeDecodeOnce(u) {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function normalizeUrl(u) {
  if (!u) return "";
  let s = stripTrailingJunk(u);
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/\\\//g, "/");
  s = s.replace(/\s+/g, "");

  // POZOR: decode jen max 1x – u download.php se ti snadno rozbije file=...%7C...
  // (dvojité decode často vyrobí '|', který některé servery nechcou)
  s = safeDecodeOnce(s);

  // sjednocení %7C
  s = s.replace(/%7c/g, "%7C");
  return s;
}

function urlVariants(u) {
  const s = normalizeUrl(u);
  if (!s) return [];

  const out = new Set();
  out.add(s);

  if (s.includes("://www.")) out.add(s.replace("://www.", "://"));
  else if (s.includes("://")) out.add(s.replace("://", "://www."));

  // pipe variants
  if (s.includes("%7C")) out.add(s.replace(/%7C/g, "|"));
  if (s.includes("|")) out.add(s.replace(/\|/g, "%7C"));

  return [...out];
}

async function fetchStatus(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; RadimBot/1.0)" },
    });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

async function validateAndFixUrl(u) {
  const variants = urlVariants(u);
  if (!variants.length) return "";

  // zkus max 4 varianty kvůli rychlosti
  for (const v of variants.slice(0, 4)) {
    const st = await fetchStatus(v);
    if (st && st !== 404) return v;
  }
  return variants[0];
}

function extractLinks(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const matches = String(text || "").match(urlRegex) || [];
  return [...new Set(matches.map(normalizeUrl))].filter(Boolean);
}

/* -------------------- MODEL -------------------- */

async function answerWithModel(userQuery, contextText, route) {
  // route-aware instrukce, aby model nepřeskakoval people/dokumenty
  const routeHint =
    route === "PEOPLE"
      ? "Tento dotaz je o OSOBÁCH A FUNKCÍCH. Používej primárně informace z PEOPLE."
      : route === "DOCS"
      ? "Tento dotaz je o DOKUMENTECH/POPLATCÍCH. Používej primárně DOCS (obsah dokumentů) a případně index pro link."
      : route === "LATEST_WEB"
      ? "Tento dotaz je o AKTUÁLNÍM DĚNÍ. Používej primárně WEB_TEXT_CURRENT."
      : "Používej nejrelevantnější část kontextu.";

  const body = {
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "Jsi AI asistent obce Radim. Odpovídej česky, stručně a věcně.\n" +
          "AKTUÁLNÍ ROK JE 2026. Starší informace označ jako historické.\n\n" +
          "PRAVIDLA:\n" +
          "1) Používej POUZE dodaný KONTEXT.\n" +
          "2) Pokud jsou různé roky, vyber NEJNOVĚJŠÍ dostupný.\n" +
          "3) V odpovědi uveď alespoň jeden zdrojový odkaz, který je V KONTEXTU, ve formátu: (Zdroj: https://...)\n" +
          "4) Pokud informace v kontextu není, napiš přesně: „Tato informace není v dostupných podkladech obce Radim uvedena.“\n" +
          `\nROUTING HINT: ${routeHint}`,
      },
      {
        role: "user",
        content: `KONTEXT (texty + URL):\n${contextText}\n\nDOTAZ:\n${userQuery}`,
      },
    ],
    temperature: 0.1,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  return json.choices?.[0]?.message?.content || "";
}

/* -------------------- HANDLER -------------------- */

export default async (req) => {
  try {
    if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
    if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

    const body = await req.json().catch(() => ({}));
    const userQuery = String(body?.message || "").trim();
    if (!userQuery) return jsonResponse(200, { ok: true, answer: "" });

    const route = routeQuery(userQuery);

    // širší search, aby se do výsledků dostala správná vrstva
    const raw = await vectorSearch(userQuery, 45);

    // filtr podle route (PEOPLE/DOCS/LATEST/GENERAL)
    const filtered = filterByRoute(raw, route);

    // rank
    const ranked = filtered
      .map((r) => {
        const snippetText = r.content?.[0]?.text || "";
        const filename = r.filename || "";
        return { ...r, _score2: (r.score || 0) + scoreBonusForQuery(snippetText, filename, route) };
      })
      .sort((a, b) => b._score2 - a._score2);

    const topSnippets = ranked.slice(0, 10);

    // Kontext = top snippety
    let finalContext = topSnippets
      .map((s) => {
        const text = s.content?.[0]?.text || "";
        return `SOUBOR: ${s.filename || "(unknown)"}\nTEXT:\n${text}`;
      })
      .join("\n\n---\n\n");

    // Volitelný lokální hard-boost (když by někdy vector store měl slabý PEOPLE)
    // Doporučení: nechat vypnuté, zapnout jen když bude potřeba.
    /*
    const coreLocal = readLocalFile("knowledge/00_CORE_obec_radim.txt");
    const peopleLocal = readLocalFile("knowledge/people/00_PEOPLE_obec_radim.txt");
    if (route === "PEOPLE" && peopleLocal) {
      finalContext = `SOUBOR: 00_PEOPLE_obec_radim.txt\nTEXT:\n${peopleLocal}\n\n---\n\n` + finalContext;
    } else if (route === "GENERAL" && coreLocal) {
      finalContext = `SOUBOR: 00_CORE_obec_radim.txt\nTEXT:\n${coreLocal}\n\n---\n\n` + finalContext;
    }
    */

    let answer = await answerWithModel(userQuery, finalContext, route);

    // URL fix + 404 fix (max 6 linků)
    const rawLinks = extractLinks(answer);
    const fixedLinks = [];
    for (const l of rawLinks.slice(0, 6)) {
      fixedLinks.push(await validateAndFixUrl(l));
    }

    for (let i = 0; i < Math.min(rawLinks.length, fixedLinks.length); i++) {
      if (rawLinks[i] && fixedLinks[i] && rawLinks[i] !== fixedLinks[i]) {
        answer = answer.split(rawLinks[i]).join(fixedLinks[i]);
      }
    }

    const payload = {
      ok: true,
      answer,
      links: fixedLinks.filter(Boolean),
    };

    if (DEBUG) {
      payload.route = route;
      payload.top = topSnippets.map((s) => ({
        filename: s.filename,
        score: s.score,
        score2: s._score2,
        preview: (s.content?.[0]?.text || "").slice(0, 220),
      }));
    }

    return jsonResponse(200, payload);
  } catch (e) {
    return jsonResponse(500, { error: "Server error", details: e?.message || String(e) });
  }
};