// Gera card PNG de compartilhamento (1080×1350) via Canvas 2D.
// Espelha a identidade do site: fundo creme + textura, header tinta,
// serifada Faustina nos títulos, Geist nos selos, sombra dura, chip
// de veredito e anel de nota iguais aos do ResultCard.
// Zero dependências — roda 100% no browser.

import { CLAIM_STATUS, VERDICTS } from "../data/constants.js";

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
  const verdict = VERDICTS[result.verdict] ?? VERDICTS.unproven;
  const claims = (result.claims ?? []).slice(0, 3);
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
  let cleanTitle = result.title.replace(/^\[MOCK\]\s*/, "");
  const urlMatch = cleanTitle.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    try {
      const host = new URL(urlMatch[0]).hostname.replace(/^www\./, "");
      cleanTitle = cleanTitle.replace(urlMatch[0], host).trim();
    } catch { /* mantém original, wrap quebra */ }
  }
  const titleLines = wrap(ctx, cleanTitle, cw - 120).slice(0, 3);
  // Layout em 2 passes: mede claims/fontes primeiro; resumo encolhe (2→0 linhas)
  // para garantir pelo menos 1 claim + fontes sempre visíveis.
  ctx.font = `400 30px ${SANS}`;
  const claimBlocks = claims.map((c) => {
    const text = c.text.replace(/^["“]|["”]$/g, "");
    const clines = wrap(ctx, text, W - 220).slice(0, 2);
    ctx.font = `400 25px ${SANS}`;
    const nlines = c.note ? wrap(ctx, c.note, W - 220).slice(0, 1) : [];
    ctx.font = `400 30px ${SANS}`;
    return { c, clines, nlines, h: 40 + clines.length * 40 + nlines.length * 34 + 22 };
  });
  ctx.font = `400 27px ${SANS}`;
  const sourceBlocks = sources.map((s) => {
    const label = s.detail ? `•  ${s.outlet} — ${s.detail}` : `•  ${s.outlet}`;
    return wrap(ctx, label, W - 220).slice(0, 2);
  });
  const sourcesH = sources.length > 0 ? 36 + 36 + sourceBlocks.reduce((a, b) => a + b.length * 36, 0) : 0;
  const firstClaimH = claimBlocks.length > 0 ? claimBlocks[0].h : 0;
  ctx.font = `400 26px ${SANS}`;
  const fullSummary = wrap(ctx, result.summary ?? "", cw - 120);
  // Orçamento: header(200) + anel/título(600→) + claims + fontes + rodapé(150).
  const TITLE_Y = 600;
  const titleH = titleLines.length * 54;
  let summaryLines = fullSummary.slice(0, 2);
  const fits = (n) => TITLE_Y + titleH + 12 + n * 34 + 32 + 40 + firstClaimH + sourcesH < H - 150;
  while (summaryLines.length > 0 && !fits(summaryLines.length)) summaryLines = summaryLines.slice(0, -1);
  const cardBottom = TITLE_Y + titleH + 12 + summaryLines.length * 34 + 32;
  hardShadow(ctx, cx0, cardTop, cw, cardBottom - cardTop, 28);
  ctx.fillStyle = PANEL;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  rr(ctx, cx0, cardTop, cw, cardBottom - cardTop, 28);
  ctx.fill();
  ctx.stroke();
  const ringX = cx0 + 170;
  const ringY = 430;
  const R = 105;
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
  ctx.fillStyle = INK;
  ctx.font = `600 96px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.fillText(String(result.score), ringX, ringY + 34);
  ctx.fillStyle = FG3;
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText("/ 100", ringX, ringY + 66);

  // Chip veredito (igual .chip do site)
  ctx.textAlign = "left";
  ctx.font = `600 30px ${SANS}`;
  const chipLabel = verdict.label.toUpperCase();
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
    ty += 54;
  }
  ty += 12;
  ctx.fillStyle = FG2;
  ctx.font = `400 26px ${SANS}`;
  for (const line of summaryLines) {
    ctx.fillText(line, W / 2, ty);
    ty += 34;
  }

  // Claims como linhas do site (badge + texto + justificativa). Para antes do rodapé.
  ctx.textAlign = "left";
  const FOOTER_TOP = H - 150;
  let y = cardBottom + 40;
  const roomFor = (h) => y + h < FOOTER_TOP - sourcesH;
  for (const { c, clines, nlines, h } of claimBlocks) {
    const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
    const badge = `${CLAIM_ICON[c.status] ?? "?"}  ${st.label.toUpperCase()} · ${c.score}`;
    if (!roomFor(h)) break;
    ctx.fillStyle = st.color;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText(badge, 110, y);
    y += 40;
    ctx.fillStyle = FG2;
    ctx.font = `400 30px ${SANS}`;
    for (const line of clines) {
      ctx.fillText(line, 110, y);
      y += 40;
    }
    ctx.fillStyle = FG3;
    ctx.font = `400 25px ${SANS}`;
    for (const line of nlines) {
      ctx.fillText(line, 110, y);
      y += 34;
    }
    y += 22;
  }

  // Divisória + fontes (com detalhe tipo · data quando houver)
  if (sources.length > 0) {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(110, y);
    ctx.lineTo(W - 110, y);
    ctx.stroke();
    y += 36;
    ctx.fillStyle = FG3;
    ctx.font = `600 22px ${SANS}`;
    ctx.fillText(`FONTES CONSULTADAS · ${result.sources.length}`, 110, y);
    y += 36;
    ctx.font = `400 27px ${SANS}`;
    ctx.fillStyle = FG2;
    for (const lines of sourceBlocks) {
      for (const line of lines) {
        ctx.fillText(line, 110, y);
        y += 36;
      }
    }
  }

  // Rodapé: meta da checagem + CTA de divulgação
  ctx.textAlign = "center";
  ctx.fillStyle = FG3;
  ctx.font = `400 22px ${SANS}`;
  const meta = [result.kind, result.publishedAt ? `checada em ${result.publishedAt}` : ""].filter(Boolean).join("  ·  ");
  if (meta) ctx.fillText(meta, W / 2, H - 152);
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText("Viu algo suspeito? Confira você também em", W / 2, H - 110);
  ctx.fillStyle = ACCENT;
  ctx.font = `600 40px ${SANS}`;
  ctx.fillText(location.host, W / 2, H - 62);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem."))),
      "image/png",
    );
  });
}
