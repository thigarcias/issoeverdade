// Serverless Vercel: POST /api/verify e GET de recuperação por capacidade.
// Limites de taxa, vagas de concorrência, orçamento diário, política de URL e
// moderação ficam em server/endpoint.js — este arquivo é só o adaptador HTTP.
// Admissão recusada = JSON + status; execução admitida = NDJSON incremental.
import { admitVerifyRequest, executeVerifyStream, handleVerifyRecovery, MAX_REQUEST_BYTES, VERIFY_CONTRACT, VERIFY_NDJSON_TYPE } from "../server/endpoint.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "GET") {
    const query = req.query ?? Object.fromEntries(new URL(req.url, "http://local").searchParams.entries());
    const out = await handleVerifyRecovery({ method: req.method, headers: req.headers, query, socketAddress: req.socket?.remoteAddress });
    for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
    return res.status(out.status).json(out.body);
  }
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
  const admitted = await admitVerifyRequest({
    method: req.method,
    headers: req.headers,
    body,
    socketAddress: req.socket?.remoteAddress,
  });
  if (admitted.status) {
    for (const [key, value] of Object.entries(admitted.headers ?? {})) res.setHeader(key, value);
    return res.status(admitted.status).json(admitted.body);
  }
  res.writeHead(200, {
    "Content-Type": VERIFY_NDJSON_TYPE,
    "Cache-Control": "no-store",
    "X-Verify-Contract": VERIFY_CONTRACT,
  });
  await executeVerifyStream({
    input: admitted.input,
    slot: admitted.slot,
    guard: admitted.guard,
    onEvent: (event) => {
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch { /* cliente desconectou; a vaga é liberada no finally */ }
    },
  });
  res.end();
}
