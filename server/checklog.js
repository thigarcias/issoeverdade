// Log estruturado de checagens — 1 JSON por iteração no Vercel Blob.
// Sem BLOB_READ_WRITE_TOKEN: cai para console.log (funciona em dev).
// Cada registro: id, timestamp, input (truncado), fases com tempos, modelo,
// veredito/score, tentativas de mídia, erros. Sem conteúdo integral de
// arquivos (só nomes) e sem keys.

const INDEX_KEY = "iev-logs/index.json";
const MAX_INDEX = 200;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function logEnabled() {
  return Boolean(blobToken());
}

async function blob() {
  return import("@vercel/blob");
}

/**
 * @param {object} entry registro completo da checagem
 * @returns {Promise<string|null>} id persistido ou null
 */
export async function saveCheckLog(entry) {
  const record = {
    id: entry.id,
    at: new Date().toISOString(),
    kind: entry.kind,
    inputPreview: String(entry.inputPreview ?? "").slice(0, 300),
    fileName: entry.fileName ?? null,
    phases: entry.phases ?? [],
    totalMs: entry.totalMs ?? null,
    model: entry.model ?? null,
    verdict: entry.verdict ?? null,
    score: entry.score ?? null,
    claimsCount: entry.claimsCount ?? null,
    sourcesCount: entry.sourcesCount ?? null,
    mediaAttempts: entry.mediaAttempts ?? [],
    transcriptSegs: entry.transcriptSegs ?? 0,
    origin: entry.origin ?? null,
    error: entry.error ?? null,
  };
  if (!logEnabled()) {
    console.log(`[iev-log] ${record.id} ${record.kind} ${record.verdict ?? record.error} ${record.totalMs}ms`);
    return null;
  }
  try {
    const { put, list, del } = await blob();
    const key = `iev-logs/${record.id}.json`;
    await put(key, JSON.stringify(record, null, 1), {
      access: "public",
      contentType: "application/json",
      token: blobToken(),
    });
    // Índice cronológico (mais novos primeiro), podado em MAX_INDEX.
    let index = [];
    try {
      const found = await list({ prefix: INDEX_KEY, token: blobToken() });
      const item = found.blobs.find((b) => b.pathname === INDEX_KEY);
      if (item) {
        const res = await fetch(item.url);
        if (res.ok) index = (await res.json()) ?? [];
      }
    } catch { /* índice novo */ }
    const entry_ = {
      id: record.id,
      at: record.at,
      kind: record.kind,
      verdict: record.verdict,
      score: record.score,
      totalMs: record.totalMs,
      model: record.model,
      error: record.error,
      inputPreview: record.inputPreview,
    };
    index = [entry_, ...index.filter((e) => e.id !== record.id)].slice(0, MAX_INDEX);
    // Remove JSONs que caíram do índice para não acumular lixo.
    const keep = new Set(index.map((e) => e.id));
    try {
      const all = await list({ prefix: "iev-logs/", token: blobToken() });
      const stale = all.blobs
        .map((b) => b.pathname)
        .filter((p) => p.startsWith("iev-logs/") && p.endsWith(".json") && p !== INDEX_KEY)
        .filter((p) => !keep.has(p.slice("iev-logs/".length, -".json".length)));
      for (const p of stale.slice(0, 20)) {
        await del(p, { token: blobToken() }).catch(() => {});
      }
    } catch { /* limpeza best-effort */ }
    await put(INDEX_KEY, JSON.stringify(index), {
      access: "public",
      contentType: "application/json",
      token: blobToken(),
    });
    return record.id;
  } catch (err) {
    console.error(`[iev-log] falha ao salvar: ${err?.message}`);
    return null;
  }
}

export async function listCheckLogs() {
  if (!logEnabled()) return { enabled: false, items: [] };
  try {
    const { list } = await blob();
    const found = await list({ prefix: INDEX_KEY, token: blobToken() });
    const item = found.blobs.find((b) => b.pathname === INDEX_KEY);
    if (!item) return { enabled: true, items: [] };
    const res = await fetch(item.url);
    if (!res.ok) return { enabled: true, items: [] };
    return { enabled: true, items: (await res.json()) ?? [] };
  } catch {
    return { enabled: true, items: [], error: "list-failed" };
  }
}

export async function getCheckLog(id) {
  if (!logEnabled()) return null;
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  try {
    const { list } = await blob();
    const found = await list({ prefix: `iev-logs/${id}.json`, token: blobToken() });
    const item = found.blobs.find((b) => b.pathname === `iev-logs/${id}.json`);
    if (!item) return null;
    const res = await fetch(item.url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
