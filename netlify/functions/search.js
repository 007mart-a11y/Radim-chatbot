// netlify/functions/search.js
exports.handler = async (event) => {
  try {
    const { q } = JSON.parse(event.body || "{}");
    const query = (q || "").toLowerCase().trim();

    if (!query) {
      return json({ ok: false, message: "Chybí dotaz." }, 400);
    }

    // ✅ Sem si dáš seznam stránek obce Radim (můžeš postupně rozšiřovat)
    // TIP: klidně sem dej 50–200 URL z menu webu, a bude to trefovat dobře.
    const PAGES = [
      { title: "Obec Radim - hlavní stránka", url: "https://www.obec-radim.cz" },
      { title: "Úřední deska", url: "https://www.obec-radim.cz/uredni-deska" },
      { title: "Kontakty", url: "https://www.obec-radim.cz/kontakty" },
      { title: "Územní plán", url: "https://www.obec-radim.cz/uzemni-plan" },
      { title: "Poplatky", url: "https://www.obec-radim.cz/poplatky" },
      { title: "Svoz odpadu", url: "https://www.obec-radim.cz/odpad" },
      { title: "Zastupitelstvo", url: "https://www.obec-radim.cz/zastupitelstvo" },
    ];

    // jednoduché skórování podle slov v dotazu
    const words = query.split(/\s+/).filter(Boolean);

    const scored = PAGES.map((p) => {
      const hay = (p.title + " " + p.url).toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 2;
      }
      // bonusy na typické dotazy
      if (query.includes("úřední") && hay.includes("kontakt")) score += 1;
      if (query.includes("územní") && hay.includes("uzemni")) score += 3;
      return { ...p, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];

    if (!best || best.score === 0) {
      return json({
        ok: true,
        found: false,
        answer:
          "Tuhle informaci nemám jistě. Pošli mi prosím přesnější dotaz (např. název formuláře / odboru), nebo mrkni na hlavní web obce.",
        links: [{ title: "Obec Radim (hlavní web)", url: "https://www.obec-radim.cz" }],
      });
    }

    return json({
      ok: true,
      found: true,
      answer: `Našel jsem nejbližší relevantní stránku:`,
      links: scored.slice(0, 3).filter(x => x.score > 0).map(x => ({ title: x.title, url: x.url })),
    });
  } catch (e) {
    return json({ ok: false, message: "Chyba serveru", error: String(e) }, 500);
  }
};

function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
}
