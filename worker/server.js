// Worker de mídia (roda no Fly.io com yt-dlp + ffmpeg).
// Endpoints (todos exigem Authorization: Bearer <WORKER_SECRET>, exceto /health):
//   GET  /health          → { ok, ytdlp }
//   POST /fetch { url }    → { ok, context, media, attempts } (metadados, sem baixar)
//   POST /audio { url }    → { ok, audio_b64, mime } ou { ok:false, reason }
//   POST /frames { url }   → { ok, frames: [jpeg_b64], count, seconds } — OCR/visão
// Limites: áudio até 20MB (retorna base64); timeout 120s por request.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.WORKER_SECRET || "";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        failed = true;
        reject(new Error("payload too large"));
      }
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
  if (!SECRET) return true; // dev local sem secret
  return req.headers.authorization === `Bearer ${SECRET}`;
}

async function probe(url) {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--no-playlist", "--dump-json", "--no-warnings", "--socket-timeout", "20", url],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const info = JSON.parse(stdout);
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

async function fetchAudio(url) {
  const dir = await mkdtempSafe();
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist", "-x", "--audio-format", "mp3", "--audio-quality", "5",
        "--no-warnings", "--print", "after_move:filepath",
        "--extractor-args", "youtube:player_client=android,web",
        "-o", `${dir}/%(id)s.%(ext)s`, url,
      ],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const file = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!file) return { ok: false, reason: "no-file" };
    const buf = await readFile(file);
    if (buf.length > MAX_AUDIO_BYTES) return { ok: false, reason: "audio-too-large" };
    return { ok: true, audio_b64: buf.toString("base64"), mime: "audio/mpeg", bytes: buf.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MAX_FRAMES = 10;
const MAX_FRAMES_BYTES = 2_500_000;

/** Frames do vídeo (JPEG base64) para OCR/visão — cobre vídeos só com texto na tela. */
async function fetchFrames(url) {
  const dir = await mkdtempSafe();
  try {
    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist", "-f", "worst[height<=480]/best[height<=480]/worst",
        "--no-warnings", "--socket-timeout", "20",
        "-o", `${dir}/v.%(ext)s`, url,
      ],
      { timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const files = await readdir(dir);
    const file = files.find((f) => f.startsWith("v."));
    if (!file) return { ok: false, reason: "no-file" };
    const src = join(dir, file);
    let seconds = 0;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src],
        { timeout: 30_000 },
      );
      seconds = Math.ceil(Number(stdout.trim()) || 0);
    } catch { /* segue sem duração */ }
    // Amostra no máximo MAX_FRAMES ao longo dos primeiros 300s.
    const span = Math.max(1, Math.min(300, seconds || 60));
    const fps = Math.min(1, MAX_FRAMES / span);
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error", "-i", src,
        "-vf", `fps=${fps.toFixed(4)},scale=448:-2`,
        "-frames:v", String(MAX_FRAMES), "-q:v", "7",
        `${dir}/f-%02d.jpg`,
      ],
      { timeout: 120_000 },
    );
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

async function mkdtempSafe() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "iev-"));
}

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const UPLOAD_MIMES = new Set([
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg",
]);

async function processUpload(encoded, mime) {
  if (!UPLOAD_MIMES.has(mime) || typeof encoded !== "string" || encoded.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) {
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
    let durationSec = 0;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src],
        { timeout: 30_000 },
      );
      durationSec = Math.ceil(Number(stdout.trim()) || 0);
    } catch { /* áudio/frame podem continuar sem duração */ }

    let audio = null;
    try {
      const audioPath = join(dir, "audio.mp3");
      await execFileAsync(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audioPath],
        { timeout: 150_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const audioBytes = await readFile(audioPath);
      if (audioBytes.length <= MAX_AUDIO_BYTES) audio = { audio_b64: audioBytes.toString("base64"), mime: "audio/mpeg", bytes: audioBytes.length };
    } catch { /* arquivo sem trilha de áudio */ }

    let frames = [];
    if (mime.startsWith("video/")) {
      try {
        const span = Math.max(1, Math.min(300, durationSec || 60));
        const fps = Math.min(1, MAX_FRAMES / span);
        await execFileAsync(
          "ffmpeg",
          ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", `fps=${fps.toFixed(4)},scale=448:-2`, "-frames:v", String(MAX_FRAMES), "-q:v", "7", `${dir}/f-%02d.jpg`],
          { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
        );
        const jpgs = (await readdir(dir)).filter((file) => /^f-\d+\.jpg$/.test(file)).sort();
        let totalBytes = 0;
        for (const [index, file] of jpgs.slice(0, MAX_FRAMES).entries()) {
          const frame = await readFile(join(dir, file));
          if (totalBytes + frame.length > MAX_FRAMES_BYTES) break;
          totalBytes += frame.length;
          frames.push({ image_b64: frame.toString("base64"), timestamp_sec: Math.round((index / fps) * 100) / 100 });
        }
      } catch { /* vídeo sem frames decodificáveis */ }
    }
    if (!audio && frames.length === 0) return { ok: false, reason: "no-readable-media" };
    return { ok: true, audio, frames, duration_sec: durationSec || null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      let ytdlp = "?";
      try {
        ytdlp = (await execFileAsync("yt-dlp", ["--version"], { timeout: 10_000 })).stdout.trim();
      } catch { ytdlp = "missing"; }
      return send(res, 200, { ok: true, ytdlp });
    }
    if (!authorized(req)) return send(res, 401, { ok: false, reason: "unauthorized" });
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "method_not_allowed" });
    let body;
    try {
      const limit = req.url === "/upload" ? 4_300_000 : 64 * 1024;
      body = JSON.parse(await readBody(req, limit));
    } catch (error) {
      return send(res, error?.message === "payload too large" ? 413 : 400, { ok: false, reason: error?.message === "payload too large" ? "payload-too-large" : "bad_request" });
    }
    if (req.url === "/upload") {
      try {
        return send(res, 200, await processUpload(body?.file_b64, String(body?.mime ?? "")));
      } catch (error) {
        return send(res, 200, { ok: false, reason: "upload-processing-failed", detail: String(error?.message ?? error).slice(0, 200) });
      }
    }
    const url = String(body?.url ?? "");
    if (!/^https?:\/\//.test(url)) return send(res, 400, { ok: false, reason: "bad_url" });
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
  } catch {
    return send(res, 500, { ok: false, reason: "worker-error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`media worker on 0.0.0.0:${PORT}`);
});
