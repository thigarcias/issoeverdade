// Admin: registros de checagem, catálogo/configuração de IA, fila de correções,
// métricas e invalidação de cache. Protegido por ADMIN_SECRET via Bearer.
// Sem secret configurado, responde 503 (admin desabilitado) — nunca expõe sem
// autenticação. Toda a lógica vive em server/admin-endpoint.js.
import { handleAdminRequest } from "../server/admin-endpoint.js";

export const config = { maxDuration: 30 };

const MAX_BODY_BYTES = 200_000;

export default async function handler(req, res) {
  const rawLen = Number(req.headers["content-length"] ?? 0);
  if (rawLen > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }
  let body = req.body ?? null;
  if (typeof body === "string") {
    if (body.length > MAX_BODY_BYTES) return res.status(413).json({ error: "payload_too_large" });
    try {
      body = body ? JSON.parse(body) : null;
    } catch {
      return res.status(400).json({ error: "bad_request" });
    }
  }
  const out = await handleAdminRequest({
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    body,
    socketAddress: req.socket?.remoteAddress,
  });
  for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
  return res.status(out.status).json(out.body);
}
