// Gera card PNG de compartilhamento (1080×1350) via Canvas 2D.
// Espelha a identidade do site: fundo creme + textura, header tinta,
// serifada Faustina nos títulos, Geist nos selos, sombra dura, chip
// de veredito e anel de nota iguais aos do ResultCard.
// Zero dependências — roda 100% no browser.

import { CLAIM_STATUS, EVIDENCE_SUPPORT, EVIDENCE_VERIFICATION, VERDICTS } from "../data/constants.js";

const W = 1080;
const H = 1350;
const BG = "#F2ECDC";
const PANEL = "#FBF7EB";
const INK = "#1A140C";
const ACCENT = "#D9341F";
const FG2 = "#453F33";
const FG3 = "#5F5849";
const LINE = "#1A140C2E";
const SERIF = "Faustina, Georgia, serif";
const SANS = "Geist, 'Helvetica Neue', Arial, sans-serif";

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
  // Quebra palavra longa (URL sem espaços) em pedaços que cabem.
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

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  function push(word) {
    const t = line ? `${line} ${word}` : word;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = t;
    }
  }
  for (const w of words) {
    if (ctx.measureText(w).width > maxW) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const part of breakWord(ctx, w, maxW)) {
        lines.push(part);
      }
    } else {
      push(w);
    }
  }
  if (line) lines.push(line);
  return lines;
}

const CLAIM_ICON = { true: "✓", false: "✕", unproven: "?", context: "◐" };
const RELATION_LABEL = { supports: "Sustenta", refutes: "Contradiz", context: "Contextualiza" };

/** Usa a alegação efetivamente checada, não a pergunta ou o nome do upload. */
export function shareCardContent(result) {
  const claims = (Array.isArray(result?.claims) ? result.claims : []).filter((claim) => String(claim?.text ?? "").trim());
  const first = claims[0];
  const title = first
    ? `Alegação: ${String(first.text).trim()}`
    : String(result?.title ?? "Checagem sem alegação verificável");
  const summary = String(result?.summary ?? "").trim() || String(first?.note ?? "").trim();
  return { title, summary, claims };
}

export function buildShareText(result, { origin, pathname = "/" }) {
  const content = shareCardContent(result);
  const label = VERDICTS[result?.verdict]?.label ?? "Sem veredito";
  const verdict = result?.score == null ? `${label} · nota indisponível` : `${label} · nota ${result.score}/100`;
  const coverage = result?.coverage;
  const coverageText = coverage
    ? `\nCobertura: ${coverage.total} no total; ${coverage.assessed} avaliadas com evidência adequada; ${coverage.unproven} sem comprovação; ${coverage.omitted} sem análise.`
    : "";
  const correction = result?.id
    ? `Checagem automática ${result.id}. Confira correções em ${origin}/correcoes.html?checkId=${encodeURIComponent(result.id)}`
    : "Checagem automática.";
  return `${content.title}\n${verdict}${coverageText}${content.summary ? `\n\n${content.summary}` : ""}\n\n${correction}\nConfira você também em ${origin}${pathname}`;
}

function sourceHost(source) {
  try {
    return new URL(source?.url).hostname.replace(/^www\./, "");
  } catch {
    return String(source?.outlet ?? "Fonte");
  }
}

/** Fatia linhas com "…" na última quando corta conteúdo. Usa a fonte atual do ctx. */
function sliceLines(ctx, lines, max, maxW) {
  const out = lines.slice(0, max);
  if (lines.length > max && out.length > 0) {
    let last = out[out.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    out[out.length - 1] = `${last}…`;
  }
  return out;
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load('600 100px Faustina'),
      document.fonts.load('400 40px Faustina'),
      document.fonts.load('600 40px Geist'),
      document.fonts.load('500 32px Geist'),
      document.fonts.load('400 30px Geist'),
    ]);
    await document.fonts.ready;
  } catch { /* fallback serif/sans */ }
}

/** Ruído sutil igual ao body::before do site. */
function grain(ctx) {
  ctx.save();
  ctx.globalAlpha = 0.05;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  ctx.fillStyle = INK;
  for (let i = 0; i < 2600; i++) {
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }
  ctx.restore();
}

/** Sombra dura do site: offset sólido sem blur. */
function hardShadow(ctx, x, y, w, h, r, color = "#1A140C2E") {
  ctx.save();
  ctx.fillStyle = color;
  rr(ctx, x + 10, y + 10, w, h, r);
  ctx.fill();
  ctx.restore();
}

/**
 * @param {object} result resultado normalizado (api.js)
 * @returns {Promise<Blob>} PNG
 */
export async function renderShareCard(result) {
  await ensureFonts();

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const content = shareCardContent(result);
  const verdict = VERDICTS[result.verdict] ?? VERDICTS.unproven;
  const claims = content.claims.slice(0, 3);
  const sources = (result.sources ?? []).filter((s) => s.url && s.url !== "#").slice(0, 3);

  // Fundo creme + textura
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  grain(ctx);

  // Header tinta (igual .header do site)
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, 150);
  ctx.fillStyle = "#0D0A06";
  ctx.fillRect(0, 146, W, 4);
  ctx.textAlign = "center";
  ctx.fillStyle = BG;
  ctx.font = `400 52px ${SERIF}`;
  const brand = "isso é verdade?";
  const brandW = ctx.measureText(brand).width;
  ctx.fillText("isso é verdade", W / 2 - 14, 88);
  ctx.fillStyle = ACCENT;
  ctx.fillText("?", W / 2 + brandW / 2 - 14, 88);
  ctx.fillStyle = "#B9B09A";
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText("ELEIÇÕES 2026  ·  SEGUNDO TURNO", W / 2, 126);

  // Card principal (igual .card: painel + borda tinta + sombra dura).
  // Título calculado ANTES para a altura do card abraçar o conteúdo.
  const cx0 = 70;
  const cw = W - 140;
  const cardTop = 200;
  ctx.font = `400 42px ${SERIF}`;
  let cleanTitle = content.title;
  const urlMatch = cleanTitle.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    try {
      const host = new URL(urlMatch[0]).hostname.replace(/^www\./, "");
      cleanTitle = cleanTitle.replace(urlMatch[0], host).trim();
    } catch { /* mantém original, wrap quebra */ }
  }
  ctx.font = `400 42px ${SERIF}`;
  const titleFull = wrap(ctx, cleanTitle, cw - 120);
  // Layout em 2 passes: mede tudo primeiro; o ajuste (fit) garante pelo menos
  // 1 claim com "porquê" (justificativa + trecho de evidência) e encolhe o resto
  // (resumo → extras → título → texto → nota → evidência → fontes) até caber.
  const prepared = claims.map((c, idx) => {
    const text = String(c.text ?? "").replace(/^["“]|["”]$/g, "");
    ctx.font = `400 30px ${SANS}`;
    const textFull = claims.length === 1 ? [] : wrap(ctx, text, W - 220);
    ctx.font = `400 25px ${SANS}`;
    const support = EVIDENCE_SUPPORT[c.evidenceSupport];
    const note = [support ? `Suporte da evidência: ${support}.` : "", c.note].filter(Boolean).join(" ");
    const noteFull = note ? wrap(ctx, note, W - 220) : [];
    const expected = c.evidenceSupport ?? (c.status === "true" ? "supports" : c.status === "false" ? "refutes" : "context");
    const ev = (c.evidence ?? []).find((e) => e?.relation === expected && String(e.quote ?? "").trim())
      ?? (c.evidence ?? []).find((e) => String(e?.quote ?? "").trim());
    let evFull = [];
    if (ev) {
      const source = result.sources?.[ev.sourceId];
      const rel = c.status === "unproven" ? "Contexto, não comprovação" : RELATION_LABEL[ev.relation] ?? "Evidência";
      ctx.font = `400 24px ${SANS}`;
      const verification = EVIDENCE_VERIFICATION[ev.verification];
      evFull = wrap(ctx, `${rel} · ${sourceHost(source)}${verification ? ` · ${verification}` : ""} · trecho original: “${String(ev.quote).trim()}”`, W - 236);
    }
    const first = idx === 0;
    return {
      c,
      textFull,
      noteFull,
      evFull,
      alloc: {
        t: Math.min(2, textFull.length),
        // Teto generoso no 1º claim: o fit corta até caber, então ocupa o espaço livre com "porquê".
        n: Math.min(first ? 6 : 2, noteFull.length),
        e: Math.min(first ? 4 : 1, evFull.length),
      },
    };
  });
  ctx.font = `400 27px ${SANS}`;
  const sourceFull = sources.map((s) => {
    const label = `•  ${s.outlet || sourceHost(s)} · ${sourceHost(s)}`;
    return wrap(ctx, label, W - 220);
  });
  let titleN = Math.min(3, titleFull.length);
  let summaryN = 0;
  let visible = prepared.length;
  let visibleSources = sourceFull.length;
  // Orçamento: header(200) + anel/título(530→) + claims + fontes + rodapé(228).
  const TITLE_Y = 530;
  const FOOTER_TOP = H - 228;
  const claimH = (p) => 38 + p.alloc.t * 38 + p.alloc.n * 31 + (p.alloc.e > 0 ? 6 + p.alloc.e * 30 : 0) + 14;
  const sourcesH = () => visibleSources > 0
    ? 30 + 30 + sourceFull.slice(0, visibleSources).reduce((a, b) => a + Math.min(2, b.length) * 34, 0)
    : 0;
  const totalH = () => {
    const bottom = TITLE_Y + titleN * 52 + 10 + summaryN * 32 + 26;
    const claimsH = prepared.slice(0, visible).reduce((a, p) => a + claimH(p), 0);
    return bottom + 48 + claimsH + sourcesH();
  };
  const fitsAll = () => totalH() <= FOOTER_TOP;
  // Resumo: alvo de 2 linhas; mantém pelo menos 1 para contextualizar o veredito.
  ctx.font = `400 26px ${SANS}`;
  const fullSummary = wrap(ctx, content.summary, cw - 120);
  summaryN = Math.min(2, fullSummary.length);
  const minSummary = fullSummary.length > 0 ? 1 : 0;
  while (summaryN > minSummary && !fitsAll()) summaryN -= 1;
  // Claims extras: cortam evidência/nota antes de sumir.
  for (let i = visible - 1; i >= 1 && !fitsAll(); i--) {
    while (prepared[i].alloc.e > 0 && !fitsAll()) prepared[i].alloc.e -= 1;
    const minN = prepared[i].noteFull.length > 0 ? 1 : 0;
    while (prepared[i].alloc.n > minN && !fitsAll()) prepared[i].alloc.n -= 1;
  }
  while (visible > 1 && !fitsAll()) visible -= 1;
  // Título, texto do 1º claim, 1ª nota e fontes entram no ajuste para o 1º claim
  // sempre caber (mínimo: badge + 1 linha de texto + 1 de porquê + 1 fonte).
  while (titleN > 2 && !fitsAll()) titleN -= 1;
  if (visible > 0) {
    const p0 = prepared[0];
    while (p0.alloc.t > 1 && !fitsAll()) p0.alloc.t -= 1;
    while (p0.alloc.n > 2 && !fitsAll()) p0.alloc.n -= 1;
    const detailMin = p0.noteFull.length > 0 ? 0 : (p0.evFull.length > 0 ? 1 : 0);
    while (p0.alloc.e > detailMin && !fitsAll()) p0.alloc.e -= 1;
    while (summaryN > 0 && !fitsAll()) summaryN -= 1;
    while (titleN > 1 && !fitsAll()) titleN -= 1;
    const noteMin = p0.noteFull.length > 0 ? 1 : 0;
    const evMin = noteMin === 0 && p0.evFull.length > 0 ? 1 : 0;
    while (p0.alloc.n > noteMin && !fitsAll()) p0.alloc.n -= 1;
    while (p0.alloc.e > evMin && !fitsAll()) p0.alloc.e -= 1;
    while (visibleSources > 1 && !fitsAll()) visibleSources -= 1;
    if (!fitsAll() && sources.length > 0) visibleSources = 0;
  } else {
    while (titleN > 1 && !fitsAll()) titleN -= 1;
    while (summaryN > 0 && !fitsAll()) summaryN -= 1;
    while (visibleSources > 1 && !fitsAll()) visibleSources -= 1;
  }
  ctx.font = `400 42px ${SERIF}`;
  const titleLines = sliceLines(ctx, titleFull, titleN, cw - 120);
  ctx.font = `400 26px ${SANS}`;
  const summaryLines = sliceLines(ctx, fullSummary, summaryN, cw - 120);
  const claimBlocks = prepared.slice(0, visible).map((p) => {
    ctx.font = `400 30px ${SANS}`;
    const clines = sliceLines(ctx, p.textFull, p.alloc.t, W - 220);
    ctx.font = `400 25px ${SANS}`;
    const nlines = sliceLines(ctx, p.noteFull, p.alloc.n, W - 220);
    ctx.font = `400 24px ${SANS}`;
    const elines = sliceLines(ctx, p.evFull, p.alloc.e, W - 236);
    return { c: p.c, clines, nlines, elines, h: 38 + clines.length * 38 + nlines.length * 31 + (elines.length > 0 ? 6 + elines.length * 30 : 0) + 14 };
  });
  ctx.font = `400 27px ${SANS}`;
  const sourceBlocks = sourceFull.slice(0, visibleSources).map((lines) => sliceLines(ctx, lines, 2, W - 220));
  const cardBottom = TITLE_Y + titleLines.length * 52 + 10 + summaryLines.length * 32 + 26;
  hardShadow(ctx, cx0, cardTop, cw, cardBottom - cardTop, 28);
  ctx.fillStyle = PANEL;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  rr(ctx, cx0, cardTop, cw, cardBottom - cardTop, 28);
  ctx.fill();
  ctx.stroke();
  const ringX = cx0 + 170;
  const ringY = 360;
  const R = 105;
  if (result.score != null) {
    ctx.lineWidth = 22;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#EFE7D3";
    ctx.beginPath();
    ctx.arc(ringX, ringY, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = verdict.color;
    ctx.beginPath();
    ctx.arc(ringX, ringY, R, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * result.score) / 100);
    ctx.stroke();
  }
  ctx.fillStyle = INK;
  ctx.font = `600 96px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.fillText(result.score == null ? "—" : String(result.score), ringX, ringY + 34);
  ctx.fillStyle = FG3;
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText(result.score == null ? "sem nota" : "/ 100", ringX, ringY + 66);

  // Chip veredito (igual .chip do site)
  ctx.textAlign = "left";
  ctx.font = `600 30px ${SANS}`;
  const chipLabel = result.verdict ? verdict.label.toUpperCase() : "SEM VEREDITO";
  const chipW = ctx.measureText(chipLabel).width + 96;
  const chipX = cx0 + 330;
  const chipY = 330;
  ctx.fillStyle = `${verdict.color}1F`;
  rr(ctx, chipX, chipY, chipW, 62, 14);
  ctx.fill();
  ctx.fillStyle = verdict.color;
  ctx.beginPath();
  ctx.arc(chipX + 32, chipY + 31, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText(chipLabel, chipX + 52, chipY + 41);

  // Título serifado centralizado (largura total = URLs cabem sem vazar).
  ctx.fillStyle = INK;
  ctx.font = `400 42px ${SERIF}`;
  ctx.textAlign = "center";
  let ty = TITLE_Y;
  for (const line of titleLines) {
    ctx.fillText(line, W / 2, ty);
    ty += 52;
  }
  ty += 10;
  ctx.fillStyle = FG2;
  ctx.font = `400 26px ${SANS}`;
  for (const line of summaryLines) {
    ctx.fillText(line, W / 2, ty);
    ty += 32;
  }

  // Claims como linhas do site (badge + texto + justificativa + trecho de evidência). Para antes do rodapé.
  ctx.textAlign = "left";
  let y = cardBottom + 48;
  const roomFor = (h) => y + h <= FOOTER_TOP - sourcesH();
  for (const { c, clines, nlines, elines, h } of claimBlocks) {
    const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
    const badge = `${CLAIM_ICON[c.status] ?? "?"}  ${st.label.toUpperCase()} · ${c.score == null ? "SEM NOTA" : c.score}`;
    if (!roomFor(h)) break;
    ctx.fillStyle = st.color;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText(badge, 110, y);
    y += 38;
    ctx.fillStyle = FG2;
    ctx.font = `400 30px ${SANS}`;
    for (const line of clines) {
      ctx.fillText(line, 110, y);
      y += 38;
    }
    ctx.fillStyle = FG3;
    ctx.font = `400 25px ${SANS}`;
    for (const line of nlines) {
      ctx.fillText(line, 110, y);
      y += 31;
    }
    if (elines.length > 0) {
      y += 6;
      ctx.fillStyle = st.color;
      ctx.fillRect(110, y - 22, 4, elines.length * 30 - 4);
      ctx.fillStyle = FG2;
      ctx.font = `400 24px ${SANS}`;
      for (const line of elines) {
        ctx.fillText(line, 126, y);
        y += 30;
      }
    }
    y += 14;
  }

  // Divisória + fontes (com detalhe tipo · data quando houver)
  if (sourceBlocks.length > 0) {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(110, y);
    ctx.lineTo(W - 110, y);
    ctx.stroke();
    y += 30;
    ctx.fillStyle = FG3;
    ctx.font = `600 22px ${SANS}`;
    const hidden = sources.length - sourceBlocks.length;
    ctx.fillText(`FONTES CONSULTADAS · ${result.sources.length}${hidden > 0 ? ` (mostrando ${sourceBlocks.length})` : ""}`, 110, y);
    y += 30;
    ctx.font = `400 27px ${SANS}`;
    ctx.fillStyle = FG2;
    for (const lines of sourceBlocks) {
      for (const line of lines) {
        ctx.fillText(line, 110, y);
        y += 34;
      }
    }
  }

  // Rodapé: meta da checagem + ID verificável + CTA de divulgação
  ctx.textAlign = "center";
  ctx.fillStyle = FG3;
  ctx.font = `400 22px ${SANS}`;
  const coverage = result.coverage;
  const meta = coverage
    ? `Cobertura: ${coverage.assessed}/${coverage.total} avaliadas · ${coverage.unproven} sem comprovação · ${coverage.omitted} sem análise`
    : [result.kind, result.publishedAt ? `checada em ${result.publishedAt}` : ""].filter(Boolean).join("  ·  ");
  if (meta) ctx.fillText(meta, W / 2, H - 214);
  // Análise automatizada, identificador e caminho para conferir correções:
  // o card pode circular fora do site, então precisa apontar para a versão vigente.
  ctx.fillStyle = FG2;
  ctx.font = `400 22px ${SANS}`;
  const aviso = result.score == null
    ? "Checagem automática · nota indisponível não significa falsidade"
    : "Checagem automática · a nota não é probabilidade calibrada";
  ctx.fillText(aviso, W / 2, H - 176);
  if (result.id) {
    ctx.fillStyle = FG3;
    ctx.font = `400 22px ${SANS}`;
    const host = location.host;
    const id = result.id;
    // URL de correções pode vazar da largura; encurta até caber.
    const candidates = [
      `ID ${id} · confira correções em ${host}/correcoes.html?checkId=${id}`,
      `ID ${id} · ${host}/correcoes.html?checkId=${id}`,
      `ID ${id} · ${host}/correcoes.html`,
      `ID ${id}`,
    ];
    const idLine = candidates.find((t) => ctx.measureText(t).width <= W - 80) ?? `ID ${id}`;
    ctx.fillText(idLine, W / 2, H - 140);
  }
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText("Viu algo suspeito? Confira você também em", W / 2, H - 100);
  ctx.fillStyle = ACCENT;
  ctx.font = `600 40px ${SANS}`;
  ctx.fillText(location.host, W / 2, H - 52);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem."))),
      "image/png",
    );
  });
}
