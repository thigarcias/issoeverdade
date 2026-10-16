import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSESSMENT_BASIS, CLAIM_STATUS, EVIDENCE_SUPPORT, VERDICTS, evidenceReviewLabel, evidenceVerificationLabel, migrateVerdict } from "../data/constants.js";
import ComparisonDetails from "./ComparisonDetails.jsx";
import { Activity, ArrowUpRight, BookOpen, ClipboardCheck, Copy, LayoutDashboard, LogOut, MessageSquare, RefreshCw, Search, Settings2, ShieldCheck } from "lucide-react";
import AdminSelect from "./AdminSelect.jsx";
import "../admin.css";

const SECRET_KEY = "iev-admin-secret";
const PAGE_SIZE = 15;

const KIND_LABEL = { link: "Link", text: "Texto", image: "Imagem", video: "Vídeo" };
const OUTCOME_LABEL = {
  checked: "Checagem executada",
  partial_coverage: "Cobertura parcial",
  insufficient_input: "Material insuficiente",
  inaccessible_media: "Mídia inacessível",
  no_verifiable_claims: "Sem afirmação verificável",
  content_refused: "Recusado por política de conteúdo",
  moderation_uncovered: "Vídeo sem cobertura de moderação",
  error: "Erro operacional",
  legacy: "Registro legado",
};

function fmtMs(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, "0")}s`;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso ?? "—";
  }
}

function fmtFullTime(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso ?? "—";
  }
}

function VerdictChip({ verdict, error, outcome }) {
  if (error || outcome === "error") {
    return (
      <span className="chip tint-down">
        <i /> erro
      </span>
    );
  }
  const v = VERDICTS[verdict];
  const label = v?.label ?? OUTCOME_LABEL[outcome] ?? "Sem veredito";
  return (
    <span className={`chip ${v?.tint ?? "tint-info"}`}>
      <i /> {label}
    </span>
  );
}

function CopyButton({ text, showToast, label = "Copiar" }) {
  return (
    <button
      type="button"
      className="btn ghost admin-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          showToast("Copiado.");
        } catch {
          showToast("Não foi possível copiar.");
        }
      }}
    >
      <Copy size={14} aria-hidden="true" />
      {label}
    </button>
  );
}

function PhaseTimeline({ phases, totalMs }) {
  const rows = phases ?? [];
  if (rows.length === 0) return <p className="admin-mut">Nenhuma fase registrada.</p>;
  const total = totalMs > 0 ? totalMs : rows.filter((p) => !p.parent).reduce((a, p) => a + (p.ms ?? 0), 0);
  return (
    <ol className="admin-timeline">
      {rows.map((p, i) => {
        const pct = total > 0 ? Math.max(3, Math.round(((p.ms ?? 0) / total) * 100)) : 3;
        return (
          <li key={`${p.name}-${i}`} className={p.ok ? "ok" : "fail"}>
            <span className="admin-tl-name">{p.parent ? `${p.parent} / ` : ""}{p.name}</span>
            <span className="admin-tl-track">
              <span className="admin-tl-bar" style={{ width: `${pct}%` }} />
            </span>
            <span className="admin-tl-ms">{fmtMs(p.ms)}</span>
            {p.error && <span className="admin-tl-err">{p.error}</span>}
            {p.evidence && <details className="admin-sec"><summary>Evidência registrada nesta fase</summary><pre className="admin-pre">{typeof p.evidence === "string" ? p.evidence : JSON.stringify(p.evidence, null, 2)}</pre></details>}
          </li>
        );
      })}
    </ol>
  );
}

const DETAIL_TABS = [
  { id: "overview", label: "Resultado" },
  { id: "claims", label: "Afirmações & evidências" },
  { id: "sources", label: "Fontes" },
  { id: "media", label: "Mídia" },
  { id: "execution", label: "Execução" },
  { id: "prompts", label: "Prompts & IA" },
];

/** Explica quando o registro não foi produzido sob a metodologia atual. */
function methodologyNotice(detail, methodology) {
  const current = methodology?.version;
  if (!detail) return "";
  const recorded = detail.methodologyVersion;
  if (!recorded) return "Registro legado sem versão de metodologia declarada; não foi reexecutado.";
  if (current && recorded !== current) {
    return `Produzido sob ${recorded}; a metodologia atual é ${current}. O resultado não foi reexecutado — uma rechecagem exige enviar o material novamente.`;
  }
  return "";
}

function frameTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function FailureSummary({ record }) {
  const code = record.errorCode ?? record.error;
  const phase = record.failedPhase ?? record.phases?.find((entry) => entry.ok === false)?.name;
  if (!code && !phase) return null;
  return <span className="admin-failure-summary"><b>{typeof code === "string" ? code : "Erro registrado"}</b>{phase && <span>Fase: {phase}</span>}<span>Provedor: {record.provider ?? "não registrado"} · Modelo: {record.model ?? "não registrado"}</span></span>;
}

function DetailDialog({ detail, loading, onClose, showToast, methodology }) {
  const ref = useRef(null);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if ((detail || loading) && !dialog.open) dialog.showModal();
    if (!detail && !loading && dialog.open) dialog.close();
  }, [detail, loading]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    function handleClose() {
      onClose();
    }
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  useEffect(() => {
    setTab("overview");
  }, [detail?.id]);

  const tabs = useMemo(() => {
    if (!detail) return DETAIL_TABS;
    return DETAIL_TABS.filter((t) => {
      if (t.id === "claims") return (detail.claims ?? []).length > 0;
      if (t.id === "sources") return (detail.sources ?? []).length > 0;
      if (t.id === "media") {
        return (
          (detail.mediaAttempts ?? []).length > 0 ||
          detail.transcriptSegs > 0 ||
          detail.transcriptPreview ||
          detail.origin?.title ||
          detail.mediaCoverage
        );
      }
      if (t.id === "prompts") {
        return detail.judgePromptPreview || detail.judgeRawPreview || detail.finalPromptPreview || detail.finalRawPreview;
      }
      return true;
    });
  }, [detail]);

  return (
    <dialog ref={ref} className="admin-dialog" aria-labelledby="admin-dialog-title">
      <div className="dialog-bar">
        <span id="admin-dialog-title">{detail ? `Checagem · ${detail.id}` : "Carregando…"}</span>
        <button className="icon-btn" type="button" aria-label="Fechar" onClick={() => ref.current?.close()}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m3 3 10 10M13 3 3 13" />
          </svg>
        </button>
      </div>
      <div className="dialog-body admin-dialog-body">
        {loading && !detail && (
          <ul className="admin-skel" aria-label="Carregando detalhe">
            {[0, 1, 2].map((i) => (
              <li key={i} />
            ))}
          </ul>
        )}
        {detail && (
          <>
            <div className="admin-detail-head">
              <VerdictChip verdict={detail.verdict} error={detail.error} outcome={detail.outcome} />
              <b className="admin-detail-score">{detail.score == null ? "Nota indisponível" : `${detail.score}/100`}</b>
              <span className="admin-mut">
                {OUTCOME_LABEL[detail.outcome] ?? "Registro legado"} · {KIND_LABEL[detail.kind] ?? detail.kind} · {fmtFullTime(detail.at)} · total {fmtMs(detail.totalMs)}
              </span>
              <CopyButton text={detail.id} showToast={showToast} label="Copiar ID" />
            </div>
            <FailureSummary record={detail} />

            <div className="admin-tabs" role="tablist" aria-label="Seções do detalhe">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {t.id === "claims" && detail.claims?.length > 0 && (
                    <span className="count">{detail.claims.length}</span>
                  )}
                  {t.id === "sources" && detail.sources?.length > 0 && (
                    <span className="count">{detail.sources.length}</span>
                  )}
                </button>
              ))}
            </div>

            {tab === "overview" && (
              <div className="admin-tabpane">
                {detail.error && (
                  <p className="admin-error-line">
                    <b>Erro:</b> {detail.error}
                    {detail.finalRawPreview && <> — {detail.finalRawPreview.slice(0, 300)}</>}
                  </p>
                )}
                <dl className="admin-dl">
                  <dt>Entrada</dt>
                  <dd className="admin-input-full">
                    {detail.kind}
                    {detail.fileName ? ` · ${detail.fileName}` : ""} — “{detail.inputPreview}”
                  </dd>
                  <dt>Estado registrado</dt>
                  <dd>{OUTCOME_LABEL[detail.outcome] ?? "Registro legado"}{detail.methodologyVersion ? ` · metodologia ${detail.methodologyVersion}` : ""}</dd>
                  {methodologyNotice(detail, methodology) && (
                    <>
                      <dt>Compatibilidade metodológica</dt>
                      <dd className="admin-mut">{methodologyNotice(detail, methodology)}</dd>
                    </>
                  )}
                  <dt>Resumo</dt>
                  <dd>{detail.summary || "—"}</dd>
                  {detail.coverage && (
                    <>
                      <dt>Cobertura das afirmações</dt>
                      <dd>{detail.coverage.total} no total · {detail.coverage.assessed} avaliadas com evidência adequada · {detail.coverage.unproven} sem comprovação · {detail.coverage.omitted} sem análise</dd>
                    </>
                  )}
                  {detail.corrections?.length > 0 && (
                    <>
                      <dt>Correções</dt>
                      <dd>{detail.corrections.join(" · ")}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}

            {tab === "claims" && (
              <ul className="admin-claim-cards">
                {(detail.claims ?? []).map((c, i) => {
                  const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
                  return (
                    <li key={i}>
                      <span className={`chip ${st.tint}`}>
                        <i /> {st.label} · {c.score == null ? "sem nota" : `${c.score}/100`}
                      </span>
                      <p>{c.text}</p>
                      {c.note && <small>{c.note}</small>}
                      {ASSESSMENT_BASIS[c.assessmentBasis] && <small>Base da avaliação: {ASSESSMENT_BASIS[c.assessmentBasis]}.{c.assessmentNote ? ` ${c.assessmentNote}` : ""}</small>}
                      {c.evidenceSupport && <small>Suporte da evidência: {EVIDENCE_SUPPORT[c.evidenceSupport] ?? c.evidenceSupport}.</small>}
                      {c.evidenceReview && <small>{evidenceReviewLabel(c)}</small>}
                      <ComparisonDetails comparison={c.comparison} assessmentBasis={c.assessmentBasis} />
                      {Array.isArray(c.evidence) && c.evidence.length > 0 && <ul className="admin-claim-evidence">{c.evidence.map((evidence, index) => {
                        const source = detail.sources?.[evidence.sourceId];
                        const relation = { supports: "Apoia", refutes: "Contradiz", context: "Contextualiza" }[evidence.relation] ?? "Evidência";
                        return (
                          <li key={`${evidence.sourceId ?? "source"}-${index}`}>
                            <b>{relation}{source?.outlet ? ` · ${source.outlet}` : ""}</b>
                            {evidence.quote && <q>{evidence.quote}</q>}
                            {evidence.verification && <small>{evidenceVerificationLabel(c, evidence)}</small>}
                            {evidence.referencePeriod && <small>Período da evidência: {evidence.referencePeriod.start} a {evidence.referencePeriod.end}</small>}
                            {source?.url && <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}
                          </li>
                        );
                      })}</ul>}
                      {Array.isArray(c.sourceIds) && (
                        <small className="admin-mut">
                          {c.sourceIds.length === 0
                            ? " — nenhuma fonte vinculada"
                            : ` — fontes: ${c.sourceIds.map((n) => `#${n + 1}`).join(", ")}`}
                        </small>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {tab === "sources" && (
              <ul className="admin-source-cards">
                {(detail.sources ?? []).map((s, i) => (
                  <li key={i}>
                    <b>{s.outlet}</b>
                    {s.detail && <small> · {s.detail}</small>}
                    <br />
                    {s.url && s.url !== "#" ? (
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.url}
                      </a>
                    ) : (
                      <small>(sem link válido)</small>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {tab === "media" && (
              <div className="admin-tabpane">
                <dl className="admin-dl">
                  <dt>Tentativas</dt>
                  <dd className="admin-mono">{(detail.mediaAttempts ?? []).join(" → ") || "—"}</dd>
                  {detail.mediaCoverage && (
                    <>
                      <dt>Cobertura analisada</dt>
                      <dd>
                        Áudio: {detail.mediaCoverage.transcript === "timestamped" ? "transcrito com segmentos" : detail.mediaCoverage.transcript === "text-only" ? "transcrito sem timestamps" : "indisponível"}
                        {" · "}
                        Quadros: {detail.mediaCoverage.sampledFrameCount ?? 0}
                        {detail.mediaCoverage.frames === "sampled-and-described" ? " amostrados e descritos" : detail.mediaCoverage.frames === "sampled-description-failed" ? " amostrados, descrição falhou" : ""}
                      </dd>
                      {detail.mediaCoverage.sampledFrameTimestamps?.length > 0 && (
                        <>
                          <dt>Instantes amostrados</dt>
                          <dd className="admin-mono">{detail.mediaCoverage.sampledFrameTimestamps.map((seconds) => frameTimestamp(seconds) ?? `${seconds}s`).join(" · ")}</dd>
                        </>
                      )}
                      {detail.mediaCoverage.durationSec > 0 && (
                        <>
                          <dt>Duração reportada</dt>
                          <dd className="admin-mono">{detail.mediaCoverage.durationSec}s</dd>
                        </>
                      )}
                    </>
                  )}
                  {detail.origin?.title && (
                    <>
                      <dt>Origem</dt>
                      <dd>
                        {detail.origin.title}
                        {detail.origin.author && <> ({detail.origin.author})</>}
                      </dd>
                    </>
                  )}
                  <dt>Transcrição</dt>
                  <dd>
                    {detail.transcriptSegs > 0 ? `${detail.transcriptSegs} segmentos` : "—"}
                    {detail.transcriptPreview && (
                      <details className="admin-sec" style={{ marginTop: 8 }}>
                        <summary>Ver texto usado</summary>
                        <pre className="admin-pre">{detail.transcriptPreview}</pre>
                      </details>
                    )}
                  </dd>
                </dl>
              </div>
            )}

            {tab === "execution" && (
              <div className="admin-tabpane">
                <dl className="admin-dl">
                  <dt>Resultado operacional</dt><dd>{OUTCOME_LABEL[detail.outcome] ?? detail.operationalStatus ?? (detail.error ? "Erro registrado" : "Não registrado")}</dd>
                  <dt>Modelo principal usado</dt><dd>{detail.model ?? "Nenhum modelo concluiu a execução"}{detail.provider ? ` · ${detail.provider}` : ""}</dd>
                  {detail.aiConfig && <><dt>Modelos solicitados</dt><dd>{Object.entries(detail.aiConfig).map(([step, value]) => `${LOG_STEP_LABEL[step] ?? step}: ${typeof value === "object" ? `${value.provider ?? ""}/${value.model ?? ""}` : value}`).join(" · ")}</dd></>}
                  {detail.modelsUsed && Object.keys(detail.modelsUsed).length > 0 && <><dt>Modelos efetivamente usados</dt><dd>{Object.entries(detail.modelsUsed).map(([step, value]) => `${LOG_STEP_LABEL[step] ?? step}: ${value.provider}/${value.model}${value.fallbackFor ? ` (fallback de ${value.fallbackFor})` : ""}`).join(" · ")}</dd></>}
                  <dt>Cache</dt><dd>{detail.cached ? "Resultado servido do cache" : detail.cachedFrom ? `Resultado reutilizado de ${detail.cachedFrom}` : "Não registrado como cache"}</dd>
                  <dt>Consultas de busca registradas</dt>
                  <dd className="admin-mono">{detail.researchQueries?.length > 0 ? detail.researchQueries.join(" · ") : "Nenhuma consulta preservada nesta execução"}</dd>
                  <dt>Proveniência da pesquisa por etapa</dt>
                  <dd>{detail.researchDiagnostics?.length > 0 ? detail.researchDiagnostics.map((item) => (
                    <p key={item.step}>
                      {LOG_STEP_LABEL[item.step] ?? item.step}: {({ available: "URLs estruturadas disponíveis", missing_provenance: "Busca executada sem URLs rastreáveis retornadas", no_search_calls: "Nenhuma chamada de busca registrada", not_requested: "Dossiê sem nova busca" })[item.status] ?? item.status}
                      {" "}· {item.acceptedUrlCount ?? 0} URLs · {item.annotationCount ?? 0} citações · {item.retrievedCount ?? 0} resultados de busca
                    </p>
                  )) : "Diagnóstico não preservado nesta execução"}</dd>
                  {detail.researchDiagnostics?.length > 0 && <>
                    <dt>Chamadas da ferramenta</dt>
                    <dd><details><summary>Status e páginas tentadas</summary><pre className="admin-pre">{JSON.stringify(detail.researchDiagnostics.map(({ step, calls }) => ({ step, calls })), null, 2)}</pre></details></dd>
                  </>}
                  <dt>Moderação e propósito</dt>
                  <dd>
                    {detail.moderationCoverage
                      ? `${detail.moderationCoverage.mode} · vídeo: ${detail.moderationCoverage.videoCoverage} · texto: ${detail.moderationCoverage.text ? "verificado" : "não"} · imagens: ${detail.moderationCoverage.images ? "verificado" : "não"}`
                      : "Não registrada nesta execução"}
                    {detail.purposeTriage ? ` · triagem de propósito: ${detail.purposeTriage}` : ""}
                    {(detail.moderation ?? []).length > 0 && <span className="admin-mono"> · {detail.moderation.join(" · ")}</span>}
                  </dd>
                  {detail.tokenUsage && <><dt>Tokens observados</dt><dd className="admin-mono">{detail.tokenUsage.input ?? 0} entrada · {detail.tokenUsage.output ?? 0} saída · {detail.tokenUsage.total ?? 0} total</dd></>}
                  {detail.evidence && <>
                    <dt>Dossiê de evidências</dt>
                    <dd>
                      {detail.evidence.summary
                        ? `${detail.evidence.summary.fetched}/${detail.evidence.summary.documents} documento(s) obtido(s) · ${detail.evidence.summary.located}/${detail.evidence.summary.citations} trecho(s) localizado(s) · ${detail.evidence.summary.missing} não localizado(s)${detail.evidence.summary.blocked ? ` · ${detail.evidence.summary.blocked} recusado(s) pela política de rede` : ""}`
                        : "Sem fontes vinculadas para buscar"}
                      {detail.evidence.verification ? ` · revisão: ${detail.evidence.verification.reviewed} citação(ões) avaliada(s), ${detail.evidence.verification.downgraded} rebaixada(s)` : ""}
                    </dd>
                    {(detail.evidence.documents ?? []).length > 0 && <>
                      <dt>Documentos tentados</dt>
                      <dd>
                        <ul className="admin-sublist">
                          {detail.evidence.documents.map((doc) => (
                            <li key={doc.url}>
                              {doc.outlet ?? doc.url}: {doc.ok ? `${doc.kind ?? "texto"} · ${Math.round((doc.bytes ?? 0) / 1024)} KB${doc.truncated ? " (truncado)" : ""}` : `não obtido — ${doc.reason ?? "falha"}`}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </>}
                    {(detail.evidence.citations ?? []).length > 0 && <>
                      <dt>Citações conferidas</dt>
                      <dd>
                        <details>
                          <summary>Localização de cada trecho</summary>
                          <pre className="admin-pre">{JSON.stringify(detail.evidence.citations.map((citation) => ({ claim: citation.claimIndex + 1, source: citation.sourceId, relation: citation.relation, locator: citation.locator?.kind, found: citation.locator?.found ?? false, similarity: citation.locator?.similarity ?? null })), null, 2)}</pre>
                        </details>
                      </dd>
                    </>}
                  </>}
                </dl>
                <h4 className="admin-sub">Fases registradas</h4>
                <p className="admin-mut">Subetapas de mídia podem ocorrer em paralelo e estão incluídas na fase principal; suas durações não devem ser somadas ao total.</p>
                <PhaseTimeline phases={detail.phases} totalMs={detail.totalMs} />
              </div>
            )}
            {tab === "prompts" && (
              <div className="admin-prompts">
                <dl className="admin-dl">
                  <dt>Versão metodológica</dt>
                  <dd>{detail.methodologyVersion ?? "não registrada"}</dd>
                  <dt>Hash do prompt · avaliação factual</dt>
                  <dd className="admin-mono">{detail.promptHashes?.judge ?? "não registrado"}</dd>
                  {detail.promptHashes?.final && <><dt>Hash do prompt · revisão final histórica</dt><dd className="admin-mono">{detail.promptHashes.final}</dd></>}
                </dl>
                <p className="admin-mut">Prévias truncadas no registro: entrada analisada até 2.000 caracteres; resposta bruta da avaliação até 4.000. Registros históricos podem conter uma segunda revisão com resposta até 6.000 caracteres. O texto integral do prompt de sistema não é armazenado, apenas o hash.</p>
                {detail.judgePromptPreview && (
                  <details className="admin-sec">
                    <summary>Prompt da avaliação factual · prévia truncada</summary>
                    <pre className="admin-pre">{detail.judgePromptPreview}</pre>
                  </details>
                )}
                {detail.judgeRawPreview && (
                  <details className="admin-sec">
                    <summary>Resposta bruta da avaliação factual · prévia truncada</summary>
                    <pre className="admin-pre">{detail.judgeRawPreview}</pre>
                  </details>
                )}
                {detail.finalPromptPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Prompt da revisão final histórica · prévia truncada</summary>
                    <pre className="admin-pre">{detail.finalPromptPreview}</pre>
                  </details>
                )}
                {detail.finalRawPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Resposta bruta da revisão final histórica · prévia truncada</summary>
                    <pre className="admin-pre">{detail.finalRawPreview}</pre>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "error", label: "Com erro" },
  { id: "no-verdict", label: "Sem veredito" },
  ...Object.keys(VERDICTS).map((v) => ({ id: v, label: VERDICTS[v].label })),
];

const SORTS = [
  { id: "newest", label: "Mais recentes" },
  { id: "oldest", label: "Mais antigas" },
  { id: "slowest", label: "Mais lentas" },
  { id: "lowest", label: "Menor score" },
];

const STEP_LABEL = {
  judge: "Avaliação factual",
  vision: "Visão / OCR de vídeo",
  transcribe: "Transcrição de áudio",
};
const LOG_STEP_LABEL = { ...STEP_LABEL, final: "Revisão final histórica" };

function AiConfigCard({ catalog, draft, saved, saving, persisted, onChange, onSave, onReload, onRefreshCatalog, error, loading, configErrors, configUnavailable, configStale, staleReason }) {
  const [inventoryQuery, setInventoryQuery] = useState("");
  if (!catalog) return <section className="card admin-ai-state" aria-live="polite"><h2>Modelos & provedores</h2><p>{loading ? "Carregando catálogo e configuração…" : error || "Catálogo de modelos indisponível."}</p>{configErrors && <ul>{Object.entries(configErrors).map(([step, reason]) => <li key={step}>{STEP_LABEL[step] ?? step}: {reason}</li>)}</ul>}{!loading && <button className="btn" type="button" onClick={onReload}>Tentar novamente</button>}</section>;
  const selection = draft ?? {};
  const dirty = JSON.stringify(selection) !== JSON.stringify(saved);
  const providers = catalog.providers ?? {};
  const steps = catalog.steps ?? Object.keys(STEP_LABEL);
  const editingBlocked = configUnavailable === "ai_config_unavailable" || loading;
  const complete = steps.length > 0 && steps.every((step) => {
    const pair = selection[step];
    const provider = providers[pair?.provider];
    return provider?.hasKey && (provider.models ?? []).some((model) => model.id === pair?.model && (model.eligibleSteps ?? []).includes(step));
  });
  const query = inventoryQuery.trim().toLowerCase();
  function setStep(step, patch) { onChange({ ...selection, [step]: { ...selection[step], ...patch } }); }
  return (
    <section className="card admin-ai" aria-label="Configuração de modelos">
      <p className="admin-mut">Escolha modelos elegíveis para cada etapa. Alterações afetam somente novas checagens; a configuração chega às instâncias via atualização periódica. Não há troca automática de provedor quando um modelo falha.</p>
      {error && <p className="admin-error-state" role="alert">{error}</p>}
      {configUnavailable && <div className="admin-notice" role="alert"><b>{configUnavailable === "ai_config_invalid" ? "Configuração persistida inválida ou incompatível:" : "Configuração de IA indisponível:"}</b>{configErrors && Object.keys(configErrors).length > 0 && <ul>{Object.entries(configErrors).map(([step, reason]) => <li key={step}>{STEP_LABEL[step] ?? step}: {reason}</li>)}</ul>}<p>As checagens ficam bloqueadas. Nenhum par diferente é usado automaticamente.</p><p>{configUnavailable === "ai_config_invalid" ? "Selecione explicitamente um provedor e um modelo elegível para cada etapa e salve a configuração corrigida. Nenhum padrão foi preenchido." : "A configuração persistida não pôde ser determinada. Edição e salvamento ficam bloqueados para evitar sobrescrevê-la sem conhecê-la; tente carregar novamente quando a persistência voltar."}</p><button className="btn" type="button" onClick={onReload} disabled={loading || saving}>Recarregar configuração</button></div>}
      {configStale && !configUnavailable && <div className="admin-notice" role="status"><b>Snapshot em uso:</b> {staleReason === "catalog_stale" ? "o catálogo está desatualizado; a última configuração conhecida e válida continua em uso sem troca de pares." : staleReason === "config_read_failed" ? "a persistência não respondeu; a última configuração conhecida e válida continua em uso, com possível desatualização." : "a última configuração conhecida e válida continua em uso, com possível desatualização."}</div>}
      <div className="admin-ai-grid">
        {steps.map((step) => {
          const pair = selection[step] ?? {};
          const prov = providers[pair.provider] ?? {};
          const models = prov.models ?? [];
          const current = models.find((m) => m.id === pair.model);
          const eligible = Boolean(prov.hasKey && current && (current.eligibleSteps ?? []).includes(step));
          const availableProviders = Object.entries(providers).filter(([, p]) => p.hasKey && (p.models ?? []).some((m) => (m.eligibleSteps ?? []).includes(step)));
          const currentReason = current?.stepReasons?.[step] ?? null;
          const visibleReason = !pair.provider || !pair.model
            ? "Selecione explicitamente um provedor e um modelo elegível."
            : !prov.hasKey
              ? "Provedor sem chave configurada — disponibilidade não confirmada."
            : (prov.discovery?.stale && !current)
              ? "Inventário desatualizado e modelo ausente da última descoberta — atualize o catálogo."
              : !current
                ? "Modelo não está no inventário descoberto."
                : (currentReason?.eligible === false ? (currentReason.message ?? current.ineligibleReason ?? "Modelo incompatível com esta etapa.") : null);
          const sorted = [...models].sort((a, b) => Number((b.eligibleSteps ?? []).includes(step)) - Number((a.eligibleSteps ?? []).includes(step)));
          return (
            <div key={step} className="admin-ai-row">
              <span className="admin-ai-step">{STEP_LABEL[step] ?? step}</span>
              <label>Provedor<AdminSelect value={pair.provider ?? ""} disabled={saving || editingBlocked} onValueChange={(value) => setStep(step, { provider: value, model: "" })}>
                <option value="" disabled>Selecione um provedor</option>
                {availableProviders.map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
              </AdminSelect></label>
              <label>Modelo<AdminSelect value={eligible ? pair.model : ""} disabled={saving || editingBlocked || !prov.hasKey || !models.length} onValueChange={(value) => setStep(step, { model: value })}>
                <option value="" disabled>Selecione um modelo elegível</option>
                {sorted.map((model) => {
                  const canUse = (model.eligibleSteps ?? []).includes(step);
                  const reason = model.stepReasons?.[step];
                  const suffix = canUse ? "" : ` — ${reason?.message ?? model.ineligibleReason ?? "incompatível com esta etapa"}`;
                  return <option key={model.id} value={model.id} disabled={!canUse}>{model.label ?? model.id}{suffix}</option>;
                })}
              </AdminSelect></label>
              {!eligible && visibleReason && <p className="admin-ai-warning" role="status">{visibleReason}</p>}
            </div>
          );
        })}
      </div>
      <p className="admin-mut">Configuração: origem {catalog.source ?? "não informada"} · revisão {catalog.revision ?? "não informada"} · persistência {persisted ? "durável (Blob)" : "efêmera nesta instância"}{catalog.updatedAt ? ` · atualizada ${fmtFullTime(catalog.updatedAt)}` : ""} · catálogo em cache por até 15 min.</p>
      <div className="admin-ai-actions">
        <button className="btn primary" type="button" onClick={onSave} disabled={saving || editingBlocked || !dirty || !complete}>{saving ? "Salvando…" : "Salvar modelos"}</button>
        <button className="btn ghost" type="button" onClick={onRefreshCatalog} disabled={loading || saving}>{loading ? "Atualizando catálogo…" : "Atualizar catálogo"}</button>
        {dirty && <button className="btn ghost" type="button" onClick={onReload} disabled={saving}>Descartar alterações</button>}
      </div>
      <div className="admin-provider-inventory">
        <h2>Inventário descoberto</h2>
        <p className="admin-mut">O inventário mostra todas as opções retornadas pelos provedores. Opções sem adapter/capacidade validada aparecem, mas ficam indisponíveis para seleção.</p>
        <label className="admin-inventory-search">Filtrar inventário de modelos<input type="search" aria-label="Filtrar inventário de modelos" placeholder="Nome, ID, protocolo ou capacidade…" value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} /></label>
        {Object.entries(providers).map(([id, provider]) => {
          const models = (provider.models ?? []).filter((model) => !query || `${model.id} ${model.label ?? ""} ${model.protocol ?? ""} ${(model.capabilities ?? []).join(" ")} ${(model.eligibleSteps ?? []).join(" ")}`.toLowerCase().includes(query));
          const discovery = provider.discovery ?? {};
          const steps = catalog.steps ?? [];
          return <section key={id}>
            <h3>{provider.label ?? id}</h3>
            <p>{provider.hasKey ? "Credencial disponível" : "Sem credencial configurada"} · {discovery.stale ? "inventário desatualizado" : discovery.updatedAt ? "descoberta atualizada" : "sem descoberta confirmada"}{discovery.updatedAt ? ` · ${fmtFullTime(discovery.updatedAt)}` : ""}{discovery.error ? ` · falha na descoberta: ${discovery.error}` : ""}</p>
            {!models.length ? <p>Nenhum modelo corresponde ao filtro.</p> : <div className="admin-table-wrap"><table className="admin-metric-table admin-model-table" aria-label={`Matriz de elegibilidade · ${provider.label ?? id}`}>
              <thead><tr><th scope="col">Modelo</th><th scope="col">Protocolo</th>{steps.map((step) => <th scope="col" key={step}>{STEP_LABEL[step] ?? step}</th>)}<th scope="col">Motivo</th></tr></thead>
              <tbody>{models.map((model) => {
                const reasons = model.stepReasons ?? {};
                const fallback = model.ineligibleReason ?? null;
                const firstBlocked = steps.map((step) => reasons[step]).find((entry) => entry && entry.eligible === false) ?? null;
                return <tr key={model.id}>
                  <td><span className="admin-model-label" aria-hidden="true">Modelo</span><b>{model.label ?? model.id}</b> <code>{model.id}</code><br /><small className="admin-mut">{(model.capabilities ?? []).join(", ") || "capacidades não informadas"}</small></td>
                  <td><span className="admin-model-label" aria-hidden="true">Protocolo</span>{model.protocol ?? "Protocolo não informado"}</td>
                  {steps.map((step) => {
                    const entry = reasons[step];
                    const ok = entry ? entry.eligible : (model.eligibleSteps ?? []).includes(step);
                    return <td key={step}><span className="admin-model-label" aria-hidden="true">{STEP_LABEL[step] ?? step}</span>{ok ? "✓" : "—"}</td>;
                  })}
                  <td><span className="admin-model-label" aria-hidden="true">Motivo</span><small>{firstBlocked?.message ?? fallback ?? (!provider.hasKey ? "Provedor sem chave configurada — disponibilidade não confirmada." : "")}</small></td>
                </tr>;
              })}</tbody>
            </table></div>}
          </section>;
        })}
      </div>
      {providers.opencode && <p className="admin-notice">OpenCode Go é um produto voltado principalmente a agentes de programação; verifique os requisitos do provedor antes de habilitar dados de usuários nesse serviço.</p>}
    </section>
  );
}

function fmtPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${index === 0 || scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

function countEntries(map) {
  return Object.entries(map ?? {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1]);
}

function sumCounts(map) {
  return Object.values(map ?? {}).reduce((total, count) => total + (Number(count) || 0), 0);
}

const CORRECTION_MODE_LABEL = {
  durable: "durável (Blob)",
  memory: "memória desta instância",
  blocked: "bloqueado nesta implantação",
};

const REPORT_SOURCE_LABEL = { result: "Resultado", detail: "Detalhe da checagem", app: "Formulário de checagem", card: "Card compartilhado" };

const CORRECTION_STATUS_TINT = {
  received: "tint-info",
  in_review: "tint-warn",
  awaiting_info: "tint-warn",
  corrected: "tint-up",
  maintained: "tint-info",
  closed: "",
};

function CorrectionStatusChip({ status, statuses }) {
  const label = statuses?.find((entry) => entry.id === status)?.label ?? status ?? "estado não registrado";
  return (
    <span className={`chip ${CORRECTION_STATUS_TINT[status] ?? "tint-info"}`}>
      <i /> {label}
    </span>
  );
}

/** Fila de correções: lista, pedido completo, mudança de estado e invalidação de cache. */
function AdminCorrections({ data, loading, error, statuses, detail, detailLoading, selected, onReload, onOpen, onClose, onOpenCheck, onSave, onInvalidateCache, showToast }) {
  const [draft, setDraft] = useState({ status: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [cacheReason, setCacheReason] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheResult, setCacheResult] = useState(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const protocol = detail?.protocol ?? "";
  const lastProtocol = useRef("");

  useEffect(() => {
    if (lastProtocol.current === protocol) return;
    lastProtocol.current = protocol;
    setSaveResult(null);
    setDraft({ status: detail?.status ?? "received", note: "" });
  }, [protocol, detail]);

  async function save() {
    if (!detail || saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const result = await onSave(detail.protocol, { status: draft.status, note: draft.note.trim() });
      const lines = [];
      if (result.cacheInvalidated) {
        lines.push("A versão vigente da checagem vinculada foi marcada e o cache foi invalidado — novas consultas passam a ver o registro atualizado.");
      }
      if (result.applied?.ok === false) {
        lines.push(`A checagem vinculada não aceitou a marcação (${result.applied.error ?? "motivo não informado"}). A nota permanece apenas na fila de correções.`);
      } else if (result.applied?.ok === true) {
        lines.push("Marcação editorial gravada no registro da checagem vinculada.");
      }
      setSaveResult({ ok: true, lines: lines.length > 0 ? lines : ["Estado atualizado na fila de correções."] });
      setDraft({ status: result.correction?.status ?? draft.status, note: "" });
    } catch (err) {
      setSaveResult({ ok: false, lines: [err.message || "Não foi possível salvar o estado do pedido."] });
    } finally {
      setSaving(false);
    }
  }

  async function invalidate() {
    if (cacheBusy) return;
    setCacheBusy(true);
    setCacheResult(null);
    try {
      setCacheResult(await onInvalidateCache(cacheReason.trim()));
    } catch (err) {
      setCacheResult(err.data ?? { ok: false, error: err.message });
    } finally {
      setCacheBusy(false);
    }
  }

  const blocked = data?.mode === "blocked";
  const memoryOnly = Boolean(data) && data.enabled === false && !blocked;
  const items = data?.items ?? [];
  const kinds = data?.kinds ?? [];
  const kindLabel = (kind) => kinds.find((entry) => entry.id === kind)?.label ?? ({ correction: "Correção de informação", right_of_reply: "Direito de resposta", removal: "Remoção de conteúdo" })[kind] ?? kind ?? "tipo não registrado";
  const pending = items.filter((item) => ["received", "in_review", "awaiting_info"].includes(item.status)).length;
  const visibleItems = items.filter((item) => (kindFilter === "all" || item.kind === kindFilter)
    && (statusFilter === "all" || item.status === statusFilter));

  return (
    <section className="admin-corrections" aria-labelledby="admin-corrections-title">
      <div className="admin-section-heading">
        <p className="admin-eyebrow">Canal público</p>
        <h1 id="admin-corrections-title">Reportes e correções</h1>
        <p>Todos os problemas enviados pelo público entram aqui, inclusive sem ID ou evidência. Resolver um problema operacional não altera a conclusão factual. Marcar uma contestação editorial como <b>Corrigido</b> só marca o registro vigente quando existe uma checagem vinculada.</p>
      </div>
      {blocked && <p className="admin-error-state" role="alert">A fila de correções está bloqueada nesta implantação (modo <code>blocked</code>): sem armazenamento durável o canal público recusa novos pedidos e o painel não consegue registrar estados.</p>}
      {memoryOnly && <p className="admin-notice" role="status">A fila existe apenas em memória nesta instância (modo <code>{data.mode}</code>): pedidos e mudanças de estado não sobrevivem ao reinício do processo nem são compartilhados entre instâncias.</p>}
      {error && <div className="admin-error-state" role="alert"><p>{error}</p><button className="btn" type="button" onClick={onReload}>Tentar novamente</button></div>}
      <div className="admin-corr-actions">
        <button className="btn ghost" type="button" onClick={onReload} disabled={loading}>{loading ? "Atualizando…" : "Atualizar fila"}</button>
        {data && <span className="admin-mut">{items.length} de até {data.max ?? "—"} pedidos retidos · modo {CORRECTION_MODE_LABEL[data.mode] ?? data.mode}</span>}
        <span className="admin-corr-spacer" />
        <button className="btn ghost" type="button" aria-expanded={cacheOpen} onClick={() => { setCacheOpen((open) => !open); setCacheResult(null); }}>Invalidar cache</button>
      </div>
      {data && <p className="admin-notice" role="status">{pending} {pending === 1 ? "pedido pendente" : "pedidos pendentes"} na fila retida · {visibleItems.length} exibidos de {items.length}.</p>}
      <div className="admin-check-toolbar">
        <label className="admin-sort">Tipo de problema<AdminSelect value={kindFilter} onValueChange={setKindFilter}><option value="all">Todos</option>{kinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</AdminSelect></label>
        <label className="admin-sort">Estado<AdminSelect value={statusFilter} onValueChange={setStatusFilter}><option value="all">Todos</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}</AdminSelect></label>
        {(kindFilter !== "all" || statusFilter !== "all") && <button className="btn ghost" type="button" onClick={() => { setKindFilter("all"); setStatusFilter("all"); }}>Limpar filtros</button>}
      </div>
      {cacheOpen && <section className="admin-cache-panel" aria-label="Invalidar cache de checagens">
        <p className="admin-mut">Publica uma nova época de cache: resultados gravados antes dela deixam de ser servidos. Use depois de corrigir um registro já publicado.</p>
        <label className="admin-cache-reason">Motivo<textarea rows={2} value={cacheReason} onChange={(event) => setCacheReason(event.target.value)} placeholder="Ex.: correção iev-xxxx publicada" /></label>
        <div className="admin-ai-actions">
          <button className="btn primary" type="button" onClick={invalidate} disabled={cacheBusy}>{cacheBusy ? "Invalidando…" : "Confirmar invalidação"}</button>
          <button className="btn ghost" type="button" onClick={() => { setCacheOpen(false); setCacheReason(""); setCacheResult(null); }} disabled={cacheBusy}>Cancelar</button>
        </div>
        {cacheResult && <p className={cacheResult.ok ? "admin-notice" : "admin-error-state"} role="status">{cacheResult.ok
          ? <>Cache invalidado. Época vigente: <code>{cacheResult.epoch}</code>{cacheResult.persisted ? " (publicada de forma durável)" : " (apenas nesta instância — outras réplicas podem seguir servindo a época anterior até recarregarem)"}.</>
          : <>A invalidação falhou{cacheResult.epoch ? ` (época retornada: ${cacheResult.epoch})` : ""}: o cache em memória desta instância foi limpo, mas nenhuma época nova foi publicada — outras instâncias continuam servindo os resultados anteriores.</>}</p>}
      </section>}
      {loading && !data
        ? <ul className="admin-skel" aria-label="Carregando pedidos de correção"><li /><li /><li /></ul>
        : <div className="admin-corr-grid">
          <div className="admin-corr-queue">
            {visibleItems.length === 0
              ? <div className="empty"><h3>{items.length ? "Nenhum relato neste filtro" : "Nenhum pedido retido"}</h3><p>{items.length ? "Ajuste o tipo ou o estado para ver outros relatos." : data?.enabled ? "A fila não tem relatos no momento." : "A fila não é durável nesta implantação; nenhum pedido é retido."}</p></div>
              : <ul className="admin-queue">
                {visibleItems.map((item) => <li key={item.protocol} className={selected === item.protocol ? "is-open" : ""}>
                  <button type="button" className="admin-queue-row" onClick={() => onOpen(item.protocol)}>
                    <span className="admin-queue-head">
                      <code>{item.protocol}</code>
                      <CorrectionStatusChip status={item.status} statuses={statuses} />
                      <time title={fmtFullTime(item.at)}>{fmtTime(item.at)}</time>
                    </span>
                    <span className="admin-queue-msg">{item.messagePreview || "(sem prévia da mensagem)"}</span>
                    <span className="admin-queue-meta">{item.checkId ? `Checagem ${item.checkId}` : "Sem checagem vinculada"} · {kindLabel(item.kind)} · atualizado em {fmtTime(item.updatedAt)}</span>
                  </button>
                  {item.checkId && <button className="quiet-link" type="button" onClick={() => onOpenCheck(item.checkId)}>Abrir detalhe da checagem</button>}
                </li>)}
              </ul>}
          </div>
          <div className="admin-corr-detail">
            {!detail && !detailLoading && <p className="admin-mut">Selecione um pedido para ver a mensagem completa, o vínculo com a checagem, o histórico e mudar o estado.</p>}
            {detailLoading && !detail && <ul className="admin-skel" aria-label="Carregando pedido"><li /><li /></ul>}
            {detail && <>
              <div className="admin-corr-detail-head">
                <h3>Pedido <code>{detail.protocol}</code></h3>
                <div className="admin-actions">
                  <CopyButton text={detail.protocol} showToast={showToast} label="Copiar protocolo" />
                  <button className="btn ghost" type="button" onClick={onClose}>Fechar</button>
                </div>
              </div>
              <dl className="admin-dl">
                <dt>Estado</dt>
                <dd><CorrectionStatusChip status={detail.status} statuses={statuses} />{" "}<small className="admin-mut">atualizado em {fmtFullTime(detail.updatedAt)}</small></dd>
                <dt>Recebido</dt>
                <dd>{fmtFullTime(detail.at)}</dd>
                <dt>Checagem vinculada</dt>
                <dd>{detail.checkId
                  ? <button className="quiet-link" type="button" onClick={() => onOpenCheck(detail.checkId)}>Abrir detalhe de {detail.checkId}</button>
                  : "Nenhuma checagem vinculada — corrigir este pedido não altera registro publicado."}{detail.operational && <small className="admin-mut"> · Relato operacional: o ID serve apenas para investigação, não para retificação editorial.</small>}</dd>
                <dt>Tipo de problema</dt>
                <dd>{kindLabel(detail.kind)}</dd>
                <dt>Persistência</dt>
                <dd>{detail.persisted ? "Durável (Blob)" : "Apenas em memória nesta instância"}</dd>
                <dt>Mensagem</dt>
                <dd className="admin-quote">{detail.message || "—"}</dd>
                <dt>Contexto para reproduzir</dt>
                <dd className="admin-quote">{detail.context || "não informado"}{" "}<small className="admin-mut">(uso interno)</small></dd>
                <dt>Origem do reporte</dt>
                <dd>{REPORT_SOURCE_LABEL[detail.source] ?? "não informada"}</dd>
                {detail.claim && <><dt>Afirmação contestada</dt><dd>{detail.claim}</dd></>}
                <dt>Link relacionado ou evidência</dt>
                <dd>{detail.evidenceUrl ? <a href={detail.evidenceUrl} target="_blank" rel="noreferrer">{detail.evidenceUrl}</a> : "não informado — opcional, inclusive para problemas operacionais"}</dd>
                <dt>Contato</dt>
                <dd>{detail.contact || "não informado"}{" "}<small className="admin-mut">(uso interno; não aparece no site)</small></dd>
              </dl>
              <h4 className="admin-sub">Histórico</h4>
              {(detail.history ?? []).length === 0
                ? <p className="admin-mut">Sem eventos registrados.</p>
                : <ol className="admin-hist">{detail.history.map((entry, index) => <li key={`${entry.at}-${index}`}>
                  <time>{fmtFullTime(entry.at)}</time>
                  <span><CorrectionStatusChip status={entry.status} statuses={statuses} /> <small className="admin-mut">por {entry.actor || "não registrado"}</small></span>
                  {entry.note && <q>{entry.note}</q>}
                </li>)}</ol>}
              <div className="admin-corr-form">
                <label>Novo estado<AdminSelect value={draft.status} disabled={saving} onValueChange={(value) => setDraft((current) => ({ ...current, status: value }))}>
                  {statuses.length === 0 && <option value={draft.status}>{draft.status}</option>}
                  {statuses.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </AdminSelect></label>
                <label>Nota interna<textarea rows={3} value={draft.note} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} placeholder="Descreva o que foi apurado, sem expor dados pessoais além do necessário." /></label>
                <div className="admin-ai-actions">
                  <button className="btn primary" type="button" onClick={save} disabled={saving || (draft.status === detail.status && !draft.note.trim())}>{saving ? "Salvando…" : "Salvar estado"}</button>
                </div>
              </div>
              {saveResult && <div className={saveResult.ok ? "admin-notice" : "admin-error-state"} role="status">
                {saveResult.lines.map((line) => <p key={line}>{line}</p>)}
              </div>}
            </>}
          </div>
        </div>}
    </section>
  );
}

const LIMITS_MODE_INFO = {
  shared: { label: "Compartilhado", text: "taxa, concorrência e orçamento em armazenamento compartilhado — o teto vale para o conjunto de instâncias." },
  memory: { label: "Por instância", text: "contadores só na memória desta instância; com várias réplicas o volume real pode passar do teto declarado." },
  blocked: { label: "Bloqueado", text: "produção sem backend compartilhado: novas checagens são recusadas até a configuração ser corrigida." },
  off: { label: "Desligado", text: "controles de abuso e custo desativados por configuração explícita; aceitável apenas em teste." },
};

const MODERATION_MODE_INFO = {
  required: "obrigatória: se a triagem ficar indisponível a checagem é recusada (fail-closed).",
  optional: "opcional: a triagem roda quando há credencial; a falha é registrada e a checagem segue.",
  off: "desligada por configuração: nenhuma triagem de conteúdo é executada.",
};

const VIDEO_COVERAGE_LABEL = {
  partial_frames_transcript: "transcrição + amostra de quadros (não é o vídeo integral)",
  uncovered: "não declarada — em modo obrigatório o vídeo é recusado",
};

function MetricCounts({ title, entries, label, empty }) {
  return (
    <section className="admin-metric-block">
      <h3 className="admin-sub">{title}</h3>
      {entries.length === 0
        ? <p className="admin-mut">{empty}</p>
        : <table className="admin-metric-table">
          <thead><tr><th>Item</th><th className="admin-num">Contagem</th></tr></thead>
          <tbody>{entries.map(([key, count]) => <tr key={key}><td>{label(key)}</td><td className="admin-num">{count}</td></tr>)}</tbody>
        </table>}
    </section>
  );
}

/** Métricas dos registros disponíveis e estado do sistema (sem segredos). */
function AdminMetrics({ data, loading, error, onReload }) {
  const metrics = data?.metrics ?? null;
  const system = data?.system ?? null;
  const limits = system?.limits ?? null;
  const alerts = metrics?.alerts ?? [];
  const errors = countEntries(metrics?.errors);
  const errorTotal = sumCounts(metrics?.errors);
  const blockedLimits = limits?.mode === "blocked";
  const sourceLabel = { supabase: "Supabase · registros persistidos", blob: "Blob privado · registros persistidos", memory: "Memória · somente esta instância" }[metrics?.source] ?? "Fonte não informada";
  return (
    <section className="admin-metrics" aria-labelledby="admin-metrics-title">
      <div className="admin-section-heading">
        <p className="admin-eyebrow">Operação · métricas e alertas</p>
        <h1 id="admin-metrics-title">Métricas</h1>
        <p>Agregações da fonte e da janela informadas abaixo. O escopo depende dos registros disponíveis nessa fonte.</p>
      </div>
      <button className="btn ghost" type="button" onClick={onReload} disabled={loading}>{loading ? "Atualizando métricas…" : "Atualizar métricas"}</button>
      {error && <div className="admin-error-state" role="alert"><p>Não foi possível consultar as métricas. Os contadores estão indisponíveis, não zerados.</p><p>{error}</p><button className="btn" type="button" onClick={onReload} disabled={loading}>Tentar novamente</button></div>}
      {loading && !metrics && <ul className="admin-skel" aria-label="Carregando métricas"><li /><li /><li /></ul>}
      {metrics && <>
        <dl className="admin-stats">
          <div><dt>Checagens na janela</dt><dd>{metrics.checks}</dd></div>
          <div><dt>Servidas do cache</dt><dd>{metrics.cached} · {fmtPercent(metrics.checks ? metrics.cached / metrics.checks : 0)}</dd></div>
          <div><dt>Abstenções</dt><dd>{metrics.abstentions} · {fmtPercent(metrics.abstentionRate)}</dd></div>
          <div className={errorTotal ? "bad" : ""}><dt>Erros</dt><dd>{errorTotal} · {fmtPercent(metrics.errorRate)}</dd></div>
        </dl>
        <dl className="admin-stats">
          <div><dt>Latência média</dt><dd>{fmtMs(metrics.latency?.avg)}</dd></div>
          <div><dt>Latência p50</dt><dd>{fmtMs(metrics.latency?.p50)}</dd></div>
          <div><dt>Latência p95</dt><dd>{fmtMs(metrics.latency?.p95)}</dd></div>
        </dl>
        <p className="admin-mut">Fonte: <b>{sourceLabel}</b>. Início da janela: {metrics.window?.startedAt ? fmtFullTime(metrics.window.startedAt) : "não informado"}{metrics.window?.endedAt ? ` · fim: ${fmtFullTime(metrics.window.endedAt)}` : ""}.</p>
        {metrics.source === "memory" && <p className="admin-notice" role="note">Contadores locais, sem persistência: não são compartilhados entre instâncias e reiniciar o processo zera esta janela.</p>}
        {metrics.note && <p className="admin-mut">{metrics.note}</p>}
        {metrics.window?.enoughSample
          ? <p className="admin-mut">Amostra desta janela: {metrics.window.sample} checagens — mínimo de {metrics.thresholds?.minSample} atingido para avaliar os limiares de alerta.</p>
          : <p className="admin-notice" role="note"><b>Amostra pequena:</b> {metrics.window?.sample ?? 0} checagens desde o início da janela, abaixo do mínimo de {metrics.thresholds?.minSample}. Os números indicam o que foi observado, não uma taxa; os alertas por limiar ficam suspensos.</p>}
        <div className="admin-metric-grid">
          <MetricCounts title="Por tipo de entrada" entries={countEntries(metrics.byKind)} label={(key) => KIND_LABEL[key] ?? key} empty="Nenhuma checagem contabilizada por tipo nesta janela." />
          <MetricCounts title="Por desfecho" entries={countEntries(metrics.byOutcome)} label={(key) => OUTCOME_LABEL[key] ?? key} empty="Nenhum desfecho contabilizado nesta janela." />
          <MetricCounts title="Por veredito" entries={countEntries(metrics.verdicts)} label={(key) => VERDICTS[key]?.label ?? key} empty="Nenhum veredito contabilizado nesta janela." />
          <MetricCounts title="Erros por código" entries={errors} label={(key) => OUTCOME_LABEL[key] ?? key} empty="Nenhum erro contabilizado nesta janela." />
        </div>
        <section className="admin-metric-block">
          <h3 className="admin-sub">Contadores observados</h3>
          <dl className="admin-dl">
            <dt>Tokens</dt>
            <dd>entrada {metrics.tokens?.input ?? 0} · saída {metrics.tokens?.output ?? 0} · total {metrics.tokens?.total ?? 0}</dd>
            <dt>Mídia processada</dt>
            <dd>transcrições {metrics.media?.transcript ?? 0} · visão {metrics.media?.vision ?? 0} · quadros {metrics.media?.frames ?? 0}</dd>
            <dt>Moderação</dt>
            <dd>recusadas {metrics.moderation?.refused ?? 0} · sem cobertura {metrics.moderation?.uncovered ?? 0} · indisponível {metrics.moderation?.unavailable ?? 0} · marcadas sensíveis {metrics.moderation?.sensitive ?? 0}</dd>
            <dt>Correções</dt>
            <dd>pedidos criados {metrics.corrections?.created ?? "não disponível"} · marcados como corrigidos {metrics.corrections?.corrected ?? "não disponível"}{metrics.window?.correctionsScope === "all_retained_reports" ? " · todos os pedidos retidos (escopo próprio, independente da janela de checagens)" : metrics.window?.correctionsScope === "editorial_corrections_in_window" ? " · correções editoriais nos registros desta janela" : ""}</dd>
            <dt>Última checagem</dt>
            <dd>{metrics.lastCheckAt ? fmtFullTime(metrics.lastCheckAt) : "nenhuma registrada nesta janela"}</dd>
          </dl>
        </section>
        <section className="admin-metric-block">
          <h3 className="admin-sub">Alertas</h3>
          {alerts.length === 0
            ? <p className="admin-mut">Sem alertas no limiar atual.</p>
            : <ul className="admin-alerts">{alerts.map((alert) => <li key={alert.id} className={alert.level === "critical" ? "critical" : "warning"}>
              <b>{alert.level === "critical" ? "Crítico" : "Atenção"}</b>
              <span>{alert.message}</span>
            </li>)}</ul>}
          <p className="admin-mut">Limiares vigentes: latência média acima de {fmtMs(metrics.thresholds?.avgLatencyMs)} · taxa de erro acima de {fmtPercent(metrics.thresholds?.errorRate)} · abstenção acima de {fmtPercent(metrics.thresholds?.abstentionRate)} · orçamento a partir de {fmtPercent(metrics.thresholds?.budgetUsedPct)} · amostra mínima de {metrics.thresholds?.minSample} checagens.</p>
        </section>
      </>}
      {system && <section className={`admin-metric-block admin-system${blockedLimits ? " critical" : ""}`}>
        <h3 className="admin-sub">Sistema</h3>
        {blockedLimits && <p className="admin-error-state" role="alert">Limites em modo <code>blocked</code>: checagens novas estão sendo recusadas até haver backend compartilhado ou configuração explícita de limites.</p>}
        <dl className="admin-dl">
          <dt>Controle de abuso e custo</dt>
          <dd><b>{LIMITS_MODE_INFO[limits.mode]?.label ?? limits.mode}</b> — {LIMITS_MODE_INFO[limits.mode]?.text ?? "modo não reconhecido pelo painel"} <small className="admin-mut">(backend: {limits.store ?? "nenhum"})</small></dd>
          <dt>Taxa por origem</dt>
          <dd>{limits.maxPerWindow} checagens por {limits.windowSec}s por origem.</dd>
          <dt>Concorrência</dt>
          <dd>{limits.maxConcurrent} checagens simultâneas; cada vaga é reservada por até {limits.slotLeaseSec}s.</dd>
          <dt>Orçamento diário</dt>
          <dd>{limits.dailyUnits} unidades ({Object.entries(limits.costUnits ?? {}).map(([kind, cost]) => `${KIND_LABEL[kind] ?? kind} ${cost}`).join(" · ") || "custo por tipo não declarado"}) · tokens: {limits.dailyTokens ? `${limits.dailyTokens} por dia` : "sem teto declarado"}.</dd>
          <dt>Moderação de conteúdo</dt>
          <dd><b>{system.moderation.mode}</b> — {MODERATION_MODE_INFO[system.moderation.mode] ?? "modo não reconhecido pelo painel"} Modelo: <code>{system.moderation.model}</code>. Categorias de recusa: {(system.moderation.refuseCategories ?? []).join(", ") || "nenhuma declarada"}.</dd>
          <dt>Cobertura de vídeo</dt>
          <dd>{VIDEO_COVERAGE_LABEL[system.moderation.videoCoverage] ?? system.moderation.videoCoverage} · até {system.moderation.frameSamples} quadros amostrados por vídeo na triagem.</dd>
          <dt>Fila de correções</dt>
          <dd>modo {CORRECTION_MODE_LABEL[system.corrections.mode] ?? system.corrections.mode} · persistência {system.corrections.durable ? "durável" : "apenas nesta instância"}.</dd>
          <dt>Limites de mídia</dt>
          <dd>duração máxima {system.media.maxMediaSeconds}s · transferência {fmtBytes(system.media.maxTransferBytes)} · temporários {fmtBytes(system.media.maxTempBytes)} · arquivo enviado {fmtBytes(system.media.maxFileBytes)}.</dd>
          <dt>Registro de checagens</dt>
          <dd>{system.logs.enabled ? `Registros privados persistidos · modo ${system.logs.mode ?? "não informado"}.` : "Persistência de registros desabilitada; somente console desta instância."}</dd>
          <dt>Política de URLs</dt>
          <dd>portas permitidas: <code>{system.urlPolicy.ports}</code> · hosts privados {system.urlPolicy.allowPrivateHosts ? "permitidos por configuração explícita" : "bloqueados"}.</dd>
        </dl>
        <p className="admin-mut">Somente configuração operacional é exibida; credenciais e segredos não são devolvidos pela API.</p>
      </section>}
    </section>
  );
}

const ADMIN_SECTIONS = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "checks", label: "Checagens", icon: ClipboardCheck },
  { id: "corrections", label: "Reportes e correções", icon: MessageSquare },
  { id: "metrics", label: "Métricas", icon: Activity },
  { id: "models", label: "Modelos & provedores", icon: Settings2 },
  { id: "methodology", label: "Metodologia", icon: BookOpen },
];

function currentAdminSection() {
  const section = new URLSearchParams(location.search).get("section");
  return ADMIN_SECTIONS.some((entry) => entry.id === section) ? section : "overview";
}

function adminParam(name, fallback = "") {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

function updateAdminUrl(patch, replace = true) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  const url = `${location.pathname}?${params}${location.hash}`;
  history[replace ? "replaceState" : "pushState"]({ admin: true }, "", url);
}

function AdminMethodology({ methodology }) {
  const version = methodology?.version;
  const bands = methodology?.bands ?? [];
  const statuses = methodology?.statuses ?? [];
  const evaluation = methodology?.evaluation;
  return <section className="admin-methodology" aria-labelledby="admin-methodology-title">
    <div className="admin-section-heading"><p className="admin-eyebrow">Transparência</p><h2 id="admin-methodology-title">Metodologia</h2><p>Como as checagens são organizadas, quais evidências foram registradas e quais limites permanecem.</p></div>
    <ol className="admin-method-steps">
      <li><b>Delimitar o material</b><span>Separar a afirmação analisada de metadados e registrar as modalidades disponíveis.</span></li>
      <li><b>Identificar afirmações</b><span>Distinguir fatos verificáveis de opinião, previsão e condição.</span></li>
      <li><b>Buscar e vincular evidências</b><span>Relacionar fontes e trechos às afirmações; uma URL isolada não demonstra suporte.</span></li>
      <li><b>Avaliar suficiência e limites</b><span>Ausência ou inacessibilidade de evidência não equivale, por si só, a falsidade.</span></li>
      <li><b>Concluir e registrar</b><span>Interpretar o resultado com seus limites, execução e versão metodológica disponíveis.</span></li>
    </ol>
    <h3 className="admin-sub">Versão em produção</h3>
    <p className="admin-mut">As novas checagens usam <b>{version ?? "versão não informada pela API"}</b>. Registros com outra versão aparecem no detalhe como não reexecutados.</p>
    {bands.length > 0 && <>
      <h3 className="admin-sub">Faixas de score aplicadas pelo servidor</h3>
      <ul className="admin-method-bands">{bands.map((band) => <li key={band.verdict}><b>{band.min}–{band.max}</b><span>{VERDICTS[band.verdict]?.label ?? band.verdict}</span></li>)}</ul>
    </>}
    {statuses.length > 0 && <>
      <h3 className="admin-sub">Estados operacionais</h3>
      <ul className="admin-method-statuses">{statuses.map((status) => <li key={status.id}><code>{status.id}</code><span>{status.label}</span></li>)}</ul>
    </>}
    {evaluation && <>
      <h3 className="admin-sub">Avaliação</h3>
      <p className="admin-mut">{evaluation.note} Harness reproduzível: <code>{evaluation.harness}</code>. Corpus anotado: {evaluation.corpus ?? "ainda não entregue"} · benchmark publicado: {evaluation.benchmarkPublished ? "sim" : "não"}.</p>
    </>}
    <p className="admin-mut">O painel não apresenta métricas de precisão ou certificações sem avaliação documentada.</p>
    <a className="btn" href="/metodologia.html">Ver metodologia pública</a>
  </section>;
}

export default function Admin({ showToast }) {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? "");
  const [input, setInput] = useState("");
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState(() => adminParam("filter", "all"));
  const [query, setQuery] = useState(() => adminParam("q"));
  const [sort, setSort] = useState(() => adminParam("sort", "newest"));
  const [statusFilter, setStatusFilter] = useState(() => adminParam("status", "all"));
  const [kindFilter, setKindFilter] = useState(() => adminParam("kind", "all"));
  const [page, setPage] = useState(() => Math.max(0, Number.parseInt(adminParam("page", "0"), 10) || 0));
  const [fromDate, setFromDate] = useState(() => adminParam("from"));
  const [toDate, setToDate] = useState(() => adminParam("to"));
  const [pageLimit, setPageLimit] = useState(() => {
    const limit = Number(adminParam("limit", String(PAGE_SIZE)));
    return [15, 30, 60].includes(limit) ? limit : PAGE_SIZE;
  });
  const [listInfo, setListInfo] = useState({ total: 0, mode: "unknown" });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [hint, setHint] = useState("");
  const [aiCatalog, setAiCatalog] = useState(null);
  const [aiConfig, setAiConfig] = useState(null);
  const [aiDraft, setAiDraft] = useState(null);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiPersisted, setAiPersisted] = useState(true);
  const [aiError, setAiError] = useState("");
  const [aiConfigErrors, setAiConfigErrors] = useState(null);
  const [aiConfigUnavailable, setAiConfigUnavailable] = useState(null);
  const [aiConfigStale, setAiConfigStale] = useState(false);
  const [aiStaleReason, setAiStaleReason] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [methodology, setMethodology] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [correctionsError, setCorrectionsError] = useState("");
  const [correctionsLoading, setCorrectionsLoading] = useState(false);
  const [correctionStatuses, setCorrectionStatuses] = useState([]);
  const [correctionDetail, setCorrectionDetail] = useState(null);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [metricsData, setMetricsData] = useState(null);
  const [metricsError, setMetricsError] = useState("");
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [section, setSection] = useState(currentAdminSection);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const aiRequest = useRef(0);
  const correctionRequest = useRef(0);
  const metricsRequest = useRef(0);
  const loadedOnce = useRef(false);

  /** Encerra a sessão local quando o servidor recusa a chave. */
  const expireSession = useCallback(() => {
    listRequest.current += 1;
    aiRequest.current += 1;
    detailRequest.current += 1;
    correctionRequest.current += 1;
    metricsRequest.current += 1;
    sessionStorage.removeItem(SECRET_KEY);
    setSecret("");
    setItems(null);
    setDetail(null);
    setCorrections(null);
    setCorrectionDetail(null);
    setMetricsData(null);
    setMetricsError("");
    setMetricsLoading(false);
    setAiCatalog(null);
    setAiConfig(null);
    setAiDraft(null);
    setAiConfigErrors(null);
    setAiConfigUnavailable(null);
    setAiConfigStale(false);
    setAiStaleReason(null);
    setAiError("");
    setAiSaving(false);
    setAiLoading(false);
    setAiPersisted(true);
  }, []);

  const authedFetch = useCallback(async (path, { allowAiConfigState = false } = {}) => {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401) {
      expireSession();
      throw new Error("Sessão inválida. Entre de novo.");
    }
    const data = await res.json().catch(() => null);
    const configState = allowAiConfigState && res.status === 200 && ["ai_config_invalid", "ai_config_unavailable"].includes(data?.error) && data.config === null;
    if (!res.ok || (data?.error && !configState) || !data) {
      const error = new Error(data?.message || data?.error || `Falha ao carregar (HTTP ${res.status}).`);
      error.data = data;
      throw error;
    }
    return data;
  }, [secret, expireSession]);

  const authedPost = useCallback(async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      expireSession();
      throw new Error("Sessão inválida. Entre de novo.");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      const error = new Error(data?.message || data?.error || `Falha na operação (HTTP ${res.status}).`);
      error.data = data;
      error.status = res.status;
      throw error;
    }
    return data ?? {};
  }, [secret, expireSession]);

  const load = useCallback(async ({ silent } = {}) => {
    if (!secret) return;
    const request = ++listRequest.current;
    if (loadedOnce.current) setRefreshing(true);
    setLoading(true);
    setLoadError("");
    try {
      if (fromDate && toDate && fromDate > toDate) throw new Error("A data inicial deve ser anterior ou igual à data final.");
      const params = new URLSearchParams({ offset: String(page * pageLimit), limit: String(pageLimit), sort });
      if (query.trim()) params.set("q", query.trim());
      if (filter !== "all") params.set("filter", filter);
      if (statusFilter !== "all") params.set("outcome", statusFilter);
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (fromDate) params.set("from", new Date(`${fromDate}T00:00:00`).toISOString());
      if (toDate) params.set("to", new Date(`${toDate}T23:59:59.999`).toISOString());
      const data = await authedFetch(`/api/admin?${params}`);
      if (request !== listRequest.current) return;
      setHint(data.hint ?? "");
      setListInfo({
        total: data.total ?? data.available ?? data.items?.length ?? 0,
        mode: data.mode ?? "unknown",
      });
      setItems((data.items ?? []).map((entry) => ({
        ...entry,
        verdict: migrateVerdict(entry?.factualVerdict ?? entry?.verdict, entry?.score),
      })));
      setUpdatedAt(new Date().toISOString());
      if (!silent) showToast("Lista atualizada.");
    } catch (err) {
      if (request !== listRequest.current) return;
      setItems(null);
      if (err.data?.mode) setListInfo((current) => ({ ...current, mode: err.data.mode }));
      setLoadError(err.message || "Não foi possível carregar as checagens.");
      if (!silent) showToast(err.message);
    } finally {
      if (request === listRequest.current) {
        loadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [secret, authedFetch, showToast, page, pageLimit, query, filter, sort, statusFilter, kindFilter, fromDate, toDate]);

  const loadAi = useCallback(async ({ refresh = false, preserveDraft = false } = {}) => {
    if (!secret) return;
    const request = ++aiRequest.current;
    setAiError("");
    setAiLoading(true);
    try {
      const data = await authedFetch(`/api/admin?config=1${refresh ? "&refresh=1" : ""}`, { allowAiConfigState: true });
      if (request !== aiRequest.current) return;
      setAiCatalog(data.catalog ? {
        ...data.catalog,
        source: data.source ?? data.catalog.source,
        revision: data.revision ?? data.catalog.revision,
        updatedAt: data.updatedAt ?? data.catalog.updatedAt,
      } : null);
      setAiConfig(data.config ?? null);
      if (!preserveDraft) setAiDraft(data.config ?? {});
      setAiConfigErrors(data.configErrors ?? null);
      setAiConfigUnavailable(data.config ? null : (data.error ?? "ai_config_unavailable"));
      setAiConfigStale(data.config ? Boolean(data.stale) : false);
      setAiStaleReason(data.staleReason ?? null);
      setAiPersisted(data.persisted === true);
      if (data.methodology) setMethodology(data.methodology);
      if (!data.catalog || (!data.config && !["ai_config_invalid", "ai_config_unavailable"].includes(data.error))) setAiError("A API não retornou catálogo e configuração.");
    } catch (err) {
      if (request !== aiRequest.current) return;
      if (!preserveDraft) setAiCatalog(null);
      setAiError(err.message || "Não foi possível carregar modelos e configuração.");
    } finally {
      if (request === aiRequest.current) setAiLoading(false);
    }
  }, [secret, authedFetch]);

  const closeDetail = useCallback(() => {
    detailRequest.current += 1;
    setDetail(null);
    setDetailLoading(false);
    if (adminParam("detail")) updateAdminUrl({ detail: null });
  }, []);

  const openDetail = useCallback(async (id) => {
    const request = ++detailRequest.current;
    if (adminParam("detail") !== id) updateAdminUrl({ detail: id }, false);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await authedFetch(`/api/admin?id=${encodeURIComponent(id)}`);
      if (request !== detailRequest.current) return;
      const rec = data.record ?? null;
      setDetail(rec ? { ...rec, verdict: migrateVerdict(rec.factualVerdict ?? rec.verdict, rec.score) } : null);
      if (!rec) showToast("Detalhe não encontrado.");
    } catch (err) {
      if (request === detailRequest.current) showToast(err.message);
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, [authedFetch, showToast]);

  const loadCorrections = useCallback(async () => {
    if (!secret) return;
    setCorrectionsError("");
    setCorrectionsLoading(true);
    try {
      const data = await authedFetch("/api/admin?corrections=1");
      setCorrections(data);
      if (Array.isArray(data.statuses)) setCorrectionStatuses(data.statuses);
    } catch (err) {
      setCorrectionsError(err.message || "Não foi possível carregar a fila de correções.");
    } finally {
      setCorrectionsLoading(false);
    }
  }, [secret, authedFetch]);

  const loadMetrics = useCallback(async () => {
    if (!secret) return;
    const request = ++metricsRequest.current;
    setMetricsError("");
    setMetricsLoading(true);
    try {
      const data = await authedFetch("/api/admin?metrics=1");
      if (!data.metrics) throw new Error("A consulta não retornou métricas.");
      if (request !== metricsRequest.current) return;
      setMetricsData(data);
    } catch (err) {
      if (request !== metricsRequest.current) return;
      setMetricsData(null);
      setMetricsError(err.message || "Não foi possível carregar as métricas.");
    } finally {
      if (request === metricsRequest.current) setMetricsLoading(false);
    }
  }, [secret, authedFetch]);

  const closeCorrection = useCallback(() => {
    correctionRequest.current += 1;
    setCorrectionDetail(null);
    setCorrectionLoading(false);
    if (adminParam("correction")) updateAdminUrl({ correction: null });
  }, []);

  const openCorrection = useCallback(async (protocol) => {
    const request = ++correctionRequest.current;
    if (adminParam("correction") !== protocol) updateAdminUrl({ correction: protocol }, false);
    setCorrectionLoading(true);
    try {
      const data = await authedFetch(`/api/admin?correction=${encodeURIComponent(protocol)}`);
      if (request !== correctionRequest.current) return;
      setCorrectionDetail(data.correction ?? null);
      if (Array.isArray(data.statuses) && data.statuses.length > 0) setCorrectionStatuses(data.statuses);
      if (!data.correction) showToast("Pedido de correção não encontrado.");
    } catch (err) {
      if (request === correctionRequest.current) showToast(err.message);
    } finally {
      if (request === correctionRequest.current) setCorrectionLoading(false);
    }
  }, [authedFetch, showToast]);

  /** Salva o estado do pedido; devolve o corpo para o painel mostrar o que foi aplicado. */
  const saveCorrection = useCallback(async (protocol, { status, note }) => {
    try {
      const data = await authedPost("/api/admin?corrections=1", { protocol, status, note: note || undefined });
      if (data.correction) {
        setCorrectionDetail(data.correction);
        setCorrections((current) => current?.items ? {
          ...current,
          items: current.items.map((item) => item.protocol === protocol ? {
            ...item,
            status: data.correction.status,
            updatedAt: data.correction.updatedAt,
            kind: data.correction.kind,
            messagePreview: String(data.correction.message ?? "").slice(0, 240),
          } : item),
        } : current);
      }
      return data;
    } catch (err) {
      const label = { missing_protocol: "Protocolo ausente no pedido.", bad_status: "Estado inválido para a fila.", not_found: "Pedido não encontrado na fila." }[err.message];
      if (label) throw new Error(label);
      throw err;
    }
  }, [authedPost]);

  const invalidateAdminCache = useCallback(async (reason) => authedPost("/api/admin?cache=1", { action: "invalidate", reason: reason || "manual" }), [authedPost]);

  async function saveAi() {
    if (!aiDraft || aiConfigUnavailable === "ai_config_unavailable" || aiLoading) return;
    const request = ++aiRequest.current;
    setAiSaving(true);
    setAiError("");
    try {
      const res = await fetch("/api/admin?config=1", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: aiDraft }),
      });
      if (request !== aiRequest.current) return;
      if (res.status === 401) {
        expireSession();
        showToast("Sessão inválida. Entre de novo.");
        return;
      }
      const data = await res.json();
      if (request !== aiRequest.current) return;
      if (!res.ok || data.error) {
        const details = Object.entries(data.fields ?? {}).map(([step, reason]) => `${STEP_LABEL[step] ?? step}: ${reason}`).join(" · ");
        setAiConfigErrors(data.fields ?? null);
        setAiError([data.message || data.error || "Não foi possível salvar a configuração.", details].filter(Boolean).join(" — "));
        showToast("Não consegui salvar a configuração de modelos.");
        return;
      }
      setAiConfigErrors(null);
      setAiConfigUnavailable(null);
      setAiConfigStale(false);
      setAiStaleReason(null);
      setAiConfig(data.saved ?? aiDraft);
      setAiDraft(data.saved ?? aiDraft);
      setAiPersisted(data.persisted === true);
      setAiCatalog((current) => current ? { ...current, revision: data.revision ?? current.revision, source: data.source ?? current.source, updatedAt: data.updatedAt ?? current.updatedAt } : current);
      showToast(data.persisted === false ? "Aplicado apenas nesta instância; não há persistência durável." : "Configuração de modelos atualizada.");
    } catch {
      if (request !== aiRequest.current) return;
      setAiError("Falha de rede ao salvar a configuração.");
      showToast("Não consegui salvar a configuração de modelos.");
    } finally { if (request === aiRequest.current) setAiSaving(false); }
  }

  useEffect(() => {
    load({ silent: true });
  }, [load]);

  useEffect(() => {
    loadAi();
    const detailId = adminParam("detail");
    if (secret && detailId) openDetail(detailId);
    const correctionProtocol = adminParam("correction");
    if (secret && correctionProtocol) openCorrection(correctionProtocol);
  }, [secret, loadAi, openDetail, openCorrection]);

  useEffect(() => {
    if (!secret) return;
    if (section === "corrections") loadCorrections();
    if (section === "metrics") loadMetrics();
  }, [section, secret, loadCorrections, loadMetrics]);

  useEffect(() => {
    const sync = () => {
      setSection(currentAdminSection());
      setFilter(adminParam("filter", "all"));
      setQuery(adminParam("q"));
      setSort(adminParam("sort", "newest"));
      setStatusFilter(adminParam("status", "all"));
      setKindFilter(adminParam("kind", "all"));
      setPage(Math.max(0, Number.parseInt(adminParam("page", "0"), 10) || 0));
      setFromDate(adminParam("from"));
      setToDate(adminParam("to"));
      const limit = Number(adminParam("limit", String(PAGE_SIZE)));
      setPageLimit([15, 30, 60].includes(limit) ? limit : PAGE_SIZE);
      const detailId = adminParam("detail");
      if (detailId && secret) openDetail(detailId);
      else closeDetail();
      const correctionProtocol = adminParam("correction");
      if (correctionProtocol && secret) openCorrection(correctionProtocol);
      else closeCorrection();
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [secret, openDetail, closeDetail, openCorrection, closeCorrection]);

  function navigateSection(id) {
    setSection(id);
    updateAdminUrl({ section: id }, false);
  }

  function login(e) {
    e.preventDefault();
    if (!input.trim()) return;
    sessionStorage.setItem(SECRET_KEY, input.trim());
    setSecret(input.trim());
    setInput("");
  }
  function logout() {
    expireSession();
  }
  const stats = useMemo(() => {
    const list = items ?? [];
    const okay = list.filter((item) => !item.error && item.outcome !== "error" && item.resultStatus !== "error");
    const times = okay.map((item) => item.totalMs).filter((time) => time != null).sort((a, b) => a - b);
    // Referência determinística: instante da última carga bem-sucedida, não o relógio do render.
    const reference = updatedAt ? new Date(updatedAt).getTime() : 0;
    return {
      errors: list.length - okay.length,
      medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      last24h: reference ? list.filter((item) => reference - new Date(item.at).getTime() < 86400000).length : 0,
    };
  }, [items, updatedAt]);
  const pages = Math.max(1, Math.ceil(listInfo.total / pageLimit));
  const visible = items ?? [];
  const hasFilter = query.trim() !== "" || filter !== "all" || statusFilter !== "all" || kindFilter !== "all" || !!fromDate || !!toDate;
  const operationalStatuses = Object.keys(OUTCOME_LABEL);
  const inputKinds = Object.keys(KIND_LABEL);

  if (!secret) return <div className="admin-login"><section className="card">
    <div className="admin-section-heading"><p className="admin-eyebrow">Área restrita</p><h1>Painel administrativo</h1></div>
    <form onSubmit={login}><label className="field-label" htmlFor="admin-secret">Chave de acesso</label>
      <div className="input-box"><input id="admin-secret" type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ADMIN_SECRET" autoComplete="current-password" /></div>
      <div className="verify-actions"><button className="btn primary" type="submit" disabled={!input.trim()}>Entrar</button></div>
    </form>
  </section></div>;

  return <div className="admin-wrap">
    <header className="admin-shell-header">
      <a className="admin-brand" href="/">isso é verdade<span>?</span><small>ADMINISTRAÇÃO</small></a>
      <div className="admin-actions">
        <button className="btn ghost" type="button" onClick={() => { load({}); loadAi({ preserveDraft: true }); if (section === "corrections") loadCorrections(); if (section === "metrics") loadMetrics(); }} disabled={refreshing || loading}><RefreshCw size={15} aria-hidden="true" className={refreshing || loading ? "admin-spinning" : undefined} />{refreshing || loading ? "Atualizando…" : "Atualizar dados"}</button>
        <a className="btn" href="/">Voltar ao site<ArrowUpRight size={15} aria-hidden="true" /></a>
        <button className="btn ghost" type="button" onClick={logout}><LogOut size={15} aria-hidden="true" />Sair</button>
      </div>
    </header>
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Seções administrativas">
        <p className="admin-nav-label">ESPAÇO DE TRABALHO</p>
        {ADMIN_SECTIONS.map((entry) => <button key={entry.id} type="button" aria-current={section === entry.id ? "page" : undefined} onClick={() => navigateSection(entry.id)}><entry.icon size={18} aria-hidden="true" /><span>{entry.label}</span></button>)}
        <div className="admin-nav-footer"><ShieldCheck size={16} aria-hidden="true" /><span>Acesso administrativo<br /><small>Sessão restrita a este navegador</small></span></div>
      </nav>
      <section className="admin-content" aria-label="Conteúdo administrativo">
        <p className="admin-storage-mode" role="status">Armazenamento: <b>{({ supabase: "Supabase · registros privados duráveis", blob: "Blob · registros administrativos", disabled: "Desabilitado · sem registros duráveis", unknown: "Aguardando resposta do serviço" })[listInfo.mode] ?? listInfo.mode}</b></p>
        {section === "overview" && <>
          <div className="admin-section-heading"><p className="admin-eyebrow">Operação · registros retidos</p><h1>Visão geral</h1><p>Indicadores calculados somente sobre os registros disponibilizados pela API.</p></div>
          {hint && <p className="admin-notice">{hint}</p>}
          {loadError && <div className="admin-error-state" role="alert"><p>{loadError}</p><button className="btn" type="button" onClick={() => load({})}>Tentar novamente</button></div>}
          <dl className="admin-stats">
            <div><dt>Total que corresponde aos filtros</dt><dd>{loading ? "…" : loadError ? "—" : listInfo.total}</dd></div>
            <div><dt>Últimas 24h · nesta lista</dt><dd>{loading ? "…" : stats.last24h}</dd></div>
            <div><dt>Mediana · sem erro nesta página</dt><dd>{loading ? "…" : fmtMs(stats.medianMs)}</dd></div>
            <div className={stats.errors ? "bad" : ""}><dt>Execuções com erro · nesta lista</dt><dd>{loading ? "…" : stats.errors}</dd></div>
          </dl>
          <p className="admin-mut">Durações e contadores operacionais usam apenas a página atual, com os filtros escolhidos em Checagens. Não representam todo o histórico. Atualização: {updatedAt ? fmtFullTime(updatedAt) : "ainda não carregada"}.</p>
          <section className="admin-recent"><div className="admin-section-heading"><h2>Checagens nesta página</h2><button className="quiet-link" type="button" onClick={() => navigateSection("checks")}>Abrir checagens</button></div>
            {items?.slice(0, 5).map((item) => <button className="admin-recent-row" type="button" key={item.id} onClick={() => openDetail(item.id)}><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome} /><span>{item.inputPreview || item.id}</span><time>{fmtTime(item.at)}</time></button>)}
            {items?.length === 0 && !loadError && <p className="admin-mut">A API não retornou registros.</p>}
          </section>
        </>}
        {section === "checks" && <section aria-labelledby="admin-checks-title">
          <div className="admin-section-heading"><p className="admin-eyebrow">Registros retidos</p><h1 id="admin-checks-title">Checagens</h1><p>Explore os resultados, acompanhe execuções e consulte as evidências de cada análise.</p></div>
          {hint && <p className="admin-notice">{hint}</p>}
          {loadError && <div className="admin-error-state" role="alert"><p>{loadError}</p><button className="btn" type="button" onClick={() => load({})}>Tentar novamente</button></div>}
          <div className="admin-check-toolbar"><div className="search-box"><Search size={17} aria-hidden="true" /><input type="search" placeholder="Buscar por texto de entrada ou ID…" aria-label="Buscar checagens no servidor por texto ou ID" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); updateAdminUrl({ q: e.target.value, page: null }); }} /></div>
            <label className="admin-sort">Ordenar<AdminSelect value={sort} onValueChange={(value) => { setSort(value); setPage(0); updateAdminUrl({ sort: value, page: null }); }}>{SORTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</AdminSelect></label>
            <label className="admin-sort">Estado da execução<AdminSelect value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(0); updateAdminUrl({ status: value === "all" ? null : value, page: null }); }}><option value="all">Todos</option>{operationalStatuses.map((status) => <option key={status} value={status}>{OUTCOME_LABEL[status] ?? status}</option>)}</AdminSelect></label>
            <label className="admin-sort">Tipo de entrada<AdminSelect value={kindFilter} onValueChange={(value) => { setKindFilter(value); setPage(0); updateAdminUrl({ kind: value === "all" ? null : value, page: null }); }}><option value="all">Todos</option>{inputKinds.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind] ?? kind}</option>)}</AdminSelect></label>
            <label className="admin-sort" htmlFor="admin-from">De (data da execução)<input id="admin-from" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => { setFromDate(e.target.value); setPage(0); updateAdminUrl({ from: e.target.value, page: null }); }} /></label>
            <label className="admin-sort" htmlFor="admin-to">Até (inclusive)<input id="admin-to" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => { setToDate(e.target.value); setPage(0); updateAdminUrl({ to: e.target.value, page: null }); }} /></label>
            <label className="admin-sort">Registros por página<AdminSelect value={String(pageLimit)} onValueChange={(value) => { setPageLimit(Number(value)); setPage(0); updateAdminUrl({ limit: value, page: null }); }}>{[15, 30, 60].map((limit) => <option key={limit} value={String(limit)}>{limit}</option>)}</AdminSelect></label>
          </div>
          <div className="filters" role="group" aria-label="Filtrar checagens no servidor">{FILTERS.map((entry) => <button key={entry.id} type="button" aria-pressed={filter === entry.id} onClick={() => { setFilter(entry.id); setPage(0); updateAdminUrl({ filter: entry.id, page: null }); }}>{VERDICTS[entry.id] && <i style={{ background: VERDICTS[entry.id].color }} />}{entry.label}</button>)}</div>
          <div className="results-meta" aria-live="polite"><p>{loading ? "Consultando o servidor…" : loadError ? "Consulta indisponível" : `${listInfo.total} ${listInfo.total === 1 ? "checagem encontrada" : "checagens encontradas"} · ${visible.length} nesta página`}{query.trim() && <> para “{query.trim()}”</>}</p>{hasFilter && <button type="button" onClick={() => { setQuery(""); setFilter("all"); setStatusFilter("all"); setKindFilter("all"); setFromDate(""); setToDate(""); setPage(0); updateAdminUrl({ q: null, filter: null, status: null, kind: null, from: null, to: null, page: null }); }}>Limpar filtros</button>}</div>
          {loading || (!items && !loadError) ? <ul className="admin-skel" aria-label="Carregando checagens"><li /><li /><li /></ul>
            : loadError ? null : visible.length === 0 ? <div className="empty"><h3>Nenhuma checagem encontrada</h3><p>{listInfo.mode === "disabled" ? "O armazenamento de registros está desabilitado." : "Não há registros nesta página para os filtros escolhidos."}</p></div>
              : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Resultado</th><th>Afirmação / entrada</th><th>Tipo</th><th>Data</th><th>Duração</th><th>Modelo</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} tabIndex="0" onClick={() => openDetail(item.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(item.id); } }}>
                <td><div className="admin-result-cell"><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome} /><b className="admin-score-value">{item.score == null ? "Sem nota" : `${item.score}/100`}</b></div>{(item.outcome || item.resultStatus || item.error) && <small className="admin-op-status">{OUTCOME_LABEL[item.outcome ?? item.resultStatus] ?? (item.error ? "Erro registrado" : item.resultStatus)}</small>}<FailureSummary record={item} /></td><td className="admin-table-preview" title={item.inputPreview || item.id}>{item.inputPreview || "(sem texto)"}<small>{item.id}</small></td><td>{KIND_LABEL[item.kind] ?? item.kind ?? "—"}</td><td><time title={fmtFullTime(item.at)}>{fmtTime(item.at)}</time></td><td>{fmtMs(item.totalMs)}</td><td>{item.model ?? "Modelo não registrado"}<small>{item.provider ?? "Provedor não registrado"}</small></td>
              </tr>)}</tbody></table>
              <ul className="admin-cards">{visible.map((item) => <li key={item.id}><button type="button" className="admin-card-row" onClick={() => openDetail(item.id)}><span className="admin-result-cell"><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome}/><b>{item.score == null ? "sem nota" : item.score}</b></span><strong>{item.inputPreview || "(sem texto)"}</strong><span>{KIND_LABEL[item.kind] ?? item.kind ?? "—"} · {fmtTime(item.at)}</span><span>{item.outcome ? OUTCOME_LABEL[item.outcome] ?? item.outcome : "Registro legado"} · {fmtMs(item.totalMs)} · {item.provider ?? "Provedor não registrado"} · {item.model ?? "Modelo não registrado"}</span><FailureSummary record={item} /><small>{item.id}</small></button></li>)}</ul></div>}
          {!loadError && (pages > 1 || page > 0) && <nav className="admin-pages" aria-label="Paginação"><button className="btn ghost" type="button" disabled={!page || loading} onClick={() => { const next = page - 1; setPage(next); updateAdminUrl({ page: next || null }); }}>← Anterior</button><span>Página {page + 1} de {pages}</span><button className="btn ghost" type="button" disabled={page >= pages - 1 || loading} onClick={() => { const next = page + 1; setPage(next); updateAdminUrl({ page: next }); }}>Próxima →</button></nav>}
        </section>}
        {section === "corrections" && <AdminCorrections
          data={corrections}
          loading={correctionsLoading}
          error={correctionsError}
          statuses={correctionStatuses}
          detail={correctionDetail}
          detailLoading={correctionLoading}
          selected={adminParam("correction")}
          onReload={() => loadCorrections()}
          onOpen={openCorrection}
          onClose={closeCorrection}
          onOpenCheck={openDetail}
          onSave={saveCorrection}
          onInvalidateCache={invalidateAdminCache}
          showToast={showToast}
        />}
        {section === "metrics" && <AdminMetrics data={metricsData} loading={metricsLoading} error={metricsError} onReload={() => loadMetrics()} />}
        {section === "models" && <section aria-labelledby="admin-models-title"><div className="admin-section-heading"><p className="admin-eyebrow">Configuração e compatibilidade</p><h1 id="admin-models-title">Modelos & provedores</h1><p>Defina separadamente os modelos usados na avaliação factual, visão e transcrição.</p></div>
          <AiConfigCard catalog={aiCatalog} draft={aiDraft} saved={aiConfig} saving={aiSaving} loading={aiLoading} persisted={aiPersisted} error={aiError} configErrors={aiConfigErrors} configUnavailable={aiConfigUnavailable} configStale={aiConfigStale} staleReason={aiStaleReason} onChange={setAiDraft} onSave={saveAi} onReload={() => loadAi()} onRefreshCatalog={() => loadAi({ refresh: true, preserveDraft: true })} />
        </section>}
        {section === "methodology" && <AdminMethodology methodology={methodology} />}
      </section>
    </div>
    <DetailDialog detail={detail} loading={detailLoading} onClose={closeDetail} showToast={showToast} methodology={methodology} />
  </div>;
}
