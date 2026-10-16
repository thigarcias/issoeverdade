// Gera PNGs verticais 1080 × 1920 para leitura rápida, sem cortar o texto dos pontos.
// Justificativas e citações completas permanecem no resultado e no texto compartilhado.
// Zero dependências — roda 100% no browser.

import { ASSESSMENT_BASIS, CLAIM_STATUS, EVIDENCE_SUPPORT, EVIDENCE_VERIFICATION, OUTCOME_LABEL, VERDICTS, evidenceReviewLabel, evidenceVerificationLabel, isLegacyMethodology } from "../data/constants.js";

const W = 1080;
const H = 1920;
const M = 72;
const NUM_W = 64;
const TEXT_X = M + NUM_W;
const TEXT_WIDTH = W - M - TEXT_X;
const TEXT_SIZE = 30;
const TEXT_LINE = 42;
const ROW_PAD = 24;
const META_GAP = 14;
const META_H = 40;
const META_SIZE = 24;
const POINT_SCORE_SIZE = 34;
const CONT_LINE = 34;
const SECTION_H = 56;
const FOOTER_SIZE = 24;
const FOOTER_LINE = 34;
const BRAND_Y = 92;
const RULE_Y = 118;
const EYEBROW_Y = 184;
const HEADLINE_Y = 252;
const HEADLINE_SIZE = 76;
const HEADLINE_LINE = 84;
const HERO_SCORE_SIZE = 136;
const COVERAGE_SIZE = 24;
const COVERAGE_LINE = 34;
const CONT_Y = 150;
const CONT_RULE_Y = 176;
const CONT_BODY_Y = 208;
const BG = "#F2ECDC";
const INK = "#1A140C";
const FG2 = "#453F33";
const FG3 = "#5F5849";
const ACCENT = "#D9341F";
const RULE = "#1A140C26";
const SANS = "Geist, 'Helvetica Neue', Arial, sans-serif";
const SERIF = "Faustina, Georgia, 'Times New Roman', serif";
const CLAIM_ICON = { true: "✓", false: "✕", unproven: "?", context: "◐" };
const RELATION_LABEL = { supports: "Sustenta", refutes: "Contradiz", context: "Contextualiza" };
const SCOPE_LABEL = {
  whole_period: "Dados dos períodos completos",
  shorter_recorte: "Dados de um recorte mais curto",
  lower_bound: "Totais parciais usados como limite inferior",
  partial: "Dados parciais: a comparação completa não foi estabelecida",
};
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 });
const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];


function breakWord(ctx, word, maxW) {
  const parts = [];
  let part = "";
  for (const ch of word) {
    if (ctx.measureText(part + ch).width > maxW && part) {
      parts.push(part);
      part = ch;
    } else {
      part += ch;
    }
  }
  if (part) parts.push(part);
  return parts;
}

function wrap(ctx, value, maxW) {
  const lines = [];
  for (const paragraph of text(value).split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const parts = ctx.measureText(word).width > maxW ? breakWord(ctx, word, maxW) : [word];
      for (const part of parts) {
        const candidate = line ? `${line} ${part}` : part;
        if (line && ctx.measureText(candidate).width > maxW) {
          lines.push(line);
          line = part;
        } else {
          line = candidate;
        }
      }
    }
    lines.push(line);
  }
  return text(value) ? lines : [];
}

function sourceHost(source) {
  try {
    return new URL(source?.url).hostname.replace(/^www\./, "");
  } catch {
    return text(source?.outlet) || "Fonte";
  }
}

function sourceText(source, index) {
  return [`[${index + 1}] ${text(source?.outlet) || sourceHost(source)}`, text(source?.citationTitle), text(source?.detail), text(source?.url)].filter(Boolean).join(" · ");
}

function periodText(period) {
  if (!period) return "";
  if (typeof period === "string") return text(period);
  return [period.start, period.end].filter((value) => value != null && value !== "").join(" a ");
}

function comparisonDetails(comparison, assessmentBasis) {
  if (!comparison || !["complete", "lower_bound", "partial", "invalid"].includes(comparison.status)) return [];
  const details = [
    `Comparação: ${SCOPE_LABEL[comparison.scope] ?? "Limites da comparação"} · ${comparison.status}.`,
    [comparison.metric, comparison.region, comparison.dataset].filter(Boolean).join(" · "),
  ];
  for (const [index, group] of list(comparison.groups).entries()) {
    const label = text(group.label) || `Período ${index + 1}`;
    const total = group.coverage?.available > 0 && Number.isFinite(group.total) ? number.format(group.total) : "Indisponível";
    const coverage = group.coverage ? `${group.coverage.available}/${group.coverage.expected}${group.coverage.complete === false ? " · parcial" : ""}` : "Indisponível";
    details.push(`${label} (${group.startYear}–${group.endYear}): total${comparison.unit ? ` (${comparison.unit})` : ""} ${total}; anos com dados: ${coverage}.`);
    for (const row of list(group.rows)) {
      details.push(`${label} · ${row.year}: ${Number.isFinite(row.value) ? number.format(row.value) : "Indisponível"}${comparison.unit ? ` ${comparison.unit}` : ""} · cobertura ${row.complete ? "completa" : "parcial"}.`);
    }
    if (list(group.coverage?.missingYears).length) details.push(`Anos ausentes ou incompletos: ${group.coverage.missingYears.join(", ")}.`);
  }
  details.push(text(comparison.reason), assessmentBasis === "web_research"
    ? "Soma calculada a partir dos trechos informados pela pesquisa, sem conferência documental independente. A avaliação considera métrica, região e períodos."
    : "Soma calculada a partir dos trechos localizados. A revisão verifica se métrica, região e períodos permitem a conclusão.");
  return details.filter(Boolean);
}

function claimDetails(claim, sources) {
  const details = [];
  if (text(claim.note)) details.push(text(claim.note));
  if (ASSESSMENT_BASIS[claim.assessmentBasis]) details.push(`Base da avaliação: ${ASSESSMENT_BASIS[claim.assessmentBasis]}.${text(claim.assessmentNote) ? ` ${text(claim.assessmentNote)}` : ""}`);
  if (claim.evidenceSupport) details.push(`Suporte da evidência: ${EVIDENCE_SUPPORT[claim.evidenceSupport] ?? claim.evidenceSupport}.`);
  if (claim.evidenceReview) {
    const review = claim.evidenceReview;
    details.push(`${evidenceReviewLabel(claim)}${claim.assessmentBasis !== "web_research" && review.verification ? ` ${EVIDENCE_VERIFICATION[review.verification] ?? ""}.` : ""}${text(review.note) ? ` ${text(review.note)}` : ""}`);
  }
  if (periodText(claim.referencePeriod)) details.push(`Período da afirmação: ${periodText(claim.referencePeriod)}.`);
  details.push(...comparisonDetails(claim.comparison, claim.assessmentBasis));
  const sourceIds = list(claim.sourceIds);
  if (sourceIds.length) details.push(`Fontes vinculadas: ${sourceIds.map((id) => `[${id + 1}]`).join(", ")}.`);
  for (const evidence of list(claim.evidence)) {
    const source = sources[evidence.sourceId];
    const relation = RELATION_LABEL[evidence.relation] ?? "Evidência";
    const verification = evidenceVerificationLabel(claim, evidence);
    const label = [relation, Number.isInteger(evidence.sourceId) ? `[${evidence.sourceId + 1}] ${sourceHost(source)}` : "Fonte não identificada", verification].filter(Boolean).join(" · ");
    const quoteLabel = evidence.verification === "research" ? "trecho informado pela pesquisa" : "trecho original";
    details.push(`${label}${text(evidence.quote) ? ` · ${quoteLabel}: “${text(evidence.quote)}”` : " · trecho não informado"}${periodText(evidence.referencePeriod) ? ` · período: ${periodText(evidence.referencePeriod)}` : ""}`);
  }
  return details;
}

function resultLimits(result) {
  const limits = [];
  const coverage = result?.coverage;
  if (coverage) limits.push(`Cobertura: ${coverage.total} no total; ${coverage.assessed} ${isLegacyMethodology(result?.methodologyVersion) ? "avaliadas com evidência adequada" : "avaliadas com nota"}; ${coverage.unproven} sem comprovação; ${coverage.omitted} sem análise.`);
  else if (result?.omittedClaimsCount > 0 || result?.outcome === "partial_coverage") limits.push(`Cobertura parcial: ${list(result?.claims).length} afirmações analisadas; ${result?.omittedClaimsCount ?? 0} ficaram sem análise.`);
  if (result?.outcome && result.outcome !== "checked" && result.outcome !== "legacy") limits.push(`Desfecho: ${result.outcomeLabel ?? OUTCOME_LABEL[result.outcome] ?? result.outcome}.`);
  const media = result?.mediaCoverage;
  const kind = text(result?.kind);
  if (kind.startsWith("Imagem") || media?.image) {
    limits.push(`Limite da imagem: ${media?.image === "described" || media?.image === "examined" ? "OCR/descrição visual foi processado, mas não autentica autoria, data ou contexto." : "a imagem não pôde ser analisada."}`);
  }
  if (kind.startsWith("Vídeo") || list(result?.media).some((attempt) => /^(audio|frames|transcribe|vision):/.test(attempt))) {
    const audio = media?.transcript === "timestamped" ? "áudio transcrito com segmentos" : media?.transcript === "text-only" ? "áudio transcrito sem timestamps" : "áudio não transcrito";
    const count = Number(media?.sampledFrameCount) || 0;
    const visuals = count > 0 ? `${count} quadros amostrados${media?.frames === "sampled-and-described" ? " e descritos" : "; descrição visual indisponível"}` : "nenhum quadro visual analisado";
    limits.push(`Cobertura parcial da mídia: ${audio}; ${visuals}. Vídeos usam até 10 quadros dos primeiros 5 minutos; isso não representa cobertura integral nem verifica autenticidade.`);
  }
  const summary = result?.evidence?.summary;
  if (summary?.enabled && summary.citations) {
    limits.push(`Verificação de trechos: ${summary.located} de ${summary.citations} citação(ões) localizadas nos documentos obtidos${summary.missing > 0 ? `; ${summary.missing} não localizada(s) — isso não prova que a fonte esteja errada` : ""}${summary.blocked > 0 ? `; ${summary.blocked} fonte(s) recusadas pela política de rede` : ""}.`);
  } else if (summary?.enabled === false) limits.push("Verificação documental de trechos desativada.");
  for (const doc of list(result?.evidence?.documents)) {
    limits.push(`${doc.outlet ?? doc.url ?? "Documento"}: ${doc.ok ? `documento obtido (${doc.kind ?? "texto"})` : `não obtido (${doc.reason ?? "falha"})`}${doc.truncated ? " · conteúdo obtido parcialmente" : ""}${doc.url ? ` · ${doc.url}` : ""}.`);
  }
  for (const limitation of list(result?.limitations)) {
    const value = typeof limitation === "string" ? limitation : [limitation?.text, limitation?.reason].filter(Boolean).join(" — ");
    if (text(value)) limits.push(text(value));
  }
  if (typeof result?.limitations === "string" && text(result.limitations)) limits.push(text(result.limitations));
  return [...new Set(limits)];
}

/** A síntese representa o conjunto; o texto integral de cada ponto vem abaixo. */
export function shareCardContent(result) {
  const claims = list(result?.claims).filter(Boolean);
  const notCheckedClaims = list(result?.notCheckedClaims).filter(Boolean);
  const total = claims.length + notCheckedClaims.length;
  const title = total === 1 && claims.length === 1
    ? `Alegação: ${text(claims[0].text) || "Afirmação sem texto"}`
    : total > 0 ? `Checagem de ${total} ${total === 1 ? "ponto" : "pontos"}` : "Checagem sem alegação verificável";
  return { title, summary: text(result?.summary), claims, notCheckedClaims, sources: list(result?.sources), limits: resultLimits(result) };
}

function claimLabel(claim, index, methodologyVersion) {
  const status = CLAIM_STATUS[claim.status] ?? CLAIM_STATUS.unproven;
  const legacy = claim.score == null && isLegacyMethodology(methodologyVersion);
  return `${index + 1}. ${CLAIM_ICON[claim.status] ?? "?"} ${status.label.toUpperCase()} · ${claim.score == null ? (legacy ? "SEM NOTA (REGISTRO ANTERIOR)" : "SEM NOTA") : `${claim.score}/100`}`;
}

/** Nunca usa a página inicial como se fosse o link de um resultado privado. */
export function publishedCheckUrl(result, { origin = "" } = {}) {
  return result?.published === true && result?.id
    ? `${origin}/?check=${encodeURIComponent(result.id)}`
    : null;
}

export function buildShareText(result, { origin = "" } = {}) {
  const content = shareCardContent(result);
  const label = VERDICTS[result?.verdict]?.label ?? "Sem veredito";
  const legacyNull = result?.score == null && isLegacyMethodology(result?.methodologyVersion);
  const sections = [content.title, result?.score == null ? (legacyNull ? `${label} · sem nota (registro anterior)` : `${label} · nota indisponível`) : `${label} · nota ${result.score}/100`];
  if (content.summary) sections.push(content.summary);
  for (const [index, claim] of content.claims.entries()) {
    sections.push([claimLabel(claim, index, result?.methodologyVersion), text(claim.text) || "Afirmação sem texto", ...claimDetails(claim, content.sources)].join("\n"));
  }
  if (content.notCheckedClaims.length) sections.push(["PONTOS NÃO CHECADOS", ...content.notCheckedClaims.map((claim, index) => `${index + 1}. ${text(claim.text) || "Ponto sem texto"}\nMotivo: ${text(claim.reason) || "Não informado no resultado."}`)].join("\n"));
  if (content.limits.length) sections.push(["COBERTURA E LIMITES", ...content.limits].join("\n"));
  sections.push(content.sources.length ? ["FONTES CONSULTADAS (não são comprovação por si só)", ...content.sources.map(sourceText)].join("\n") : "Nenhuma fonte documental disponível no resultado.");
  sections.push(result?.score == null ? (legacyNull ? "Checagem automática · sem nota (registro anterior à metodologia com nota por afirmação)." : "Checagem automática · nota indisponível não significa falsidade.") : "Checagem automática · a nota não é probabilidade calibrada.");
  if (result?.id) sections.push(`ID ${result.id} · confira correções em ${origin}/correcoes.html?checkId=${encodeURIComponent(result.id)}`);
  const permalink = publishedCheckUrl(result, { origin });
  if (permalink) sections.push(`Confira esta checagem em ${permalink}`);
  return sections.join("\n\n");
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load(`400 36px ${SERIF}`),
      document.fonts.load(`400 ${HERO_SCORE_SIZE}px ${SERIF}`),
      document.fonts.load(`400 ${TEXT_SIZE}px ${SANS}`),
      document.fonts.load(`600 ${META_SIZE}px ${SANS}`),
    ]);
    await document.fonts.ready;
  } catch { /* fallback sans-serif */ }
}

/** @returns {Promise<Blob[]>} Todos os pontos, em um ou mais PNGs de 1080 × 1920. */
export async function renderShareCards(result) {
  await ensureFonts();
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("O navegador não oferece Canvas 2D. Copie o texto completo da checagem.");
  const claims = list(result?.claims).filter(Boolean);
  const notCheckedClaims = list(result?.notCheckedClaims).filter(Boolean);
  const verdict = VERDICTS[result?.verdict];
  const color = verdict?.color ?? FG3;
  const label = verdict?.label ?? OUTCOME_LABEL[result?.outcome] ?? "Sem veredito";
  const sources = list(result?.sources);
  const hasScore = result?.score != null;
  const kind = text(result?.kind);
  const media = result?.mediaCoverage;
  const coverage = [
    `${claims.length} ${claims.length === 1 ? "analisado" : "analisados"}`,
    notCheckedClaims.length ? `${notCheckedClaims.length} não ${notCheckedClaims.length === 1 ? "checado" : "checados"}` : "",
    result?.coverage ? `${result.coverage.assessed} ${isLegacyMethodology(result?.methodologyVersion) ? "com evidência" : "com nota"} · ${result.coverage.unproven} sem comprovação` : "",
    (result?.coverage?.omitted ?? result?.omittedClaimsCount) > 0 ? `${result?.coverage?.omitted ?? result.omittedClaimsCount} sem análise` : "",
  ].filter(Boolean).join(" · ");

  function measure(value, width, size = TEXT_SIZE, weight = 400, family = SANS) {
    ctx.font = `${weight} ${size}px ${family}`;
    return wrap(ctx, value, width);
  }
  function widthOf(value, size, weight, family) {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.letterSpacing = "0px";
    return ctx.measureText(value).width;
  }
  function paint(value, x, y, { size = TEXT_SIZE, weight = 400, family = SANS, fill = INK, align = "left", baseline = "top", spacing = 0 } = {}) {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = fill;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(value, x, y);
  }
  function paintLines(lines, x, y, style, lineHeight) {
    lines.forEach((line, index) => paint(line, x, y + index * lineHeight, style));
  }
  function rule(y, fill = RULE, height = 1) {
    ctx.fillStyle = fill;
    ctx.fillRect(M, y, W - M * 2, height);
  }

  // Cabeçalho do primeiro PNG: veredito e nota dominam; a cobertura fica discreta.
  const headlineWidth = hasScore ? W - M * 2 - 320 : W - M * 2;
  const titleLines = measure(label, headlineWidth, HEADLINE_SIZE, 400, SERIF);
  const coverageLines = measure(coverage, W - M * 2, COVERAGE_SIZE);
  const headlineEnd = HEADLINE_Y + Math.max(0, titleLines.length - 1) * HEADLINE_LINE;
  const coverageY = headlineEnd + 52;
  const coverageEnd = coverageY + Math.max(0, coverageLines.length - 1) * COVERAGE_LINE;
  const firstRuleY = coverageEnd + 40;
  const firstBodyY = firstRuleY + 36;

  // Rodapé: fontes, aviso de método, limites da mídia e identificação da checagem.
  const footerLines = [
    sources.length
      ? `${sources.length} ${sources.length === 1 ? "fonte" : "fontes"} · justificativas e citações no texto completo.`
      : "Nenhuma fonte documental disponível no resultado.",
    claims.some((claim) => claim.assessmentBasis === "web_research")
      ? "Pesquisa com fontes citadas · trechos sem conferência documental independente."
      : claims.some((claim) => claim.assessmentBasis === "document_review") ? "Base da avaliação: revisão documental." : "",
    hasScore ? "Checagem automática · a nota não é probabilidade calibrada." : "Checagem automática · nota indisponível não significa falsidade.",
  ].flatMap((value) => measure(value, W - M * 2, FOOTER_SIZE));
  if (kind.startsWith("Vídeo") || list(result?.media).some((attempt) => /^(audio|frames|transcribe|vision):/.test(attempt))) {
    footerLines.push(...measure("Vídeo: cobertura parcial de áudio/quadros; não verifica autenticidade.", W - M * 2, FOOTER_SIZE));
  } else if (kind.startsWith("Imagem") || media?.image) {
    footerLines.push(...measure(media?.image && !["described", "examined"].includes(media.image)
      ? "Imagem não analisada; autoria, data e contexto não autenticados."
      : "Imagem: análise não autentica autoria, data ou contexto.", W - M * 2, FOOTER_SIZE));
  }
  const identityLines = measure([location.host, result?.id ? `ID ${result.id}` : ""].filter(Boolean).join(" · "), W - M * 2 - 200, FOOTER_SIZE);
  const footerTop = H - M - (footerLines.length + identityLines.length) * FOOTER_LINE;
  const footerRuleY = footerTop - 24;
  const bodyBottom = footerRuleY - 20;
  const minPointHeight = ROW_PAD * 2 + TEXT_LINE + META_GAP + META_H;
  if (bodyBottom - firstBodyY < minPointHeight) {
    throw new Error("Os metadados não cabem no card. Copie o texto completo da checagem.");
  }

  // Pontos inteiros ficam juntos; só um texto maior que a página é dividido, com rótulo de continuação.
  const pages = [];
  let page = [];
  let pageTop = firstBodyY;
  let y = firstBodyY;
  function openPage() {
    page = [];
    pages.push(page);
    pageTop = pages.length === 1 ? firstBodyY : CONT_BODY_Y;
    y = pageTop;
  }
  function addSection(continued) {
    page.push({ type: "section", y, continued });
    y += SECTION_H;
  }
  function newPage(inNotChecked) {
    openPage();
    if (inNotChecked) addSection(true);
  }
  function addPoint(claim, index, notChecked) {
    const lines = measure(text(claim.text) || (notChecked ? "Ponto sem texto" : "Afirmação sem texto"), TEXT_WIDTH);
    const status = notChecked ? { label: "Não checado", color: FG3 } : (CLAIM_STATUS[claim.status] ?? CLAIM_STATUS.unproven);
    const score = !notChecked && claim.score != null ? `${claim.score}/100` : null;
    const fullHeight = ROW_PAD * 2 + lines.length * TEXT_LINE + META_GAP + META_H;
    const freshCapacity = bodyBottom - CONT_BODY_Y - (notChecked ? SECTION_H : 0);
    if (y + fullHeight > bodyBottom && fullHeight <= freshCapacity) newPage(notChecked);
    let offset = 0;
    while (offset < lines.length) {
      const continued = offset > 0;
      const head = continued ? CONT_LINE : 0;
      const remaining = lines.length - offset;
      const avail = bodyBottom - y - ROW_PAD * 2 - head;
      const finishes = remaining * TEXT_LINE + META_GAP + META_H <= avail;
      // Sem espaço para a linha de status, a última linha segue para a próxima página.
      const count = finishes ? remaining : Math.min(Math.floor(avail / TEXT_LINE), remaining - 1);
      if (count < 1) {
        if (y === pageTop) throw new Error("Os metadados não cabem no card. Copie o texto completo da checagem.");
        newPage(notChecked);
        continue;
      }
      const last = page[page.length - 1];
      page.push({
        type: "point", index, continued, finishes, status, score,
        separator: !continued && last?.type === "point",
        y, lines: lines.slice(offset, offset + count),
      });
      y += ROW_PAD * 2 + head + count * TEXT_LINE + (finishes ? META_GAP + META_H : 0);
      offset += count;
      if (!finishes) newPage(notChecked);
    }
  }

  openPage();
  claims.forEach((claim, index) => addPoint(claim, index + 1, false));
  if (notCheckedClaims.length) {
    if (bodyBottom - y < SECTION_H + minPointHeight) newPage(false);
    addSection(false);
    notCheckedClaims.forEach((claim, index) => addPoint(claim, claims.length + index + 1, true));
  }
  if (!claims.length && !notCheckedClaims.length) {
    page.push({
      type: "empty", y,
      lines: measure("Nenhuma afirmação factual foi checada neste resultado. Consulte o texto completo para o motivo e os limites.", W - M * 2),
    });
  }

  const blobs = [];
  for (const [pageIndex, commands] of pages.entries()) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const brandWidth = widthOf("isso é verdade", 36, 400, SERIF);
    paint("isso é verdade", M, BRAND_Y, { size: 36, family: SERIF, baseline: "alphabetic" });
    paint("?", M + brandWidth + 1, BRAND_Y, { size: 36, family: SERIF, fill: ACCENT, baseline: "alphabetic" });
    paint("PARECER RÁPIDO", W - M, BRAND_Y, { size: 22, weight: 600, fill: FG3, align: "right", baseline: "alphabetic", spacing: 3 });
    rule(RULE_Y, INK, 2);

    if (pageIndex === 0) {
      paint("VEREDITO", M, EYEBROW_Y, { size: 22, weight: 600, fill: FG3, baseline: "alphabetic", spacing: 3 });
      paintLines(titleLines, M, HEADLINE_Y, { size: HEADLINE_SIZE, family: SERIF, fill: color, baseline: "alphabetic" }, HEADLINE_LINE);
      if (hasScore) {
        const suffix = "/100";
        paint(suffix, W - M, HEADLINE_Y, { size: 26, fill: FG3, align: "right", baseline: "alphabetic" });
        paint(`${result.score}`, W - M - widthOf(suffix, 26, 400, SANS) - 6, HEADLINE_Y, { size: HERO_SCORE_SIZE, family: SERIF, fill: color, align: "right", baseline: "alphabetic" });
      } else {
        paint(isLegacyMethodology(result?.methodologyVersion) ? "Sem nota (registro anterior)" : "Sem nota disponível", W - M, HEADLINE_Y, { size: 28, weight: 600, fill: FG3, align: "right", baseline: "alphabetic" });
      }
      paintLines(coverageLines, M, coverageY, { size: COVERAGE_SIZE, fill: FG2, baseline: "alphabetic" }, COVERAGE_LINE);
      rule(firstRuleY);
    } else {
      paint(label, M, CONT_Y, { size: 26, weight: 600, fill: color, baseline: "alphabetic" });
      paint(hasScore ? `${result.score}/100` : (isLegacyMethodology(result?.methodologyVersion) ? "Sem nota (registro anterior)" : "Sem nota disponível"), W - M, CONT_Y, { size: 26, weight: 600, fill: FG2, align: "right", baseline: "alphabetic" });
      rule(CONT_RULE_Y);
    }

    for (const command of commands) {
      if (command.type === "section") {
        rule(command.y);
        paint(command.continued ? "PONTOS NÃO CHECADOS · CONTINUAÇÃO" : "PONTOS NÃO CHECADOS", M, command.y + 20, { size: 22, weight: 600, fill: FG3, spacing: 3 });
      } else if (command.type === "empty") {
        paintLines(command.lines, M, command.y, { size: TEXT_SIZE, fill: FG2 }, TEXT_LINE);
      } else {
        if (command.separator) rule(command.y);
        const textY = command.y + ROW_PAD + (command.continued ? CONT_LINE : 0);
        if (command.continued) paint("continuação", TEXT_X, command.y + ROW_PAD, { size: META_SIZE, weight: 600, fill: FG3 });
        else paint(String(command.index).padStart(2, "0"), M, textY + 6, { size: 24, weight: 600, fill: FG3 });
        paintLines(command.lines, TEXT_X, textY, { size: TEXT_SIZE, fill: INK }, TEXT_LINE);
        if (command.finishes) {
          const metaY = textY + command.lines.length * TEXT_LINE + META_GAP + META_H / 2;
          ctx.beginPath();
          ctx.arc(TEXT_X + 6, metaY, 6, 0, Math.PI * 2);
          ctx.fillStyle = command.status.color;
          ctx.fill();
          paint(command.status.label, TEXT_X + 22, metaY, { size: META_SIZE, weight: 600, fill: command.status.color, baseline: "middle" });
          if (command.score) paint(command.score, W - M, metaY, { size: POINT_SCORE_SIZE, family: SERIF, fill: command.status.color, align: "right", baseline: "middle" });
        }
      }
    }

    rule(footerRuleY);
    paintLines(footerLines, M, footerTop, { size: FOOTER_SIZE, fill: FG3 }, FOOTER_LINE);
    const identityY = footerTop + footerLines.length * FOOTER_LINE;
    paintLines(identityLines, M, identityY, { size: FOOTER_SIZE, fill: FG3 }, FOOTER_LINE);
    if (pages.length > 1) paint(`Página ${pageIndex + 1}/${pages.length}`, W - M, identityY, { size: FOOTER_SIZE, weight: 600, fill: FG2, align: "right" });

    blobs.push(await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("O navegador não conseguiu gerar todas as páginas PNG. Copie o texto completo da checagem.")), "image/png");
    }));
  }
  return blobs;
}
