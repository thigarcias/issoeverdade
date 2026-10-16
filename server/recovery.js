// Capability-only recovery; never reads administrative logs or indexes by input.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { stateStoreMode, readState, writeState } from "./state-store.js";

const TTL_MS = 30 * 60 * 1000;
const PENDING_MS = 5 * 60 * 1000;
const MAX_MEMORY = 200;
const PREFIX = "iev-recovery-v1/";
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validToken = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export class RecoveryUnavailable extends Error {
  constructor() {
    super("recovery_unavailable");
    this.code = "recovery_unavailable";
  }
}

// Injectable dependencies keep expiry and persistence failure tests deterministic.
export function createRecoveryStore({ now = Date.now, blobToken = () => process.env.BLOB_READ_WRITE_TOKEN || "", loadBlob = () => import("@vercel/blob"), fetchBlob = (...args) => fetch(...args), ttlMs = TTL_MS, pendingMs = PENDING_MS, maxMemory = MAX_MEMORY } = {}) {
  const memory = new Map();
  const keyFor = (checkId, recoveryToken) => createHash("sha256").update(`${checkId}:${recoveryToken}`).digest("hex");
  const prune = () => {
    for (const [key, record] of memory) if (record.expiresAt <= now()) memory.delete(key);
    while (memory.size > maxMemory) memory.delete(memory.keys().next().value);
  };
  const save = async (key, record) => {
    if (stateStoreMode() === "supabase") {
      try { await writeState("recovery", key, record, { expiresAt: record.expiresAt }); }
      catch { throw new RecoveryUnavailable(); }
      return;
    }
    const token = blobToken();
    if (token) {
      try {
        const { put } = await loadBlob();
        await put(`${PREFIX}${key}.json`, JSON.stringify(record), {
          access: "private", contentType: "application/json", token,
          allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 0,
        });
      } catch { throw new RecoveryUnavailable(); }
    } else {
      memory.set(key, record);
      prune();
    }
  };
  const load = async (key) => {
    prune();
    if (stateStoreMode() === "supabase") {
      try { return await readState("recovery", key); }
      catch { throw new RecoveryUnavailable(); }
    }
    const token = blobToken();
    if (!token) return memory.get(key) ?? null;
    try {
      const { list } = await loadBlob();
      const pathname = `${PREFIX}${key}.json`;
      const page = await list({ prefix: pathname, token, limit: 1 });
      const item = page.blobs.find((blob) => blob.pathname === pathname);
      if (!item) return null;
      const response = await fetchBlob(item.url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) throw new RecoveryUnavailable();
      return await response.json();
    } catch { throw new RecoveryUnavailable(); }
  };
  const authorized = async (checkId, recoveryToken) => {
    if (!validId(checkId) || !validToken(recoveryToken)) return null;
    const key = keyFor(checkId, recoveryToken);
    const record = await load(key);
    if (!record || record.checkId !== checkId || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) return null;
    return { key, record };
  };
  return {
    async start(checkId = randomUUID()) {
      if (!validId(checkId)) throw new RecoveryUnavailable();
      const capability = { checkId, recoveryToken: randomBytes(32).toString("base64url") };
      const startedAt = now();
      await save(keyFor(checkId, capability.recoveryToken), { checkId, status: "pending", expiresAt: startedAt + ttlMs, pendingUntil: startedAt + pendingMs });
      return capability;
    },
    async complete(capability, envelope) {
      const entry = await authorized(capability?.checkId, capability?.recoveryToken);
      if (!entry || entry.record.status !== "pending" || envelope?.checkId !== capability.checkId) throw new RecoveryUnavailable();
      await save(entry.key, { checkId: capability.checkId, status: "completed", expiresAt: entry.record.expiresAt, envelope });
    },
    async fail(capability, error) {
      const entry = await authorized(capability?.checkId, capability?.recoveryToken);
      if (!entry || entry.record.status !== "pending") return;
      await save(entry.key, { checkId: capability.checkId, status: "failed", expiresAt: entry.record.expiresAt,
        error: { code: String(error?.code ?? "upstream_error").slice(0, 80), message: String(error?.message ?? "Não consegui checar agora.").slice(0, 500) } });
    },
    async read(checkId, recoveryToken) {
      const entry = await authorized(checkId, recoveryToken);
      if (!entry) return null;
      const { record } = entry;
      if (record.status === "completed") return { status: "completed", envelope: record.envelope };
      if (record.status === "failed") return { status: "failed", error: record.error };
      if (record.status !== "pending") throw new RecoveryUnavailable();
      if (record.pendingUntil <= now()) return { status: "failed", error: { code: "recovery_timeout", message: "A execução não concluiu dentro do prazo. Não há resultado recuperável." } };
      return { status: "pending" };
    },
  };
}

const recovery = createRecoveryStore();
export const startRecovery = (...args) => recovery.start(...args);
export const completeRecovery = (...args) => recovery.complete(...args);
export const failRecovery = (...args) => recovery.fail(...args);
export const readRecovery = (...args) => recovery.read(...args);

