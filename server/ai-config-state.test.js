// Resiliência da resolução de configuração de IA: bootstrap intencional,
// outage de persistência, configuração inválida e catálogo desatualizado.
// Nenhum caminho substitui silenciosamente o par persistido por um padrão.
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

function catalogResponse(modelsByProvider) {
  return async (url) => {
    const provider = String(url).includes("opencode.ai") ? "opencode" : "openai";
    return new Response(JSON.stringify({ data: (modelsByProvider[provider] ?? []).map((id) => ({ id })) }), { status: 200 });
  };
}

const VALID_CONFIG = {
  judge: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  vision: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  transcribe: { provider: "openai", model: "whisper-1" },
};

async function withModule(fn) {
  const previousFetch = globalThis.fetch;
  const names = ["OPENCODE_API", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN"];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const mod = await import("./ai-config.js");
  mod.__resetAiConfigCaches();
  mod.__setAiConfigLoader(null);
  try {
    await fn(mod);
  } finally {
    mod.__setAiConfigLoader(null);
    mod.__resetAiConfigCaches();
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("outage de persistência com snapshot conhecido preserva par/revisão e informa a origem", async () => {
  await withModule(async (mod) => {
    setKeys();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: "2026-10-01T00:00:00.000Z" }));
    const first = await mod.getAiConfigState();
    assert.equal(first.source, "blob");
    assert.deepEqual(first.config, VALID_CONFIG);
    const revision = first.revision;
    mod.__expireAiConfigMemory();
    mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const second = await mod.getAiConfigState();
    assert.deepEqual(second.config, VALID_CONFIG, "o par persistido é preservado exatamente");
    assert.equal(second.revision, revision, "a revisão conhecida é preservada");
    assert.equal(second.source, "blob", "a origem continua explícita");
    assert.equal(second.stale, true);
    assert.equal(second.staleReason, "config_read_failed");
  });
});

test("outage sem configuração conhecida não executa um padrão diferente", async () => {
  await withModule(async (mod) => {
    setKeys();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const state = await mod.getAiConfigState();
    assert.equal(state.config, null, "nenhum par é escolhido durante o outage");
    assert.equal(state.error, "ai_config_unavailable");
    assert.equal(state.source, "unavailable");
  });
});

test("bootstrap sem preferência persistida usa a fábrica; inválida não é confundida com bootstrap", async () => {
  await withModule(async (mod) => {
    setKeys();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => null);
    const bootstrap = await mod.getAiConfigState();
    assert.equal(bootstrap.source, "factory");
    assert.equal(bootstrap.config.judge.provider, "opencode");
    assert.equal(bootstrap.config.transcribe.provider, "openai");

    mod.__resetAiConfigCaches();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    mod.__setAiConfigLoader(async () => ({
      config: { ...VALID_CONFIG, judge: { provider: "openai", model: "whisper-1" } },
      updatedAt: "2026-10-01T00:00:00.000Z",
    }));
    const invalid = await mod.getAiConfigState();
    assert.equal(invalid.config, null, "config inválida não vira padrão");
    assert.equal(invalid.error, "ai_config_invalid");
    assert.match(invalid.configErrors.judge, /transcrição|compatível/i);
  });
});

test("catálogo desatualizado sobre a mesma revisão reutiliza o snapshot, sem trocar o par", async () => {
  await withModule(async (mod) => {
    setKeys();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: "2026-10-01T00:00:00.000Z" }));
    const first = await mod.getAiConfigState();
    assert.deepEqual(first.config, VALID_CONFIG);
    // Catálogo passa a falhar: inventário stale cai no fallback de fábrica, que
    // não contém o modelo persistido. Mesmo assim, o snapshot da MESMA revisão
    // é reutilizado explicitamente, sem troca de par.
    mod.__expireAiConfigMemory();
    mod.__resetAiConfigCatalogCache();
    globalThis.fetch = async () => { throw new Error("catalog down"); };
    const second = await mod.getAiConfigState();
    assert.deepEqual(second.config, VALID_CONFIG);
    assert.equal(second.revision, first.revision);
    assert.equal(second.stale, true);
    assert.equal(second.staleReason, "catalog_stale");
  });
});

test("credencial ausente e modelo incompatível permanecem motivos distintos e observáveis", async () => {
  await withModule(async (mod) => {
    setKeys({ opencode: OPENCODE, openai: null });
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"] });
    mod.__setAiConfigLoader(async () => ({ config: { ...VALID_CONFIG, transcribe: { provider: "openai", model: "whisper-1" } }, updatedAt: null }));
    const missingKey = await mod.getAiConfigState();
    assert.equal(missingKey.error, "ai_config_invalid");
    assert.equal(missingKey.configErrors.transcribe, mod.REASON_MESSAGES.missing_credential);

    mod.__resetAiConfigCaches();
    setKeys();
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob";
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor", "deepseek-v4-flash"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: { ...VALID_CONFIG, vision: { provider: "opencode", model: "deepseek-v4-flash" } }, updatedAt: null }));
    const incompatible = await mod.getAiConfigState();
    assert.equal(incompatible.error, "ai_config_invalid");
    assert.equal(incompatible.configErrors.vision, mod.REASON_MESSAGES.unvalidated_capability);
    assert.notEqual(incompatible.configErrors.vision, mod.REASON_MESSAGES.missing_credential);
  });
});

test("outage de Blob revalida as credenciais atuais antes de reutilizar o snapshot", async () => {
  for (const provider of ["opencode", "openai"]) {
    await withModule(async (mod) => {
      setKeys();
      delete process.env.BLOB_READ_WRITE_TOKEN;
      globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
      mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: "2026-10-01T00:00:00.000Z" }));
      const first = await mod.getAiConfigState();
      mod.__expireAiConfigMemory();
      setKeys(provider === "opencode" ? { opencode: null } : { openai: null });
      mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
      const state = await mod.getAiConfigState();
      assert.equal(state.config, null, "não reutiliza nem substitui pares sem credencial atual");
      assert.equal(state.error, "ai_config_invalid");
      assert.equal(state.configErrors[provider === "opencode" ? "judge" : "transcribe"], mod.REASON_MESSAGES.missing_credential);
      assert.equal(state.revision, first.revision);
      assert.equal(state.rawRevision, first.rawRevision);
      assert.equal(state.source, first.source);
      assert.equal(state.updatedAt, first.updatedAt);
      assert.equal(state.staleReason, "config_read_failed");
    });
  }
});

test("snapshot ainda no TTL não esconde remoção de credencial", async () => {
  await withModule(async (mod) => {
    setKeys();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: null }));
    const first = await mod.getAiConfigState();
    setKeys({ opencode: null });
    const state = await mod.getAiConfigState();
    assert.equal(state.config, null);
    assert.equal(state.error, "ai_config_invalid");
    assert.equal(state.configErrors.judge, mod.REASON_MESSAGES.missing_credential);
    assert.equal(state.revision, first.revision);
  });
});

test("outage de Blob não ignora remoção do modelo no catálogo atual", async () => {
  await withModule(async (mod) => {
    setKeys();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: null }));
    const first = await mod.getAiConfigState();
    globalThis.fetch = catalogResponse({ opencode: ["gpt-6-luna"], openai: ["whisper-1"] });
    await mod.aiConfigCatalog({ refresh: true });
    mod.__expireAiConfigMemory();
    mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const state = await mod.getAiConfigState();
    assert.equal(state.config, null);
    assert.equal(state.error, "ai_config_invalid");
    assert.equal(state.configErrors.judge, mod.REASON_MESSAGES.not_in_inventory);
    assert.equal(state.revision, first.revision);
    assert.equal(state.source, first.source);
  });
});

test("outage de Blob revalida capacidades do snapshot contra o catálogo atual", async () => {
  await withModule(async (mod) => {
    setKeys();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
    mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: null }));
    await mod.getAiConfigState();
    const catalog = await mod.aiConfigCatalog();
    const model = catalog.providers.opencode.models.find((item) => item.id === VALID_CONFIG.vision.model);
    model.eligibleSteps = ["judge"];
    model.stepReasons.vision = { eligible: false, reason: "unvalidated_capability" };
    mod.__expireAiConfigMemory();
    mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
    const state = await mod.getAiConfigState();
    assert.equal(state.config, null);
    assert.equal(state.error, "ai_config_invalid");
    assert.equal(state.configErrors.vision, mod.REASON_MESSAGES.unvalidated_capability);
  });
});

test("outage simultâneo de descoberta e Blob só reutiliza o mesmo snapshot com credenciais válidas", async () => {
  for (const missingCredential of [false, true]) {
    await withModule(async (mod) => {
      setKeys();
      delete process.env.BLOB_READ_WRITE_TOKEN;
      globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor"], openai: ["whisper-1"] });
      mod.__setAiConfigLoader(async () => ({ config: VALID_CONFIG, updatedAt: null }));
      const first = await mod.getAiConfigState();
      mod.__expireAiConfigMemory();
      mod.__resetAiConfigCatalogCache();
      if (missingCredential) setKeys({ opencode: null });
      globalThis.fetch = async () => { throw new Error("catalog down"); };
      mod.__setAiConfigLoader(async () => { throw new Error("blob down"); });
      const state = await mod.getAiConfigState();
      assert.equal(state.revision, first.revision);
      assert.equal(state.source, first.source);
      assert.equal(state.staleReason, "config_read_failed");
      if (missingCredential) {
        assert.equal(state.config, null);
        assert.equal(state.error, "ai_config_invalid");
        assert.equal(state.configErrors.judge, mod.REASON_MESSAGES.missing_credential);
      } else {
        assert.deepEqual(state.config, VALID_CONFIG);
        assert.equal(state.error, null);
        assert.equal(state.stale, true);
      }
    });
  }
});

test("duas resoluções consecutivas para texto preservam bootstrap sem chave da transcrição opcional", async () => {
  await withModule(async (mod) => {
    setKeys({ openai: null });
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = catalogResponse({ opencode: ["muse-spark-1.3-contributor", "gpt-6-luna"] });
    mod.__setAiConfigLoader(async () => null);
    const first = await mod.getAiConfigState();
    const second = await mod.getAiConfigState();
    assert.equal(first.source, "factory");
    assert.equal(first.error, null);
    assert.equal(second.source, first.source);
    assert.equal(second.error, null, "ausência de OpenAI em etapa opcional não invalida bootstrap de texto no TTL");
    assert.equal(second.configErrors, null);
    assert.deepEqual(second.config, first.config);
    assert.deepEqual(second.config.judge, { provider: "opencode", model: "gpt-6-luna" });
    assert.equal(second.revision, first.revision);
    assert.deepEqual(await mod.getAiConfig(), first.config, "a resolução usada pela inferência continua determinável");
  });
});
