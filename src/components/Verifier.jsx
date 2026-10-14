import { useEffect, useRef, useState } from "react";
import { ACTIVITY_STATE_LABEL, ACTIVITY_TEXT, VERDICTS, modalitySummary } from "../data/constants.js";
import { verify } from "../lib/api.js";
import { useServerLimits } from "../lib/hooks.js";
import ResultCard from "./ResultCard.jsx";

const TABS = [
  { id: "link", label: "Link" },
  { id: "text", label: "Texto" },
  { id: "video", label: "Vídeo / áudio" },
  { id: "image", label: "Imagem" },
];

const PLACEHOLDERS = {
  link: "https://www.exemplo.com/noticia…",
  text: "Cole a notícia, o post ou a fala que você quer checar…",
  video: "https://www.instagram.com/reel/…",
};

function isValidHttpUrl(value) {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}min ${String(s % 60).padStart(2, "0")}s`;
}
function fileFingerprint(file) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : null;
}
const ACTIVITY_ORDER = ["source-classification", "media-probe", "media-acquisition", "media-upload", "media-metadata", "media-transcription", "media-vision", "judge", "article-research", "final", "evidence", "evidence-review", "cache"];
function activityDot(state) {
  if (state === "done") return "✓";
  if (state === "running") return "…";
  if (state === "failed") return "!";
  if (state === "limited") return "◐";
  if (state === "skipped") return "–";
  return "·";
}
export default function Verifier({ showToast, onChecked, quickInput, onShareCard }) {
  const limits = useServerLimits();
  const [tab, setTab] = useState("link");
  const [text, setText] = useState("");
  const [imageContext, setImageContext] = useState("");
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [running, setRunning] = useState(false);
  const [activities, setActivities] = useState(new Map());
  const [content, setContent] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [checkedInput, setCheckedInput] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(0);
  const aborter = useRef(null);
  const runId = useRef(0);
  const fileInput = useRef(null);
  const pendingQuick = useRef(null);
  const resultPane = useRef(null);
  const lastPhase = useRef("idle");

  // Checagem rápida do topo: detecta link × texto e dispara sozinha.
  useEffect(() => {
    if (!quickInput) return;
    const isUrl = isValidHttpUrl(quickInput);
    const looksVideo = /instagram\.com|youtu\.?be|tiktok\.com|reel|video/i.test(quickInput);
    pendingQuick.current = { tab: isUrl ? (looksVideo ? "video" : "link") : "text", text: quickInput };
    setTab(pendingQuick.current.tab);
    setText(quickInput);
    setImageContext("");
    setFile(null);
    setResult(null);
    setError(null);
    setActivities(new Map());
    setContent(null);
  }, [quickInput]);

  const isUpload = tab === "video" || tab === "image";
  const linkOk = text.trim().length === 0 || isValidHttpUrl(text);
  const canSubmit =
    !running &&
    (tab === "link"
      ? isValidHttpUrl(text)
      : tab === "video"
        ? Boolean(file) || isValidHttpUrl(text)
        : tab === "image"
          ? Boolean(file)
          : text.trim().length >= 4);

  // Cronômetro do tempo decorrido (sem % inventada); aria-live anuncia as
  // atividades, não cada tick do relógio.
  useEffect(() => {
    if (!running) return;
    const clock = setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, 500);
    return () => clearInterval(clock);
  }, [running]);

  function resetProgress() {
    setActivities(new Map());
    setContent(null);
    setRunning(false);
  }

  function switchTab(next) {
    if (next === tab) return;
    aborter.current?.abort();
    runId.current += 1;
    setTab(next);
    setText("");
    setImageContext("");
    setFile(null);
    setResult(null);
    setError(null);
    resetProgress();
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!canSubmit) return;
    aborter.current?.abort();
    aborter.current = new AbortController();
    const mine = ++runId.current;
    startRef.current = Date.now();
    setElapsedMs(0);
    setResult(null);
    setError(null);
    setExpanded(false);
    setActivities(new Map());
    setContent(null);
    setRunning(true);
    try {
      const uploadFile = file;
      const snapshot = {
        kind: tab,
        text: tab === "image" ? "" : text.trim(),
        context: tab === "image" ? imageContext.trim() : "",
        fileName: uploadFile?.name ?? null,
        fileMime: uploadFile?.type ?? "",
        file: uploadFile ?? undefined,
        fileFingerprint: fileFingerprint(uploadFile),
      };
      const { result: r } = await verify(snapshot, {
        signal: aborter.current.signal,
        onContent: (next) => {
          if (runId.current !== mine) return;
          setContent(next);
        },
        onActivity: (activity) => {
          if (runId.current !== mine) return;
          setActivities((prev) => {
            const next = new Map(prev);
            next.set(activity.id, activity);
            return next;
          });
        },
      });
      if (runId.current !== mine) return; // execução obsoleta
      r.elapsedMs = Date.now() - startRef.current;
      setResult(r);
      setCheckedInput({ kind: snapshot.kind, text: snapshot.text, context: snapshot.context, fileName: snapshot.fileName, fileFingerprint: snapshot.fileFingerprint });
      onChecked?.(r);
      setRunning(false);
    } catch (err) {
      if (runId.current !== mine) return;
      if (err?.name === "AbortError") {
        resetProgress();
        return;
      }
      setError(err?.message ?? "Não consegui checar agora. Tente de novo.");
      setRunning(false);
    }
  }

  // Dispara a checagem rápida assim que aba + texto assentam.
  // (Scroll acontece no effect abaixo, após o layout assentar.)
  useEffect(() => {
    const q = pendingQuick.current;
    if (!q || text !== q.text || tab !== q.tab) return;
    pendingQuick.current = null;
    handleSubmit();
  });

  // Rola para o processamento/resultado APÓS o layout mudar — só nas transições.
  // Delay de 650ms: espera o hero terminar de colapsar (transição de 500ms).
  useEffect(() => {
    const phase = result ? "done" : running ? "running" : "idle";
    if (phase === lastPhase.current || phase === "idle") return;
    lastPhase.current = phase;
    const t = setTimeout(() => {
      resultPane.current?.scrollIntoView({ behavior: "auto", block: "start" });
    }, 650);
    return () => clearTimeout(t);
  }, [running, result]);

  function handleFiles(files) {
    const f = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    const videoTypes = new Set(["video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg"]);
    const validType = tab === "video" ? videoTypes.has(f.type) : ["image/jpeg", "image/png", "image/webp"].includes(f.type);
    if (!validType) {
      showToast(tab === "video" ? "Envie MP4, MOV, WebM ou áudio compatível." : "Envie uma imagem PNG, JPEG ou WebP.");
      return;
    }
    if (f.size > limits.maxUploadBytes) {
      showToast(`Arquivo acima do limite de ${formatBytes(limits.maxUploadBytes)}.`);
      return;
    }
    setFile(f);
    showToast(`"${f.name}" pronto para checar.`);
  }

  function reset() {
    aborter.current?.abort();
    runId.current += 1;
    setText("");
    setImageContext("");
    setFile(null);
    setResult(null);
    setError(null);
    setCheckedInput(null);
    resetProgress();
  }

  return (
    <div>
      <div className={`verify-grid${result && !running && !expanded ? " verify-result-mode" : ""}${running && !result ? " verify-processing-mode" : ""}`}>
        <form className={`card${result && !running && !expanded ? " form-collapsed" : ""}${running && !result ? " form-hidden" : ""}`} onSubmit={handleSubmit} aria-label="Enviar conteúdo para checagem">
          <div className="hd">
            <h3>{result && !running ? "Checagem concluída" : "O que você quer checar?"}</h3>
            <span className="aside">{result && !running ? (result.score != null ? `nota ${result.score}/100` : "sem veredito") : "link · texto · vídeo · foto"}</span>
          </div>

          <div className="tabs" role="tablist" aria-label="Tipo de conteúdo">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`tab-${t.id}`}
                aria-controls="verify-panel"
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                type="button"
                onClick={() => switchTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const i = TABS.findIndex((x) => x.id === tab);
                  const d = e.key === "ArrowRight" ? 1 : -1;
                  const next = TABS[(i + d + TABS.length) % TABS.length];
                  switchTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="verify-panel" aria-labelledby={`tab-${tab}`}>
            {tab === "link" && (
              <div>
                <label className="field-label" htmlFor="verify-input">
                  Link da notícia, post ou vídeo
                </label>
                <div className="input-box">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
                  </svg>
                  <input
                    id="verify-input"
                    type="text"
                    inputMode="url"
                    placeholder={PLACEHOLDERS.link}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    autoComplete="off"
                    aria-invalid={!linkOk}
                    aria-describedby={linkOk ? undefined : "verify-link-error"}
                  />
                </div>
                {!linkOk && (
                  <p className="field-error" id="verify-link-error" role="alert">
                    Cole um link válido, começando com http:// ou https://
                  </p>
                )}
              </div>
            )}

            {tab === "text" && (
              <div>
                <label className="field-label" htmlFor="verify-input">
                  Texto para checar
                </label>
                <textarea
                  id="verify-input"
                  className="input-plain"
                  placeholder={PLACEHOLDERS.text}
                  value={text}
                  maxLength={limits.maxTextChars}
                  onChange={(e) => setText(e.target.value)}
                />
                {text.length > limits.maxTextChars * 0.9 && (
                  <p className="field-help" role="note">
                    {text.length}/{limits.maxTextChars} caracteres. Envie o trecho essencial; o servidor recusa texto acima do limite.
                  </p>
                )}
              </div>
            )}

            {isUpload && (
              <div className="upload-stack">
                {tab === "video" && (
                  <div>
                    <label className="field-label" htmlFor="verify-input">
                      Ou cole o link do vídeo
                    </label>
                    <div className="input-box">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
                      </svg>
                      <input
                        id="verify-input"
                        type="text"
                        inputMode="url"
                        placeholder={PLACEHOLDERS.video}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        autoComplete="off"
                        aria-invalid={!linkOk}
                      />
                    </div>
                    {!linkOk && (
                      <p className="field-error" role="alert">
                        Cole um link válido, começando com http:// ou https://
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <span className="field-label" id="file-label">
                    {tab === "video"
                      ? "Suba um vídeo ou áudio para analisar fala e, em vídeos, amostras visuais"
                      : "Suba uma imagem ou captura de tela"}
                  </span>
                  <div
                    className={`drop${drag ? " drag" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-labelledby="file-label"
                    onClick={() => fileInput.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDrag(true);
                    }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDrag(false);
                      handleFiles(e.dataTransfer.files);
                    }}
                  >
                    {file ? (
                      <span className="file-pill">
                        <span>
                          {file.name} · {formatBytes(file.size)}
                        </span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remover arquivo"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFile(null);
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <>
                        <b>Arraste o arquivo ou clique para escolher</b>
                        <span>
                          {tab === "video" ? "MP4, MOV, WebM ou áudio compatível" : "PNG, JPEG ou WebP"} · até 3 MB
                        </span>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    aria-label="Escolher arquivo"
                    accept={tab === "video" ? "video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/webm,audio/ogg" : "image/jpeg,image/png,image/webp"}
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                </div>
                {tab === "image" && (
                  <div>
                    <label className="field-label" htmlFor="verify-image-context">
                      Contexto da imagem (opcional)
                    </label>
                    <textarea
                      id="verify-image-context"
                      className="input-plain"
                      inputMode="text"
                      placeholder="Qual afirmação você quer checar? Se souber, conte onde a imagem circulou e a data alegada…"
                      value={imageContext}
                      maxLength={limits.maxTextChars}
                      onChange={(e) => setImageContext(e.target.value)}
                      aria-describedby="verify-image-context-help"
                    />
                    <p className="field-help" id="verify-image-context-help">
                      Você pode enviar só a imagem. Este texto orienta a checagem; não comprova autoria, data ou autenticidade.
                    </p>
                    {imageContext.length > limits.maxTextChars * 0.9 && (
                      <p className="field-help" role="note">
                        {imageContext.length}/{limits.maxTextChars} caracteres. Envie o contexto essencial; o servidor recusa texto acima do limite.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="verify-actions">
            {result && !running && !expanded ? (
              <button className="btn big" type="button" onClick={() => setExpanded(true)}>
                Checar outra coisa
              </button>
            ) : (
              <>
                <button className="btn primary big" type="submit" disabled={!canSubmit}>
                  {running ? "Checando…" : "Checar agora"}
                </button>
                {running && (
                  <button className="btn ghost" type="button" onClick={reset}>
                    Cancelar
                  </button>
                )}
                {(result || text || imageContext || file) && !running && (
                  <button className="btn ghost" type="button" onClick={reset}>
                    Limpar
                  </button>
                )}
              </>
            )}
          </div>
          <p className="verify-hint" style={{ marginTop: 10 }}>
            Grátis, sem conta. Mostramos o que é verdade e de onde veio a informação.
          </p>
        </form>

        <div className="card result-pane" aria-label="Resultado da checagem" ref={resultPane}>
          <div className="hd">
            <h3>{result ? "Resultado" : running ? "Analisando…" : error ? "Algo deu errado" : "Seu resultado aparece aqui"}</h3>
            <span className="aside">{result ? (result.score == null ? "sem veredito" : `nota ${result.score}/100`) : running ? "a IA está trabalhando" : "leva segundos"}</span>
          </div>
          {result && !running && expanded && checkedInput &&
            ((tab === "image" ? "" : text.trim()) !== checkedInput.text || (tab === "image" ? imageContext.trim() : "") !== checkedInput.context || tab !== checkedInput.kind || fileFingerprint(file) !== checkedInput.fileFingerprint) && (
              <p className="stale-warning" role="status">
                Você alterou o conteúdo — este resultado é da checagem anterior.{" "}
                <button type="button" className="quiet-link" onClick={handleSubmit} disabled={!canSubmit}>
                  Checar o novo conteúdo
                </button>
              </p>
            )}

          {running && !result && (
            <div className="processing-hero">
              <p className="thinking thinking-big" aria-live="polite">
                <span className="thinking-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
                {modalitySummary(content, { hasUpload: Boolean(file) })}
              </p>
              <p className="eta-line">
                {formatDuration(elapsedMs)} decorridos
                {tab === "video" && <> · vídeos e arquivos enviados podem levar alguns minutos; o upload aceita até 3 MB</>}
              </p>
              <ol className="pipeline">
                {ACTIVITY_ORDER.filter((id) => activities.has(id)).map((id, i) => {
                  const activity = activities.get(id);
                  const meta = ACTIVITY_TEXT[id] ?? { title: id, hint: "" };
                  return (
                    <li
                      key={id}
                      className={`pipe-step${activity.state === "done" || activity.state === "limited" ? " done" : ""}${activity.state === "running" || activity.state === "pending" ? " active" : ""}`}
                      aria-current={activity.state === "running" ? "step" : undefined}
                      style={{ "--i": i }}
                    >
                      <span className="pipe-dot">{activityDot(activity.state)}</span>
                      <div>
                        <h4>{meta.title}</h4>
                        <p>{activity.note ?? meta.hint} · {ACTIVITY_STATE_LABEL[activity.state] ?? activity.state}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="processing-actions">
                <button className="btn ghost" type="button" onClick={reset}>
                  Cancelar checagem
                </button>
              </div>
            </div>
          )}

          {!running && !result && !error && (
            <div className="result-empty">
              <h3>Uma checagem com limites explícitos.</h3>
              <p>
                Envie texto, link ou mídia. O sistema apresenta afirmações, evidências e limitações; se faltar base suficiente, pode não atribuir veredito.
              </p>
              <span className="chip tint-info">
                <i /> toque num exemplo abaixo do formulário para testar
              </span>
            </div>
          )}

          {error && !running && !result && (
            <div className="result-empty" role="alert">
              <h3>Não consegui checar</h3>
              <p>{error}</p>
              <button className="btn" type="button" onClick={handleSubmit} disabled={!canSubmit}>
                Tentar de novo
              </button>
            </div>
          )}

          {result && <ResultCard result={result} showToast={showToast} onShareCard={onShareCard} />}
          {!result && (
            <p className="verify-hint" style={{ marginTop: 10 }}>
              Falha no envio, erro ou demora na checagem?{" "}
              <a className="quiet-link" href="/correcoes.html?source=app">Reportar problema</a>
            </p>
          )}
        </div>
      </div>

      {result && (
        <p className="verify-hint" style={{ marginTop: 10 }}>
          {result.verdict && VERDICTS[result.verdict] ? <>Veredito: <b>{VERDICTS[result.verdict].label}</b></> : "Sem veredito factual"}
          {result.score != null && <> · nota {result.score}/100</>}
          {" "}· {result.claims.length} {result.claims.length === 1 ? "afirmação" : "afirmações"} · {result.sources.length} {result.sources.length === 1 ? "fonte" : "fontes"}
          {typeof result.elapsedMs === "number" && <> · checada em {formatDuration(result.elapsedMs)}</>}.
        </p>
      )}
    </div>
  );
}
