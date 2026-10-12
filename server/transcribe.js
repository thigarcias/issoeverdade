// Transcrição server-side via faster-whisper (worker Python).
// - Modelo padrão: large-v3-turbo ("turbo") — melhor custo/qualidade.
// - GPU (CUDA) se disponível, senão CPU.
// - Fila com concorrência 1: transcrição é pesada, não paraleliza.
// - Cache em memória por caminho de arquivo (mesmo áudio = mesma transcrição).
// Requer: `py scripts/transcribe.py` funcional (pip install faster-whisper).
// Ausente? transcribe() retorna { ok:false } e o runVerify segue sem transcrição.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "transcribe.py");
const MODEL = process.env.WHISPER_MODEL || "turbo";
const TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 300_000);

const cache = new Map();
let available = null;
let queue = Promise.resolve();

export async function hasTranscriber() {
  if (available !== null) return available;
  try {
    await execFileAsync("py", [SCRIPT, "--help"], { timeout: 60_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

function formatTs(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {string} audioPath caminho do MP3/WAV/M4A
 * @returns {{ ok, segments?: [{ts,start,end,text}], text?, duration?, model?, reason? }}
 */
export async function transcribe(audioPath) {
  if (cache.has(audioPath)) return cache.get(audioPath);
  // Serializa via fila
  const job = queue.then(() => runTranscribe(audioPath));
  queue = job.catch(() => {});
  const out = await job;
  if (out.ok) cache.set(audioPath, out);
  return out;
}

async function runTranscribe(audioPath) {
  if (!(await hasTranscriber())) return { ok: false, reason: "no-transcriber" };
  try {
    const { stdout } = await execFileAsync(
      "py",
      [SCRIPT, audioPath, "--model", MODEL],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    if (data.error) return { ok: false, reason: "worker-error", detail: data.error };
    const segments = (data.segments ?? []).map((s) => ({
      ts: formatTs(s.start),
      start: s.start,
      end: s.end,
      text: s.text,
    }));
    return {
      ok: true,
      segments,
      text: data.text ?? "",
      duration: data.duration ?? null,
      model: data.model ?? MODEL,
    };
  } catch (err) {
    return { ok: false, reason: "transcribe-failed", detail: String(err?.message ?? err).slice(0, 300) };
  }
}

export function transcriptToPrompt(t) {
  if (!t?.ok || !t.segments?.length) return "";
  return t.segments.map((s) => `[${s.ts}] ${s.text}`).join("\n");
}
