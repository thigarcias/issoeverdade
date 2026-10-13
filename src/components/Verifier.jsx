import { useEffect, useRef, useState } from "react";
import { PIPELINE_STEPS, THINKING_LINES, VERDICTS } from "../data/constants.js";
import { verify } from "../lib/api.js";
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

const MAX_FILE_BYTES = 3 * 1024 * 1024;

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
export default function Verifier({ showToast, onChecked, quickInput, onShareCard }) {
  const [tab, setTab] = useState("link");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [step, setStep] = useState(-1); // -1 idle, 0..n running, len done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [thinkIdx, setThinkIdx] = useState(0);
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
    setFile(null);
    setResult(null);
    setError(null);
    setStep(-1);
  }, [quickInput]);

  const running = step >= 0 && step < PIPELINE_STEPS.length;
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

  // Frases de thinking + cronômetro: rotaciona enquanto a IA trabalha.
  useEffect(() => {
    if (!running) {
      setThinkIdx(0);
      return;
    }
    const think = setInterval(() => {
      setThinkIdx((i) => (i + 1) % THINKING_LINES.length);
    }, 2600);
    const clock = setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, 500);
    return () => {
      clearInterval(think);
      clearInterval(clock);
    };
  }, [running]);

  function switchTab(next) {
    aborter.current?.abort();
    runId.current += 1;
    setTab(next);
    setFile(null);
    setResult(null);
    setError(null);
    setStep(-1);
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
    try {
      const uploadFile = file;
      const snapshot = {
        kind: tab,
        text: text.trim(),
        fileName: uploadFile?.name ?? null,
        fileMime: uploadFile?.type ?? "",
        file: uploadFile ?? undefined,
        fileFingerprint: fileFingerprint(uploadFile),
      };
      const { result: r } = await verify(
        snapshot,
        { onStep: setStep, signal: aborter.current.signal },
      );
      if (runId.current !== mine) return; // execução obsoleta
      r.elapsedMs = Date.now() - startRef.current;
      setResult(r);
      setCheckedInput({ kind: snapshot.kind, text: snapshot.text, fileName: snapshot.fileName, fileFingerprint: snapshot.fileFingerprint });
      onChecked?.(r);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError(err?.message ?? "Não consegui checar agora. Tente de novo.");
      setStep(-1);
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
    if (f.size > MAX_FILE_BYTES) {
      showToast("Arquivo acima do limite de 3 MB.");
      return;
    }
    setFile(f);
    showToast(`"${f.name}" pronto para checar.`);
  }

  function reset() {
    aborter.current?.abort();
    runId.current += 1;
    setText("");
    setFile(null);
    setResult(null);
    setError(null);
    setCheckedInput(null);
    setStep(-1);
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
                  onChange={(e) => setText(e.target.value)}
                />
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
                {(result || text || file) && !running && (
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
            (text.trim() !== checkedInput.text || tab !== checkedInput.kind || fileFingerprint(file) !== checkedInput.fileFingerprint) && (
              <p className="stale-warning" role="status">
                Você alterou o conteúdo — este resultado é da checagem anterior.{" "}
                <button type="button" className="quiet-link" onClick={handleSubmit} disabled={!canSubmit}>
                  Checar o novo conteúdo
                </button>
              </p>
            )}

          {running && !result && (
            <div className="processing-hero">
              <p className="thinking thinking-big" aria-live="polite" key={thinkIdx}>
                <span className="thinking-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
                {THINKING_LINES[thinkIdx]}
              </p>
              <div className="progress-track" aria-hidden="true">
                <i style={{ width: `${Math.round(((step + 1) / PIPELINE_STEPS.length) * 100)}%` }} />
              </div>
              <p className="eta-line">
                {formatDuration(elapsedMs)} decorridos
                {tab === "video" && <> · vídeos e arquivos enviados podem levar alguns minutos; o upload aceita até 3 MB</>}
              </p>
              <ol className="pipeline">
                {PIPELINE_STEPS.map((s, i) => (
                  <li
                    key={s.id}
                    className={`pipe-step${i < step ? " done" : ""}${i === step ? " active" : ""}`}
                    aria-current={i === step ? "step" : undefined}
                    style={{ "--i": i }}
                  >
                    <span className="pipe-dot">{i < step ? "✓" : i + 1}</span>
                    <div>
                      <h4>{s.title}</h4>
                      <p>{s.hint}</p>
                    </div>
                  </li>
                ))}
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
