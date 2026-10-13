import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLAIM_STATUS, VERDICTS } from "../data/constants.js";

const SECRET_KEY = "iev-admin-secret";
const PAGE_SIZE = 15;

const KIND_LABEL = { link: "Link", text: "Texto", image: "Imagem", video: "Vídeo" };

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

function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

function VerdictChip({ verdict, error }) {
  if (error) {
    return (
      <span className="chip tint-down">
        <i /> erro
      </span>
    );
  }
  const v = VERDICTS[verdict];
  return (
    <span className={`chip ${v?.tint ?? ""}`}>
      <i /> {v?.label ?? verdict}
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
  const total = totalMs > 0 ? totalMs : rows.reduce((a, p) => a + (p.ms ?? 0), 0);
  return (
    <ol className="admin-timeline">
      {rows.map((p, i) => {
        const pct = total > 0 ? Math.max(3, Math.round(((p.ms ?? 0) / total) * 100)) : 3;
        return (
          <li key={`${p.name}-${i}`} className={p.ok ? "ok" : "fail"}>
            <span className="admin-tl-name">{p.name}</span>
            <span className="admin-tl-track">
              <span className="admin-tl-bar" style={{ width: `${pct}%` }} />
            </span>
            <span className="admin-tl-ms">{fmtMs(p.ms)}</span>
            {p.error && <span className="admin-tl-err">{p.error}</span>}
          </li>
        );
      })}
    </ol>
  );
}

const DETAIL_TABS = [
  { id: "overview", label: "Resumo" },
  { id: "claims", label: "Afirmações" },
  { id: "sources", label: "Fontes" },
  { id: "media", label: "Mídia" },
  { id: "prompts", label: "Prompts & IA" },
];

function DetailDialog({ detail, loading, onClose, showToast }) {
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
          detail.origin?.title
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
              <VerdictChip verdict={detail.verdict} error={detail.error} />
              {detail.score != null && <b className="admin-detail-score">{detail.score}/100</b>}
              <span className="admin-mut">
                {KIND_LABEL[detail.kind] ?? detail.kind} · {fmtFullTime(detail.at)} · total {fmtMs(detail.totalMs)}
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
                  <dt>Modelo</dt>
                  <dd>{detail.model ?? "—"}</dd>
                  <dt>Resumo</dt>
                  <dd>{detail.summary || "—"}</dd>
                  {detail.cachedFrom && (
                    <>
                      <dt>Cache</dt>
                      <dd className="admin-mut">reutilizou o resultado de {detail.cachedFrom}</dd>
                    </>
                  )}
                  {detail.corrections?.length > 0 && (
                    <>
                      <dt>Correções</dt>
                      <dd>{detail.corrections.join(" · ")}</dd>
                    </>
                  )}
                </dl>
                <h4 className="admin-sub">Linha do tempo das fases</h4>
                <PhaseTimeline phases={detail.phases} totalMs={detail.totalMs} />
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

            {tab === "prompts" && (
              <div className="admin-prompts">
                {detail.judgePromptPreview && (
                  <details className="admin-sec">
                    <summary>Prompt passo 1 (judge)</summary>
                    <pre className="admin-pre">{detail.judgePromptPreview}</pre>
                  </details>
                )}
                {detail.judgeRawPreview && (
                  <details className="admin-sec">
                    <summary>Resposta bruta passo 1</summary>
                    <pre className="admin-pre">{detail.judgeRawPreview}</pre>
                  </details>
                )}
                {detail.finalPromptPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Prompt passo 2 (final)</summary>
                    <pre className="admin-pre">{detail.finalPromptPreview}</pre>
                  </details>
                )}
                {detail.finalRawPreview && !detail.error && (
                  <details className="admin-sec">
                    <summary>Resposta bruta passo 2</summary>
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
  ...Object.keys(VERDICTS).map((v) => ({ id: v, label: VERDICTS[v].label })),
];

const SORTS = [
  { id: "newest", label: "Mais recentes" },
  { id: "oldest", label: "Mais antigas" },
  { id: "slowest", label: "Mais lentas" },
  { id: "lowest", label: "Menor score" },
];

export default function Admin({ showToast }) {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? "");
  const [input, setInput] = useState("");
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hint, setHint] = useState("");

  const authedFetch = useCallback(
    async (path) => {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } });
      if (res.status === 401) {
        sessionStorage.removeItem(SECRET_KEY);
        setSecret("");
        setItems(null);
        throw new Error("Sessão inválida. Entre de novo.");
      }
      return res.json();
    },
    [secret],
  );

  const load = useCallback(
    async ({ silent } = {}) => {
      if (!secret) return;
      if (items) setRefreshing(true);
      else setLoading(true);
      try {
        const data = await authedFetch("/api/admin");
        if (data.error === "admin_disabled") {
          setHint("Admin desabilitado no servidor (sem ADMIN_SECRET).");
          setItems([]);
          return;
        }
        setHint(data.hint ?? "");
        setItems(data.items ?? []);
        setPage(0);
        if (!silent) showToast("Lista atualizada.");
      } catch (err) {
        showToast(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [secret, authedFetch, items, showToast],
  );

  useEffect(() => {
    load({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret]);

  async function openDetail(id) {
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await authedFetch(`/api/admin?id=${encodeURIComponent(id)}`);
      setDetail(data.record ?? null);
    } catch (err) {
      showToast(err.message);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
    setDetailLoading(false);
  }

  function login(e) {
    e.preventDefault();
    if (!input.trim()) return;
    sessionStorage.setItem(SECRET_KEY, input.trim());
    setSecret(input.trim());
    setInput("");
  }

  function logout() {
    sessionStorage.removeItem(SECRET_KEY);
    setSecret("");
    setItems(null);
    setDetail(null);
  }

  const counts = useMemo(() => {
    const c = { all: (items ?? []).length, error: 0 };
    for (const it of items ?? []) {
      if (it.error) c.error += 1;
      c[it.verdict] = (c[it.verdict] ?? 0) + 1;
    }
    return c;
  }, [items]);

  const stats = useMemo(() => {
    const list = items ?? [];
    const ok = list.filter((it) => !it.error);
    const times = ok.map((it) => it.totalMs).filter((t) => t != null).sort((a, b) => a - b);
    const median = times.length > 0 ? times[Math.floor(times.length / 2)] : null;
    const last24h = list.filter((it) => Date.now() - new Date(it.at).getTime() < 24 * 3600_000).length;
    return {
      total: list.length,
      errors: list.length - ok.length,
      medianMs: median,
      last24h,
    };
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (items ?? []).filter((it) => {
      if (filter === "error") {
        if (!it.error) return false;
      } else if (filter !== "all" && it.verdict !== filter) {
        return false;
      }
      if (q && !`${it.inputPreview ?? ""} ${it.id} ${it.kind}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const by = {
      newest: (a, b) => String(b.at).localeCompare(String(a.at)),
      oldest: (a, b) => String(a.at).localeCompare(String(b.at)),
      slowest: (a, b) => (b.totalMs ?? -1) - (a.totalMs ?? -1),
      lowest: (a, b) => (a.score ?? 101) - (b.score ?? 101),
    }[sort];
    return [...list].sort(by);
  }, [items, filter, query, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const hasFilter = query.trim() !== "" || filter !== "all";

  if (!secret) {
    return (
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
        <div className="card">
          <div className="hd">
            <h3>Painel admin</h3>
            <span className="aside">restrito</span>
          </div>
          <form onSubmit={login}>
            <label className="field-label" htmlFor="admin-secret">
              Chave de acesso
            </label>
            <div className="input-box">
              <input
                id="admin-secret"
                type="password"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="ADMIN_SECRET"
                autoComplete="off"
              />
            </div>
            <div className="verify-actions">
              <button className="btn primary" type="submit" disabled={!input.trim()}>
                Entrar
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap admin-wrap">
      <div className="admin-bar">
        <h2>Painel admin</h2>
        <div className="admin-actions">
          <button className="btn ghost" type="button" onClick={() => load({})} disabled={refreshing || loading}>
            {refreshing || loading ? "Atualizando…" : "Atualizar"}
          </button>
          <button className="btn ghost" type="button" onClick={logout}>
            Sair
          </button>
          <a className="btn" href="#topo">
            Voltar ao site
          </a>
        </div>
      </div>
      {hint && <p className="verify-hint">{hint}</p>}

      <dl className="admin-stats">
        <div>
          <dt>Checagens</dt>
          <dd>{loading ? "…" : stats.total}</dd>
        </div>
        <div>
          <dt>Últimas 24h</dt>
          <dd>{loading ? "…" : stats.last24h}</dd>
        </div>
        <div>
          <dt>Tempo mediano</dt>
          <dd>{loading ? "…" : fmtMs(stats.medianMs)}</dd>
        </div>
        <div className={stats.errors > 0 ? "bad" : ""}>
          <dt>Com erro</dt>
          <dd>{loading ? "…" : stats.errors}</dd>
        </div>
      </dl>

      <div className="search-panel">
        <div className="search-box">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            placeholder="Buscar por texto, ID ou tipo…"
            aria-label="Buscar checagens"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <label className="admin-sort">
          Ordenar
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filters" role="group" aria-label="Filtrar checagens">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setPage(0);
            }}
          >
            {VERDICTS[f.id] && <i style={{ background: VERDICTS[f.id].color }} />}
            {f.label}
            <span className="count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="results-meta">
        <p>
          {filtered.length} {filtered.length === 1 ? "checagem" : "checagens"}
          {query.trim() && <> para “{query.trim()}”</>}
        </p>
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setFilter("all");
              setPage(0);
            }}
          >
            Limpar busca
          </button>
        )}
      </div>

      {loading || !items ? (
        <ul className="admin-skel" aria-label="Carregando checagens">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} />
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <h3>Nenhuma checagem encontrada</h3>
          <p>Ajuste a busca ou os filtros — ou aguarde as próximas checagens.</p>
        </div>
      ) : (
        <>
          <ul className="admin-list">
            {visible.map((it) => (
              <li key={it.id}>
                <button type="button" className="admin-row" onClick={() => openDetail(it.id)}>
                  <span className="admin-row-top">
                    <VerdictChip verdict={it.verdict} error={it.error} />
                    {it.score != null && <b className="admin-score">{it.score}</b>}
                    <span className="admin-kind">{KIND_LABEL[it.kind] ?? it.kind}</span>
                    <time className="admin-time" title={fmtFullTime(it.at)}>
                      {fmtTime(it.at)} · {relTime(it.at)}
                    </time>
                  </span>
                  <span className="admin-preview">{it.inputPreview || "(sem texto)"}</span>
                  <span className="admin-meta">
                    {it.id} · {it.totalMs != null ? fmtMs(it.totalMs) : "—"}
                    {it.model ? ` · ${it.model}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="admin-pages" aria-label="Paginação">
              <button
                type="button"
                className="btn ghost"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                ← Anterior
              </button>
              <span>
                Página {safePage + 1} de {pages}
              </span>
              <button
                type="button"
                className="btn ghost"
                disabled={safePage >= pages - 1}
                onClick={() => setPage(safePage + 1)}
              >
                Próxima →
              </button>
            </nav>
          )}
        </>
      )}

      <DetailDialog detail={detail} loading={detailLoading} onClose={closeDetail} showToast={showToast} />
    </div>
  );
}
