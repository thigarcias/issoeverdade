// Endpoint administrativo compartilhado (Vercel e dev): registros de checagem,
// catálogo/configuração de IA, fila de correções, métricas operacionais e
// invalidação de cache. Toda ação exige o Bearer de ADMIN_SECRET: comparação em
// tempo constante, mínimo de tamanho e trava por origem nas falhas.
import { createHash, timingSafeEqual } from "node:crypto";
import { appendCorrectionToLog, getCheckLog, listCheckLogs, logEnabled, logMode } from "./checklog.js";
import { reportStorageError, storageFailureMessage } from "./supabase.js";
import { aiConfigCatalog, getAiConfigState, saveAiConfig } from "./ai-config.js";
import { invalidateCache } from "./cache.js";
import { activeGuard, createGuard, limitsConfig } from "./limits.js";
import { clientIp } from "./client-ip.js";
import { mediaLimits } from "./media.js";
import { snapshot as metricsSnapshot, recordCorrection } from "./metrics.js";
import { moderationConfig } from "./moderation.js";
import { PROMPT_VERSION, VERDICT_BANDS } from "./scoring.js";
import {
  CORRECTION_STATUSES,
  adminCorrection,
  correctionsEnabled,
  correctionsMode,
  getCorrection,
  isOperationalReport,
  listCorrections,
  updateCorrection,
} from "./corrections.js";

export const METHODOLOGY = {
  version: PROMPT_VERSION,
  bands: VERDICT_BANDS,
  statuses: [
    { id: "checked", label: "Checagem executada" },
    { id: "partial_coverage", label: "Cobertura parcial" },
    { id: "insufficient_input", label: "Material insuficiente" },
    { id: "inaccessible_media", label: "Mídia inacessível" },
    { id: "no_verifiable_claims", label: "Sem afirmação verificável" },
    { id: "content_refused", label: "Recusado por política de conteúdo" },
    { id: "moderation_uncovered", label: "Vídeo sem cobertura de moderação" },
    { id: "error", label: "Erro operacional" },
    { id: "legacy", label: "Registro legado" },
  ],
  evaluation: {
    harness: "scripts/evaluate-factual.mjs",
    corpusTool: "scripts/corpus-tool.mjs",
    corpus: null,
    benchmarkPublished: false,
    note: "Nenhum corpus humano anotado foi entregue; nenhuma taxa de precisão é publicada.",
  },
};

function jsonError(status, body) {
  return { status, body };
}

/** Mínimo de ADMIN_SECRET: 32 caracteres aleatórios (UUID v4, openssl rand -hex 32…). */
export const MIN_SECRET_CHARS = 32;
/** Falhas de chave toleradas por origem dentro da janela da trava. */
export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_SEC = 15 * 60;

const AUTH_BUCKET = "admin-auth";
// Contador por instância para quando não há backend compartilhado (produção sem
// Redis/KV resolve para "blocked" e fica sem store no guard ativo).
const localAuthGuard = createGuard({ ...limitsConfig(), mode: "memory" });

/** Comparação em tempo constante: hashes de tamanho fixo antes do timingSafeEqual. */
function secretMatches(authorization, secret) {
  const provided = createHash("sha256").update(String(authorization ?? "")).digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(provided, expected);
}

/**
 * Consulta o bloqueio antes de comparar credenciais; só incrementa nas falhas.
 * Uma origem bloqueada não pode testar nem mesmo a chave correta até o TTL.
 */
async function authLimit({ headers, socketAddress, env }, failed = false) {
  const identity = clientIp(headers, socketAddress, env);
  const options = { bucket: AUTH_BUCKET, max: AUTH_FAILURE_LIMIT, windowSec: AUTH_FAILURE_WINDOW_SEC };
  const check = async (guard) => {
    if (failed) {
      const rate = await guard.rateLimit(identity, options);
      return rate.allowed ? null : rate.retryAfterSec ?? AUTH_FAILURE_WINDOW_SEC;
    }
    const key = `iev:limits:v1:rate:${AUTH_BUCKET}:${identity}`;
    const hits = Number(await guard.store.get(key));
    if (hits < AUTH_FAILURE_LIMIT) return null;
    const ttl = await guard.store.ttl(key);
    return ttl > 0 ? ttl : AUTH_FAILURE_WINDOW_SEC;
  };
  const guard = activeGuard(env);
  if (guard.store) {
    try {
      return await check(guard);
    } catch (error) {
      // Contador compartilhado indisponível: cai no contador local em vez de
      // liberar tentativas sem trava.
      reportStorageError("admin-auth-limit", logMode(), error);
    }
  }
  return check(localAuthGuard);
}

/** Estado operacional exibido no painel: modos e limites, sem segredos. */
export function systemState(env = process.env) {
  const guard = activeGuard(env);
  const moderation = moderationConfig(env);
  const limits = mediaLimits(env);
  return {
    limits: guard.describe(),
    moderation: {
      mode: moderation.mode,
      model: moderation.model,
      refuseCategories: moderation.refuseCategories,
      videoCoverage: moderation.videoCoverage || "uncovered",
      frameSamples: moderation.maxFramesChecked,
    },
    media: {
      maxMediaSeconds: limits.maxMediaSeconds,
      maxTransferBytes: limits.maxTransferBytes,
      maxTempBytes: limits.maxTempBytes,
      maxFileBytes: limits.maxFileBytes,
    },
    corrections: { mode: correctionsMode(env), durable: correctionsEnabled() },
    logs: { enabled: logEnabled(env), mode: logMode(env) },
    urlPolicy: {
      ports: String(env.IEV_HTTP_PORTS ?? "80,443"),
      allowPrivateHosts: env.IEV_ALLOW_PRIVATE_HOSTS === "1",
    },
  };
}

export async function handleAdminRequest({ method, headers = {}, query = {}, body = null, socketAddress, env = process.env } = {}) {
  const secret = env.ADMIN_SECRET || "";
  if (!secret) return jsonError(503, { error: "admin_disabled" });
  if (secret.length < MIN_SECRET_CHARS) return jsonError(503, { error: "admin_secret_too_weak", minLength: MIN_SECRET_CHARS, message: `ADMIN_SECRET tem menos de ${MIN_SECRET_CHARS} caracteres. O painel fica desabilitado até configurar um segredo aleatório maior (openssl rand -hex 32).` });
  const retryAfterSec = await authLimit({ headers, socketAddress, env });
  if (retryAfterSec) return { status: 429, body: { error: "too_many_attempts", message: `Origem temporariamente bloqueada após falhas de autenticação. Tente novamente em ${retryAfterSec}s.` }, headers: { "Retry-After": String(retryAfterSec) } };
  if (!secretMatches(headers.authorization, secret)) {
    await authLimit({ headers, socketAddress, env }, true);
    return jsonError(401, { error: "unauthorized" });
  }

  if (query.metrics !== undefined && query.metrics !== "0") {
    if (method !== "GET") return jsonError(405, { error: "method_not_allowed" });
    const guard = activeGuard(env);
    const system = systemState(env);
    const used = await guard.store?.get?.(`iev:limits:v1:budget:${new Date().toISOString().slice(0, 10)}`).catch(() => null);
    const budgetUsed = Number(used ?? 0);
    return {
      status: 200,
      body: {
        metrics: metricsSnapshot({
          limitsMode: guard.mode,
          budgetUsedPct: guard.config.dailyUnits ? budgetUsed / guard.config.dailyUnits : undefined,
          moderationMode: system.moderation.mode,
          videoCoverage: system.moderation.videoCoverage,
        }, env),
        system,
      },
    };
  }

  if (query.cache !== undefined && query.cache !== "0") {
    if (method !== "POST") return jsonError(405, { error: "method_not_allowed" });
    if (body?.action !== "invalidate") return jsonError(400, { error: "bad_action" });
    const out = await invalidateCache(String(body?.reason ?? "manual").slice(0, 120));
    return { status: out.ok ? 200 : 502, body: out };
  }

  if (query.corrections !== undefined && query.corrections !== "0") {
    if (method === "GET") {
      const listed = await listCorrections();
      return {
        status: 200,
        body: {
          ...listed,
          statuses: CORRECTION_STATUSES,
          items: listed.items,
        },
      };
    }
    if (method === "POST") {
      const protocol = String(body?.protocol ?? "");
      if (!protocol) return jsonError(400, { error: "missing_protocol" });
      const updated = await updateCorrection(protocol, { status: body?.status, note: body?.note, actor: body?.actor });
      if (!updated.ok) return jsonError(updated.status ?? 400, { error: updated.error });
      recordCorrection(updated.record.status === "corrected" ? "corrected" : "updated");
      const record = updated.record;
      let applied = null;
      const editorialCorrection = record.status === "corrected" && record.checkId && !isOperationalReport(record.kind);
      if (editorialCorrection) {
        applied = await appendCorrectionToLog(record.checkId, {
          protocol: record.protocol,
          note: body?.note ?? record.claim ?? "",
          actor: body?.actor,
          status: record.status,
        });
        await invalidateCache(`correção ${record.protocol}`);
      }
      return { status: 200, body: { correction: adminCorrection(record), applied, cacheInvalidated: Boolean(editorialCorrection) } };
    }
    return jsonError(405, { error: "method_not_allowed" });
  }

  if (query.correction !== undefined) {
    if (method !== "GET") return jsonError(405, { error: "method_not_allowed" });
    const record = await getCorrection(String(query.correction));
    if (!record) return jsonError(404, { error: "not_found" });
    return { status: 200, body: { correction: adminCorrection(record), statuses: CORRECTION_STATUSES } };
  }

  if (query.config !== undefined && query.config !== "0") {
    if (method === "GET") {
      const refresh = query.refresh === "1" || query.refresh === "true";
      const catalog = await aiConfigCatalog({ refresh });
      const state = await getAiConfigState();
      return {
        status: 200,
        body: {
          catalog,
          config: state.config,
          configErrors: state.configErrors,
          source: state.source,
          revision: state.revision,
          updatedAt: state.updatedAt,
          persisted: state.persisted,
          stale: Boolean(state.stale),
          staleReason: state.staleReason ?? null,
          error: state.error ?? null,
          methodology: METHODOLOGY,
        },
      };
    }
    if (method === "POST") {
      if (!body || typeof body.config !== "object") return jsonError(400, { error: "bad_config" });
      try {
        return { status: 200, body: await saveAiConfig(body.config) };
      } catch (error) {
        if (error?.status === 400) return jsonError(400, { error: "invalid_ai_config", fields: error.fields });
        return jsonError(502, { error: "config_save_failed" });
      }
    }
    return jsonError(405, { error: "method_not_allowed" });
  }

  if (method !== "GET") return jsonError(405, { error: "method_not_allowed" });
  const id = typeof query.id === "string" ? query.id : "";
  try {
    if (id) {
      const record = await getCheckLog(id);
      if (!record) return jsonError(404, { error: "not_found" });
      return { status: 200, body: { record } };
    }
    const listed = await listCheckLogs(query);
    return { status: listed.error ? 502 : 200, body: listed };
  } catch (error) {
    if (error?.code === "invalid_log_query") return jsonError(400, { error: "invalid_log_query" });
    reportStorageError("admin-read", logMode(), error);
    return jsonError(502, { error: "logs_storage_failed", enabled: logEnabled(), mode: logMode(), message: storageFailureMessage(logMode(), error) });
  }
}
