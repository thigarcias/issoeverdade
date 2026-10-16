// ---------------------------------------------------------------------------
// API client — checagem real via POST /api/verify com resposta NDJSON
// incremental (accepted/content/activity/result/error). Falhas viram exceção
// com mensagem amigável; a UI exibe estado de erro com botão de tentar de novo.
// Retorna `{ result }`. Detalhes do modelo ficam no servidor.
// ---------------------------------------------------------------------------

import { ASSESSMENT_BASIS, ERROR_MESSAGES, EVIDENCE_SUPPORT, EVIDENCE_VERIFICATION, OUTCOME_LABEL, migrateVerdict } from "../data/constants.js";

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

function titleFrom(input, raw, origin) {
  const candidates = [origin?.title, raw?.claims?.[0]?.text, input.kind === "text" ? input.text : "", input.fileName];
  const title = candidates.find((value) => typeof value === "string" && value.trim() && !/^https?:\/\//i.test(value.trim()));
  const text = title?.trim() || "Conteúdo enviado para análise";
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/** Normaliza o JSON do modelo para o formato que o ResultCard espera. */
function normalize(raw, input, origin, createdAt) {
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
          assessmentBasis: typeof claim?.assessmentBasis === "string" && Object.hasOwn(ASSESSMENT_BASIS, claim.assessmentBasis) ? claim.assessmentBasis : null,
          assessmentNote: typeof claim?.assessmentNote === "string" ? claim.assessmentNote.slice(0, 800) : "",
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
                  verification: typeof item?.verification === "string" && Object.hasOwn(EVIDENCE_VERIFICATION, item.verification) ? item.verification : null,
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
    title: titleFrom(input, raw, origin),
    kind: kindLabel(input),
    author: origin?.author ?? "checagem por IA",
    createdAt: createdAt ?? new Date().toISOString(),
    publishedAt: new Date(createdAt ?? Date.now()).toLocaleDateString("pt-BR"),
    checkedAt: createdAt ? new Date(createdAt).toLocaleString("pt-BR") : "agora",
    summary: String(raw?.summary ?? "Resultado gerado pela checagem."),
    claims,
    notCheckedClaims: Array.isArray(raw?.notCheckedClaims) ? raw.notCheckedClaims.slice(0, 50) : [],
    omittedClaimsCount: Number(raw?.omittedClaimsCount) || 0,
    coverage: raw?.coverage ?? null,
    sources,
    origin: origin ?? (/^https?:\/\//i.test(input.text?.trim() ?? "") ? { url: input.text.trim() } : null),
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
  const result = normalize({ ...data.result, checkId: id, methodologyVersion: typeof data.methodologyVersion === "string" ? data.methodologyVersion : null }, input, data.origin ?? null);
  result.cached = Boolean(data.cached);
  result.cachedFrom = data.cachedFrom ?? null;
  result.persisted = data.storage?.persisted === true;
  if (result.persisted && typeof data.storage?.shareToken === "string" && data.storage.shareToken) {
    result.shareToken = data.storage.shareToken;
  }
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
      // Servidores antigos não informavam `recoveryAvailable`: um token válido
      // continua sendo capacidade. A indisponibilidade explícita nunca é
      // confundida com recuperação disponível.
      const offered = event.recoveryAvailable !== false && typeof checkId === "string" && typeof event.recoveryToken === "string";
      if (offered) capability = { checkId, recoveryToken: event.recoveryToken };
      notify(opts.onAccepted, { checkId, recoveryAvailable: offered, recoveryToken: offered ? event.recoveryToken : null, contract: event.contract ?? null });
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
    // Sem capacidade não existe GET possível nem nova inferência automática:
    // a execução pode ter continuado no servidor sem resultado recuperável.
    throw withRecovery(friendlyError("upstream_error", "A conexão foi interrompida antes do resultado e esta execução não tem cópia recuperável. Ela pode ter continuado no servidor sem resultado disponível."), null);
  }
  if (terminal.kind === "error") throw withRecovery(friendlyError(terminal.code, terminal.message), null);
  return recoveredResult(terminal.envelope, input, terminal.checkId);
}

async function checksResponse(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error || !data) {
    const error = new Error(res.status === 404
      ? "Checagem não encontrada ou não publicada."
      : data?.message || "O serviço de compartilhamento está indisponível. Tente novamente.");
    error.code = data?.error ?? "checks_unavailable";
    error.status = res.status;
    throw error;
  }
  return data;
}

/** Publica somente com a capacidade privada entregue nesta execução. */
export async function publishCheck(result, { signal } = {}) {
  if (!result?.id || !result.persisted || !result.shareToken || result.publicView) {
    throw new Error("Link indisponível para esta checagem. Você ainda pode exportar o texto e as imagens.");
  }
  const data = await checksResponse(await fetch("/api/checks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkId: result.id, shareToken: result.shareToken }),
    signal,
    cache: "no-store",
  }));
  if (data.id !== result.id) throw new Error("O serviço não confirmou a publicação desta checagem.");
  return { id: data.id, url: `/?check=${encodeURIComponent(data.id)}` };
}

/** A leitura pública nunca recupera capacidade de publicação ou dados privados. */
export async function getPublishedCheck(id, { signal } = {}) {
  const data = await checksResponse(await fetch(`/api/checks?id=${encodeURIComponent(id)}`, {
    signal,
    cache: "no-store",
  }));
  if (data.checkId !== id || !data.result || typeof data.result !== "object" || Array.isArray(data.result)
    || !data.createdAt || !Number.isFinite(Date.parse(data.createdAt))) {
    throw new Error("O serviço retornou uma checagem incompleta. Tente novamente.");
  }
  const result = normalize({ ...data.result, checkId: id, methodologyVersion: typeof data.methodologyVersion === "string" ? data.methodologyVersion : null }, { kind: "", text: "" }, data.origin ?? null, data.createdAt);
  result.kind = "Checagem compartilhada";
  result.persisted = true;
  result.published = true;
  result.publicView = true;
  return result;
}
