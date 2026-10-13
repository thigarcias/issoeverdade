// Cache de vereditos por hash do input — mesma checagem em <24h retorna
// o resultado idêntico: variação zero + custo zero. Storage: Vercel Blob
// (prefixo iev-cache/); sem Blob, cache em memória (vale por instância).
// TTL: 24h. Chave: sha256(kind + texto normalizado).

import { createHash } from "node:crypto";

const TTL_MS = 24 * 3600 * 1000;
const PREFIX = "iev-cache/";
const memory = new Map();

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function cacheKey(input) {
  const norm = `${input?.kind ?? ""}\n${String(input?.text ?? "").trim().toLowerCase()}\n${input?.fileName ?? ""}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

export async function getCached(input) {
  const key = cacheKey(input);
  const mem = memory.get(key);
  if (mem && Date.now() - mem.savedAt < TTL_MS) {
    return { ...mem.value, cached: true };
  }
  memory.delete(key);
  if (!blobToken()) return null;
  try {
    const { list } = await import("@vercel/blob");
    const found = await list({ prefix: `${PREFIX}${key}.json`, token: blobToken() });
    const item = found.blobs.find((b) => b.pathname === `${PREFIX}${key}.json`);
    if (!item) return null;
    const uploadedAt = new Date(item.uploadedAt).getTime();
    if (Date.now() - uploadedAt > TTL_MS) return null;
    const res = await fetch(item.url);
    if (!res.ok) return null;
    const value = await res.json();
    memory.set(key, { value, savedAt: Date.now() });
    return { ...value, cached: true };
  } catch {
    return null;
  }
}

export async function setCached(input, value) {
  const key = cacheKey(input);
  memory.set(key, { value, savedAt: Date.now() });
  if (memory.size > 200) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
  if (!blobToken()) return;
  try {
    const { put } = await import("@vercel/blob");
    await put(`${PREFIX}${key}.json`, JSON.stringify(value), {
      access: "public",
      contentType: "application/json",
      token: blobToken(),
    });
  } catch {
    /* cache best-effort */
  }
}
