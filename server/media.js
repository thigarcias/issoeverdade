// Kit de mídia server-side: baixa vídeo/áudio de "qualquer lugar" para a IA checar.
// Estratégia em camadas (tenta em ordem, para na primeira que funciona):
//   0. worker remoto (Fly.io) → yt-dlp + ffmpeg externos, se MEDIA_WORKER_URL definido
//   1. yt-dlp --dump-json  → metadados + formatos (X, Instagram, TikTok, YouTube, +1000 sites)
//   2. yt-dlp -x            → extrai áudio MP3 (para transcrição com Whisper)
//   3. oEmbed oficial       → texto do post (fallback leve, ex.: publish.twitter.com)
//   4. fetch HTML + og:*    → título/descrição/thumbnail (fallback universal)
// Chamado pelo runVerify; também usável via CLI: node scripts/fetch-media.mjs <url>
// Local com yt-dlp: camadas 1-2 diretas, sem latência. Vercel: delega ao worker (0),
// cai para 3-4 se o worker falhar.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const YTDLP_TIMEOUT_MS = 60_000;
const MAX_DESC = 2000;
const WORKER_URL = (process.env.MEDIA_WORKER_URL || "").replace(/\/$/, "");
const WORKER_SECRET = process.env.MEDIA_WORKER_SECRET || "";

/** Camada 0: delega probe ao worker remoto (Fly.io). */
async function probeViaWorker(url) {
  if (!WORKER_URL) return { ok: false, reason: "no-worker-url" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 75_000);
    const res = await fetch(`${WORKER_URL}/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WORKER_SECRET ? { Authorization: `Bearer ${WORKER_SECRET}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `worker-http-${res.status}` };
    const data = await res.json();
    if (!data?.ok) return { ok: false, reason: data?.reason ?? "worker-probe-failed" };
    return { ok: true, source: "worker:yt-dlp", ...data.media, _context: data.context };
  } catch {
    return { ok: false, reason: "worker-unreachable" };
  }
}

/** Camada 0 (áudio): baixa MP3 via worker remoto, salva local para transcrever. */
async function downloadViaWorker(url, outDir) {
  if (!WORKER_URL) return { ok: false, reason: "no-worker-url" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 150_000);
    const res = await fetch(`${WORKER_URL}/audio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WORKER_SECRET ? { Authorization: `Bearer ${WORKER_SECRET}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `worker-http-${res.status}` };
    const data = await res.json();
    if (!data?.ok || !data.audio_b64) return { ok: false, reason: data?.reason ?? "worker-audio-failed" };
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    // Vercel/Lambda: filesystem read-only exceto /tmp.
    const dir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
    await mkdir(dir, { recursive: true });
    const file = `${dir}/worker-${Date.now().toString(36)}.mp3`;
    await writeFile(file, Buffer.from(data.audio_b64, "base64"));
    return { ok: true, file, via: "worker" };
  } catch {
    return { ok: false, reason: "worker-unreachable" };
  }
}

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

/** Camada 2: baixa áudio — worker remoto → yt-dlp local → og:video direto. */
export async function downloadAudio(url, outDir = "./media-tmp") {
  if (!(await hasYtDlp()) && WORKER_URL) {
    // Sem binário local (Vercel): worker primeiro.
    const w = await downloadViaWorker(url, outDir);
    if (w.ok) return w;
  }
  if (await hasYtDlp()) {
    const dl = await downloadViaYtDlp(url, outDir);
    if (dl.ok) return dl;
  }
  return downloadViaDirectUrl(url, outDir);
}

async function downloadViaYtDlp(url, outDir) {
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
    return file ? { ok: true, file, via: "yt-dlp" } : { ok: false, reason: "no-file" };
  } catch (err) {
    return { ok: false, reason: "download-failed", detail: String(err?.message ?? err).slice(0, 200) };
  }
}

async function downloadViaDirectUrl(url, outDir) {
  // Sem yt-dlp (ex.: Vercel): procura og:video/twitter:player:stream no HTML e baixa direto.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", Accept: "text/html" },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: "no-ytdlp-no-direct" };
    const html = (await res.text()).slice(0, 200_000);
    const m = html.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/i)
      ?? html.match(/<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)/i);
    const direct = m?.[1];
    if (!direct || !/^https?:\/\//.test(direct)) return { ok: false, reason: "no-direct-video-url" };
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
    await mkdir(dir, { recursive: true });
    const dlCtrl = new AbortController();
    const dlT = setTimeout(() => dlCtrl.abort(), 90_000);
    const dl = await fetch(direct, { signal: dlCtrl.signal });
    clearTimeout(dlT);
    if (!dl.ok) return { ok: false, reason: `direct-http-${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) return { ok: false, reason: "direct-too-large" };
    const ext = (direct.split("?")[0].split(".").pop() || "mp4").slice(0, 4).replace(/[^a-z0-9]/gi, "") || "mp4";
    const file = `${dir}/direct-${Date.now().toString(36)}.${ext}`;
    await writeFile(file, buf);
    return { ok: true, file, via: "direct" };
  } catch {
    return { ok: false, reason: "direct-failed" };
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
          : /(^|\.)(instagram\.com)$/.test(host)
            ? `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}`
            : null;
  if (!endpoint) return { ok: false, reason: "no-oembed-provider" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(endpoint, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `oembed-http-${res.status}` };
    const data = await res.json();
    const isInsta = /(^|\.)(instagram\.com)$/.test(host);
    const title = String(data.title ?? "").slice(0, 300);
    return {
      ok: true,
      source: "oembed",
      title,
      author: String(data.author_name ?? "").slice(0, 200),
      // No Instagram o "title" já é a legenda do post.
      description: isInsta ? title : pickText(stripHtml(data.html)),
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
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const isInsta = /(^|\.)(instagram\.com)$/.test(host);
  // Instagram: oEmbed primeiro (rápido, ~1s, sem o 429 do scraping).
  if (isInsta) {
    const oe = await probeOEmbed(url);
    attempts.push(`oembed:${oe.ok ? "ok" : oe.reason}`);
    if (oe.ok) {
      const lines = [
        `Plataforma: Instagram`,
        oe.author && `Autor: ${oe.author}`,
        oe.description && `Legenda do post: ${oe.description}`,
      ].filter(Boolean);
      return { ok: true, context: lines.join("\n"), media: oe, attempts };
    }
  }
  // Sem yt-dlp local (Vercel) e com worker configurado: delega primeiro.
  if (!(await hasYtDlp()) && WORKER_URL) {
    const w = await probeViaWorker(url);
    attempts.push(`worker:${w.ok ? "ok" : w.reason}`);
    if (w.ok) return { ok: true, context: w._context, media: w, attempts };
  }
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
