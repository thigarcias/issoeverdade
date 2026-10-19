import { activeGuard, blockedPayload, LimitsExceeded, LimitsUnavailable } from "./limits.js";
import { clientIp } from "./client-ip.js";
import { getPublishedCheck, publishCheck, validCheckId, logEnabled, logMode } from "./checklog.js";
import { reportStorageError } from "./supabase.js";

// Capability publication and published reads only: never runs or charges AI.
export async function handleChecksRequest({ method, headers = {}, query = {}, body = null, socketAddress, guard = activeGuard(), env = process.env } = {}) {
  const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const reply = (status, body, extra = {}) => ({ status, body, headers: { ...responseHeaders, ...extra } });
  if (!["GET", "POST"].includes(method)) return reply(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
  try {
    const rate = await guard.rateLimit(clientIp(headers, socketAddress, env), { bucket: "checks", max: guard.config.correctionsPerWindow });
    if (!rate.allowed) return reply(429, { error: "rate_limited" }, { "Retry-After": String(rate.retryAfterSec ?? guard.config.windowSec) });
  } catch (error) {
    if (error instanceof LimitsUnavailable) return reply(503, blockedPayload(guard));
    if (error instanceof LimitsExceeded) return reply(429, { error: error.code });
    reportStorageError("rate-limit", "checks", error);
    return reply(503, { error: "checks_unavailable" });
  }
  const id = method === "GET" ? query.id : body?.checkId;
  if (!validCheckId(id)) return reply(400, { error: "invalid_check_id" });
  if (method === "POST" && (typeof body?.shareToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.shareToken))) {
    return reply(403, { error: "publication_denied" });
  }
  if (!logEnabled()) return method === "GET" ? reply(404, { error: "not_found" }) : reply(503, { error: "checks_unavailable" });
  try {
    if (method === "GET") {
      const envelope = await getPublishedCheck(id);
      return envelope ? reply(200, envelope) : reply(404, { error: "not_found" });
    }
    if (!await publishCheck(id, body.shareToken)) return reply(403, { error: "publication_denied" });
    return reply(200, { id, url: `/check/${encodeURIComponent(id)}` });
  } catch (error) {
    reportStorageError(method === "GET" ? "public-read" : "publish", logMode(), error);
    return reply(502, { error: "checks_storage_failed" });
  }
}
