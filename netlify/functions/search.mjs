import OpenAI from "openai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickOpenAIError(err) {
  // openai sdk v4 errors often contain:
  // err.status, err.message, err.error, err.response
  const out = {
    message: err?.message ?? String(err),
    status: err?.status ?? err?.response?.status ?? null,
    name: err?.name ?? null,
    type: err?.type ?? err?.error?.type ?? null,
    code: err?.code ?? err?.error?.code ?? null,
  };

  // Sometimes useful details are nested
  const apiErr = err?.error ?? err?.response?.data?.error ?? null;
  if (apiErr) {
    out.api_error = {
      message: apiErr.message ?? null,
      type: apiErr.type ?? null,
      code: apiErr.code ?? null,
      param: apiErr.param ?? null,
    };
  }

  return out;
}

export default async function handler(request) {
  const reqId = `req_${Math.random().toString(16).slice(2)}`;

  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Use POST" }, 405);
    }

    const body = await request.json().catch(() => ({}));
    const query = body?.query;

    if (!query || typeof query !== "string") {
      return json({ ok: false, error: "Missing 'query' (string) in JSON body." }, 400);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    // ✅ okamžitá diagnostika env (bez volání OpenAI)
    if (!apiKey || !assistantId) {
      const details = {
        reqId,
        has_OPENAI_API_KEY: Boolean(apiKey),
        has_ASSISTANT_ID: Boolean(assistantId),
        assistantId_prefix: assistantId ? assistantId.slice(0, 5) : null, // "asst_"
      };
      console.error("ENV_MISSING", details);
      return json(
        { ok: false, error: "Missing required env vars.", details },
        500
      );
    }

    const client = new OpenAI({ apiKey });

    // 1) create thread
    let thread;
    try {
      thread = await client.beta.threads.create();
    } catch (e) {
      const details = { reqId, where: "threads.create", openai: pickOpenAIError(e) };
      console.error("OPENAI_ERROR", details);
      return json({ ok: false, error: "OpenAI error at threads.create", details }, 502);
    }

    // 2) add user message
    try {
      await client.beta.threads.messages.create(thread.id, {
        role: "user",
        content: query,
      });
    } catch (e) {
      const details = { reqId, where: "threads.messages.create", thread_id: thread.id, openai: pickOpenAIError(e) };
      console.error("OPENAI_ERROR", details);
      return json({ ok: false, error: "OpenAI error at messages.create", details }, 502);
    }

    // 3) run
    let run;
    try {
      run = await client.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });
    } catch (e) {
      const details = { reqId, where: "threads.runs.create", thread_id: thread.id, assistant_id: assistantId, openai: pickOpenAIError(e) };
      console.error("OPENAI_ERROR", details);
      return json({ ok: false, error: "OpenAI error at runs.create", details }, 502);
    }

    // 4) poll status
    let status = run.status;
    let lastError = null;

    for (let i = 0; i < 60; i++) {
      let r;
      try {
        r = await client.beta.threads.runs.retrieve(thread.id, run.id);
      } catch (e) {
        const details = { reqId, where: "threads.runs.retrieve", thread_id: thread.id, run_id: run.id, openai: pickOpenAIError(e) };
        console.error("OPENAI_ERROR", details);
        return json({ ok: false, error: "OpenAI error at runs.retrieve", details }, 502);
      }

      status = r.status;
      lastError = r.last_error ?? null;

      if (status === "completed") break;
      if (status === "failed" || status === "cancelled" || status === "expired") break;

      await sleep(500);
    }

    if (status !== "completed") {
      const details = { reqId, thread_id: thread.id, run_id: run.id, status, last_error: lastError };
      console.error("RUN_NOT_COMPLETED", details);
      return json(
        { ok: false, error: "Assistant run did not complete.", details },
        502
      );
    }

    // 5) list messages
    let msgs;
    try {
      msgs = await client.beta.threads.messages.list(thread.id, { limit: 20 });
    } catch (e) {
      const details = { reqId, where: "threads.messages.list", thread_id: thread.id, openai: pickOpenAIError(e) };
      console.error("OPENAI_ERROR", details);
      return json({ ok: false, error: "OpenAI error at messages.list", details }, 502);
    }

    // vezmeme nejnovější assistant zprávu
    const assistantMsg = msgs.data.find((m) => m.role === "assistant");

    let text = "";
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      for (const part of assistantMsg.content) {
        if (part?.type === "text" && part?.text?.value) {
          text += part.text.value + "\n";
        }
      }
    }
    text = text.trim();

    if (!text) {
      const details = {
        reqId,
        note: "No assistant text extracted.",
        thread_id: thread.id,
        run_id: run.id,
        assistant_msg_present: Boolean(assistantMsg),
        assistant_msg_content_types: assistantMsg?.content?.map?.((p) => p?.type) ?? null,
      };
      console.error("EMPTY_ASSISTANT_TEXT", details);
      return json({ ok: false, error: "Empty assistant answer.", details }, 502);
    }

    return json({ ok: true, answer: text });
  } catch (err) {
    const details = { reqId, where: "top-level", openai: pickOpenAIError(err) };
    console.error("UNHANDLED", details);
    return json({ ok: false, error: "Unhandled error in function.", details }, 500);
  }
}
