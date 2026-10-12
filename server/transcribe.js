// Transcrição server-side via API da OpenAI (whisper-1, verbose_json).
// - Zero binário/modelo local: funciona na Vercel, local, em qualquer lugar.
// - verbose_json devolve segmentos com timestamps (start/end/text).
// - Cache em memória por caminho de arquivo.
// - Fila com concorrência 3 (API aguenta paralelo; evita estourar rate limit).
// Requer: OPENAI_API_KEY no ambiente. Ausente? { ok:false } e segue sem transcrição.

import { readFile, stat } from "node:fs/promises";

const API_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120_000);
const MAX_BYTES = 25 * 1024 * 1024; // limite da API OpenAI

const cache = new Map();
let queue = Promise.resolve();
let running = 0;
const MAX_PARALLEL = 3;

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

/**
 * @param {string} audioPath caminho do MP3/WAV/M4A (lê do disco e faz upload)
 * @returns {{ ok, segments?: [{ts,start,end,text}], text?, duration?, model?, reason? }}
 */
export async function transcribe(audioPath) {
  if (cache.has(audioPath)) return cache.get(audioPath);
  const job = queue.then(async () => {
    while (running >= MAX_PARALLEL) {
      await new Promise((r) => setTimeout(r, 200));
    }
    running++;
    try {
      return await runTranscribe(audioPath);
    } finally {
      running--;
    }
  });
  queue = job.catch(() => {});
  const out = await job;
  if (out.ok) cache.set(audioPath, out);
  return out;
}

async function runTranscribe(audioPath) {
  if (!apiKey()) return { ok: false, reason: "no-openai-key" };
  let size = 0;
  try {
    size = (await stat(audioPath)).size;
  } catch {
    return { ok: false, reason: "audio-not-found" };
  }
  if (size > MAX_BYTES) {
    return { ok: false, reason: "audio-too-large", detail: `${Math.round(size / 1024 / 1024)}MB > 25MB` };
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const buf = await readFile(audioPath);
    const ext = (audioPath.split(".").pop() || "mp3").toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : ext === "m4a" ? "audio/m4a" : "audio/mpeg";
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
    form.append("model", MODEL);
    form.append("language", "pt");
    form.append("response_format", "verbose_json");
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
      return { ok: false, reason: "openai-error", detail: msg.slice(0, 300) };
    }
    const data = JSON.parse(raw);
    const segments = (data.segments ?? []).map((s) => ({
      ts: formatTs(s.start ?? 0),
      start: Math.round((s.start ?? 0) * 100) / 100,
      end: Math.round((s.end ?? 0) * 100) / 100,
      text: String(s.text ?? "").trim(),
    })).filter((s) => s.text);
    if (!segments.length && !data.text) return { ok: false, reason: "empty-transcript" };
    return {
      ok: true,
      segments,
      text: segments.map((s) => s.text).join(" ") || String(data.text ?? ""),
      duration: data.duration ?? null,
      model: MODEL,
    };
  } catch (err) {
    if (err?.name === "AbortError") return { ok: false, reason: "transcribe-timeout" };
    return { ok: false, reason: "transcribe-failed", detail: String(err?.message ?? err).slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

export function transcriptToPrompt(t) {
  if (!t?.ok || !t.segments?.length) return "";
  return t.segments.map((s) => `[${s.ts}] ${s.text}`).join("\n");
}
