// Métricas sem conteúdo sensível: contadores locais para consumidores síncronos,
// histórico durável para o painel administrativo, independente da instância.
import { readMetricsLogs } from "./checklog.js";
import { limitsConfig } from "./limits.js";
const MAX_LATENCIES = 200;
const METRICS_TIME_ZONE = "America/Sao_Paulo";
const dayFormatter = new Intl.DateTimeFormat("en", {
  timeZone: METRICS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

function eventDate(at) {
  if (typeof at !== "string" || !at.trim()) return null;
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return null;
  const parts = dayFormatter.formatToParts(timestamp);
  const part = (type) => parts.find((value) => value.type === type).value;
  return { timestamp, date: `${part("year")}-${part("month")}-${part("day")}` };
}

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
// Abstenção é por outcome sem claim factual, não por score: checked/unproven com nota 45 seguem fora deste contador; só outcomes sem alegação contam (legado null e novos null entram igual).

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
    timeZone: METRICS_TIME_ZONE,
    daily: null,
    dailyExcludedInvalidAt: 0,
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
    note: "Contadores por instância, sem persistência; use junto do painel de registros. Histórico diário indisponível neste modo.",
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

const METRICS_PERIODS = ["7d", "30d", "all"];
const METRICS_PERIOD_MS = { "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000 };
const METRICS_MAX_FILTER_CHARS = 160;
const METRICS_MODEL_STEPS = ["judge", "article-research", "evidence-review", "evidence-research", "evidence-rereview", "transcribe", "vision"];
const METRICS_CAPABILITIES = [
  { id: "judge", label: "Julgamento" },
  { id: "article-research", label: "Pesquisa do artigo" },
  { id: "evidence-review", label: "Revisão de evidências" },
  { id: "evidence-research", label: "Pesquisa de evidências" },
  { id: "evidence-rereview", label: "Revisão adicional de evidências" },
  { id: "transcribe", label: "Transcrição" },
  { id: "vision", label: "Visão" },
  { id: "web_search", label: "Busca web" },
  { id: "evidence", label: "Dossiê de evidências" },
  { id: "evidence-recovered", label: "Evidências recuperadas" },
  { id: "moderation", label: "Moderação" },
];

function cleanMetricsText(value) {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  if (list.length !== 1) return false;
  const text = String(list[0]).trim();
  if (!text) return null;
  return text.length <= METRICS_MAX_FILTER_CHARS ? text : false;
}

function validMetricsDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function splitModelFilter(model) {
  const index = model.indexOf(":");
  if (index < 0) return { provider: null, model };
  const provider = model.slice(0, index).trim() || null;
  const name = model.slice(index + 1).trim();
  if (!name) return null;
  return { provider, model: name };
}

/**
 * Filtros da aba Métricas (`period`, `provider`, `model`, `kind` vindos da
 * query). Sem `period` o padrão da API é `7d`; `model` aceita
 * `provider:modelo` ou só o nome do modelo. Malformado →
 * `{ ok: false, error: "invalid_metrics_query" }`. Filtro válido sem matches
 * não é erro: o agregado sai zerado com nota ("Nenhum registro corresponde
 * aos filtros."). `durableSnapshot` sem `filters` usa a janela completa.
 */
export function parseMetricsFilters(query = {}) {
  const source = query ?? {};
  const periodText = cleanMetricsText(source.period);
  const rawPeriod = periodText === null ? "7d" : periodText;
  const provider = cleanMetricsText(source.provider);
  const model = cleanMetricsText(source.model);
  const kind = cleanMetricsText(source.kind);
  const period = rawPeriod === false ? null
    : rawPeriod === "7d" || rawPeriod === "30d" || rawPeriod === "all" ? rawPeriod
    : validMetricsDay(rawPeriod) ? rawPeriod : null;
  if (!period || provider === false || model === false || kind === false) {
    return { ok: false, error: "invalid_metrics_query" };
  }
  if (model && !splitModelFilter(model)) return { ok: false, error: "invalid_metrics_query" };
  return { ok: true, filters: { period, provider, model, kind } };
}

function modelsUsedList(record) {
  const used = record?.modelsUsed;
  if (!used || typeof used !== "object" || Array.isArray(used)) return [];
  const out = [];
  for (const [step, entry] of Object.entries(used)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out.push({
      step,
      provider: typeof entry.provider === "string" ? entry.provider : null,
      model: typeof entry.model === "string" ? entry.model : null,
    });
  }
  return out;
}

function recordMatchesFilters(record, event, filters, nowMs) {
  if (!filters) return true;
  if (filters.kind && record?.kind !== filters.kind) return false;
  if (filters.provider) {
    const entries = modelsUsedList(record);
    if (record?.provider !== filters.provider && !entries.some((entry) => entry.provider === filters.provider)) return false;
  }
  if (filters.model) {
    const parsed = splitModelFilter(filters.model);
    if (!parsed) return false;
    const entries = modelsUsedList(record);
    const hit = parsed.provider
      ? ((record?.provider === parsed.provider && record?.model === parsed.model) || entries.some((entry) => entry.provider === parsed.provider && entry.model === parsed.model))
      : (record?.model === parsed.model || entries.some((entry) => entry.model === parsed.model));
    if (!hit) return false;
  }
  if (filters.period && filters.period !== "all") {
    if (METRICS_PERIOD_MS[filters.period]) {
      const timestamp = event ? event.timestamp : Date.parse(record?.at);
      if (!Number.isFinite(timestamp) || timestamp < nowMs - METRICS_PERIOD_MS[filters.period]) return false;
    } else if (!event || event.date !== filters.period) {
      return false;
    }
  }
  return true;
}

function emptyUsageAcc() {
  return {
    units: 0, byKind: new Map(),
    tokens: { input: 0, output: 0 },
    steps: new Map(), providers: new Map(), models: new Map(),
    queries: 0, diagnostics: 0, checksWithQueries: 0,
    dossier: 0, reviewed: 0, recovered: 0,
    moderationChecks: 0, refused: 0, unavailable: 0, sensitive: 0,
    transcriptions: 0, visions: 0, frames: 0,
  };
}

function phasePresent(record, name) {
  return Array.isArray(record?.phases) && record.phases.some((phase) => phase?.name === name && phase?.ok !== false);
}

/**
 * Soma sinais de uso de um registro filtrado. Cache-hit representa trabalho
 * já pago: 0 unidades novas, 0 tokens novos e nenhuma chamada nova — por isso
 * todos os sinais (etapas, provedores, busca, evidências, moderação, mídia)
 * são ignorados quando `check.cached`. Tokens existem só por checagem; as
 * capacidades trazem calls/checks, nunca tokens.
 */
function accumulateUsage(acc, record, check, checkUnits, checkId) {
  const kind = record?.kind ?? check.kind ?? "unknown";
  let kindEntry = acc.byKind.get(kind);
  if (!kindEntry) { kindEntry = { checks: 0, units: 0 }; acc.byKind.set(kind, kindEntry); }
  kindEntry.checks++;
  kindEntry.units += checkUnits;
  acc.units += checkUnits;
  if (check.cached) return;
  if (Number.isFinite(check.tokens?.input)) acc.tokens.input += check.tokens.input;
  if (Number.isFinite(check.tokens?.output)) acc.tokens.output += check.tokens.output;
  const entries = modelsUsedList(record);
  const seenSteps = new Set();
  const providers = new Map();
  const models = new Map();
  for (const entry of entries) {
    if (entry.step && !seenSteps.has(entry.step)) {
      seenSteps.add(entry.step);
      acc.steps.set(entry.step, (acc.steps.get(entry.step) ?? 0) + 1);
    }
    if (entry.provider) providers.set(entry.provider, (providers.get(entry.provider) ?? 0) + 1);
    if (entry.provider && entry.model) {
      const key = `${entry.provider}:${entry.model}`;
      models.set(key, (models.get(key) ?? 0) + 1);
    }
  }
  for (const step of METRICS_MODEL_STEPS) {
    if (!seenSteps.has(step) && phasePresent(record, step)) {
      seenSteps.add(step);
      acc.steps.set(step, (acc.steps.get(step) ?? 0) + 1);
    }
  }
  for (const [provider, calls] of providers) {
    let slot = acc.providers.get(provider);
    if (!slot) { slot = { checks: new Set(), calls: 0 }; acc.providers.set(provider, slot); }
    slot.calls += calls;
    slot.checks.add(checkId);
  }
  for (const [key, calls] of models) {
    let slot = acc.models.get(key);
    if (!slot) { slot = { checks: new Set(), calls: 0 }; acc.models.set(key, slot); }
    slot.calls += calls;
    slot.checks.add(checkId);
  }
  const queries = Array.isArray(record?.researchQueries) ? record.researchQueries : [];
  const diagnostics = Array.isArray(record?.researchDiagnostics) ? record.researchDiagnostics : [];
  if (queries.length > 0 || diagnostics.length > 0) acc.checksWithQueries++;
  acc.queries += queries.length;
  acc.diagnostics += diagnostics.length;
  if (record?.evidence !== null && record?.evidence !== undefined) acc.dossier++;
  if (record?.evidenceVerification !== null && record?.evidenceVerification !== undefined) acc.reviewed++;
  if (phasePresent(record, "evidence-recovered")) acc.recovered++;
  const reports = Array.isArray(record?.moderationReports) ? record.moderationReports : null;
  const legacy = Array.isArray(record?.moderation) ? record.moderation : null;
  if ((reports && reports.length > 0) || (legacy && legacy.length > 0)) acc.moderationChecks++;
  if (check.moderation?.refused) acc.refused++;
  if (check.moderation?.unavailable) acc.unavailable++;
  if (check.moderation?.sensitive) acc.sensitive++;
  if (check.media?.transcript) acc.transcriptions++;
  if (check.media?.vision) acc.visions++;
  if (Number.isFinite(check.media?.frames)) acc.frames += check.media.frames;
}

function renderUsage(acc, filtersApplied, unitCosts) {
  const steps = {};
  for (const [step, calls] of [...acc.steps.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    steps[step] = { calls };
  }
  const byKind = {};
  for (const [kind, entry] of [...acc.byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byKind[kind] = { checks: entry.checks, units: entry.units };
  }
  const byProvider = {};
  for (const [provider, slot] of [...acc.providers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byProvider[provider] = { checks: slot.checks.size, calls: slot.calls };
  }
  const byModel = {};
  for (const [key, slot] of [...acc.models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byModel[key] = { checks: slot.checks.size, calls: slot.calls };
  }
  const capabilities = [];
  const pushCapability = (meta, calls, checks, detail) => {
    if (!Number.isFinite(calls) || calls <= 0) return;
    capabilities.push({ id: meta.id, label: meta.label, calls, checks, detail });
  };
  for (const meta of METRICS_CAPABILITIES) {
    if (meta.id === "web_search") {
      pushCapability(meta, acc.queries + acc.diagnostics, acc.checksWithQueries,
        `${acc.queries} consulta(s) em ${acc.checksWithQueries} checagem(ns) com busca web (sinais researchQueries/researchDiagnostics).`);
    } else if (meta.id === "evidence") {
      pushCapability(meta, acc.dossier, acc.dossier,
        `${acc.dossier} checagem(ns) com dossiê de evidências (sinais evidence/evidenceVerification).`);
    } else if (meta.id === "evidence-recovered") {
      pushCapability(meta, acc.recovered, acc.recovered,
        `${acc.recovered} checagem(ns) com coleta documental (fase evidence-recovered; sem chamada nova de modelo).`);
    } else if (meta.id === "moderation") {
      pushCapability(meta, acc.moderationChecks, acc.moderationChecks,
        `${acc.moderationChecks} checagem(ns) com moderação registrada (sinal moderationReports).`);
    } else {
      const calls = acc.steps.get(meta.id) ?? 0;
      pushCapability(meta, calls, calls,
        `${calls} chamada(s) em ${calls} checagem(ns) via modelsUsed, com fallback de phases.`);
    }
  }
  return {
    scope: "estimated_from_retained_logs",
    filtersApplied: { ...filtersApplied },
    units: {
      estimated: acc.units,
      byKind,
      unitCosts: { ...unitCosts },
      basis: "Estimativa a partir dos logs retidos: unidades de custo vigentes por tipo (IEV_COST_UNITS ou padrão text=1, link=2, image=2, video=4); cache-hit custa 0 unidades novas e 0 tokens novos; tipos sem custo configurado contam 1 unidade. Unidades não são moeda nem preço por modelo; o log guarda tokens só por checagem (total), nunca por etapa ou modelo.",
    },
    tokens: { input: acc.tokens.input, output: acc.tokens.output, total: acc.tokens.input + acc.tokens.output },
    steps,
    webSearch: { checksWithQueries: acc.checksWithQueries, queries: acc.queries },
    evidence: { checksWithDossier: acc.dossier, checksReviewed: acc.reviewed },
    moderation: { checks: acc.moderationChecks, refused: acc.refused, unavailable: acc.unavailable, sensitive: acc.sensitive },
    media: { transcriptions: acc.transcriptions, visions: acc.visions, frames: acc.frames },
    providers: { byProvider, byModel },
    capabilities,
  };
}

/** Opções estáveis calculadas do histórico SEM filtros (inclui cache-hits). */
function buildUsageOptions(records) {
  const providers = new Set();
  const models = new Map();
  const kinds = new Set();
  const days = new Set();
  for (const record of records) {
    if (typeof record?.provider === "string" && record.provider) providers.add(record.provider);
    if (typeof record?.kind === "string" && record.kind) kinds.add(record.kind);
    for (const entry of modelsUsedList(record)) {
      if (entry.provider) providers.add(entry.provider);
      if (entry.provider && entry.model) models.set(`${entry.provider}:${entry.model}`, { provider: entry.provider, model: entry.model });
    }
    const event = eventDate(record?.at);
    if (event) days.add(event.date);
  }
  return {
    periods: [...METRICS_PERIODS],
    providers: [...providers].sort((a, b) => a.localeCompare(b)),
    models: [...models.values()]
      .sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`))
      .map(({ provider, model }) => ({ provider, model, label: `${provider}:${model}` })),
    kinds: [...kinds].sort((a, b) => a.localeCompare(b)),
    days: [...days].sort((a, b) => a.localeCompare(b)),
  };
}

/** Sem histórico durável não há estimativa: uso null e opções vazias. */
function emptyUsageOptions() {
  return { periods: [...METRICS_PERIODS], providers: [], models: [], kinds: [], days: [] };
}

/** Administrative snapshot based only on retained persisted logs, never memory. */
export async function durableSnapshot(extra = {}, env = process.env, filters = null) {
  const history = await readMetricsLogs(env);
  const unitCosts = { ...(limitsConfig(env)?.costUnits ?? {}) };
  if (!history) {
    return { ...snapshot(extra, env), usage: null, usageOptions: emptyUsageOptions() };
  }
  const usageOptions = buildUsageOptions(history.records);
  const filtersApplied = {
    period: filters?.period ?? "all",
    provider: filters?.provider ?? null,
    model: filters?.model ?? null,
    kind: filters?.kind ?? null,
  };
  const filtersActive = Boolean(filters) && (filtersApplied.period !== "all" || Boolean(filtersApplied.provider || filtersApplied.model || filtersApplied.kind));
  const nowMs = Date.parse(history.capturedAt);
  const aggregate = emptyState();
  aggregate.startedAt = null;
  const protocols = new Set();
  let correctionsWithoutProtocol = 0;
  const days = new Map();
  const dayUnits = new Map();
  let dailyExcludedInvalidAt = 0;
  const usageAcc = emptyUsageAcc();
  let checkIndex = 0;
  for (const record of history.records) {
    const event = eventDate(record.at);
    if (!recordMatchesFilters(record, event, filters, nowMs)) continue;
    const check = persistedCheck(record);
    accumulateCheck(aggregate, check);
    const checkUnits = check.cached ? 0 : (Number.isFinite(unitCosts?.[record?.kind]) ? unitCosts[record.kind] : 1);
    accumulateUsage(usageAcc, record, check, checkUnits, record?.id ?? `check-${checkIndex}`);
    checkIndex++;
    if (event) {
      if (!aggregate.startedAt || event.timestamp < Date.parse(aggregate.startedAt)) aggregate.startedAt = record.at;
      if (!aggregate.lastCheckAt || event.timestamp > Date.parse(aggregate.lastCheckAt)) aggregate.lastCheckAt = record.at;
      let day = days.get(event.date);
      if (!day) {
        day = emptyState();
        day.startedAt = null;
        day.corrections = { created: null, corrected: null };
        days.set(event.date, day);
      }
      accumulateCheck(day, check);
      if (!day.startedAt || event.timestamp < Date.parse(day.startedAt)) day.startedAt = record.at;
      if (!day.lastCheckAt || event.timestamp > Date.parse(day.lastCheckAt)) day.lastCheckAt = record.at;
      dayUnits.set(event.date, (dayUnits.get(event.date) ?? 0) + checkUnits);
    } else {
      dailyExcludedInvalidAt++;
    }
    for (const correction of Array.isArray(record.editorialCorrections) ? record.editorialCorrections : []) {
      if (correction.status && correction.status !== "corrected") continue;
      if (correction.protocol) protocols.add(correction.protocol);
      else correctionsWithoutProtocol++;
    }
    if (record.correctedAt && !record.editorialCorrections?.length) correctionsWithoutProtocol++;
  }
  aggregate.corrections = history.corrections ?? { created: null, corrected: protocols.size + correctionsWithoutProtocol };
  const result = renderSnapshot(aggregate, extra, env);
  const daily = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => {
    const rendered = renderSnapshot(day, extra, env);
    delete rendered.daily;
    delete rendered.dailyExcludedInvalidAt;
    return {
      ...rendered,
      date,
      source: history.mode,
      window: {
        ...rendered.window, scope: "daily_retained_checks",
        capturedAt: history.capturedAt, limit: history.limit, limited: history.limited,
        correctionsScope: "unavailable_by_day",
      },
      usage: {
        unitsEstimated: dayUnits.get(date) ?? 0,
        tokens: rendered.tokens,
        checks: rendered.checks,
        cached: rendered.cached,
      },
      note: "Checagens retidas deste dia em America/Sao_Paulo; não representa necessariamente o dia completo. Correções por dia indisponíveis.",
    };
  });
  const usage = renderUsage(usageAcc, filtersApplied, unitCosts);
  const filterDetail = [`período ${filtersApplied.period}`];
  if (filtersApplied.provider) filterDetail.push(`provedor ${filtersApplied.provider}`);
  if (filtersApplied.model) filterDetail.push(`modelo ${filtersApplied.model}`);
  if (filtersApplied.kind) filterDetail.push(`tipo ${filtersApplied.kind}`);
  return {
    ...result,
    source: history.mode,
    daily,
    dailyExcludedInvalidAt,
    usage,
    usageOptions,
    window: {
      ...result.window, scope: "latest_retained_checks", endedAt: aggregate.lastCheckAt,
      capturedAt: history.capturedAt, limit: history.limit, limited: history.limited,
      correctionsScope: history.corrections ? "all_retained_reports" : "editorial_corrections_in_window",
      filters: filtersApplied,
    },
    note: `Histórico persistido: até ${history.limit} checagens retidas mais recentes, de qualquer data.${history.limited ? " Há registros anteriores fora desta janela." : ""} Latência usa toda a janela; tokens, mídia e moderação contam apenas trabalho não servido de cache. Campos ausentes nos registros antigos não podem ser recuperados. ${history.corrections ? "Correções: todos os pedidos retidos no Blob (corrigidos = estado atual)." : "Correções: somente alterações editoriais nos logs da janela; pedidos criados indisponíveis (null)."} A retenção do armazenamento pode excluir registros antigos. Dias usam America/Sao_Paulo; correções diárias indisponíveis.${dailyExcludedInvalidAt ? ` ${dailyExcludedInvalidAt} registro(s) com data inválida mantidos no agregado, mas excluídos dos dias e dos limites temporais.` : ""} Uso estimado em unidades de custo vigentes aplicadas aos logs retidos (cache-hit = 0); o orçamento real do dia vem do guard atual, não do histórico.${filtersActive ? ` Filtros aplicados: ${filterDetail.join(", ")}.` : ""}${filtersActive && aggregate.checks === 0 ? " Nenhum registro corresponde aos filtros." : ""}`,
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
