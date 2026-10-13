// Serverless Vercel: POST /api/corrections (cria protocolo) e GET ?protocol=
// (consulta pública). A fila administrativa fica em /api/admin.
import { handleCorrectionsRequest } from "../server/corrections-endpoint.js";

export const config = { maxDuration: 30 };

const MAX_BODY_BYTES = 32_000;

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
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
  const out = await handleCorrectionsRequest({
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    body,
    socketAddress: req.socket?.remoteAddress,
  });
  for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
  return res.status(out.status).json(out.body);
}
