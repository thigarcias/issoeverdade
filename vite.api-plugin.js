// Plugin Vite (dev): serve /api/verify e /api/admin com as chaves server-side.
// Reusa server/verify.js + server/checklog.js — mesma lógica da Vercel.
import { loadEnv } from "vite";
import { runVerify } from "./server/verify.js";
import { getCheckLog, listCheckLogs, logEnabled } from "./server/checklog.js";
import { aiConfigCatalog, getAiConfigState, saveAiConfig } from "./server/ai-config.js";
import { normalizeVerifyInput } from "./server/uploads.js";
import { PROMPT_VERSION, VERDICT_BANDS } from "./server/scoring.js";

const METHODOLOGY = {
  version: PROMPT_VERSION,
  bands: VERDICT_BANDS,
  statuses: [
    { id: "checked", label: "Checagem executada" },
    { id: "partial_coverage", label: "Cobertura parcial" },
    { id: "insufficient_input", label: "Material insuficiente" },
    { id: "inaccessible_media", label: "Mídia inacessível" },
    { id: "no_verifiable_claims", label: "Sem afirmação verificável" },
    { id: "error", label: "Erro operacional" },
    { id: "legacy", label: "Registro legado" },
  ],
  evaluation: {
    harness: "scripts/evaluate-factual.mjs",
    corpus: null,
    benchmarkPublished: false,
    note: "Nenhum corpus humano anotado foi entregue; nenhuma taxa de precisão é publicada.",
  },
};


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
        let body;
        try {
          body = JSON.parse(await readBody(req, 4_300_000));
        } catch (error) {
          return send(error?.message === "payload too large" ? 413 : 400, { error: error?.message === "payload too large" ? "payload_too_large" : "bad_request" });
        }
        let input;
        try {
          input = normalizeVerifyInput(body);
        } catch (error) {
          return send(error.status ?? 400, { error: error.message ?? "invalid_input" });
        }
        if (!input.text && !input.fileName && !input.fileBuffer) return send(400, { error: "empty_input" });
        try {
          const out = await runVerify(input);
          return send(200, out);
        } catch (err) {
          return send(err.status ?? 502, err.payload ?? { error: err.message ?? "upstream_error" });
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
            const catalog = await aiConfigCatalog({ refresh: params.get("refresh") === "1" });
            const state = await getAiConfigState();
            return send(200, {
              catalog,
              config: state.config,
              configErrors: state.configErrors,
              source: state.source,
              revision: state.revision,
              updatedAt: state.updatedAt,
              persisted: state.persisted,
              methodology: METHODOLOGY,
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
            } catch (error) {
              if (error?.status === 400) return send(400, { error: "invalid_ai_config", fields: error.fields });
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
