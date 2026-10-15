// Transporte PostgREST exclusivamente no servidor; nunca usa a chave anon.
export function supabaseConfigured(env = process.env) {
  return Boolean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY);
}

export class StorageError extends Error {
  constructor(code = "storage_failed", status = null) {
    super(code);
    this.name = "StorageError";
    this.code = code;
    this.status = status;
  }
}

export function reportStorageError(operation, mode, error) {
  console.error("[iev-storage]", JSON.stringify({ operation, mode, code: error instanceof StorageError ? error.code : "storage_failed", status: Number.isInteger(error?.status) ? error.status : null }));
}

export function storageFailureMessage(mode, error) {
  if (mode === "supabase") {
    if (error?.code === "storage_not_configured") return "Supabase incompleto: configure SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY somente no servidor. A chave anon não autoriza logs privados.";
    if (error?.status === 404) return "O armazenamento Supabase não está pronto. Aplique a migração SQL de supabase/migrations e confira o projeto configurado.";
    if ([401, 403].includes(error?.status)) return "O Supabase recusou o acesso aos logs privados. Confira a chave de serviço do servidor e as permissões da migração SQL.";
    return "Não foi possível acessar o armazenamento Supabase. Confira a configuração, a migração SQL e a disponibilidade do serviço.";
  }
  return "Não foi possível acessar os registros privados. Confira a configuração e a disponibilidade do armazenamento Blob.";
}

export async function supabaseRequest(path, { method = "GET", query, body, prefer } = {}, env = process.env) {
  const base = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new StorageError("storage_not_configured");
  let url;
  try {
    url = new URL(`${String(base).replace(/\/$/, "")}/rest/v1/${path}`);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    if (query) url.search = new URLSearchParams(query).toString();
  } catch {
    throw new StorageError("storage_invalid_config");
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    throw new StorageError("storage_unreachable");
  }
  if (!response.ok) throw new StorageError("storage_request_failed", response.status);
  let data = null;
  if (response.status !== 204) {
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new StorageError("storage_invalid_response", response.status);
    }
  }
  return { data, count: response.headers.get("content-range")?.split("/")[1] ?? null };
}
