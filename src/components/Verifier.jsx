import { useEffect, useRef, useState } from "react";
import { PIPELINE_STEPS, REAL_EXAMPLES, THINKING_LINES, VERDICTS } from "../data/constants.js";
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

const MAX_FILE_BYTES = 200 * 1024 * 1024;

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

export default function Verifier({ showToast, onChecked, quickInput }) {
  const [tab, setTab] = useState("link");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [step, setStep] = useState(-1); // -1 idle, 0..n running, len done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [thinkIdx, setThinkIdx] = useState(0);
  const aborter = useRef(null);
  const runId = useRef(0);
  const fileInput = useRef(null);
  const pendingQuick = useRef(null);

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

  // Frases de thinking: rotaciona enquanto a IA trabalha.
  useEffect(() => {
    if (!running) {
      setThinkIdx(0);
      return;
    }
    const t = setInterval(() => {
      setThinkIdx((i) => (i + 1) % THINKING_LINES.length);
    }, 2600);
    return () => clearInterval(t);
  }, [running]);

  function switchTab(next) {
    aborter.current?.abort();
    runId.current += 1;
    setTab(next);
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
    setResult(null);
    setError(null);
    try {
      const { result: r } = await verify(
        { kind: tab, text: text.trim(), fileName: file?.name ?? null },
        { onStep: setStep, signal: aborter.current.signal },
      );
      if (runId.current !== mine) return; // execução obsoleta
      setResult(r);
      onChecked?.(r);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError(err?.message ?? "Não consegui checar agora. Tente de novo.");
      setStep(-1);
    }
  }

  // Dispara a checagem rápida assim que aba + texto assentam.
  useEffect(() => {
    const q = pendingQuick.current;
    if (!q || text !== q.text || tab !== q.tab) return;
    pendingQuick.current = null;
    document.getElementById("verificar")?.scrollIntoView({ behavior: "smooth", block: "start" });
    handleSubmit();
  });

  function handleFiles(files) {
    const f = files?.[0];
    if (!f) return;
    const accept = tab === "video" ? /^(video|audio)\// : /^image\//;
    if (!accept.test(f.type)) {
      showToast(
        tab === "video"
          ? "Envie um vídeo ou áudio."
          : "Envie uma imagem.",
      );
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      showToast("Arquivo acima do limite de 200 MB.");
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
    setStep(-1);
  }

  function loadExample(ex) {
    aborter.current?.abort();
    runId.current += 1;
    setTab(ex.tab);
    setText(ex.text);
    setFile(null);
    setResult(null);
    setError(null);
    setStep(-1);
    showToast("Exemplo carregado. Clique em “Checar agora”.");
  }

  return (
    <div>
      <div className="verify-grid">
        <form className="card" onSubmit={handleSubmit} aria-label="Enviar conteúdo para checagem">
          <div className="hd">
            <h3>O que você quer checar?</h3>
            <span className="aside">link · texto · vídeo · foto</span>
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
                      ? "Ou suba o arquivo (a gente transcreve o áudio)"
                      : "Imagem ou print (lemos o texto dela)"}
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
                          {tab === "video" ? "MP4, MP3, MOV" : "PNG, JPG, prints de posts"} · até 200 MB
                        </span>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    aria-label="Escolher arquivo"
                    accept={tab === "video" ? "video/*,audio/*" : "image/*"}
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="verify-actions">
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
          </div>
          <p className="verify-hint" style={{ marginTop: 10 }}>
            Grátis, sem conta. Mostramos o que é verdade e de onde veio a informação.
          </p>

          <div className="examples" aria-label="Exemplos para testar">
            {REAL_EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" onClick={() => loadExample(ex)}>
                {ex.label}
              </button>
            ))}
          </div>
        </form>

        <div className="card result-pane" aria-label="Resultado da checagem">
          <div className="hd">
            <h3>{result ? "Resultado" : running ? "Analisando…" : error ? "Algo deu errado" : "Seu resultado aparece aqui"}</h3>
            <span className="aside">{result ? `nota ${result.score}/100` : running ? "a IA está trabalhando" : "leva segundos"}</span>
          </div>

          {running && !result && (
            <div>
              <p className="thinking" aria-live="polite" key={thinkIdx}>
                <span className="thinking-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
                {THINKING_LINES[thinkIdx]}
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
            </div>
          )}

          {!running && !result && !error && (
            <div className="result-empty">
              <h3>É verdade ou mentira? A gente responde.</h3>
              <p>
                Cole o conteúdo ao lado e receba uma nota de 0 a 100, com cada
                parte marcada: verdade, mentira ou sem comprovação — sempre com a fonte.
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

          {result && <ResultCard result={result} showToast={showToast} />}
        </div>
      </div>

      {result && (
        <p className="verify-hint" style={{ marginTop: 10 }}>
          Veredito: <b>{VERDICTS[result.verdict].label}</b> · nota {result.score}/100 ·{" "}
          {result.claims.length} afirmações · {result.sources.length} fontes.
        </p>
      )}
    </div>
  );
}
