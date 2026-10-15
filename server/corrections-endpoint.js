// Endpoint público de contestação: POST cria o protocolo, GET consulta o estado.
// Compartilhado entre a Vercel (api/corrections.js) e o servidor de dev.
import { activeGuard, blockedPayload, LimitsExceeded, LimitsUnavailable } from "./limits.js";
import { clientIp } from "./client-ip.js";
import {
  correctionsForCheck,
  correctionsMode,
  createCorrection,
  getCorrection,
  normalizeCorrection,
  publicCorrection,
} from "./corrections.js";

function jsonError(status, body, headers = {}) {
  return { status, body, headers };
}

export async function handleCorrectionsRequest({
  method,
  headers = {},
  query = {},
  body = null,
  socketAddress,
  guard = activeGuard(),
  env = process.env,
} = {}) {
  const mode = correctionsMode(env);
  if (method === "GET") {
    const checkId = String(query.checkId ?? "");
    if (checkId) {
      const listed = await correctionsForCheck(checkId);
      if (!listed.ok) return jsonError(400, { error: listed.error });
      return { status: 200, body: { checkId: listed.checkId, corrections: listed.corrections, correctedAt: listed.correctedAt } };
    }
    const protocol = String(query.protocol ?? "");
    if (!protocol) return jsonError(400, { error: "missing_protocol" });
    const record = await getCorrection(protocol);
    if (!record) return jsonError(404, { error: "not_found" });
    return { status: 200, body: { correction: publicCorrection(record) } };
  }
  if (method !== "POST") return jsonError(405, { error: "method_not_allowed" });
  if (mode === "blocked") {
    return jsonError(503, {
      error: "corrections_unavailable",
      message: "O canal de correções está indisponível nesta implantação: o armazenamento durável não está configurado.",
    });
  }
  const ip = clientIp(headers, socketAddress, env);
  try {
    const rate = await guard.rateLimit(ip, { bucket: "corrections", max: guard.config.correctionsPerWindow });
    if (!rate.allowed) {
      return jsonError(429, {
        error: "rate_limited",
        message: "Muitos pedidos em pouco tempo. Aguarde alguns minutos.",
      }, { "Retry-After": String(rate.retryAfterSec ?? guard.config.windowSec) });
    }
  } catch (error) {
    if (error instanceof LimitsUnavailable) return jsonError(503, blockedPayload(guard));
    if (error instanceof LimitsExceeded) return jsonError(429, { error: error.code, message: error.message });
    throw error;
  }
  if (String(body?.website ?? "").trim()) {
    // Campo armadilha: formulário automatizado.
    return jsonError(400, { error: "bad_request" });
  }
  const normalized = normalizeCorrection(body);
  if (!normalized.ok) return jsonError(normalized.status ?? 400, { error: normalized.error });
  try {
    const record = await createCorrection(normalized.value);
    return {
      status: 201,
      body: {
        protocol: record.protocol,
        status: record.status,
        persisted: record.persisted,
        message: record.persisted
          ? "Pedido registrado. Guarde o protocolo para acompanhar a revisão."
          : "Pedido registrado apenas nesta instância (sem armazenamento durável configurado).",
      },
    };
  } catch (error) {
    return jsonError(502, {
      error: "corrections_write_failed",
      message: "Não foi possível registrar o pedido agora. Tente novamente mais tarde.",
      detail: String(error?.message ?? error).slice(0, 160),
    });
  }
}
