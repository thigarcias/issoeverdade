// Log estruturado de checagens — 1 JSON por iteração no Vercel Blob (store privada).
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
    summary: String(entry.summary ?? "").slice(0, 1000),
    claims: Array.isArray(entry.claims) ? entry.claims.slice(0, 10) : [],
    sources: Array.isArray(entry.sources) ? entry.sources.slice(0, 10) : [],
    claimsCount: entry.claimsCount ?? null,
    sourcesCount: entry.sourcesCount ?? null,
    mediaAttempts: entry.mediaAttempts ?? [],
    transcriptSegs: entry.transcriptSegs ?? 0,
    transcriptPreview: String(entry.transcriptPreview ?? "").slice(0, 2000),
    origin: entry.origin ?? null,
    judgePromptPreview: String(entry.judgePromptPreview ?? "").slice(0, 4000),
    judgeRawPreview: String(entry.judgeRawPreview ?? "").slice(0, 4000),
    finalPromptPreview: String(entry.finalPromptPreview ?? "").slice(0, 4000),
    finalRawPreview: String(entry.finalRawPreview ?? "").slice(0, 6000),
    corrections: entry.corrections ?? [],
    error: entry.error ?? null,
  };
  if (!logEnabled()) {
    console.log(`[iev-log] ${record.id} ${record.kind} ${record.verdict ?? record.error} ${record.totalMs}ms`);
    return null;
  }
  try {
    const { put, list, del } = await blob();
    const tok = blobToken();
    const key = `iev-logs/${record.id}.json`;
    await put(key, JSON.stringify(record, null, 1), {
      access: "private",
      contentType: "application/json",
      token: tok,
      allowOverwrite: true,
    });
    // Índice cronológico (mais novos primeiro), podado em MAX_INDEX.
    let index = [];
    try {
      const found = await list({ prefix: INDEX_KEY, token: tok });
      const item = found.blobs.find((b) => b.pathname === INDEX_KEY);
      if (item) {
        const res = await fetch(item.url, { headers: { Authorization: `Bearer ${tok}` } });
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
      const all = await list({ prefix: "iev-logs/", token: tok });
      const stale = all.blobs
        .map((b) => b.pathname)
        .filter((p) => p.startsWith("iev-logs/") && p.endsWith(".json") && p !== INDEX_KEY)
        .filter((p) => !keep.has(p.slice("iev-logs/".length, -".json".length)));
      for (const p of stale.slice(0, 20)) {
        await del(p, { token: tok }).catch(() => {});
      }
    } catch { /* limpeza best-effort */ }
    await put(INDEX_KEY, JSON.stringify(index), {
      access: "private",
      contentType: "application/json",
      token: tok,
      allowOverwrite: true,
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
    const tok = blobToken();
    const { list } = await blob();
    const found = await list({ prefix: INDEX_KEY, token: tok });
    const item = found.blobs.find((b) => b.pathname === INDEX_KEY);
    if (!item) return { enabled: true, items: [] };
    const res = await fetch(item.url, { headers: { Authorization: `Bearer ${tok}` } });
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
    const tok = blobToken();
    const { list } = await blob();
    const found = await list({ prefix: `iev-logs/${id}.json`, token: tok });
    const item = found.blobs.find((b) => b.pathname === `iev-logs/${id}.json`);
    if (!item) return null;
    const res = await fetch(item.url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
