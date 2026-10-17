// Pré-visualização OG para crawlers e redirecionamento de /check/:id para o SPA.
import { handleOg } from "../server/og.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const out = await handleOg({
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    socketAddress: req.socket?.remoteAddress,
  });
  res.statusCode = out.status;
  for (const [key, value] of Object.entries(out.headers)) res.setHeader(key, value);
  return out.body ? res.end(out.body) : res.end();
}
