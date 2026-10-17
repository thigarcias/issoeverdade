import { handleAudienceRequest } from "../server/audience.js";
export const config = { maxDuration: 15 };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (Number(req.headers["content-length"] ?? 0) > 2048) return res.status(413).json({ error: "payload_too_large" });
  let body = req.body ?? null;
  try {
    if (typeof body === "string") {
      if (Buffer.byteLength(body) > 2048) return res.status(413).json({ error: "payload_too_large" });
      body = JSON.parse(body);
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 2048) return res.status(413).json({ error: "payload_too_large" });
  } catch { return res.status(400).json({ error: "bad_request" }); }
  const out = await handleAudienceRequest({ method: req.method, headers: req.headers, body, socketAddress: req.socket?.remoteAddress });
  for (const [key, value] of Object.entries(out.headers)) res.setHeader(key, value);
  return out.status === 204 ? res.status(204).end() : res.status(out.status).json(out.body);
}
