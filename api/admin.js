// Admin: IA usada pelo site (?config=1) + checagens (índice ou ?id=).
// Protegido por ADMIN_SECRET via Authorization: Bearer. Sem secret configurado,
// responde 503 (admin desabilitado) — nunca expõe sem autenticação.
// GET ?config=1 → { catalog, config, persisted } (sem chaves, só disponibilidade).
// POST ?config=1 { config } → valida contra o catálogo e salva no Blob.
import { getCheckLog, listCheckLogs, logEnabled } from "../server/checklog.js";
import { aiConfigCatalog, getAiConfigState, saveAiConfig } from "../server/ai-config.js";
import { PROMPT_VERSION, VERDICT_BANDS } from "../server/scoring.js";

const METHODOLOGY = {
  version: PROMPT_VERSION,
  bands: VERDICT_BANDS,
  statuses: [
    { id: "checked", label: "Checagem executada" },
    { id: "partial_coverage", label: "Cobertura parcial" },
    { id: "insufficient_input", label: "Material insuficiente" },
    { id: "inaccessible_media", label: "Mídia inacessível" },
    { id: "no_verifiable_claims", label: "Sem afirmação verificável" },
    { id: "error", label: "Erro operacional" },
    { id: "legacy", label: "Registro legado" },
  ],
  evaluation: {
    harness: "scripts/evaluate-factual.mjs",
    corpus: null,
    benchmarkPublished: false,
    note: "Nenhum corpus humano anotado foi entregue; nenhuma taxa de precisão é publicada.",
  },
};

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const secret = process.env.ADMIN_SECRET || "";
  if (!secret) {
    return res.status(503).json({ error: "admin_disabled" });
  }
  const auth = String(req.headers.authorization ?? "");
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.query.config !== undefined && req.query.config !== "0") {
    if (req.method === "GET") {
      const refresh = req.query.refresh === "1";
      const catalog = await aiConfigCatalog({ refresh });
      const state = await getAiConfigState();
      return res.status(200).json({
        catalog,
        config: state.config,
        configErrors: state.configErrors,
        source: state.source,
        revision: state.revision,
        updatedAt: state.updatedAt,
        persisted: state.persisted,
        methodology: METHODOLOGY,
      });
    }
    if (req.method === "POST") {
      let body = null;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
      } catch {
        return res.status(400).json({ error: "bad_config" });
      }
      if (!body || typeof body.config !== "object") {
        return res.status(400).json({ error: "bad_config" });
      }
      try {
        return res.status(200).json(await saveAiConfig(body.config));
      } catch (error) {
        if (error?.status === 400) return res.status(400).json({ error: "invalid_ai_config", fields: error.fields });
        return res.status(502).json({ error: "config_save_failed" });
      }
    }
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!logEnabled()) {
    return res.status(200).json({ enabled: false, items: [], hint: "BLOB_READ_WRITE_TOKEN ausente — logs só no console." });
  }
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (id) {
    const record = await getCheckLog(id);
    if (!record) return res.status(404).json({ error: "not_found" });
    return res.status(200).json({ record });
  }
  return res.status(200).json(await listCheckLogs());
}
