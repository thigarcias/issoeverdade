// Gera card PNG de compartilhamento (1080×1350) via Canvas 2D.
// Identidade: creme #F2ECDC, tinta #1A140C, vermelho #D9341F, serifada.
// Zero dependências — roda 100% no browser.

import { CLAIM_STATUS, VERDICTS } from "../data/constants.js";

const W = 1080;
const H = 1350;
const BG = "#F2ECDC";
const INK = "#1A140C";
const ACCENT = "#D9341F";
const FG2 = "#453F33";
const FG3 = "#5F5849";

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

/**
 * @param {object} result resultado normalizado (api.js)
 * @returns {Promise<Blob>} PNG
 */
export async function renderShareCard(result) {
  try {
    await document.fonts.load('600 200px Faustina, Georgia, serif');
    await document.fonts.load('500 40px Geist, Arial, sans-serif');
  } catch { /* fonte fallback */ }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const verdict = VERDICTS[result.verdict] ?? VERDICTS.unproven;

  // Fundo + moldura
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 10;
  ctx.strokeRect(24, 24, W - 48, H - 48);
  // Faixa vermelha fina no topo
  ctx.fillStyle = ACCENT;
  ctx.fillRect(24, 24, W - 48, 14);

  let y = 130;

  // Marca
  ctx.fillStyle = INK;
  ctx.font = "400 44px Faustina, Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText("isso é verdade?", W / 2, y);
  ctx.fillStyle = ACCENT;
  const markW = ctx.measureText("isso é verdade?").width;
  ctx.fillText("?", W / 2 + markW / 2 - 12, y);
  y += 44;
  ctx.fillStyle = FG3;
  ctx.font = "600 24px Geist, Arial, sans-serif";
  ctx.fillText("E L E I Ç Õ E S  2 0 2 6  ·  2 º  T U R N O", W / 2, y);
  y += 90;

  // Nota gigante
  ctx.fillStyle = verdict.color;
  ctx.font = "600 230px Faustina, Georgia, serif";
  ctx.fillText(String(result.score), W / 2, y + 170);
  y += 210;
  ctx.fillStyle = FG3;
  ctx.font = "500 34px Geist, Arial, sans-serif";
  ctx.fillText("NOTA DE VERDADE · 0–100", W / 2, y);
  y += 80;

  // Chip veredito
  ctx.font = "600 40px Geist, Arial, sans-serif";
  const label = verdict.label.toUpperCase();
  const chipW = ctx.measureText(label).width + 90;
  ctx.fillStyle = verdict.color;
  rr(ctx, W / 2 - chipW / 2, y, chipW, 76, 38);
  ctx.fill();
  ctx.fillStyle = "#FFF6E9";
  ctx.fillText(label, W / 2, y + 51);
  y += 140;

  // Título do conteúdo
  ctx.fillStyle = INK;
  ctx.font = "400 38px Faustina, Georgia, serif";
  const titleLines = wrap(ctx, result.title, W - 200).slice(0, 3);
  for (const line of titleLines) {
    ctx.fillText(line, W / 2, y);
    y += 48;
  }
  y += 20;

  // Claims (até 4)
  ctx.textAlign = "left";
  const claims = (result.claims ?? []).slice(0, 4);
  for (const c of claims) {
    const st = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unproven;
    ctx.font = "500 30px Geist, Arial, sans-serif";
    const badge = `${CLAIM_ICON[c.status] ?? "?"} ${st.label} · ${c.score}`;
    const bw = ctx.measureText(badge).width + 36;
    ctx.fillStyle = st.color;
    rr(ctx, 100, y, bw, 48, 12);
    ctx.fill();
    ctx.fillStyle = "#FFF6E9";
    ctx.fillText(badge, 118, y + 33);
    y += 62;
    ctx.fillStyle = FG2;
    ctx.font = "400 30px Geist, Arial, sans-serif";
    const clines = wrap(ctx, c.text.replace(/^["“]|["”]$/g, ""), W - 200).slice(0, 2);
    for (const line of clines) {
      ctx.fillText(line, 100, y);
      y += 40;
    }
    y += 18;
  }

  // Fontes
  const sources = (result.sources ?? []).filter((s) => s.url && s.url !== "#").slice(0, 3);
  if (sources.length > 0) {
    y += 6;
    ctx.fillStyle = FG3;
    ctx.font = "600 24px Geist, Arial, sans-serif";
    ctx.fillText("FONTES", 100, y);
    y += 36;
    ctx.font = "400 26px Geist, Arial, sans-serif";
    ctx.fillStyle = FG2;
    for (const s of sources) {
      const line = `• ${s.outlet}`;
      ctx.fillText(line.slice(0, 60), 100, y);
      y += 36;
    }
  }

  // Rodapé
  ctx.textAlign = "center";
  ctx.fillStyle = FG3;
  ctx.font = "500 26px Geist, Arial, sans-serif";
  ctx.fillText("Confira a checagem completa:", W / 2, H - 120);
  ctx.fillStyle = INK;
  ctx.font = "600 30px Geist, Arial, sans-serif";
  ctx.fillText(location.host, W / 2, H - 78);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem."))),
      "image/png",
    );
  });
}
