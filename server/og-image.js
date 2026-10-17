// Imagem 1200×630 por checagem para og:image. Renderiza SVG → PNG no servidor (resvg).
// Checagem não publicada, ou falha de render, recebe a imagem padrão (fail-open).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { VERDICTS } from "../src/data/constants.js";
import { validCheckId } from "./checklog.js";
import { handleChecksRequest } from "./checks-endpoint.js";
import { checkTitle, escapeHtml, truncate } from "./og.js";

const FONT_DIR = fileURLToPath(new URL("../node_modules/@expo-google-fonts/faustina/", import.meta.url));
const FONT_FILES = [`${FONT_DIR}600SemiBold/Faustina_600SemiBold.ttf`, `${FONT_DIR}400Regular/Faustina_400Regular.ttf`];
const DEFAULT_PNG = readFileSync(fileURLToPath(new URL("../public/og-default.png", import.meta.url)));
const COLORS = { bg: "#F2ECDC", ink: "#1A140C", red: "#D9341F", muted: "#6B5F4E" };

/** Quebra em no máximo `maxLines` linhas de até `maxChars`; a última recebe reticências se sobrar texto. */
export function wrapLines(text, maxChars, maxLines) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word.length > maxChars ? truncate(word, maxChars) : word);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncate(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, maxChars);
  return kept;
}

function textBlock(lines, x, y, lineHeight, attrs) {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * lineHeight}" ${attrs}>${escapeHtml(line)}</text>`).join("");
}

export function renderOgSvg(result, origin) {
  const verdict = Object.hasOwn(VERDICTS, result?.verdict) ? VERDICTS[result.verdict] : null;
  const label = verdict?.label ?? "Sem veredito";
  const pillColor = verdict?.color ?? COLORS.muted;
  const pillWidth = Math.round(label.length * 15 + 56);
  const score = Number.isFinite(result?.score) ? `${result.score}/100` : "sem nota";
  const scoreSize = Number.isFinite(result?.score) ? 150 : 64;
  const title = wrapLines(checkTitle(result, origin) || "Conteúdo enviado para análise", 40, 2);
  const summary = wrapLines(truncate(result?.summary, 300), 66, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${COLORS.bg}"/>
<rect x="80" y="120" width="20" height="390" fill="${COLORS.red}"/>
<text x="130" y="150" font-family="Faustina" font-weight="600" font-size="40" fill="${COLORS.ink}">isso é verdade?</text>
<rect x="130" y="186" width="${pillWidth}" height="54" rx="27" fill="${pillColor}"/>
<text x="${130 + pillWidth / 2}" y="223" text-anchor="middle" font-family="Faustina" font-weight="600" font-size="26" fill="${COLORS.bg}">${escapeHtml(label)}</text>
<text x="1120" y="200" text-anchor="end" font-family="Faustina" font-weight="400" font-size="28" fill="${COLORS.muted}">NOTA</text>
<text x="1120" y="330" text-anchor="end" font-family="Faustina" font-weight="600" font-size="${scoreSize}" fill="${COLORS.ink}">${escapeHtml(score)}</text>
${textBlock(title, 130, 400, 56, `font-family="Faustina" font-weight="600" font-size="48" fill="${COLORS.ink}"`)}
${textBlock(summary, 130, 512, 38, `font-family="Faustina" font-weight="400" font-size="28" fill="${COLORS.muted}"`)}
<text x="130" y="596" font-family="Faustina" font-weight="400" font-size="24" fill="${COLORS.muted}">issoeverdade.site</text>
</svg>`;
}

export function renderOgPng(result, origin) {
  const resvg = new Resvg(renderOgSvg(result, origin), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Faustina" },
  });
  return resvg.render().asPng();
}

async function loadPublished({ headers, socketAddress, env, fetchCheck, id }) {
  if (!validCheckId(id)) return null;
  try {
    const out = await fetchCheck({ method: "GET", headers, query: { id }, socketAddress, env });
    return out?.status === 200 && out.body?.result ? out.body : null;
  } catch {
    return null;
  }
}

/** Entrada de /api/og-image?id=. Retorna { status, headers, body }; body é PNG (null em HEAD). */
export async function handleOgImage({ method, headers = {}, query = {}, socketAddress, env = process.env, fetchCheck = handleChecksRequest } = {}) {
  const common = { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" };
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...common, Allow: "GET, HEAD", "Cache-Control": "no-store" }, body: null };
  }
  const id = typeof query.id === "string" ? query.id : "";
  const body = await loadPublished({ headers, socketAddress, env, fetchCheck, id });
  let png = DEFAULT_PNG;
  let cache = "public, max-age=300";
  if (body) {
    try {
      png = renderOgPng(body.result, body.origin);
      cache = "public, max-age=3600";
    } catch {
      png = DEFAULT_PNG;
    }
  }
  return { status: 200, headers: { ...common, "Cache-Control": cache }, body: method === "HEAD" ? null : png };
}
