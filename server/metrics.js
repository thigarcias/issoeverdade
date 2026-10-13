// Métricas operacionais por instância (sem conteúdo sensível).
// Objetivo: dar ao painel e ao plantão números observados — volume, desfechos,
// latência, erros, abstenções, tokens e uso de cache — com alertas por limiar.
// Não é auditoria: nada aqui é persistido entre reinícios do processo.
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

const state = {
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

function bump(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + amount;
}

const ABSTENTION_OUTCOMES = new Set(["insufficient_input", "inaccessible_media", "no_verifiable_claims", "moderation_uncovered", "content_refused"]);

/** Registra o desfecho de uma checagem concluída ou recusada. */
export function recordCheck({ kind, outcome, verdict, totalMs, tokens, cached, error, media, moderation } = {}) {
  state.checks++;
  if (cached) state.cached++;
  bump(state.byKind, kind);
  bump(state.byOutcome, outcome ?? (error ? "error" : "legacy"));
  if (error) bump(state.errors, String(error).slice(0, 80));
  if (verdict) bump(state.verdicts, verdict);
  if (ABSTENTION_OUTCOMES.has(outcome)) state.abstentions++;
  if (Number.isFinite(totalMs)) {
    state.latencyMs.push(Math.round(totalMs));
    if (state.latencyMs.length > MAX_LATENCIES) state.latencyMs.shift();
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
  state.lastCheckAt = new Date().toISOString();
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
    window: { startedAt: state.startedAt, sample: state.checks, enoughSample },
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
