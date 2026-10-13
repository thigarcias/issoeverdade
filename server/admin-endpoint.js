// Endpoint administrativo compartilhado (Vercel e dev): registros de checagem,
// catálogo/configuração de IA, fila de correções, métricas operacionais e
// invalidação de cache. Toda ação exige ADMIN_SECRET.
import { appendCorrectionToLog, getCheckLog, listCheckLogs, logEnabled } from "./checklog.js";
import { aiConfigCatalog, getAiConfigState, saveAiConfig } from "./ai-config.js";
import { invalidateCache } from "./cache.js";
import { activeGuard } from "./limits.js";
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
    logs: { enabled: logEnabled() },
    urlPolicy: {
      ports: String(env.IEV_HTTP_PORTS ?? "80,443"),
      allowPrivateHosts: env.IEV_ALLOW_PRIVATE_HOSTS === "1",
    },
  };
}

export async function handleAdminRequest({ method, headers = {}, query = {}, body = null, env = process.env } = {}) {
  const secret = env.ADMIN_SECRET || "";
  if (!secret) return jsonError(503, { error: "admin_disabled" });
  if (String(headers.authorization ?? "") !== `Bearer ${secret}`) return jsonError(401, { error: "unauthorized" });

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
      if (record.status === "corrected" && record.checkId) {
        applied = await appendCorrectionToLog(record.checkId, {
          protocol: record.protocol,
          note: body?.note ?? record.claim ?? "",
          actor: body?.actor,
          status: record.status,
        });
        await invalidateCache(`correção ${record.protocol}`);
      }
      return { status: 200, body: { correction: adminCorrection(record), applied, cacheInvalidated: Boolean(record.status === "corrected" && record.checkId) } };
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
  if (!logEnabled()) {
    return { status: 200, body: { enabled: false, items: [], hint: "BLOB_READ_WRITE_TOKEN ausente — logs só no console." } };
  }
  const id = typeof query.id === "string" ? query.id : "";
  if (id) {
    const record = await getCheckLog(id);
    if (!record) return jsonError(404, { error: "not_found" });
    return { status: 200, body: { record } };
  }
  return { status: 200, body: await listCheckLogs() };
}
