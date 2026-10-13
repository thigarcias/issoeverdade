// Plugin Vite (dev): serve POST /api/verify com a chave OpenCode server-side.
// Reusa server/verify.js — a mesma lógica da serverless Vercel (api/verify.js).
import { loadEnv } from "vite";
import { runVerify } from "./server/verify.js";

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
    },
  };
}
