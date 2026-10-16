import { test } from "node:test";
import assert from "node:assert/strict";
import { stateStoreMode, readState, writeState, listState } from "./state-store.js";
import { getAiConfigState, saveAiConfig, __resetAiConfigCaches, __expireAiConfigMemory } from "./ai-config.js";
import { createRecoveryStore, RecoveryUnavailable } from "./recovery.js";
import { getCached, setCached, invalidateCache } from "./cache.js";
import { createCorrection, updateCorrection, listCorrections, correctionsForCheck, publicCorrection } from "./corrections.js";
import { saveSuccessfulCheck, publishCheck, getPublishedCheck, readMetricsLogs } from "./checklog.js";

const config = {
  judge: { provider: "opencode", model: "gpt-6-luna" },
  vision: { provider: "opencode", model: "gpt-6-luna" },
  transcribe: { provider: "openai", model: "whisper-1" },
};

// Simula PostgREST pelo transporte real do app. Qualquer chamada ao Blob
// (mesmo com token presente) ou a um provedor pago faz o teste falhar.
async function withDatabase(fn) {
  const names = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BLOB_READ_WRITE_TOKEN", "OPENCODE_API", "OPENAI_API_KEY", "IEV_JUDGE"];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  const db = { rows: new Map(), checks: new Map(), requests: [], fail: false, pageCap: 200 };
  Object.assign(process.env, { SUPABASE_URL: "https://state.example", SUPABASE_SERVICE_ROLE_KEY: "service-test", BLOB_READ_WRITE_TOKEN: "blocked-blob", OPENCODE_API: "go-test", OPENAI_API_KEY: "openai-test" });
  delete process.env.IEV_JUDGE;
  __resetAiConfigCaches();
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    db.requests.push(url.href);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: url.hostname === "opencode.ai" ? "gpt-6-luna" : "whisper-1" }] });
    assert.equal(url.hostname, "state.example", `unexpected external request: ${url.hostname}`);
    assert.equal(options.headers.apikey, "service-test");
    assert.equal(options.headers.Authorization, "Bearer service-test");
    if (db.fail) return new Response("private failure", { status: 503 });
    if (url.pathname.endsWith("/rpc/iev_put_state")) {
      const body = JSON.parse(options.body);
      db.rows.set(`${body.p_namespace}:${body.p_key}`, { key: body.p_key, namespace: body.p_namespace, value: body.p_value, expires_at: body.p_expires_at });
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/iev_state")) {
      let rows = [...db.rows.values()].filter((row) => `eq.${row.namespace}` === url.searchParams.get("namespace"));
      const key = url.searchParams.get("key");
      if (key?.startsWith("eq.")) rows = rows.filter((row) => row.key === key.slice(3));
      if (key?.startsWith("gt.")) rows = rows.filter((row) => row.key > key.slice(3));
      rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      return Response.json(rows.slice(0, Math.min(Number(url.searchParams.get("limit")), db.pageCap)));
    }
    assert.ok(url.pathname.endsWith("/iev_checks"));
    if (options.method === "POST") {
      const row = JSON.parse(options.body);
      db.checks.set(row.id, row);
      return new Response(null, { status: 201 });
    }
    let rows = url.searchParams.has("or") ? [] : [...db.checks.values()];
    if (url.searchParams.has("id")) rows = rows.filter((row) => `eq.${row.id}` === url.searchParams.get("id"));
    if (url.searchParams.has("published_at")) rows = rows.filter((row) => row.published_at);
    if (options.method === "PATCH") rows.forEach((row) => Object.assign(row, JSON.parse(options.body)));
    return Response.json(rows);
  };
  try { await fn(db); }
  finally {
    __resetAiConfigCaches();
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("migração usa Supabase com Blob bloqueado: configuração, recuperação, cache, correções, logs e compartilhamento", async () => {
  await withDatabase(async (db) => {
    assert.equal(stateStoreMode(), "supabase");
    const initial = await getAiConfigState();
    assert.equal(initial.config, null, "não troca a escolha antiga por um padrão");
    assert.equal(initial.error, "ai_config_setup_required");
    const saved = await saveAiConfig(config);
    assert.equal(saved.persisted, true);
    assert.equal(saved.source, "supabase");
    __resetAiConfigCaches();
    assert.deepEqual((await getAiConfigState()).config, config, "nova instância lê a escolha persistida");

    const recovery = createRecoveryStore();
    const capability = await recovery.start("check-state");
    const envelope = { checkId: capability.checkId, result: { outcome: "checked", claims: [] } };
    await recovery.complete(capability, envelope);
    assert.deepEqual(await createRecoveryStore().read(capability.checkId, capability.recoveryToken), { status: "completed", envelope });
    assert.equal(await recovery.read(capability.checkId, "x".repeat(43)), null);
    const recoveryRow = [...db.rows.values()].find((row) => row.namespace === "recovery");
    assert.ok(recoveryRow.expires_at);
    assert.equal(JSON.stringify(recoveryRow).includes(capability.recoveryToken), false);

    await invalidateCache("migration-test");
    const input = { kind: "text", text: "example-state" };
    await setCached(input, envelope, "test-state", "policy");
    assert.ok((await getCached(input, "test-state", "policy")).cached);
    // Simule uma entrada gravada por outra instância, sem memória local.
    const { cacheKey } = await import("./cache.js");
    const other = { kind: "text", text: "other-instance-state" };
    const storedCache = [...db.rows.values()].find((row) => row.namespace === "cache" && row.key !== "epoch");
    await writeState("cache", cacheKey(other, "test-state"), storedCache.value, { expiresAt: Date.now() + 10000 });
    assert.equal((await getCached(other, "test-state", "policy")).checkId, capability.checkId);
    await invalidateCache("editorial-correction");
    assert.equal(await getCached(input, "test-state", "policy"), null);

    const correction = await createCorrection({ protocol: "corr-state", message: "Mensagem detalhada para revisão", checkId: capability.checkId, kind: "correction", contact: "private@example.test" });
    assert.equal(correction.persisted, true);
    await updateCorrection(correction.protocol, { status: "corrected", note: "nota privada" });
    assert.equal((await listCorrections()).items[0].status, "corrected");
    assert.ok((await correctionsForCheck(capability.checkId)).correctedAt);
    assert.equal(JSON.stringify(publicCorrection(correction)).includes("private@example.test"), false);

    const sharing = await saveSuccessfulCheck({ id: capability.checkId, kind: "text", outcome: "checked" }, envelope);
    assert.ok(sharing?.shareToken);
    assert.equal(await getPublishedCheck(capability.checkId), null);
    assert.equal(await publishCheck(capability.checkId, sharing.shareToken), true);
    assert.ok(await getPublishedCheck(capability.checkId));
    const metrics = await readMetricsLogs();
    assert.equal(metrics.mode, "supabase");
    assert.deepEqual(metrics.corrections, { created: 1, corrected: 1 });
    assert.ok(db.requests.length > 0);
  });
});

test("Supabase indisponível não usa Blob nem memória para confirmar persistência", async () => {
  await withDatabase(async (db) => {
    await saveAiConfig(config);
    db.fail = true;
    __expireAiConfigMemory();
    const known = await getAiConfigState();
    assert.deepEqual(known.config, config, "snapshot conhecido permanece válido sem mudar pares");
    __resetAiConfigCaches();
    assert.equal((await getAiConfigState()).error, "ai_config_unavailable");
    await assert.rejects(saveAiConfig(config));
    await assert.rejects(createRecoveryStore().start("unpersisted"), RecoveryUnavailable);
    await assert.rejects(createCorrection({ protocol: "corr-fail", message: "não confirmar persistência" }));
  });
});

test("estado expirado é invisível e paginação respeita limite menor imposto pelo PostgREST", async () => {
  await withDatabase(async (db) => {
    await writeState("recovery", "expired", { status: "completed" }, { expiresAt: Date.now() - 1 });
    assert.equal(await readState("recovery", "expired"), null);
    for (let i = 0; i < 5; i++) await writeState("corrections", `corr-${i}`, { protocol: `corr-${i}` });
    db.pageCap = 2;
    assert.equal((await listState("corrections")).length, 5);
  });
});
