// Identidade de origem usada pelas travas de taxa (verify, checks, correções e
// admin). Fica isolada de endpoint.js para que os endpoints administrativos não
// carreguem o pipeline de verificação só para resolver o IP.

/** IP do cliente conforme o proxy confiável da hospedagem. */
export function clientIp(headers, socketAddress, env = process.env) {
  const trustProxy = env.IEV_TRUST_PROXY !== "0";
  if (trustProxy) {
    const header = String(env.IEV_TRUST_PROXY_HEADER || "x-forwarded-for").toLowerCase();
    const raw = headers?.[header] ?? headers?.["x-real-ip"] ?? "";
    const value = String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
    if (value) return value.slice(0, 64);
  }
  return String(socketAddress ?? "").split(",")[0].trim().slice(0, 64) || "unknown";
}
