// Regressões dos controles de abuso/custo: modos fail-closed, limite de taxa,
// vagas com lease, orçamento diário e backend REST compatível com Redis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  LimitsExceeded,
  LimitsUnavailable,
  createGuard,
  dayKey,
  limitsConfig,
  memoryStore,
  resolveMode,
  restStore,
} from "./limits.js";

test("modo dos limites: compartilhado, memória declarada e produção sem backend", () => {
  assert.equal(resolveMode(limitsConfig({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" })), "shared");
  assert.equal(resolveMode(limitsConfig({ VERCEL_ENV: "production" })), "blocked");
  assert.equal(resolveMode(limitsConfig({})), "memory");
  assert.equal(resolveMode(limitsConfig({ IEV_LIMITS_MODE: "memory", VERCEL_ENV: "production" })), "memory");
  assert.equal(resolveMode(limitsConfig({ IEV_LIMITS_MODE: "off", VERCEL_ENV: "production" })), "off");
  assert.equal(resolveMode(limitsConfig({ KV_REST_API_URL: "https://kv", KV_REST_API_TOKEN: "t", VERCEL_ENV: "production" })), "shared");
});

test("store em memória respeita TTL e SET NX", async () => {
  const store = memoryStore();
  assert.equal(await store.incr("k"), 1);
  assert.equal(await store.incr("k"), 2);
  await store.expire("k", 1);
  assert.equal(await store.get("k"), 2);
  assert.ok((await store.ttl("k")) <= 1);
  assert.equal(await store.setNx("slot", 1, 60), true);
  assert.equal(await store.setNx("slot", 1, 60), false);
  await store.del("slot");
  assert.equal(await store.get("slot"), null);
  await store.incrBy("orçamento", 5);
  assert.equal(await store.get("orçamento"), 5);
});

/** Servidor REST mínimo compatível com o subconjunto usado por restStore. */
function fakeRedis() {
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
  const run = (command) => {
    const [name, ...args] = command.map(String);
    switch (name.toUpperCase()) {
      case "INCR": {
        const entry = alive(args[0]) ?? { value: 0, expiresAt: null };
        entry.value += 1;
        data.set(args[0], entry);
        return entry.value;
      }
      case "INCRBY": {
        const entry = alive(args[0]) ?? { value: 0, expiresAt: null };
        entry.value += Number(args[1]);
        data.set(args[0], entry);
        return entry.value;
      }
      case "EXPIRE": {
        const entry = alive(args[0]);
        if (!entry) return 0;
        if (args[2] === "NX" && entry.expiresAt) return 0;
        entry.expiresAt = Date.now() + Number(args[1]) * 1000;
        return 1;
      }
      case "SET": {
        if (args[2] === "NX" && alive(args[0])) return null;
        const ttlIndex = args.indexOf("EX");
        data.set(args[0], { value: args[1], expiresAt: ttlIndex > 0 ? Date.now() + Number(args[ttlIndex + 1]) * 1000 : null });
        return "OK";
      }
      case "DEL":
        data.delete(args[0]);
        return 1;
      case "GET": {
        const entry = alive(args[0]);
        return entry ? String(entry.value) : null;
      }
      case "TTL": {
        const entry = alive(args[0]);
        return entry?.expiresAt ? Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : -1;
      }
      default:
        return { error: `unsupported ${name}` };
    }
  };
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "[]");
      const isPipeline = Array.isArray(parsed[0]);
      const commands = isPipeline ? parsed : [parsed];
      const results = commands.map((command) => {
        const value = run(command);
        return value && typeof value === "object" && "error" in value ? value : { result: value };
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(isPipeline ? results : results[0]));
    });
  });
}

async function comRedis(fn) {
  const server = fakeRedis();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(createGuard(limitsConfig({
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${port}`,
      UPSTASH_REDIS_REST_TOKEN: "token",
      IEV_RATE_LIMIT_PER_WINDOW: "2",
      IEV_MAX_CONCURRENT_CHECKS: "1",
      IEV_SLOT_WAIT_MS: "300",
      IEV_SLOT_POLL_MS: "50",
      IEV_DAILY_CHECK_UNITS: "3",
    })));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("limite de taxa compartilhado conta por janela e devolve espera", async () => {
  await comRedis(async (guard) => {
    assert.equal(guard.mode, "shared");
    assert.equal((await guard.rateLimit("1.2.3.4")).allowed, true);
    assert.equal((await guard.rateLimit("1.2.3.4")).allowed, true);
    const terceiro = await guard.rateLimit("1.2.3.4");
    assert.equal(terceiro.allowed, false);
    assert.ok(terceiro.retryAfterSec > 0);
    assert.equal((await guard.rateLimit("5.6.7.8")).allowed, true);
  });
});

test("vagas de concorrência usam lease e liberam na saída", async () => {
  await comRedis(async (guard) => {
    const first = await guard.acquireSlot();
    await assert.rejects(() => guard.acquireSlot({ waitMs: 200, pollMs: 50 }), (error) => error instanceof LimitsExceeded && error.code === "capacity_full");
    await first.release();
    const second = await guard.acquireSlot({ waitMs: 200 });
    assert.equal(typeof second.release, "function");
    await second.release();
  });
});

test("sugestão de capacidade fica entre 1 e 30 segundos e vaga liberada é reutilizada", async () => {
  const guard = createGuard(limitsConfig({
    IEV_LIMITS_MODE: "memory",
    IEV_MAX_CONCURRENT_CHECKS: "1",
    IEV_SLOT_LEASE_SECONDS: "120",
  }));
  const held = await guard.acquireSlot();
  let retryAfterSec;
  await assert.rejects(
    () => guard.acquireSlot({ waitMs: 5, pollMs: 1 }),
    (error) => {
      assert.ok(error instanceof LimitsExceeded);
      assert.equal(error.code, "capacity_full");
      retryAfterSec = error.retryAfterSec;
      assert.ok(retryAfterSec >= 1 && retryAfterSec <= 30);
      return true;
    },
  );
  assert.equal(retryAfterSec, 30);
  await held.release();
  const reused = await guard.acquireSlot({ waitMs: 5, pollMs: 1 });
  assert.equal(reused.index, held.index);
  await assert.rejects(
    () => guard.acquireSlot({ waitMs: 5, pollMs: 1 }),
    (error) => error.code === "capacity_full",
  );
  await reused.release();
});

test("lease expira e libera a vaga mesmo sem release explícito", async () => {
  const guard = createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory", IEV_MAX_CONCURRENT_CHECKS: "1", IEV_SLOT_LEASE_SECONDS: "1", IEV_SLOT_WAIT_MS: "100" }));
  const slot = await guard.acquireSlot({ waitMs: 50 });
  await assert.rejects(() => guard.acquireSlot({ waitMs: 50 }), (error) => error.code === "capacity_full");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const depois = await guard.acquireSlot({ waitMs: 50 });
  assert.equal(typeof depois.release, "function");
  await slot.release();
});

test("orçamento diário reserva antes, recusa acima do teto e devolve a reserva", async () => {
  await comRedis(async (guard) => {
    const reserva = await guard.chargeUnits(undefined, "text");
    assert.equal(reserva.used, 1);
    assert.equal(reserva.limit, 3);
    await guard.chargeUnits(undefined, "text");
    await assert.rejects(() => guard.chargeUnits(undefined, "video"), (error) => error.code === "daily_budget");
    const depois = await guard.chargeUnits(undefined, "text");
    assert.equal(depois.used, 3);
    assert.equal(dayKey().length, 10);
  });
});

test("conciliação cobra unidades pelos tokens observados sem rejeitar a resposta", async () => {
  const guard = createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory", IEV_DAILY_CHECK_UNITS: "10", IEV_TOKENS_PER_UNIT: "100000" }));
  const leve = await guard.reconcileTokens(50_000);
  assert.equal(leve.extraUnits, 0);
  assert.equal(leve.exceeded, false);
  const pesada = await guard.reconcileTokens(329_006);
  assert.equal(pesada.extraUnits, 3);
  assert.equal(pesada.unitsUsed, 3);
  assert.equal(pesada.tokensUsed, 379_006);
  const estouro = await guard.reconcileTokens(2_000_000);
  assert.equal(estouro.extraUnits, 20);
  assert.equal(estouro.exceeded, true, "orçamento estourado é reportado, não lançado");
  assert.equal(guard.describe().tokensPerUnit, 100000);
});

test("store indisponível lança LimitsUnavailable (fail-closed no endpoint)", async () => {
  const guard = createGuard(limitsConfig({ UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1", UPSTASH_REDIS_REST_TOKEN: "t" }));
  await assert.rejects(() => guard.rateLimit("9.9.9.9"), (error) => error instanceof LimitsUnavailable);
  assert.equal(restStore(limitsConfig({})).kind, "rest");
});
