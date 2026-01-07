import fs from "fs";
import path from "path";

function loadKB() {
  const kbPath = path.join(process.cwd(), "kb", "kb.json");
  return JSON.parse(fs.readFileSync(kbPath, "utf8"));
}

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function hasAny(q, arr) {
  const t = norm(q);
  return arr.some(k => t.includes(norm(k)));
}

function formatOfficeHours(kb) {
  const oh = kb?.office?.office_hours || {};
  if (!oh.day || !oh.from || !oh.to) return null;
  return `**Úřední hodiny:** ${oh.day} ${oh.from}–${oh.to}${oh.note ? ` (${oh.note})` : ""}`;
}

function formatContacts(kb) {
  const o = kb?.office || {};
  const addr = o.address || {};
  const c = o.contacts || {};

  const phones = Array.isArray(c.phone) ? c.phone : [];
  const emails = Array.isArray(c.email) ? c.email : [];

  const lines = [];
  const addrLine = [addr.name, addr.street, `${addr.zip || ""} ${addr.city || ""}`.trim()]
    .filter(Boolean)
    .join(", ");
  if (addrLine) lines.push(`**Adresa:** ${addrLine}`);
  if (phones.length) lines.push(`**Telefon:** ${phones.join(", ")}`);
  if (emails.length) lines.push(`**E-mail:** ${emails.join(", ")}`);
  if (c.data_box) lines.push(`**Datová schránka:** ${c.data_box}`);
  if (c.bank_account) lines.push(`**Č. účtu:** ${c.bank_account}`);

  return lines.join("\n");
}

function sources(links, keys) {
  const out = [];
  for (const k of keys) {
    if (links?.[k]) out.push(`- ${links[k]}`);
  }
  return out.length ? `\n\n**Zdroje:**\n${out.join("\n")}` : "";
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").trim();
    if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };

    const kb = loadKB();
    const links = kb?.links || {};

    // =========================
    // 1) TVRDÉ (NE-AI) ODPOVĚDI
    // =========================

    // ÚŘEDNÍ HODINY
    if (hasAny(message, ["uredni hodiny", "úřední hodiny", "oteviraci doba", "otevreno", "kdy mate otevreno"])) {
      const oh = formatOfficeHours(kb);
      const reply = oh
        ? `${oh}`
        : `Úřední hodiny nemám v databázi přesně uvedené. Podívejte se prosím na web obce.`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply: reply + sources(links, ["office", "web_home"]) }) };
    }

    // KONTAKTY / ADRESA
    if (hasAny(message, ["kontakt", "kontakty", "telefon", "email", "e-mail", "datova schranka", "adresa", "kde sidli"])) {
      const text = formatContacts(kb) || "Kontaktní údaje nemám v databázi kompletní.";
      return { statusCode: 200, headers, body: JSON.stringify({ reply: text + sources(links, ["contacts", "office", "web_home"]) }) };
    }

    // ÚZEMNÍ PLÁN (kde najdu / odkaz)
    if (hasAny(message, ["uzemni plan", "územní plán", "kde najdu uzemni plan", "kde je uzemni plan", "odkaz uzemni plan"])) {
      let r = `Územní plán obce Radim najdete na webu obce:`;
      if (links.zoning_plan_page) r += `\n\n**Odkaz (stránka):**\n${links.zoning_plan_page}`;
      if (links.zoning_plan_pdf) r += `\n\n**Odkaz (PDF ke stažení):**\n${links.zoning_plan_pdf}`;
      if (!links.zoning_plan_page && !links.zoning_plan_pdf) r += `\n\nOdkaz nemám v databázi, podívejte se prosím na hlavní web obce.`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply: r + sources(links, ["zoning_plan_page", "zoning_plan_pdf", "web_home"]) }) };
    }

    // PROGRAM ROZVOJE (kde najdu / odkaz)
    if (hasAny(message, ["program rozvoje", "rozvojovy program", "program obce", "kde najdu program rozvoje", "odkaz program rozvoje"])) {
      let r = `Program rozvoje obce Radim je zveřejněn na webu obce jako dokument:`;
      if (links.development_program_pdf) r += `\n\n**Odkaz (PDF ke stažení):**\n${links.development_program_pdf}`;
      if (!links.development_program_pdf) r += `\n\nOdkaz nemám v databázi, podívejte se prosím na hlavní web obce.`;
      return { statusCode: 200, headers, body: JSON.stringify({ reply: r + sources(links, ["development_program_pdf", "web_home"]) }) };
    }

    // =========================
    // 2) AI fallback (jen pro ostatní dotazy)
    // =========================
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    }

    const safeContext = {
      office: kb.office || {},
      links: kb.links || {},
      notes: kb.notes || {}
    };

    const systemPrompt = `
Jsi oficiální virtuální asistent obce Radim.

Pravidla:
- Odpovídej česky, stručně a věcně.
- Používej POUZE informace ze "Kontextu" níže.
- Pokud informaci v kontextu nemáš, řekni to narovinu a pošli relevantní odkaz z kontextu (např. web_home / office / contacts).
- Nevymýšlej si žádné časy, částky, vyhlášky ani termíny.
- Na konec odpovědi vždy napiš sekci "Zdroje:" a uveď použité odkazy.
`;

    const userPrompt = `
Dotaz:
${message}

Kontext (interní databáze obce):
${JSON.stringify(safeContext, null, 2)}
`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({ error: data }) };
    }

    let reply = data?.choices?.[0]?.message?.content || "Omlouvám se, nepodařilo se získat odpověď.";

    // pojistka – když by model zapomněl zdroje
    if (!reply.toLowerCase().includes("zdroje")) {
      const fallback = links.web_home ? `- ${links.web_home}` : "- oficiální web obce";
      reply += `\n\nZdroje:\n${fallback}`;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e) }) };
  }
}
