// Métricas sem conteúdo sensível: contadores locais para consumidores síncronos,
// histórico durável para o painel administrativo, independente da instância.
import { readMetricsLogs } from "./checklog.js";
const MAX_LATENCIES = 200;

function intEnv(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}

export function alertThresholds(env = process.env) {
  return {
    avgLatencyMs: intEnv(env.IEV_ALERT_AVG_LATENCY_MS, 180_000),
    errorRate: Number.isFinite(Number(env.IEV_ALERT_ERROR_RATE)) ? Number(env.IEV_ALERT_ERROR_RATE) : 0.25,
    abstentionRate: Number.isFinite(Number(env.IEV_ALERT_ABSTENTION_RATE)) ? Number(env.IEV_ALERT_ABSTENTION_RATE) : 0.6,
    budgetUsedPct: Number.isFinite(Number(env.IEV_ALERT_BUDGET_PCT)) ? Number(env.IEV_ALERT_BUDGET_PCT) : 0.8,
    minSample: intEnv(env.IEV_ALERT_MIN_SAMPLE, 10),
  };
}

function emptyState() {
  return {
    startedAt: new Date().toISOString(),
    checks: 0,
    cached: 0,
    byKind: {},
    byOutcome: {},
    errors: {},
    abstentions: 0,
    verdicts: {},
    latencyMs: [],
    tokens: { input: 0, output: 0 },
    media: { transcript: 0, vision: 0, frames: 0 },
    moderation: { refused: 0, uncovered: 0, unavailable: 0, sensitive: 0 },
    corrections: { created: 0, corrected: 0 },
    lastCheckAt: null,
  };
}

const state = emptyState();

function bump(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + amount;
}

const ABSTENTION_OUTCOMES = new Set(["insufficient_input", "inaccessible_media", "no_verifiable_claims", "moderation_uncovered", "content_refused"]);

/** Registra o desfecho de uma checagem concluída ou recusada. */
export function recordCheck({ kind, outcome, verdict, totalMs, tokens, cached, error, media, moderation } = {}) {
  accumulateCheck(state, { kind, outcome, verdict, totalMs, tokens, cached, error, media, moderation }, MAX_LATENCIES);
  state.lastCheckAt = new Date().toISOString();
}

function accumulateCheck(state, { kind, outcome, verdict, totalMs, tokens, cached, error, media, moderation }, latencyLimit = Infinity) {
  state.checks++;
  if (cached) state.cached++;
  bump(state.byKind, kind);
  bump(state.byOutcome, outcome ?? (error ? "error" : "legacy"));
  if (error) bump(state.errors, String(error).slice(0, 80));
  if (verdict) bump(state.verdicts, verdict);
  if (ABSTENTION_OUTCOMES.has(outcome)) state.abstentions++;
  if (Number.isFinite(totalMs)) {
    state.latencyMs.push(Math.round(totalMs));
    if (state.latencyMs.length > latencyLimit) state.latencyMs.shift();
  }
  if (Number.isFinite(tokens?.input)) state.tokens.input += tokens.input;
  if (Number.isFinite(tokens?.output)) state.tokens.output += tokens.output;
  if (media?.transcript) state.media.transcript++;
  if (media?.vision) state.media.vision++;
  if (Number.isFinite(media?.frames)) state.media.frames += media.frames;
  if (moderation?.refused) state.moderation.refused++;
  if (moderation?.uncovered) state.moderation.uncovered++;
  if (moderation?.unavailable) state.moderation.unavailable++;
  if (moderation?.sensitive) state.moderation.sensitive++;
}

export function recordCorrection(event) {
  if (event === "created") state.corrections.created++;
  if (event === "corrected") state.corrections.corrected++;
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

/**
 * Retrato atual com alertas. `extra` traz contexto da implantação (modo dos
 * limites, orçamento consumido, cobertura de moderação) para o painel.
 */
export function snapshot(extra = {}, env = process.env) {
  return renderSnapshot(state, extra, env);
}

function renderSnapshot(state, extra, env) {
  const thresholds = alertThresholds(env);
  const avg = state.latencyMs.length ? Math.round(state.latencyMs.reduce((sum, value) => sum + value, 0) / state.latencyMs.length) : null;
  const errorCount = Object.values(state.errors).reduce((sum, value) => sum + value, 0);
  const errorRate = state.checks ? errorCount / state.checks : 0;
  const abstentionRate = state.checks ? state.abstentions / state.checks : 0;
  const alerts = [];
  const enoughSample = state.checks >= thresholds.minSample;
  if (enoughSample && avg && avg > thresholds.avgLatencyMs) alerts.push({ id: "latency", level: "warning", message: `Latência média ${avg}ms acima do limiar ${thresholds.avgLatencyMs}ms.` });
  if (enoughSample && errorRate > thresholds.errorRate) alerts.push({ id: "error_rate", level: "critical", message: `Taxa de erro ${(errorRate * 100).toFixed(1)}% acima do limiar ${(thresholds.errorRate * 100).toFixed(0)}%.` });
  if (enoughSample && abstentionRate > thresholds.abstentionRate) alerts.push({ id: "abstention", level: "warning", message: `Abstenção em ${(abstentionRate * 100).toFixed(1)}% das checagens (limiar ${(thresholds.abstentionRate * 100).toFixed(0)}%).` });
  if (Number.isFinite(extra.budgetUsedPct) && extra.budgetUsedPct >= thresholds.budgetUsedPct) {
    alerts.push({ id: "budget", level: "warning", message: `Orçamento diário em ${(extra.budgetUsedPct * 100).toFixed(0)}% do teto.` });
  }
  if (extra.limitsMode === "blocked") alerts.push({ id: "limits", level: "critical", message: "Controles de abuso/custo inativos: novas checagens estão sendo recusadas." });
  if (extra.moderationMode === "required" && extra.videoCoverage !== "partial_frames_transcript") {
    alerts.push({ id: "video_coverage", level: "warning", message: "Vídeo desativado: cobertura de moderação de vídeo não declarada." });
  }
  return {
    source: "memory",
    window: { scope: "instance", startedAt: state.startedAt, endedAt: state.lastCheckAt, sample: state.checks, enoughSample, limited: false, latencySample: state.latencyMs.length },
    checks: state.checks,
    cached: state.cached,
    byKind: state.byKind,
    byOutcome: state.byOutcome,
    verdicts: state.verdicts,
    errors: state.errors,
    errorRate,
    abstentions: state.abstentions,
    abstentionRate,
    latency: { avg, p50: percentile(state.latencyMs, 0.5), p95: percentile(state.latencyMs, 0.95) },
    tokens: { ...state.tokens, total: state.tokens.input + state.tokens.output },
    media: state.media,
    moderation: state.moderation,
    corrections: state.corrections,
    lastCheckAt: state.lastCheckAt,
    thresholds,
    alerts,
    note: "Contadores por instância, sem persistência; use junto do painel de registros.",
  };
}

const UNAVAILABLE_MODERATION_REASONS = new Set(["no_key", "empty_result", "missing_key", "timeout", "unreachable", "http_error", "invalid_response", "unavailable"]);

function persistedCheck(record) {
  const phases = Array.isArray(record.phases) ? record.phases : [];
  const cached = Boolean(record.cachedFrom || phases.some((phase) => phase.name === "cache-hit"));
  const reports = Array.isArray(record.moderationReports) && record.moderationReports.length
    ? record.moderationReports : Array.isArray(record.moderation) ? record.moderation.map((report) => {
      if (report && typeof report === "object") return report;
      const match = String(report).match(/:(checked|no_key|empty_result|timeout|unreachable|http_\d+)(?::(.*))?$/);
      return match ? { checked: match[1] === "checked", reason: match[1], categories: match[2]?.split("|") ?? [] } : {};
    }) : [];
  const attempts = Array.isArray(record.mediaAttempts) ? record.mediaAttempts : [];
  const legacyFrameCount = attempts.reduce((count, attempt) => {
    const match = String(attempt).match(/^frames:[^:]+:(\d+)$/);
    return match ? Math.max(count, Number(match[1])) : count;
  }, 0);
  const coverage = record.mediaCoverage;
  const transcript = coverage?.transcript === "timestamped" || coverage?.transcript === "text-only" || record.transcriptSegs > 0 || Boolean(record.transcriptPreview) ||
    attempts.some((attempt) => /^transcribe:.*:\d+ segmentos$/.test(String(attempt)));
  const vision = coverage?.frames === "sampled-and-described" || coverage?.image === "described" ||
    attempts.some((attempt) => /^vision:.*:ok$/.test(String(attempt)));
  return {
    kind: record.kind,
    outcome: record.outcome ?? (record.error || record.errorCode ? "error" : record.verdict ? "checked" : "legacy"),
    verdict: record.verdict,
    totalMs: record.totalMs,
    // Cached logs may contain diagnostics copied from the original execution;
    // they represent no new provider usage or media/moderation work.
    cached,
    tokens: cached ? null : record.tokenUsage,
    error: record.errorCode || record.error || (record.outcome === "error" ? "unknown_error" : null),
    media: cached ? null : { transcript, vision, frames: Number.isFinite(coverage?.sampledFrameCount) ? coverage.sampledFrameCount : legacyFrameCount },
    moderation: cached ? null : {
      refused: record.outcome === "content_refused",
      uncovered: record.outcome === "moderation_uncovered",
      unavailable: record.errorCode === "moderation_unavailable" || record.error === "moderation_unavailable" ||
        reports.some((report) => !report.checked && (UNAVAILABLE_MODERATION_REASONS.has(report.reason) || String(report.reason ?? "").startsWith("http_"))),
      sensitive: reports.some((report) => Array.isArray(report.categories) && report.categories.length > 0),
    },
  };
}

/** Administrative snapshot based only on retained persisted logs, never memory. */
export async function durableSnapshot(extra = {}, env = process.env) {
  const history = await readMetricsLogs(env);
  if (!history) return snapshot(extra, env);
  const aggregate = emptyState();
  aggregate.startedAt = null;
  const protocols = new Set();
  let correctionsWithoutProtocol = 0;
  for (const record of history.records) {
    accumulateCheck(aggregate, persistedCheck(record));
    if (!aggregate.startedAt || Date.parse(record.at) < Date.parse(aggregate.startedAt)) aggregate.startedAt = record.at;
    if (!aggregate.lastCheckAt || Date.parse(record.at) > Date.parse(aggregate.lastCheckAt)) aggregate.lastCheckAt = record.at;
    for (const correction of Array.isArray(record.editorialCorrections) ? record.editorialCorrections : []) {
      if (correction.status && correction.status !== "corrected") continue;
      if (correction.protocol) protocols.add(correction.protocol);
      else correctionsWithoutProtocol++;
    }
    if (record.correctedAt && !record.editorialCorrections?.length) correctionsWithoutProtocol++;
  }
  aggregate.corrections = history.corrections ?? { created: null, corrected: protocols.size + correctionsWithoutProtocol };
  const result = renderSnapshot(aggregate, extra, env);
  return {
    ...result,
    source: history.mode,
    window: {
      ...result.window, scope: "latest_retained_checks", endedAt: aggregate.lastCheckAt,
      capturedAt: history.capturedAt, limit: history.limit, limited: history.limited,
      correctionsScope: history.corrections ? "all_retained_reports" : "editorial_corrections_in_window",
    },
    note: `Histórico persistido: até ${history.limit} checagens retidas mais recentes, de qualquer data.${history.limited ? " Há registros anteriores fora desta janela." : ""} Latência usa toda a janela; tokens, mídia e moderação contam apenas trabalho não servido de cache. Campos ausentes nos registros antigos não podem ser recuperados. ${history.corrections ? "Correções: todos os pedidos retidos no Blob (corrigidos = estado atual)." : "Correções: somente alterações editoriais nos logs da janela; pedidos criados indisponíveis (null)."} A retenção do armazenamento pode excluir registros antigos.`,
  };
}

/** Somente para testes: zera os contadores do processo. */
export function resetMetrics() {
  state.checks = 0;
  state.cached = 0;
  state.byKind = {};
  state.byOutcome = {};
  state.errors = {};
  state.abstentions = 0;
  state.verdicts = {};
  state.latencyMs = [];
  state.tokens = { input: 0, output: 0 };
  state.media = { transcript: 0, vision: 0, frames: 0 };
  state.moderation = { refused: 0, uncovered: 0, unavailable: 0, sensitive: 0 };
  state.corrections = { created: 0, corrected: 0 };
  state.lastCheckAt = null;
  state.startedAt = new Date().toISOString();
}
