// Registros privados no Supabase; Blob privado quando Supabase não configurado.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { publicCheckEnvelope } from "./public-check.js";
import { supabaseConfigured, supabaseRequest, StorageError, reportStorageError, storageFailureMessage } from "./supabase.js";
const INDEX_KEY = "iev-logs/index.json";
const MAX_INDEX = 200;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function logMode(env = process.env) {
  return supabaseConfigured(env) ? "supabase" : env.BLOB_READ_WRITE_TOKEN ? "blob" : "disabled";
}

export function logEnabled(env = process.env) {
  return logMode(env) !== "disabled";
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
    errorCode: record.errorCode,
    errorStatus: record.errorStatus,
    failedPhase: record.failedPhase,
    inputPreview: record.inputPreview,
  };
}

export async function saveCheckLog(entry, { sharing = null } = {}) {
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
    // Legado v≤18: score null preservado para "sem nota"; novos checked/unproven trazem número.
    score: typeof entry.score === "number" ? entry.score : null,
    summary: String(entry.summary ?? ""),
    claims: Array.isArray(entry.claims) ? entry.claims.slice(0, 50) : [],
    notCheckedClaims: Array.isArray(entry.notCheckedClaims) ? entry.notCheckedClaims.slice(0, 50) : [],
    omittedClaimsCount: entry.omittedClaimsCount ?? 0,
    coverage: entry.coverage ?? null,
    sources: Array.isArray(entry.sources) ? entry.sources.slice(0, 30) : [],
    researchCitations: Array.isArray(entry.researchCitations) ? entry.researchCitations.slice(0, 50) : [],
    researchQueries: Array.isArray(entry.researchQueries) ? entry.researchQueries.slice(0, 20) : [],
    researchDiagnostics: Array.isArray(entry.researchDiagnostics) ? entry.researchDiagnostics.slice(0, 4) : [],
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
    cacheNamespace: entry.cacheNamespace ?? null,
    cachedFrom: entry.cachedFrom ?? null,
    corrections: entry.corrections ?? [],
    editorialCorrections: entry.editorialCorrections ?? [],
    correctedAt: entry.correctedAt ?? null,
    moderation: entry.moderation ?? [],
    moderationReports: entry.moderationReports ?? [],
    moderationCoverage: entry.moderationCoverage ?? null,
    purposeTriage: entry.purposeTriage ?? null,
    tokenUsage: entry.tokenUsage ?? null,
    evidence: entry.evidence ?? null,
    evidenceVerification: entry.evidenceVerification ?? null,
    error: entry.error ?? null,
    errorStatus: Number.isInteger(entry.errorStatus) ? entry.errorStatus : null,
    errorCode: entry.errorCode ?? entry.error ?? null,
    failedPhase: entry.failedPhase ?? [...(entry.phases ?? [])].reverse().find((phase) => !phase.ok)?.name ?? null,
  };
  if (sharing) record._sharing = sharing;
  if (logMode() === "supabase") {
    try {
      await supabaseRequest("iev_checks", {
        method: "POST",
        body: {
          id: record.id, at: record.at, kind: record.kind, outcome: record.outcome,
          input_preview: record.inputPreview, index_entry: indexEntry(record), log: Object.fromEntries(Object.entries(record).filter(([key]) => key !== "_sharing")),
          public_envelope: sharing?.envelope ?? null, share_token_hash: sharing?.tokenHash ?? null,
        },
        prefer: "return=minimal",
      });
      return record.id;
    } catch (error) {
      reportStorageError("save", "supabase", error);
      return null;
    }
  }
  if (!logEnabled()) {
    console.log("[iev-log]", JSON.stringify({ id: record.id, kind: record.kind, outcome: record.outcome, totalMs: record.totalMs, mode: "disabled" }));
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
        if (!response.ok) throw new StorageError("storage_request_failed", response.status);
        index = (await response.json()) ?? [];
      }
    } catch (error) { reportStorageError("index-read", "blob", error); }
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
    reportStorageError("save", "blob", error);
    return null;
  }
}

export function normalizeLogQuery(query = {}) {
  const integer = (value, fallback, max) => {
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(String(value)) || Number(value) > max) throw new StorageError("invalid_log_query", 400);
    return Number(value);
  };
  const date = (value) => {
    if (value === undefined || value === "") return null;
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(text) || !Number.isFinite(Date.parse(text))) throw new StorageError("invalid_log_query", 400);
    return new Date(text).toISOString();
  };
  const filters = {
    q: String(query.q ?? "").trim().slice(0, 300),
    outcome: String(query.outcome ?? "").slice(0, 80),
    kind: String(query.kind ?? "").slice(0, 40),
    filter: String(query.filter ?? query.status ?? "all"),
    sort: String(query.sort ?? "newest"),
    from: date(query.from), to: date(query.to),
    offset: integer(query.offset, 0, 1000000), limit: integer(query.limit, 50, 100),
  };
  if (filters.limit < 1 || (filters.from && filters.to && filters.from > filters.to)) throw new StorageError("invalid_log_query", 400);
  if (!["all", "error", "no-verdict", "true", "mostly_true", "partially_true", "distorted", "unproven", "misleading", "false"].includes(filters.filter) || !["newest", "oldest", "slowest", "lowest"].includes(filters.sort)) throw new StorageError("invalid_log_query", 400);
  if (filters.outcome === "all") filters.outcome = "";
  if (filters.kind === "all") filters.kind = "";
  return filters;
}

export function filterCheckLogIndex(index, filters) {
  const q = filters.q.toLocaleLowerCase();
  return index.filter((item) => {
    const verdict = item.verdict === "mixed" ? Number(item.score) >= 65 ? "partially_true" : "distorted" : item.verdict;
    const isError = Boolean(item.error || item.outcome === "error");
    const chip = filters.filter === "all" || (filters.filter === "error" ? isError : filters.filter === "no-verdict" ? verdict == null && !isError : verdict === filters.filter);
    return chip && (!q || String(item.id).toLocaleLowerCase() === q || String(item.inputPreview ?? "").toLocaleLowerCase().includes(q)) &&
      (!filters.outcome || item.outcome === filters.outcome) && (!filters.kind || item.kind === filters.kind) &&
      (!filters.from || item.at >= filters.from) && (!filters.to || item.at <= filters.to);
  }).sort((a, b) => {
    const primary = filters.sort === "oldest" ? String(a.at).localeCompare(String(b.at))
      : filters.sort === "slowest" ? (b.totalMs ?? -1) - (a.totalMs ?? -1)
        : filters.sort === "lowest" ? (a.score ?? 101) - (b.score ?? 101)
          : String(b.at).localeCompare(String(a.at));
    return primary || String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id));
  });
}

export async function listCheckLogs(query = {}) {
  const filters = normalizeLogQuery(query);
  const mode = logMode();
  const base = { enabled: logEnabled(), available: 0, total: 0, max: mode === "supabase" ? null : MAX_INDEX, items: [], offset: filters.offset, limit: filters.limit, mode };
  if (mode === "disabled") return { ...base, hint: "Armazenamento durável de logs não configurado." };
  try {
    if (mode === "supabase") {
      const { data } = await supabaseRequest("rpc/iev_list_checks", {
        method: "POST",
        body: { p_q: filters.q, p_outcome: filters.outcome, p_kind: filters.kind, p_from: filters.from, p_to: filters.to, p_offset: filters.offset, p_limit: filters.limit, p_filter: filters.filter, p_sort: filters.sort },
      });
      if (!data || !Number.isSafeInteger(data.total) || !Array.isArray(data.items)) throw new StorageError("storage_invalid_response");
      return { ...base, available: data.total, total: data.total, items: data.items };
    }
    const token = blobToken();
    const { list } = await blob();
    const found = await list({ prefix: INDEX_KEY, token });
    const item = found.blobs.find((candidate) => candidate.pathname === INDEX_KEY);
    if (!item) return base;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new StorageError("storage_request_failed", response.status);
    const index = await response.json();
    if (!Array.isArray(index)) throw new StorageError("storage_invalid_response");
    const items = filterCheckLogIndex(index, filters);
    return { ...base, available: index.length, total: items.length, items: items.slice(filters.offset, filters.offset + filters.limit) };
  } catch (error) {
    reportStorageError("list", mode, error);
    return { ...base, error: "list_failed", errorCode: error instanceof StorageError ? error.code : "storage_failed", message: storageFailureMessage(mode, error) };
  }
}

const METRICS_LIMIT = 1000;
const METRICS_PAGE_SIZE = 200;
const METRICS_BLOB_SCAN_LIMIT = 10000;

// Read the objects, not the capped/best-effort indexes: older retained logs and
// reports can exist without an index entry. Any failed page/object fails metrics.
async function retainedBlobRecords(prefix, env) {
  const { list } = await blob();
  const token = env.BLOB_READ_WRITE_TOKEN;
  const paths = new Set();
  let cursor;
  const cursors = new Set();
  do {
    const page = await list({ prefix, token, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.blobs)) throw new StorageError("storage_invalid_response");
    for (const item of page.blobs) {
      if (typeof item.pathname !== "string" || !item.pathname.startsWith(prefix) || !item.pathname.endsWith(".json") || item.pathname === `${prefix}index.json`) continue;
      paths.add(item.pathname);
      if (paths.size > METRICS_BLOB_SCAN_LIMIT) throw new StorageError("metrics_scan_limit");
    }
    if (!page.hasMore) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new StorageError("storage_invalid_response");
    cursor = page.cursor;
    cursors.add(cursor);
  } while (cursor);
  const records = [];
  const pathnames = [...paths];
  const { get } = await blob();
  for (let offset = 0; offset < pathnames.length; offset += 8) {
    const batch = await Promise.all(pathnames.slice(offset, offset + 8).map(async (pathname) => {
      const result = await get(pathname, { access: "private", token, useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) throw new StorageError("storage_read_failed");
      let record;
      try { record = await new Response(result.stream).json(); }
      catch { throw new StorageError("storage_invalid_response"); }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new StorageError("storage_invalid_response");
      return record;
    }));
    records.push(...batch);
  }
  return records;
}

/** Bounded retained-history input for administrative metrics; never merges memory. */
export async function readMetricsLogs(env = process.env) {
  const mode = logMode(env);
  const capturedAt = new Date().toISOString();
  if (mode === "disabled") return null;
  let records = [];
  if (mode === "supabase") {
    let before = null;
    const seen = new Set();
    while (records.length <= METRICS_LIMIT) {
      const query = {
        select: "id,at,kind,outcome,log", order: "at.desc,id.desc",
        at: `lte.${capturedAt}`, limit: String(Math.min(METRICS_PAGE_SIZE, METRICS_LIMIT + 1 - records.length)),
      };
      if (before) query.or = `(at.lt.${before.at},and(at.eq.${before.at},id.lt.${before.id}))`;
      const { data } = await supabaseRequest("iev_checks", { query }, env);
      if (!Array.isArray(data) || data.length > Number(query.limit)) throw new StorageError("storage_invalid_response");
      if (data.length === 0) break;
      for (const row of data) {
        if (!validCheckId(row?.id) || !Number.isFinite(Date.parse(row?.at)) || !row.log || typeof row.log !== "object" || Array.isArray(row.log)) throw new StorageError("storage_invalid_response");
        if (seen.has(row.id) || Date.parse(row.at) > Date.parse(capturedAt)) throw new StorageError("storage_invalid_response");
        seen.add(row.id);
        records.push({ ...row.log, id: row.id, at: row.at, kind: row.kind, outcome: row.outcome });
        before = row;
      }
    }
  } else {
    records = (await retainedBlobRecords("iev-logs/", env)).filter((record) => {
      if (!validCheckId(record.id) || !Number.isFinite(Date.parse(record.at))) throw new StorageError("storage_invalid_response");
      return Date.parse(record.at) <= Date.parse(capturedAt);
    });
    records.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || String(b.id).localeCompare(String(a.id)));
  }
  const limited = records.length > METRICS_LIMIT;
  records = records.slice(0, METRICS_LIMIT);
  let corrections = null;
  if (env.BLOB_READ_WRITE_TOKEN) {
    const reports = await retainedBlobRecords("iev-corrections/", env);
    const protocols = new Set();
    corrections = { created: 0, corrected: 0 };
    for (const report of reports) {
      if (typeof report.protocol !== "string" || typeof report.status !== "string") throw new StorageError("storage_invalid_response");
      if (protocols.has(report.protocol)) continue;
      protocols.add(report.protocol);
      corrections.created++;
      if (report.status === "corrected") corrections.corrected++;
    }
  }
  return { mode, records, capturedAt, limit: METRICS_LIMIT, limited, corrections };
}

async function readCheckRecord(id) {
  if (!logEnabled() || !validCheckId(id)) return null;
  if (logMode() === "supabase") {
    const { data } = await supabaseRequest("iev_checks", { query: { id: `eq.${id}`, select: "log,public_envelope,share_token_hash,published_at", limit: "1" } });
    const row = data?.[0];
    return row ? { ...row.log, _sharing: { envelope: row.public_envelope, tokenHash: row.share_token_hash, publishedAt: row.published_at } } : null;
  }
  try {
    const token = blobToken();
    const { list } = await blob();
    const pathname = `iev-logs/${id}.json`;
    const found = await list({ prefix: pathname, token });
    const item = found.blobs.find((candidate) => candidate.pathname === pathname);
    if (!item) return null;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new StorageError("storage_request_failed", response.status);
    return await response.json();
  } catch (error) {
    reportStorageError("read", "blob", error);
    throw new StorageError("storage_read_failed");
  }
}

export function validCheckId(id) {
  return typeof id === "string" && /^[a-z0-9-]{1,100}$/i.test(id);
}

export async function getCheckLog(id) {
  const record = await readCheckRecord(id);
  if (!record) return null;
  const { _sharing, ...privateLog } = record;
  return privateLog;
}

export async function saveSuccessfulCheck(entry, envelope) {
  const shareToken = randomBytes(32).toString("base64url");
  const at = entry.at ?? new Date().toISOString();
  const sharing = {
    tokenHash: createHash("sha256").update(shareToken).digest("hex"),
    envelope: publicCheckEnvelope(envelope, { checkId: entry.id, createdAt: at }),
    publishedAt: null,
  };
  const id = await saveCheckLog({ ...entry, at }, { sharing });
  return id ? { persisted: true, ...(entry.outcome === "content_refused" ? {} : { shareToken }) } : { persisted: false };
}

export async function getPublishedCheck(id) {
  if (!validCheckId(id) || !logEnabled()) return null;
  if (logMode() === "supabase") {
    const { data } = await supabaseRequest("iev_checks", { query: { id: `eq.${id}`, published_at: "not.is.null", outcome: "neq.content_refused", select: "public_envelope", limit: "1" } });
    return data?.[0]?.public_envelope ? publicCheckEnvelope(data[0].public_envelope) : null;
  }
  const record = await readCheckRecord(id);
  return record?._sharing?.publishedAt && record.outcome !== "content_refused"
    ? publicCheckEnvelope(record._sharing.envelope) : null;
}

export async function publishCheck(id, token) {
  const record = await readCheckRecord(id);
  const expected = record?._sharing?.tokenHash;
  const actual = createHash("sha256").update(token).digest();
  const hash = typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) ? Buffer.from(expected, "hex") : Buffer.alloc(32);
  const authorized = timingSafeEqual(actual, hash);
  if (!authorized || !expected || !record?._sharing?.envelope || record.outcome === "content_refused") return false;
  if (record._sharing.publishedAt) return true;
  const publishedAt = new Date().toISOString();
  if (logMode() === "supabase") {
    const { data } = await supabaseRequest("iev_checks", {
      method: "PATCH",
      query: { id: `eq.${id}`, share_token_hash: `eq.${expected}`, outcome: "neq.content_refused", select: "id" },
      body: { published_at: publishedAt }, prefer: "return=representation",
    });
    if (!data?.length) throw new StorageError("storage_publish_failed");
  } else {
    const { put } = await blob();
    await put(`iev-logs/${id}.json`, JSON.stringify({ ...record, _sharing: { ...record._sharing, publishedAt } }), {
      access: "private", contentType: "application/json", token: blobToken(), allowOverwrite: true,
    });
  }
  return true;
}

/**
 * Marca uma correção editorial no registro de checagem: preserva a execução
 * original, registra o protocolo e o motivo e atualiza a versão vigente.
 */
export async function appendCorrectionToLog(id, { protocol, note, actor, status } = {}) {
  if (!logEnabled()) return { ok: false, error: "log_disabled" };
  let record;
  try { record = await readCheckRecord(id); }
  catch { return { ok: false, error: "storage_read_failed" }; }
  if (!record) return { ok: false, error: "not_found" };
  const at = new Date().toISOString();
  const updated = {
    ...record,
    correctedAt: at,
    editorialCorrections: [
      ...(record.editorialCorrections ?? []),
      { at, protocol: String(protocol ?? "").slice(0, 80), note: String(note ?? "").slice(0, 1000), actor: String(actor ?? "admin").slice(0, 80), status: status ?? "corrected" },
    ],
  };
  try {
    if (logMode() === "supabase") {
      const { _sharing, ...log } = updated;
      await supabaseRequest("iev_checks", { method: "PATCH", query: { id: `eq.${id}` }, body: { log, index_entry: indexEntry(log) }, prefer: "return=minimal" });
      return { ok: true, record: log };
    }
    const token = blobToken();
    const { put } = await blob();
    await put(`iev-logs/${id}.json`, JSON.stringify(updated), {
      access: "private", contentType: "application/json", token, allowOverwrite: true,
    });
    const { _sharing, ...log } = updated;
    return { ok: true, record: log };
  } catch (error) {
    reportStorageError("correction", logMode(), error);
    return { ok: false, error: "storage_write_failed" };
  }
}
