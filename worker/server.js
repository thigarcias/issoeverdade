// Worker de mídia (roda no Fly.io com yt-dlp + ffmpeg).
// Endpoints (todos exigem Authorization: Bearer <WORKER_SECRET>, exceto /health):
//   GET  /health          → { ok, ytdlp }
//   POST /fetch { url }    → { ok, context, media, attempts } (metadados, sem baixar)
//   POST /audio { url }    → { ok, audio_b64, mime } ou { ok:false, reason }
// Limites: áudio até 20MB (retorna base64); timeout 120s por request.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
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

async function mkdtempSafe() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "iev-"));
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
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { ok: false, reason: "bad_request" });
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
    return send(res, 404, { ok: false, reason: "not_found" });
  } catch {
    return send(res, 500, { ok: false, reason: "worker-error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`media worker on 0.0.0.0:${PORT}`);
});
