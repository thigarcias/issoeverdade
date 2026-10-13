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

/**
 * Executa o ciclo completo da requisição de checagem.
 * @returns {Promise<{status:number, body:object, headers?:object}>}
 */
export async function handleVerifyRequest({ method, headers = {}, body, socketAddress, guard = activeGuard(), env = process.env } = {}) {
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
  if (!input.text && !input.fileName && !input.fileBuffer) return jsonError(400, { error: "empty_input" });

  // Política de URL antes de qualquer etapa paga (a mídia revalida na busca).
  const maybeUrl = String(input.text ?? "").trim();
  if (input.kind === "link" && /^https?:\/\//i.test(maybeUrl)) {
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
    try {
      await guard.chargeUnits(undefined, input.kind);
    } catch (error) {
      if (error instanceof LimitsExceeded) {
        return jsonError(429, { error: error.code, message: error.message }, { "Retry-After": String(error.retryAfterSec ?? 3600) });
      }
      if (error instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
      throw error;
    }
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
