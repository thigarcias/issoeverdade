import { useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, ChevronDown, Copy, Flag, Link2, Share2 } from "lucide-react";
import { ASSESSMENT_BASIS, CLAIM_STATUS, EVIDENCE_SUPPORT, VERDICTS, evidenceReviewLabel, evidenceVerificationLabel, isLegacyMethodology } from "../data/constants.js";
import ScoreRing from "./ScoreRing.jsx";
import { copyText } from "../lib/hooks.js";
import { buildShareText } from "../lib/shareCard.js";
import ComparisonDetails from "./ComparisonDetails.jsx";

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
      <ArrowUpRight className="out" size={17} aria-hidden="true" />
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
function EvidenceNote({ result }) {
  const summary = result.evidence?.summary;
  if (!summary?.enabled || !summary.citations) return null;
  const documents = Array.isArray(result.evidence?.documents) ? result.evidence.documents : [];
  return (
    <div className="coverage-warning evidence-note" role="note">
      <b>Verificação de trechos:</b> {summary.located} de {summary.citations} citação(ões) localizadas nos documentos obtidos
      {summary.missing > 0 ? `; ${summary.missing} não localizada(s) — isso não prova que a fonte esteja errada` : ""}
      {summary.blocked > 0 ? `; ${summary.blocked} fonte(s) recusadas pela política de rede` : ""}.
      {documents.length > 0 && (
        <ul>
          {documents.map((doc) => (
            <li key={doc.url}>
              {doc.outlet ?? doc.url}: {doc.ok ? `documento obtido (${doc.kind ?? "texto"})` : `não obtido (${doc.reason ?? "falha"})`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
const NO_VERDICT_LABEL = {
  insufficient_input: "Material insuficiente",
  inaccessible_media: "Mídia inacessível",
  no_verifiable_claims: "Sem afirmação verificável",
  content_refused: "Recusado por política de conteúdo",
  moderation_uncovered: "Vídeo sem cobertura de moderação",
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

export default function ResultCard({ result, showToast, titleId, onShareCard, reportSource = "result" }) {
  const verdict = VERDICTS[result.verdict];
  const origin = result.origin;
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => setImgOk(true), [origin?.thumbnail]);
  const title = result.title?.replace(/^Checagem:\s*/i, "").trim();
  const contentTitle = title && !/^https?:\/\//i.test(title)
    ? title
    : result.claims?.[0]?.text || origin?.title || "Conteúdo enviado para análise";
  const original = origin?.url && (
    <a className="origin-card" href={origin.url} target="_blank" rel="noreferrer">
      {origin.thumbnail && imgOk && (
        <img src={origin.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
      )}
      <span className="origin-meta">
        <b><Link2 size={16} aria-hidden="true" /> Ver postagem original</b>
        <small>{origin.url}</small>
        {(origin.author || origin.platform) && <small>{[origin.author, origin.platform].filter(Boolean).join(" · ")}</small>}
      </span>
      <ArrowUpRight className="out" size={18} aria-hidden="true" />
    </a>
  );
  const shareText = buildShareText(result, typeof location !== "undefined" ? location : { origin: "", pathname: "/" });
  const reportUrl = `/correcoes.html?source=${encodeURIComponent(reportSource)}${result.id ? `&checkId=${encodeURIComponent(result.id)}` : ""}`;

  if (!verdict || (result.score == null && !result.claims?.length)) {
    return (
      <article aria-live="polite" className="result-anim">
        <span className="result-eyebrow">LEITURA DA ANÁLISE</span>
        <h3 className="no-verdict-title" id={titleId}>{contentTitle}</h3>
        <span className="chip tint-info"><i /> {NO_VERDICT_LABEL[result.outcome] ?? "Sem veredito"}</span>
        {result.summary?.trim() && <p className="result-summary">{result.summary}</p>}
        <MediaCoverageNote result={result} />
        {result.notCheckedClaims?.length > 0 && (
          <ul>
            {result.notCheckedClaims.map((claim, index) => (
              <li key={`${claim.text}-${index}`}>{claim.text}{claim.reason ? ` — ${claim.reason}` : ""}</li>
            ))}
          </ul>
        )}
        <p className="score-legend">Nenhuma nota ou conclusão factual foi atribuída; o motivo e os limites estão descritos acima.</p>
        <EvidenceNote result={result} />
        {original}
        <div className="result-actions">
          <button className="btn primary" onClick={() => onShareCard?.(result)}>
            <Share2 size={16} aria-hidden="true" /> Compartilhar card
          </button>
          <button className="btn" onClick={() => copyText(shareText, showToast)}>
            <Copy size={16} aria-hidden="true" /> Copiar texto
          </button>
          <a className="btn ghost" href={reportUrl}>
            <Flag size={16} aria-hidden="true" /> Reportar problema ou contestar
          </a>
          <a className="btn ghost" href="/correcoes.html">Política de correções</a>
        </div>
        <p className="score-legend">Erro, transcrição ruim, lentidão ou download? Conte para nós — não precisa de evidência factual.</p>
      </article>
    );
  }
 

  function share() {
    copyText(shareText, showToast);
  }

  return (
    <article aria-live="polite" className="result-anim">

      <div className="result-head">
        {result.score != null ? <AnimatedScore score={result.score} color={verdict.color} /> : null}
        <div className="result-title">
          <span className="verdict-row">
            <span className={`chip ${verdict.tint}`}>
              <i /> {verdict.label}
            </span>
          </span>
          <h3 id={titleId} style={{ marginTop: 8 }}>
            {contentTitle}
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
      {original}
      <p className="score-legend">
        {result.score == null
          ? (isLegacyMethodology(result.methodologyVersion)
            ? "Sem nota (registro anterior): este resultado foi produzido sob metodologia anterior sem nota por afirmação. Falta de evidência não significa falsidade."
            : "Nota indisponível: menos da metade das afirmações pôde ser avaliada com evidência adequada. Falta de evidência não significa falsidade.")
          : "Pesquisa com fontes citadas ou revisão documental opcional: nota na faixa do status, decidida pela força da evidência — confirmação 90–100 · refutação 0–14 · sem comprovação 35–54; o servidor valida a faixa. A base de cada afirmação aparece abaixo; pesquisa não é conferência documental independente. A escala anterior é preservada nos registros históricos; a nota não é probabilidade calibrada."}
      </p>

      {result.summary?.trim() && <p className="result-summary">{result.summary}</p>}
      <MediaCoverageNote result={result} />
      <EvidenceNote result={result} />

      <h4 className="sec-label result-section-label">Afirmações analisadas <span>{result.claims.length}</span></h4>
      <ol className="claims">
        {result.claims.map((claim, i) => {
          const st = CLAIM_STATUS[claim.status] ?? CLAIM_STATUS.unproven;
          const linked = (claim.sourceIds ?? [])
            .map((idx) => result.sources[idx])
            .filter(Boolean);
          return (
            <li key={claim.id} className="claim-anim" style={{ "--i": i }}>
              <details className="claim" open={i === 0}>
                <summary>
                  <span className={`chip ${st.tint} claim-badge`}>
                    <i /> {st.label} · {claim.score == null ? "sem nota (registro anterior)" : `${claim.score}/100`}
                  </span>
                  <span className="claim-text">
                    {claim.text}
                    <small>
                      {linked.length === 0
                        ? "nenhuma fonte localizada"
                        : `${linked.length} fonte${linked.length > 1 ? "s" : ""} vinculada${linked.length > 1 ? "s" : ""}`}
                    </small>
                  </span>
                  <ChevronDown className="claim-chevron" size={17} aria-hidden="true" />
                </summary>
                <div className="claim-body">
                  <p>{claim.note}</p>
                  {ASSESSMENT_BASIS[claim.assessmentBasis] && <p className="score-legend">Base da avaliação: {ASSESSMENT_BASIS[claim.assessmentBasis]}.{claim.assessmentNote ? ` ${claim.assessmentNote}` : ""}</p>}
                  {claim.evidenceSupport && <p className="score-legend">Suporte da evidência: {EVIDENCE_SUPPORT[claim.evidenceSupport] ?? claim.evidenceSupport}.</p>}
                  {claim.evidenceReview && <p className="score-legend">{evidenceReviewLabel(claim)}</p>}
                  <ComparisonDetails comparison={claim.comparison} assessmentBasis={claim.assessmentBasis} />
                  {claim.evidence?.length > 0 && (
                    <ul className="claim-evidence">
                      {claim.evidence.map((item, evidenceIndex) => {
                        const source = result.sources[item.sourceId];
                        if (!source || !item.quote) return null;
                        const relation = { supports: "Sustenta", refutes: "Contradiz", context: "Contextualiza" }[item.relation];
                        return (
                          <li key={`${item.sourceId}-${evidenceIndex}`}>
                            <span>{relation} · {source.outlet}</span>
                            {item.verification && <span>{evidenceVerificationLabel(claim, item)}</span>}
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
      {(result.coverage || result.outcome === "partial_coverage" || result.omittedClaimsCount > 0) && (
        <div className="coverage-warning" role="note">
          {result.coverage ? (
            <><b>Cobertura das afirmações:</b> {result.coverage.total} no total; {result.coverage.assessed} avaliadas com evidência adequada; {result.coverage.unproven} sem comprovação; {result.coverage.omitted} sem análise.</>
          ) : (
            <><b>Cobertura parcial.</b> Foram analisadas {result.claims.length} afirmações; {result.omittedClaimsCount} ficaram sem análise.</>
          )}
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
          <BookOpen size={16} aria-hidden="true" /> Fontes encontradas <span>{result.sources.length}</span>
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
          <Share2 size={16} aria-hidden="true" /> Compartilhar card
        </button>
        <button className="btn" onClick={share}>
          <Copy size={16} aria-hidden="true" /> Copiar texto
        </button>
        <a className="btn ghost" href={reportUrl}>
          <Flag size={16} aria-hidden="true" /> Reportar problema ou contestar
        </a>
        <a className="btn ghost" href="/correcoes.html">Política de correções</a>
      </div>
      <p className="score-legend">Algo deu errado no resultado ou no card? Seu relato ajuda a melhorar o serviço.</p>
    </article>
  );
}
