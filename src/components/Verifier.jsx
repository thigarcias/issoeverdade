import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, CircleAlert, CircleMinus, Clock3, FileCheck, FileText, Image as ImageIcon, Link2, ListChecks, LoaderCircle, Minus, RotateCcw, Scale, SearchCheck, UploadCloud, Video, X } from "lucide-react";
import { ACTIVITY_STATE_LABEL, ACTIVITY_TEXT, VERDICTS, modalitySummary } from "../data/constants.js";
import { verify } from "../lib/api.js";
import { useServerLimits } from "../lib/hooks.js";
import ResultCard from "./ResultCard.jsx";
import "../verifier.css";

const TABS = [
  { id: "link", label: "Link", icon: Link2 },
  { id: "text", label: "Texto", icon: FileText },
  { id: "video", label: "Vídeo / áudio", icon: Video },
  { id: "image", label: "Imagem", icon: ImageIcon },
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
const ACTIVITY_ORDER = ["source-classification", "media-probe", "media-acquisition", "media-upload", "media-metadata", "media-transcription", "media-vision", "judge", "article-research", "evidence", "evidence-review", "cache"];
function activityDot(state) {
  if (state === "done") return <Check aria-hidden="true" />;
  if (state === "running") return <LoaderCircle className="verifier-spinner" aria-hidden="true" />;
  if (state === "failed") return <CircleAlert aria-hidden="true" />;
  if (state === "limited") return <CircleMinus aria-hidden="true" />;
  if (state === "skipped") return <Minus aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
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
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const startRef = useRef(0);
  const aborter = useRef(null);
  const runId = useRef(0);
  const fileInput = useRef(null);
  const pendingQuick = useRef(null);
  const resultPane = useRef(null);
  const lastPhase = useRef("idle");
  const recoveryRef = useRef(null);

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
      setElapsedMs(performance.now() - startRef.current);
    }, 500);
    return () => clearInterval(clock);
  }, [running]);

  function resetProgress() {
    setActivities(new Map());
    setContent(null);
    setRunning(false);
  }

  function clearRecovery() {
    recoveryRef.current = null;
    setRecoveryAvailable(false);
  }

  function changeText(value) {
    if (value !== text) clearRecovery();
    setText(value);
  }

  function switchTab(next) {
    if (next === tab) return;
    aborter.current?.abort();
    runId.current += 1;
    clearRecovery();
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
    startRef.current = performance.now();
    setElapsedMs(0);
    setResult(null);
    setError(null);
    setExpanded(false);
    setActivities(new Map());
    setContent(null);
    setRunning(true);
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
    const previous = recoveryRef.current;
    const unchanged = previous && previous.snapshot.kind === snapshot.kind &&
      previous.snapshot.text === snapshot.text && previous.snapshot.context === snapshot.context &&
      previous.snapshot.file === snapshot.file;
    if (!unchanged) clearRecovery();
    try {
      const { result: r } = await verify(snapshot, {
        signal: aborter.current.signal,
        recovery: unchanged ? previous.capability : null,
        onAccepted: ({ checkId, recoveryToken }) => {
          if (runId.current !== mine || !recoveryToken) return;
          recoveryRef.current = { snapshot, capability: { checkId, recoveryToken } };
          setRecoveryAvailable(true);
        },
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
      r.elapsedMs = performance.now() - startRef.current;
      clearRecovery();
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
      if (err && Object.hasOwn(err, "recovery")) {
        if (err.recovery) {
          recoveryRef.current = { snapshot, capability: err.recovery };
          setRecoveryAvailable(true);
        } else clearRecovery();
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
    clearRecovery();
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
    clearRecovery();
    setText("");
    setImageContext("");
    setFile(null);
    setResult(null);
    setError(null);
    setCheckedInput(null);
    resetProgress();
  }

  return (
    <div className="verifier-workspace">
      <div className={`verify-grid${result && !running && !expanded ? " verify-result-mode" : ""}${running && !result ? " verify-processing-mode" : ""}`}>
        <form className={`card${result && !running && !expanded ? " form-collapsed" : ""}${running && !result ? " form-hidden" : ""}`} onSubmit={handleSubmit} aria-label="Enviar conteúdo para checagem">
          <div className="hd">
            <h3>{result && !running ? "Checagem concluída" : "O que você quer checar?"}</h3>
            <span className="aside">{result && !running ? (result.score != null ? `nota ${result.score}/100` : result.verdict ? "sem nota global" : "sem veredito") : "Escolha um formato"}</span>
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
                <t.icon size={16} aria-hidden="true" />
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
                  <Link2 aria-hidden="true" />
                  <input
                    id="verify-input"
                    type="text"
                    inputMode="url"
                    placeholder={PLACEHOLDERS.link}
                    value={text}
                    onChange={(e) => changeText(e.target.value)}
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
                  onChange={(e) => changeText(e.target.value)}
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
                      <Link2 aria-hidden="true" />
                      <input
                        id="verify-input"
                        type="text"
                        inputMode="url"
                        placeholder={PLACEHOLDERS.video}
                        value={text}
                        onChange={(e) => changeText(e.target.value)}
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
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        fileInput.current?.click();
                      }
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
                        <FileCheck aria-hidden="true" />
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
                            clearRecovery();
                          }}
                        >
                          <X size={16} aria-hidden="true" />
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className="upload-icon"><UploadCloud size={26} aria-hidden="true" /></span>
                        <b>Arraste o arquivo ou clique para escolher</b>
                        <span>
                          {tab === "video" ? "MP4, MOV, WebM ou áudio compatível" : "PNG, JPEG ou WebP"} · até {formatBytes(limits.maxUploadBytes)}
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
                      onChange={(e) => {
                        if (e.target.value !== imageContext) clearRecovery();
                        setImageContext(e.target.value);
                      }}
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
                <RotateCcw size={16} aria-hidden="true" /> Checar outra coisa
              </button>
            ) : (
              <>
                <button className="btn primary big" type="submit" disabled={!canSubmit}>
                  {running ? <LoaderCircle className="verifier-spinner" size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
                  {running ? "Checando…" : "Checar agora"}
                </button>
                {running && (
                  <button className="btn ghost" type="button" onClick={reset}>
                    <X size={16} aria-hidden="true" /> Cancelar
                  </button>
                )}
                {(result || text || imageContext || file) && !running && (
                  <button className="btn ghost" type="button" onClick={reset}>
                    <RotateCcw size={16} aria-hidden="true" /> Limpar
                  </button>
                )}
              </>
            )}
          </div>
          <p className="verify-hint" style={{ marginTop: 10 }}>
            Sem cadastro. A análise reúne evidências e explicita o que não pôde ser verificado.
          </p>
        </form>

        <div className="card result-pane" aria-label="Resultado da checagem" ref={resultPane}>
          <div className="hd">
            <h3>{result ? "Resultado da análise" : running ? "Checagem em andamento" : error ? "Não foi possível concluir" : "Da dúvida ao contexto"}</h3>
            <span className="aside">{result ? (result.score == null ? (result.verdict ? "sem nota global" : "sem veredito") : `nota ${result.score}/100`) : running ? "Etapas em tempo real" : error ? "Revise e tente novamente" : "Sua leitura, com evidências"}</span>
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
              <span className="processing-symbol" aria-hidden="true"><SearchCheck size={30} /></span>
              <p className="thinking thinking-big" aria-live="polite">
                <LoaderCircle className="verifier-spinner" size={22} aria-hidden="true" />
                {modalitySummary(content, { hasUpload: Boolean(file) })}
              </p>
              <p className="eta-line">
                {formatDuration(elapsedMs)} decorridos
                {tab === "video" && <> · vídeos e arquivos enviados podem levar alguns minutos; o upload aceita até {formatBytes(limits.maxUploadBytes)}</>}
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
                  <X size={16} aria-hidden="true" /> Cancelar checagem
                </button>
              </div>
            </div>
          )}

          {!running && !result && !error && (
            <div className="result-empty">
              <span className="result-empty-icon"><SearchCheck size={30} aria-hidden="true" /></span>
              <span className="result-eyebrow">O QUE A ANÁLISE ENTREGA</span>
              <h3>Mais contexto.<br />Menos conclusões apressadas.</h3>
              <p>
                Envie texto, link ou mídia. O sistema apresenta afirmações, evidências e limitações; se faltar base suficiente, pode não atribuir veredito.
              </p>
              <ul className="result-expectations" aria-label="Elementos da análise">
                <li><ListChecks size={17} aria-hidden="true" /> Afirmações verificáveis</li>
                <li><BookOpen size={17} aria-hidden="true" /> Fontes vinculadas</li>
                <li><Scale size={17} aria-hidden="true" /> Limites da análise</li>
              </ul>
            </div>
          )}

          {error && !running && !result && (
            <div className="result-empty result-error" role="alert">
              <span className="result-empty-icon"><CircleAlert size={30} aria-hidden="true" /></span>
              <h3>{recoveryAvailable ? "Resultado ainda indisponível" : "Não consegui checar"}</h3>
              <p>{error}</p>
              <button className="btn" type="button" onClick={handleSubmit} disabled={!canSubmit}>
                <RotateCcw size={16} aria-hidden="true" />
                {recoveryAvailable ? "Recuperar resultado" : "Tentar de novo"}
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
        <p className="verify-hint" role="status" style={{ marginTop: 10 }}>
          {result.recovered && <>Resultado recuperado da análise anterior, sem nova checagem. </>}
          {result.verdict && VERDICTS[result.verdict] ? <>Veredito: <b>{VERDICTS[result.verdict].label}</b></> : "Sem veredito factual"}
          {result.score != null && <> · nota {result.score}/100</>}
          {" "}· {result.claims.length} {result.claims.length === 1 ? "afirmação" : "afirmações"} · {result.sources.length} {result.sources.length === 1 ? "fonte" : "fontes"}
          {typeof result.elapsedMs === "number" && <> · {result.recovered ? "recuperada" : "checada"} em {formatDuration(result.elapsedMs)}</>}.
        </p>
      )}
    </div>
  );
}
