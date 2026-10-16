// Catálogo de IA descoberto nos endpoints dos provedores; credenciais nunca
// saem do servidor. Só capacidades documentadas e adapters implementados são
// elegíveis para cada etapa.
import { createHash } from "node:crypto";
import { stateStoreMode, readState, writeState } from "./state-store.js";

const KEY = "iev-config/ai-v2.json";
const CATALOG_KEY = "iev-config/catalog-v1.json";
const TTL_MS = 60_000;
const CATALOG_TTL_MS = 15 * 60_000;
const STEPS = ["judge", "vision", "transcribe"];
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
  judge: { provider: "opencode", model: "gpt-6-luna" },
  vision: { provider: "opencode", model: "gpt-6-luna" },
  transcribe: { provider: "openai", model: "whisper-1" },
};
// Registro explícito de modelos com adapter implementado e capacidades
// comprovadas por provedor. Fontes por entrada: (D) página do modelo em
// developers.openai.com com Responses+web_search, (S) sonda real de inferência
// (Responses com web_search, e input_image para visão), (Z) tabela da OpenCode
// (opencode.ai/docs/zen, coluna Endpoint). Só IDs presentes aqui são
// elegíveis; qualquer outro ID descoberto fica com protocolo "unknown".
// `eligibleSteps` é derivado das capacidades.
const MODEL_REGISTRY = {
  opencode: {
    // Responses+web_search sondados (S); visão sondada com imagem 64px (S).
    "muse-spark-1.3-contributor": { label: "Muse Spark 1.3 Contributor", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "muse-spark-1.2-contributor": { label: "Muse Spark 1.2 Contributor", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6-luna": { label: "GPT-6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.6-luna": { label: "GPT-5.6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "grok-4.7": { label: "Grok 4.7", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "grok-4.6": { label: "Grok 4.6", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    // Família deepseek responde no endpoint Go com web_search (S). A doc Zen
    // lista chat/completions (Z), mas a sonda no endpoint Go retornou 200 com
    // a tool — vale o comportamento observado. Visão: só a variante
    // vision-exp aceitou input_image (S); as demais recusam imagem.
    "deepseek-v4-flash": { label: "DeepSeek V4 Flash", protocol: "responses", capabilities: ["text-output", "web-search"] },
    "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", protocol: "responses", capabilities: ["text-output", "web-search"] },
    "deepseek-v4-pro": { label: "DeepSeek V4 Pro", protocol: "responses", capabilities: ["text-output", "web-search"] },
    "deepseek-flash": { label: "DeepSeek Flash", protocol: "responses", capabilities: ["text-output", "web-search"] },
    "deepseek-v4-flash-vision-exp": { label: "DeepSeek V4 Flash Vision (exp)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
  },
  openai: {
    // Documentados com Responses+web_search+image (D) e sondados com a tool (S).
    "gpt-4o": { label: "GPT-4o", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-mini": { label: "GPT-4o Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-2024-11-20": { label: "GPT-4o (2024-11-20)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-2024-08-06": { label: "GPT-4o (2024-08-06)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-2024-05-13": { label: "GPT-4o (2024-05-13)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4o-mini-2024-07-18": { label: "GPT-4o Mini (2024-07-18)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1": { label: "GPT-4.1", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1-mini": { label: "GPT-4.1 Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    // gpt-4.1-nano: doc lista Responses mas SEM web_search nas tools, e a sonda confirma 400 — fora.
    "gpt-4.1-2025-04-14": { label: "GPT-4.1 (2025-04-14)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-4.1-mini-2025-04-14": { label: "GPT-4.1 Mini (2025-04-14)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5": { label: "GPT-5", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-2025-08-07": { label: "GPT-5 (2025-08-07)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-mini": { label: "GPT-5 Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-mini-2025-08-07": { label: "GPT-5 Mini (2025-08-07)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-nano": { label: "GPT-5 Nano", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-nano-2025-08-07": { label: "GPT-5 Nano (2025-08-07)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-pro": { label: "GPT-5 Pro", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5-pro-2025-10-06": { label: "GPT-5 Pro (2025-10-06)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.1": { label: "GPT-5.1", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.1-2025-11-13": { label: "GPT-5.1 (2025-11-13)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.2": { label: "GPT-5.2", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.2-2025-12-11": { label: "GPT-5.2 (2025-12-11)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.2-pro": { label: "GPT-5.2 Pro", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.2-pro-2025-12-11": { label: "GPT-5.2 Pro (2025-12-11)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.3-codex": { label: "GPT-5.3 Codex", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4": { label: "GPT-5.4", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-2026-03-05": { label: "GPT-5.4 (2026-03-05)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-mini": { label: "GPT-5.4 Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-mini-2026-03-17": { label: "GPT-5.4 Mini (2026-03-17)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-nano": { label: "GPT-5.4 Nano", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-nano-2026-03-17": { label: "GPT-5.4 Nano (2026-03-17)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-pro": { label: "GPT-5.4 Pro", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.4-pro-2026-03-05": { label: "GPT-5.4 Pro (2026-03-05)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.5": { label: "GPT-5.5", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.5-2026-04-23": { label: "GPT-5.5 (2026-04-23)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.5-pro": { label: "GPT-5.5 Pro", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.5-pro-2026-04-23": { label: "GPT-5.5 Pro (2026-04-23)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.6-sol": { label: "GPT-5.6 Sol", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.6-luna": { label: "GPT-5.6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-5.6-terra": { label: "GPT-5.6 Terra", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6-luna": { label: "GPT-6 Luna", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6-sol": { label: "GPT-6 Sol", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6.1-sol": { label: "GPT-6.1 Sol", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "gpt-6-astra": { label: "GPT-6 Astra", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    // Raciocínio com Responses+web_search+imagem (D+S). o1/o1-pro/o3-mini
    // recusam a tool (sonda 400) e ficam fora; codex/chat-latest 404 nesta
    // chave (sem acesso) e também ficam fora.
    "o3": { label: "o3", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "o3-2025-04-16": { label: "o3 (2025-04-16)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "o3-pro": { label: "o3 Pro", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "o4-mini": { label: "o4 Mini", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "o4-mini-2025-04-16": { label: "o4 Mini (2025-04-16)", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
    "chat-latest": { label: "Chat Latest", protocol: "responses", capabilities: ["text-output", "web-search", "image-input"] },
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
  if (capabilities.includes("text-output")) steps.push("judge");
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
let blobConfigLoader = null;

export function __resetAiConfigCaches() {
  memory = null;
  catalogMemory = null;
}

export function __resetAiConfigCatalogCache() {
  catalogMemory = null;
}

/** Injeção usada por testes; `null` restaura a leitura real do Blob. */
export function __setAiConfigLoader(loader) {
  blobConfigLoader = typeof loader === "function" ? loader : null;
}

/** Expira a memória sem descartá-la, para exercitar revalidação em testes. */
export function __expireAiConfigMemory() {
  if (memory) memory = { ...memory, loadedAt: 0 };
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
  if (stateStoreMode() === "supabase") {
    try { return (await readState("catalog", "providers"))?.providers ?? null; }
    catch { return null; }
  }
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
  if (stateStoreMode() === "supabase") return writeState("catalog", "providers", { version: 1, providers });
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
      current.models = last?.models?.length ? last.models.map((model) => modelInfo(id, model.id)) : fallbackInventory(id);
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
    stale: false,
    staleReason: null,
    rawRevision: state.rawRevision ?? null,
    error: null,
  };
}

/**
 * Estado sem configuração determinável com segurança. Nunca carrega um par:
 * o chamador deve falhar antes da inferência paga, com motivo distinto.
 */
function unavailableState({ source, persisted, configErrors = null, error, stale = false, staleReason = null }) {
  return {
    config: null,
    source,
    persisted,
    configErrors,
    updatedAt: null,
    revision: null,
    stale,
    staleReason,
    rawRevision: null,
    error,
  };
}

function revalidateSnapshot(snapshot, catalog, staleReason = null) {
  const validation = resolvePairs(snapshot.config, catalog, { strict: true });
  const staleOnly = validation.errors && Object.values(validation.errors).every((reason) => reason === REASON_MESSAGES.stale_inventory)
    && STEPS.every((step) => registryStepReason(snapshot.config[step]?.provider, snapshot.config[step]?.model, step).eligible);
  if (validation.errors && !staleOnly) {
    return {
      ...snapshot,
      config: null,
      configErrors: validation.errors,
      error: "ai_config_invalid",
      stale: Boolean(staleReason ?? snapshot.staleReason),
      staleReason: staleReason ?? snapshot.staleReason,
      loadedAt: Date.now(),
    };
  }
  const reason = staleReason ?? (staleOnly ? "catalog_stale" : snapshot.staleReason);
  return { ...snapshot, stale: Boolean(reason), staleReason: reason, loadedAt: snapshot.loadedAt };
}

async function loadBlobConfig() {
  if (stateStoreMode() === "supabase") return readState("config", "ai-v2");
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
  const cached = memory && (memory.source === "ephemeral" || Date.now() - memory.loadedAt < TTL_MS);
  // Bootstrap conserva etapas opcionais ainda não configuradas; a credencial
  // de cada etapa é exigida quando ela é usada. Snapshots explícitos salvos
  // continuam sujeitos à revalidação integral, mesmo dentro do TTL.
  if (cached && (!memory.config || memory.source === "factory" || memory.source === "env")) return memory;
  const catalog = await aiConfigCatalog();
  if (cached) {
    memory = revalidateSnapshot(memory, catalog);
    return memory;
  }
  let saved = null;
  let readFailure = null;
  try {
    saved = await (blobConfigLoader ? blobConfigLoader() : loadBlobConfig());
  } catch {
    readFailure = "config_read_failed";
  }
  if (readFailure) {
    // Revalidar o snapshot contra as credenciais e capacidades atuais antes de
    // reutilizá-lo. Só indisponibilidade de descoberta permite inventário stale.
    if (memory?.config && memory.persisted) {
      memory = { ...revalidateSnapshot(memory, catalog, readFailure), loadedAt: Date.now() };
      return memory;
    }
    memory = unavailableState({
      source: "unavailable",
      persisted: true,
      error: "ai_config_unavailable",
      stale: true,
      staleReason: readFailure,
    });
    memory.loadedAt = Date.now();
    return memory;
  }
  if (saved) {
    const rawRevision = configRevision(saved.config);
    const validation = resolvePairs(saved.config, catalog, { strict: true });
    if (validation.errors) {
      // Persistida inválida ou incompatível com o catálogo. Reutiliza um
      // snapshot apenas quando ele corresponde à MESMA configuração persistida
      // e o bloqueio veio somente de inventário desatualizado; caso contrário,
      // não substitui por padrão e expõe motivos distintos por etapa.
      const reasons = Object.values(validation.errors);
      const staleOnly = reasons.length > 0 && reasons.every((reason) => reason === REASON_MESSAGES.stale_inventory);
      if (staleOnly && memory?.config && memory.rawRevision === rawRevision) {
        memory = { ...revalidateSnapshot(memory, catalog, "catalog_stale"), loadedAt: Date.now() };
        return memory;
      }
      memory = unavailableState({
        source: stateStoreMode() === "supabase" ? "supabase" : "blob",
        persisted: true,
        configErrors: validation.errors,
        error: "ai_config_invalid",
      });
      memory.updatedAt = saved.updatedAt ?? null;
      memory.rawRevision = rawRevision;
      memory.loadedAt = Date.now();
      return memory;
    }
    memory = {
      ...validState({ config: validation.config, updatedAt: saved.updatedAt, rawRevision }, stateStoreMode() === "supabase" ? "supabase" : "blob", true),
      loadedAt: Date.now(),
    };
    return memory;
  }
  // Nunca definida (bootstrap intencional): ambiente ou padrão documentado.
  const rawEnv = envConfig();
  // O Blob bloqueado pode conter uma escolha diferente. A migração requer
  // salvar a escolha no admin ou fornecer IEV_JUDGE explicitamente.
  if (stateStoreMode() === "supabase" && !rawEnv.judge) {
    memory = { ...unavailableState({ source: "supabase", persisted: false,
      error: "ai_config_setup_required", configErrors: { judge: "Salve a configuração de IA no painel para concluir a migração ao Supabase." },
    }), loadedAt: Date.now() };
    return memory;
  }
  const env = resolvePairs(rawEnv, catalog);
  const hasEnv = Object.keys(rawEnv).length > 0;
  memory = { ...validState({ config: env.config, updatedAt: null }, hasEnv ? "env" : "factory", false), loadedAt: Date.now(), stale: false, error: null };
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
  const supabase = stateStoreMode() === "supabase";
  if (supabase) {
    await writeState("config", "ai-v2", { version: 2, config, updatedAt, revision: configRevision(config) });
  } else if (token) {
    const { put } = await import("@vercel/blob");
    await put(KEY, JSON.stringify({ version: 2, config, updatedAt, revision: configRevision(config) }), {
      access: "private", contentType: "application/json", token, allowOverwrite: true,
    });
  }
  memory = {
    ...validState({ config, updatedAt, rawRevision: configRevision(config) }, supabase ? "supabase" : token ? "blob" : "ephemeral", supabase || Boolean(token)),
    loadedAt: Date.now(),
  };
  return { saved: config, persisted: supabase || Boolean(token), source: memory.source, revision: memory.revision, updatedAt };
}

