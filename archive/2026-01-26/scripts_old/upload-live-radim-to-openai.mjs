// scripts/upload-live-to-openai.mjs
// 1) vygeneruje jednotný čas aktualizace (identický pro log + soubor)
// 2) spustí live_radim_scrape.mjs s env LIVE_UPDATED_AT_...
// 3) smaže staré LIVE "10_LIVE*" z vector store
// 4) nahraje nový LIVE soubor a připojí ho do vector store

import { readFile } from "node:fs/promises";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const CLEANUP_OLD = String(process.env.CLEANUP_OLD ?? "1") !== "0";

if (!OPENAI_API_KEY) throw new Error("Missing env OPENAI_API_KEY");
if (!VECTOR_STORE_ID) throw new Error("Missing env VECTOR_STORE_ID");

const LIVE_FILE_PATH =
  process.env.LIVE_FILE_PATH ||
  (process.env.NETLIFY ? "/tmp/knowledge/10_LIVE_obec_radim.txt" : "public/knowledge/10_LIVE_obec_radim.txt");

function formatPrague(dt) {
  // identická “čitelnost” jako u Chomutic: cs-CZ, Europe/Prague, včetně sekund
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(dt);
}

async function oaiFetch(path, opts = {}) {
  const res = await fetch(`https://api.openai.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`OpenAI ${res.status} ${path}: ${msg}`);
  }
  return json ?? {};
}

async function listVectorStoreFiles() {
  return await oaiFetch(`/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=100`);
}

async function deleteVectorStoreFile(vectorStoreFileId) {
  return await oaiFetch(`/v1/vector_stores/${VECTOR_STORE_ID}/files/${vectorStoreFileId}`, {
    method: "DELETE",
  });
}

async function deleteFile(fileId) {
  return await oaiFetch(`/v1/files/${fileId}`, { method: "DELETE" });
}

function isLiveCandidate(filename) {
  return /^10_LIVE/i.test(filename || "");
}

async function cleanupOldLive() {
  if (!CLEANUP_OLD) {
    console.log("CLEANUP_OLD=0 → skipping cleanup");
    return;
  }

  const page = await listVectorStoreFiles();
  const items = page?.data || [];
  console.log("Vector store files:", items.length);

  for (const f of items) {
    const vsFileId = f?.id;
    const fileId = f?.file?.id || f?.file_id || null;
    const filename = f?.file?.filename || f?.filename || "";

    if (!isLiveCandidate(filename)) continue;

    console.log("Deleting LIVE from vector store:", { filename, vsFileId, fileId });

    if (vsFileId) {
      try { await deleteVectorStoreFile(vsFileId); } catch (e) { console.log("Delete vector store file failed:", e.message); }
    }
    if (fileId) {
      try { await deleteFile(fileId); } catch (e) { console.log("Delete file failed:", e.message); }
    }
  }
}

async function uploadFileToOpenAI(filepath) {
  const content = await readFile(filepath);
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([content], { type: "text/plain" }), filepath.split("/").pop());

  const res = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Upload failed: ${json?.error?.message || res.statusText}`);
  return json; // { id, filename, ... }
}

async function attachFileToVectorStore(fileId) {
  return await oaiFetch(`/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
}

async function runLiveScrape({ updatedIso, updatedPrague }) {
  const { spawn } = await import("node:child_process");

  const env = {
    ...process.env,
    LIVE_UPDATED_AT_ISO: updatedIso,
    LIVE_UPDATED_AT_PRAGUE: updatedPrague,
  };

  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["scripts/live_radim_scrape.mjs"], {
      stdio: "inherit",
      env,
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`live_scrape exit ${code}`))));
  });
}

async function main() {
  // 1) jednotný čas pro celý běh
  const updatedAt = new Date();
  const updatedIso = updatedAt.toISOString();
  const updatedPrague = formatPrague(updatedAt);

  console.log("=== LIVE RUN START ===");
  console.log({
    LIVE_FILE_PATH,
    VECTOR_STORE_ID,
    CLEANUP_OLD,
    UPDATED_AT_ISO: updatedIso,
    UPDATED_AT_PRAGUE: updatedPrague,
  });

  // 2) scrape s jednotným timestampem
  await runLiveScrape({ updatedIso, updatedPrague });

  // 3) cleanup starých LIVE
  await cleanupOldLive();

  // 4) upload + attach
  const uploaded = await uploadFileToOpenAI(LIVE_FILE_PATH);
  console.log("Uploaded file:", { id: uploaded.id, filename: uploaded.filename });

  const attached = await attachFileToVectorStore(uploaded.id);
  console.log("Attached to vector store:", { id: attached.id });

  console.log("=== LIVE RUN DONE ===");
}

main().catch((e) => {
  console.error("LIVE UPLOAD FAILED:", e);
  process.exit(1);
});