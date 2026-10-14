// Tratamento compartilhado de POST /api/verify entre a Vercel (api/verify.js) e
// o servidor de desenvolvimento (vite.api-plugin.js). Centraliza:
//   - política de URL (destino público) antes de gastar chamadas de IA;
//   - moderação de conteúdo/propósito (server/moderation.js);
//   - limites de taxa, vagas de concorrência e orçamento diário (server/limits.js);
//   - mapeamento de erro para o contrato da interface.
// Sem controles ativos em produção o endpoint RECUSA a checagem (fail-closed).
import { activeGuard, blockedPayload, LimitsExceeded, LimitsUnavailable } from "./limits.js";
import { parseUrlStrict } from "./net.js";
import { normalizeVerifyInput } from "./uploads.js";
import { runVerify } from "./verify.js";

export const MAX_REQUEST_BYTES = 4_300_000;
const KINDS = new Set(["link", "text", "video", "image"]);

/** IP do cliente conforme o proxy confiável da hospedagem. */
export function clientIp(headers, socketAddress, env = process.env) {
  const trustProxy = env.IEV_TRUST_PROXY !== "0";
  if (trustProxy) {
    const header = String(env.IEV_TRUST_PROXY_HEADER || "x-forwarded-for").toLowerCase();
    const raw = headers?.[header] ?? headers?.["x-real-ip"] ?? "";
    const value = String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
    if (value) return value.slice(0, 64);
  }
  return String(socketAddress ?? "").split(",")[0].trim().slice(0, 64) || "unknown";
}

function jsonError(status, body, headers = {}) {
  return { status, body, headers };
}

export const VERIFY_NDJSON_TYPE = "application/x-ndjson";
export const VERIFY_CONTRACT = "iev-verify-ndjson/1";

function publicErrorCode(err) {
  const code = err?.payload?.error ?? err?.message ?? "upstream_error";
  return typeof code === "string" && code ? code.slice(0, 80) : "upstream_error";
}

function publicErrorMessage(status, code) {
  if (status === 503 && code === "missing_api_key") return "Serviço de checagem indisponível no momento.";
  if (status === 504) return "A checagem demorou demais. Tente de novo.";
  if (status === 503 && code === "moderation_unavailable") return "Moderação de conteúdo indisponível; a checagem não foi executada.";
  return undefined;
}

/**
 * Admissão: validação, limites e reserva de vaga antes de qualquer etapa paga.
 * Erros aqui continuam JSON + status (pré-headers do stream).
 * @returns {Promise<{status:number, body:object, headers?:object}|{input:object, slot:object, guard:object}>}
 */
export async function admitVerifyRequest({ method, headers = {}, body, socketAddress, guard = activeGuard(), env = process.env } = {}) {
  if (method !== "POST") return jsonError(405, { error: "method_not_allowed" });
  if (guard.mode === "blocked") {
    return jsonError(503, blockedPayload(guard));
  }
  if (guard.mode === "off" && guard.config.production) {
    return jsonError(503, blockedPayload(guard));
  }
  const ip = clientIp(headers, socketAddress, env);
  try {
    const rate = await guard.rateLimit(ip);
    if (!rate.allowed) {
      return jsonError(429, {
        error: "rate_limited",
        message: "Muitas checagens em pouco tempo. Aguarde alguns minutos.",
      }, { "Retry-After": String(rate.retryAfterSec ?? guard.config.windowSec) });
    }
  } catch (error) {
    if (error instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    throw error;
  }
  if (!KINDS.has(body?.kind)) return jsonError(400, { error: "bad_kind" });

  let input;
  try {
    input = normalizeVerifyInput(body);
  } catch (error) {
    return jsonError(error.status ?? 400, { error: error.message ?? "invalid_input" });
  }
  if (input.kind === "link" ? !String(input.text ?? "").trim() : !input.text && !input.fileName && !input.fileBuffer) {
    return jsonError(400, { error: "empty_input" });
  }

  // Política de URL antes de qualquer etapa paga (a mídia revalida na busca).
  const maybeUrl = String(input.text ?? "").trim();
  if (input.kind === "link") {
    try {
      parseUrlStrict(maybeUrl);
    } catch (error) {
      const code = error?.code ?? "bad_url";
      const privateCodes = ["private_address", "private_hostname", "port_not_allowed", "url_credentials"];
      return jsonError(400, {
        error: privateCodes.includes(code) ? "private_url" : "invalid_url",
        message: privateCodes.includes(code)
          ? "Esse endereço não é aceito: apenas páginas públicas em HTTP/HTTPS."
          : "URL inválida.",
        reason: code,
      });
    }
  }

  let slot = null;
  try {
    slot = await guard.acquireSlot();
  } catch (error) {
    if (error instanceof LimitsExceeded) {
      return jsonError(429, { error: error.code, message: error.message }, { "Retry-After": String(error.retryAfterSec ?? 30) });
    }
    if (error instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    throw error;
  }
  try {
    await guard.chargeUnits(undefined, input.kind);
  } catch (error) {
    await slot?.release?.().catch(() => {});
    if (error instanceof LimitsExceeded) {
      return jsonError(429, { error: error.code, message: error.message }, { "Retry-After": String(error.retryAfterSec ?? 3600) });
    }
    if (error instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    throw error;
  }
  return { input, slot, guard };
}

/**
 * Execução: roda a checagem com callback de progresso e concilia o consumo.
 * `onEvent` recebe eventos NDJSON (`accepted`/`content`/`activity`/`result`/`error`);
 * exatamente um terminal (`result` ou `error`) é emitido, com `seq` crescente.
 */
export async function executeVerifyStream({ input, slot, guard, checkId = null, onEvent } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  let seq = 0;
  let terminal = false;
  const send = (event) => {
    if (terminal) return;
    seq += 1;
    emit({ ...event, seq, at: new Date().toISOString() });
    if (event?.type === "result" || event?.type === "error") terminal = true;
  };
  const id = typeof checkId === "string" && checkId ? checkId : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  send({ type: "accepted", checkId: id, contract: VERIFY_CONTRACT });
  try {
    const out = await runVerify(input, {
      onProgress: (event) => {
        if (event?.type !== "content" && event?.type !== "activity") return;
        send(event);
      },
    });
    const tokens = out?.tokenUsage?.total ?? 0;
    if (tokens) await guard.reconcileTokens(tokens).catch(() => null);
    send({ type: "result", checkId: out?.checkId ?? id, envelope: out });
  } catch (err) {
    if (err instanceof LimitsUnavailable) {
      send({ type: "error", code: "limits_unavailable", message: blockedPayload(guard)?.message ?? "Controles de uso indisponíveis." });
    } else {
      const status = err?.status ?? 502;
      const code = publicErrorCode(err);
      const message = err?.payload?.message ?? publicErrorMessage(status, code) ?? "Não consegui checar agora. Tente de novo.";
      send({ type: "error", code, message: String(message).slice(0, 500) });
    }
  } finally {
    await slot?.release?.().catch(() => {});
  }
  return { checkId: id };
}

/**
 * Executa o ciclo completo da requisição de checagem.
 * @returns {Promise<{status:number, body:object, headers?:object}>}
 */
export async function handleVerifyRequest({ method, headers = {}, body, socketAddress, guard = activeGuard(), env = process.env } = {}) {
  const admitted = await admitVerifyRequest({ method, headers, body, socketAddress, guard, env });
  if (admitted.status) return admitted;
  const { input, slot } = admitted;
  try {
    const out = await runVerify(input);
    const tokens = out?.tokenUsage?.total ?? 0;
    if (tokens) await guard.reconcileTokens(tokens).catch(() => null);
    return { status: 200, body: out };
  } catch (err) {
    if (err instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    return jsonError(err.status ?? 502, err.payload ?? { error: err.message ?? "upstream_error" });
  } finally {
    await slot?.release?.().catch(() => {});
  }
}
