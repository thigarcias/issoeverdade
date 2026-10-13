// Gera card PNG de compartilhamento (1080×1350) via Canvas 2D.
// Design escuro estilo Spotify Wrapped, na identidade (tinta + veredito + creme).
// Zero dependências — roda 100% no browser.

import { CLAIM_STATUS, VERDICTS } from "../data/constants.js";

const W = 1080;
const H = 1350;
const INK = "#1A140C";
const CREAM = "#F2ECDC";
const CREAM_DIM = "#B9B09A";
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
    ]);
    await document.fonts.ready;
  } catch { /* fallback serif/sans */ }
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

  // Fundo tinta + brilho radial na cor do veredito
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 420, 60, W / 2, 420, 620);
  glow.addColorStop(0, `${verdict.color}55`);
  glow.addColorStop(1, "#1A140C00");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Faixa superior na cor do veredito
  ctx.fillStyle = verdict.color;
  ctx.fillRect(0, 0, W, 18);

  ctx.textAlign = "center";

  // Marca
  let y = 110;
  ctx.fillStyle = CREAM;
  ctx.font = `400 46px ${SERIF}`;
  ctx.fillText("isso é verdade?", W / 2, y);
  y += 40;
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText("ELEIÇÕES 2026 · SEGUNDO TURNO", W / 2, y);

  // Anel de score
  const cx = W / 2;
  const cy = 470;
  const R = 150;
  ctx.lineWidth = 26;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#3A332A";
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = verdict.color;
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * result.score) / 100);
  ctx.stroke();
  // Nota dentro do anel
  ctx.fillStyle = CREAM;
  ctx.font = `600 130px ${SERIF}`;
  ctx.fillText(String(result.score), cx, cy + 48);
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText("/ 100", cx, cy + 88);

  // Veredito em destaque
  y = cy + 220;
  ctx.fillStyle = verdict.color;
  ctx.font = `600 64px ${SANS}`;
  ctx.fillText(verdict.label.toUpperCase(), W / 2, y);

  // Título do conteúdo (entre aspas, itálico)
  y += 70;
  ctx.fillStyle = CREAM;
  ctx.font = `italic 400 36px ${SERIF}`;
  const cleanTitle = result.title.replace(/^\[MOCK\]\s*/, "");
  const titleLines = wrap(ctx, `“${cleanTitle}”`, W - 240).slice(0, 3);
  for (const line of titleLines) {
    ctx.fillText(line, W / 2, y);
    y += 48;
  }
  y += 30;

  // Claims com barra lateral colorida
  ctx.textAlign = "left";
  for (const c of claims) {
    const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
    const text = c.text.replace(/^["“]|["”]$/g, "");
    ctx.font = `400 29px ${SANS}`;
    const clines = wrap(ctx, text, W - 320).slice(0, 2);
    const blockH = 48 + clines.length * 40 + 16;
    // barra lateral
    ctx.fillStyle = st.color;
    rr(ctx, 110, y, 10, blockH, 5);
    ctx.fill();
    // selo com fundo creme (contraste no fundo escuro)
    ctx.font = `600 24px ${SANS}`;
    const badge = `${CLAIM_ICON[c.status] ?? "?"} ${st.label.toUpperCase()} · ${c.score}`;
    const badgeW = ctx.measureText(badge).width + 32;
    ctx.fillStyle = CREAM;
    rr(ctx, 145, y + 2, badgeW, 36, 8);
    ctx.fill();
    ctx.fillStyle = st.color;
    ctx.fillText(badge, 161, y + 28);
    // texto
    ctx.fillStyle = CREAM;
    ctx.font = `400 29px ${SANS}`;
    clines.forEach((line, i) => {
      ctx.fillText(line, 145, y + 48 + 40 * (i + 1));
    });
    y += blockH + 34;
  }

  // Fontes
  if (sources.length > 0) {
    y += 4;
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `600 22px ${SANS}`;
    ctx.fillText("FONTES", 110, y);
    y += 34;
    ctx.font = `400 26px ${SANS}`;
    ctx.fillStyle = CREAM;
    for (const s of sources) {
      const lines = wrap(ctx, `•  ${s.outlet}`, W - 260).slice(0, 2);
      for (const line of lines) {
        ctx.fillText(line, 110, y);
        y += 34;
      }
    }
  }

  // Rodapé
  ctx.textAlign = "center";
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText("Confira a checagem completa em", W / 2, H - 100);
  ctx.fillStyle = CREAM;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText(location.host, W / 2, H - 58);

  // Faixa inferior na cor do veredito
  ctx.fillStyle = verdict.color;
  ctx.fillRect(0, H - 18, W, 18);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem."))),
      "image/png",
    );
  });
}
