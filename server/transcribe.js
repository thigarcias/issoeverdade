// Transcrição server-side pelo endpoint de áudio OpenAI.
// Whisper suporta segmentos com timestamps; os demais adapters suportados
// devolvem texto, sem inventar segmentação temporal.
// Requer OPENAI_API_KEY.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const API_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000;
const MAX_BYTES = 25 * 1024 * 1024;

const cache = new Map();
const inFlight = new Map();
const waiting = [];
let running = 0;
const MAX_PARALLEL = 3;
const MAX_CACHE = 100;
const TIMESTAMP_MODELS = new Set(["whisper-1"]);
const SUPPORTED_MODELS = new Set([
  "whisper-1",
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

function apiKey() {
  return process.env.OPENAI_API_KEY || "";
}

export async function hasTranscriber() {
  return Boolean(apiKey());
}

function formatTs(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function acquireSlot() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // Transfere a vaga, sem polling nem serializar todos os jobs.
  else running--;
}

function safeDetail(value) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(token|secret|signature|sig|auth|key)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\/(?:tmp|var\/tmp)\/[^\s"'<>]+/g, "[path]")
    .slice(0, 300);
}

/**
 * @param {string} audioPath caminho do áudio local
 * @param {{ provider?: string, model?: string }} opts configuração selecionada
 * @returns {{ ok, segments?, text?, duration?, model?, provider?, reason? }}
 */
export async function transcribe(audioPath, opts = {}) {
  const provider = opts.provider ?? "openai";
  const model = typeof opts.model === "string" && opts.model ? opts.model : MODEL;
  if (provider !== "openai") return { ok: false, reason: "unsupported-transcription-provider", provider, model };
  if (!SUPPORTED_MODELS.has(model)) return { ok: false, reason: "unsupported-transcription-model", provider, model };
  if (!apiKey()) return { ok: false, reason: "no-openai-key", provider, model };
  let size = 0;
  try {
    size = (await stat(audioPath)).size;
  } catch {
    return { ok: false, reason: "audio-not-found" };
  }
  if (size === 0) return { ok: false, reason: "empty-audio", provider, model };
  if (size > MAX_BYTES) {
    return { ok: false, reason: "audio-too-large", detail: `${Math.round(size / 1024 / 1024)}MB > 25MB` };
  }
  let buf;
  try {
    buf = await readFile(audioPath);
  } catch {
    return { ok: false, reason: "audio-not-found" };
  }
  const digest = createHash("sha256").update(buf).digest("hex");
  const key = `${provider}:${model}:${digest}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = (async () => {
    await acquireSlot();
    try {
      const out = await runTranscribe(audioPath, model, buf);
      if (out.ok) {
        cache.set(key, out);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      return out;
    } finally {
      releaseSlot();
    }
  })();
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}


async function runTranscribe(audioPath, model = MODEL, buf) {
  if (!apiKey()) return { ok: false, reason: "no-openai-key" };
  if (!buf) buf = await readFile(audioPath);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const ext = (audioPath.split(".").pop() || "mp3").toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : ext === "m4a" ? "audio/mp4" : ext === "webm" ? "audio/webm" : "audio/mpeg";
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
    form.append("model", model);
    form.append("language", "pt");
    form.append("response_format", TIMESTAMP_MODELS.has(model) ? "verbose_json" : "json");
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 300);
      try {
        msg = JSON.parse(raw)?.error?.message ?? msg;
      } catch { /* mantém raw */ }
      return { ok: false, reason: "openai-error", status: res.status, detail: safeDetail(msg), provider: "openai", model };
    }
    const data = JSON.parse(raw);
    const segments = Array.isArray(data.segments)
      ? data.segments.map((s) => ({
          ts: formatTs(s.start ?? 0),
          start: Math.round((s.start ?? 0) * 100) / 100,
          end: Math.round((s.end ?? 0) * 100) / 100,
          text: String(s.text ?? "").trim(),
        })).filter((s) => s.text)
      : [];
    const text = segments.map((s) => s.text).join(" ") || String(data.text ?? "").trim();
    if (!text) return { ok: false, reason: "empty-transcript" };
    return { ok: true, segments, text, duration: data.duration ?? null, model, provider: "openai" };
  } catch (err) {
    if (err?.name === "AbortError") return { ok: false, reason: "transcribe-timeout" };
    return { ok: false, reason: "transcribe-failed", detail: safeDetail(err?.message ?? err), provider: "openai", model };
  } finally {
    clearTimeout(timeout);
  }
}

export function transcriptToPrompt(t) {
  if (!t?.ok) return "";
  if (t.segments?.length) return t.segments.map((s) => `[${s.ts}] ${s.text}`).join("\n");
  return t.text ? `[timestamp indisponível] ${t.text}` : "";
}
