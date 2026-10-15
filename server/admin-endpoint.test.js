// Regressões do painel administrativo e do endpoint de saúde: autenticação,
// métricas, fila de correções, invalidação de cache e limites públicos.
const SECRET = "00000000-0000-4000-8000-000000000000";
process.env.ADMIN_SECRET = SECRET;
process.env.IEV_LIMITS_MODE = "memory";
// Isolamento: as expectativas de "log_disabled" valem sem storage configurado,
// independentemente do ambiente que executa a suíte.
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
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

test("dez falhas bloqueiam qualquer credencial apenas na origem afetada", async () => {
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
  assert.equal((await handleAdminRequest({ method: "GET", headers: { ...auth, ...origem }, query: { metrics: "1" } })).status, 429);
  assert.equal((await handleAdminRequest({ method: "GET", headers: { ...auth, "x-forwarded-for": "198.51.100.7" }, query: { metrics: "1" } })).status, 200);
});

test("sem backend compartilhado a trava vale por instância", async () => {
  const env = { ADMIN_SECRET: SECRET, IEV_LIMITS_MODE: "blocked", VERCEL_ENV: "production" };
  const errada = { authorization: "Bearer chave-errada", "x-forwarded-for": "198.51.100.55" };
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
    assert.equal((await handleAdminRequest({ method: "GET", headers: errada, query: {}, env })).status, 401);
  }
  assert.equal((await handleAdminRequest({ method: "GET", headers: errada, query: {}, env })).status, 429);
  assert.equal((await handleAdminRequest({ method: "GET", headers: { ...errada, ...auth }, query: { metrics: "1" }, env })).status, 429);
});

test("credenciais válidas não gastam tentativas e o bloqueio expira sem renovação", async (t) => {
  const inicio = Date.now();
  t.mock.method(Date, "now", () => inicio);
  const origem = { "x-forwarded-for": "203.0.113.42" };
  const request = (authorization) => handleAdminRequest({ method: "GET", headers: { ...origem, authorization }, query: { metrics: "1" } });
  for (let i = 0; i < AUTH_FAILURE_LIMIT + 1; i++) {
    assert.equal((await request(auth.authorization)).status, 200);
  }
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
    assert.equal((await request("Bearer errada")).status, 401);
  }
  t.mock.method(Date, "now", () => inicio + 899_000);
  const bloqueada = await request(auth.authorization);
  assert.equal(bloqueada.status, 429);
  assert.equal(bloqueada.headers["Retry-After"], "1");
  t.mock.method(Date, "now", () => inicio + 900_000);
  assert.equal((await request(auth.authorization)).status, 200);
  assert.equal((await request("Bearer errada")).status, 401);
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

test("admin entrega estados de IA inválida/indisponível com catálogo e aceita correção explícita", async () => {
  const ai = await import("./ai-config.js");
  const previousFetch = globalThis.fetch;
  const keys = ["OPENCODE_API", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN"];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const config = {
    judge: { provider: "opencode", model: "muse-spark-1.3-contributor" },
    vision: { provider: "opencode", model: "muse-spark-1.3-contributor" },
    transcribe: { provider: "openai", model: "whisper-1" },
  };
  const getConfig = () => handleAdminRequest({ method: "GET", headers: auth, query: { config: "1" } });
  ai.__resetAiConfigCaches();
  try {
    process.env.OPENCODE_API = "test-opencode";
    process.env.OPENAI_API_KEY = "test-openai";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = async (url) => new Response(JSON.stringify({
      data: (String(url).includes("opencode.ai") ? ["muse-spark-1.3-contributor"] : ["whisper-1"]).map((id) => ({ id })),
    }), { status: 200 });
    ai.__setAiConfigLoader(async () => ({ config: { ...config, judge: { provider: "openai", model: "whisper-1" } } }));
    const invalid = await getConfig();
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.error, "ai_config_invalid");
    assert.equal(invalid.body.config, null);
    assert.equal(invalid.body.configErrors.judge, ai.REASON_MESSAGES.other_step);
    assert.ok(invalid.body.catalog.providers.opencode.models.length > 0, "catálogo permanece disponível para correção explícita");

    const corrected = await handleAdminRequest({ method: "POST", headers: auth, query: { config: "1" }, body: { config } });
    assert.equal(corrected.status, 200);
    assert.deepEqual(corrected.body.saved, config);
    const afterSave = await getConfig();
    assert.deepEqual(afterSave.body.config, config);
    assert.equal(afterSave.body.error, null);
    assert.equal(afterSave.body.configErrors, null);
    assert.equal(afterSave.body.stale, false);
    assert.equal(afterSave.body.staleReason, null);

    ai.__resetAiConfigCaches();
    ai.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const unavailable = await getConfig();
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.error, "ai_config_unavailable");
    assert.equal(unavailable.body.config, null);
    assert.equal(unavailable.body.staleReason, "config_read_failed");
    assert.ok(unavailable.body.catalog.providers.opencode.models.length > 0);
  } finally {
    ai.__setAiConfigLoader(null);
    ai.__resetAiConfigCaches();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("admin informa motivo de snapshot stale e não o reutiliza após remoção de credencial", async () => {
  const ai = await import("./ai-config.js");
  const previousFetch = globalThis.fetch;
  const keys = ["OPENCODE_API", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN"];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const config = {
    judge: { provider: "opencode", model: "muse-spark-1.3-contributor" },
    vision: { provider: "opencode", model: "muse-spark-1.3-contributor" },
    transcribe: { provider: "openai", model: "whisper-1" },
  };
  const getConfig = (refresh = false) => handleAdminRequest({ method: "GET", headers: auth, query: { config: "1", ...(refresh ? { refresh: "1" } : {}) } });
  ai.__resetAiConfigCaches();
  try {
    process.env.OPENCODE_API = "test-opencode";
    process.env.OPENAI_API_KEY = "test-openai";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = async (url) => new Response(JSON.stringify({
      data: (String(url).includes("opencode.ai") ? ["muse-spark-1.3-contributor"] : ["whisper-1"]).map((id) => ({ id })),
    }), { status: 200 });
    ai.__setAiConfigLoader(async () => ({ config, updatedAt: "2026-10-01T00:00:00.000Z" }));
    const first = await getConfig();
    ai.__expireAiConfigMemory();
    ai.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const stale = await getConfig();
    assert.equal(stale.body.error, null);
    assert.equal(stale.body.staleReason, "config_read_failed");
    assert.equal(stale.body.revision, first.body.revision);
    assert.deepEqual(stale.body.config, config);
    delete process.env.OPENCODE_API;
    const invalid = await getConfig();
    assert.equal(invalid.body.error, "ai_config_invalid");
    assert.equal(invalid.body.config, null);
    assert.equal(invalid.body.configErrors.judge, ai.REASON_MESSAGES.missing_credential);
    assert.equal(invalid.body.revision, first.body.revision);
    assert.equal(invalid.body.source, first.body.source);
    assert.equal(invalid.body.catalog.providers.opencode.hasKey, false);

    ai.__resetAiConfigCaches();
    process.env.OPENCODE_API = "test-opencode";
    ai.__setAiConfigLoader(async () => ({ config }));
    await getConfig();
    ai.__expireAiConfigMemory();
    ai.__resetAiConfigCatalogCache();
    globalThis.fetch = async () => { throw new Error("catalog down"); };
    const catalogStale = await getConfig(true);
    assert.equal(catalogStale.body.error, null);
    assert.equal(catalogStale.body.staleReason, "catalog_stale");
    assert.deepEqual(catalogStale.body.config, config);
  } finally {
    ai.__setAiConfigLoader(null);
    ai.__resetAiConfigCaches();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
