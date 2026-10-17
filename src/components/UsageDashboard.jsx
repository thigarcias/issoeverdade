import AdminSelect from "./AdminSelect.jsx";

export const DEFAULT_METRICS_FILTERS = { period: "7d", provider: "all", model: "all", kind: "all" };

export const PERIOD_LABEL = { "7d": "Últimos 7 dias", "30d": "Últimos 30 dias", all: "Tudo retido" };

const KIND_LABEL = { link: "Link", text: "Texto", image: "Imagem", video: "Vídeo" };

export function isDayPeriod(period) {
  return typeof period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(period);
}

export function buildMetricsQuery(filters = {}) {
  const params = new URLSearchParams();
  const period = typeof filters.period === "string" ? filters.period.trim() : "";
  if (period) params.set("period", period);
  if (filters.provider && filters.provider !== "all") params.set("provider", filters.provider);
  if (filters.model && filters.model !== "all") params.set("model", filters.model);
  if (filters.kind && filters.kind !== "all") params.set("kind", filters.kind);
  return params.toString();
}

export function metricDayLabel(date) {
  return String(date ?? "").split("-").reverse().join("/");
}

function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function numOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeModelEntry(entry) {
  if (typeof entry === "string") return splitModelValue(entry, entry);
  const provider = entry?.provider ?? "";
  const model = entry?.model ?? "";
  const value = provider ? `${provider}:${model}` : model;
  return { provider, model, value, label: entry?.label ?? (value || model) };
}

function splitModelValue(value, label) {
  const text = String(value ?? "");
  const sep = text.indexOf(":");
  if (sep < 0) return { provider: "", model: text, value: text, label: label ?? text };
  const provider = text.slice(0, sep);
  const model = text.slice(sep + 1);
  return { provider, model, value: text, label: label ?? text };
}

function withCurrent(values, current) {
  return values.includes(current) ? values : [...values, current];
}

/** Filtros server-side: valem para uso estimado e qualidade operacional. */
export function UsageFilterBar({ filters, options, disabled, onChange, onReset }) {
  const active = { ...DEFAULT_METRICS_FILTERS, ...filters };
  const periods = Array.isArray(options?.periods) && options.periods.length > 0 ? options.periods : ["7d", "30d", "all"];
  const days = Array.isArray(options?.days) ? options.days : [];
  const providers = Array.isArray(options?.providers) ? options.providers : [];
  const models = (Array.isArray(options?.models) ? options.models : []).map(normalizeModelEntry);
  const kinds = Array.isArray(options?.kinds) && options.kinds.length > 0 ? options.kinds : Object.keys(KIND_LABEL);
  const periodValues = withCurrent([...periods, ...days.filter((day) => !periods.includes(day))], active.period);
  const providerValues = withCurrent(["all", ...providers], active.provider);
  const visibleModels = active.provider === "all" ? models : models.filter((entry) => entry.provider === active.provider || entry.provider === "");
  const modelValues = withCurrent(["all", ...visibleModels.map((entry) => entry.value)], active.model);
  const modelLabels = new Map([["all", "Todos"], ...visibleModels.map((entry) => [entry.value, entry.label])]);
  if (active.model !== "all" && !modelLabels.has(active.model)) modelLabels.set(active.model, splitModelValue(active.model, active.model).label);
  const kindValues = withCurrent(["all", ...kinds], active.kind);
  const dirty = active.period !== "7d" || active.provider !== "all" || active.model !== "all" || active.kind !== "all";
  const set = (patch) => onChange({ ...active, ...patch });
  return (
    <div className="admin-usage-filters" role="group" aria-label="Filtros de uso e qualidade">
      <label>Período
        <AdminSelect value={active.period} disabled={disabled} onValueChange={(period) => set({ period })}>
          {periodValues.map((value) => <option key={value} value={value}>{PERIOD_LABEL[value] ?? (isDayPeriod(value) ? `Dia ${metricDayLabel(value)}` : value)}</option>)}
        </AdminSelect>
      </label>
      <label>Provedor
        <AdminSelect value={active.provider} disabled={disabled || providerValues.length <= 1} onValueChange={(provider) => set({ provider, model: "all" })}>
          {providerValues.map((value) => <option key={value} value={value}>{value === "all" ? "Todos" : value}</option>)}
        </AdminSelect>
      </label>
      <label>Modelo
        <AdminSelect value={active.model} disabled={disabled || modelValues.length <= 1} onValueChange={(model) => set({ model })}>
          {modelValues.map((value) => <option key={value} value={value}>{modelLabels.get(value) ?? value}</option>)}
        </AdminSelect>
      </label>
      <label>Tipo de entrada
        <AdminSelect value={active.kind} disabled={disabled} onValueChange={(kind) => set({ kind })}>
          {kindValues.map((value) => <option key={value} value={value}>{value === "all" ? "Todos" : KIND_LABEL[value] ?? value}</option>)}
        </AdminSelect>
      </label>
      {dirty && <button className="btn ghost" type="button" onClick={onReset} disabled={disabled}>Limpar filtros</button>}
      <p className="admin-mut admin-usage-scope">Os filtros desta área valem para uso estimado e qualidade operacional.</p>
    </div>
  );
}

/** Hero "Uso no período" + card do orçamento real de hoje, com escopos distintos. */
export function UsageHero({ usage, metrics, budget, limits }) {
  const units = usage?.units;
  const tokens = usage?.tokens ?? metrics?.tokens;
  const tokenTotal = numOrNull(tokens?.total) ?? (numOrNull(tokens?.input) ?? 0) + (numOrNull(tokens?.output) ?? 0);
  const hasTokens = tokens != null && (numOrNull(tokens?.input) != null || numOrNull(tokens?.output) != null || numOrNull(tokens?.total) != null);
  const checks = numOrNull(metrics?.checks) ?? 0;
  const cached = numOrNull(metrics?.cached) ?? 0;
  const usedUnits = numOrNull(budget?.usedUnits);
  const unitLimit = numOrNull(budget?.limit) ?? numOrNull(limits?.dailyUnits);
  const tokensObserved = numOrNull(budget?.tokensObserved);
  const tokenLimit = numOrNull(budget?.tokenLimit) ?? numOrNull(limits?.dailyTokens);
  const budgetPct = usedUnits != null && unitLimit ? Math.max(0, Math.min(100, (usedUnits / unitLimit) * 100)) : null;
  const byKindTitle = units?.byKind ? Object.entries(units.byKind).map(([kind, value]) => `${KIND_LABEL[kind] ?? kind}: ${fmtInt(value?.units ?? value)} un · ${fmtInt(value?.checks)} chec`).join(" · ") : "";
  const costsTitle = units?.unitCosts ? Object.entries(units.unitCosts).map(([kind, cost]) => `${KIND_LABEL[kind] ?? kind} ${cost}`).join(" · ") : "";
  return (
    <section className="admin-usage-hero" aria-label="Uso no período">
      <h3 className="admin-sub">Uso no período</h3>
      <dl className="admin-stats">
        <div>
          <dt>Unidades estimadas</dt>
          <dd title={byKindTitle || undefined}>{units?.estimated != null ? fmtInt(units.estimated) : "—"}
            <span className="admin-hero-sub">{units?.estimated != null ? "estimativa dos logs retidos" : "estimativa indisponível nesta resposta"}</span>
          </dd>
        </div>
        <div>
          <dt>Tokens no período</dt>
          <dd>{hasTokens ? fmtInt(tokenTotal) : "—"}
            <span className="admin-hero-sub">{hasTokens ? `entrada ${fmtInt(tokens.input)} · saída ${fmtInt(tokens.output)}` : "tokens não registrados"}</span>
          </dd>
        </div>
        <div>
          <dt>Checagens</dt>
          <dd>{fmtInt(checks)}
            <span className="admin-hero-sub">{fmtInt(cached)} do cache · cache-hit custa 0 unidades novas</span>
          </dd>
        </div>
        <div>
          <dt>Orçamento de hoje (UTC)</dt>
          <dd>{usedUnits != null ? fmtInt(usedUnits) : "—"} / {unitLimit != null ? fmtInt(unitLimit) : "—"}
            {budgetPct != null && <span className="admin-budget-track" aria-hidden="true"><span style={{ width: `${budgetPct}%` }} /></span>}
            <span className="admin-hero-sub">
              {budget ? `guard atual${budget.dateUTC ? ` · ${budget.dateUTC}` : ""} · tokens ${tokensObserved != null ? fmtInt(tokensObserved) : "—"}${tokenLimit != null ? ` / ${fmtInt(tokenLimit)}` : ""}` : "orçamento de hoje indisponível nesta resposta"}
            </span>
          </dd>
        </div>
      </dl>
      <p className="admin-mut">Uso: estimativa dos logs retidos, sem valores em moeda{units?.basis ? ` · base: ${units.basis}` : ""}{costsTitle ? ` · custos vigentes: ${costsTitle}` : ""}.</p>
      <p className="admin-mut">Orçamento: guard atual de hoje (UTC), nunca reconstruído do histórico{budget?.store ? ` · ${budget.store}` : ""}{budget?.note ? ` · ${budget.note}` : ""}.</p>
    </section>
  );
}

const CAPABILITY_META = [
  { id: "judge", label: "Julgamento" },
  { id: "article-research", label: "Pesquisa do artigo" },
  { id: "evidence-review", label: "Revisão de evidências" },
  { id: "evidence-research", label: "Pesquisa de evidências" },
  { id: "evidence-rereview", label: "Re-revisão de evidências" },
  { id: "evidence-recovered", label: "Evidências recuperadas" },
  { id: "transcribe", label: "Transcrição" },
  { id: "vision", label: "Visão" },
  { id: "web_search", label: "Busca web" },
  { id: "evidence", label: "Dossiê de evidências" },
  { id: "moderation", label: "Moderação" },
];

function stepCalls(steps, name) {
  const value = steps?.[name];
  if (typeof value === "number") return numOrNull(value);
  return numOrNull(value?.calls);
}

/** Capacidades com calls/checks — nunca tokens (logs só têm o total por checagem). */
export function resolveCapabilities(usage) {
  if (Array.isArray(usage?.capabilities) && usage.capabilities.length > 0) {
    return usage.capabilities.map((entry) => ({
      id: entry.id ?? entry.key ?? "capability",
      label: entry.label ?? entry.id ?? "Capacidade",
      calls: numOrNull(entry.calls),
      checks: numOrNull(entry.checks),
      detail: entry.detail ?? null,
    }));
  }
  if (!usage) return null;
  const webSearch = usage.webSearch ?? {};
  const evidence = usage.evidence ?? {};
  const moderation = usage.moderation ?? {};
  const media = usage.media ?? {};
  const modParts = [
    numOrNull(moderation.refused) ? `${moderation.refused} recusadas` : "",
    numOrNull(moderation.unavailable) ? `${moderation.unavailable} indisponíveis` : "",
    numOrNull(moderation.sensitive) ? `${moderation.sensitive} sensíveis` : "",
  ].filter(Boolean).join(" · ");
  const list = [
    { id: "judge", label: "Julgamento", calls: stepCalls(usage.steps, "judge"), checks: null, detail: null },
    { id: "web_search", label: "Pesquisa web", calls: numOrNull(webSearch.queries), checks: numOrNull(webSearch.checksWithQueries), detail: webSearch.queries != null ? `${fmtInt(webSearch.queries)} consultas` : null },
    { id: "evidence", label: "Evidência", calls: null, checks: numOrNull(evidence.checksWithDossier) ?? numOrNull(evidence.checksReviewed), detail: evidence.checksWithDossier != null || evidence.checksReviewed != null ? `${fmtInt(evidence.checksWithDossier)} com dossiê · ${fmtInt(evidence.checksReviewed)} revisadas` : null },
    { id: "transcribe", label: "Transcrição", calls: null, checks: numOrNull(media.transcriptions), detail: null },
    { id: "vision", label: "Visão", calls: null, checks: numOrNull(media.visions), detail: numOrNull(media.frames) ? `${fmtInt(media.frames)} quadros` : null },
    { id: "moderation", label: "Moderação", calls: null, checks: numOrNull(moderation.checks), detail: modParts || null },
  ];
  const meaningful = list.filter((entry) => entry.calls != null || entry.checks != null);
  return meaningful.length > 0 ? meaningful : null;
}

export function CapabilityGrid({ usage }) {
  const capabilities = resolveCapabilities(usage);
  return (
    <section className="admin-metric-block" aria-label="Uso por capacidade">
      <h3 className="admin-sub">Uso por capacidade</h3>
      {!capabilities
        ? <p className="admin-mut">Detalhamento por capacidade indisponível nesta resposta.</p>
        : <ul className="admin-cap-grid">
          {capabilities.map((entry) => (
            <li key={entry.id} className="admin-cap-card">
              <b>{CAPABILITY_META.find((meta) => meta.id === entry.id)?.label ?? entry.label}</b>
              <span>Chamadas: {entry.calls != null ? fmtInt(entry.calls) : "—"}</span>
              <span>Checagens: {entry.checks != null ? fmtInt(entry.checks) : "—"}</span>
              {entry.detail && <small className="admin-mut">{entry.detail}</small>}
            </li>
          ))}
        </ul>}
      <p className="admin-mut">Chamadas e checagens por capacidade — nunca tokens: os logs guardam só o total por checagem.</p>
    </section>
  );
}

function UsageDayChart({ title, daily, selectedPeriod, onSelect, valueOf, formatValue, formatAxis }) {
  const values = daily.map(valueOf);
  const maximum = Math.max(0, ...values.filter((value) => Number.isFinite(value) && value >= 0));
  return (
    <section className="admin-chart" aria-label={title}>
      <h3 className="admin-sub">{title}</h3>
      <p className="admin-mut">Escala linear de 0 a {formatAxis(maximum)}. Selecione uma barra para filtrar o painel por dia.</p>
      <div className="admin-chart-scroll" tabIndex={0} role="region" aria-label={`${title}: dias em ordem cronológica; role horizontalmente para ver mais dias`}>
        <div className="admin-day-bars">
          {daily.map((day) => {
            const value = valueOf(day);
            const available = Number.isFinite(value) && value >= 0;
            const label = available ? formatValue(value) : "sem registro";
            return (
              <button type="button" key={day.date} className="admin-day-bar" aria-pressed={selectedPeriod === day.date} onClick={() => onSelect(day.date)} aria-label={`${metricDayLabel(day.date)}: ${label}`}>
                <span className="admin-day-value">{available ? formatValue(value) : "—"}</span>
                <span className="admin-day-track" aria-hidden="true"><span style={{ height: `${available && maximum > 0 ? (value / maximum) * 100 : 0}%` }} /></span>
                <time dateTime={day.date}>{metricDayLabel(day.date)}</time>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Gráficos temporais do uso filtrado; barras clicáveis filtram por dia. */
export function UsageTemporalCharts({ daily, selectedPeriod, onSelect }) {
  if (!Array.isArray(daily) || daily.length === 0) return null;
  const dayChecks = (day) => numOrNull(day.usage?.checks ?? day.checks);
  const dayUnits = (day) => numOrNull(day.usage?.unitsEstimated);
  const dayTokens = (day) => numOrNull(day.usage?.tokens?.total ?? day.tokens?.total);
  const hasUnits = daily.some((day) => dayUnits(day) != null);
  const hasTokens = daily.some((day) => dayTokens(day) != null);
  return (
    <div className="admin-temporal-charts">
      <UsageDayChart title="Volume por dia" daily={daily} selectedPeriod={selectedPeriod} onSelect={onSelect} valueOf={dayChecks} formatValue={(value) => `${fmtInt(value)} checagens`} formatAxis={(max) => `${fmtInt(max)} checagens`} />
      {hasUnits
        ? <UsageDayChart title="Unidades estimadas por dia" daily={daily} selectedPeriod={selectedPeriod} onSelect={onSelect} valueOf={dayUnits} formatValue={(value) => `${fmtInt(value)} un`} formatAxis={(max) => `${fmtInt(max)} un`} />
        : <section className="admin-chart" aria-label="Unidades estimadas por dia"><h3 className="admin-sub">Unidades estimadas por dia</h3><p className="admin-mut">Unidades por dia indisponíveis nesta resposta.</p></section>}
      {hasTokens
        ? <UsageDayChart title="Tokens por dia" daily={daily} selectedPeriod={selectedPeriod} onSelect={onSelect} valueOf={dayTokens} formatValue={(value) => `${fmtInt(value)} tokens`} formatAxis={(max) => `${fmtInt(max)} tokens`} />
        : <section className="admin-chart" aria-label="Tokens por dia"><h3 className="admin-sub">Tokens por dia</h3><p className="admin-mut">Tokens por dia indisponíveis nesta resposta.</p></section>}
    </div>
  );
}
