import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runLimited } from "./proc.js";

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

function toolFailure(tool, run) {
  if (run.reason === "timeout") return `${tool}-timeout`;
  if (run.reason === "spawn_failed" && /ENOENT/i.test(run.stderr)) return `${tool}-unavailable`;
  return `${tool}-failed`;
}

/** Probe real streams and duration; metadata alone never approves unreadable media. */
export async function inspectMediaFile(file, maxMediaSeconds, { timeoutMs = 30_000 } = {}) {
  const run = await runLimited("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file,
  ], { timeoutMs, maxOutputBytes: 64 * 1024 });
  if (!run.ok) return { ok: false, reason: toolFailure("ffprobe", run) };
  let probe;
  try {
    probe = JSON.parse(run.stdout);
  } catch {
    return { ok: false, reason: "media-unreadable" };
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const hasVideo = streams.some((stream) => stream?.codec_type === "video");
  const seconds = Number(probe?.format?.duration);
  if ((!hasAudio && !hasVideo) || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, reason: "media-duration-unavailable" };
  }
  const durationSec = Math.ceil(seconds);
  if (durationSec > maxMediaSeconds) return { ok: false, reason: `duration-limit:${durationSec}s` };
  return { ok: true, durationSec, seconds, hasAudio, hasVideo };
}

function jpegIsDecodableCandidate(bytes) {
  return bytes.length >= 4 && bytes.subarray(0, 3).equals(JPEG_START) && bytes.subarray(-2).equals(JPEG_END);
}

/**
 * Extracts selected modalities from one validated local source file.
 * The caller owns `dir` and must remove it after consuming the returned bytes.
 */
export async function processMediaFile(file, dir, {
  maxMediaSeconds,
  maxTempBytes,
  maxAudioBytes = 20 * 1024 * 1024,
  maxFrames = 10,
  maxFramesBytes = 2_500_000,
  maxFrameBytes = 600_000,
  timeoutMs = 150_000,
  extractAudio = true,
  extractFrames = true,
} = {}) {
  const inspected = await inspectMediaFile(file, maxMediaSeconds);
  if (!inspected.ok) return inspected;

  let audioBytes = null;
  let audioReason = null;
  if (extractAudio && inspected.hasAudio) {
    const audioFile = join(dir, "audio.mp3");
    const converted = await runLimited("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-t", String(maxMediaSeconds), audioFile,
    ], { timeoutMs, watchDir: dir, maxDirBytes: maxTempBytes, maxOutputBytes: 1024 * 1024 });
    if (!converted.ok) {
      audioReason = toolFailure("ffmpeg", converted);
    } else {
      const extracted = await inspectMediaFile(audioFile, maxMediaSeconds);
      if (!extracted.ok || !extracted.hasAudio) {
        audioReason = extracted.ok ? "audio-content-unreadable" : extracted.reason;
      } else {
        const bytes = await readFile(audioFile);
        if (!bytes.length || bytes.length > maxAudioBytes) audioReason = "audio-too-large";
        else audioBytes = bytes;
      }
    }
  } else if (extractAudio) {
    audioReason = "no-audio-track";
  }

  const frames = [];
  let frameReason = null;
  if (extractFrames && inspected.hasVideo) {
    const span = Math.max(1, Math.min(maxMediaSeconds, inspected.durationSec));
    const fps = Math.min(1, maxFrames / span);
    const converted = await runLimited("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vf", `fps=${fps.toFixed(4)},scale=448:-2`,
      "-frames:v", String(maxFrames), "-q:v", "7", join(dir, "f-%02d.jpg"),
    ], { timeoutMs: 120_000, watchDir: dir, maxDirBytes: maxTempBytes, maxOutputBytes: 1024 * 1024 });
    if (!converted.ok) {
      frameReason = toolFailure("ffmpeg", converted);
    } else {
      const paths = (await readdir(dir)).filter((name) => /^f-\d+\.jpg$/.test(name)).sort();
      let total = 0;
      for (const [index, name] of paths.slice(0, maxFrames).entries()) {
        const bytes = await readFile(join(dir, name));
        if (!jpegIsDecodableCandidate(bytes)) {
          frameReason = "frame-content-unreadable";
          frames.length = 0;
          break;
        }
        if (bytes.length > maxFrameBytes || total + bytes.length > maxFramesBytes) break;
        total += bytes.length;
        frames.push({ data: bytes.toString("base64"), timestampSec: Math.round((index / fps) * 100) / 100 });
      }
      if (!frames.length && !frameReason) frameReason = "no-frames";
    }
  } else if (extractFrames) {
    frameReason = "no-video-track";
  }

  if (!audioBytes && !frames.length) {
    return {
      ok: false,
      reason: audioReason && audioReason !== "no-audio-track" ? audioReason : frameReason ?? "no-readable-media",
      durationSec: inspected.durationSec,
      hasAudio: inspected.hasAudio,
      hasVideo: inspected.hasVideo,
      audioReason,
      frameReason,
    };
  }
  return {
    ok: true,
    audioBytes,
    frames,
    durationSec: inspected.durationSec,
    hasAudio: inspected.hasAudio,
    hasVideo: inspected.hasVideo,
    audioReason,
    frameReason,
  };
}

export { jpegIsDecodableCandidate };
