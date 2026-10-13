// Plugin Vite (dev): serve /api/verify e /api/admin com as chaves server-side.
// Reusa server/verify.js + server/checklog.js — mesma lógica da Vercel.
import { loadEnv } from "vite";
import { runVerify } from "./server/verify.js";
import { getCheckLog, listCheckLogs, logEnabled } from "./server/checklog.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 200_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function apiVerifyPlugin() {
  let apiKey = process.env.OPENCODE_API || "";
  return {
    name: "iev-api-verify",
    apply: "serve",
    configResolved(config) {
      const full = loadEnv(config.mode, config.root || process.cwd(), "");
      apiKey = apiKey || full.OPENCODE_API || "";
      if (full.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = full.OPENAI_API_KEY;
      }
      if (full.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_READ_WRITE_TOKEN) {
        process.env.BLOB_READ_WRITE_TOKEN = full.BLOB_READ_WRITE_TOKEN;
      }
      if (full.ADMIN_SECRET && !process.env.ADMIN_SECRET) {
        process.env.ADMIN_SECRET = full.ADMIN_SECRET;
      }
    },
    configureServer(server) {
      server.middlewares.use("/api/verify", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const send = (status, obj) => {
          res.statusCode = status;
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return send(405, { error: "method_not_allowed" });
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch {
          return send(400, { error: "bad_request" });
        }
        const text = String(input?.text ?? "");
        const fileName = input?.fileName ? String(input.fileName) : null;
        if (!text && !fileName) return send(400, { error: "empty_input" });
        try {
          const out = await runVerify({ kind: input.kind, text, fileName }, { apiKey });
          return send(200, out);
        } catch (err) {
          return send(err.status ?? 502, err.payload ?? { error: "upstream_error" });
        }
      });
      server.middlewares.use("/api/admin", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const send = (status, obj) => {
          res.statusCode = status;
          res.end(JSON.stringify(obj));
        };
        const secret = process.env.ADMIN_SECRET || "";
        if (!secret) return send(503, { error: "admin_disabled" });
        if (String(req.headers.authorization ?? "") !== `Bearer ${secret}`) {
          return send(401, { error: "unauthorized" });
        }
        if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
        if (!logEnabled()) {
          return send(200, { enabled: false, items: [], hint: "BLOB_READ_WRITE_TOKEN ausente — logs só no console." });
        }
        const id = new URL(req.url, "http://local").searchParams.get("id") || "";
        if (id) {
          const record = await getCheckLog(id);
          if (!record) return send(404, { error: "not_found" });
          return send(200, { record });
        }
        return send(200, await listCheckLogs());
      });
    },
  };
}
