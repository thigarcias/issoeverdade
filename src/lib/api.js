// ---------------------------------------------------------------------------
// API client — tenta o backend real (/api/verify, OpenCode Go) e cai para o
// mock local se o backend estiver indisponível. Contrato estável:
// `verify()` retorna `{ result, live: boolean, model: string|null }`.
// ---------------------------------------------------------------------------

import { MOCK_FALLBACK, MOCK_RESULTS, PIPELINE_STEPS } from "../data/mocks.js";

const STEP_DELAY_MS = 650;

const ERROR_MESSAGES = {
  missing_api_key: "Servidor sem chave OpenCode — usando demonstração local.",
  upstream_timeout: "O modelo demorou demais — usando demonstração local.",
  upstream_fetch_failed: "Falha ao falar com a OpenCode — usando demonstração local.",
  model_bad_json: "O modelo respondeu num formato estranho — usando demonstração local.",
  FreeTierError: "Modelo gratuito indisponível fora do OpenCode — usando demonstração local.",
};

function pickMock(input) {
  const hay = `${input.text ?? ""} ${input.fileName ?? ""}`.toLowerCase();
  return (
    MOCK_RESULTS.find((r) => r.match.some((k) => hay.includes(k))) ??
    MOCK_FALLBACK
  );
}

function personalize(result, input) {
  if (input.kind === "link" && input.text) {
    try {
      const host = new URL(input.text).hostname.replace(/^www\./, "");
      return { ...result, kind: `Link · ${host} (mock)` };
    } catch {
      return result;
    }
  }
  if ((input.kind === "video" || input.kind === "image") && input.fileName) {
    const label = input.kind === "video" ? "Vídeo" : "Imagem";
    return { ...result, kind: `${label} · ${input.fileName} (mock)` };
  }
  return result;
}

function kindLabel(input) {
  if (input.kind === "link") {
    try {
      return `Link · ${new URL(input.text).hostname.replace(/^www\./, "")}`;
    } catch {
      return "Link";
    }
  }
  if (input.kind === "video") return input.fileName ? `Vídeo · ${input.fileName}` : "Vídeo · link";
  if (input.kind === "image") return input.fileName ? `Imagem · ${input.fileName}` : "Imagem";
  return "Texto";
}

function titleFrom(input) {
  const raw = (input.text || input.fileName || "conteúdo enviado").trim();
  const short = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
  return `Checagem: ${short}`;
}

/** Normaliza o JSON do modelo para o formato que o ResultCard espera. */
function normalizeLive(raw, input, model) {
  const verdicts = ["true", "mostly_true", "mixed", "unproven", "misleading", "false"];
  const statuses = ["true", "false", "unproven", "context"];
  const clamp = (n, dflt) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : dflt;
  };
  const sources = Array.isArray(raw?.sources)
    ? raw.sources.slice(0, 8).map((s) => ({
        outlet: String(s?.outlet ?? "Fonte").slice(0, 120),
        detail: String(s?.detail ?? "").slice(0, 120),
        url: typeof s?.url === "string" && /^https?:\/\//.test(s.url) ? s.url : "#",
      }))
    : [];
  const claims = Array.isArray(raw?.claims)
    ? raw.claims.slice(0, 10).map((c, i) => ({
        id: `live-c${i + 1}`,
        status: statuses.includes(c?.status) ? c.status : "unproven",
        score: clamp(c?.score, 50),
        text: String(c?.text ?? "Afirmação").slice(0, 400),
        note: String(c?.note ?? "").slice(0, 400),
        sourceIds: sources.map((_, idx) => idx),
      }))
    : [];
  return {
    id: `live-${Date.now().toString(36)}`,
    verdict: verdicts.includes(raw?.verdict) ? raw.verdict : "unproven",
    score: clamp(raw?.score, 50),
    title: titleFrom(input),
    kind: `${kindLabel(input)} · ${model}`,
    author: "checagem ao vivo",
    publishedAt: new Date().toLocaleDateString("pt-BR"),
    checkedAt: "agora",
    summary: String(raw?.summary ?? "Resultado gerado pelo modelo.").slice(0, 600),
    claims,
    transcript: null,
    sources,
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

async function mockVerify(input, opts) {
  for (let i = 0; i < PIPELINE_STEPS.length; i++) {
    opts.onStep?.(i);
    await wait(STEP_DELAY_MS, opts.signal);
  }
  opts.onStep?.(PIPELINE_STEPS.length);
  return {
    result: personalize(pickMock(input), input),
    live: false,
    model: null,
  };
}

async function liveVerify(input, opts) {
  // Avança o pipeline visual enquanto o modelo trabalha (passo 3 = "conferindo").
  opts.onStep?.(0);
  await wait(400, opts.signal);
  opts.onStep?.(1);
  await wait(400, opts.signal);
  opts.onStep?.(2);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let res;
  try {
    res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: input.kind, text: input.text, fileName: input.fileName }),
      signal: ctrl.signal,
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  opts.onStep?.(3);
  await wait(300, opts.signal);
  if (!res.ok) {
    let code = "upstream_error";
    try {
      code = (await res.json())?.error ?? code;
    } catch { /* corpo ilegível */ }
    const err = new Error(ERROR_MESSAGES[code] ?? "Backend indisponível — usando demonstração local.");
    err.fallback = true;
    throw err;
  }
  const data = await res.json();
  opts.onStep?.(4);
  await wait(300, opts.signal);
  opts.onStep?.(PIPELINE_STEPS.length);
  return {
    result: normalizeLive(data.result, input, data.model ?? "ao vivo"),
    live: true,
    model: data.model ?? null,
  };
}

/**
 * @param {{ kind: "link"|"text"|"video"|"image", text: string, fileName: string|null }} input
 * @param {{ onStep?: (index: number) => void, signal?: AbortSignal, onFallback?: (msg: string) => void }} opts
 * @returns {Promise<{ result: object, live: boolean, model: string|null, steps: typeof PIPELINE_STEPS }>}
 */
export async function verify(input, opts = {}) {
  try {
    const out = await liveVerify(input, opts);
    return { ...out, steps: PIPELINE_STEPS };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (!err?.fallback && !(err instanceof TypeError)) throw err;
    opts.onFallback?.(err?.fallback ? err.message : "Backend indisponível — usando demonstração local.");
    const out = await mockVerify(input, { ...opts, signal: opts.signal });
    return { ...out, steps: PIPELINE_STEPS };
  }
}
