// Worker de mídia (roda no Fly.io com yt-dlp + ffmpeg).
// Endpoints (todos exigem Authorization: Bearer <WORKER_SECRET>, exceto /health):
//   GET  /health          → { ok, ytdlp, busy, limits }
//   POST /fetch { url }    → { ok, context, media, attempts } (metadados, sem baixar)
//   POST /audio { url }    → { ok, audio_b64, mime } ou { ok:false, reason }
//   POST /frames { url }   → { ok, frames: [jpeg_b64], count, seconds } — OCR/visão
//   POST /media { url, source_type? } → áudio + frames de uma única aquisição
//   POST /upload { file_b64, mime } → áudio MP3 + frames do arquivo enviado
// Segurança:
//   - Sem WORKER_SECRET o processo recusa iniciar (WORKER_ALLOW_INSECURE=1 só em dev).
//   - Toda URL é validada aqui também (net.js): destino público, sem credenciais,
//     porta permitida — a validação da aplicação não é considerada suficiente.
//   - WORKER_EGRESS_PROXY (opcional) repassa um proxy de saída ao yt-dlp para a
//     plataforma bloquear redes internas mesmo em manifests/segmentos.
// Limites: áudio até 20MB, frames até 10 e 2.5MB, duração IEV_MAX_MEDIA_SECONDS,
// disco IEV_MAX_TEMP_BYTES (vigia mata a árvore de processos), concorrência limitada.
import { createServer } from "node:http";
import { readdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { hostPolicy, parseUrlStrict, resolvePublicHost, safeFetch } from "../server/net.js";
import { runLimited } from "../server/proc.js";
import { processMediaFile } from "../server/local-media.js";

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.WORKER_SECRET || "";
const ALLOW_INSECURE = process.env.WORKER_ALLOW_INSECURE === "1";
const EGRESS_PROXY = process.env.WORKER_EGRESS_PROXY || "";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_FRAMES = 10;
const MAX_FRAMES_BYTES = 2_500_000;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const UPLOAD_MIMES = new Set([
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg",
]);

function intEnv(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}

const LIMITS = {
  maxMediaSeconds: intEnv(process.env.IEV_MAX_MEDIA_SECONDS, 900),
  maxTempBytes: intEnv(process.env.IEV_MAX_TEMP_BYTES, 256 * 1024 * 1024),
  maxFileBytes: intEnv(process.env.IEV_MAX_MEDIA_FILE_BYTES, 32 * 1024 * 1024),
  maxTransferBytes: intEnv(process.env.IEV_MAX_DOWNLOAD_BYTES, 64 * 1024 * 1024),
  ytdlpTimeoutMs: intEnv(process.env.IEV_YTDLP_TIMEOUT_MS, 150_000),
  concurrency: intEnv(process.env.IEV_WORKER_CONCURRENCY, 2),
};

let busy = 0;

function limitReason() {
  return busy >= LIMITS.concurrency ? "worker-busy" : null;
}

function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new Error("payload too large"));
      return;
    }
    let data = "";
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new Error("payload too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!failed) resolve(data);
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function authorized(req) {
  if (!SECRET) return false; // sem segredo o worker recusa tudo (ver item de startup)
  return req.headers.authorization === `Bearer ${SECRET}`;
}

/** Valida a URL antes de entregar ao yt-dlp: destino público, porta e esquema. */
async function guardUrl(url) {
  const { host } = parseUrlStrict(url, { policy: hostPolicy() });
  await resolvePublicHost(host, { policy: hostPolicy() });
  return url;
}

function ytdlpArgs(extra, url) {
  return [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--socket-timeout", "20",
    "--retries", "2",
    "--max-filesize", String(LIMITS.maxFileBytes),
    ...(EGRESS_PROXY ? ["--proxy", EGRESS_PROXY] : []),
    ...extra,
    url,
  ];
}

async function probe(url) {
  const run = await runLimited("yt-dlp", ytdlpArgs(["--dump-json"], url), {
    timeoutMs: 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (!run.ok) {
    // "Post sem áudio/vídeo" é conclusivo e não deve ser confundido com falha operacional.
    const noMedia = /no video could be found|no video formats|no media found/i.test(run.stderr ?? "");
    return {
      ok: false,
      reason: noMedia ? "no-media" : run.reason === "timeout" ? "probe-timeout" : "probe-failed",
      detail: safeDetail(run.stderr),
    };
  }
  const info = JSON.parse(run.stdout);
  const desc = [info.description, info.title].find((s) => typeof s === "string" && s.trim()) ?? "";
  const media = {
    platform: info.extractor_key ?? info.extractor ?? "desconhecida",
    title: String(info.title ?? "").slice(0, 300),
    author: String(info.uploader ?? info.uploader_id ?? info.channel ?? "").slice(0, 200),
    publishedAt: info.upload_date
      ? `${info.upload_date.slice(6, 8)}/${info.upload_date.slice(4, 6)}/${info.upload_date.slice(0, 4)}`
      : "",
    durationSec: typeof info.duration === "number" ? Math.round(info.duration) : null,
    hasAudio: typeof info.acodec === "string" ? info.acodec !== "none" : null,
    hasVideo: typeof info.vcodec === "string" ? info.vcodec !== "none" : null,
    description: desc.trim().slice(0, 2000),
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : "",
    id: String(info.id ?? ""),
  };
  const lines = [
    `Plataforma: ${media.platform}`,
    media.title && `Título: ${media.title}`,
    media.author && `Autor: ${media.author}`,
    media.publishedAt && `Publicado em: ${media.publishedAt}`,
    media.durationSec && `Duração: ${media.durationSec}s (vídeo/áudio)`,
    media.description && `Descrição/texto do post: ${media.description}`,
  ].filter(Boolean);
  return { ok: true, media, context: lines.join("\n") };
}

async function mkdtempSafe() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "iev-"));
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

function safeDetail(value) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(token|secret|signature|sig|auth|key)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\/(?:tmp|var\/tmp)\/[^\s"'<>]+/g, "[path]")
    .slice(0, 200);
}

async function downloadSource(url, dir, format) {
  const run = await runLimited(
    "yt-dlp",
    ytdlpArgs([...(format ? ["-f", format] : []), "-o", join(dir, "source.%(ext)s")], url),
    { timeoutMs: LIMITS.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: LIMITS.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (!run.ok) return { ok: false, reason: subprocessReason(run, "download", "download-failed"), detail: safeDetail(run.stderr) };
  const name = (await readdir(dir)).find((candidate) => /^source\.[^.]+$/i.test(candidate) && !candidate.endsWith(".part"));
  if (!name) return { ok: false, reason: "no-file" };
  const file = join(dir, name);
  const size = (await stat(file)).size;
  if (size <= 0) return { ok: false, reason: "media-unreadable" };
  if (size > LIMITS.maxFileBytes) return { ok: false, reason: "file-too-large" };
  return { ok: true, file };
}

async function fetchAudio(url) {
  const dir = await mkdtempSafe();
  try {
    const download = await downloadSource(url, dir, "bestaudio/best");
    if (!download.ok) return download;
    const processed = await processMediaFile(download.file, dir, {
      maxMediaSeconds: LIMITS.maxMediaSeconds,
      maxTempBytes: LIMITS.maxTempBytes,
      maxAudioBytes: MAX_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
      extractFrames: false,
    });
    if (!processed.ok) return processed;
    if (!processed.audioBytes) return { ok: false, reason: processed.audioReason ?? "no-audio-track" };
    return {
      ok: true,
      audio_b64: processed.audioBytes.toString("base64"),
      mime: "audio/mpeg",
      bytes: processed.audioBytes.length,
      seconds: processed.durationSec,
      has_audio: processed.hasAudio,
      has_video: processed.hasVideo,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Frames do vídeo (JPEG base64) para OCR/visão — cobre vídeos só com texto na tela. */
async function fetchFrames(url) {
  const dir = await mkdtempSafe();
  try {
    const download = await downloadSource(url, dir, "worst[height<=480]/best[height<=480]/worst");
    if (!download.ok) return download;
    const processed = await processMediaFile(download.file, dir, {
      maxMediaSeconds: LIMITS.maxMediaSeconds,
      maxTempBytes: LIMITS.maxTempBytes,
      maxAudioBytes: MAX_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
      extractAudio: false,
    });
    if (!processed.ok) return processed;
    if (!processed.frames.length) return { ok: false, reason: processed.frameReason ?? "no-video-track" };
    const frames = processed.frames.map((frame) => ({
      image_b64: frame.data,
      timestamp_sec: frame.timestampSec,
    }));
    return { ok: true, frames, count: frames.length, seconds: processed.durationSec, bytes: frames.reduce((sum, frame) => sum + Math.floor(frame.image_b64.length * 3 / 4), 0), has_audio: processed.hasAudio, has_video: processed.hasVideo };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Uma aquisição e uma vaga para todas as modalidades do vídeo. */
async function fetchMedia(url, sourceType) {
  const dir = await mkdtempSafe();
  try {
    let download;
    if (["audio", "video"].includes(sourceType)) {
      const response = await safeFetch(url, {
        maxBytes: Math.min(LIMITS.maxFileBytes, LIMITS.maxTransferBytes),
        timeoutMs: 90_000,
        maxRedirects: 3,
        accept: "video/*,audio/*,application/octet-stream",
      });
      if (!response.ok) return { ok: false, reason: `direct-http-${response.status}` };
      const mime = String(response.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (mime && !/^(?:audio\/|video\/|application\/octet-stream$)/.test(mime)) {
        return { ok: false, reason: "unsupported-media-content-type" };
      }
      const file = join(dir, "source.bin");
      await writeFile(file, response.body, { flag: "wx" });
      download = { ok: true, file };
    } else {
      download = await downloadSource(url, dir, "worst[height<=480][acodec!=none]/best[height<=480][acodec!=none]/worst");
    }
    if (!download.ok) return download;
    const processed = await processMediaFile(download.file, dir, {
      maxMediaSeconds: LIMITS.maxMediaSeconds,
      maxTempBytes: LIMITS.maxTempBytes,
      maxAudioBytes: MAX_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
    });
    return extractionResponse(processed);
  } catch (error) {
    const code = error?.code;
    return { ok: false, reason: code === "too_large" ? "file-too-large" : code === "timeout" ? "download-timeout" : "media-processing-failed", detail: safeDetail(error?.message) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractionResponse(processed) {
  if (!processed.ok) return processed;
  return {
    ok: true,
    audio: processed.audioBytes ? { audio_b64: processed.audioBytes.toString("base64"), mime: "audio/mpeg", bytes: processed.audioBytes.length } : null,
    audio_reason: processed.audioReason,
    frames: processed.frames.map((frame) => ({ image_b64: frame.data, timestamp_sec: frame.timestampSec })),
    frame_reason: processed.frameReason,
    duration_sec: processed.durationSec,
    has_audio: processed.hasAudio,
    has_video: processed.hasVideo,
  };
}

async function processUpload(encoded, mime) {
  if (!UPLOAD_MIMES.has(mime) || typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) {
    return { ok: false, reason: "unsupported-upload" };
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || bytes.toString("base64") !== encoded) {
    return { ok: false, reason: "invalid-upload" };
  }
  const dir = await mkdtempSafe();
  try {
    const ext = mime === "video/quicktime" ? "mov"
      : mime === "video/webm" || mime === "audio/webm" ? "webm"
        : mime === "audio/wav" ? "wav"
          : mime === "audio/ogg" ? "ogg"
            : mime === "audio/mpeg" ? "mp3" : "mp4";
    const source = join(dir, `source.${ext}`);
    await writeFile(source, bytes, { flag: "wx" });
    const processed = await processMediaFile(source, dir, {
      maxMediaSeconds: LIMITS.maxMediaSeconds,
      maxTempBytes: LIMITS.maxTempBytes,
      maxAudioBytes: MAX_AUDIO_BYTES,
      maxFrames: MAX_FRAMES,
      maxFramesBytes: MAX_FRAMES_BYTES,
    });
    return extractionResponse(processed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Remove temporários órfãos de execuções anteriores (queda do processo). */
async function sweepStaleTemp() {
  const maxAgeMs = 60 * 60 * 1000;
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("iev-")) continue;
      const full = join(tmpdir(), entry.name);
      const info = await stat(full);
      if (Date.now() - info.mtimeMs > maxAgeMs) await rm(full, { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* varredura best-effort */ }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      let ytdlp = "?";
      try {
        const run = await runLimited("yt-dlp", ["--version"], { timeoutMs: 10_000, maxOutputBytes: 4096 });
        ytdlp = run.ok ? run.stdout.trim() : "missing";
      } catch { ytdlp = "missing"; }
      return send(res, 200, { ok: true, protocol: 2, ytdlp, busy, limits: { concurrency: LIMITS.concurrency, maxMediaSeconds: LIMITS.maxMediaSeconds } });
    }
    if (!authorized(req)) return send(res, 401, { ok: false, reason: "unauthorized" });
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "method_not_allowed" });
    const limited = limitReason();
    if (limited) return send(res, 503, { ok: false, reason: limited }, { "Retry-After": "20" });
    let body;
    try {
      const limit = req.url === "/upload" ? 4_300_000 : 64 * 1024;
      body = JSON.parse(await readBody(req, limit));
    } catch (error) {
      return send(res, error?.message === "payload too large" ? 413 : 400, { ok: false, reason: error?.message === "payload too large" ? "payload-too-large" : "bad_request" });
    }
    // A leitura do corpo cede execução; outra requisição pode ocupar a última vaga.
    const afterBodyLimit = limitReason();
    if (afterBodyLimit) return send(res, 503, { ok: false, reason: afterBodyLimit }, { "Retry-After": "20" });
    busy++;
    try {
      if (req.url === "/upload") {
        try {
          return send(res, 200, await processUpload(body?.file_b64, String(body?.mime ?? "")));
        } catch (error) {
          return send(res, 200, { ok: false, reason: "upload-processing-failed", detail: safeDetail(error?.message ?? error) });
        }
      }
      const url = String(body?.url ?? "");
      if (!/^https?:\/\//.test(url)) return send(res, 400, { ok: false, reason: "bad_url" });
      try {
        await guardUrl(url);
      } catch (error) {
        return send(res, 200, { ok: false, reason: `blocked:${error?.code ?? "url_policy"}` });
      }
      if (req.url === "/fetch") {
        try {
          const out = await probe(url);
          return send(res, 200, { ...out, attempts: [out.ok ? "worker:yt-dlp:ok" : `worker:yt-dlp:${out.reason}`] });
        } catch (err) {
          return send(res, 200, { ok: false, reason: "probe-failed", detail: safeDetail(err?.message ?? err) });
        }
      }
      if (req.url === "/media") return send(res, 200, await fetchMedia(url, body?.source_type));
      if (req.url === "/audio") {
        try {
          return send(res, 200, await fetchAudio(url));
        } catch (err) {
          return send(res, 200, { ok: false, reason: "audio-failed", detail: safeDetail(err?.message ?? err) });
        }
      }
      if (req.url === "/frames") {
        try {
          return send(res, 200, await fetchFrames(url));
        } catch (err) {
          return send(res, 200, { ok: false, reason: "frames-failed", detail: safeDetail(err?.message ?? err) });
        }
      }
      return send(res, 404, { ok: false, reason: "not_found" });
    } finally {
      busy--;
    }
  } catch {
    return send(res, 500, { ok: false, reason: "worker-error" });
  }
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  if (!SECRET && !ALLOW_INSECURE) {
    console.error("WORKER_SECRET ausente: recusando iniciar (use WORKER_ALLOW_INSECURE=1 apenas em dev local).");
    process.exit(1);
  }
  if (!SECRET) console.warn("AVISO: worker sem WORKER_SECRET (modo inseguro de desenvolvimento).");
  sweepStaleTemp().finally(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`media worker on 0.0.0.0:${PORT} (concorrência ${LIMITS.concurrency}, duração máx ${LIMITS.maxMediaSeconds}s)`);
    });
  });
}

export { guardUrl, server, sweepStaleTemp };
