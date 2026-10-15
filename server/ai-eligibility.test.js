// Elegibilidade por etapa, precedência de motivos e rejeição do backend.
// Testes comportamentais: afirmam códigos/etapas, não textos de rótulos.
import { test } from "node:test";
import assert from "node:assert/strict";

const OPENCODE = "k-opencode";
const OPENAI = "k-openai";

function setKeys({ opencode = OPENCODE, openai = OPENAI } = {}) {
  if (opencode === null) delete process.env.OPENCODE_API;
  else process.env.OPENCODE_API = opencode;
  if (openai === null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = openai;
}

function catalogWith(modelsByProvider, { stale = {} } = {}) {
  const providers = {};
  for (const [provider, models] of Object.entries(modelsByProvider)) {
    providers[provider] = { models, discovery: { stale: Boolean(stale[provider]), updatedAt: null, error: null } };
  }
  return { providers };
}

let mod;
async function load() {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  mod = await import("./ai-config.js?eligibility");
  mod.__resetAiConfigCaches();
  return mod;
}

test("registro explícito: gpt-4o elegível para judge/vision; whisper-1 só transcribe; desconhecido sem etapas", async () => {
  const { modelInfo } = await load();
  const gpt4o = modelInfo("openai", "gpt-4o");
  assert.deepEqual([...gpt4o.eligibleSteps].sort(), ["judge", "vision"]);
  assert.ok(gpt4o.capabilities.includes("web-search"));
  assert.equal(gpt4o.protocol, "responses");
  const whisper = modelInfo("openai", "whisper-1");
  assert.deepEqual(whisper.eligibleSteps, ["transcribe"]);
  assert.equal(whisper.stepReasons.judge.reason, "other_step");
  assert.equal(whisper.stepReasons.judge.eligible, false);
  const unknown = modelInfo("openai", "gpt-99-xyz-search-vision");
  assert.deepEqual(unknown.eligibleSteps, []);
  assert.equal(unknown.protocol, "unknown");
  for (const step of ["judge", "vision", "transcribe"]) {
    assert.equal(unknown.stepReasons[step].eligible, false);
    assert.equal(unknown.stepReasons[step].reason, "no_adapter");
  }
});

test("grok com visão sondada ganha vision; deepseek sem imagem não ganha", async () => {
  const { modelInfo } = await load();
  const grok = modelInfo("opencode", "grok-4.7");
  assert.ok(grok.eligibleSteps.includes("judge"));
  assert.ok(grok.eligibleSteps.includes("vision"));
  const deepseek = modelInfo("opencode", "deepseek-v4-flash");
  assert.ok(deepseek.eligibleSteps.includes("judge"));
  assert.ok(!deepseek.eligibleSteps.includes("vision"));
  assert.equal(deepseek.stepReasons.vision.reason, "unvalidated_capability");
  const visionExp = modelInfo("opencode", "deepseek-v4-flash-vision-exp");
  assert.ok(visionExp.eligibleSteps.includes("vision"));
});

test("famílias sondadas: gpt-5/o3/o4-mini elegíveis; legados sem web_search fora", async () => {
  const { modelInfo } = await load();
  for (const id of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.4-mini", "gpt-5.6-sol", "gpt-6-luna", "o3", "o4-mini"]) {
    const info = modelInfo("openai", id);
    assert.deepEqual([...info.eligibleSteps].sort(), ["judge", "vision"]);
    assert.ok(info.capabilities.includes("web-search"));
  }
  for (const id of ["gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "o1", "gpt-4o-search-preview"]) {
    const info = modelInfo("openai", id);
    assert.deepEqual(info.eligibleSteps, []);
    assert.equal(info.protocol, "unknown");
  }
});

test("contrato público expõe três etapas, padrões Luna e ignora chave final persistida", async () => {
  setKeys();
  const { aiConfigCatalog, modelInfo, resolvePairs } = await load();
  const catalog = await aiConfigCatalog();
  assert.deepEqual(catalog.steps, ["judge", "vision", "transcribe"]);
  assert.deepEqual(Object.keys(catalog.factory), catalog.steps);
  for (const step of ["judge", "vision"]) {
    assert.deepEqual(catalog.factory[step], { provider: "opencode", model: "gpt-6-luna" });
  }
  assert.deepEqual(catalog.factory.transcribe, { provider: "openai", model: "whisper-1" });
  assert.equal(Object.hasOwn(modelInfo("opencode", "gpt-6-luna").stepReasons, "final"), false);
  const pairs = {
    judge: { provider: "opencode", model: "gpt-6-luna" },
    vision: { provider: "opencode", model: "gpt-6-luna" },
    transcribe: { provider: "openai", model: "gpt-transcribe" },
    final: { provider: "obsolete", model: "unused" },
  };
  const result = resolvePairs(pairs, catalogWith({
    opencode: [modelInfo("opencode", "gpt-6-luna")],
    openai: [modelInfo("openai", "gpt-transcribe")],
  }), { strict: true });
  assert.equal(result.errors, undefined);
  assert.deepEqual(Object.keys(result.config), catalog.steps);
  assert.equal(Object.hasOwn(result.config, "final"), false);
  assert.deepEqual(result.config.transcribe, pairs.transcribe);
});

test("precedência: credencial ausente supera inventário; inventário desatualizado distingue-se de ausente", async () => {
  const { modelInfo, resolvePairs } = await load();
  const catalog = catalogWith({
    opencode: [modelInfo("opencode", "muse-spark-1.3-contributor")],
    openai: [modelInfo("openai", "gpt-4o")],
  });
  setKeys({ opencode: null, openai: OPENAI });
  const missingKey = resolvePairs(
    { judge: { provider: "opencode", model: "muse-spark-1.3-contributor" } },
    catalog,
    { strict: true },
  );
  assert.ok(missingKey.errors.judge.length > 0);

  setKeys({ opencode: OPENCODE, openai: OPENAI });
  const staleCatalog = catalogWith(
    { opencode: [modelInfo("opencode", "muse-spark-1.3-contributor")], openai: [] },
    { stale: { openai: true } },
  );
  const stale = resolvePairs({ judge: { provider: "openai", model: "gpt-4o" } }, staleCatalog, { strict: true });
  const fresh = resolvePairs(
    { judge: { provider: "openai", model: "gpt-4o" } },
    catalogWith({ opencode: [modelInfo("opencode", "muse-spark-1.3-contributor")], openai: [modelInfo("openai", "gpt-4o")] }),
    { strict: true },
  );
  assert.ok(stale.errors.judge.length > 0);
  assert.ok(!fresh.errors?.judge);
  assert.equal(stale.errors.judge, mod.REASON_MESSAGES.stale_inventory);
  assert.equal(missingKey.errors.judge, mod.REASON_MESSAGES.missing_credential);
});

test("backend publica contrato de três etapas e recusa pares inválidos com fields por motivo", async () => {
  setKeys({ opencode: OPENCODE, openai: OPENAI });
  process.env.ADMIN_SECRET = "00000000-0000-4000-8000-000000000002";
  const ai = await load();
  const { handleAdminRequest } = await import("./admin-endpoint.js?eligibility");
  const auth = { authorization: "Bearer 00000000-0000-4000-8000-000000000002" };
  const catalog = await ai.aiConfigCatalog();
  const published = await handleAdminRequest({ method: "GET", headers: auth, query: { config: "1" } });
  assert.equal(published.status, 200);
  assert.deepEqual(published.body.catalog.steps, ["judge", "vision", "transcribe"]);
  assert.deepEqual(Object.keys(published.body.config), published.body.catalog.steps);
  assert.equal(Object.hasOwn(published.body.config, "final"), false);
  const validPair = {};
  for (const step of catalog.steps) validPair[step] = { ...catalog.factory[step] };
  const invalid = {
    ...validPair,
    judge: { provider: "openai", model: "whisper-1" },
    vision: { provider: "openai", model: "modelo-que-nao-existe" },
  };
  const rejected = await handleAdminRequest({ method: "POST", headers: auth, query: { config: "1" }, body: { config: invalid } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "invalid_ai_config");
  assert.ok(rejected.body.fields.judge.length > 0);
  assert.ok(rejected.body.fields.vision.length > 0);
  assert.notEqual(rejected.body.fields.judge, rejected.body.fields.vision);
});

test("providerUrl compartilha o registro: responses resolvido, transcrição sem URL", async () => {
  const { providerUrl } = await load();
  assert.ok((providerUrl("openai", "gpt-4o") ?? "").includes("responses"));
  assert.ok((providerUrl("opencode", "muse-spark-1.3-contributor") ?? "").includes("responses"));
  assert.equal(providerUrl("openai", "whisper-1"), null);
  assert.equal(providerUrl("openai", "modelo-que-nao-existe"), null);
});
