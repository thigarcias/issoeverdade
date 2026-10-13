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

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
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

  // Card principal (igual .card: painel + borda tinta + sombra dura)
  const cx0 = 70;
  const cw = W - 140;
  hardShadow(ctx, cx0, 210, cw, 690, 28);
  ctx.fillStyle = PANEL;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  rr(ctx, cx0, 210, cw, 690, 28);
  ctx.fill();
  ctx.stroke();

  // Anel de nota (igual ScoreRing: track + barra arredondada)
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

  // Título serifado (igual .result-title h3)
  ctx.fillStyle = INK;
  ctx.font = `400 44px ${SERIF}`;
  const cleanTitle = result.title.replace(/^\[MOCK\]\s*/, "");
  const titleLines = wrap(ctx, cleanTitle, cw - 300).slice(0, 3);
  let ty = chipY + 120;
  for (const line of titleLines) {
    ctx.fillText(line, chipX, ty);
    ty += 56;
  }

  // Claims como linhas do site (badge + texto)
  let y = 990;
  for (const c of claims) {
    const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
    ctx.font = `600 26px ${SANS}`;
    const badge = `${CLAIM_ICON[c.status] ?? "?"}  ${st.label.toUpperCase()} · ${c.score}`;
    ctx.fillStyle = st.color;
    ctx.fillText(badge, 110, y);
    y += 40;
    ctx.fillStyle = FG2;
    ctx.font = `400 30px ${SANS}`;
    const text = c.text.replace(/^["“]|["”]$/g, "");
    const clines = wrap(ctx, text, W - 220).slice(0, 2);
    for (const line of clines) {
      ctx.fillText(line, 110, y);
      y += 40;
    }
    y += 22;
  }

  // Divisória + fontes
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
    ctx.fillText("FONTES CONSULTADAS", 110, y);
    y += 36;
    ctx.font = `400 27px ${SANS}`;
    ctx.fillStyle = FG2;
    for (const s of sources) {
      const lines = wrap(ctx, `•  ${s.outlet}`, W - 220).slice(0, 1);
      ctx.fillText(lines[0] ?? "", 110, y);
      y += 36;
    }
  }

  // Rodapé: CTA de divulgação
  ctx.textAlign = "center";
  ctx.fillStyle = FG3;
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
