// Kit de mídia server-side: baixa vídeo/áudio de "qualquer lugar" para a IA checar.
// Estratégia em camadas (tenta em ordem, para na primeira que funciona):
//   1. yt-dlp --dump-json  → metadados + formatos (X, Instagram, TikTok, YouTube, +1000 sites)
//   2. yt-dlp -x            → extrai áudio MP3 (para transcrição futura com Whisper)
//   3. oEmbed oficial       → texto do post (fallback leve, ex.: publish.twitter.com)
//   4. fetch HTML + og:*    → título/descrição/thumbnail (fallback universal)
// Chamado pelo runVerify; também usável via CLI: node scripts/fetch-media.mjs <url>
// Requer no servidor: yt-dlp + ffmpeg instalados (dev local: OK; Vercel: ver nota abaixo).
// NOTA Vercel: functions não têm yt-dlp nativo. Opções: (a) self-host do backend,
// (b) API externa (Cobalt), (c) manter camadas 3-4 na Vercel (sem yt-dlp, degradado).
// Este módulo detecta ausência do binário e pula para os fallbacks automaticamente.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const YTDLP_TIMEOUT_MS = 60_000;
const MAX_DESC = 2000;

let ytdlpAvailable = null;

export async function hasYtDlp() {
  if (ytdlpAvailable !== null) return ytdlpAvailable;
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 10_000 });
    ytdlpAvailable = true;
  } catch {
    ytdlpAvailable = false;
  }
  return ytdlpAvailable;
}

function pickText(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, MAX_DESC);
  }
  return "";
}

/** Camada 1: metadados completos via yt-dlp (sem baixar o arquivo). */
export async function probeWithYtDlp(url) {
  if (!(await hasYtDlp())) return { ok: false, reason: "no-ytdlp" };
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      ["--no-playlist", "--dump-json", "--no-warnings", "--socket-timeout", "20", url],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    const desc = pickText(info.description, info.title);
    return {
      ok: true,
      source: "yt-dlp",
      platform: info.extractor_key ?? info.extractor ?? "desconhecida",
      title: String(info.title ?? "").slice(0, 300),
      author: String(info.uploader ?? info.uploader_id ?? info.channel ?? "").slice(0, 200),
      publishedAt: info.upload_date
        ? `${info.upload_date.slice(6, 8)}/${info.upload_date.slice(4, 6)}/${info.upload_date.slice(0, 4)}`
        : "",
      durationSec: typeof info.duration === "number" ? Math.round(info.duration) : null,
      description: desc,
      thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : "",
      mediaUrl: typeof info.url === "string" ? info.url : "",
      id: String(info.id ?? ""),
    };
  } catch (err) {
    return { ok: false, reason: "ytdlp-failed", detail: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Camada 2: baixa só o áudio (MP3) para transcrição futura. Retorna caminho do arquivo. */
export async function downloadAudio(url, outDir = "./media-tmp") {
  if (!(await hasYtDlp())) return { ok: false, reason: "no-ytdlp" };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist", "-x", "--audio-format", "mp3", "--audio-quality", "5",
        "--no-warnings", "--print", "after_move:filepath",
        "-o", `${outDir}/%(id)s.%(ext)s`, url,
      ],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const file = stdout.trim().split("\n").pop()?.trim() ?? "";
    return file ? { ok: true, file } : { ok: false, reason: "no-file" };
  } catch (err) {
    return { ok: false, reason: "download-failed", detail: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Camada 3: oEmbed oficial (leve, sem binário). */
export async function probeOEmbed(url) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const endpoint =
    /(^|\.)(x\.com|twitter\.com)$/.test(host)
      ? `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`
      : /(^|\.)(youtube\.com|youtu\.be)$/.test(host)
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
        : /(^|\.)(tiktok\.com)$/.test(host)
          ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
          : null;
  // Instagram removeu o oEmbed público em 2024 — cai para o HTML.
  if (!endpoint) return { ok: false, reason: "no-oembed-provider" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(endpoint, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `oembed-http-${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      source: "oembed",
      title: String(data.title ?? "").slice(0, 300),
      author: String(data.author_name ?? "").slice(0, 200),
      description: pickText(stripHtml(data.html)),
      thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : "",
    };
  } catch {
    return { ok: false, reason: "oembed-failed" };
  }
}

function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Camada 4: fetch do HTML + meta tags og:/twitter: (universal, sem login). */
export async function probeOpenGraph(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `html-http-${res.status}` };
    const html = (await res.text()).slice(0, 200_000);
    const meta = (prop) => {
      const m =
        html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)`, "i")) ??
        html.match(new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)`, "i"));
      return m ? m[1].trim() : "";
    };
    const title = meta("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "").trim();
    const description = meta("og:description") || meta("description") || meta("twitter:description");
    if (!title && !description) return { ok: false, reason: "no-meta" };
    return {
      ok: true,
      source: "opengraph",
      title: title.slice(0, 300),
      description: description.slice(0, MAX_DESC),
      thumbnail: meta("og:image") || meta("twitter:image"),
      author: meta("og:site_name").slice(0, 200),
    };
  } catch {
    return { ok: false, reason: "html-failed" };
  }
}

/**
 * Ponto de entrada: tenta yt-dlp → oEmbed → OpenGraph, retorna o melhor contexto.
 * @returns {{ ok, context: string, media: object|null, attempts: string[] }}
 * `context` é texto pronto para injetar no prompt do modelo.
 */
export async function fetchMediaContext(url) {
  const attempts = [];
  const yt = await probeWithYtDlp(url);
  attempts.push(`yt-dlp:${yt.ok ? "ok" : yt.reason}`);
  if (yt.ok) {
    const lines = [
      `Plataforma: ${yt.platform}`,
      yt.title && `Título: ${yt.title}`,
      yt.author && `Autor: ${yt.author}`,
      yt.publishedAt && `Publicado em: ${yt.publishedAt}`,
      yt.durationSec && `Duração: ${yt.durationSec}s (vídeo/áudio)`,
      yt.description && `Descrição/texto do post: ${yt.description}`,
    ].filter(Boolean);
    return { ok: true, context: lines.join("\n"), media: yt, attempts };
  }
  const oe = await probeOEmbed(url);
  attempts.push(`oembed:${oe.ok ? "ok" : oe.reason}`);
  if (oe.ok) {
    const lines = [
      oe.title && `Título: ${oe.title}`,
      oe.author && `Autor: ${oe.author}`,
      oe.description && `Texto do post: ${oe.description}`,
    ].filter(Boolean);
    if (lines.length > 0) return { ok: true, context: lines.join("\n"), media: oe, attempts };
  }
  const og = await probeOpenGraph(url);
  attempts.push(`opengraph:${og.ok ? "ok" : og.reason}`);
  if (og.ok) {
    const lines = [
      og.title && `Título da página: ${og.title}`,
      og.author && `Site: ${og.author}`,
      og.description && `Descrição: ${og.description}`,
    ].filter(Boolean);
    return { ok: true, context: lines.join("\n"), media: og, attempts };
  }
  return { ok: false, context: "", media: null, attempts };
}
