// Admin: IA usada pelo site (?config=1) + checagens (índice ou ?id=).
// Protegido por ADMIN_SECRET via Authorization: Bearer. Sem secret configurado,
// responde 503 (admin desabilitado) — nunca expõe sem autenticação.
// GET ?config=1 → { catalog, config, persisted } (sem chaves, só disponibilidade).
// POST ?config=1 { config } → valida contra o catálogo e salva no Blob.
import { getCheckLog, listCheckLogs, logEnabled } from "../server/checklog.js";
import { aiConfigCatalog, getAiConfig, providerKey, saveAiConfig } from "../server/ai-config.js";

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
      const catalog = aiConfigCatalog();
      for (const id of Object.keys(catalog.providers)) {
        catalog.providers[id].hasKey = Boolean(providerKey(id));
      }
      const config = await getAiConfig();
      return res.status(200).json({
        catalog,
        config,
        persisted: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
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
        const out = await saveAiConfig(body.config);
        return res.status(200).json(out);
      } catch {
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
