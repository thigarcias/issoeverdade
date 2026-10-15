// Execução de subprocessos com teto de tempo, teto de saída e vigia de disco.
// Existe porque timeout sozinho não limita bytes baixados por yt-dlp/ffmpeg:
// um stream sem Content-Length pode gravar até o disco acabar.
// Usa apenas módulos nativos — o worker copia este arquivo no container.
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Soma recursiva do diretório com teto de entradas, para não travar o vigia. */
export async function dirBytes(dir, { maxEntries = 5000 } = {}) {
  let total = 0;
  let entries = 0;
  const walk = async (path) => {
    let list;
    try {
      list = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (entries++ > maxEntries) return;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          /* arquivo removido durante a varredura */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/** Mata a árvore de processos: grupo no POSIX, /T no Windows. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* processo já era */
    }
  }
}

/**
 * Executa um binário com limites. O vigia observa o diretório de trabalho e
 * interrompe a árvore de processos quando o disco ou o tempo estouram.
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, killed:boolean, reason:string|null, peakBytes:number}>}
 */
export async function runLimited(file, args, opts = {}) {
  const {
    timeoutMs = 120_000,
    maxDirBytes = 0,
    watchDir = null,
    watchMs = 500,
    maxOutputBytes = 4 * 1024 * 1024,
    cwd = undefined,
    env = undefined,
    signal = undefined,
  } = opts;
  if (signal?.aborted) return { ok: false, code: null, stdout: "", stderr: "", killed: false, reason: "aborted", peakBytes: 0 };
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let reason = null;
    let peakBytes = 0;
    let outputOverflow = false;
    const stop = (why) => {
      if (killed) return;
      killed = true;
      reason = why;
      killTree(child);
    };
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const watcher = watchDir && maxDirBytes > 0
      ? setInterval(async () => {
          const bytes = await dirBytes(watchDir);
          peakBytes = Math.max(peakBytes, bytes);
          if (bytes > maxDirBytes) stop("disk_limit");
        }, watchMs)
      : null;
    if (watcher?.unref) watcher.unref();
    child.stdout?.on("data", (chunk) => {
      if (stdout.length + chunk.length > maxOutputBytes) {
        outputOverflow = true;
        stop("output_limit");
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length + chunk.length > maxOutputBytes) return;
      stderr += chunk;
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      clearInterval(watcher);
      resolve({ ok: false, code: null, stdout: "", stderr: String(error?.message ?? error), killed, reason: reason ?? "spawn_failed", peakBytes });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      clearInterval(watcher);
      resolve({
        ok: code === 0 && !killed,
        code,
        stdout,
        stderr,
        killed,
        reason: reason ?? (code === 0 ? null : `exit_${code}`),
        peakBytes,
        outputOverflow,
      });
    });
  });
}
