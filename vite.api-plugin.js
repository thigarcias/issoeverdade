// Plugin Vite (dev): serve /api/verify, /api/corrections e /api/admin com as
// chaves server-side — mesmos handlers da Vercel.
// /api/verify admite (JSON + status em caso de recusa) e transmite NDJSON.
import { loadEnv } from "vite";
import { admitVerifyRequest, executeVerifyStream, handleVerifyRecovery, VERIFY_CONTRACT, VERIFY_NDJSON_TYPE } from "./server/endpoint.js";
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
        const sendJson = (status, obj, headers = {}) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET") {
          const query = Object.fromEntries(new URL(req.url, "http://local").searchParams.entries());
          const out = await handleVerifyRecovery({ method: req.method, headers: req.headers, query, socketAddress: req.socket?.remoteAddress });
          return sendJson(out.status, out.body, out.headers);
        }
        if (req.method !== "POST") return sendJson(405, { error: "method_not_allowed" });
        let body;
        try {
          body = JSON.parse(await readBody(req, 4_300_000));
        } catch (error) {
          return sendJson(error?.message === "payload too large" ? 413 : 400, { error: error?.message === "payload too large" ? "payload_too_large" : "bad_request" });
        }
        let admitted;
        try {
          admitted = await admitVerifyRequest({
            method: req.method,
            headers: req.headers,
            body,
            socketAddress: req.socket?.remoteAddress,
          });
        } catch (err) {
          return sendJson(err.status ?? 502, err.payload ?? { error: err.message ?? "upstream_error" });
        }
        if (admitted.status) return sendJson(admitted.status, admitted.body, admitted.headers);
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
