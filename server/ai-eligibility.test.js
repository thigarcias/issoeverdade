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

test("registro explícito: gpt-4o elegível para judge/final/vision; whisper-1 só transcribe; desconhecido sem etapas", async () => {
  const { modelInfo } = await load();
  const gpt4o = modelInfo("openai", "gpt-4o");
  assert.deepEqual([...gpt4o.eligibleSteps].sort(), ["final", "judge", "vision"]);
  assert.ok(gpt4o.capabilities.includes("web-search"));
  assert.equal(gpt4o.protocol, "responses");
  const whisper = modelInfo("openai", "whisper-1");
  assert.deepEqual(whisper.eligibleSteps, ["transcribe"]);
  assert.equal(whisper.stepReasons.judge.reason, "other_step");
  assert.equal(whisper.stepReasons.judge.eligible, false);
  const unknown = modelInfo("openai", "gpt-99-xyz-search-vision");
  assert.deepEqual(unknown.eligibleSteps, []);
  assert.equal(unknown.protocol, "unknown");
  for (const step of ["judge", "final", "vision", "transcribe"]) {
    assert.equal(unknown.stepReasons[step].eligible, false);
    assert.equal(unknown.stepReasons[step].reason, "no_adapter");
  }
});

test("grok sem imagem não ganha vision automaticamente", async () => {
  const { modelInfo } = await load();
  const grok = modelInfo("opencode", "grok-4.7");
  assert.ok(grok.eligibleSteps.includes("judge"));
  assert.ok(!grok.eligibleSteps.includes("vision"));
  assert.equal(grok.stepReasons.vision.reason, "unvalidated_capability");
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

test("backend recusa 400 com fields por motivo; par válido passa", async () => {
  setKeys({ opencode: OPENCODE, openai: OPENAI });
  process.env.ADMIN_SECRET = "segredo-de-teste";
  const ai = await load();
  const { handleAdminRequest } = await import("./admin-endpoint.js?eligibility");
  const auth = { authorization: "Bearer segredo-de-teste" };
  const catalog = await ai.aiConfigCatalog();
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
