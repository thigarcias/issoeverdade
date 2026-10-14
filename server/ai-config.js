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
// Registro explícito de modelos com adapter implementado e capacidades
// documentadas por provedor. Só IDs presentes aqui são elegíveis; qualquer
// outro ID descoberto fica com protocolo "unknown", sem inferência por
// semelhança de nome. `eligibleSteps` é derivado das capacidades.
const MODEL_REGISTRY = {
  opencode: {
    "muse-spark-1.3-contributor": { label: "Muse Spark 1.3 Contributor", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "muse-spark-1.2-contributor": { label: "Muse Spark 1.2 Contributor", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6-luna": { label: "GPT-6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.6-luna": { label: "GPT-5.6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "grok-4.7": { label: "Grok 4.7", protocol: "responses", capabilities: ["text-output", "web-search"] },
    "grok-4.6": { label: "Grok 4.6", protocol: "responses", capabilities: ["text-output", "web-search"] },
  },
  openai: {
    "gpt-4o": { label: "GPT-4o", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-mini": { label: "GPT-4o Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1": { label: "GPT-4.1", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1-mini": { label: "GPT-4.1 Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1-nano": { label: "GPT-4.1 Nano", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "whisper-1": { label: "Whisper 1 (transcrição)", protocol: "audio-transcriptions", capabilities: ["audio-input", "transcription"] },
    "gpt-4o-transcribe": { label: "GPT-4o Transcribe", protocol: "audio-transcriptions", capabilities: ["audio-input", "transcription"] },
    "gpt-4o-mini-transcribe": { label: "GPT-4o Mini Transcribe", protocol: "audio-transcriptions", capabilities: ["audio-input", "transcription"] },
    "gpt-transcribe": { label: "GPT Transcribe", protocol: "audio-transcriptions", capabilities: ["audio-input", "transcription"] },
  },
};

// Motivos estruturados de (in)elegibilidade por (modelo, etapa).
export const ELIGIBILITY_REASONS = {
  OTHER_STEP: "other_step",
  NO_ADAPTER: "no_adapter",
  UNVALIDATED_CAPABILITY: "unvalidated_capability",
  MISSING_CREDENTIAL: "missing_credential",
  NOT_IN_INVENTORY: "not_in_inventory",
  STALE_INVENTORY: "stale_inventory",
};

export const REASON_MESSAGES = {
  other_step: "Modelo de transcrição: compatível apenas com a etapa de transcrição.",
  no_adapter: "Protocolo ou provedor sem adapter validado neste pipeline.",
  unvalidated_capability: "Capacidades deste modelo ainda não validadas para esta etapa.",
  missing_credential: "Provedor sem chave configurada — disponibilidade não confirmada.",
  not_in_inventory: "Modelo não está no inventário descoberto.",
  stale_inventory: "Inventário desatualizado e modelo ausente da última descoberta — atualize o catálogo.",
  missing_pair: "Par provedor/modelo ausente.",
};
function eligibleStepsFor(capabilities) {
  if (capabilities.includes("transcription")) return ["transcribe"];
  const steps = [];
  if (capabilities.includes("text-output")) steps.push("judge", "final");
  if (capabilities.includes("image-input")) steps.push("vision");
  return steps;
}

function stepReasonEntry(provider, id, step) {
  const found = registryStepReason(provider, id, step);
  if (found.eligible) return { eligible: true, reason: null, message: null };
  return { eligible: false, reason: found.reason, message: REASON_MESSAGES[found.reason] ?? found.reason };
}

// Elegibilidade no registro, sem depender do inventário descoberto nem de
// credenciais: distingue outra etapa, adapter ausente e capacidade não
// validada. Presença no inventário e credencial são avaliadas em
// pairRejection, com precedência própria.
function registryStepReason(provider, id, step) {
  if (!PROVIDERS[provider]) return { eligible: false, reason: ELIGIBILITY_REASONS.NO_ADAPTER };
  const entry = MODEL_REGISTRY[provider]?.[id];
  if (!entry) return { eligible: false, reason: ELIGIBILITY_REASONS.NO_ADAPTER };
  if (eligibleStepsFor(entry.capabilities).includes(step)) return { eligible: true, reason: null };
  if (entry.capabilities.includes("transcription")) return { eligible: false, reason: ELIGIBILITY_REASONS.OTHER_STEP };
  return { eligible: false, reason: ELIGIBILITY_REASONS.UNVALIDATED_CAPABILITY };
}

let memory = null;
let catalogMemory = null;

export function __resetAiConfigCaches() {
  memory = null;
  catalogMemory = null;
}


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
  if (MODEL_REGISTRY[provider]?.[model]?.protocol === "responses") return config.responseUrl;
  return null;
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label ?? provider;
}

export function modelInfo(provider, id) {
  const entry = PROVIDERS[provider] ? MODEL_REGISTRY[provider]?.[id] : null;
  if (!entry) {
    return {
      id, label: id, protocol: "unknown", capabilities: [], eligibleSteps: [],
      stepReasons: Object.fromEntries(STEPS.map((step) => [step, { eligible: false, reason: ELIGIBILITY_REASONS.NO_ADAPTER, message: REASON_MESSAGES.no_adapter }])),
      ineligibleReason: REASON_MESSAGES.no_adapter,
    };
  }
  return {
    id,
    label: entry.label ?? id,
    protocol: entry.protocol,
    capabilities: [...entry.capabilities],
    eligibleSteps: eligibleStepsFor(entry.capabilities),
    stepReasons: Object.fromEntries(STEPS.map((step) => [step, stepReasonEntry(provider, id, step)])),
  };
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

// Precedência de recusa por (provedor, modelo, etapa): provedor sem adapter
// > credencial ausente (independente de elegibilidade: sem chave não há como
// confirmar disponibilidade) > ausência no inventário (com motivo próprio
// quando o inventário está desatualizado, mantendo o bloqueio atual) >
// elegibilidade da etapa no registro.
function pairRejection(provider, model, step, catalog) {
  if (!PROVIDERS[provider]) return ELIGIBILITY_REASONS.NO_ADAPTER;
  if (!providerKey(provider)) return ELIGIBILITY_REASONS.MISSING_CREDENTIAL;
  const discovered = catalog.providers[provider];
  const info = discovered?.models?.find((candidate) => candidate.id === model);
  if (!info) {
    return discovered?.discovery?.stale ? ELIGIBILITY_REASONS.STALE_INVENTORY : ELIGIBILITY_REASONS.NOT_IN_INVENTORY;
  }
  if (!info.eligibleSteps.includes(step)) {
    return info.stepReasons?.[step]?.reason ?? ELIGIBILITY_REASONS.UNVALIDATED_CAPABILITY;
  }
  return null;
}

export function resolvePairs(raw, catalog, { strict = false } = {}) {
  const out = {};
  const errors = {};
  for (const step of STEPS) {
    const pair = raw?.[step];
    if (!pair || typeof pair !== "object") {
      if (strict) errors[step] = REASON_MESSAGES.missing_pair;
      else out[step] = { ...FACTORY[step] };
      continue;
    }
    const provider = String(pair.provider ?? "");
    const model = String(pair.model ?? "");
    const reason = pairRejection(provider, model, step, catalog);
    if (reason) {
      if (strict) errors[step] = REASON_MESSAGES[reason] ?? reason;
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
