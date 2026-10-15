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
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { byteBudget, hostPolicy, parseUrlStrict, safeFetch, urlHost } from "./net.js";
import { runLimited } from "./proc.js";
import { clip, pageMeta, stripHtml, structuredArticle, textFromHtml } from "./text.js";
import { evidenceConfig, fetchDocument } from "./evidence.js";
import { inspectMediaFile, jpegIsDecodableCandidate, processMediaFile } from "./local-media.js";
import { classifySourceUrl } from "./source-type.js";
import { normalizeVerifyInput, uploadLimits } from "./uploads.js";

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
    presenceTimeoutMs: int(env.IEV_MEDIA_PRESENCE_TIMEOUT_MS, 30_000),
  };
}

const MAX_WORKER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_WORKER_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_WORKER_FRAMES_BYTES = 2_500_000;
const MAX_WORKER_FRAMES = 10;
function sanitizeDiagnostic(value, max = 160) {
  const safe = String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(token|secret|signature|sig|auth|key)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\/(?:tmp|var\/tmp)\/[^\s"'<>]+/g, "[path]");
  return clip(safe, max);
}

function diagnosticAttempt(stage, result) {
  const reason = result?.ok ? "ok" : result?.reason ?? "failed";
  const detail = result?.detail ? `:${sanitizeDiagnostic(result.detail)}` : "";
  return `${stage}:${reason}${detail}`;
}

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
    if (!response.ok) {
      if (path === "/media" && response.status === 404) {
        return { ok: false, reason: "worker-protocol-incompatible", detail: "Implante a versão atual do worker junto com o servidor." };
      }
      // O worker devolve motivos operacionais também com 4xx/503 (ex.: ocupado).
      try {
        const data = JSON.parse(response.body.toString("utf8"));
        if (data?.ok === false && typeof data.reason === "string") {
          return { ok: false, reason: sanitizeDiagnostic(data.reason), detail: sanitizeDiagnostic(data.detail) };
        }
      } catch { /* resposta não JSON: preserva o status */ }
      return { ok: false, reason: `worker-http-${response.status}` };
    }
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

/** Normaliza frames do worker e só retém JPEGs completos e dentro dos limites. */
export function normalizeWorkerFrames(value) {
  const frames = [];
  let bytes = 0;
  for (const item of Array.isArray(value) ? value : []) {
    if (frames.length >= MAX_WORKER_FRAMES) break;
    const data = typeof item === "string" ? item : item?.image_b64 ?? item?.data;
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const image = Buffer.from(data, "base64");
    if (image.toString("base64") !== data || !jpegIsDecodableCandidate(image)) continue;
    if (image.length > 600_000 || bytes + image.length > MAX_WORKER_FRAMES_BYTES) break;
    bytes += image.length;
    const seconds = Number(item?.timestamp_sec ?? item?.timestampSec);
    frames.push({ data, timestampSec: Number.isFinite(seconds) ? seconds : null });
  }
  return frames;
}

/** Resolves redirects and uses MIME/signature hints without retaining file bodies. */
export async function resolveSourceType(value) {
  const initial = classifySourceUrl(value);
  if (!initial.finalUrl) return initial;
  try {
    let response = await safeFetch(initial.finalUrl, {
      method: "HEAD",
      maxBytes: 8192,
      truncate: true,
      maxRedirects: 3,
      timeoutMs: 10_000,
      accept: "*/*",
    });
    let contentType = String(response.headers?.["content-type"] ?? "").toLowerCase().split(";")[0].trim();
    let contentPrefix = null;
    if ([405, 501].includes(response.status) || !contentType || contentType === "application/octet-stream") {
      const sample = await safeFetch(initial.finalUrl, {
        maxBytes: 8192,
        truncate: true,
        maxRedirects: 3,
        timeoutMs: 10_000,
        accept: "*/*",
      });
      if (sample.ok || [405, 501].includes(response.status)) {
        response = sample;
        contentType = String(sample.headers?.["content-type"] ?? contentType).toLowerCase().split(";")[0].trim();
        contentPrefix = sample.body;
      }
    }
    const finalUrl = response.finalUrl ?? initial.finalUrl;
    const resolved = classifySourceUrl(finalUrl, { contentType, contentPrefix });
    return { ...resolved, finalUrl, originalUrl: initial.finalUrl };
  } catch {
    return initial;
  }
}

/** Fetches a direct image under the existing upload cap and signature contract. */
export async function fetchImageSource(url) {
  const maxBytes = uploadLimits().maxFileBytes;
  try {
    const response = await safeFetch(url, {
      maxBytes,
      maxRedirects: 3,
      timeoutMs: 20_000,
      accept: "image/jpeg,image/png,image/webp",
    });
    if (!response.ok) return { ok: false, reason: `image-http-${response.status}` };
    const contentType = String(response.headers?.["content-type"] ?? "").toLowerCase().split(";")[0].trim();
    const normalized = normalizeVerifyInput({
      kind: "image",
      text: url,
      fileBuffer: response.body,
      fileMime: contentType,
    });
    return { ok: true, fileBuffer: normalized.fileBuffer, fileMime: normalized.fileMime, finalUrl: response.finalUrl };
  } catch (error) {
    return { ok: false, reason: ["unsupported_upload_type", "upload_too_large"].includes(error?.message) ? error.message : netReason(error) };
  }
}

/** Camada 0: delega probe ao worker remoto (Fly.io). */
async function probeViaWorker(url) {
  const data = await workerPost("/fetch", { url }, { timeoutMs: 90_000 });
  if (!data?.ok) return { ok: false, reason: data?.reason ?? "worker-probe-failed" };
  return { ok: true, source: "worker:yt-dlp", ...data.media, _context: data.context };
}

/** Camada 0 (áudio): worker valida a duração antes de enviar o artefato. */
async function downloadViaWorker(url, outDir) {
  const limits = mediaLimits();
  const data = await workerPost("/audio", { url });
  if (!data?.ok || typeof data.audio_b64 !== "string") return { ok: false, reason: data?.reason ?? "worker-audio-failed", detail: data?.detail };
  const seconds = Number(data.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "worker-duration-unavailable" };
  if (Math.ceil(seconds) > limits.maxMediaSeconds) return { ok: false, reason: `duration-limit:${Math.ceil(seconds)}s` };
  const encoded = data.audio_b64;
  if (encoded.length === 0 || encoded.length > Math.ceil(MAX_WORKER_AUDIO_BYTES / 3) * 4) return { ok: false, reason: "worker-audio-too-large" };
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_WORKER_AUDIO_BYTES || bytes.toString("base64") !== encoded) {
    return { ok: false, reason: "worker-audio-invalid" };
  }
  const base = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "iev-audio-"));
  const file = join(dir, "audio.mp3");
  try {
    await writeFile(file, bytes, { flag: "wx" });
    return { ok: true, file, dir, via: "worker", durationSec: Math.ceil(seconds), hasAudio: data.has_audio !== false, hasVideo: data.has_video === true };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: "worker-audio-invalid", detail: sanitizeDiagnostic(error?.message) };
  }
}

/** Duração, streams e legibilidade são exigidos antes de liberar um artefato local. */
export async function enforceDuration(file, maxSeconds) {
  return inspectMediaFile(file, maxSeconds);
}

/** Valida os mesmos artefatos para upload e extração remota de URL. */
async function consumeWorkerExtraction(data, via) {
  const limits = mediaLimits();
  if (!data?.ok) {
    const reason = via === "worker-upload" && /payload|too-large/.test(String(data?.reason ?? "")) ? "upload-too-large" : data?.reason ?? "worker-extraction-failed";
    return { ok: false, reason, detail: sanitizeDiagnostic(data?.detail, 160) };
  }
  const seconds = Number(data.duration_sec);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "worker-duration-unavailable" };
  const durationSec = Math.ceil(seconds);
  if (durationSec > limits.maxMediaSeconds) return { ok: false, reason: `duration-limit:${durationSec}s` };
  let audio = null;
  let audioReason = data.audio_reason ?? null;
  let audioDir = null;
  try {
    if (data.audio?.audio_b64 != null) {
      const encoded = data.audio.audio_b64;
      if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(MAX_WORKER_AUDIO_BYTES / 3) * 4) {
        audioReason = "worker-audio-invalid";
      } else {
        const audioBytes = Buffer.from(encoded, "base64");
        if (audioBytes.length === 0 || audioBytes.length > MAX_WORKER_AUDIO_BYTES || audioBytes.toString("base64") !== encoded) {
          audioReason = "worker-audio-invalid";
        } else {
          audioDir = await mkdtemp(join(tmpdir(), "iev-worker-"));
          const file = join(audioDir, "audio.mp3");
          await writeFile(file, audioBytes, { flag: "wx" });
          audio = { ok: true, file, dir: audioDir, via };
        }
      }
    }
    const frames = normalizeWorkerFrames(data.frames);
    const frameReason = frames.length ? null : data.frame_reason ?? "no-frames";
    if (!audio && !frames.length) {
      if (audioDir) await rm(audioDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: audioReason ?? frameReason ?? "no-readable-media" };
    }
    const hasAudio = Boolean(audio) || data.has_audio === true;
    const hasVideo = data.has_video === true || frames.length > 0;
    return { ok: true, audio, frames, count: frames.length, durationSec, via, audioReason, frameReason, hasAudio, hasVideo, dir: audioDir };
  } catch (error) {
    if (audioDir) await rm(audioDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: "worker-artifact-invalid", detail: sanitizeDiagnostic(error?.message) };
  }
}

/** Processa upload localmente quando não há worker; serverless permanece fail-closed. */
export async function processUploadedMedia(fileBuffer, mime) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) return { ok: false, reason: "empty-upload" };
  const limits = mediaLimits();
  if (WORKER_URL) {
    const data = await workerPost("/upload", { file_b64: fileBuffer.toString("base64"), mime });
    return consumeWorkerExtraction(data, "worker-upload");
  }

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return { ok: false, reason: "worker-unavailable-serverless" };
  if (!/^audio\//.test(mime) && !/^video\//.test(mime)) return { ok: false, reason: "unsupported-media-type" };

  const dir = await mkdtemp(join(tmpdir(), "iev-upload-local-"));
  const extension = ({ "video/quicktime": "mov", "video/webm": "webm", "audio/webm": "webm", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "mp4", "video/mp4": "mp4" })[mime] ?? "media";
  const file = join(dir, `source.${extension}`);
  try {
    await writeFile(file, fileBuffer, { flag: "wx" });
    const result = await processMediaFile(file, dir, {
      maxMediaSeconds: limits.maxMediaSeconds,
      maxTempBytes: limits.maxTempBytes,
      maxAudioBytes: MAX_WORKER_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
    });
    if (!result.ok) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return result;
    }
    const audio = result.audioBytes
      ? { ok: true, file: join(dir, "audio.mp3"), dir, via: "local-upload" }
      : null;
    if (!audio) await rm(join(dir, "audio.mp3"), { force: true }).catch(() => {});
    return { ...result, audio, via: "local-upload", dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: "local-media-processing-failed", detail: sanitizeDiagnostic(error?.message) };
  }
}


let ytdlpAvailable = null;

export async function hasYtDlp({ timeoutMs = 4_000 } = {}) {
  if (ytdlpAvailable !== null) return ytdlpAvailable;
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: Math.min(4_000, timeoutMs) });
    ytdlpAvailable = true;
  } catch (error) {
    // Um orçamento curto não prova que o executável está ausente.
    if (error?.killed) return false;
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
export async function probeWithYtDlp(url, { timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now();
  const available = await hasYtDlp({ timeoutMs });
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return { ok: false, reason: "ytdlp-timeout" };
  if (!available) return { ok: false, reason: "no-ytdlp" };
  const run = await runLimited(
    "yt-dlp",
    ["--no-playlist", "--dump-json", "--no-warnings", "--socket-timeout", "20", "--retries", "1", url],
    { timeoutMs: remainingMs, maxOutputBytes: 8 * 1024 * 1024 },
  );
  if (!run.ok) {
    return { ok: false, reason: run.reason === "timeout" ? "ytdlp-timeout" : "ytdlp-failed", detail: sanitizeDiagnostic(run.stderr, 200) };
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
      hasAudio: typeof info.acodec === "string" ? info.acodec !== "none" : null,
      hasVideo: typeof info.vcodec === "string" ? info.vcodec !== "none" : null,
      description: desc,
      thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : "",
      mediaUrl: typeof info.url === "string" ? info.url : "",
      id: String(info.id ?? ""),
    };
  } catch (err) {
    return { ok: false, reason: "ytdlp-bad-json", detail: clip(err?.message ?? err, 300) };
  }
}

/**
 * Sinais definitivos do yt-dlp de que o alvo não tem áudio/vídeo (não é falha
 * operacional). O worker novo também devolve reason "no-media"; o padrão no
 * detalhe sanitizado cobre worker antigo durante a transição de implantação.
 */
const NO_MEDIA_PATTERN = /no video could be found|no video formats|no media found/i;

/**
 * Confirma presença de áudio/vídeo antes de anunciar a aquisição. `hasMedia`
 * `true`/`false` são conclusivos; `null` é indeterminado (falha operacional) e
 * nunca bloqueia o fluxo normal de download.
 */
export async function probeMediaPresence(url, { timeoutMs = mediaLimits().presenceTimeoutMs } = {}) {
  const attempts = [];
  if (WORKER_URL) {
    // O subprocesso deve terminar e liberar a vaga antes do timeout HTTP.
    const workerBudgetMs = Math.max(1, Math.floor(timeoutMs - Math.min(1000, timeoutMs / 5)));
    const data = await workerPost("/fetch", { url, timeout_ms: workerBudgetMs }, { timeoutMs });
    if (data?.ok) {
      const media = data.media ?? {};
      const hasMedia = media.hasVideo === true || media.hasAudio === true;
      const none = media.hasVideo === false && media.hasAudio === false;
      attempts.push(`worker-presence:ok:${hasMedia ? "media" : none ? "no-media" : "unknown"}`);
      return { ok: true, hasMedia: hasMedia ? true : none ? false : null, media, attempts };
    }
    const noMedia = data?.reason === "no-media" ||
      (data?.reason !== "worker-timeout" && NO_MEDIA_PATTERN.test(String(data?.detail ?? "")));
    attempts.push(diagnosticAttempt("worker-presence", data));
    return { ok: false, hasMedia: noMedia ? false : null, reason: data?.reason ?? "worker-presence-failed", attempts };
  }
  const yt = await probeWithYtDlp(url, { timeoutMs });
  if (yt.ok) {
    const hasMedia = yt.hasVideo === true || yt.hasAudio === true;
    const none = yt.hasVideo === false && yt.hasAudio === false;
    attempts.push(`yt-dlp-presence:ok:${hasMedia ? "media" : none ? "no-media" : "unknown"}`);
    return { ok: true, hasMedia: hasMedia ? true : none ? false : null, media: yt, attempts };
  }
  const noMedia = NO_MEDIA_PATTERN.test(String(yt.detail ?? ""));
  attempts.push(diagnosticAttempt("yt-dlp-presence", yt));
  return { ok: false, hasMedia: noMedia ? false : null, reason: yt.reason, attempts };
}

/**
 * Caminho da checagem: uma aquisição gera áudio e frames do mesmo arquivo.
 * Evita dois downloads e duas vagas do worker para um único vídeo.
 */
export async function downloadMedia(url, outDir = "./media-tmp", sourceType = null) {
  const source = sourceType ? { type: sourceType } : classifySourceUrl(url);
  const directAsset = ["audio", "video"].includes(source.type);
  const attempts = [];
  let result;
  if (directAsset && !WORKER_URL) {
    result = await downloadDirectAsset(url, outDir, "both");
    attempts.push(diagnosticAttempt("direct-media", result));
  } else if (WORKER_URL) {
    const data = await workerPost("/media", { url, source_type: directAsset ? source.type : null });
    result = await consumeWorkerExtraction(data, "worker");
    attempts.push(diagnosticAttempt("worker-media", result));
    // Worker configurado não muda para ferramentas locais após uma falha.
  } else {
    result = await downloadViaYtDlp(url, outDir, "both");
    attempts.push(diagnosticAttempt("yt-dlp-media", result));
    if (!result.ok) {
      const budget = byteBudget(mediaLimits().maxTransferBytes);
      try {
        const direct = await directVideoUrl(url, budget);
        result = direct.ok ? await downloadDirectAsset(direct.url, outDir, "both", budget) : direct;
      } catch (error) {
        result = { ok: false, reason: netReason(error) };
      }
      attempts.push(diagnosticAttempt("og-video-media", result));
    }
  }
  const shared = { hasAudio: result?.hasAudio, hasVideo: result?.hasVideo, durationSec: result?.durationSec };
  return {
    ok: result?.ok === true,
    reason: result?.reason,
    attempts,
    audio: result?.audio ? { ...result.audio, ...shared } : { ok: false, reason: result?.audioReason ?? result?.reason ?? "no-audio-track", ...shared },
    frameResult: {
      ok: Boolean(result?.frames?.length),
      frames: result?.frames ?? [],
      seconds: result?.durationSec,
      via: result?.via,
      reason: source.type === "audio" ? "not-applicable-audio" : result?.frameReason ?? result?.reason ?? "no-frames",
      ...shared,
    },
  };
}

/** Camada 2: áudio — worker remoto, yt-dlp local ou URL og:video validada. */
export async function downloadAudio(url, outDir = "./media-tmp", sourceType = null) {
  const attempts = [];
  const source = sourceType ? { type: sourceType } : classifySourceUrl(url);
  const hasYtdlp = await hasYtDlp();
  if (!hasYtdlp && WORKER_URL) {
    const result = await downloadViaWorker(url, outDir);
    attempts.push(diagnosticAttempt("worker-audio", result));
    if (result.ok) return { ...result, attempts };
  }
  if (hasYtdlp) {
    const result = await downloadViaYtDlp(url, outDir);
    attempts.push(diagnosticAttempt("yt-dlp-audio", result));
    if (result.ok) return { ...result, attempts };
  }
  const direct = source.type === "audio" || source.type === "video"
    ? await downloadDirectAsset(url, outDir, "audio")
    : await downloadViaDirectUrl(url, outDir);
  attempts.push(diagnosticAttempt(source.type === "audio" || source.type === "video" ? "direct-media-audio" : "og-video-audio", direct));
  return { ...direct, attempts };
}

async function mediaTempDir(outDir, prefix) {
  const base = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? tmpdir() : outDir;
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

function subprocessReason(run, stage, fallback) {
  if (run?.killed) {
    if (run.reason === "disk_limit") return "disk-limit";
    if (run.reason === "timeout") return `${stage}-timeout`;
    return `kill:${run.reason}`;
  }
  if (run?.reason === "spawn_failed" && /ENOENT/i.test(run.stderr)) return `${stage}-unavailable`;
  if (/larger than max-filesize/i.test(run?.stderr ?? "")) return "file-too-large";
  return fallback;
}

async function downloadViaYtDlp(url, outDir, mode = "audio") {
  const limits = mediaLimits();
  if (!(await hasYtDlp())) return { ok: false, reason: "no-ytdlp" };
  const dir = await mediaTempDir(outDir, "iev-audio-");
  const maxBytes = Math.min(limits.maxTransferBytes, limits.maxFileBytes);
  let keep = false;
  try {
    const run = await runLimited(
      "yt-dlp",
      [
        "--no-playlist", "-f", mode === "both" ? "worst[height<=480][acodec!=none]/best[height<=480][acodec!=none]/worst" : "bestaudio/best",
        "--no-warnings", "--no-progress", "--retries", "2", "--socket-timeout", "20",
        "--max-filesize", String(maxBytes),
        "--extractor-args", "youtube:player_client=android,web",
        "-o", join(dir, "source.%(ext)s"), url,
      ],
      { timeoutMs: limits.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: limits.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (!run.ok) return { ok: false, reason: subprocessReason(run, "download", "download-failed"), detail: sanitizeDiagnostic(run.stderr, 200) };
    const names = await readdir(dir);
    const name = names.find((candidate) => /^source\.[^.]+$/i.test(candidate) && !candidate.endsWith(".part"));
    if (!name) return { ok: false, reason: "no-file" };
    const file = join(dir, name);
    const size = (await stat(file)).size;
    if (size <= 0) return { ok: false, reason: "media-unreadable" };
    if (size > maxBytes) return { ok: false, reason: "file-too-large" };
    const extracted = await processMediaFile(file, dir, {
      maxMediaSeconds: limits.maxMediaSeconds,
      maxTempBytes: limits.maxTempBytes,
      maxAudioBytes: MAX_WORKER_AUDIO_BYTES,
      extractFrames: mode === "both",
    });
    if (!extracted.ok) return extracted;
    if (mode === "both") {
      const audio = extracted.audioBytes ? { ok: true, file: join(dir, "audio.mp3"), dir, via: "yt-dlp" } : null;
      keep = Boolean(audio);
      return { ...extracted, audio, dir: audio ? dir : null, via: "yt-dlp" };
    }
    if (!extracted.audioBytes) return { ok: false, reason: extracted.audioReason ?? "no-audio-track", hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
    keep = true;
    return { ok: true, file: join(dir, "audio.mp3"), dir, via: "yt-dlp", durationSec: extracted.durationSec, hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
  } catch (error) {
    return { ok: false, reason: "download-failed", detail: sanitizeDiagnostic(error?.message, 200) };
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Camada 2b: frames — worker remoto, yt-dlp local ou URL og:video validada. */
export async function downloadFrames(url, sourceType = null) {
  const attempts = [];
  const source = sourceType ? { type: sourceType } : classifySourceUrl(url);
  if (source.type === "audio") return { ok: false, reason: "not-applicable-audio", attempts: [] };
  const hasYtdlp = await hasYtDlp();
  let workerTried = false;
  if (!hasYtdlp && WORKER_URL) {
    const result = await framesViaWorker(url);
    attempts.push(diagnosticAttempt("worker-frames", result));
    workerTried = true;
    if (result.ok) return { ...result, attempts };
  }
  if (hasYtdlp) {
    const result = await framesViaYtDlp(url);
    attempts.push(diagnosticAttempt("yt-dlp-frames", result));
    if (result.ok) return { ...result, attempts };
  }
  if (WORKER_URL && !workerTried) {
    const result = await framesViaWorker(url);
    attempts.push(diagnosticAttempt("worker-frames", result));
    if (result.ok) return { ...result, attempts };
  }
  const direct = source.type === "audio" || source.type === "video"
    ? await downloadDirectAsset(url, "./media-tmp", "frames")
    : await framesViaDirectUrl(url);
  attempts.push(diagnosticAttempt("direct-video-frames", direct));
  return { ...direct, attempts };
}

const MAX_FRAMES = 10;
const MAX_FRAMES_BYTES = 2_500_000;

async function framesViaWorker(url) {
  const data = await workerPost("/frames", { url });
  if (!data?.ok) return { ok: false, reason: data?.reason ?? "worker-frames-failed", detail: data?.detail };
  const seconds = Number(data.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "worker-duration-unavailable" };
  if (Math.ceil(seconds) > mediaLimits().maxMediaSeconds) return { ok: false, reason: `duration-limit:${Math.ceil(seconds)}s` };
  const frames = normalizeWorkerFrames(data.frames);
  if (!frames.length) return { ok: false, reason: data.reason ?? "no-frames", hasAudio: data.has_audio === true, hasVideo: data.has_video === true };
  return { ok: true, frames, count: frames.length, seconds: Math.ceil(seconds), via: "worker", hasAudio: data.has_audio === true, hasVideo: data.has_video === true };
}

async function framesViaYtDlp(url) {
  const limits = mediaLimits();
  const dir = await mediaTempDir("./media-tmp", "iev-frames-");
  const maxBytes = Math.min(limits.maxFileBytes, limits.maxTransferBytes);
  try {
    const download = await runLimited(
      "yt-dlp",
      [
        "--no-playlist", "-f", "worst[height<=480]/best[height<=480]/worst",
        "--no-warnings", "--no-progress", "--socket-timeout", "20", "--retries", "2",
        "--max-filesize", String(maxBytes),
        "--extractor-args", "youtube:player_client=android,web",
        "-o", join(dir, "source.%(ext)s"), url,
      ],
      { timeoutMs: limits.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: limits.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (!download.ok) return { ok: false, reason: subprocessReason(download, "download", "download-failed"), detail: sanitizeDiagnostic(download.stderr, 200) };
    const names = await readdir(dir);
    const srcName = names.find((name) => /^source\.(?!part$)[^.]+$/i.test(name) && !name.endsWith(".part"));
    if (!srcName) return { ok: false, reason: "no-file" };
    const src = join(dir, srcName);
    const size = (await stat(src)).size;
    if (size <= 0) return { ok: false, reason: "media-unreadable" };
    if (size > maxBytes) return { ok: false, reason: "file-too-large" };
    const extracted = await processMediaFile(src, dir, {
      maxMediaSeconds: limits.maxMediaSeconds,
      maxTempBytes: limits.maxTempBytes,
      extractAudio: false,
      extractFrames: true,
    });
    if (!extracted.ok) return extracted;
    return { ok: true, frames: extracted.frames, count: extracted.frames.length, seconds: extracted.durationSec, via: "yt-dlp", hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
  } catch (error) {
    return { ok: false, reason: "frames-failed", detail: sanitizeDiagnostic(error?.message, 200) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Stable network reasons; safeFetch revalidates every redirect destination. */
function netReason(error) {
  const code = error?.code ?? "network_failed";
  if (["private_address", "private_hostname", "port_not_allowed", "bad_protocol", "bad_url", "url_credentials"].includes(code)) return `blocked:${code}`;
  if (code === "too_large") return "file-too-large";
  if (code === "budget_exhausted") return "byte-budget-exhausted";
  if (code === "timeout") return "download-timeout";
  if (code === "too_many_redirects") return "too-many-redirects";
  return `net:${code}`;
}

async function downloadDirectAsset(url, outDir, mode, budget = byteBudget(mediaLimits().maxTransferBytes)) {
  const limits = mediaLimits();
  let dir = null;
  try {
    const response = await safeFetch(url, {
      maxBytes: Math.min(limits.maxFileBytes, budget.remaining()),
      timeoutMs: 90_000,
      maxRedirects: 3,
      budget,
      accept: "video/*,audio/*,application/octet-stream",
    });
    if (!response.ok) return { ok: false, reason: `direct-http-${response.status}` };
    const contentType = String(response.headers?.["content-type"] ?? "").toLowerCase().split(";")[0].trim();
    if (contentType && !contentType.startsWith("video/") && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      return { ok: false, reason: "unsupported-media-content-type" };
    }
    if (!response.body?.length) return { ok: false, reason: "media-unreadable" };
    dir = await mediaTempDir(outDir, "iev-direct-");
    const sourceFile = join(dir, "source.bin");
    await writeFile(sourceFile, response.body, { flag: "wx" });
    const extracted = await processMediaFile(sourceFile, dir, {
      maxMediaSeconds: limits.maxMediaSeconds,
      maxTempBytes: limits.maxTempBytes,
      maxAudioBytes: MAX_WORKER_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
      extractAudio: mode !== "frames",
      extractFrames: mode !== "audio",
    });
    if (!extracted.ok) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return extracted;
    }
    if (mode === "both") {
      const audio = extracted.audioBytes ? { ok: true, file: join(dir, "audio.mp3"), dir, via: "direct" } : null;
      if (!audio) await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ...extracted, audio, dir: audio ? dir : null, via: "direct" };
    }
    if (mode === "audio") {
      if (!extracted.audioBytes) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return { ok: false, reason: extracted.audioReason ?? "no-audio-track", hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
      }
      return { ok: true, file: join(dir, "audio.mp3"), dir, via: "direct", durationSec: extracted.durationSec, hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
    }
    if (!extracted.frames.length) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: extracted.frameReason ?? "no-video-track", hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, frames: extracted.frames, count: extracted.frames.length, seconds: extracted.durationSec, via: "direct", hasAudio: extracted.hasAudio, hasVideo: extracted.hasVideo };
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: netReason(error), detail: sanitizeDiagnostic(error?.message, 160) };
  }
}

async function directVideoUrl(url, budget) {
  const page = await safeFetch(url, {
    maxBytes: 512 * 1024,
    truncate: true,
    timeoutMs: 20_000,
    headers: { Accept: "text/html" },
    budget,
  });
  if (!page.ok) return { ok: false, reason: `direct-http-${page.status}` };
  const html = page.body.toString("utf8");
  const direct = pageMeta(html, "og:video:secure_url") || pageMeta(html, "og:video") || pageMeta(html, "twitter:player:stream");
  if (!direct) return { ok: false, reason: "no-direct-video-url" };
  try {
    const parsed = parseUrlStrict(new URL(direct, page.finalUrl).href);
    return { ok: true, url: parsed.url.href };
  } catch (error) {
    return { ok: false, reason: `direct-${netReason(error)}` };
  }
}

async function downloadViaDirectUrl(url, outDir) {
  const limits = mediaLimits();
  const budget = byteBudget(limits.maxTransferBytes);
  try {
    const direct = await directVideoUrl(url, budget);
    if (!direct.ok) return direct;
    return await downloadDirectAsset(direct.url, outDir, "audio", budget);
  } catch (error) {
    return { ok: false, reason: netReason(error), detail: sanitizeDiagnostic(error?.message, 160) };
  }
}

async function framesViaDirectUrl(url) {
  const limits = mediaLimits();
  const budget = byteBudget(limits.maxTransferBytes);
  try {
    const direct = await directVideoUrl(url, budget);
    if (!direct.ok) return direct;
    return await downloadDirectAsset(direct.url, "./media-tmp", "frames", budget);
  } catch (error) {
    return { ok: false, reason: netReason(error), detail: sanitizeDiagnostic(error?.message, 160) };
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

async function fetchPdfContext(url, config = evidenceConfig()) {
  const host = urlHost(new URL(url));
  const document = await fetchDocument(url, { config });
  const media = {
    source: "document",
    format: "pdf",
    platform: host,
    finalUrl: document.finalUrl ?? url,
    truncated: Boolean(document.truncated),
    extraction: document.ok ? document.truncated ? "partial" : "full" : "inaccessible",
    extractionMethod: "unpdf",
    body: document.ok ? document.text : "",
  };
  if (!document.ok) {
    const reason = document.reason ?? "pdf-text-unavailable";
    return {
      ok: false,
      reason,
      media,
      context: `Documento PDF: o texto não pôde ser extraído (${reason}). PDF escaneado ou sem texto permanece sem leitura; não use metadados como transcrição.`,
    };
  }
  return {
    ok: true,
    media,
    context: `Documento PDF obtido (${media.extraction === "partial" ? "texto limitado pelo teto" : "texto extraído"}; conteúdo não confiável):\n${document.text}${document.truncated ? "\nO documento foi truncado pelo teto; o texto não é integral." : ""}`,
  };
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

async function fetchLinkedContext(text, attempts, sourceUrl = "") {
  const urls = extractUrls(text).slice(0, LINKED_MAX);
  const blocks = [];
  let ownUrl = "";
  try { ownUrl = new URL(sourceUrl).href; } catch {}
  for (const rawUrl of urls) {
    let normalized;
    try { normalized = new URL(rawUrl); } catch { continue; }
    const host = normalized.hostname.toLowerCase().slice(0, 120);
    if (normalized.href === ownUrl) {
      attempts.push(`linked:skipped-self:${host}`);
      continue;
    }
    const source = await resolveSourceType(normalized.href);
    if (source.social) {
      attempts.push(`linked:skipped-social:${host}`);
      continue;
    }
    if (["image", "audio", "video", "unsupported"].includes(source.type)) {
      attempts.push(`linked:skipped-media:${host}`);
      continue;
    }
    if (source.type === "pdf") {
      const config = evidenceConfig({
        ...process.env,
        IEV_MAX_DOC_BYTES: String(512 * 1024),
        IEV_EVIDENCE_TIMEOUT_MS: "15000",
        IEV_EVIDENCE_MAX_TEXT_CHARS: String(LINKED_TEXT_MAX),
      });
      const pdf = await fetchPdfContext(source.finalUrl ?? normalized.href, config);
      if (pdf.ok) blocks.push(`Conteúdo documental vinculado (PDF, texto limitado):\n${pdf.context}`.slice(0, LINKED_TEXT_MAX * 2));
      attempts.push(`linked:${pdf.ok ? "ok" : pdf.reason}:${host}`);
      continue;
    }
    const article = await fetchArticleContext(source.finalUrl ?? normalized.href, { maxTextChars: LINKED_TEXT_MAX, maxBytes: 512 * 1024, timeoutMs: 15_000 });
    if (article.ok) blocks.push(`Contexto vinculado limitado (não garante artigo integral):\n${article.context}`.slice(0, LINKED_TEXT_MAX * 2));
    attempts.push(`linked:${article.ok ? "ok" : article.reason}:${host}`);
  }
  return blocks.join("\n\n").slice(0, 12000);
}
function socialPostText(media) {
  const ignored = /^(?:x|twitter|instagram|tiktok|facebook|threads|reddit|kwai|linkedin|pinterest|spotify|youtube)(?:\s+(?:video|post|profile))?$/i;
  for (const candidate of [media?.postText, media?.description]) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (text && !ignored.test(text)) return text.slice(0, 8000);
  }
  return "";
}

async function withLinkedPostText(media, context, attempts, url) {
  const postText = socialPostText(media);
  const linkedContext = postText ? await fetchLinkedContext(postText, attempts, url) : "";
  const lines = [
    context,
    postText && `Texto do post: ${postText}`,
    linkedContext && `Conteúdo vinculado (metadados/trecho):\n${linkedContext}`,
  ].filter(Boolean);
  return { ok: true, context: lines.join("\n"), media: { ...media, postText, linkedContext }, attempts };
}

function isHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export async function fetchMediaContext(url, { sourceInfo = null } = {}) {
  const attempts = [];
  try {
    parseUrlStrict(url);
  } catch (error) {
    attempts.push(`url:${netReason(error)}`);
    return { ok: false, context: "", media: null, reason: netReason(error), attempts };
  }
  const source = sourceInfo ?? await resolveSourceType(url);
  const targetUrl = source.finalUrl ?? url;
  attempts.push(`source:${source.type}`);
  if (source.type === "unsupported") {
    return { ok: false, context: "Formato de arquivo não suportado para leitura direta. Envie texto ou um arquivo em formato compatível.", media: { source: "unsupported", finalUrl: targetUrl }, reason: "unsupported-format", attempts };
  }
  if (source.type === "pdf") {
    const pdf = await fetchPdfContext(targetUrl);
    attempts.push(`pdf:${pdf.ok ? pdf.media.extraction : pdf.reason}`);
    return { ...pdf, attempts };
  }
  if (["image", "audio", "video"].includes(source.type)) {
    return { ok: false, context: "", media: { source: source.type, finalUrl: targetUrl }, reason: `direct-${source.type}-requires-reader`, attempts };
  }
  const host = source.host ?? urlHost(new URL(targetUrl));
  const isInsta = isHost(host, "instagram.com");
  const isX = isHost(host, "x.com") || isHost(host, "twitter.com");
  if (source.type === "html") {
    const article = await fetchArticleContext(targetUrl);
    attempts.push(`article:${article.ok ? article.media.extraction : article.reason}`);
    return { ...article, attempts };
  }
  if (isX || isInsta) {
    const oe = await probeOEmbed(targetUrl);
    attempts.push(`oembed:${oe.ok ? "ok" : oe.reason}`);
    if (oe.ok) {
      const platform = isX ? "X" : "Instagram";
      const lines = [`Plataforma: ${platform}`, oe.author && `Autor: ${oe.author}`].filter(Boolean).join("\n");
      return withLinkedPostText(oe, lines, attempts, targetUrl);
    }
  }
  if (!(await hasYtDlp()) && WORKER_URL) {
    const w = await probeViaWorker(targetUrl);
    attempts.push(diagnosticAttempt("worker-probe", w));
    if (w.ok) {
      const lines = w._context ?? `Plataforma: ${w.platform ?? host}`;
      return withLinkedPostText(w, lines, attempts, targetUrl);
    }
  }
  const yt = await probeWithYtDlp(targetUrl);
  attempts.push(diagnosticAttempt("yt-dlp-probe", yt));
  if (yt.ok) {
    const lines = [
      `Plataforma: ${yt.platform}`,
      yt.title && `Título: ${yt.title}`,
      yt.author && `Autor: ${yt.author}`,
      yt.publishedAt && `Publicado em: ${yt.publishedAt}`,
      yt.durationSec && `Duração: ${yt.durationSec}s (vídeo/áudio)`,
      yt.description && `Descrição/texto do post: ${yt.description}`,
    ].filter(Boolean).join("\n");
    return withLinkedPostText(yt, lines, attempts, targetUrl);
  }
  const oe = await probeOEmbed(targetUrl);
  attempts.push(`oembed:${oe.ok ? "ok" : oe.reason}`);
  if (oe.ok) {
    const lines = [`Plataforma: ${oe.platform ?? host}`, oe.author && `Autor: ${oe.author}`, oe.title && `Título: ${oe.title}`].filter(Boolean).join("\n");
    return withLinkedPostText(oe, lines, attempts, targetUrl);
  }
  const og = await probeOpenGraph(targetUrl);
  attempts.push(`opengraph:${og.ok ? "ok" : og.reason}`);
  if (og.ok) {
    const lines = [`Plataforma: ${og.platform ?? host}`, og.title && `Título: ${og.title}`].filter(Boolean).join("\n");
    return withLinkedPostText(og, lines, attempts, targetUrl);
  }
  return { ok: false, context: "", media: null, attempts };
}
