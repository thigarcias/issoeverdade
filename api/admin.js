// Admin: lista checagens (índice) ou detalhe (?id=).
// Protegido por ADMIN_SECRET via Authorization: Bearer. Sem secret configurado,
// responde 503 (admin desabilitado) — nunca expõe sem autenticação.
import { getCheckLog, listCheckLogs, logEnabled } from "../server/checklog.js";

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
