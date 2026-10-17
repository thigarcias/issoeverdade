// PNG 1200×630 por checagem publicada, usado em og:image de /check/:id.
import { handleOgImage } from "../server/og-image.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const out = await handleOgImage({
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    socketAddress: req.socket?.remoteAddress,
  });
  res.statusCode = out.status;
  for (const [key, value] of Object.entries(out.headers)) res.setHeader(key, value);
  return out.body ? res.end(out.body) : res.end();
}
