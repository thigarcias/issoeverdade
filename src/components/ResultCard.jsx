import { CLAIM_STATUS, VERDICTS } from "../data/mocks.js";
import ScoreRing from "./ScoreRing.jsx";
import { copyText } from "../lib/hooks.js";

function SourceRow({ source }) {
  const body = (
    <span>
      {source.outlet}
      <small>{source.detail}</small>
    </span>
  );
  // Mock: "#" não é link — renderiza texto estático para não pular a página.
  if (!source.url || source.url === "#") {
    return <span className="source-static">{body}</span>;
  }
  return (
    <a href={source.url} target="_blank" rel="noreferrer">
      {body}
      <span className="out" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

export default function ResultCard({ result, showToast, titleId }) {
  const verdict = VERDICTS[result.verdict];

  function share() {
    const url = `${location.origin}${location.pathname}#checagem-${result.id}`;
    copyText(
      `${result.title} — score ${result.score}/100 (${verdict.label}). ${url}`,
      showToast,
    );
  }

  return (
    <article aria-live="polite">
      <div className="result-head">
        <ScoreRing
          score={result.score}
          color={verdict.color}
          title="Escala 0–100: 0–39 falso/enganoso · 40–69 misto/sem comprovação · 70–100 verdadeiro"
        />
        <div className="result-title">
          <span className="verdict-row">
            <span className={`chip ${verdict.tint}`}>
              <i /> {verdict.label}
            </span>
            {result.live ? (
              <span className="chip tint-info" title={`Modelo: ${result.liveModel ?? "ao vivo"}`}>
                <i /> ao vivo · IA
              </span>
            ) : (
              <span className="chip" title="Demonstração local, sem IA">
                <i /> mock
              </span>
            )}
          </span>
          <h3 id={titleId} style={{ marginTop: 8 }}>
            {result.title}
          </h3>
          <p className="meta">
            <span>{result.kind}</span>
            <span>·</span>
            <span>{result.author}</span>
            <span>·</span>
            <span>checada {result.checkedAt}</span>
          </p>
        </div>
      </div>
      <p className="score-legend">
        Escala 0–100: <b>0–39</b> falso/enganoso · <b>40–69</b> misto/sem
        comprovação · <b>70–100</b> verdadeiro
      </p>

      <p className="result-summary">{result.summary}</p>

      <ol className="claims">
        {result.claims.map((claim, i) => {
          const st = CLAIM_STATUS[claim.status];
          const linked = (claim.sourceIds ?? [])
            .map((idx) => result.sources[idx])
            .filter(Boolean);
          return (
            <li key={claim.id}>
              <details className="claim" open={i === 0}>
                <summary>
                  <span className={`chip ${st.tint} claim-badge`}>
                    <i /> {st.label} · {claim.score}/100
                  </span>
                  <span className="claim-text">
                    {claim.text}
                    <small>
                      {linked.length === 0
                        ? "nenhuma fonte localizada"
                        : `${linked.length} fonte${linked.length > 1 ? "s" : ""} vinculada${linked.length > 1 ? "s" : ""}`}
                    </small>
                  </span>
                </summary>
                <div className="claim-body">
                  <p>{claim.note}</p>
                  {linked.length > 0 && (
                    <ul className="source-list claim-sources">
                      {linked.map((s) => (
                        <li key={s.outlet}>
                          <SourceRow source={s} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {result.transcript && (
        <div className="transcript">
          <span className="sec-label">{result.transcriptModel ? `Transcrição (Whisper ${result.transcriptModel} · real)` : "Transcrição (Whisper Turbo · mock)"}</span>
          <blockquote>
            {result.transcript.map((line) => (
              <span className="line" key={line.ts}>
                <span className="ts">{line.ts}</span>
                <span className={line.mark ? `mark-${line.mark}` : undefined}>
                  {line.text}
                </span>
              </span>
            ))}
          </blockquote>
        </div>
      )}

      <div className="sources">
        <span className="sec-label">
          Fontes encontradas · {result.sources.length}
        </span>
        <ul className="source-list">
          {result.sources.map((s) => (
            <li key={s.outlet}>
              <SourceRow source={s} />
            </li>
          ))}
        </ul>
      </div>

      <div className="result-actions">
        <button className="btn" onClick={share}>
          Compartilhar checagem
        </button>
        <button
          className="btn ghost"
          onClick={() => showToast("Denúncia registrada (mock). Obrigado pelo aviso.")}
        >
          Reportar erro
        </button>
      </div>
    </article>
  );
}
