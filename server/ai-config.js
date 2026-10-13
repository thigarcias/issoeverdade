// Catálogo de IA descoberto nos endpoints dos provedores; credenciais nunca
// saem do servidor. Só capacidades documentadas e adapters implementados são
// elegíveis para cada etapa.
import { createHash } from "node:crypto";

const KEY = "iev-config/ai-v2.json";
const CATALOG_KEY = "iev-config/catalog-v1.json";
const TTL_MS = 60_000;
const CATALOG_TTL_MS = 15 * 60_000;
const STEPS = ["judge", "final", "vision", "transcribe"];
const PROVIDERS = {
  opencode: {
    label: "OpenCode Go",
    responseUrl: "https://opencode.ai/zen/go/v1/responses",
    modelsUrl: "https://opencode.ai/inference/go/v1/models",
    keyName: "OPENCODE_API",
    product: "OpenCode Go",
  },
  openai: {
    label: "OpenAI",
    responseUrl: "https://api.openai.com/v1/responses",
    modelsUrl: "https://api.openai.com/v1/models",
    keyName: "OPENAI_API_KEY",
    product: "OpenAI API",
  },
};

const FACTORY = {
  judge: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  final: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  vision: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  transcribe: { provider: "openai", model: "whisper-1" },
};
const GO_RESPONSES = new Set([
  "grok-4.6", "grok-4.7", "gpt-5.6-luna", "gpt-6-luna",
  "muse-spark-1.2-contributor", "muse-spark-1.3-contributor",
]);
const OPENAI_TRANSCRIPTION = new Set([
  "whisper-1", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe",
]);

let memory = null;
let catalogMemory = null;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function providerKey(provider) {
  const keyName = PROVIDERS[provider]?.keyName;
  return keyName ? process.env[keyName] || null : null;
}

export function providerUrl(provider, model) {
  const config = PROVIDERS[provider];
  if (!config) return null;
  if (provider === "opencode" && GO_RESPONSES.has(model)) return config.responseUrl;
  if (provider === "openai" && isOpenAiResponsesModel(model)) return config.responseUrl;
  return null;
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label ?? provider;
}

function isOpenAiResponsesModel(id) {
  return /^(?:gpt-(?:6(?:\.\d+)?|5(?:\.\d+)?|4\.(?:1|o))(?:-(?:mini|nano|pro|sol|terra|luna))?)$/.test(id);
}

function modelInfo(provider, id) {
  if (provider === "openai" && OPENAI_TRANSCRIPTION.has(id)) {
    return {
      id, label: id, protocol: "audio-transcriptions", capabilities: ["audio-input", "transcription"],
      eligibleSteps: ["transcribe"],
    };
  }
  const supported = provider === "opencode" ? GO_RESPONSES.has(id) : isOpenAiResponsesModel(id);
  if (!supported) {
    return {
      id, label: id, protocol: "unknown", capabilities: [], eligibleSteps: [],
      ineligibleReason: "Protocolo ou capacidades ainda não validados para este pipeline.",
    };
  }
  const vision = provider === "openai" || /^(?:muse-spark|gpt-\d)/.test(id);
  const capabilities = ["text-output", "web-search", ...(vision ? ["image-input"] : [])];
  return {
    id, label: modelLabel(id), protocol: "responses", capabilities,
    eligibleSteps: ["judge", "final", ...(vision ? ["vision"] : [])],
  };
}

function modelLabel(id) {
  const known = {
    "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
    "muse-spark-1.2-contributor": "Muse Spark 1.2 Contributor",
    "gpt-6-luna": "GPT-6 Luna",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "grok-4.7": "Grok 4.7",
    "grok-4.6": "Grok 4.6",
    "whisper-1": "Whisper 1 (transcrição)",
    "gpt-transcribe": "GPT Transcribe",
    "gpt-4o-transcribe": "GPT-4o Transcribe",
    "gpt-4o-mini-transcribe": "GPT-4o Mini Transcribe",
  };
  return known[id] ?? id;
}

async function fetchCatalog(provider) {
  const token = providerKey(provider);
  if (provider === "openai" && !token) {
    return { models: [], error: "Provedor sem chave configurada.", updatedAt: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(PROVIDERS[provider].modelsUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ids = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
    if (ids.length === 0) throw new Error("empty_catalog");
    return { models: [...new Set(ids)].map((id) => modelInfo(provider, id)), error: null, updatedAt: new Date().toISOString() };
  } catch (error) {
    return { models: null, error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? "discovery_failed").slice(0, 120), updatedAt: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadStoredCatalog() {
  const token = blobToken();
  if (!token) return null;
  try {
    const { list } = await import("@vercel/blob");
    const found = await list({ prefix: CATALOG_KEY, token });
    const item = found.blobs.find((blob) => blob.pathname === CATALOG_KEY);
    if (!item) return null;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.providers && typeof body.providers === "object" ? body.providers : null;
  } catch {
    return null;
  }
}

async function storeCatalog(providers) {
  const token = blobToken();
  if (!token) return;
  const { put } = await import("@vercel/blob");
  await put(CATALOG_KEY, JSON.stringify({ version: 1, providers }), {
    access: "private", contentType: "application/json", token, allowOverwrite: true,
  });
}

async function getCatalogState(force = false) {
  if (!force && catalogMemory && Date.now() - catalogMemory.fetchedAt < CATALOG_TTL_MS) return catalogMemory;
  const [results, stored] = await Promise.all([
    Promise.all(Object.keys(PROVIDERS).map(async (id) => [id, await fetchCatalog(id)])),
    catalogMemory ? Promise.resolve(null) : loadStoredCatalog(),
  ]);
  const providers = Object.fromEntries(results);
  const previous = catalogMemory?.providers ?? stored ?? {};
  for (const [id, current] of Object.entries(providers)) {
    if (current.models === null) {
      const last = previous[id];
      current.models = last?.models?.length ? last.models : fallbackInventory(id);
      current.updatedAt = last?.updatedAt ?? null;
      current.stale = true;
    } else {
      current.stale = false;
    }
  }
  catalogMemory = { providers, fetchedAt: Date.now() };
  if (Object.values(providers).some((provider) => !provider.stale && provider.models.length > 0)) {
    storeCatalog(providers).catch(() => {});
  }
  return catalogMemory;
}

function fallbackInventory(provider) {
  return Object.keys(FACTORY).map((step) => FACTORY[step])
    .filter((pair) => pair.provider === provider)
    .map((pair) => modelInfo(provider, pair.model));
}

export async function aiConfigCatalog({ refresh = false } = {}) {
  const state = await getCatalogState(refresh);
  const catalogProviders = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => {
    const discovered = state.providers[id];
    return [id, {
      label: p.label,
      product: p.product,
      hasKey: Boolean(providerKey(id)),
      models: discovered.models,
      discovery: { updatedAt: discovered.updatedAt, stale: discovered.stale, error: discovered.error ?? null },
    }];
  }));
  return {
    providers: catalogProviders,
    steps: [...STEPS],
    factory: Object.fromEntries(Object.entries(FACTORY).map(([step, pair]) => [step, { ...pair }])),
  };
}

function envConfig() {
  const out = {};
  for (const step of STEPS) {
    try {
      if (process.env[`IEV_${step.toUpperCase()}`]) out[step] = JSON.parse(process.env[`IEV_${step.toUpperCase()}`]);
    } catch { /* invalid environment value is ignored in favor of factory */ }
  }
  return out;
}

function resolvePairs(raw, catalog, { strict = false } = {}) {
  const out = {};
  const errors = {};
  for (const step of STEPS) {
    const pair = raw?.[step];
    if (!pair || typeof pair !== "object") {
      if (strict) errors[step] = "Par provedor/modelo ausente.";
      else out[step] = { ...FACTORY[step] };
      continue;
    }
    const provider = String(pair.provider ?? "");
    const model = String(pair.model ?? "");
    const info = catalog.providers[provider]?.models?.find((candidate) => candidate.id === model);
    const providerReady = Boolean(providerKey(provider));
    if (!info || !info.eligibleSteps.includes(step) || !providerReady) {
      const reason = !info ? "Modelo não está no inventário descoberto." :
        !info.eligibleSteps.includes(step) ? info.ineligibleReason ?? `Modelo incompatível com ${step}.` : "Chave do provedor ausente.";
      if (strict) errors[step] = reason;
      else out[step] = { ...FACTORY[step] };
      continue;
    }
    out[step] = { provider, model };
  }
  if (strict && Object.keys(errors).length) return { errors };
  for (const step of STEPS) out[step] ??= { ...FACTORY[step] };
  return { config: out };
}

function configRevision(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

function validState(state, source, persisted, configErrors = null) {
  return {
    config: state.config,
    source,
    persisted,
    configErrors,
    updatedAt: state.updatedAt ?? null,
    revision: configRevision(state.config),
  };
}

async function loadBlobConfig() {
  const token = blobToken();
  if (!token) return null;
  const { list } = await import("@vercel/blob");
  const found = await list({ prefix: KEY, token });
  const item = found.blobs.find((blob) => blob.pathname === KEY);
  if (!item) return null;
  const response = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("config_read_failed");
  const body = await response.json();
  return { config: body.config ?? body, updatedAt: body.updatedAt ?? null };
}

export async function getAiConfigState() {
  if (memory && (memory.source === "ephemeral" || Date.now() - memory.loadedAt < TTL_MS)) return memory;
  const catalog = await aiConfigCatalog();
  try {
    const saved = await loadBlobConfig();
    if (saved) {
      const validation = resolvePairs(saved.config, catalog, { strict: true });
      const result = resolvePairs(saved.config, catalog);
      memory = {
        ...validState({ config: result.config, updatedAt: saved.updatedAt }, "blob", true, validation.errors ?? null),
        loadedAt: Date.now(),
      };
      return memory;
    }
  } catch {
    if (memory) return memory;
  }
  const rawEnv = envConfig();
  const env = resolvePairs(rawEnv, catalog);
  const hasEnv = Object.keys(rawEnv).length > 0;
  memory = { ...validState({ config: env.config, updatedAt: null }, hasEnv ? "env" : "factory", false), loadedAt: Date.now() };
  return memory;
}

export async function getAiConfig() {
  return (await getAiConfigState()).config;
}

export async function validateAiConfig(raw) {
  const catalog = await aiConfigCatalog();
  const result = resolvePairs(raw, catalog, { strict: true });
  return result.errors ? { errors: result.errors } : { config: result.config };
}

export async function saveAiConfig(raw) {
  const validation = await validateAiConfig(raw);
  if (validation.errors) {
    const error = new Error("invalid_ai_config");
    error.status = 400;
    error.fields = validation.errors;
    throw error;
  }
  const config = validation.config;
  const updatedAt = new Date().toISOString();
  const token = blobToken();
  if (token) {
    const { put } = await import("@vercel/blob");
    await put(KEY, JSON.stringify({ version: 2, config, updatedAt, revision: configRevision(config) }), {
      access: "private", contentType: "application/json", token, allowOverwrite: true,
    });
  }
  memory = {
    ...validState({ config, updatedAt }, token ? "blob" : "ephemeral", Boolean(token)),
    loadedAt: Date.now(),
  };
  return { saved: config, persisted: Boolean(token), source: memory.source, revision: memory.revision, updatedAt };
}
