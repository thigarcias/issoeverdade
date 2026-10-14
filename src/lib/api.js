// ---------------------------------------------------------------------------
// API client — checagem real via POST /api/verify com resposta NDJSON
// incremental (accepted/content/activity/result/error). Falhas viram exceção
// com mensagem amigável; a UI exibe estado de erro com botão de tentar de novo.
// Retorna `{ result }`. Detalhes do modelo ficam no servidor.
// ---------------------------------------------------------------------------

import { ERROR_MESSAGES, EVIDENCE_SUPPORT, EVIDENCE_VERIFICATION, OUTCOME_LABEL, migrateVerdict } from "../data/constants.js";

export const VERIFY_NDJSON_TYPE = "application/x-ndjson";

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
          score: clamp(claim?.score, null),
          evidenceSupport: Object.hasOwn(EVIDENCE_SUPPORT, claim?.evidenceSupport) ? claim.evidenceSupport : null,
          text: String(claim?.text ?? "Afirmação"),
          note: String(claim?.note ?? ""),
          referencePeriod: claim?.referencePeriod ?? null,
          comparison: claim?.comparison ?? null,
          evidenceReview: claim?.evidenceReview ?? null,
          sourceIds,
          evidence: Array.isArray(claim?.evidence)
            ? claim.evidence
                .filter((item) => sourceIds.includes(item?.sourceId) && ["supports", "refutes", "context"].includes(item?.relation))
                .map((item) => ({
                  sourceId: item.sourceId,
                  evidenceId: typeof item?.evidenceId === "string" ? item.evidenceId : null,
                  relation: item.relation,
                  verification: Object.hasOwn(EVIDENCE_VERIFICATION, item?.verification) ? item.verification : null,
                  quote: String(item.quote ?? ""),
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
    summary: String(raw?.summary ?? "Resultado gerado pela checagem."),
    claims,
    notCheckedClaims: Array.isArray(raw?.notCheckedClaims) ? raw.notCheckedClaims.slice(0, 50) : [],
    omittedClaimsCount: Number(raw?.omittedClaimsCount) || 0,
    coverage: raw?.coverage ?? null,
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

async function encodeUpload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function friendlyError(code, serverMessage) {
  const fallback = code === "payload_too_large" ? "O arquivo excede o limite de envio." : "Não consegui checar agora. Tente de novo.";
  const error = new Error(serverMessage || ERROR_MESSAGES[code] || fallback);
  error.code = code;
  return error;
}

async function throwAdmissionError(res) {
  let code = "upstream_error";
  let serverMessage = "";
  try {
    const payload = await res.json();
    code = payload?.error ?? code;
    serverMessage = typeof payload?.message === "string" ? payload.message : "";
  } catch { /* corpo ilegível */ }
  throw friendlyError(code, serverMessage);
}

function notify(callback, value) {
  try {
    const pending = callback?.(value);
    pending?.catch?.(() => {});
  } catch { /* UI progress observers must not discard a valid result. */ }
}

function recoveredResult(data, input, checkId) {
  if (!data || typeof data !== "object" || !data.result || typeof data.result !== "object" || Array.isArray(data.result)) {
    throw friendlyError("upstream_error", "Resposta de checagem incompleta.");
  }
  const id = data.checkId ?? data.result.checkId ?? checkId;
  const result = normalize({ ...data.result, checkId: id }, input, data.origin ?? null);
  result.cached = Boolean(data.cached);
  result.cachedFrom = data.cachedFrom ?? null;
  return { result, checkId: id };
}

function withRecovery(error, recovery) {
  error.recovery = recovery;
  return error;
}

async function recover(input, capability, opts) {
  try {
    opts.signal?.throwIfAborted?.();
    const res = await fetch(`/api/verify?checkId=${encodeURIComponent(capability.checkId)}`, {
      method: "GET",
      headers: { "X-Verify-Recovery": capability.recoveryToken },
      signal: opts.signal,
      cache: "no-store",
    });
    const payload = await res.json();
    opts.signal?.throwIfAborted?.();
    if (res.status === 202 && payload?.status === "pending") {
      throw withRecovery(friendlyError("recovery_pending", "A checagem original ainda está em andamento. Aguarde e tente recuperar o resultado."), capability);
    }
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw withRecovery(friendlyError(payload?.error ?? "recovery_unavailable", payload?.message), transient ? capability : null);
    }
    if (payload?.status !== "completed") throw withRecovery(friendlyError("recovery_unavailable", "Resultado ainda indisponível."), capability);
    const out = recoveredResult(payload.envelope, input, capability.checkId);
    out.result.recovered = true;
    return out;
  } catch (error) {
    if (error?.name === "AbortError" || opts.signal?.aborted) throw error;
    if (Object.hasOwn(error, "recovery")) throw error;
    throw withRecovery(friendlyError("recovery_unavailable", "Não foi possível recuperar o resultado. Tente de novo."), capability);
  }
}

/**
 * POST streams accepted/content/activity/result/error. A supplied recovery
 * capability performs GET only; pending recovery never launches another analysis.
 * @param {object} input
 * @param {{onContent?: Function, onActivity?: Function, onAccepted?: Function, recovery?: {checkId: string, recoveryToken: string}, signal?: AbortSignal}} opts
 * @returns {Promise<{result: object, checkId: string}>}
 */
export async function verify(input, opts = {}) {
  opts.signal?.throwIfAborted?.();
  if (opts.recovery) return recover(input, opts.recovery, opts);
  const body = {
    kind: input.kind,
    text: input.text,
    context: input.kind === "image" ? input.context ?? "" : "",
    fileName: input.fileName,
    fileMime: input.file?.type ?? input.fileMime ?? "",
    fileData: input.file ? await encodeUpload(input.file) : undefined,
  };
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const contentType = String(res.headers?.get?.("content-type") ?? "");
  if (!res.ok || !contentType.includes("x-ndjson")) await throwAdmissionError(res);
  const reader = res.body?.getReader?.();
  if (!reader) throw friendlyError("upstream_error", "");
  const decoder = new TextDecoder();
  let buffer = "";
  let checkId = null;
  let capability = null;
  let terminal = null;
  const consume = (line) => {
    if (!line.trim() || terminal) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === "accepted") {
      checkId = event.checkId ?? checkId;
      if (typeof checkId === "string" && typeof event.recoveryToken === "string") capability = { checkId, recoveryToken: event.recoveryToken };
      notify(opts.onAccepted, { checkId, recoveryToken: event.recoveryToken ?? null, contract: event.contract ?? null });
    } else if (event?.type === "content") {
      notify(opts.onContent, { modality: event.modality ?? "unknown", provisional: Boolean(event.provisional), coverage: event.coverage ?? {} });
    } else if (event?.type === "activity") {
      notify(opts.onActivity, { id: event.id, parent: event.parent ?? null, state: event.state, note: event.note, seq: event.seq ?? null, at: event.at ?? null });
    } else if (event?.type === "result" && event.envelope?.result && typeof event.envelope.result === "object" && !Array.isArray(event.envelope.result)) {
      terminal = { kind: "result", envelope: event.envelope, checkId: event.checkId ?? checkId };
    } else if (event?.type === "error") {
      terminal = { kind: "error", code: event.code ?? "upstream_error", message: event.message ?? "" };
    }
  };
  const finishBuffer = () => {
    buffer += decoder.decode();
    consume(buffer);
    buffer = "";
  };
  try {
    for (;;) {
      opts.signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      opts.signal?.throwIfAborted?.();
      if (done) {
        finishBuffer();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !terminal) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (terminal) {
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError" || opts.signal?.aborted) throw error;
    // A read may fail immediately after delivering a complete record without LF.
    finishBuffer();
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  opts.signal?.throwIfAborted?.();
  if (!terminal) {
    if (capability) return recover(input, capability, opts);
    throw withRecovery(friendlyError("upstream_error", "A conexão foi interrompida antes do resultado."), null);
  }
  if (terminal.kind === "error") throw withRecovery(friendlyError(terminal.code, terminal.message), null);
  return recoveredResult(terminal.envelope, input, terminal.checkId);
}
