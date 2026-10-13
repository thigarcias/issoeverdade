import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLAIM_STATUS, VERDICTS, migrateVerdict } from "../data/constants.js";

const SECRET_KEY = "iev-admin-secret";
const PAGE_SIZE = 15;

const KIND_LABEL = { link: "Link", text: "Texto", image: "Imagem", video: "Vídeo" };
const OUTCOME_LABEL = {
  checked: "Checagem executada",
  partial_coverage: "Cobertura parcial",
  insufficient_input: "Material insuficiente",
  inaccessible_media: "Mídia inacessível",
  no_verifiable_claims: "Sem afirmação verificável",
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
              {detail.score != null && <b className="admin-detail-score">{detail.score}/100</b>}
              <span className="admin-mut">
                {OUTCOME_LABEL[detail.outcome] ?? "Registro legado"} · {KIND_LABEL[detail.kind] ?? detail.kind} · {fmtFullTime(detail.at)} · total {fmtMs(detail.totalMs)}
              </span>
              <CopyButton text={detail.id} showToast={showToast} label="Copiar ID" />
            </div>

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
                        <i /> {st.label} · {c.score}
                      </span>
                      <p>{c.text}</p>
                      {c.note && <small>{c.note}</small>}
                      {Array.isArray(c.evidence) && c.evidence.length > 0 && <ul className="admin-claim-evidence">{c.evidence.map((evidence, index) => {
                        const source = detail.sources?.[evidence.sourceId];
                        const relation = { supports: "Apoia", refutes: "Contradiz", context: "Contextualiza" }[evidence.relation] ?? "Evidência";
                        return (
                          <li key={`${evidence.sourceId ?? "source"}-${index}`}>
                            <b>{relation}{source?.outlet ? ` · ${source.outlet}` : ""}</b>
                            {evidence.quote && <q>{evidence.quote}</q>}
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
                  {detail.aiConfig && <><dt>Modelos solicitados</dt><dd>{Object.entries(detail.aiConfig).map(([step, value]) => `${STEP_LABEL[step] ?? step}: ${typeof value === "object" ? `${value.provider ?? ""}/${value.model ?? ""}` : value}`).join(" · ")}</dd></>}
                  {detail.modelsUsed && Object.keys(detail.modelsUsed).length > 0 && <><dt>Modelos efetivamente usados</dt><dd>{Object.entries(detail.modelsUsed).map(([step, value]) => `${STEP_LABEL[step] ?? step}: ${value.provider}/${value.model}${value.fallbackFor ? ` (fallback de ${value.fallbackFor})` : ""}`).join(" · ")}</dd></>}
                  <dt>Cache</dt><dd>{detail.cached ? "Resultado servido do cache" : detail.cachedFrom ? `Resultado reutilizado de ${detail.cachedFrom}` : "Não registrado como cache"}</dd>
                  <dt>Consultas de busca registradas</dt>
                  <dd className="admin-mono">{detail.researchQueries?.length > 0 ? detail.researchQueries.join(" · ") : "Nenhuma consulta preservada nesta execução"}</dd>
                  <dt>Proveniência da pesquisa por etapa</dt>
                  <dd>{detail.researchDiagnostics?.length > 0 ? detail.researchDiagnostics.map((item) => (
                    <p key={item.step}>
                      {STEP_LABEL[item.step] ?? item.step}: {({ available: "URLs estruturadas disponíveis", missing_provenance: "Busca executada sem URLs rastreáveis retornadas", no_search_calls: "Nenhuma chamada de busca registrada", not_requested: "Revisão do dossiê sem nova busca" })[item.status] ?? item.status}
                      {" "}· {item.acceptedUrlCount ?? 0} URLs · {item.annotationCount ?? 0} citações · {item.retrievedCount ?? 0} resultados de busca
                    </p>
                  )) : "Diagnóstico não preservado nesta execução"}</dd>
                  {detail.researchDiagnostics?.length > 0 && <>
                    <dt>Chamadas da ferramenta</dt>
                    <dd><details><summary>Status e páginas tentadas</summary><pre className="admin-pre">{JSON.stringify(detail.researchDiagnostics.map(({ step, calls }) => ({ step, calls })), null, 2)}</pre></details></dd>
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
                  <dt>Hash do prompt · judge</dt>
                  <dd className="admin-mono">{detail.promptHashes?.judge ?? "não registrado"}</dd>
                  <dt>Hash do prompt · final</dt>
                  <dd className="admin-mono">{detail.promptHashes?.final ?? "não registrado"}</dd>
                </dl>
                <p className="admin-mut">Prévias truncadas no registro: entrada analisada até 2.000 caracteres; resposta bruta até 4.000 (judge) e 6.000 (final). O texto integral do prompt de sistema não é armazenado, apenas o hash.</p>
                {detail.judgePromptPreview && (
                  <details className="admin-sec">
                    <summary>Prompt passo 1 (judge) · prévia truncada</summary>
                    <pre className="admin-pre">{detail.judgePromptPreview}</pre>
                  </details>
                )}
                {detail.judgeRawPreview && (
                  <details className="admin-sec">
                    <summary>Resposta bruta passo 1 · prévia truncada</summary>
                    <pre className="admin-pre">{detail.judgeRawPreview}</pre>
                  </details>
                )}
                {detail.finalPromptPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Prompt passo 2 (final) · prévia truncada</summary>
                    <pre className="admin-pre">{detail.finalPromptPreview}</pre>
                  </details>
                )}
                {detail.finalRawPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Resposta bruta passo 2 · prévia truncada</summary>
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
  judge: "Julgamento (passo 1)",
  final: "Veredito final (passo 2)",
  vision: "Visão / OCR de vídeo",
  transcribe: "Transcrição de áudio",
};

function AiConfigCard({ catalog, draft, saved, saving, persisted, onChange, onSave, onReload, onRefreshCatalog, error, loading, configErrors }) {
  const [inventoryQuery, setInventoryQuery] = useState("");
  if (!catalog || !draft) return <section className="card admin-ai-state" aria-live="polite"><h2>Modelos & provedores</h2><p>{loading ? "Carregando catálogo e configuração…" : error || "Catálogo de modelos indisponível."}</p>{!loading && <button className="btn" type="button" onClick={onReload}>Tentar novamente</button>}</section>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const providers = catalog.providers ?? {};
  const query = inventoryQuery.trim().toLowerCase();
  function setStep(step, patch) { onChange({ ...draft, [step]: { ...draft[step], ...patch } }); }
  return (
    <section className="card admin-ai" aria-label="Configuração de modelos">
      <p className="admin-mut">Escolha modelos elegíveis para cada etapa. Alterações afetam somente novas checagens; a configuração chega às instâncias via atualização periódica. Não há troca automática de provedor quando um modelo falha.</p>
      {error && <p className="admin-error-state" role="alert">{error}</p>}
      {configErrors && Object.keys(configErrors).length > 0 && <div className="admin-notice" role="status"><b>Configuração persistida com pares inválidos:</b><ul>{Object.entries(configErrors).map(([step, reason]) => <li key={step}>{STEP_LABEL[step] ?? step}: {reason}</li>)}</ul><p>A checagem usa temporariamente o modelo padrão até a configuração ser corrigida.</p></div>}
      <div className="admin-ai-grid">
        {(catalog.steps ?? []).map((step) => {
          const pair = draft[step] ?? {};
          const prov = providers[pair.provider] ?? {};
          const models = prov.models ?? [];
          const eligible = models.some((m) => m.id === pair.model && (m.eligibleSteps ?? []).includes(step));
          const availableProviders = Object.entries(providers).filter(([, p]) => p.hasKey && (p.models ?? []).some((m) => (m.eligibleSteps ?? []).includes(step)));
          return (
            <div key={step} className="admin-ai-row">
              <span className="admin-ai-step">{STEP_LABEL[step] ?? step}</span>
              <label>Provedor<select value={pair.provider ?? ""} disabled={saving} onChange={(e) => {
                const next = providers[e.target.value] ?? {};
                const model = (next.models ?? []).find((m) => (m.eligibleSteps ?? []).includes(step));
                setStep(step, { provider: e.target.value, model: model?.id ?? "" });
              }}>
                {availableProviders.map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
              </select></label>
              <label>Modelo<select value={eligible ? pair.model : ""} disabled={saving || !models.length} onChange={(e) => setStep(step, { model: e.target.value })}>
                <option value="" disabled>Selecione um modelo elegível</option>
                {models.map((model) => {
                  const canUse = (model.eligibleSteps ?? []).includes(step);
                  return <option key={model.id} value={model.id} disabled={!canUse}>{model.label ?? model.id}{canUse ? "" : " — incompatível com esta etapa"}</option>;
                })}
              </select></label>
              {!eligible && <p className="admin-ai-warning">A configuração atual não está elegível no catálogo recebido.</p>}
            </div>
          );
        })}
      </div>
      <p className="admin-mut">Configuração: origem {catalog.source ?? "não informada"} · revisão {catalog.revision ?? "não informada"} · persistência {persisted ? "durável (Blob)" : "efêmera nesta instância"}{catalog.updatedAt ? ` · atualizada ${fmtFullTime(catalog.updatedAt)}` : ""} · catálogo em cache por até 15 min.</p>
      <div className="admin-ai-actions">
        <button className="btn primary" type="button" onClick={onSave} disabled={saving || !dirty}>{saving ? "Salvando…" : "Salvar modelos"}</button>
        <button className="btn ghost" type="button" onClick={onRefreshCatalog} disabled={loading}>{loading ? "Atualizando catálogo…" : "Atualizar catálogo"}</button>
        {dirty && <button className="btn ghost" type="button" onClick={onReload} disabled={saving}>Descartar alterações</button>}
      </div>
      <div className="admin-provider-inventory">
        <h2>Inventário descoberto</h2>
        <p className="admin-mut">O inventário mostra todas as opções retornadas pelos provedores. Opções sem adapter/capacidade validada aparecem, mas ficam indisponíveis para seleção.</p>
        <label className="admin-inventory-search">Filtrar inventário de modelos<input type="search" aria-label="Filtrar inventário de modelos" placeholder="Nome, ID, protocolo ou capacidade…" value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} /></label>
        {Object.entries(providers).map(([id, provider]) => {
          const models = (provider.models ?? []).filter((model) => !query || `${model.id} ${model.label ?? ""} ${model.protocol ?? ""} ${(model.capabilities ?? []).join(" ")} ${(model.eligibleSteps ?? []).join(" ")}`.toLowerCase().includes(query));
          const discovery = provider.discovery ?? {};
          return <section key={id}>
            <h3>{provider.label ?? id}</h3>
            <p>{provider.hasKey ? "Credencial disponível" : "Sem credencial configurada"} · {discovery.stale ? "inventário desatualizado" : discovery.updatedAt ? "descoberta atualizada" : "sem descoberta confirmada"}{discovery.updatedAt ? ` · ${fmtFullTime(discovery.updatedAt)}` : ""}{discovery.error ? ` · falha na descoberta: ${discovery.error}` : ""}</p>
            {!models.length ? <p>Nenhum modelo corresponde ao filtro.</p> : <ul>{models.map((model) => <li key={model.id}><b>{model.label ?? model.id}</b><code>{model.id}</code><span>{model.protocol ?? "Protocolo não informado"} · {(model.capabilities ?? []).join(", ") || "capacidades não informadas"} · Elegível: {(model.eligibleSteps ?? []).map((step) => STEP_LABEL[step] ?? step).join(", ") || "nenhuma etapa validada"}</span>{model.ineligibleReason && <small>{model.ineligibleReason}</small>}</li>)}</ul>}
          </section>;
        })}
      </div>
      {providers.opencode && <p className="admin-notice">OpenCode Go é um produto voltado principalmente a agentes de programação; verifique os requisitos do provedor antes de habilitar dados de usuários nesse serviço.</p>}
    </section>
  );
}

const ADMIN_SECTIONS = [
  { id: "overview", label: "Visão geral" },
  { id: "checks", label: "Checagens" },
  { id: "models", label: "Modelos & provedores" },
  { id: "methodology", label: "Metodologia" },
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
  const [aiLoading, setAiLoading] = useState(false);
  const [methodology, setMethodology] = useState(null);
  const [section, setSection] = useState(currentAdminSection);
  const detailRequest = useRef(0);
  const aiRequest = useRef(0);
  const loadedOnce = useRef(false);

  const authedFetch = useCallback(async (path) => {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401) {
      aiRequest.current += 1;
      sessionStorage.removeItem(SECRET_KEY);
      setSecret("");
      setItems(null);
      setAiCatalog(null);
      setAiConfig(null);
      setAiDraft(null);
      setAiConfigErrors(null);
      throw new Error("Sessão inválida. Entre de novo.");
    }
    if (!res.ok) throw new Error(`Falha ao carregar (HTTP ${res.status}).`);
    return res.json();
  }, [secret]);

  const load = useCallback(async ({ silent } = {}) => {
    if (!secret) return;
    if (loadedOnce.current) setRefreshing(true); else setLoading(true);
    setLoadError("");
    try {
      const data = await authedFetch("/api/admin");
      if (data.error === "admin_disabled") {
        setHint("Admin desabilitado no servidor (sem ADMIN_SECRET).");
        setItems([]);
        return;
      }
      setHint(data.hint ?? "");
      setItems((data.items ?? []).map((entry) => ({
        ...entry,
        verdict: migrateVerdict(entry?.factualVerdict ?? entry?.verdict, entry?.score),
      })));
      setUpdatedAt(new Date().toISOString());
      if (!silent) showToast("Lista atualizada.");
    } catch (err) {
      setLoadError(err.message || "Não foi possível carregar as checagens.");
      if (!silent) showToast(err.message);
    } finally {
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, [secret, authedFetch, showToast]);

  const loadAi = useCallback(async ({ refresh = false, preserveDraft = false } = {}) => {
    if (!secret) return;
    const request = ++aiRequest.current;
    setAiError("");
    setAiLoading(true);
    try {
      const data = await authedFetch(`/api/admin?config=1${refresh ? "&refresh=1" : ""}`);
      if (request !== aiRequest.current) return;
      setAiCatalog(data.catalog ? {
        ...data.catalog,
        source: data.source ?? data.catalog.source,
        revision: data.revision ?? data.catalog.revision,
        updatedAt: data.updatedAt ?? data.catalog.updatedAt,
      } : null);
      setAiConfig(data.config ?? null);
      if (!preserveDraft) setAiDraft(data.config ?? null);
      setAiConfigErrors(data.configErrors ?? null);
      setAiPersisted(data.persisted === true);
      if (data.methodology) setMethodology(data.methodology);
      if (!data.catalog || !data.config) setAiError("A API não retornou catálogo e configuração.");
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

  async function saveAi() {
    if (!aiDraft) return;
    setAiSaving(true);
    setAiError("");
    try {
      const res = await fetch("/api/admin?config=1", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: aiDraft }),
      });
      if (res.status === 401) {
        aiRequest.current += 1;
        sessionStorage.removeItem(SECRET_KEY);
        setSecret("");
        setItems(null);
        setAiCatalog(null);
        setAiConfig(null);
        setAiDraft(null);
        setAiConfigErrors(null);
        showToast("Sessão inválida. Entre de novo.");
        return;
      }
      const data = await res.json();
      if (!res.ok || data.error) {
        const details = Object.entries(data.fields ?? {}).map(([step, reason]) => `${STEP_LABEL[step] ?? step}: ${reason}`).join(" · ");
        setAiConfigErrors(data.fields ?? null);
        setAiError([data.message || data.error || "Não foi possível salvar a configuração.", details].filter(Boolean).join(" — "));
        showToast("Não consegui salvar a configuração de modelos.");
        return;
      }
      setAiConfigErrors(null);
      setAiConfig(data.saved ?? aiDraft);
      setAiDraft(data.saved ?? aiDraft);
      setAiPersisted(data.persisted === true);
      setAiCatalog((current) => current ? { ...current, revision: data.revision ?? current.revision, source: data.source ?? current.source } : current);
      showToast(data.persisted === false ? "Aplicado apenas nesta instância; não há persistência durável." : "Configuração de modelos atualizada.");
    } catch {
      setAiError("Falha de rede ao salvar a configuração.");
      showToast("Não consegui salvar a configuração de modelos.");
    } finally { setAiSaving(false); }
  }

  useEffect(() => {
    load({ silent: true });
    loadAi();
    const detailId = adminParam("detail");
    if (secret && detailId) openDetail(detailId);
  }, [secret, load, loadAi, openDetail]);

  useEffect(() => {
    const sync = () => {
      setSection(currentAdminSection());
      setFilter(adminParam("filter", "all"));
      setQuery(adminParam("q"));
      setSort(adminParam("sort", "newest"));
      setStatusFilter(adminParam("status", "all"));
      setKindFilter(adminParam("kind", "all"));
      setPage(Math.max(0, Number.parseInt(adminParam("page", "0"), 10) || 0));
      const detailId = adminParam("detail");
      if (detailId && secret) openDetail(detailId);
      else closeDetail();
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [secret, openDetail, closeDetail]);

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
    aiRequest.current += 1;
    detailRequest.current += 1;
    sessionStorage.removeItem(SECRET_KEY);
    setSecret("");
    setItems(null);
    setDetail(null);
    setAiCatalog(null);
    setAiConfig(null);
    setAiDraft(null);
    setAiConfigErrors(null);

  }
  const stats = useMemo(() => {
    const list = items ?? [];
    const okay = list.filter((item) => !item.error && item.outcome !== "error" && item.resultStatus !== "error");
    const times = okay.map((item) => item.totalMs).filter((time) => time != null).sort((a, b) => a - b);
    // Referência determinística: instante da última carga bem-sucedida, não o relógio do render.
    const reference = updatedAt ? new Date(updatedAt).getTime() : 0;
    return {
      total: list.length,
      errors: list.length - okay.length,
      medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      last24h: reference ? list.filter((item) => reference - new Date(item.at).getTime() < 86400000).length : 0,
    };
  }, [items, updatedAt]);
  const counts = useMemo(() => {
    const result = { all: (items ?? []).length, error: 0, "no-verdict": 0 };
    for (const item of items ?? []) {
      const isError = Boolean(item.error || item.outcome === "error" || item.resultStatus === "error");
      if (isError) result.error += 1;
      if (item.verdict == null && !isError) result["no-verdict"] += 1;
      if (item.verdict != null) result[item.verdict] = (result[item.verdict] ?? 0) + 1;
    }
    return result;
  }, [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (items ?? []).filter((item) => {
      const isError = Boolean(item.error || item.outcome === "error" || item.resultStatus === "error");
      if (filter === "error" ? !isError : filter === "no-verdict" ? item.verdict != null || isError : filter !== "all" && item.verdict !== filter) return false;
      const status = item.outcome ?? item.resultStatus ?? (isError ? "error" : "legacy");
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (kindFilter !== "all" && (item.kind ?? "legacy") !== kindFilter) return false;
      return !q || `${item.inputPreview ?? ""} ${item.id} ${item.kind}`.toLowerCase().includes(q);
    });
    const compare = {
      newest: (a, b) => String(b.at).localeCompare(String(a.at)),
      oldest: (a, b) => String(a.at).localeCompare(String(b.at)),
      slowest: (a, b) => (b.totalMs ?? -1) - (a.totalMs ?? -1),
      lowest: (a, b) => (a.score ?? 101) - (b.score ?? 101),
    }[sort];
    return list.sort(compare);
  }, [items, filter, statusFilter, kindFilter, query, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const hasFilter = query.trim() !== "" || filter !== "all" || statusFilter !== "all" || kindFilter !== "all";
  const operationalStatuses = [...new Set((items ?? []).map((item) => item.outcome ?? item.resultStatus ?? (item.error ? "error" : null)).filter(Boolean))];
  const inputKinds = [...new Set((items ?? []).map((item) => item.kind ?? "legacy"))];

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
        <button className="btn ghost" type="button" onClick={() => { load({}); loadAi({ preserveDraft: true }); }} disabled={refreshing || loading}>{refreshing || loading ? "Atualizando…" : "Atualizar dados"}</button>
        <a className="btn" href="/">Voltar ao site</a>
        <button className="btn ghost" type="button" onClick={logout}>Sair</button>
      </div>
    </header>
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Seções administrativas">
        {ADMIN_SECTIONS.map((entry) => <button key={entry.id} type="button" aria-current={section === entry.id ? "page" : undefined} onClick={() => navigateSection(entry.id)}>{entry.label}</button>)}
      </nav>
      <section className="admin-content" aria-label="Conteúdo administrativo">
        {section === "overview" && <>
          <div className="admin-section-heading"><p className="admin-eyebrow">Operação · registros retidos</p><h1>Visão geral</h1><p>Indicadores calculados somente sobre os registros disponibilizados pela API.</p></div>
          {hint && <p className="admin-notice">{hint}</p>}
          {loadError && <div className="admin-error-state" role="alert"><p>{loadError}</p><button className="btn" type="button" onClick={() => load({})}>Tentar novamente</button></div>}
          <dl className="admin-stats">
            <div><dt>Registros disponíveis</dt><dd>{loading ? "…" : stats.total}</dd></div>
            <div><dt>Últimas 24h · nesta lista</dt><dd>{loading ? "…" : stats.last24h}</dd></div>
            <div><dt>Mediana · execuções sem erro</dt><dd>{loading ? "…" : fmtMs(stats.medianMs)}</dd></div>
            <div className={stats.errors ? "bad" : ""}><dt>Execuções com erro · nesta lista</dt><dd>{loading ? "…" : stats.errors}</dd></div>
          </dl>
          <p className="admin-mut">A lista é a amostra retida entregue pela API, não um total histórico. Atualização: {updatedAt ? fmtFullTime(updatedAt) : "ainda não carregada"}.</p>
          <section className="admin-recent"><div className="admin-section-heading"><h2>Checagens recentes</h2><button className="quiet-link" type="button" onClick={() => navigateSection("checks")}>Abrir checagens</button></div>
            {items?.slice(0, 5).map((item) => <button className="admin-recent-row" type="button" key={item.id} onClick={() => openDetail(item.id)}><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome} /><span>{item.inputPreview || item.id}</span><time>{fmtTime(item.at)}</time></button>)}
            {items?.length === 0 && !loadError && <p className="admin-mut">A API não retornou registros.</p>}
          </section>
        </>}
        {section === "checks" && <section aria-labelledby="admin-checks-title">
          <div className="admin-section-heading"><p className="admin-eyebrow">Registros retidos</p><h1 id="admin-checks-title">Checagens</h1></div>
          {loadError && <div className="admin-error-state" role="alert"><p>{loadError}</p><button className="btn" type="button" onClick={() => load({})}>Tentar novamente</button></div>}
          <div className="admin-check-toolbar"><div className="search-box"><input type="search" placeholder="Buscar por texto, ID ou tipo…" aria-label="Buscar checagens" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); updateAdminUrl({ q: e.target.value, page: null }); }} /></div>
            <label className="admin-sort">Ordenar<select value={sort} onChange={(e) => { setSort(e.target.value); updateAdminUrl({ sort: e.target.value }); }}>{SORTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
            <label className="admin-sort">Estado da execução<select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); updateAdminUrl({ status: e.target.value === "all" ? null : e.target.value, page: null }); }}><option value="all">Todos</option>{operationalStatuses.map((status) => <option key={status} value={status}>{OUTCOME_LABEL[status] ?? status}</option>)}</select></label>
            <label className="admin-sort">Tipo de entrada<select value={kindFilter} onChange={(e) => { setKindFilter(e.target.value); setPage(0); updateAdminUrl({ kind: e.target.value === "all" ? null : e.target.value, page: null }); }}><option value="all">Todos</option>{inputKinds.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind] ?? kind}</option>)}</select></label>
          </div>
          <div className="filters" role="group" aria-label="Filtrar checagens">{FILTERS.map((entry) => <button key={entry.id} type="button" aria-pressed={filter === entry.id} onClick={() => { setFilter(entry.id); setPage(0); updateAdminUrl({ filter: entry.id, page: null }); }}>{VERDICTS[entry.id] && <i style={{ background: VERDICTS[entry.id].color }} />}{entry.label}<span className="count">{counts[entry.id] ?? 0}</span></button>)}</div>
          <div className="results-meta"><p>{filtered.length} {filtered.length === 1 ? "checagem" : "checagens"}{query.trim() && <> para “{query.trim()}”</>}</p>{hasFilter && <button type="button" onClick={() => { setQuery(""); setFilter("all"); setStatusFilter("all"); setKindFilter("all"); setPage(0); updateAdminUrl({ q: null, filter: null, status: null, kind: null, page: null }); }}>Limpar filtros</button>}</div>
          {loading || !items ? <ul className="admin-skel" aria-label="Carregando checagens"><li /><li /><li /></ul>
            : filtered.length === 0 ? <div className="empty"><h3>{loadError ? "Lista indisponível" : items.length === 0 ? "Nenhum registro retido" : "Nenhuma checagem encontrada"}</h3><p>{loadError || (items.length === 0 ? "A API não disponibilizou checagens." : "Ajuste a busca ou os filtros.")}</p></div>
              : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Resultado</th><th>Afirmação / entrada</th><th>Tipo</th><th>Data</th><th>Duração</th><th>Modelo</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} tabIndex="0" onClick={() => openDetail(item.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(item.id); } }}>
                <td><div className="admin-result-cell"><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome} />{item.score != null && <b>{item.score}</b>}</div>{(item.outcome || item.resultStatus || item.error) && <small className="admin-op-status">{OUTCOME_LABEL[item.outcome ?? item.resultStatus] ?? (item.error ? "Erro registrado" : item.resultStatus)}</small>}</td><td className="admin-table-preview" title={item.inputPreview || item.id}>{item.inputPreview || "(sem texto)"}<small>{item.id}</small></td><td>{KIND_LABEL[item.kind] ?? item.kind ?? "—"}</td><td><time title={fmtFullTime(item.at)}>{fmtTime(item.at)}</time></td><td>{fmtMs(item.totalMs)}</td><td>{item.model ?? item.provider ?? "—"}</td>
              </tr>)}</tbody></table>
              <ul className="admin-cards">{visible.map((item) => <li key={item.id}><button type="button" className="admin-card-row" onClick={() => openDetail(item.id)}><span className="admin-result-cell"><VerdictChip verdict={item.verdict} error={item.error} outcome={item.outcome}/>{item.score != null && <b>{item.score}</b>}</span><strong>{item.inputPreview || "(sem texto)"}</strong><span>{KIND_LABEL[item.kind] ?? item.kind ?? "—"} · {fmtTime(item.at)}</span><span>{item.outcome ? OUTCOME_LABEL[item.outcome] ?? item.outcome : "Registro legado"} · {fmtMs(item.totalMs)} · {item.model ?? item.provider ?? "Modelo não registrado"}</span><small>{item.id}</small></button></li>)}</ul></div>}
          {pages > 1 && <nav className="admin-pages" aria-label="Paginação"><button className="btn ghost" type="button" disabled={!safePage} onClick={() => { const next = safePage - 1; setPage(next); updateAdminUrl({ page: next || null }); }}>← Anterior</button><span>Página {safePage + 1} de {pages}</span><button className="btn ghost" type="button" disabled={safePage >= pages - 1} onClick={() => { const next = safePage + 1; setPage(next); updateAdminUrl({ page: next }); }}>Próxima →</button></nav>}
        </section>}
        {section === "models" && <section aria-labelledby="admin-models-title"><div className="admin-section-heading"><p className="admin-eyebrow">Configuração e compatibilidade</p><h1 id="admin-models-title">Modelos & provedores</h1><p>Defina separadamente os modelos usados em julgamento, conclusão, visão e transcrição.</p></div>
          <AiConfigCard catalog={aiCatalog} draft={aiDraft} saved={aiConfig} saving={aiSaving} loading={aiLoading} persisted={aiPersisted} error={aiError} configErrors={aiConfigErrors} onChange={setAiDraft} onSave={saveAi} onReload={() => loadAi()} onRefreshCatalog={() => loadAi({ refresh: true, preserveDraft: true })} />
        </section>}
        {section === "methodology" && <AdminMethodology methodology={methodology} />}
      </section>
    </div>
    <DetailDialog detail={detail} loading={detailLoading} onClose={closeDetail} showToast={showToast} methodology={methodology} />
  </div>;
}
