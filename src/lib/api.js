// ---------------------------------------------------------------------------
// API client — checagem real via /api/verify. Falhas viram exceção com mensagem
// amigável; a UI exibe estado de erro com botão de tentar de novo.
// Retorna `{ result, steps }`. Detalhes do modelo ficam no servidor.
// ---------------------------------------------------------------------------

import { ERROR_MESSAGES, OUTCOME_LABEL, PIPELINE_STEPS, migrateVerdict } from "../data/constants.js";

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
  const clamp = (value, fallback) => {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback;
  };
  const sources = Array.isArray(raw?.sources)
    ? raw.sources
        .filter((source) => typeof source?.url === "string" && /^https?:\/\//.test(source.url))
        .slice(0, 30)
        .map((source) => ({
          outlet: String(source?.outlet ?? "Fonte").slice(0, 120),
          detail: String(source?.detail ?? "").slice(0, 180),
          citationTitle: String(source?.citationTitle ?? "").slice(0, 300),
          url: source.url,
        }))
    : [];
  const claims = Array.isArray(raw?.claims)
    ? raw.claims.slice(0, 50).map((claim, index) => {
        const sourceIds = Array.isArray(claim?.sourceIds)
          ? claim.sourceIds.filter((id) => Number.isInteger(id) && id >= 0 && id < sources.length)
          : [];
        return {
          id: `c${index + 1}`,
          status: statuses.includes(claim?.status) ? claim.status : "unproven",
          score: clamp(claim?.score, 35),
          text: String(claim?.text ?? "Afirmação").slice(0, 600),
          note: String(claim?.note ?? "").slice(0, 800),
          referencePeriod: claim?.referencePeriod ?? null,
          sourceIds,
          evidence: Array.isArray(claim?.evidence)
            ? claim.evidence
                .filter((item) => sourceIds.includes(item?.sourceId) && ["supports", "refutes", "context"].includes(item?.relation))
                .map((item) => ({
                  sourceId: item.sourceId,
                  relation: item.relation,
                  quote: String(item.quote ?? "").slice(0, 600),
                  referencePeriod: item?.referencePeriod ?? null,
                }))
            : [],
        };
      })
    : [];
  return {
    id: raw?.checkId ?? `r-${Date.now().toString(36)}`,
    verdict: raw?.verdict ? migrateVerdict(raw.verdict, raw.score) : null,
    outcome: raw?.outcome ?? "legacy",
    outcomeLabel: OUTCOME_LABEL[raw?.outcome] ?? null,
    score: clamp(raw?.score, null),
    title: origin?.title ?? titleFrom(input),
    kind: kindLabel(input),
    author: origin?.author ?? "checagem por IA",
    publishedAt: new Date().toLocaleDateString("pt-BR"),
    checkedAt: "agora",
    summary: String(raw?.summary ?? "Resultado gerado pela checagem.").slice(0, 1000),
    claims,
    notCheckedClaims: Array.isArray(raw?.notCheckedClaims) ? raw.notCheckedClaims.slice(0, 50) : [],
    omittedClaimsCount: Number(raw?.omittedClaimsCount) || 0,
    sources,
    origin: origin ?? null,
    cached: Boolean(raw?.cached),
    cachedFrom: raw?.cachedFrom ?? null,
    modelsUsed: raw?.modelsUsed ?? {},
    methodologyVersion: raw?.methodologyVersion ?? null,
    configRevision: raw?.configRevision ?? null,
    mediaCoverage: raw?.mediaCoverage ?? null,
    media: Array.isArray(raw?.media) ? raw.media : [],
    transcript: raw?.transcript ?? null,
    evidence: raw?.evidence ?? null,
    moderation: Array.isArray(raw?.moderation) ? raw.moderation : [],
    moderationCoverage: raw?.moderationCoverage ?? null,
    tokenUsage: raw?.tokenUsage ?? null,
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

async function encodeUpload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let res;
  try {
    const body = {
      kind: input.kind,
      text: input.text,
      fileName: input.fileName,
      fileMime: input.file?.type ?? input.fileMime ?? "",
      fileData: input.file ? await encodeUpload(input.file) : undefined,
    };
    res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  opts.onStep?.(3);
  await wait(300, opts.signal);
  if (!res.ok) {
    let code = "upstream_error";
    let serverMessage = "";
    try {
      const payload = await res.json();
      code = payload?.error ?? code;
      serverMessage = typeof payload?.message === "string" ? payload.message : "";
    } catch { /* corpo ilegível */ }
    const fallback = code === "payload_too_large" ? "O arquivo excede o limite de envio." : "Não consegui checar agora. Tente de novo.";
    const error = new Error(serverMessage || ERROR_MESSAGES[code] || fallback);
    error.code = code;
    throw error;
  }
  const data = await res.json();
  opts.onStep?.(4);
  await wait(300, opts.signal);
  opts.onStep?.(PIPELINE_STEPS.length);
  // O identificador da checagem vem no envelope (data.checkId), não no resultado
  // validado: sem ele, o link de contestação não aponta para um registro real.
  const result = normalize({ ...data.result, checkId: data.checkId ?? data.result?.checkId ?? null }, input, data.origin ?? null);
  result.cached = Boolean(data.cached);
  result.cachedFrom = data.cachedFrom ?? null;
  return {
    result,
    steps: PIPELINE_STEPS,
  };
}
