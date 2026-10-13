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
function MediaCoverageNote({ result }) {
  const coverage = result.mediaCoverage;
  const attempts = result.media ?? [];
  const kind = result.kind ?? "";
  const isImage = kind.startsWith("Imagem") || Boolean(coverage?.image);
  const isVideo = kind.startsWith("Vídeo") || attempts.some((attempt) => /^(audio|frames|transcribe|vision):/.test(attempt));
  if (!isImage && !isVideo) return null;
  if (isImage) {
    return <div className="coverage-warning media-coverage-note" role="note"><b>Limite da imagem:</b> {coverage?.image === "described" ? "OCR/descrição visual foi processado, mas não autentica autoria, data ou contexto." : "a imagem não pôde ser analisada."}</div>;
  }
  const audio = coverage?.transcript === "timestamped"
    ? "áudio transcrito com segmentos"
    : coverage?.transcript === "text-only"
      ? "áudio transcrito sem timestamps"
      : "áudio não transcrito";
  const count = Number(coverage?.sampledFrameCount) || 0;
  const visuals = count > 0
    ? `${count} quadros amostrados${coverage?.frames === "sampled-and-described" ? " e descritos" : "; descrição visual indisponível"}`
    : "nenhum quadro visual analisado";
  return <div className="coverage-warning media-coverage-note" role="note"><b>Cobertura parcial da mídia:</b> {audio}; {visuals}. Vídeos usam até 10 quadros dos primeiros 5 minutos; isso não representa cobertura integral nem verifica autenticidade.</div>;
}
const NO_VERDICT_LABEL = {
  insufficient_input: "Material insuficiente",
  inaccessible_media: "Mídia inacessível",
  no_verifiable_claims: "Sem afirmação verificável",
};



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

export default function ResultCard({ result, showToast, titleId, onShareCard }) {
  const verdict = VERDICTS[result.verdict];
  const origin = result.origin;
  const [imgOk, setImgOk] = useState(true);

  if (!verdict || result.score == null) {
    return (
      <article aria-live="polite" className="result-anim">
        {origin?.title && <h3>{origin.title}</h3>}
        <span className="chip tint-info"><i /> {NO_VERDICT_LABEL[result.outcome] ?? "Sem veredito"}</span>
        <p className="result-summary">{result.summary}</p>
        <MediaCoverageNote result={result} />
        {result.notCheckedClaims?.length > 0 && (
          <ul>
            {result.notCheckedClaims.map((claim, index) => (
              <li key={`${claim.text}-${index}`}>{claim.text}{claim.reason ? ` — ${claim.reason}` : ""}</li>
            ))}
          </ul>
        )}
        <p className="score-legend">Nenhuma nota ou conclusão factual foi atribuída; o motivo e os limites estão descritos acima.</p>
        {result.origin?.url && <a href={result.origin.url} target="_blank" rel="noreferrer">Abrir conteúdo original ↗</a>}
      </article>
    );
  }
 

  function share() {
    copyText(
      `🔍 ${result.title} — nota ${result.score}/100 (${verdict.label.toLowerCase()}).\n\nViu algo suspeito? Confira você também em ${location.origin}${location.pathname}`,
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
        Escala 0–100: <b>0–14</b> falso · <b>15–34</b> enganoso · <b>35–54</b>{" "}
        sem comprovação · <b>55–64</b> distorcido · <b>65–74</b> parcialmente verdadeiro ·{" "}
        <b>75–89</b> maioria verdadeira · <b>90–100</b> verdadeiro
      </p>

      <p className="result-summary">{result.summary}</p>
      <MediaCoverageNote result={result} />

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
                  {claim.evidence?.length > 0 && (
                    <ul className="claim-evidence">
                      {claim.evidence.map((item, evidenceIndex) => {
                        const source = result.sources[item.sourceId];
                        if (!source || !item.quote) return null;
                        const relation = { supports: "Sustenta", refutes: "Contradiz", context: "Contextualiza" }[item.relation];
                        return (
                          <li key={`${item.sourceId}-${evidenceIndex}`}>
                            <span>{relation} · {source.outlet}</span>
                            <blockquote>“{item.quote}”</blockquote>
                          </li>
                        );
                      })}
                    </ul>
                  )}
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
      {(result.outcome === "partial_coverage" || result.omittedClaimsCount > 0) && (
        <div className="coverage-warning" role="note">
          <b>Cobertura parcial.</b> Foram analisadas {result.claims.length} afirmações;{" "}
          {result.omittedClaimsCount} ficaram sem análise.
          {result.notCheckedClaims?.length > 0 && (
            <ul>
              {result.notCheckedClaims.map((claim, index) => (
                <li key={`${claim.text}-${index}`}>{claim.text}{claim.reason ? ` — ${claim.reason}` : ""}</li>
              ))}
            </ul>
          )}
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
        <button className="btn primary" onClick={() => onShareCard?.(result)}>
          Gerar card
        </button>
        <button className="btn" onClick={share}>
          Copiar texto
        </button>
        <a className="btn ghost" href="/correcoes.html">Política de correções</a>
      </div>
    </article>
  );
}
