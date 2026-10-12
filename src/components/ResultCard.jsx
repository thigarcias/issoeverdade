import { useEffect, useState } from "react";
import { CLAIM_STATUS, VERDICTS } from "../data/constants.js";
import ScoreRing from "./ScoreRing.jsx";
import { copyText } from "../lib/hooks.js";

function SourceRow({ source }) {
  const body = (
    <span>
      {source.outlet}
      <small>{source.detail}</small>
    </span>
  );
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

/** Anel com contagem animada de 0 até o score. */
function AnimatedScore({ score, color }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let frame = 0;
    const t0 = performance.now();
    const dur = 900;
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(eased * score));
      if (p < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [score]);
  return <ScoreRing score={shown} color={color} title={`Nota ${score} de 100`} />;
}

export default function ResultCard({ result, showToast, titleId }) {
  const verdict = VERDICTS[result.verdict];
  const origin = result.origin;
  const [imgOk, setImgOk] = useState(true);

  function share() {
    const url = `${location.origin}${location.pathname}#checagem-${result.id}`;
    copyText(
      `${result.title} — nota ${result.score}/100 (${verdict.label}). ${url}`,
      showToast,
    );
  }

  return (
    <article aria-live="polite" className="result-anim">
      {origin && (origin.thumbnail || origin.title) && (
        <a
          className="origin-card"
          href={origin.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Abrir conteúdo original: ${origin.title ?? origin.url}`}
        >
          {origin.thumbnail && imgOk ? (
            <img
              src={origin.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImgOk(false)}
            />
          ) : (
            <span className="origin-play" aria-hidden="true">▶</span>
          )}
          <span className="origin-meta">
            <b>{origin.title ?? "Conteúdo original"}</b>
            <small>
              {[origin.author, origin.platform].filter(Boolean).join(" · ")}
            </small>
          </span>
          <span className="out" aria-hidden="true">
            ↗
          </span>
        </a>
      )}

      <div className="result-head">
        <AnimatedScore score={result.score} color={verdict.color} />
        <div className="result-title">
          <span className="verdict-row">
            <span className={`chip ${verdict.tint}`}>
              <i /> {verdict.label}
            </span>
          </span>
          <h3 id={titleId} style={{ marginTop: 8 }}>
            {origin?.title ? (
              <>É {verdict.label.toLowerCase()}.</>
            ) : (
              result.title
            )}
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
            <li key={claim.id} className="claim-anim" style={{ "--i": i }}>
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
          onClick={() => showToast("Obrigado pelo aviso. Vamos revisar esta checagem.")}
        >
          Reportar erro
        </button>
      </div>
    </article>
  );
}
