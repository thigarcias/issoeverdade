import { useCallback, useEffect, useState } from "react";
import { VERDICTS } from "../data/constants.js";

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
      second: "2-digit",
    });
  } catch {
    return iso ?? "—";
  }
}

const SECRET_KEY = "iev-admin-secret";

export default function Admin({ showToast }) {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? "");
  const [input, setInput] = useState("");
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
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

  const load = useCallback(async () => {
    if (!secret) return;
    setLoading(true);
    try {
      const data = await authedFetch("/api/admin");
      if (data.error === "admin_disabled") {
        setHint("Admin desabilitado no servidor (sem ADMIN_SECRET).");
        setItems([]);
        return;
      }
      setHint(data.hint ?? "");
      setItems(data.items ?? []);
    } catch (err) {
      showToast(err.message);
    } finally {
      setLoading(false);
    }
  }, [secret, authedFetch, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDetail(id) {
    setLoading(true);
    try {
      const data = await authedFetch(`/api/admin?id=${encodeURIComponent(id)}`);
      setDetail(data.record ?? null);
    } catch (err) {
      showToast(err.message);
    } finally {
      setLoading(false);
    }
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

  const filtered = (items ?? []).filter((it) => {
    if (filter === "all") return true;
    if (filter === "error") return Boolean(it.error);
    return it.verdict === filter;
  });

  return (
    <div className="wrap admin-wrap">
      <div className="admin-bar">
        <h2>Painel admin</h2>
        <div className="admin-actions">
          <button className="btn ghost" type="button" onClick={load} disabled={loading}>
            {loading ? "Carregando…" : "Atualizar"}
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

      <div className="filters" role="group" aria-label="Filtrar checagens">
        {[
          { id: "all", label: "Todas" },
          { id: "error", label: "Com erro" },
          ...Object.keys(VERDICTS).map((v) => ({ id: v, label: VERDICTS[v].label })),
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {VERDICTS[f.id] && <i style={{ background: VERDICTS[f.id].color }} />}
            {f.label}
          </button>
        ))}
      </div>

      {!items ? (
        <p className="verify-hint" style={{ marginTop: 16 }}>Carregando…</p>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <h3>Nenhuma checagem registrada</h3>
          <p>As próximas checagens aparecem aqui com fases, tempos e tentativas.</p>
        </div>
      ) : (
        <ul className="admin-list">
          {filtered.map((it) => (
            <li key={it.id}>
              <button type="button" className="admin-row" onClick={() => openDetail(it.id)}>
                <span className={`chip ${it.error ? "tint-down" : VERDICTS[it.verdict]?.tint ?? ""}`}>
                  <i /> {it.error ? "erro" : VERDICTS[it.verdict]?.label ?? it.verdict}
                </span>
                <span className="admin-preview">{it.inputPreview || "(sem texto)"}</span>
                <span className="admin-meta">
                  {it.kind} · {it.score != null ? `${it.score}/100` : "—"} · {fmtMs(it.totalMs)} · {fmtTime(it.at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div className="card admin-detail">
          <div className="hd">
            <h3>Detalhe · {detail.id}</h3>
            <button className="icon-btn" type="button" aria-label="Fechar detalhe" onClick={() => setDetail(null)}>
              ✕
            </button>
          </div>
          <dl className="admin-dl">
            <dt>Quando</dt>
            <dd>{fmtTime(detail.at)} · total {fmtMs(detail.totalMs)}</dd>
            <dt>Entrada</dt>
            <dd>
              {detail.kind}
              {detail.fileName ? ` · ${detail.fileName}` : ""} — “{detail.inputPreview}”
            </dd>
            <dt>Modelo</dt>
            <dd>{detail.model ?? "—"}</dd>
            <dt>Veredito</dt>
            <dd>
              {detail.error ? (
                <>erro: {detail.error}</>
              ) : (
                <>{detail.verdict} · {detail.score}/100 · {detail.claimsCount} afirmações · {detail.sourcesCount} fontes</>
              )}
            </dd>
            <dt>Fases</dt>
            <dd>
              <ul className="admin-phases">
                {(detail.phases ?? []).map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <span className={`chip ${p.ok ? "tint-up" : "tint-down"}`}>
                      <i /> {p.name}
                    </span>{" "}
                    {fmtMs(p.ms)}
                    {p.error ? ` — ${p.error}` : ""}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Mídia</dt>
            <dd>
              tentativas: {(detail.mediaAttempts ?? []).join(" → ") || "—"}
              {detail.transcriptSegs > 0 && <> · transcrição: {detail.transcriptSegs} segmentos</>}
              {detail.origin?.title && <> · origem: {detail.origin.title} ({detail.origin.author})</>}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
