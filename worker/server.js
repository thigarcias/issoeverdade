// Worker de mídia (roda no Fly.io com yt-dlp + ffmpeg).
// Endpoints (todos exigem Authorization: Bearer <WORKER_SECRET>, exceto /health):
//   GET  /health          → { ok, ytdlp, busy, limits }
//   POST /fetch { url }    → { ok, context, media, attempts } (metadados, sem baixar)
//   POST /audio { url }    → { ok, audio_b64, mime } ou { ok:false, reason }
//   POST /frames { url }   → { ok, frames: [jpeg_b64], count, seconds } — OCR/visão
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
import { readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { hostPolicy, parseUrlStrict, resolvePublicHost } from "../server/net.js";
import { runLimited } from "../server/proc.js";

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
  maxFileBytes: intEnv(process.env.IEV_MAX_MEDIA_FILE_BYTES, 64 * 1024 * 1024),
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
    "--max-downloads", "1",
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
  if (!run.ok) return { ok: false, reason: run.reason === "timeout" ? "probe-timeout" : "probe-failed", detail: run.stderr.slice(0, 300) };
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
  return { media, context: lines.join("\n") };
}

async function mkdtempSafe() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "iev-"));
}

/** Duração do arquivo (ffprobe) com teto operacional; ausência de ffprobe não bloqueia. */
async function checkDuration(file) {
  const run = await runLimited(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
  );
  if (!run.ok) return { ok: true, seconds: null };
  const seconds = Math.ceil(Number(run.stdout.trim()) || 0);
  if (seconds > LIMITS.maxMediaSeconds) return { ok: false, reason: `duration-limit:${seconds}s` };
  return { ok: true, seconds: seconds || null };
}

async function fetchAudio(url) {
  const dir = await mkdtempSafe();
  try {
    const run = await runLimited(
      "yt-dlp",
      ytdlpArgs(["-x", "--audio-format", "mp3", "--audio-quality", "5", "--print", "after_move:filepath",
        "-o", `${dir}/%(id)s.%(ext)s`], url),
      { timeoutMs: LIMITS.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: LIMITS.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (!run.ok) {
      return {
        ok: false,
        reason: run.killed
          ? run.reason === "disk_limit" ? "disk-limit" : run.reason === "timeout" ? "audio-timeout" : `kill:${run.reason}`
          : /larger than max-filesize/i.test(run.stderr) ? "file-too-large" : "audio-failed",
        detail: run.stderr.slice(0, 200),
      };
    }
    const file = run.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!file) return { ok: false, reason: "no-file" };
    const duration = await checkDuration(file);
    if (duration.ok === false) return { ok: false, reason: duration.reason };
    const buf = await readFile(file);
    if (buf.length > MAX_AUDIO_BYTES) return { ok: false, reason: "audio-too-large" };
    return { ok: true, audio_b64: buf.toString("base64"), mime: "audio/mpeg", bytes: buf.length, seconds: duration.seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Frames do vídeo (JPEG base64) para OCR/visão — cobre vídeos só com texto na tela. */
async function fetchFrames(url) {
  const dir = await mkdtempSafe();
  try {
    const download = await runLimited(
      "yt-dlp",
      ytdlpArgs(["-f", "worst[height<=480]/best[height<=480]/worst", "-o", `${dir}/v.%(ext)s`], url),
      { timeoutMs: LIMITS.ytdlpTimeoutMs, watchDir: dir, maxDirBytes: LIMITS.maxTempBytes, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (!download.ok) {
      return {
        ok: false,
        reason: download.killed
          ? download.reason === "disk_limit" ? "disk-limit" : download.reason === "timeout" ? "download-timeout" : `kill:${download.reason}`
          : /larger than max-filesize/i.test(download.stderr) ? "file-too-large" : "download-failed",
        detail: download.stderr.slice(0, 200),
      };
    }
    const files = await readdir(dir);
    const file = files.find((f) => f.startsWith("v."));
    if (!file) return { ok: false, reason: "no-file" };
    const src = join(dir, file);
    const duration = await checkDuration(src);
    if (duration.ok === false) return { ok: false, reason: duration.reason };
    const seconds = duration.seconds ?? 0;
    // Amostra no máximo MAX_FRAMES ao longo do vídeo, limitada pelo teto de duração.
    const span = Math.max(1, Math.min(LIMITS.maxMediaSeconds, seconds || 60));
    const fps = Math.min(1, MAX_FRAMES / span);
    const framesResult = await runLimited(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error", "-i", src,
        "-vf", `fps=${fps.toFixed(4)},scale=448:-2`,
        "-frames:v", String(MAX_FRAMES), "-q:v", "7",
        `${dir}/f-%02d.jpg`,
      ],
      { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
    );
    if (!framesResult.ok) return { ok: false, reason: framesResult.killed ? "frames-timeout" : "frames-failed", detail: framesResult.stderr.slice(0, 200) };
    const jpgs = (await readdir(dir)).filter((f) => /^f-\d+\.jpg$/.test(f)).sort();
    const frames = [];
    let bytes = 0;
    for (const [index, j] of jpgs.slice(0, MAX_FRAMES).entries()) {
      const buf = await readFile(join(dir, j));
      if (bytes + buf.length > MAX_FRAMES_BYTES) break;
      bytes += buf.length;
      frames.push({
        image_b64: buf.toString("base64"),
        timestamp_sec: Math.round((index / fps) * 100) / 100,
      });
    }
    if (!frames.length) return { ok: false, reason: "no-frames" };
    return { ok: true, frames, count: frames.length, seconds: seconds || null, bytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function processUpload(encoded, mime) {
  const limits = LIMITS;
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
    const src = join(dir, `input.${ext}`);
    await writeFile(src, bytes, { flag: "wx" });
    const duration = await checkDuration(src);
    if (duration.ok === false) return { ok: false, reason: duration.reason };
    const durationSec = duration.seconds ?? 0;

    let audio = null;
    const audioRun = await runLimited(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
        "-t", String(Math.min(limits.maxMediaSeconds, 3600)), join(dir, "audio.mp3")],
      { timeoutMs: 150_000, maxOutputBytes: 1024 * 1024, watchDir: dir, maxDirBytes: limits.maxTempBytes },
    );
    if (audioRun.ok) {
      try {
        const audioBytes = await readFile(join(dir, "audio.mp3"));
        if (audioBytes.length <= MAX_AUDIO_BYTES) audio = { audio_b64: audioBytes.toString("base64"), mime: "audio/mpeg", bytes: audioBytes.length };
      } catch { /* arquivo sem trilha de áudio */ }
    }

    let frames = [];
    if (mime.startsWith("video/")) {
      const span = Math.max(1, Math.min(limits.maxMediaSeconds, durationSec || 60));
      const fps = Math.min(1, MAX_FRAMES / span);
      const framesRun = await runLimited(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", `fps=${fps.toFixed(4)},scale=448:-2`,
          "-frames:v", String(MAX_FRAMES), "-q:v", "7", `${dir}/f-%02d.jpg`],
        { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
      );
      if (framesRun.ok) {
        const jpgs = (await readdir(dir)).filter((file) => /^f-\d+\.jpg$/.test(file)).sort();
        let totalBytes = 0;
        for (const [index, file] of jpgs.slice(0, MAX_FRAMES).entries()) {
          const frame = await readFile(join(dir, file));
          if (totalBytes + frame.length > MAX_FRAMES_BYTES) break;
          totalBytes += frame.length;
          frames.push({ image_b64: frame.toString("base64"), timestamp_sec: Math.round((index / fps) * 100) / 100 });
        }
      }
    }
    if (!audio && frames.length === 0) return { ok: false, reason: "no-readable-media" };
    return { ok: true, audio, frames, duration_sec: durationSec || null };
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
      return send(res, 200, { ok: true, ytdlp, busy, limits: { concurrency: LIMITS.concurrency, maxMediaSeconds: LIMITS.maxMediaSeconds } });
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
    busy++;
    try {
      if (req.url === "/upload") {
        try {
          return send(res, 200, await processUpload(body?.file_b64, String(body?.mime ?? "")));
        } catch (error) {
          return send(res, 200, { ok: false, reason: "upload-processing-failed", detail: String(error?.message ?? error).slice(0, 200) });
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
          return send(res, 200, { ok: true, ...out, attempts: ["worker:yt-dlp:ok"] });
        } catch (err) {
          return send(res, 200, { ok: false, reason: "probe-failed", detail: String(err?.message ?? err).slice(0, 300) });
        }
      }
      if (req.url === "/audio") {
        try {
          return send(res, 200, await fetchAudio(url));
        } catch (err) {
          return send(res, 200, { ok: false, reason: "audio-failed", detail: String(err?.message ?? err).slice(0, 300) });
        }
      }
      if (req.url === "/frames") {
        try {
          return send(res, 200, await fetchFrames(url));
        } catch (err) {
          return send(res, 200, { ok: false, reason: "frames-failed", detail: String(err?.message ?? err).slice(0, 300) });
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
