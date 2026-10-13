// Serverless Vercel: POST /api/verify (mesma lógica do dev local).
// Env vars na Vercel: OPENAI_API_KEY (primário), OPENCODE_API (fallback).
import { runVerify } from "../server/verify.js";
import { normalizeVerifyInput } from "../server/uploads.js";


export const config = { maxDuration: 300 };

// Rate limit simples por IP (memória local — por instância).
// 20 checagens / 10 min por IP. Suficiente contra abuso casual;
// para produção em escala, migrar para Upstash Redis.
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 20;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_HITS) return true;
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) {
    const oldest = HITS.keys().next().value;
    HITS.delete(oldest);
  }
  return false;
}
const MAX_REQUEST_BYTES = 4_300_000;
const KINDS = new Set(["link", "text", "video", "image"]);

function isPrivateUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(h)) return true;
    if (/^(10|192\.168)\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    if (/\.internal$|\.local$|\.lan$/.test(h)) return true;
    return false;
  } catch {
    return false; // não é URL — validação de formato acontece depois
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "600");
    return res.status(429).json({ error: "rate_limited", message: "Muitas checagens em pouco tempo. Aguarde alguns minutos." });
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
  if (!KINDS.has(body?.kind)) {
    return res.status(400).json({ error: "bad_kind" });
  }
  let input;
  try {
    input = normalizeVerifyInput(body);
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message ?? "invalid_input" });
  }
  if (!input.text && !input.fileName && !input.fileBuffer) {
    return res.status(400).json({ error: "empty_input" });
  }
  if (input.text && /^https?:\/\//i.test(input.text.trim()) && isPrivateUrl(input.text)) {
    return res.status(400).json({ error: "private_url" });
  }
  try {
    const out = await runVerify(input);
    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status ?? 502).json(err.payload ?? { error: err.message ?? "upstream_error" });
  }
}
