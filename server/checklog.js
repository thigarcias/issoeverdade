// Registros de checagem e índice administrativo no Blob privado.
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

function indexEntry(record) {
  return {
    id: record.id,
    at: record.at,
    kind: record.kind,
    outcome: record.outcome,
    verdict: record.verdict,
    score: record.score,
    totalMs: record.totalMs,
    methodologyVersion: record.methodologyVersion,
    model: record.model,
    provider: record.provider,
    error: record.error,
    inputPreview: record.inputPreview,
  };
}

export async function saveCheckLog(entry) {
  const record = {
    id: entry.id,
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    inputPreview: String(entry.inputPreview ?? "").slice(0, 300),
    inputHash: entry.inputHash ?? null,
    fileName: entry.fileName ?? null,
    phases: entry.phases ?? [],
    totalMs: entry.totalMs ?? null,
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    aiConfig: entry.aiConfig ?? null,
    modelsUsed: entry.modelsUsed ?? {},
    configRevision: entry.configRevision ?? null,
    configSource: entry.configSource ?? null,
    methodologyVersion: entry.methodologyVersion ?? "legacy",
    promptHashes: entry.promptHashes ?? {},
    outcome: entry.outcome ?? (entry.error ? "error" : entry.verdict ? "checked" : "legacy"),
    verdict: entry.verdict ?? null,
    score: typeof entry.score === "number" ? entry.score : null,
    summary: String(entry.summary ?? "").slice(0, 1000),
    claims: Array.isArray(entry.claims) ? entry.claims.slice(0, 50) : [],
    notCheckedClaims: Array.isArray(entry.notCheckedClaims) ? entry.notCheckedClaims.slice(0, 50) : [],
    omittedClaimsCount: entry.omittedClaimsCount ?? 0,
    sources: Array.isArray(entry.sources) ? entry.sources.slice(0, 30) : [],
    researchCitations: Array.isArray(entry.researchCitations) ? entry.researchCitations.slice(0, 50) : [],
    researchQueries: Array.isArray(entry.researchQueries) ? entry.researchQueries.slice(0, 20) : [],
    claimsCount: entry.claimsCount ?? null,
    sourcesCount: entry.sourcesCount ?? null,
    mediaAttempts: entry.mediaAttempts ?? [],
    mediaCoverage: entry.mediaCoverage ?? null,
    transcriptSegs: entry.transcriptSegs ?? 0,
    transcriptPreview: String(entry.transcriptPreview ?? "").slice(0, 2000),
    origin: entry.origin ?? null,
    judgePromptVersion: entry.judgePromptVersion ?? null,
    judgePromptPreview: String(entry.judgePromptPreview ?? "").slice(0, 2000),
    judgeRawPreview: String(entry.judgeRawPreview ?? "").slice(0, 4000),
    finalPromptVersion: entry.finalPromptVersion ?? null,
    finalPromptPreview: String(entry.finalPromptPreview ?? "").slice(0, 2000),
    finalRawPreview: String(entry.finalRawPreview ?? "").slice(0, 6000),
    cacheNamespace: entry.cacheNamespace ?? null,
    cachedFrom: entry.cachedFrom ?? null,
    corrections: entry.corrections ?? [],
    error: entry.error ?? null,
  };
  if (!logEnabled()) {
    console.log(`[iev-log] ${record.id} ${record.kind} ${record.verdict ?? record.error} ${record.totalMs}ms`);
    return null;
  }
  try {
    const { put, list, del } = await blob();
    const token = blobToken();
    await put(`iev-logs/${record.id}.json`, JSON.stringify(record), {
      access: "private", contentType: "application/json", token, allowOverwrite: true,
    });
    let index = [];
    try {
      const found = await list({ prefix: INDEX_KEY, token });
      const item = found.blobs.find((candidate) => candidate.pathname === INDEX_KEY);
      if (item) {
        const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
        if (response.ok) index = (await response.json()) ?? [];
      }
    } catch { /* índice novo ou indisponível */ }
    index = [indexEntry(record), ...index.filter((item) => item.id !== record.id)].slice(0, MAX_INDEX);
    try {
      const all = await list({ prefix: "iev-logs/", token });
      const known = new Set(index.map((item) => item.id));
      const orphanIds = all.blobs
        .map((item) => item.pathname)
        .filter((path) => path.startsWith("iev-logs/") && path.endsWith(".json") && path !== INDEX_KEY)
        .map((path) => path.slice("iev-logs/".length, -".json".length))
        .filter((id) => !known.has(id));
      for (const id of orphanIds.slice(0, 10)) {
        const record = await getCheckLog(id);
        if (record) index.push(indexEntry({ ...record, methodologyVersion: record.methodologyVersion ?? "legacy", outcome: record.outcome ?? "legacy", score: record.score ?? null }));
      }
      index.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      index = index.slice(0, MAX_INDEX);
      const keep = new Set(index.map((item) => item.id));
      const records = all.blobs.filter((item) => item.pathname.startsWith("iev-logs/") && item.pathname.endsWith(".json") && item.pathname !== INDEX_KEY);
      if (records.length > MAX_INDEX * 2) {
        const stale = records.map((item) => item.pathname).filter((path) => !keep.has(path.slice("iev-logs/".length, -".json".length)));
        for (const path of stale.slice(0, 20)) await del(path, { token }).catch(() => {});
      }
    } catch { /* recuperação de índice é best-effort */ }
    await put(INDEX_KEY, JSON.stringify(index), {
      access: "private", contentType: "application/json", token, allowOverwrite: true,
    });
    return record.id;
  } catch (error) {
    console.error(`[iev-log] falha ao salvar: ${error?.message}`);
    return null;
  }
}

export async function listCheckLogs() {
  if (!logEnabled()) return { enabled: false, available: 0, max: MAX_INDEX, items: [], hint: "BLOB_READ_WRITE_TOKEN ausente — logs só no console." };
  try {
    const token = blobToken();
    const { list } = await blob();
    const found = await list({ prefix: INDEX_KEY, token });
    const item = found.blobs.find((candidate) => candidate.pathname === INDEX_KEY);
    if (!item) return { enabled: true, available: 0, max: MAX_INDEX, items: [] };
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return { enabled: true, available: 0, max: MAX_INDEX, items: [] };
    const items = (await response.json()) ?? [];
    return { enabled: true, available: items.length, max: MAX_INDEX, items };
  } catch {
    return { enabled: true, available: 0, max: MAX_INDEX, items: [], error: "list-failed" };
  }
}

export async function getCheckLog(id) {
  if (!logEnabled() || !/^[a-z0-9-]+$/i.test(id)) return null;
  try {
    const token = blobToken();
    const { list } = await blob();
    const pathname = `iev-logs/${id}.json`;
    const found = await list({ prefix: pathname, token });
    const item = found.blobs.find((candidate) => candidate.pathname === pathname);
    if (!item) return null;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
