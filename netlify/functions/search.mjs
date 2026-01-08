const resp = await fetch("/.netlify/functions/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: userMessage.trim() }),
});

const data = await resp.json();
