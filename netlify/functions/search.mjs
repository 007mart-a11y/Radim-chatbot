// netlify/functions/search.mjs
// OpenAI Assistants v2 přes fetch (bez OpenAI SDK)
// Vrací JSON: { ok:true, answer, thread_id } nebo { ok:false, error, details }
//
// ENV:
// - OPENAI_API_KEY
// - ASSISTANT_ID

const OPENAI_BASE = "https://api.openai.com/v1";
const MODEL_HEADERS = () => ({
  "authorization": `Bearer ${process.env.OPENAI_API_KEY || ""}`,
  "content-type": "application/json",
  "openai-beta": "assistants=v2",
});

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Odstraní FileSearch citace a bordel typu:
 * , [6:0], (6:0), "†source", apod.
 * + zruší markdown hvězdičky (**bold**, * odrážky)
 * + uhladí whitespace
 * + opraví rozbitá URL (odsekne ),.];:!? za odkazem)
 */
function cleanAssistantText(input) {
  if (!input) return "";
  let t = String(input);

  // 0) Zruš markdown bold/italic hvězdičky
  // **text** -> text
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");
  // * text (odrážka) -> - text
  t = t.replace(/^(\s*)\*\s+/gm, "$1- ");
  // zbytečné osamělé hvězdičky
  t = t.replace(/\*/g, "");

  // 1) Nejčastější OpenAI citace z File Search
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*†[^】]*】/g, "");

  // 2) Variace bez †… nebo s jiným obsahem
  t = t.replace(/【\s*\d+\s*:\s*\d+\s*】/g, "");

  // 3) Variace v hranatých / kulatých závorkách
  t = t.replace(/\[\s*\d+\s*:\s*\d+\s*(?:†[^\]]*)?\]/g, "");
  t = t.replace(/\(\s*\d+\s*:\s*\d+\s*(?:†[^)]*)?\)/g, "");

  // 4) „†source“ a podobné zbytky
  t = t.replace(/†\s*source/gi, "");
  t = t.replace(/\bsource:\s*\d+\s*:\s*\d+\b/gi, "");

  // 5) Holé tokeny typu "6:0" (pozor na časy 12:30)
  t = t.replace(/(^|[^\d])(\d{1,3}\s*:\s*\d{1,3})(?=($|[^\d]))/g, (m, p1, tok) => {
    const parts = tok.replace(/\s+/g, "").split(":");
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    const looksLikeTime = a >= 0 && a <= 23 && b >= 0 && b <= 59;
    if (looksLikeTime) return m; // nech čas
    return p1; // smaž token
  });

  // 6) Oprava rozbitých URL: odstraní trailing interpunkci za URL
  t = t.replace(/(https?:\/\/[^\s<>"']+?)([)\],.;:!?]+)(?=\s|$)/g, "$1");

  // 7) Uhlazení mezer a prázdných řádků
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.trim();

  return t;
}

function extractAssistantTextFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return "";
  let out = "";
  for (const c of msg.content) {
    if (c?.type === "text" && c?.text?.value) {
      out += (out ? "\n\n" : "") + c.text.value;
    }
  }
  return out;
}

async function oaiFetch(path, options = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    ...options,
    headers: { ...MODEL_HEADERS(), ...(options.headers || {}) },
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = json || { raw: text || "(empty)" };
    const msg = detail?.error?.message || `OpenAI error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  return json;
}

async function ensureThread(thread_id) {
  if (thread_id) return thread_id;
  const t = await oaiFetch(`/threads`, { method: "POST", body: JSON.stringify({}) });
  return t.id;
}

async function addUserMessage(thread_id, message) {
  await oaiFetch(`/threads/${thread_id}/messages`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content: message }),
  });
}

async function runAssistant(thread_id, assistant_id) {
  // ✅ Stabilita odpovědí:
  // temperature: 0 = minimální náhodnost
  const run = await oaiFetch(`/threads/${thread_id}/runs`, {
    method: "POST",
    body: JSON.stringify({
      assistant_id,
      temperature: 0,
    }),
  });
  return run.id;
}

async function waitRun(thread_id, run_id, { timeoutMs = 45000 } = {}) {
  const start = Date.now();
  while (true) {
    const run = await oaiFetch(`/threads/${thread_id}/runs/${run_id}`, { method: "GET" });

    const status = run.status;
    if (status === "completed") return run;
    if (status === "failed" || status === "cancelled" || status === "expired") {
      const errMsg = run?.last_error?.message || `Run ${status}`;
      const err = new Error(errMsg);
      err.detail = run;
      throw err;
    }

    if (Date.now() - start > timeoutMs) {
      const err = new Error("Timeout: asistent nestihl odpovědět v limitu.");
      err.detail = run;
      throw err;
    }

    await sleep(900);
  }
}

async function getLatestAssistantMessage(thread_id) {
  const list = await oaiFetch(`/threads/${thread_id}/messages?limit=50`, { method: "GET" });
  const msgs = Array.isArray(list.data) ? list.data : [];

  // ✅ vezmeme opravdu nejnovější assistant zprávu
  const assistants = msgs.filter((m) => m.role === "assistant");
  assistants.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return assistants[0] || null;
}

/**
 * Netlify Function handler
 */
export default async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return jsonResponse(200, { ok: true });
    }

    if (request.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID = process.env.ASSISTANT_ID;

    if (!OPENAI_API_KEY) {
      return jsonResponse(500, { ok: false, error: "Missing env OPENAI_API_KEY" });
    }
    if (!ASSISTANT_ID) {
      return jsonResponse(500, { ok: false, error: "Missing env ASSISTANT_ID" });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const message = String(body.message || "").trim();
    const thread_in = body.thread_id ? String(body.thread_id) : "";

    if (!message) {
      return jsonResponse(400, { ok: false, error: "Missing message" });
    }

    const thread_id = await ensureThread(thread_in);
    await addUserMessage(thread_id, message);

    const run_id = await runAssistant(thread_id, ASSISTANT_ID);
    await waitRun(thread_id, run_id, { timeoutMs: 45000 });

    const msg = await getLatestAssistantMessage(thread_id);
    const raw = extractAssistantTextFromMessage(msg);
    const answer = cleanAssistantText(raw) || "Bez odpovědi.";

    return jsonResponse(200, { ok: true, answer, thread_id });
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      error: e?.message || "Internal error",
      details: e?.detail || null,
    });
  }
};