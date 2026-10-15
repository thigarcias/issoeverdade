import { test } from "node:test";
import assert from "node:assert/strict";
import { getCached, setCached } from "./cache.js";

async function withoutExternalStorage(fn) {
  const old = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try { await fn(); } finally {
    if (old === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = old;
  }
}

test("indisponibilidade documental ou revisão inconclusiva não congela abstenção no cache", async () => {
  await withoutExternalStorage(async () => {
    for (const verification of ["unavailable", "unclear", undefined]) {
      const input = { kind: "text", text: `Cache limitação ${verification}` };
      const namespace = "cache-limitation-regression";
      await setCached(input, { checkId: "old", result: { claims: [{ status: "true" }] } }, namespace);
      assert.equal((await getCached(input, namespace)).checkId, "old");
      await setCached(input, { result: { claims: [{ status: "unproven", evidenceReview: { verification } }] } }, namespace);
      assert.equal(await getCached(input, namespace), null);
    }
  });
});

test("conclusão documental e insuficiência semântica revisada continuam reutilizáveis", async () => {
  await withoutExternalStorage(async () => {
    for (const status of ["true", "false", "unproven"]) {
      const input = { kind: "text", text: `Cache conclusão ${status}` };
      const value = { checkId: status, result: { claims: [{ status, evidenceReview: { verification: "verified", verdict: status === "unproven" ? "context" : "supports" } }] } };
      await setCached(input, value, "cache-conclusion-regression");
      const restored = await getCached(input, "cache-conclusion-regression");
      assert.equal(restored.checkId, status);
      assert.equal(restored.result.claims[0].status, status);
    }
  });
});

test("política de moderação idêntica permite cache hit", async () => {
  await withoutExternalStorage(async () => {
    const input = { kind: "text", text: "Cache mesma política" };
    const value = { checkId: "same", result: { claims: [{ status: "true" }] } };
    const policy = { mode: "required", model: "omni-moderation-latest", refuseCategories: ["sexual/minors"], thresholds: { "sexual/minors": 0.1 }, videoCoverage: "partial_frames_transcript", maxFramesChecked: 4, maxModerationChars: 24_000 };
    await setCached(input, value, "cache-policy-regression", policy);
    const restored = await getCached(input, "cache-policy-regression", policy);
    assert.equal(restored.checkId, "same");
    assert.equal(restored.cached, true);
  });
});

test("mudança de política de moderação invalida a reutilização do cache", async () => {
  await withoutExternalStorage(async () => {
    const input = { kind: "text", text: "Cache política alterada" };
    const value = { checkId: "old", result: { claims: [{ status: "true" }] } };
    const policyA = { mode: "required", model: "omni-moderation-latest", refuseCategories: ["sexual/minors"], thresholds: { "sexual/minors": 0.1 }, videoCoverage: "partial_frames_transcript", maxFramesChecked: 4, maxModerationChars: 24_000 };
    const policyB = { mode: "required", model: "omni-moderation-latest", refuseCategories: ["sexual/minors"], thresholds: { "sexual/minors": 0.9 }, videoCoverage: "partial_frames_transcript", maxFramesChecked: 4, maxModerationChars: 24_000 };
    await setCached(input, value, "cache-policy-change-regression", policyA);
    // Limiar diferente: deve ser cache miss, não reutilizar resultado sob política antiga.
    assert.equal(await getCached(input, "cache-policy-change-regression", policyB), null);
    // Política idêntica à gravada: hit.
    assert.equal((await getCached(input, "cache-policy-change-regression", policyA)).checkId, "old");
  });
});

test("registro sem identidade de política (legado) não recupera resultado sob nova política", async () => {
  await withoutExternalStorage(async () => {
    const input = { kind: "text", text: "Cache legado sem política" };
    const value = { checkId: "legacy", result: { claims: [{ status: "true" }] } };
    // Grava sem identidade de política (registro legado).
    await setCached(input, value, "cache-legacy-regression");
    // Ler com uma política exigida: registro legado não tem identidade compatível → miss.
    const policy = { mode: "required", model: "omni-moderation-latest", refuseCategories: ["sexual/minors"], thresholds: { "sexual/minors": 0.1 }, videoCoverage: "partial_frames_transcript", maxFramesChecked: 4, maxModerationChars: 24_000 };
    assert.equal(await getCached(input, "cache-legacy-regression", policy), null);
  });
});

test("outage da época: cache miss sem reutilizar época anterior e sem gravar novo registro", async () => {
  const { __setCacheEpochLoader } = await import("./cache.js");
  const input = { kind: "text", text: "Época indisponível não reutiliza cache" };
  const value = { checkId: "epoch", result: { claims: [{ status: "true" }] } };
  try {
    // Primeiro com época disponível: grava e recupera normalmente.
    __setCacheEpochLoader(async () => "epoch-1");
    await setCached(input, value, "cache-epoch-regression");
    assert.equal((await getCached(input, "cache-epoch-regression")).checkId, "epoch");
    // Outage: nem leitura nem escrita usam época inicial/anterior.
    __setCacheEpochLoader(async () => { throw new Error("epoch down"); });
    assert.equal(await getCached(input, "cache-epoch-regression"), null);
    const other = { checkId: "other", result: { claims: [{ status: "true" }] } };
    await setCached(input, other, "cache-epoch-regression");
    __setCacheEpochLoader(async () => "epoch-1");
    const restored = await getCached(input, "cache-epoch-regression");
    assert.equal(restored?.checkId ?? null, null, "registro novo não foi gravado durante o outage");
  } finally {
    __setCacheEpochLoader(null);
  }
});

test("leitor HTTP da época rejeita outage e documentos inválidos sem sintetizar initial", async () => {
  const { readCacheEpochResponse } = await import("./cache.js");
  let decoded = false;
  await assert.rejects(readCacheEpochResponse({
    ok: false, status: 503, json: async () => { decoded = true; return { epoch: "initial" }; },
  }), /cache_epoch_unavailable/);
  assert.equal(decoded, false, "corpo de resposta HTTP sem sucesso não é uma época válida");
  for (const body of [{}, null, { epoch: null }, { epoch: "" }, { epoch: " \n" }, { epoch: 123 }, { epoch: false }, { epoch: [] }, { epoch: {} }]) {
    await assert.rejects(readCacheEpochResponse({ ok: true, json: async () => body }), /cache_epoch_unavailable/);
  }
  await assert.rejects(readCacheEpochResponse({ ok: true, json: async () => { throw new Error("invalid JSON"); } }));
  assert.equal(await readCacheEpochResponse({ ok: true, json: async () => ({ epoch: "epoch-2" }) }), "epoch-2");
});

test("respostas HTTP 503 e {} da época não recuperam cache initial anterior", async () => {
  const { __setCacheEpochLoader, readCacheEpochResponse } = await import("./cache.js");
  await withoutExternalStorage(async () => {
    const input = { kind: "text", text: "HTTP epoch regression" };
    try {
      __setCacheEpochLoader(async () => "initial");
      await setCached(input, { checkId: "old-initial", result: { claims: [{ status: "true" }] } }, "epoch-http");
      assert.equal((await getCached(input, "epoch-http")).checkId, "old-initial");
      for (const response of [
        { ok: false, status: 503, json: async () => ({}) },
        { ok: true, status: 200, json: async () => ({}) },
      ]) {
        __setCacheEpochLoader(() => readCacheEpochResponse(response));
        assert.equal(await getCached(input, "epoch-http"), null);
      }
    } finally {
      __setCacheEpochLoader(null);
    }
  });
});

test("cache rejeita mudanças de produção e limites de aquisição efetivos", async () => {
  const { moderationConfig, moderationPolicyFingerprint } = await import("./moderation.js");
  await withoutExternalStorage(async () => {
    const env = { MODERATION_MODE: "required", MEDIA_VIDEO_MODERATION: "none" };
    const policy = moderationPolicyFingerprint(moderationConfig(env));
    const input = { kind: "text", text: "Cache effective safety coverage" };
    const namespace = "cache-effective-policy";
    await setCached(input, { checkId: "effective", result: { claims: [{ status: "true" }] } }, namespace, policy);
    assert.equal((await getCached(input, namespace, policy)).checkId, "effective");
    for (const change of [
      { NODE_ENV: "production" }, { IEV_MAX_TEXT_CHARS: "50000" },
      { IEV_MAX_UPLOAD_BYTES: "1000000" }, { IEV_MAX_MEDIA_SECONDS: "60" },
      { IEV_MAX_DOC_BYTES: "1000000" }, { IEV_EVIDENCE_MAX_TEXT_CHARS: "50000" },
    ]) {
      const changed = moderationPolicyFingerprint(moderationConfig({ ...env, ...change }));
      assert.notEqual(changed, policy);
      assert.equal(await getCached(input, namespace, changed), null);
    }
  });
});
