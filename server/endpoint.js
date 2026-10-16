// Tratamento compartilhado de POST /api/verify entre a Vercel (api/verify.js) e
// o servidor de desenvolvimento (vite.api-plugin.js). Centraliza:
//   - política de URL (destino público) antes de gastar chamadas de IA;
//   - moderação de conteúdo/propósito (server/moderation.js);
//   - limites de taxa, vagas de concorrência e orçamento diário (server/limits.js);
//   - mapeamento de erro para o contrato da interface.
// Sem controles ativos em produção o endpoint RECUSA a checagem (fail-closed).
import { activeGuard, blockedPayload, LimitsExceeded, LimitsUnavailable } from "./limits.js";
import { clientIp } from "./client-ip.js";
import { randomUUID } from "node:crypto";
import { startRecovery, completeRecovery, failRecovery, readRecovery, RecoveryUnavailable } from "./recovery.js";
import { parseUrlStrict } from "./net.js";
import { normalizeVerifyInput } from "./uploads.js";
import { runVerify } from "./verify.js";

export const MAX_REQUEST_BYTES = 4_300_000;
const KINDS = new Set(["link", "text", "video", "image"]);
const RECOVERY = { start: startRecovery, complete: completeRecovery, fail: failRecovery };

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
  if (status === 502 && code === "output_integrity_failed") return "A checagem não passou na validação de integridade e não foi entregue.";
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
const RECOVERY_TIMEOUT_MS = 5_000;

/** Executa a operação com prazo próprio; no estouro, resolve `onTimeout()`. */
function withTimeout(operation, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timer); return value; },
      (error) => { clearTimeout(timer); throw error; },
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
      if (typeof timer?.unref === "function") timer.unref();
    }),
  ]);
}

export async function executeVerifyStream({ input, slot, guard, checkId = null, onEvent, recoveryStore = RECOVERY, recoveryStartTimeoutMs = RECOVERY_TIMEOUT_MS, recoverySettlementTimeoutMs = RECOVERY_TIMEOUT_MS } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  let seq = 0;
  let terminal = false;
  let capability = null;
  let tokens = 0;
  const send = (event) => {
    if (terminal) return;
    if (event?.type === "result" || event?.type === "error") terminal = true;
    // Delivery callbacks cannot turn a completed analysis into a failed one.
    try { emit({ ...event, seq: ++seq, at: new Date().toISOString() }); } catch { /* disconnected consumer */ }
  };
  const id = typeof checkId === "string" && checkId ? checkId : randomUUID();
  try {
    // A recuperação é complementar: falha ou prazo excedido do registro inicial
    // não impede a checagem permitida, apenas deixa de prometer recuperação.
    try {
      capability = await withTimeout(() => recoveryStore.start(id), recoveryStartTimeoutMs, () => null);
    } catch {
      capability = null;
    }
    if (!capability?.checkId || typeof capability.recoveryToken !== "string") capability = null;
    const recoveryCreated = Boolean(capability);
    send({
      type: "accepted",
      checkId: id,
      contract: VERIFY_CONTRACT,
      recoveryAvailable: recoveryCreated,
      ...(recoveryCreated ? { recoveryToken: capability.recoveryToken } : {}),
    });
    const out = await runVerify(input, {
      checkId: id,
      onProgress: (event) => {
        if (event?.type !== "content" && event?.type !== "activity") return;
        send(event);
      },
    });
    tokens = out?.cached ? 0 : out?.tokenUsage?.total ?? 0;
    let recoveryAvailable = false;
    if (recoveryCreated) {
      // Complete e a eventual marcação de falha compartilham um único prazo.
      // Uma rejeição tardia é observada, mas não inicia outra gravação após ele.
      let expired = false;
      recoveryAvailable = await withTimeout(async () => {
        try {
          await recoveryStore.complete(capability, out);
          return true;
        } catch {
          if (!expired) {
            try {
              await recoveryStore.fail(capability, {
                code: "recovery_unavailable",
                message: "A análise concluiu, mas não foi possível guardar uma cópia recuperável.",
              });
            } catch { /* The valid result is still delivered; recovery is not promised. */ }
          }
          return false;
        }
      }, recoverySettlementTimeoutMs, () => {
        expired = true;
        return false;
      });
    }
    send({ type: "result", checkId: id, recoveryAvailable, envelope: out });
  } catch (err) {
    let code = publicErrorCode(err);
    let message = err?.payload?.message ?? publicErrorMessage(err?.status ?? 502, code) ?? "Não consegui checar agora. Tente de novo.";
    if (err instanceof LimitsUnavailable) {
      code = "limits_unavailable";
      message = blockedPayload(guard)?.message ?? "Controles de uso indisponíveis.";
    } else if (err instanceof RecoveryUnavailable) {
      code = "recovery_unavailable";
      message = "Não foi possível guardar o resultado para recuperação.";
    }
    if (capability) {
      // A gravação do erro é best-effort e limitada: preserva o erro primário.
      try {
        await withTimeout(() => recoveryStore.fail(capability, { code, message }), recoverySettlementTimeoutMs, () => null);
      } catch { /* primary error preserved */ }
    }
    send({ type: "error", checkId: id, code, message: String(message).slice(0, 500) });
  } finally {
    // Keep the execution alive until settlement, without delaying result delivery.
    try {
      if (tokens) await guard.reconcileTokens(tokens).catch(() => null);
    } finally {
      await slot?.release?.().catch(() => {});
    }
  }
  return { checkId: id };
}

/** GET is capability-only and never reserves a slot, charges usage or runs AI. */
export async function handleVerifyRecovery({ method = "GET", headers = {}, query = {}, socketAddress, guard = activeGuard(), env = process.env } = {}) {
  const responseHeaders = { "Cache-Control": "no-store", Vary: "X-Verify-Recovery" };
  if (method !== "GET") return jsonError(405, { error: "method_not_allowed" }, responseHeaders);
  try {
    const rate = await guard.rateLimit(clientIp(headers, socketAddress, env), { bucket: "verify-recovery" });
    if (!rate.allowed) return jsonError(429, { error: "rate_limited", message: "Muitas consultas em pouco tempo. Aguarde alguns minutos." }, { ...responseHeaders, "Retry-After": String(rate.retryAfterSec ?? guard.config.windowSec) });
    const recoveryToken = headers["x-verify-recovery"];
    const state = await readRecovery(query.checkId, recoveryToken);
    if (!state) return jsonError(404, { error: "recovery_not_found", message: "Resultado indisponível ou recuperação expirada." }, responseHeaders);
    if (state.status === "pending") return jsonError(202, state, responseHeaders);
    if (state.status === "failed") return jsonError(409, { status: "failed", error: state.error.code, message: state.error.message }, responseHeaders);
    return jsonError(200, state, responseHeaders);
  } catch (err) {
    if (err instanceof LimitsUnavailable || err instanceof RecoveryUnavailable) return jsonError(503, { error: "recovery_unavailable", message: "Recuperação temporariamente indisponível." }, responseHeaders);
    throw err;
  }
}

/**
 * Executa o ciclo completo da requisição de checagem.
 * @returns {Promise<{status:number, body:object, headers?:object}>}
 */
export async function handleVerifyRequest({ method, headers = {}, query = {}, body, socketAddress, guard = activeGuard(), env = process.env } = {}) {
  if (method === "GET") return handleVerifyRecovery({ method, headers, query, socketAddress, guard, env });
  const admitted = await admitVerifyRequest({ method, headers, body, socketAddress, guard, env });
  if (admitted.status) return admitted;
  const { input, slot } = admitted;
  try {
    const out = await runVerify(input);
    const tokens = out?.cached ? 0 : out?.tokenUsage?.total ?? 0;
    if (tokens) await guard.reconcileTokens(tokens).catch(() => null);
    return { status: 200, body: out };
  } catch (err) {
    if (err instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    return jsonError(err.status ?? 502, err.payload ?? { error: err.message ?? "upstream_error" });
  } finally {
    await slot?.release?.().catch(() => {});
  }
}
