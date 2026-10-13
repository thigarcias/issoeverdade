// Plugin Vite (dev): serve /api/verify, /api/corrections e /api/admin com as
// chaves server-side — mesmos handlers da Vercel.
import { loadEnv } from "vite";
import { handleVerifyRequest } from "./server/endpoint.js";
import { handleCorrectionsRequest } from "./server/corrections-endpoint.js";
import { handleAdminRequest } from "./server/admin-endpoint.js";
import { handleHealthRequest } from "./server/health-endpoint.js";

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        failed = true;
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!failed) resolve(data);
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

export function apiVerifyPlugin() {
  return {
    name: "iev-api-verify",
    apply: "serve",
    configResolved(config) {
      const full = loadEnv(config.mode, config.root || process.cwd(), "");
      const allowed = /^(OPENCODE_|OPENAI_|BLOB_|ADMIN_SECRET|MEDIA_|IEV_|MODERATION_|UPSTASH_|KV_REST_API_|VERCEL_ENV|NODE_ENV)/;
      for (const [key, value] of Object.entries(full)) {
        if (value && allowed.test(key) && !process.env[key]) process.env[key] = value;
      }
    },
    configureServer(server) {
      server.middlewares.use("/api/verify", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const send = (status, obj, headers = {}) => {
          res.statusCode = status;
          for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return send(405, { error: "method_not_allowed" });
        let body;
        try {
          body = JSON.parse(await readBody(req, 4_300_000));
        } catch (error) {
          return send(error?.message === "payload too large" ? 413 : 400, { error: error?.message === "payload too large" ? "payload_too_large" : "bad_request" });
        }
        try {
          const out = await handleVerifyRequest({
            method: req.method,
            headers: req.headers,
            body,
            socketAddress: req.socket?.remoteAddress,
          });
          return send(out.status, out.body, out.headers);
        } catch (err) {
          return send(err.status ?? 502, err.payload ?? { error: err.message ?? "upstream_error" });
        }
      });
      server.middlewares.use("/api/health", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const out = handleHealthRequest({});
        res.statusCode = out.status;
        res.end(JSON.stringify(out.body));
      });
      server.middlewares.use("/api/corrections", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const send = (status, obj, headers = {}) => {
          res.statusCode = status;
          for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
          res.end(JSON.stringify(obj));
        };
        let body = null;
        if (req.method === "POST") {
          try {
            body = JSON.parse(await readBody(req, 32_000));
          } catch (error) {
            return send(error?.message === "payload too large" ? 413 : 400, { error: error?.message === "payload too large" ? "payload_too_large" : "bad_request" });
          }
        }
        const params = new URL(req.url, "http://local").searchParams;
        const out = await handleCorrectionsRequest({
          method: req.method,
          headers: req.headers,
          query: Object.fromEntries(params.entries()),
          body,
          socketAddress: req.socket?.remoteAddress,
        });
        return send(out.status, out.body, out.headers);
      });
      server.middlewares.use("/api/admin", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const send = (status, obj) => {
          res.statusCode = status;
          res.end(JSON.stringify(obj));
        };
        let body = null;
        if (req.method === "POST") {
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return send(400, { error: "bad_request" });
          }
        }
        const params = new URL(req.url, "http://local").searchParams;
        const out = await handleAdminRequest({
          method: req.method,
          headers: req.headers,
          query: Object.fromEntries(params.entries()),
          body,
        });
        return send(out.status, out.body);
      });
    },
  };
}
