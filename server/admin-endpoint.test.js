// Regressões do painel administrativo e do endpoint de saúde: autenticação,
// métricas, fila de correções, invalidação de cache e limites públicos.
const SECRET = "00000000-0000-4000-8000-000000000000";
process.env.ADMIN_SECRET = SECRET;
process.env.IEV_LIMITS_MODE = "memory";
const { handleAdminRequest, systemState, MIN_SECRET_CHARS, AUTH_FAILURE_LIMIT } = await import("./admin-endpoint.js");
const { handleHealthRequest } = await import("./health-endpoint.js");
const { createCorrection, normalizeCorrection } = await import("./corrections.js");
const { recordCheck, resetMetrics } = await import("./metrics.js");

import { test } from "node:test";
import assert from "node:assert/strict";

const auth = { authorization: `Bearer ${SECRET}` };

test("admin exige segredo configurado e Bearer correto", async () => {
  const semSecret = await handleAdminRequest({ method: "GET", headers: {}, query: {}, env: {} });
  assert.equal(semSecret.status, 503);
  assert.equal(semSecret.body.error, "admin_disabled");
  const semAuth = await handleAdminRequest({ method: "GET", headers: {}, query: {} });
  assert.equal(semAuth.status, 401);
  const errado = await handleAdminRequest({ method: "GET", headers: { authorization: "Bearer outro" }, query: {} });
  assert.equal(errado.status, 401);
  // Comparação por hash antes do timingSafeEqual: tamanhos diferentes não estouram.
  const mesmoTamanho = await handleAdminRequest({ method: "GET", headers: { authorization: `Bearer ${"0".repeat(SECRET.length)}` }, query: {} });
  assert.equal(mesmoTamanho.status, 401);
});

test("segredo abaixo do mínimo é recusado (fail-closed) em vez de aceito", async () => {
  const fraco = "segredo-forte-do-painel";
  const curto = await handleAdminRequest({ method: "GET", headers: { authorization: `Bearer ${fraco}` }, query: {}, env: { ADMIN_SECRET: fraco } });
  assert.equal(curto.status, 503);
  assert.equal(curto.body.error, "admin_secret_too_weak");
  assert.equal(curto.body.minLength, MIN_SECRET_CHARS);
  const naLinha = "a".repeat(MIN_SECRET_CHARS);
  const aceito = await handleAdminRequest({ method: "GET", headers: { authorization: `Bearer ${naLinha}` }, query: { metrics: "1" }, env: { ADMIN_SECRET: naLinha } });
  assert.equal(aceito.status, 200);
});

test("falhas de chave são limitadas por origem e não bloqueiam a chave correta", async () => {
  const origem = { "x-forwarded-for": "203.0.113.9" };
  const errada = { authorization: "Bearer chave-errada", ...origem };
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
    assert.equal((await handleAdminRequest({ method: "GET", headers: errada, query: {} })).status, 401);
  }
  const bloqueada = await handleAdminRequest({ method: "GET", headers: errada, query: {} });
  assert.equal(bloqueada.status, 429);
  assert.equal(bloqueada.body.error, "too_many_attempts");
  assert.ok(Number(bloqueada.headers["Retry-After"]) > 0);
  // Outra origem continua apenas recusada: a trava é por IP, não global.
  const outraOrigem = await handleAdminRequest({ method: "GET", headers: { authorization: "Bearer chave-errada", "x-forwarded-for": "198.51.100.7" }, query: {} });
  assert.equal(outraOrigem.status, 401);
  // A chave correta nunca entra na contagem: queimar tentativas não derruba o painel.
  assert.equal((await handleAdminRequest({ method: "GET", headers: { ...auth, ...origem }, query: { metrics: "1" } })).status, 200);
});

test("sem backend compartilhado a trava vale por instância", async () => {
  const env = { ADMIN_SECRET: SECRET, IEV_LIMITS_MODE: "blocked", VERCEL_ENV: "production" };
  const errada = { authorization: "Bearer chave-errada", "x-forwarded-for": "198.51.100.55" };
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
    assert.equal((await handleAdminRequest({ method: "GET", headers: errada, query: {}, env })).status, 401);
  }
  assert.equal((await handleAdminRequest({ method: "GET", headers: errada, query: {}, env })).status, 429);
  assert.equal((await handleAdminRequest({ method: "GET", headers: { ...errada, ...auth }, query: { metrics: "1" }, env })).status, 200);
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

test("admin vê reportes operacionais e resolvê-los não marca correção editorial nem invalida cache", async () => {
  for (const kind of ["technical", "transcription", "download", "slow", "result", "card", "other"]) {
    const created = await createCorrection(normalizeCorrection({
      kind,
      checkId: `operational-${kind}`,
      message: "Ao baixar o card, aparece um erro e o arquivo não é salvo.",
      context: "Safari no celular, botão Baixar PNG.",
      contact: "relator@example.org",
      source: "detail",
    }).value);
    const list = await handleAdminRequest({ method: "GET", headers: auth, query: { corrections: "1" } });
    assert.equal(list.status, 200);
    assert.ok(list.body.kinds.some((entry) => entry.id === kind));
    assert.equal(list.body.items.find((item) => item.protocol === created.protocol).kind, kind);
    const detail = await handleAdminRequest({ method: "GET", headers: auth, query: { correction: created.protocol } });
    assert.equal(detail.body.correction.context, "Safari no celular, botão Baixar PNG.");
    assert.equal(detail.body.correction.contact, "relator@example.org");
    assert.equal(detail.body.correction.operational, true);
    const updated = await handleAdminRequest({
      method: "POST",
      headers: auth,
      query: { corrections: "1" },
      body: { protocol: created.protocol, status: "corrected", note: "Problema operacional resolvido." },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.correction.status, "corrected");
    assert.equal(updated.body.cacheInvalidated, false);
    assert.equal(updated.body.applied, null);
    assert.equal(updated.body.correction.history.at(-1).note, "Problema operacional resolvido.");
  }
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
