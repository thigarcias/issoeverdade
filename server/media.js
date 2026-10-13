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
// Todo acesso remoto passa por server/net.js (destinos públicos, teto de bytes por
// transferência) e todo subprocesso por server/proc.js (tempo + vigia de disco).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { byteBudget, hostPolicy, parseUrlStrict, safeFetch, urlHost } from "./net.js";
import { runLimited } from "./proc.js";
import { clip, decodeEntities, stripHtml, textFromHtml } from "./text.js";

const execFileAsync = promisify(execFile);
const MAX_DESC = 2000;
const WORKER_URL = (process.env.MEDIA_WORKER_URL || "").replace(/\/$/, "");
const WORKER_SECRET = process.env.MEDIA_WORKER_SECRET || "";

/** Limites vigentes por job. Valores são operacionais e ficam registrados nas tentativas. */
export function mediaLimits(env = process.env) {
  const int = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback);
  return {
    maxMediaSeconds: int(env.IEV_MAX_MEDIA_SECONDS, 900),
    maxTransferBytes: int(env.IEV_MAX_DOWNLOAD_BYTES, 64 * 1024 * 1024),
    maxTempBytes: int(env.IEV_MAX_TEMP_BYTES, 128 * 1024 * 1024),
    maxFileBytes: int(env.IEV_MAX_MEDIA_FILE_BYTES, 32 * 1024 * 1024),
    maxDocBytes: int(env.IEV_MAX_DOC_BYTES, 8 * 1024 * 1024),
    ytdlpTimeoutMs: int(env.IEV_YTDLP_TIMEOUT_MS, 150_000),
    workerTimeoutMs: int(env.IEV_WORKER_TIMEOUT_MS, 180_000),
  };
}

const MAX_WORKER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_WORKER_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_WORKER_FRAMES_BYTES = 2_500_000;
const MAX_WORKER_FRAMES = 10;

/**
 * Política de rede usada para falar com o worker: porta do worker permitida e
 * endereço privado aceito apenas com opt-in explícito (worker local em dev).
 */
function workerPolicy() {
  const base = hostPolicy();
  if (!WORKER_URL) return base;
  try {
    const parsed = new URL(WORKER_URL);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const allowPrivate = base.allowPrivate || process.env.IEV_ALLOW_PRIVATE_WORKER === "1";
    return { allowPrivate, ports: [...new Set([...base.ports, port])] };
  } catch {
    return base;
  }
}

/** POST JSON ao worker com teto de resposta e timeout único. */
async function workerPost(path, payload, { timeoutMs = mediaLimits().workerTimeoutMs } = {}) {
  if (!WORKER_URL) return { ok: false, reason: "no-worker-url" };
  try {
    const response = await safeFetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WORKER_SECRET ? { Authorization: `Bearer ${WORKER_SECRET}` } : {}),
      },
      body: JSON.stringify(payload),
      maxBytes: MAX_WORKER_RESPONSE_BYTES,
      timeoutMs,
      policy: workerPolicy(),
    });
    if (!response.ok) return { ok: false, reason: `worker-http-${response.status}` };
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      return { ok: false, reason: "worker-bad-json" };
    }
  } catch (error) {
    const code = error?.code ?? "network_failed";
    return { ok: false, reason: code === "timeout" ? "worker-timeout" : `worker-${code}` };
  }
}

/** Normaliza frames do worker: limite de quantidade, tamanho por frame e base64 válido. */
export function normalizeWorkerFrames(value) {
  const frames = [];
  let bytes = 0;
  for (const item of Array.isArray(value) ? value : []) {
    if (frames.length >= MAX_WORKER_FRAMES) break;
    const data = typeof item === "string" ? item : item?.image_b64 ?? item?.data;
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const size = Math.floor((data.length * 3) / 4);
    if (size > 600_000 || bytes + size > MAX_WORKER_FRAMES_BYTES) break;
    bytes += size;
    const seconds = Number(item?.timestamp_sec ?? item?.timestampSec);
    frames.push({ data, timestampSec: Number.isFinite(seconds) ? seconds : null });
  }
  return frames;
}

/** Camada 0: delega probe ao worker remoto (Fly.io). */
async function probeViaWorker(url) {
  const data = await workerPost("/fetch", { url }, { timeoutMs: 90_000 });
  if (!data?.ok) return { ok: false, reason: data?.reason ?? "worker-probe-failed" };
  return { ok: true, source: "worker:yt-dlp", ...data.media, _context: data.context };
}

/** Camada 0 (áudio): baixa MP3 via worker remoto, salva local para transcrever. */
async function downloadViaWorker(url, outDir) {
  const limits = mediaLimits();
  const data = await workerPost("/audio", { url });
  if (!data?.ok || typeof data.audio_b64 !== "string") return { ok: false, reason: data?.reason ?? "worker-audio-failed" };
  const encoded = data.audio_b64;
  if (encoded.length === 0 || encoded.length > Math.ceil(MAX_WORKER_AUDIO_BYTES / 3) * 4) return { ok: false, reason: "worker-audio-too-large" };
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_WORKER_AUDIO_BYTES || bytes.toString("base64") !== encoded) {
    return { ok: false, reason: "worker-audio-invalid" };
  }
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  // Vercel/Lambda: filesystem read-only exceto /tmp.
  const dir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
  await mkdir(dir, { recursive: true });
  const file = `${dir}/worker-${Date.now().toString(36)}.mp3`;
  await writeFile(file, bytes);
  const checked = await enforceDuration(file, limits.maxMediaSeconds);
  if (checked.ok === false) {
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true }).catch(() => {});
    return { ok: false, reason: checked.reason };
  }
  return { ok: true, file, via: "worker", durationSec: checked.durationSec };
}

/** Duração real do arquivo (ffprobe) e recusa acima do teto configurado. */
export async function enforceDuration(file, maxSeconds) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: 20_000 },
    );
    const seconds = Math.ceil(Number(stdout.trim()) || 0);
    if (seconds > maxSeconds) return { ok: false, reason: `duration-limit:${seconds}s` };
    return { ok: true, durationSec: seconds || null };
  } catch {
    return { ok: true, durationSec: null, detail: "ffprobe-unavailable" };
  }
}

/** Processes an uploaded video/audio file through the isolated media worker. */
export async function processUploadedMedia(fileBuffer, mime) {
  if (!WORKER_URL || !Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    return { ok: false, reason: !WORKER_URL ? "no-worker-url" : "empty-upload" };
  }
  const limits = mediaLimits();
  const data = await workerPost("/upload", { file_b64: fileBuffer.toString("base64"), mime });
  if (!data?.ok) {
    const reason = /payload|too-large|unsupported|invalid/.test(String(data?.reason ?? "")) ? "upload-too-large" : data?.reason ?? "worker-upload-failed";
    return { ok: false, reason };
  }
  let audioDir = null;
  try {
    let audio = null;
    if (typeof data.audio?.audio_b64 === "string") {
      const encoded = data.audio.audio_b64;
      if (encoded.length <= Math.ceil(MAX_WORKER_AUDIO_BYTES / 3) * 4) {
        const audioBytes = Buffer.from(encoded, "base64");
        if (audioBytes.length > 0 && audioBytes.length <= MAX_WORKER_AUDIO_BYTES && audioBytes.toString("base64") === encoded) {
          const { mkdtemp, writeFile } = await import("node:fs/promises");
          const { tmpdir } = await import("node:os");
          const { join } = await import("node:path");
          audioDir = await mkdtemp(join(tmpdir(), "iev-upload-"));
          const file = join(audioDir, "audio.mp3");
          await writeFile(file, audioBytes, { flag: "wx" });
          audio = { ok: true, file, dir: audioDir, via: "worker-upload" };
        }
      }
    }
    const durationSec = Number.isFinite(data.duration_sec) ? data.duration_sec : null;
    if (durationSec && durationSec > limits.maxMediaSeconds) {
      if (audioDir) {
        const { rm } = await import("node:fs/promises");
        await rm(audioDir, { recursive: true, force: true }).catch(() => {});
      }
      return { ok: false, reason: `duration-limit:${durationSec}s` };
    }
    const frames = normalizeWorkerFrames(data.frames);
    return {
      ok: true,
      audio,
      frames,
      count: frames.length,
      durationSec,
      via: "worker-upload",
    };
  } catch (error) {
    if (audioDir) {
      const { rm } = await import("node:fs/promises");
      await rm(audioDir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: false, reason: String(error?.code ?? error?.message ?? "worker-upload-failed").slice(0, 120) };
  }
}

let ytdlpAvailable = null;

export async function hasYtDlp() {
  if (ytdlpAvailable !== null) return ytdlpAvailable;
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 4_000 });
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
  const run = await runLimited(
    "yt-dlp",
    ["--no-playlist", "--dump-json", "--no-warnings", "--socket-timeout", "20", "--retries", "1", url],
    { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 },
  );
  if (!run.ok) {
    return { ok: false, reason: run.reason === "timeout" ? "ytdlp-timeout" : "ytdlp-failed", detail: clip(run.stderr, 300) };
  }
  try {
    const info = JSON.parse(run.stdout);
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
    return { ok: false, reason: "ytdlp-bad-json", detail: clip(err?.message ?? err, 300) };
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
  const limits = mediaLimits();
  const { mkdir, rm } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const maxBytes = Math.min(limits.maxTransferBytes, limits.maxFileBytes);
  const run = await runLimited(
    "yt-dlp",
    [
      "--no-playlist", "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "--no-warnings", "--no-progress", "--retries", "2", "--socket-timeout", "20",
      "--max-filesize", String(maxBytes), "--max-downloads", "1",
      "--print", "after_move:filepath",
      "--extractor-args", "youtube:player_client=android,web",
      "-o", `${outDir}/%(id)s.%(ext)s`, url,
    ],
    { timeoutMs: limits.ytdlpTimeoutMs, watchDir: outDir, maxDirBytes: limits.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
  );
  const file = run.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!run.ok || !file) {
    if (file) await rm(file, { force: true }).catch(() => {});
    const reason = run.killed
      ? run.reason === "disk_limit" ? "disk-limit" : run.reason === "timeout" ? "download-timeout" : `kill:${run.reason}`
      : /larger than max-filesize/i.test(run.stderr) ? "file-too-large"
        : "download-failed";
    return { ok: false, reason, detail: clip(run.stderr, 200) };
  }
  const duration = await enforceDuration(file, limits.maxMediaSeconds);
  if (duration.ok === false) {
    await rm(file, { force: true }).catch(() => {});
    return { ok: false, reason: duration.reason };
  }
  return { ok: true, file, via: "yt-dlp", durationSec: duration.durationSec };
}

/** Camada 2b: frames do vídeo — worker remoto → yt-dlp+ffmpeg local. */
export async function downloadFrames(url) {
  if (!(await hasYtDlp()) && WORKER_URL) {
    const w = await framesViaWorker(url);
    if (w.ok) return w;
  }
  if (await hasYtDlp()) {
    const f = await framesViaYtDlp(url);
    if (f.ok) return f;
  }
  if (WORKER_URL) {
    const w = await framesViaWorker(url);
    if (w.ok) return w;
  }
  return { ok: false, reason: "no-frames-path" };
}

const MAX_FRAMES = 10;
const MAX_FRAMES_BYTES = 2_500_000;

async function framesViaWorker(url) {
  const data = await workerPost("/frames", { url });
  if (!data?.ok) return { ok: false, reason: data?.reason ?? "worker-frames-failed" };
  const frames = normalizeWorkerFrames(data.frames);
  if (!frames.length) return { ok: false, reason: "no-frames" };
  return { ok: true, frames, count: frames.length, seconds: data.seconds ?? null, via: "worker" };
}

async function framesViaYtDlp(url) {
  const limits = mediaLimits();
  const { mkdir, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const base = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : "./media-tmp";
  const dir = `${base}/frames-${Date.now().toString(36)}`;
  await mkdir(dir, { recursive: true });
  try {
    const download = await runLimited(
      "yt-dlp",
      [
        "--no-playlist", "-f", "worst[height<=480]/best[height<=480]/worst",
        "--no-warnings", "--no-progress", "--socket-timeout", "20", "--retries", "2",
        "--max-filesize", String(Math.min(limits.maxFileBytes, limits.maxTransferBytes)),
        "--max-downloads", "1",
        "--extractor-args", "youtube:player_client=android,web",
        "-o", `${dir}/v.%(ext)s`, url,
      ],
      { timeoutMs: limits.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: limits.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (!download.ok) {
      return {
        ok: false,
        reason: download.killed ? (download.reason === "disk_limit" ? "disk-limit" : "download-timeout") : /larger than max-filesize/i.test(download.stderr) ? "file-too-large" : "download-failed",
        detail: clip(download.stderr, 200),
      };
    }
    const file = (await readdir(dir)).find((f) => f.startsWith("v."));
    if (!file) return { ok: false, reason: "no-file" };
    const src = `${dir}/${file}`;
    const duration = await enforceDuration(src, limits.maxMediaSeconds);
    if (duration.ok === false) return { ok: false, reason: duration.reason };
    const seconds = duration.durationSec ?? 0;
    const span = Math.max(1, Math.min(limits.maxMediaSeconds, seconds || 60));
    const fps = Math.min(1, MAX_FRAMES / span);
    const frames = await runLimited(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error", "-i", src,
        "-vf", `fps=${fps.toFixed(4)},scale=448:-2`,
        "-frames:v", String(MAX_FRAMES), "-q:v", "7",
        `${dir}/f-%02d.jpg`,
      ],
      { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
    );
    if (!frames.ok) return { ok: false, reason: frames.killed ? "frames-timeout" : "frames-failed", detail: clip(frames.stderr, 200) };
    const jpgs = (await readdir(dir)).filter((f) => /^f-\d+\.jpg$/.test(f)).sort();
    const collected = [];
    let bytes = 0;
    const { readFile } = await import("node:fs/promises");
    for (const [index, j] of jpgs.slice(0, MAX_FRAMES).entries()) {
      const buf = await readFile(`${dir}/${j}`);
      if (bytes + buf.length > MAX_FRAMES_BYTES) break;
      bytes += buf.length;
      collected.push({ data: buf.toString("base64"), timestampSec: Math.round((index / fps) * 100) / 100 });
    }
    if (!collected.length) return { ok: false, reason: "no-frames" };
    return { ok: true, frames: collected, count: collected.length, seconds: seconds || null, via: "yt-dlp" };
  } catch (err) {
    return { ok: false, reason: "frames-failed", detail: clip(err?.message ?? err, 200) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Motivo estável para tentativas registradas no resultado. */
function netReason(error) {
  const code = error?.code ?? "network_failed";
  if (["private_address", "private_hostname", "port_not_allowed", "bad_protocol", "bad_url", "url_credentials"].includes(code)) return `blocked:${code}`;
  if (code === "too_large") return "file-too-large";
  if (code === "budget_exhausted") return "byte-budget-exhausted";
  if (code === "timeout") return "download-timeout";
  if (code === "too_many_redirects") return "too-many-redirects";
  return `net:${code}`;
}

async function downloadViaDirectUrl(url, outDir) {
  // Sem yt-dlp (ex.: Vercel): procura og:video/twitter:player:stream no HTML e baixa direto.
  const limits = mediaLimits();
  const budget = byteBudget(limits.maxTransferBytes);
  try {
    const page = await safeFetch(url, {
      maxBytes: 512 * 1024,
      truncate: true,
      timeoutMs: 20_000,
      headers: { Accept: "text/html" },
      budget,
    });
    if (!page.ok) return { ok: false, reason: `direct-http-${page.status}` };
    const html = page.body.toString("utf8");
    const m = html.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/i)
      ?? html.match(/<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)/i);
    const direct = m?.[1];
    if (!direct || !/^https?:\/\//.test(direct)) return { ok: false, reason: "no-direct-video-url" };
    const download = await safeFetch(direct, {
      maxBytes: Math.min(limits.maxFileBytes, budget.remaining()),
      timeoutMs: 90_000,
      budget,
    });
    if (!download.ok) return { ok: false, reason: `direct-http-${download.status}` };
    const buf = download.body;
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
    await mkdir(dir, { recursive: true });
    const ext = (direct.split("?")[0].split(".").pop() || "mp4").slice(0, 4).replace(/[^a-z0-9]/gi, "") || "mp4";
    const file = `${dir}/direct-${Date.now().toString(36)}.${ext}`;
    await writeFile(file, buf);
    const duration = await enforceDuration(file, limits.maxMediaSeconds);
    if (duration.ok === false) {
      await rm(file, { force: true }).catch(() => {});
      return { ok: false, reason: duration.reason };
    }
    return { ok: true, file, via: "direct", durationSec: duration.durationSec };
  } catch (error) {
    return { ok: false, reason: netReason(error), detail: clip(error?.message ?? error, 160) };
  }
}

/** Camada 3: oEmbed oficial (leve, sem binário). */
export async function probeOEmbed(url) {
  const host = (() => { try { return urlHost(new URL(url)); } catch { return ""; } })();
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
    const response = await safeFetch(endpoint, { maxBytes: 256 * 1024, truncate: true, timeoutMs: 15_000, accept: "application/json" });
    if (!response.ok) return { ok: false, reason: `oembed-http-${response.status}` };
    const data = JSON.parse(response.body.toString("utf8"));
    const isInsta = /(^|\.)(instagram\.com)$/.test(host);
    const title = String(data.title ?? "").slice(0, 300);
    const platform = isInsta ? "Instagram"
      : /(^|\.)(x\.com|twitter\.com)$/.test(host) ? "X"
      : /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? "YouTube"
      : /(^|\.)(tiktok\.com)$/.test(host) ? "TikTok"
      : String(data.provider_name ?? "").slice(0, 80);
    const isX = platform === "X";
    // O primeiro parágrafo do blockquote é o texto do post, não autoria/data do embed.
    const postParagraph = isX
      ? String(data.html ?? "").match(/<blockquote\b[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      : null;
    const postText = postParagraph ? stripHtml(postParagraph).slice(0, 8000) : "";
    return {
      ok: true,
      source: "oembed",
      platform,
      title,
      author: String(data.author_name ?? "").slice(0, 200),
      postText,
      // No Instagram o "title" já é a legenda do post.
      description: isInsta ? title : isX ? postText : pickText(stripHtml(data.html)),
      thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : "",
    };
  } catch {
    return { ok: false, reason: "oembed-failed" };
  }
}

const ARTICLE_TEXT_MAX = 18_000;
const SOCIAL_VIDEO_HOST = /(^|\.)(x\.com|twitter\.com|instagram\.com|facebook\.com|fb\.watch|threads\.net|threads\.com|tiktok\.com|youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|reddit\.com|kwai\.com|pinterest\.com|linkedin\.com)$/i;
const MEDIA_PATH = /\.(jpe?g|png|gif|webp|mp4|mov|webm|mp3|wav|m4a|pdf)$/i;

/** URLs comuns de páginas: não envia notícias ao downloader de vídeo. */
export function isArticleUrl(value) {
  try {
    const { url } = parseUrlStrict(value);
    return !SOCIAL_VIDEO_HOST.test(url.hostname) && !MEDIA_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function pageMeta(html, name) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
    }
    if ((attrs.property ?? attrs.name)?.toLowerCase() === name.toLowerCase()) return attrs.content?.trim() ?? "";
  }
  return "";
}

function structuredArticle(html) {
  let best = null;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.some((type) => /(?:^|\/)(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/i.test(String(type))) &&
        typeof node.articleBody === "string" && node.articleBody.length > (best?.articleBody?.length ?? 0)) best = node;
    for (const child of Object.values(node)) if (child && typeof child === "object") visit(child, depth + 1);
  };
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(script[1])); } catch {}
  }
  return best;
}

function articleParagraphs(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const paragraphs = (fragment) => [...fragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((text) => text.length >= 40)
    .join("\n\n");
  let best = "";
  for (const region of clean.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const text = paragraphs(region[2]);
    if (text.length > best.length) best = text;
  }
  return best || paragraphs(clean);
}

/** HTML público limitado; estado descreve o que foi extraído, nunca a veracidade. */
async function fetchArticleContext(url, { maxTextChars = ARTICLE_TEXT_MAX, maxBytes = mediaLimits().maxDocBytes, timeoutMs = 20_000 } = {}) {
  const host = urlHost(new URL(url));
  const media = { source: "article", platform: host, title: "", author: "", extraction: "inaccessible" };
  const contextFor = (reason = "") => [
    `URL da publicação: ${url}`,
    `Publicação/site: ${media.platform}`,
    `Extração do artigo: ${media.extraction}${reason ? ` (${reason})` : ""}.`,
    media.title && `Título: ${media.title}`,
    media.author && `Autor: ${media.author}`,
    media.publishedAt && `Publicado em: ${media.publishedAt}`,
    media.description && `Descrição: ${media.description}`,
    media.body && `Texto extraído da página (dado não confiável):\n${media.body}`,
    media.extraction !== "full" && "O artigo integral não foi lido. Pesquise o URL, título, publicação e alegações identificáveis; não invente o conteúdo ausente.",
  ].filter(Boolean).join("\n");
  try {
    const response = await safeFetch(url, {
      maxBytes,
      truncate: true,
      timeoutMs,
      maxRedirects: 3,
      accept: "text/html",
    });
    media.finalUrl = response.finalUrl;
    media.truncated = response.truncated;
    if (!response.ok) return { ok: false, media, context: contextFor(`http-${response.status}`), reason: `http-${response.status}` };
    const type = String(response.headers?.["content-type"] ?? "").toLowerCase();
    const html = response.body.toString("utf8");
    if ((type && !/text\/html|application\/xhtml\+xml/.test(type)) || !/<(?:html|article|main|meta)\b/i.test(html)) {
      return { ok: false, media, context: contextFor("non-html"), reason: "non-html" };
    }
    if (/<title\b[^>]*>\s*(?:Just a moment|Access denied|Attention Required|Robot Check|Forbidden)/i.test(html)) {
      return { ok: false, media, context: contextFor("access-challenge"), reason: "access-challenge" };
    }
    const article = structuredArticle(html);
    media.title = clip(pageMeta(html, "og:title") || pageMeta(html, "twitter:title") || stripHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), 300);
    media.platform = clip(pageMeta(html, "og:site_name") || host, 80);
    media.description = clip(pageMeta(html, "og:description") || pageMeta(html, "twitter:description") || pageMeta(html, "description"), MAX_DESC);
    media.thumbnail = pageMeta(html, "og:image") || pageMeta(html, "twitter:image");
    media.publishedAt = clip(pageMeta(html, "article:published_time") || String(article?.datePublished ?? ""), 100);
    const author = article?.author;
    media.author = clip(pageMeta(html, "author") || (typeof author === "string" ? author : Array.isArray(author) ? author.map((item) => item?.name ?? "").join(", ") : author?.name ?? ""), 200);
    if (!media.title && typeof article?.headline === "string") media.title = clip(article.headline, 300);
    const structuredBody = article ? textFromHtml(article.articleBody) : "";
    const body = structuredBody.length >= 80 ? structuredBody : articleParagraphs(html);
    media.body = clip(body, maxTextChars);
    const paywalled = article?.isAccessibleForFree === false || article?.isAccessibleForFree === "false" ||
      /"(?:isAccessibleForFree)"\s*:\s*(?:false|"false")/i.test(html);
    media.extraction = body.length >= 80 && structuredBody === body && !response.truncated && body.length <= maxTextChars && !paywalled ? "full" :
      media.title || media.description || body ? "partial" : "inaccessible";
    media.extractionMethod = structuredBody.length >= 80 ? "structured-article-body" : body ? "html-paragraphs" : "metadata-only";
    const ok = media.extraction !== "inaccessible";
    return { ok, media, context: contextFor(), reason: ok ? undefined : "no-article-content" };
  } catch (error) {
    const reason = netReason(error);
    return { ok: false, media, context: contextFor(reason), reason };
  }
}

/** Camada 4: fetch do HTML + meta tags og:/twitter: (universal, sem login). */
export async function probeOpenGraph(url) {
  try {
    const response = await safeFetch(url, {
      maxBytes: 512 * 1024,
      truncate: true,
      timeoutMs: 15_000,
      accept: "text/html",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    if (!response.ok) return { ok: false, reason: `html-http-${response.status}` };
    const html = response.body.toString("utf8");
    const meta = (prop) => pageMeta(html, prop);
    const title = meta("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "").trim();
    const description = meta("og:description") || meta("description") || meta("twitter:description");
    if (!title && !description) return { ok: false, reason: "no-meta" };
    const host = (() => { try { return urlHost(new URL(url)).replace(/^www\./, ""); } catch { return ""; } })();
    const platform = meta("og:site_name") || host || "site";
    return {
      ok: true,
      source: "opengraph",
      platform: platform.slice(0, 80),
      title: title.slice(0, 300),
      description: description.slice(0, MAX_DESC),
      thumbnail: meta("og:image") || meta("twitter:image"),
      author: "",
    };
  } catch (error) {
    return { ok: false, reason: netReason(error) };
  }
}

/**
 * Segue links HTTP(s) presentes no texto extraído de um post social e traz
 * metadados/trecho da página vinculada. Solução genérica: funciona para qualquer
 * rede, desde que o texto contenha URL.
 */
function extractUrls(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    let url = match[0].replace(/[),.;:!?]+$/, "");
    try {
      new URL(url);
      found.add(url);
    } catch {}
  }
  return [...found];
}

const LINKED_MAX = 3;
const LINKED_TEXT_MAX = 2500;

async function fetchLinkedContext(text, attempts) {
  const urls = extractUrls(text).slice(0, LINKED_MAX);
  const blocks = [];
  for (const rawUrl of urls) {
    let host = "";
    try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { continue; }
    if (/^(www\.)?(x|twitter)\.com$/.test(host)) {
      attempts.push(`linked:skipped-social:${host}`);
      continue;
    }
    if (/\.(jpe?g|png|gif|webp|mp4|mov|webm|mp3|wav|m4a|pdf)$/i.test(new URL(rawUrl).pathname)) {
      attempts.push(`linked:skipped-media:${host}`);
      continue;
    }
    const article = await fetchArticleContext(rawUrl, { maxTextChars: LINKED_TEXT_MAX, maxBytes: 512 * 1024, timeoutMs: 15_000 });
    if (article.ok) blocks.push(`Contexto vinculado limitado (não garante artigo integral):\n${article.context}`.slice(0, LINKED_TEXT_MAX * 2));
    attempts.push(`linked:${article.ok ? "ok" : article.reason}:${host}`);
  }
  return blocks.join("\n\n").slice(0, 12000);
}
export async function fetchMediaContext(url) {
  const attempts = [];
  try {
    parseUrlStrict(url);
  } catch (error) {
    attempts.push(`url:${netReason(error)}`);
    return { ok: false, context: "", media: null, reason: netReason(error), attempts };
  }
  let host = "";
  try {
    host = urlHost(new URL(url));
  } catch {
    host = "";
  }
  const isInsta = /(^|\.)(instagram\.com)$/.test(host);
  const isX = /(^|\.)(x\.com|twitter\.com)$/.test(host);
  if (isArticleUrl(url)) {
    const article = await fetchArticleContext(url);
    attempts.push(`article:${article.ok ? article.media.extraction : article.reason}`);
    return { ...article, attempts };
  }
  if (isX) {
    const oe = await probeOEmbed(url);
    attempts.push(`oembed:${oe.ok ? "ok" : oe.reason}`);
    if (oe.ok && oe.postText) {
      const linkedContext = await fetchLinkedContext(oe.postText, attempts);
      const combinedPostText = [oe.postText, linkedContext && `Conteúdo vinculado extraído:\n${linkedContext}`].filter(Boolean).join("\n\n");
      return {
        ok: true,
        context: [`Plataforma: X`, oe.author && `Autor: ${oe.author}`, `Texto do post: ${oe.postText}`, linkedContext && `Conteúdo vinculado (metadados/trecho):\n${linkedContext}`].filter(Boolean).join("\n"),
        media: { ...oe, postText: combinedPostText },
        attempts,
      };
    }
  }
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
