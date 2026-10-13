// Controles de abuso e custo compartilhados entre instâncias.
// Modelo: limites de taxa por origem, vagas de concorrência com lease (sem Lua,
// usando SET NX por vaga), orçamento diário em unidades e contagem de tokens.
// Backend: REST compatível com Redis (Upstash/Vercel KV) — operações de chave
// única, atômicas por natureza. Sem backend compartilhado em produção, o
// endpoint RECUSA novas checagens (fail-closed) em vez de liberar consumo.
//
// Estados retornados por describe():
//   "shared"  → limites compartilhados ativos
//   "memory"  → limites por instância, apenas com declaração explícita ou dev
//   "blocked" → produção sem backend compartilhado: novas checagens recusadas
//   "off"     → desligado por configuração explícita (não usar em produção)

export class LimitsUnavailable extends Error {
  constructor(detail) {
    super("limits_unavailable");
    this.name = "LimitsUnavailable";
    this.code = "limits_unavailable";
    this.detail = detail;
  }
}

export class LimitsExceeded extends Error {
  constructor(code, message, retryAfterSec) {
    super(message ?? code);
    this.name = "LimitsExceeded";
    this.code = code;
    this.status = 429;
    this.retryAfterSec = retryAfterSec ?? null;
  }
}

const REST_TIMEOUT_MS = 4_000;

function intEnv(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}

function costUnitsFromEnv(value) {
  const defaults = { text: 1, link: 2, image: 2, video: 4 };
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value);
    const out = { ...defaults };
    for (const [kind, units] of Object.entries(parsed ?? {})) {
      if (Number.isFinite(Number(units)) && Number(units) > 0) out[kind] = Math.round(Number(units));
    }
    return out;
  } catch {
    return defaults;
  }
}

export function limitsConfig(env = process.env) {
  return {
    mode: env.IEV_LIMITS_MODE || "auto",
    storeUrl: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || "",
    storeToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || "",
    production: env.VERCEL_ENV === "production" || env.NODE_ENV === "production" || env.IEV_PRODUCTION === "1",
    windowSec: intEnv(env.IEV_RATE_WINDOW_SECONDS, 600),
    maxPerWindow: intEnv(env.IEV_RATE_LIMIT_PER_WINDOW, 20),
    maxConcurrent: intEnv(env.IEV_MAX_CONCURRENT_CHECKS, 3),
    slotLeaseSec: intEnv(env.IEV_SLOT_LEASE_SECONDS, 300),
    slotWaitMs: intEnv(env.IEV_SLOT_WAIT_MS, 20_000),
    slotPollMs: intEnv(env.IEV_SLOT_POLL_MS, 750),
    dailyUnits: intEnv(env.IEV_DAILY_CHECK_UNITS, 200),
    dailyTokens: intEnv(env.IEV_DAILY_TOKENS, 0),
    correctionsPerWindow: intEnv(env.IEV_CORRECTIONS_RATE_LIMIT_PER_WINDOW, 5),
    costUnits: costUnitsFromEnv(env.IEV_COST_UNITS),
  };
}

export function resolveMode(config) {
  if (config.mode === "off") return "off";
  if (config.mode === "shared") return "shared";
  if (config.mode === "memory") return "memory";
  if (config.storeUrl && config.storeToken) return "shared";
  return config.production ? "blocked" : "memory";
}

/** Backend em memória — por instância; não protege contra múltiplas réplicas. */
export function memoryStore() {
  const data = new Map();
  const alive = (key) => {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      data.delete(key);
      return null;
    }
    return entry;
  };
  return {
    kind: "memory",
    async incr(key) {
      const entry = alive(key) ?? { value: 0, expiresAt: null };
      entry.value += 1;
      data.set(key, entry);
      return entry.value;
    },
    async incrBy(key, amount) {
      const entry = alive(key) ?? { value: 0, expiresAt: null };
      entry.value += amount;
      data.set(key, entry);
      return entry.value;
    },
    async expire(key, seconds) {
      const entry = alive(key);
      if (!entry) return false;
      entry.expiresAt = Date.now() + seconds * 1000;
      return true;
    },
    async setNx(key, _value, ttlSeconds) {
      if (alive(key)) return false;
      data.set(key, { value: 1, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
      return true;
    },
    async del(key) {
      data.delete(key);
    },
    async get(key) {
      return alive(key)?.value ?? null;
    },
    async ttl(key) {
      const entry = alive(key);
      if (!entry?.expiresAt) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    },
  };
}

/** Backend REST compatível com Redis (Upstash/Vercel KV). */
export function restStore(config) {
  const endpoint = config.storeUrl.replace(/\/$/, "");
  const call = async (commands) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      const response = await fetch(commands.length === 1 ? endpoint : `${endpoint}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.storeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands.length === 1 ? commands[0] : commands),
        signal: controller.signal,
      });
      if (!response.ok) throw new LimitsUnavailable(`rest-http-${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [payload];
      const results = rows.map((row) => {
        if (row?.error) throw new LimitsUnavailable(String(row.error).slice(0, 120));
        return row?.result ?? null;
      });
      return results;
    } catch (error) {
      if (error instanceof LimitsUnavailable) throw error;
      throw new LimitsUnavailable(error?.name === "AbortError" ? "rest-timeout" : "rest-unreachable");
    } finally {
      clearTimeout(timer);
    }
  };
  const asNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return {
    kind: "rest",
    async incr(key) {
      if (!key) return null;
      const [value] = await call([["INCR", key]]);
      return asNumber(value);
    },
    async incrBy(key, amount) {
      if (!key) return null;
      const [value] = await call(["INCRBY", key, String(amount)]);
      return asNumber(value);
    },
    async expire(key, seconds) {
      if (!key) return null;
      // NX: não renova a janela de quem já tem TTL definido.
      const [value] = await call(["EXPIRE", key, String(seconds), "NX"]);
      return asNumber(value) === 1;
    },
    async setNx(key, value, ttlSeconds) {
      if (!key) return null;
      const [result] = await call(["SET", key, String(value), "NX", "EX", String(ttlSeconds)]);
      return result === "OK";
    },
    async del(key) {
      if (!key) return null;
      await call(["DEL", key]);
      return true;
    },
    async get(key) {
      if (!key) return null;
      const [value] = await call(["GET", key]);
      return value;
    },
    async ttl(key) {
      if (!key) return null;
      const [value] = await call(["TTL", key]);
      return asNumber(value);
    },
  };
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Guard ativo: resolve o modo, cria o backend e expõe as operações usadas pelo
 * endpoint. `describe()` alimenta o painel administrativo.
 */
export function createGuard(config = limitsConfig()) {
  const mode = resolveMode(config);
  const store = mode === "shared" ? restStore(config) : mode === "memory" ? memoryStore() : null;
  const prefix = "iev:limits:v1";
  return {
    mode,
    config,
    store,
    describe() {
      return {
        mode,
        shared: mode === "shared",
        store: store?.kind ?? null,
        windowSec: config.windowSec,
        maxPerWindow: config.maxPerWindow,
        maxConcurrent: config.maxConcurrent,
        slotLeaseSec: config.slotLeaseSec,
        dailyUnits: config.dailyUnits,
        dailyTokens: config.dailyTokens,
        costUnits: config.costUnits,
      };
    },
    /** Janela fixa por origem: INCR + EXPIRE NX (nunca renova a janela). */
    async rateLimit(identity, { bucket = "verify", max = config.maxPerWindow, windowSec = config.windowSec } = {}) {
      if (!store) return { allowed: true, remaining: null };
      const key = `${prefix}:rate:${bucket}:${identity}`;
      const hits = await store.incr(key);
      if (hits === null) throw new LimitsUnavailable("rate-counter");
      if (hits === 1) await store.expire(key, windowSec);
      const ttl = (await store.ttl(key)) ?? windowSec;
      if (hits > max) {
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, ttl), hits };
      }
      return { allowed: true, remaining: Math.max(0, max - hits), hits, retryAfterSec: null };
    },
    /**
     * Vaga de concorrência com lease: tenta SET NX em vagas numeradas. O total é
     * limitado pelo número de chaves de vaga, e a queda do processo libera a vaga
     * quando o lease expira.
     */
    async acquireSlot({ waitMs = config.slotWaitMs, pollMs = config.slotPollMs } = {}) {
      if (!store) return { release: async () => {}, index: null, waitedMs: 0 };
      const deadline = Date.now() + waitMs;
      let waitedMs = 0;
      for (;;) {
        for (let index = 0; index < config.maxConcurrent; index++) {
          const key = `${prefix}:slot:${index}`;
          const acquired = await store.setNx(key, Date.now(), config.slotLeaseSec);
          if (acquired) {
            return {
              index,
              waitedMs,
              release: async () => {
                await store.del(key).catch(() => {});
              },
            };
          }
        }
        waitedMs = Date.now() - (deadline - waitMs);
        if (Date.now() >= deadline) {
          throw new LimitsExceeded("capacity_full", "Capacidade de checagens simultâneas esgotada. Tente novamente em instantes.", Math.ceil(config.slotLeaseSec / 2));
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    /** Reserva unidades do dia antes de iniciar trabalho pago. */
    async chargeUnits(units, kind) {
      if (!store) return { units: units ?? 0, used: null, limit: config.dailyUnits };
      const key = `${prefix}:budget:${dayKey()}`;
      const amount = units ?? config.costUnits[kind] ?? 1;
      const used = await store.incrBy(key, amount);
      if (used === null) throw new LimitsUnavailable("budget-counter");
      if (used === amount) await store.expire(key, 2 * 24 * 3600);
      if (used > config.dailyUnits) {
        await store.incrBy(key, -amount).catch(() => {});
        throw new LimitsExceeded("daily_budget", "Orçamento diário de checagens atingido. Tente novamente amanhã.", 3600);
      }
      return { units: amount, used, limit: config.dailyUnits };
    },
    /** Tokens observados após a execução (contabilidade; teto opcional). */
    async recordTokens(tokens) {
      if (!store || !Number.isFinite(tokens) || tokens <= 0) return null;
      const key = `${prefix}:tokens:${dayKey()}`;
      const used = await store.incrBy(key, Math.round(tokens));
      if (used === Math.round(tokens)) await store.expire(key, 2 * 24 * 3600);
      return used;
    },
    async tokensToday() {
      if (!store || !config.dailyTokens) return null;
      const value = await store.get(`${prefix}:tokens:${dayKey()}`);
      return Number(value ?? 0);
    },
  };
}

let cachedGuard = null;

/** Guard do processo, reutilizado entre requisições (o backend REST é stateless). */
export function activeGuard(env = process.env) {
  const config = limitsConfig(env);
  if (!cachedGuard || cachedGuard.signature !== `${config.mode}|${config.storeUrl}|${config.maxConcurrent}|${config.dailyUnits}`) {
    cachedGuard = { signature: `${config.mode}|${config.storeUrl}|${config.maxConcurrent}|${config.dailyUnits}`, guard: createGuard(config) };
  }
  return cachedGuard.guard;
}

/** Mensagem operacional para o endpoint quando os controles não estão ativos. */
export function blockedPayload(guard) {
  return {
    error: "limits_unavailable",
    message: "Controles de abuso/custo não estão configurados nesta implantação. Configure o armazenamento compartilhado (UPSTASH_REDIS_REST_URL/TOKEN) ou defina IEV_LIMITS_MODE=memory explicitamente.",
    mode: guard?.mode ?? "blocked",
  };
}
