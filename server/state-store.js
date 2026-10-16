// Estado privado do servidor. Supabase tem prioridade sobre Blob, sem fallback
// para outro backend durante falhas (evita configurações/resultados divergentes).
import { supabaseConfigured, supabaseRequest, StorageError } from "./supabase.js";

export function stateStoreMode(env = process.env) {
  return supabaseConfigured(env) ? "supabase" : env.BLOB_READ_WRITE_TOKEN ? "blob" : "memory";
}

export async function readState(namespace, key, env = process.env) {
  const { data } = await supabaseRequest("iev_state", { query: {
    namespace: `eq.${namespace}`, key: `eq.${key}`, select: "value,expires_at",
    limit: "1",
  } }, env);
  if (!Array.isArray(data) || data.length > 1) throw new StorageError("storage_invalid_response");
  if (!data.length) return null;
  const row = data[0];
  if (row.expires_at && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now())) return null;
  if (!row.value || typeof row.value !== "object" || Array.isArray(row.value)) throw new StorageError("storage_invalid_response");
  return row.value;
}

export async function writeState(namespace, key, value, { expiresAt = null, env = process.env } = {}) {
  await supabaseRequest("rpc/iev_put_state", { method: "POST", body: {
    p_namespace: namespace, p_key: key, p_value: value,
    p_expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  } }, env);
}

// Paginação por chave: respeita o teto de linhas do PostgREST sem truncar a fila.
export async function listState(namespace, { limit = 500, env = process.env } = {}) {
  const rows = [];
  let after = null;
  while (rows.length < limit) {
    const query = { namespace: `eq.${namespace}`, select: "key,value,expires_at", order: "key.asc", limit: String(Math.min(200, limit - rows.length)) };
    if (after !== null) query.key = `gt.${after}`;
    const { data } = await supabaseRequest("iev_state", { query }, env);
    if (!Array.isArray(data) || data.length > Number(query.limit)) throw new StorageError("storage_invalid_response");
    if (!data.length) break;
    for (const row of data) {
      if (typeof row.key !== "string" || (after !== null && row.key <= after) || !row.value || typeof row.value !== "object" || Array.isArray(row.value)) throw new StorageError("storage_invalid_response");
      after = row.key;
      if (!row.expires_at || Date.parse(row.expires_at) > Date.now()) rows.push(row.value);
    }
  }
  return rows;
}
