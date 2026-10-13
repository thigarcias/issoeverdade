// ---------------------------------------------------------------------------
// API client — checagem real via /api/verify. Falhas viram exceção com mensagem
// amigável; a UI exibe estado de erro com botão de tentar de novo.
// Retorna `{ result, steps }`. Detalhes do modelo ficam no servidor.
// ---------------------------------------------------------------------------

import { PIPELINE_STEPS, migrateVerdict } from "../data/constants.js";

export const ERROR_MESSAGES = {
  missing_api_key: "Serviço de checagem indisponível no momento.",
  upstream_timeout: "A checagem demorou demais. Tente de novo.",
  upstream_fetch_failed: "Não consegui falar com o serviço de IA. Tente de novo.",
  model_bad_json: "A IA respondeu num formato estranho. Tente de novo.",
  FreeTierError: "Serviço de IA indisponível. Tente de novo mais tarde.",
};

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
function normalize(raw, input, origin) {
  const statuses = ["true", "false", "unproven", "context"];
  const clamp = (n, dflt) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : dflt;
  };
  // Backend já remove fontes sem URL válida; aqui filtramos por segurança.
  const sources = Array.isArray(raw?.sources)
    ? raw.sources
        .filter((s) => typeof s?.url === "string" && /^https?:\/\//.test(s.url))
        .slice(0, 8)
        .map((s) => ({
          outlet: String(s?.outlet ?? "Fonte").slice(0, 120),
          detail: String(s?.detail ?? "").slice(0, 120),
          url: s.url,
        }))
    : [];
  const claims = Array.isArray(raw?.claims)
    ? raw.claims.slice(0, 10).map((c, i) => {
        // Servidor novo envia sourceIds (0-based, podados); sem eles, vincula todas (compat).
        const ids = Array.isArray(c?.sourceIds)
          ? c.sourceIds.filter((n) => Number.isInteger(n) && n >= 0 && n < sources.length)
          : sources.map((_, idx) => idx);
        return {
          id: `c${i + 1}`,
          status: statuses.includes(c?.status) ? c.status : "unproven",
          score: clamp(c?.score, 50),
          text: String(c?.text ?? "Afirmação").slice(0, 400),
          note: String(c?.note ?? "").slice(0, 400),
          sourceIds: ids,
        };
      })
    : [];
  return {
    id: `r-${Date.now().toString(36)}`,
    verdict: migrateVerdict(raw?.verdict, raw?.score),
    score: clamp(raw?.score, 50),
    title: origin?.title ?? titleFrom(input),
    kind: kindLabel(input),
    author: origin?.author ?? "checagem por IA",
    publishedAt: new Date().toLocaleDateString("pt-BR"),
    checkedAt: "agora",
    summary: String(raw?.summary ?? "Resultado gerado pela checagem.").slice(0, 600),
    claims,
    sources,
    origin: origin ?? null,
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

/**
 * @param {{ kind: "link"|"text"|"video"|"image", text: string, fileName: string|null }} input
 * @param {{ onStep?: (index: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ result: object, steps: typeof PIPELINE_STEPS }>}
 */
export async function verify(input, opts = {}) {
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
    throw new Error(ERROR_MESSAGES[code] ?? "Não consegui checar agora. Tente de novo.");
  }
  const data = await res.json();
  opts.onStep?.(4);
  await wait(300, opts.signal);
  opts.onStep?.(PIPELINE_STEPS.length);
  return {
    result: normalize(data.result, input, data.origin ?? null),
    steps: PIPELINE_STEPS,
  };
}
