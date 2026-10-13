// Regressões do painel administrativo e do endpoint de saúde: autenticação,
// métricas, fila de correções, invalidação de cache e limites públicos.
process.env.ADMIN_SECRET = "segredo-de-teste";
process.env.IEV_LIMITS_MODE = "memory";
const { handleAdminRequest, systemState } = await import("./admin-endpoint.js");
const { handleHealthRequest } = await import("./health-endpoint.js");
const { createCorrection, normalizeCorrection } = await import("./corrections.js");
const { recordCheck, resetMetrics } = await import("./metrics.js");

import { test } from "node:test";
import assert from "node:assert/strict";

const auth = { authorization: "Bearer segredo-de-teste" };

test("admin exige segredo configurado e Bearer correto", async () => {
  const semSecret = await handleAdminRequest({ method: "GET", headers: {}, query: {}, env: {} });
  assert.equal(semSecret.status, 503);
  assert.equal(semSecret.body.error, "admin_disabled");
  const semAuth = await handleAdminRequest({ method: "GET", headers: {}, query: {} });
  assert.equal(semAuth.status, 401);
  const errado = await handleAdminRequest({ method: "GET", headers: { authorization: "Bearer outro" }, query: {} });
  assert.equal(errado.status, 401);
});

test("métricas somam desfechos e trazem estado do sistema", async () => {
  resetMetrics();
  recordCheck({ kind: "text", outcome: "checked", verdict: "true", totalMs: 1200, tokens: { input: 100, output: 50 } });
  recordCheck({ kind: "video", outcome: "content_refused", totalMs: 30, moderation: { refused: 1 } });
  recordCheck({ kind: "text", outcome: "error", error: "missing_api_key", totalMs: 5 });
  const out = await handleAdminRequest({ method: "GET", headers: auth, query: { metrics: "1" } });
  assert.equal(out.status, 200);
  assert.equal(out.body.metrics.checks, 3);
  assert.equal(out.body.metrics.byKind.text, 2);
  assert.equal(out.body.metrics.moderation.refused, 1);
  assert.equal(out.body.metrics.tokens.total, 150);
  assert.equal(out.body.metrics.latency.avg, Math.round((1200 + 30 + 5) / 3));
  assert.equal(out.body.system.limits.mode, "memory");
  assert.ok(Array.isArray(out.body.system.moderation.refuseCategories));
  assert.equal(out.body.system.corrections.mode, "memory");
  assert.equal(out.body.metrics.note.includes("sem persistência"), true);
});

test("fila de correções lista, atualiza e registra correção editorial", async () => {
  const created = await createCorrection(normalizeCorrection({ message: "Pedido de teste com tamanho suficiente para validação.", checkId: "abc-123" }).value);
  const lista = await handleAdminRequest({ method: "GET", headers: auth, query: { corrections: "1" } });
  assert.equal(lista.status, 200);
  assert.ok(lista.body.items.some((item) => item.protocol === created.protocol));
  assert.ok(lista.body.statuses.some((status) => status.id === "corrected"));

  const detalhe = await handleAdminRequest({ method: "GET", headers: auth, query: { correction: created.protocol } });
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.body.correction.checkId, "abc-123");

  const atualizado = await handleAdminRequest({
    method: "POST",
    headers: auth,
    query: { corrections: "1" },
    body: { protocol: created.protocol, status: "in_review", note: "triagem" },
  });
  assert.equal(atualizado.status, 200);
  assert.equal(atualizado.body.correction.status, "in_review");
  assert.equal(atualizado.body.cacheInvalidated, false);

  const corrigido = await handleAdminRequest({
    method: "POST",
    headers: auth,
    query: { corrections: "1" },
    body: { protocol: created.protocol, status: "corrected", note: "número corrigido" },
  });
  assert.equal(corrigido.status, 200);
  assert.equal(corrigido.body.cacheInvalidated, true);
  assert.equal(corrigido.body.applied.ok, false, "sem Blob, o registro de checagem não é atualizado — e isso é reportado");
  assert.equal(corrigido.body.applied.error, "log_disabled");

  const inexistente = await handleAdminRequest({ method: "POST", headers: auth, query: { corrections: "1" }, body: { protocol: "corr-nao-existe", status: "closed" } });
  assert.equal(inexistente.status, 404);
});

test("invalidação de cache troca a época e exige ação explícita", async () => {
  const semAcao = await handleAdminRequest({ method: "POST", headers: auth, query: { cache: "1" }, body: {} });
  assert.equal(semAcao.status, 400);
  const out = await handleAdminRequest({ method: "POST", headers: auth, query: { cache: "1" }, body: { action: "invalidate", reason: "teste" } });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.persisted, false);
  assert.ok(out.body.epoch.length > 4);
});

test("saúde publica limites e modos sem segredos", () => {
  const out = handleHealthRequest({ env: { IEV_MAX_UPLOAD_BYTES: "1048576", IEV_MAX_TEXT_CHARS: "500" } });
  assert.equal(out.status, 200);
  assert.equal(out.body.limits.maxUploadBytes, 1048576);
  assert.equal(out.body.limits.maxTextChars, 500);
  assert.equal(out.body.controls.limitsMode, "memory");
  const serialized = JSON.stringify(out.body);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|ADMIN_SECRET|BLOB_READ_WRITE_TOKEN|UPSTASH/);
});

test("estado do sistema não inclui valores de ambiente sensíveis", () => {
  const state = systemState({ ADMIN_SECRET: "x", OPENAI_API_KEY: "y", IEV_LIMITS_MODE: "memory" });
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /"x"|"y"/);
  assert.equal(state.limits.mode, "memory");
});
