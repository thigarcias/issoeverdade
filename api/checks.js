// Publicação explícita e leitura de resultados compartilhados; sem acesso público aos logs.
import { handleChecksRequest } from "../server/checks-endpoint.js";

export const config = { maxDuration: 30 };
const MAX_BODY_BYTES = 4096;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }
  let body = req.body ?? null;
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return res.status(413).json({ error: "payload_too_large" });
    try { body = body ? JSON.parse(body) : null; }
    catch { return res.status(400).json({ error: "bad_request" }); }
  }
  const out = await handleChecksRequest({
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    body,
    socketAddress: req.socket?.remoteAddress,
  });
  for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
  return res.status(out.status).json(out.body);
}
