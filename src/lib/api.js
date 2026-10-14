// ---------------------------------------------------------------------------
// API client — checagem real via POST /api/verify com resposta NDJSON
// incremental (accepted/content/activity/result/error). Falhas viram exceção
// com mensagem amigável; a UI exibe estado de erro com botão de tentar de novo.
// Retorna `{ result }`. Detalhes do modelo ficam no servidor.
// ---------------------------------------------------------------------------

import { ERROR_MESSAGES, OUTCOME_LABEL, migrateVerdict } from "../data/constants.js";

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
    summary: String(raw?.summary ?? "Resultado gerado pela checagem."),
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

/**
 * @param {{ kind: "link"|"text"|"video"|"image", text: string, context?: string, fileName: string|null, file?: File }} input
 * @param {{ onContent?: (content: { modality: string, provisional: boolean, coverage: object }) => void, onActivity?: (activity: { id: string, parent: string|null, state: string, note?: string }) => void, onAccepted?: (accepted: { checkId: string, contract: string }) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ result: object, checkId: string }>}
 *
 * Consome o NDJSON incremental linha a linha (buffer split-chunk): cada chunk
 * decodificado é acumulado até `\n`; linhas completas viram eventos. Eventos de
 * execução obsoleta são ignorados pelo chamador via `runId`. Abort propaga ao
 * fetch e o servidor libera a vaga ao detectar a desconexão.
 */
export async function verify(input, opts = {}) {
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
  if (!res.ok || !contentType.includes("x-ndjson")) {
    await throwAdmissionError(res);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Sem streaming legível, não há como acompanhar o progresso real.
    throw friendlyError("upstream_error", "");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let checkId = null;
  let terminal = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let event = null;
          try {
            event = JSON.parse(line);
          } catch { /* linha incompleta ou estranha: ignora sem quebrar o stream */ }
          if (event?.type === "accepted") {
            checkId = event.checkId ?? checkId;
            opts.onAccepted?.({ checkId, contract: event.contract ?? null });
          } else if (event?.type === "content") {
            opts.onContent?.({ modality: event.modality ?? "unknown", provisional: Boolean(event.provisional), coverage: event.coverage ?? {} });
          } else if (event?.type === "activity") {
            opts.onActivity?.({ id: event.id, parent: event.parent ?? null, state: event.state, note: event.note, seq: event.seq ?? null, at: event.at ?? null });
          } else if (event?.type === "result") {
            terminal = { kind: "result", envelope: event.envelope, checkId: event.checkId ?? checkId };
          } else if (event?.type === "error") {
            terminal = { kind: "error", code: event.code ?? "upstream_error", message: event.message ?? "" };
          }
          if (terminal) {
            try { await reader.cancel(); } catch { /* leitor já encerrado */ }
            break;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (terminal) break;
      opts.signal?.throwIfAborted?.();
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (!terminal) throw friendlyError("upstream_error", "");
  } finally {
    try { reader.releaseLock(); } catch { /* leitor já liberado */ }
  }
  if (!terminal) throw friendlyError("upstream_error", "A conexão foi interrompida antes do resultado.");
  if (terminal.kind === "error") throw friendlyError(terminal.code, terminal.message);
  const data = terminal.envelope ?? {};
  // O identificador da checagem vem no envelope (data.checkId), não no resultado
  // validado: sem ele, o link de contestação não aponta para um registro real.
  const result = normalize({ ...data.result, checkId: data.checkId ?? data.result?.checkId ?? checkId }, input, data.origin ?? null);
  result.cached = Boolean(data.cached);
  result.cachedFrom = data.cachedFrom ?? null;
  return { result, checkId: data.checkId ?? checkId };
}
