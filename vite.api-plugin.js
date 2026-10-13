// Plugin Vite (dev): serve /api/verify e /api/admin com as chaves server-side.
// Reusa server/verify.js + server/checklog.js — mesma lógica da Vercel.
import { loadEnv } from "vite";
import { runVerify } from "./server/verify.js";
import { getCheckLog, listCheckLogs, logEnabled } from "./server/checklog.js";
import { aiConfigCatalog, getAiConfig, providerKey, saveAiConfig } from "./server/ai-config.js";

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
  return {
    name: "iev-api-verify",
    apply: "serve",
    configResolved(config) {
      const full = loadEnv(config.mode, config.root || process.cwd(), "");
      for (const k of ["OPENCODE_API", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN", "ADMIN_SECRET", "MEDIA_WORKER_URL", "MEDIA_WORKER_SECRET"]) {
        if (full[k] && !process.env[k]) process.env[k] = full[k];
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
          const out = await runVerify({ kind: input.kind, text, fileName });
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
        const params = new URL(req.url, "http://local").searchParams;
        if (params.has("config") && params.get("config") !== "0") {
          if (req.method === "GET") {
            const catalog = aiConfigCatalog();
            for (const id of Object.keys(catalog.providers)) {
              catalog.providers[id].hasKey = Boolean(providerKey(id));
            }
            return send(200, {
              catalog,
              config: await getAiConfig(),
              persisted: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
            });
          }
          if (req.method === "POST") {
            let body = null;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              return send(400, { error: "bad_config" });
            }
            if (!body || typeof body.config !== "object") return send(400, { error: "bad_config" });
            try {
              return send(200, await saveAiConfig(body.config));
            } catch {
              return send(502, { error: "config_save_failed" });
            }
          }
          return send(405, { error: "method_not_allowed" });
        }
        if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
        if (!logEnabled()) {
          return send(200, { enabled: false, items: [], hint: "BLOB_READ_WRITE_TOKEN ausente — logs só no console." });
        }
        const id = params.get("id") || "";
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
