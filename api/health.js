// Saúde e limites públicos (sem segredos). Serve também de smoke de implantação.
import { handleHealthRequest } from "../server/health-endpoint.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const out = handleHealthRequest({});
  res.setHeader("Cache-Control", "no-store");
  return res.status(out.status).json(out.body);
}
