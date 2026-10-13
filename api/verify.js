// Serverless Vercel: POST /api/verify (mesma lógica do dev local).
// Limites de taxa, vagas de concorrência, orçamento diário, política de URL e
// moderação ficam em server/endpoint.js — este arquivo é só o adaptador HTTP.
import { handleVerifyRequest, MAX_REQUEST_BYTES } from "../server/endpoint.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const rawLen = Number(req.headers["content-length"] ?? 0);
  if (rawLen > MAX_REQUEST_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }
  let body = req.body ?? {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "bad_request" });
    }
  }
  const out = await handleVerifyRequest({
    method: req.method,
    headers: req.headers,
    body,
    socketAddress: req.socket?.remoteAddress,
  });
  for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
  return res.status(out.status).json(out.body);
}
