// Gera um único PNG de 1080 px de largura e altura medida via Canvas 2D.
// Preserva a identidade do site e todo o conteúdo; nunca corta pontos para caber.
// Zero dependências — roda 100% no browser.

import { CLAIM_STATUS, EVIDENCE_SUPPORT, EVIDENCE_VERIFICATION, OUTCOME_LABEL, VERDICTS } from "../data/constants.js";

const W = 1080;
const MIN_H = 1350;
// Evita dimensões inválidas e alocações excessivas. Acima disso, falha explicitamente,
// mantendo o texto completo disponível no diálogo em vez de produzir um PNG parcial.
const MAX_DIMENSION = 32767;
const MAX_PIXELS = 32 * 1024 * 1024;
const BG = "#F2ECDC";
const PANEL = "#FBF7EB";
const INK = "#1A140C";
const ACCENT = "#D9341F";
const FG2 = "#453F33";
const FG3 = "#5F5849";
const LINE = "#1A140C2E";
const SERIF = "Faustina, Georgia, serif";
const SANS = "Geist, 'Helvetica Neue', Arial, sans-serif";
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

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

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

function comparisonDetails(comparison) {
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
  details.push(text(comparison.reason), "Soma calculada a partir dos trechos localizados. A revisão verifica se métrica, região e períodos permitem a conclusão.");
  return details.filter(Boolean);
}

function claimDetails(claim, sources) {
  const details = [];
  if (text(claim.note)) details.push(text(claim.note));
  if (claim.evidenceSupport) details.push(`Suporte da evidência: ${EVIDENCE_SUPPORT[claim.evidenceSupport] ?? claim.evidenceSupport}.`);
  if (claim.evidenceReview) {
    const review = claim.evidenceReview;
    details.push(`Revisão do conjunto: ${EVIDENCE_SUPPORT[review.verdict] ?? "Inconclusiva"}${review.verification ? ` · ${EVIDENCE_VERIFICATION[review.verification] ?? review.verification}` : ""}${review.incomplete ? " · cobertura incompleta" : ""}.${text(review.note) ? ` ${text(review.note)}` : ""}`);
  }
  if (periodText(claim.referencePeriod)) details.push(`Período da afirmação: ${periodText(claim.referencePeriod)}.`);
  details.push(...comparisonDetails(claim.comparison));
  const sourceIds = list(claim.sourceIds);
  if (sourceIds.length) details.push(`Fontes vinculadas: ${sourceIds.map((id) => `[${id + 1}]`).join(", ")}.`);
  for (const evidence of list(claim.evidence)) {
    const source = sources[evidence.sourceId];
    const relation = RELATION_LABEL[evidence.relation] ?? "Evidência";
    const verification = claim.evidenceReview && evidence.verification === "verified"
      ? "Trecho do conjunto revisado"
      : EVIDENCE_VERIFICATION[evidence.verification] ?? text(evidence.verification);
    const label = [relation, Number.isInteger(evidence.sourceId) ? `[${evidence.sourceId + 1}] ${sourceHost(source)}` : "Fonte não identificada", verification].filter(Boolean).join(" · ");
    details.push(`${label}${text(evidence.quote) ? ` · trecho original: “${text(evidence.quote)}”` : " · trecho não informado"}${periodText(evidence.referencePeriod) ? ` · período: ${periodText(evidence.referencePeriod)}` : ""}`);
  }
  return details;
}

function resultLimits(result) {
  const limits = [];
  const coverage = result?.coverage;
  if (coverage) limits.push(`Cobertura: ${coverage.total} no total; ${coverage.assessed} avaliadas com evidência adequada; ${coverage.unproven} sem comprovação; ${coverage.omitted} sem análise.`);
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

function claimLabel(claim, index) {
  const status = CLAIM_STATUS[claim.status] ?? CLAIM_STATUS.unproven;
  return `${index + 1}. ${CLAIM_ICON[claim.status] ?? "?"} ${status.label.toUpperCase()} · ${claim.score == null ? "SEM NOTA" : `${claim.score}/100`}`;
}

export function buildShareText(result, { origin, pathname = "/" }) {
  const content = shareCardContent(result);
  const label = VERDICTS[result?.verdict]?.label ?? "Sem veredito";
  const sections = [content.title, result?.score == null ? `${label} · nota indisponível` : `${label} · nota ${result.score}/100`];
  if (content.summary) sections.push(content.summary);
  for (const [index, claim] of content.claims.entries()) {
    sections.push([claimLabel(claim, index), text(claim.text) || "Afirmação sem texto", ...claimDetails(claim, content.sources)].join("\n"));
  }
  if (content.notCheckedClaims.length) sections.push(["PONTOS NÃO CHECADOS", ...content.notCheckedClaims.map((claim, index) => `${index + 1}. ${text(claim.text) || "Ponto sem texto"}\nMotivo: ${text(claim.reason) || "Não informado no resultado."}`)].join("\n"));
  if (content.limits.length) sections.push(["COBERTURA E LIMITES", ...content.limits].join("\n"));
  sections.push(content.sources.length ? ["FONTES CONSULTADAS (não são comprovação por si só)", ...content.sources.map(sourceText)].join("\n") : "Nenhuma fonte documental disponível no resultado.");
  sections.push(result?.score == null ? "Checagem automática · nota indisponível não significa falsidade." : "Checagem automática · a nota não é probabilidade calibrada.");
  if (result?.id) sections.push(`ID ${result.id} · confira correções em ${origin}/correcoes.html?checkId=${encodeURIComponent(result.id)}`);
  sections.push(`Confira você também em ${origin}${pathname}`);
  return sections.join("\n\n");
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load('600 100px Faustina'),
      document.fonts.load('400 42px Faustina'),
      document.fonts.load('600 30px Geist'),
      document.fonts.load('400 30px Geist'),
      document.fonts.load('400 25px Geist'),
    ]);
    await document.fonts.ready;
  } catch { /* fallback serif/sans */ }
}

function grain(ctx, height) {
  ctx.save();
  ctx.globalAlpha = 0.05;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  ctx.fillStyle = INK;
  for (let i = 0; i < Math.ceil(2600 * height / MIN_H); i++) ctx.fillRect(rand() * W, rand() * height, 2, 2);
  ctx.restore();
}

function hardShadow(ctx, x, y, w, h, r) {
  ctx.save();
  ctx.fillStyle = "#1A140C2E";
  rr(ctx, x + 10, y + 10, w, h, r);
  ctx.fill();
  ctx.restore();
}

/** @returns {Promise<Blob>} PNG completo ou erro explícito, nunca imagem parcial. */
export async function renderShareCard(result) {
  await ensureFonts();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("O navegador não oferece Canvas 2D. Copie o texto completo da checagem.");
  const content = shareCardContent(result);
  const verdict = VERDICTS[result?.verdict];
  const color = verdict?.color ?? FG3;
  const commands = [];
  let y = result?.score == null ? 460 : 500;

  // Primeiro mede e posiciona todas as linhas, inclusive fontes/limites/rodapé.
  // O desenho usa exatamente o mesmo plano, sem outro ajuste ou corte.
  function paragraph(value, { size = 25, lineHeight = 34, weight = 400, family = SANS, color: fill = FG2, x = 110, width = W - 220, align = "left", gap = 10 } = {}) {
    const font = `${weight} ${size}px ${family}`;
    ctx.font = font;
    const lines = wrap(ctx, value, width);
    if (!lines.length) return;
    commands.push({ type: "text", lines, font, color: fill, x: align === "center" ? W / 2 : x, y, lineHeight, align });
    y += lines.length * lineHeight + gap;
  }
  function section(label) {
    y += 12;
    commands.push({ type: "line", y });
    y += 24;
    paragraph(label, { size: 22, lineHeight: 30, weight: 600, color: FG3, gap: 18 });
  }

  paragraph(content.title, { size: 42, lineHeight: 54, family: SERIF, color: INK, x: 130, width: W - 260, align: "center", gap: 16 });
  paragraph(content.summary, { size: 26, lineHeight: 36, x: 130, width: W - 260, align: "center", gap: 0 });
  const cardBottom = y + 30;
  y = cardBottom + 42;
  if (content.claims.length) {
    section(`AFIRMAÇÕES ANALISADAS · ${content.claims.length}`);
    for (const [index, claim] of content.claims.entries()) {
      paragraph(claimLabel(claim, index), { size: 26, lineHeight: 36, weight: 600, color: CLAIM_STATUS[claim.status]?.color ?? CLAIM_STATUS.unproven.color });
      paragraph(text(claim.text) || "Afirmação sem texto", { size: 30, lineHeight: 40 });
      for (const detail of claimDetails(claim, content.sources)) paragraph(detail);
      y += 18;
    }
  }
  if (content.notCheckedClaims.length) {
    section(`PONTOS NÃO CHECADOS · ${content.notCheckedClaims.length}`);
    for (const [index, claim] of content.notCheckedClaims.entries()) {
      paragraph(`${index + 1}. ${text(claim.text) || "Ponto sem texto"}`, { size: 30, lineHeight: 40 });
      paragraph(`Motivo: ${text(claim.reason) || "Não informado no resultado."}`, { color: FG3 });
      y += 18;
    }
  }
  if (content.limits.length) {
    section("COBERTURA E LIMITES");
    for (const limit of content.limits) paragraph(limit);
  }
  section(`FONTES CONSULTADAS · ${content.sources.length}`);
  paragraph("Fontes encontradas não são comprovação por si só; confira a relação e os limites de cada trecho.", { color: FG3 });
  if (content.sources.length) {
    for (const [index, source] of content.sources.entries()) paragraph(sourceText(source, index));
  } else paragraph("Nenhuma fonte documental disponível no resultado.");

  y += 30;
  const footerStart = y;
  const host = location.host;
  paragraph([result?.kind, result?.publishedAt ? `checada em ${result.publishedAt}` : ""].filter(Boolean).join(" · "), { size: 22, lineHeight: 30, color: FG3, align: "center" });
  paragraph(result?.score == null ? "Checagem automática · nota indisponível não significa falsidade" : "Checagem automática · a nota não é probabilidade calibrada", { size: 22, lineHeight: 30, align: "center" });
  if (result?.id) paragraph(`ID ${result.id} · confira correções em ${host}/correcoes.html?checkId=${encodeURIComponent(result.id)}`, { size: 22, lineHeight: 30, color: FG3, align: "center" });
  paragraph("Viu algo suspeito? Confira você também em", { size: 26, lineHeight: 36, align: "center" });
  paragraph(host, { size: 40, lineHeight: 50, weight: 600, color: ACCENT, align: "center", gap: 0 });
  const height = Math.max(MIN_H, Math.ceil(y + 52));
  if (!Number.isSafeInteger(height) || height > MAX_DIMENSION || W * height > MAX_PIXELS) {
    throw new Error("O resultado completo excede o tamanho de PNG suportado. Copie o texto completo da checagem; nenhum ponto foi cortado.");
  }
  // O mínimo de altura mantém a composição dos cards curtos sem esticar conteúdo.
  const footerShift = height - Math.ceil(y + 52);
  for (const command of commands) if (command.y >= footerStart) command.y += footerShift;
  canvas.width = W;
  canvas.height = height;
  if (canvas.width !== W || canvas.height !== height) throw new Error("O navegador não suporta o tamanho do card completo. Copie o texto completo da checagem.");

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, height);
  grain(ctx, height);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, 150);
  ctx.fillStyle = "#0D0A06";
  ctx.fillRect(0, 146, W, 4);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.fillStyle = BG;
  ctx.font = `400 52px ${SERIF}`;
  const brandW = ctx.measureText("isso é verdade?").width;
  ctx.fillText("isso é verdade", W / 2 - 14, 88);
  ctx.fillStyle = ACCENT;
  ctx.fillText("?", W / 2 + brandW / 2 - 14, 88);
  ctx.fillStyle = "#B9B09A";
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText("ELEIÇÕES 2026  ·  SEGUNDO TURNO", W / 2, 126);

  hardShadow(ctx, 70, 200, W - 140, cardBottom - 200, 28);
  ctx.fillStyle = PANEL;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  rr(ctx, 70, 200, W - 140, cardBottom - 200, 28);
  ctx.fill();
  ctx.stroke();
  if (result?.score != null) {
    ctx.lineWidth = 22;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#EFE7D3";
    ctx.beginPath();
    ctx.arc(240, 360, 105, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(240, 360, 105, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * result.score / 100);
    ctx.stroke();
  }
  ctx.fillStyle = INK;
  ctx.font = `600 96px ${SERIF}`;
  ctx.fillText(result?.score == null ? "—" : String(result.score), 240, 394);
  ctx.fillStyle = FG3;
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText(result?.score == null ? "sem nota" : "/ 100", 240, 426);

  ctx.font = `600 30px ${SANS}`;
  const chipLines = wrap(ctx, (verdict?.label ?? "Sem veredito").toUpperCase(), 470);
  const chipWidth = Math.max(...chipLines.map((line) => ctx.measureText(line).width)) + 76;
  const chipHeight = chipLines.length * 38 + 24;
  ctx.fillStyle = verdict ? `${color}1F` : "#1A140C12";
  rr(ctx, 400, 330, chipWidth, chipHeight, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(424, 330 + chipHeight / 2, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const [index, line] of chipLines.entries()) ctx.fillText(line, 446, 342 + index * 38);

  for (const command of commands) {
    if (command.type === "line") {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(110, command.y);
      ctx.lineTo(W - 110, command.y);
      ctx.stroke();
    } else {
      ctx.font = command.font;
      ctx.fillStyle = command.color;
      ctx.textAlign = command.align;
      for (const [index, line] of command.lines.entries()) ctx.fillText(line, command.x, command.y + index * command.lineHeight);
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("O navegador não conseguiu gerar o PNG completo. Copie o texto completo da checagem.")), "image/png");
  });
}
