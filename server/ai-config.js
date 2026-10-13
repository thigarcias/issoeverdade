// Config de IA selecionável pelo painel admin — qual provedor e modelo
// o pipeline usa em cada passo. Persistida no Vercel Blob (privada);
// sem Blob, vale em memória por instância + variáveis de ambiente.
// Sem config salva: fábrica (Muse primário, Luna fallback).

const KEY = "iev-config/ai.json";

const PROVIDERS = {
  opencode: {
    label: "OpenCode Go",
    url: "https://opencode.ai/zen/go/v1/responses",
    needsKey: "OPENCODE_API",
    models: [
      { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3" },
    ],
  },
  openai: {
    label: "OpenAI",
    url: "https://api.openai.com/v1/responses",
    needsKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-6-luna", label: "Luna 6" },
      { id: "whisper-1", label: "Whisper 1 (transcrição)" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o Mini Transcribe" },
    ],
  },
};

const STEPS = ["judge", "final", "vision", "transcribe"];

const FACTORY = {
  judge: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  final: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  vision: { provider: "opencode", model: "muse-spark-1.3-contributor" },
  transcribe: { provider: "openai", model: "whisper-1" },
};

let mem = null;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function aiConfigCatalog() {
  // Deep copy: callers montam a visão pública (hasKey) sem mutar o módulo.
  return {
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, models: p.models.map((m) => ({ ...m })) }]),
    ),
    steps: [...STEPS],
    factory: Object.fromEntries(Object.entries(FACTORY).map(([s, v]) => [s, { ...v }])),
  };
}

function validPair(pair) {
  if (!pair || typeof pair !== "object") return null;
  const provider = String(pair.provider ?? "");
  const model = String(pair.model ?? "").slice(0, 120);
  const p = PROVIDERS[provider];
  if (!p) return null;
  // Modelo precisa estar no catálogo OU ser custom honesto (transcribe aceita qualquer id).
  const known = p.models.some((m) => m.id === model);
  if (!known && !(provider === "openai" && /^[a-z0-9][a-z0-9._:-]{1,119}$/i.test(model))) {
    return null;
  }
  return { provider, model };
}

/** Sanitiza config crua (do admin) contra o catálogo; inválido volta à fábrica. */
export function sanitizeAiConfig(raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const step of STEPS) {
    out[step] = validPair(src[step]) ?? { ...FACTORY[step] };
  }
  return out;
}

function envPair(name) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : undefined;
  } catch {
    return undefined;
  }
}

/** Config efetiva: Blob → memória → env → fábrica. Cache de 60s por instância. */
const MEM_TTL_MS = 60_000;
let memAt = 0;
export async function getAiConfig() {
  if (mem && Date.now() - memAt < MEM_TTL_MS) return mem;
  const fromEnv = sanitizeAiConfig({
    judge: envPair("IEV_JUDGE"),
    final: envPair("IEV_FINAL"),
    vision: envPair("IEV_VISION"),
    transcribe: envPair("IEV_TRANSCRIBE"),
  });
  if (!blobToken()) {
    mem = fromEnv;
    memAt = Date.now();
    return mem;
  }
  try {
    const { list } = await import("@vercel/blob");
    const tok = blobToken();
    const found = await list({ prefix: KEY, token: tok });
    const item = found.blobs.find((b) => b.pathname === KEY);
    if (!item) {
      mem = fromEnv;
      memAt = Date.now();
      return mem;
    }
    const res = await fetch(item.url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) {
      mem = fromEnv;
      memAt = Date.now();
      return mem;
    }
    mem = sanitizeAiConfig({ ...fromEnv, ...(await res.json().catch(() => ({}))) });
    memAt = Date.now();
    return mem;
  } catch {
    mem = fromEnv;
    memAt = Date.now();
    return mem;
  }
}

export async function saveAiConfig(raw) {
  const clean = sanitizeAiConfig(raw);
  mem = clean;
  memAt = Date.now();
  if (!blobToken()) return { saved: clean, persisted: false };
  const { put } = await import("@vercel/blob");
  await put(KEY, JSON.stringify({ ...clean, updatedAt: new Date().toISOString() }), {
    access: "private",
    contentType: "application/json",
    token: blobToken(),
    allowOverwrite: true,
  });
  return { saved: clean, persisted: true };
}

/** Chave de API do provedor (server-side). Null = não configurada. */
export function providerKey(provider) {
  const need = PROVIDERS[provider]?.needsKey;
  return need ? process.env[need] || null : null;
}

export function providerUrl(provider) {
  return PROVIDERS[provider]?.url ?? null;
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.label ?? provider;
}
