// Cache efêmero privado, vinculado à versão da configuração e metodologia.
// Respostas em cache nunca são servidas como produzidas por outra revisão.
import { createHash } from "node:crypto";

const TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = "iev-cache-v2/";
const LEGACY_PREFIX = "iev-cache/";
const EPOCH_KEY = "iev-cache-v2/epoch.json";
const EPOCH_TTL_MS = 60_000;
const MAX_MEMORY = 200;
const memory = new Map();
let legacyCleanup = null;
let epochMemory = { value: null, at: 0 };

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

/**
 * Época do cache: resultados gravados antes de uma invalidação (correção
 * editorial, incidente) deixam de ser servidos como versão vigente.
 */
export async function currentEpoch() {
  if (!blobToken()) return "local";
  if (epochMemory.value && Date.now() - epochMemory.at < EPOCH_TTL_MS) return epochMemory.value;
  try {
    const { list } = await import("@vercel/blob");
    const found = await list({ prefix: EPOCH_KEY, token: blobToken() });
    const item = found.blobs.find((blob) => blob.pathname === EPOCH_KEY);
    if (!item) {
      epochMemory = { value: "initial", at: Date.now() };
      return "initial";
    }
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${blobToken()}` } });
    const body = response.ok ? await response.json() : null;
    epochMemory = { value: String(body?.epoch ?? "initial"), at: Date.now() };
    return epochMemory.value;
  } catch {
    return epochMemory.value ?? "initial";
  }
}

/** Invalida o cache: nova época no Blob e limpeza do cache em memória. */
export async function invalidateCache(reason = "manual") {
  memory.clear();
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!blobToken()) {
    epochMemory = { value: epoch, at: Date.now() };
    return { ok: true, epoch, persisted: false, reason };
  }
  try {
    const { put } = await import("@vercel/blob");
    await put(EPOCH_KEY, JSON.stringify({ epoch, at: new Date().toISOString(), reason }), {
      access: "private",
      contentType: "application/json",
      token: blobToken(),
      allowOverwrite: true,
    });
    epochMemory = { value: epoch, at: Date.now() };
    return { ok: true, epoch, persisted: true, reason };
  } catch {
    return { ok: false, epoch: null, persisted: false, reason };
  }
}

export function cacheKey(input, namespace = "legacy") {
  const norm = JSON.stringify({
    kind: input?.kind ?? "",
    text: String(input?.text ?? "").trim().normalize("NFC"),
    fileName: input?.fileName ?? "",
    fileHash: input?.fileHash ?? "",
    namespace,
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

async function removeLegacyPublicCache() {
  const token = blobToken();
  if (!token) return;
  const { list, del } = await import("@vercel/blob");
  let cursor;
  do {
    const page = await list({ prefix: LEGACY_PREFIX, token, limit: 1000, ...(cursor ? { cursor } : {}) });
    const paths = page.blobs
      .map((blob) => blob.pathname)
      .filter((pathname) => pathname.startsWith(LEGACY_PREFIX) && pathname.endsWith(".json"));
    for (const pathname of paths) await del(pathname, { token });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

async function ensurePrivateCutover() {
  if (!blobToken()) return;
  if (!legacyCleanup) {
    legacyCleanup = removeLegacyPublicCache().catch((error) => {
      legacyCleanup = null;
      throw error;
    });
  }
  await legacyCleanup;
}

export async function getCached(input, namespace) {
  const key = cacheKey(input, namespace);
  const epoch = await currentEpoch();
  const mem = memory.get(key);
  if (mem && Date.now() - mem.savedAt < TTL_MS && mem.epoch === epoch) return { ...mem.value, cached: true, cachedFrom: mem.value.checkId ?? null };
  memory.delete(key);
  const token = blobToken();
  if (!token) return null;
  try {
    await ensurePrivateCutover();
    const { list } = await import("@vercel/blob");
    const pathname = `${PREFIX}${key}.json`;
    const found = await list({ prefix: pathname, token });
    const item = found.blobs.find((blob) => blob.pathname === pathname);
    if (!item || Date.now() - new Date(item.uploadedAt).getTime() > TTL_MS) return null;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.namespace !== namespace || !body?.value) return null;
    if ((body?.epoch ?? "initial") !== epoch) return null;
    memory.set(key, { value: body.value, savedAt: Date.now(), epoch });
    return { ...body.value, cached: true, cachedFrom: body.value.checkId ?? null };
  } catch {
    return null;
  }
}

export async function setCached(input, value, namespace) {
  const key = cacheKey(input, namespace);
  const epoch = await currentEpoch();
  const entry = { value, namespace, savedAt: Date.now(), epoch };
  memory.set(key, entry);
  if (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
  const token = blobToken();
  if (!token) return;
  try {
    await ensurePrivateCutover();
    const { put } = await import("@vercel/blob");
    await put(`${PREFIX}${key}.json`, JSON.stringify(entry), {
      access: "private",
      contentType: "application/json",
      token,
      allowOverwrite: true,
    });
  } catch {
    // Cache best-effort: a provider result remains valid without persistence.
  }
}
