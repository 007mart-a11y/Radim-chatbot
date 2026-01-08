export default async function handler(req) {
  console.log("METHOD:", req.method);

  let rawBody;
  try {
    rawBody = await req.text();
  } catch (e) {
    console.log("BODY READ ERROR", e);
  }

  console.log("RAW BODY:", rawBody);

  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.log("JSON PARSE ERROR", e);
  }

  console.log("PARSED BODY:", body);
