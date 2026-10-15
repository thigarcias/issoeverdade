import { test } from "node:test";
import assert from "node:assert/strict";
process.env.IEV_LIMITS_MODE = "memory";
process.env.MODERATION_MODE = "off";
process.env.BLOB_READ_WRITE_TOKEN = "";
const { executeVerifyStream, handleVerifyRecovery } = await import("./endpoint.js");
const { readRecovery, startRecovery, failRecovery } = await import("./recovery.js");
const { createGuard, limitsConfig } = await import("./limits.js");
const { setCached } = await import("./cache.js");
const { getAiConfigState } = await import("./ai-config.js");
const { evidenceConfig } = await import("./evidence.js");
const { moderationConfig, moderationPolicyFingerprint } = await import("./moderation.js");
const { PROMPT_VERSION } = await import("./scoring.js");
const { default: vercelHandler } = await import("../api/verify.js");
const { apiVerifyPlugin } = await import("../vite.api-plugin.js");

const guard = () => createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory" }));
const queryFor = (capability, extra = {}) => ({ method: "GET", headers: { "x-verify-recovery": capability.recoveryToken }, query: { checkId: capability.checkId }, guard: guard(), ...extra });

test("pending exists before acceptance; completed result survives terminal write loss and precedes final release", async () => {
  let capability;
  let pendingAtAcceptance;
  let completedAtDelivery;
  let releaseSlot;
  let releaseStarted;
  const releasing = new Promise((resolve) => { releaseStarted = resolve; });
  const held = new Promise((resolve) => { releaseSlot = resolve; });
  const events = [];
  const execution = executeVerifyStream({
    input: { kind: "text", text: "escreva um poema sobre o mar" },
    checkId: "stable-delivery-id",
    guard: guard(),
    slot: { async release() { releaseStarted(); await held; } },
    onEvent(event) {
      events.push(event);
      if (event.type === "accepted") {
        capability = { checkId: event.checkId, recoveryToken: event.recoveryToken };
        pendingAtAcceptance = readRecovery(capability.checkId, capability.recoveryToken);
      }
      if (event.type === "result") {
        completedAtDelivery = readRecovery(capability.checkId, capability.recoveryToken);
        throw new Error("socket write lost");
      }
    },
  });
  await releasing;
  try {
    assert.equal((await pendingAtAcceptance).status, "pending");
    const saved = await completedAtDelivery;
    assert.equal(saved.status, "completed");
    assert.equal(saved.envelope.checkId, capability.checkId);
    assert.equal(events.filter((event) => event.type === "result" || event.type === "error").length, 1);
    const recovered = await handleVerifyRecovery(queryFor(capability));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.envelope.checkId, "stable-delivery-id");
    assert.equal(recovered.headers["Cache-Control"], "no-store");
    assert.equal((await handleVerifyRecovery(queryFor(capability, { headers: {} }))).status, 404);
    assert.equal((await handleVerifyRecovery(queryFor(capability, { headers: { "x-verify-recovery": "x".repeat(43) } }))).status, 404);
  } finally { releaseSlot(); await execution; }
});

test("GET recovery enforces its rate bucket but bypasses POST slots, budgets and model calls", async () => {
  const capability = await startRecovery("pending-admission");
  const g = guard();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("recovery must not call a provider"); };
  try {
    g.acquireSlot = g.chargeUnits = g.reconcileTokens = async () => { assert.fail("GET spent analysis resources"); };
    let rateCalls = 0;
    g.rateLimit = async (_ip, options) => { rateCalls++; assert.equal(options.bucket, "verify-recovery"); return { allowed: true }; };
    const pending = await handleVerifyRecovery(queryFor(capability, { guard: g }));
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.body, { status: "pending" });
    await failRecovery(capability, { code: "upstream_error", message: "No result" });
    const failed = await handleVerifyRecovery(queryFor(capability, { guard: g }));
    assert.equal(failed.status, 409);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.error, "upstream_error");
    assert.equal(rateCalls, 2);
    g.rateLimit = async () => ({ allowed: false, retryAfterSec: 8 });
    const limited = await handleVerifyRecovery(queryFor(capability, { guard: g }));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["Retry-After"], "8");
  } finally { globalThis.fetch = originalFetch; }
});

test("cached historical token usage is not reconciled again by stream or recovery", async () => {
  const input = { kind: "text", text: "cached historical accounting boundary" };
  const config = await getAiConfigState();
  const evidence = evidenceConfig();
  const namespace = `${PROMPT_VERSION}:media-context-v6:${config.revision}:${moderationPolicyFingerprint(moderationConfig())}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  const policy = moderationPolicyFingerprint(moderationConfig());
  await setCached(input, { checkId: "historical-id", tokenUsage: { total: 900 }, result: { outcome: "checked", claims: [], sources: [], summary: "Stored result" } }, namespace, policy);
  const g = guard();
  g.reconcileTokens = async () => { assert.fail("historical tokens were charged twice"); };
  const events = [];
  await executeVerifyStream({ input, checkId: "cached-execution-id", guard: g, slot: { async release() {} }, onEvent: (event) => events.push(event) });
  const accepted = events.find((event) => event.type === "accepted");
  const result = events.find((event) => event.type === "result");
  assert.ok(result);
  assert.equal(result.envelope.cached, true);
  assert.equal(result.envelope.cachedFrom, "historical-id");
  assert.equal(result.envelope.checkId, accepted.checkId);
  const recovered = await handleVerifyRecovery(queryFor(accepted, { guard: g }));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.envelope.tokenUsage.total, 900);
});

function responseCapture() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end(body) { this.body = JSON.parse(body); } };
}

test("Vercel and development adapters accept GET capability recovery consistently", async () => {
  const capability = await startRecovery("adapter-recovery-id");
  const headers = { "x-verify-recovery": capability.recoveryToken };
  const vercel = responseCapture();
  await vercelHandler({ method: "GET", headers, query: { checkId: capability.checkId }, socket: {} }, vercel);
  assert.equal(vercel.statusCode, 202);
  const vercelUrl = responseCapture();
  await vercelHandler({ method: "GET", headers, url: `/api/verify?checkId=${capability.checkId}`, socket: {} }, vercelUrl);
  assert.equal(vercelUrl.statusCode, 202);
  const handlers = new Map();
  apiVerifyPlugin().configureServer({ middlewares: { use(path, handler) { handlers.set(path, handler); } } });
  const dev = responseCapture();
  await handlers.get("/api/verify")({ method: "GET", headers, url: `/?checkId=${capability.checkId}`, socket: {} }, dev);
  assert.equal(dev.statusCode, 202);
  assert.deepEqual(dev.body, vercel.body);
  assert.equal(dev.headers["Cache-Control"], "no-store");
});

test("execution failure is recorded for recovery and always releases its slot", async () => {
  const events = [];
  let released = false;
  await executeVerifyStream({
    input: { kind: "pdf", text: "invalid input never reaches a model" },
    checkId: "failed-execution-id",
    guard: guard(),
    slot: { async release() { released = true; } },
    onEvent(event) { events.push(event); },
  });
  assert.equal(released, true);
  assert.deepEqual(events.map((event) => event.type), ["accepted", "error"]);
  const state = await handleVerifyRecovery(queryFor(events[0]));
  assert.equal(state.status, 409);
  assert.equal(state.body.status, "failed");
  assert.equal(state.body.error, events[1].code);
  assert.equal(events[0].checkId, events[1].checkId);
});

test("falha ao guardar recuperação não transforma análise concluída em erro público", async () => {
  const input = { kind: "text", text: "completed analysis with recovery persistence failure" };
  const config = await getAiConfigState();
  const evidence = evidenceConfig();
  const namespace = `${PROMPT_VERSION}:media-context-v6:${config.revision}:${moderationPolicyFingerprint(moderationConfig())}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "stored-analysis", result: { outcome: "checked", verdict: "unproven", score: null, claims: [], sources: [], summary: "Análise concluída." } }, namespace, moderationPolicyFingerprint(moderationConfig()));
  const events = [];
  await executeVerifyStream({
    input, guard: guard(), slot: { async release() {} },
    recoveryStore: { start: startRecovery, complete: () => { throw new Error("storage unavailable"); }, fail: failRecovery },
    onEvent: (event) => events.push(event),
  });
  const terminal = events.filter((event) => event.type === "result" || event.type === "error");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "result");
  assert.equal(terminal[0].recoveryAvailable, false);
  const accepted = events.find((event) => event.type === "accepted");
  const recovery = await readRecovery(accepted.checkId, accepted.recoveryToken);
  assert.equal(recovery.status, "failed");
  assert.equal(recovery.error.code, "recovery_unavailable");
});

test("registro inicial de recuperação falhou: análise conclui sem capacidade fictícia", async () => {
  const input = { kind: "text", text: "análise concluída sem registro de recuperação" };
  const config = await getAiConfigState();
  const evidence = evidenceConfig();
  const policy = moderationPolicyFingerprint(moderationConfig());
  const namespace = `${PROMPT_VERSION}:media-context-v6:${config.revision}:${policy}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "stored-without-recovery", result: { outcome: "checked", verdict: "unproven", score: null, claims: [], sources: [], summary: "Análise concluída." } }, namespace, policy);
  let completionCalls = 0;
  const events = [];
  await executeVerifyStream({
    input,
    checkId: "start-failed-id",
    guard: guard(),
    slot: { async release() {} },
    recoveryStore: {
      start: async () => { throw new Error("blob unavailable"); },
      complete: async () => { completionCalls++; },
      fail: async () => { completionCalls++; },
    },
    onEvent(event) { events.push(event); },
  });
  const accepted = events.find((event) => event.type === "accepted");
  assert.equal(accepted.checkId, "start-failed-id");
  assert.equal(accepted.recoveryAvailable, false);
  assert.equal(accepted.recoveryToken, undefined, "não cria token fictício");
  const terminal = events.filter((event) => event.type === "result" || event.type === "error");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "result");
  assert.equal(terminal[0].recoveryAvailable, false);
  assert.equal(completionCalls, 0, "não chama complete/fail sem capacidade criada");
});

test("registro inicial de recuperação excede o prazo: análise segue sem esperar", async (t) => {
  const input = { kind: "text", text: "registro de recuperação que nunca responde" };
  const config = await getAiConfigState();
  const evidence = evidenceConfig();
  const policy = moderationPolicyFingerprint(moderationConfig());
  const namespace = `${PROMPT_VERSION}:media-context-v6:${config.revision}:${policy}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "stored-slow-recovery", result: { outcome: "checked", verdict: "unproven", score: null, claims: [], sources: [], summary: "Análise concluída." } }, namespace, policy);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let startCalled;
  const starting = new Promise((resolve) => { startCalled = resolve; });
  const events = [];
  const execution = executeVerifyStream({
    input,
    checkId: "start-timeout-id",
    guard: guard(),
    slot: { async release() {} },
    recoveryStartTimeoutMs: 40,
    recoveryStore: {
      start: () => { startCalled(); return new Promise(() => {}); },
      complete: async () => { throw new Error("no capacity"); },
      fail: async () => { throw new Error("no capacity"); },
    },
    onEvent(event) { events.push(event); },
  });
  await starting;
  t.mock.timers.tick(40);
  await execution;
  const accepted = events.find((event) => event.type === "accepted");
  assert.equal(accepted.recoveryAvailable, false);
  assert.equal(accepted.recoveryToken, undefined);
  const result = events.find((event) => event.type === "result");
  assert.ok(result, "resultado entregue apesar do prazo excedido");
  assert.equal(result.recoveryAvailable, false);
});

test("falha ao gravar o erro na recuperação preserva o erro primário", async (t) => {
  const input = { kind: "pdf", text: "invalid input never reaches a model" };
  const baseline = [];
  await executeVerifyStream({
    input, checkId: "primary-error-baseline", guard: guard(), slot: { async release() {} },
    onEvent(event) { baseline.push(event); },
  });
  const primary = baseline.find((event) => event.type === "error");
  assert.ok(primary);
  for (const mode of ["sync-throw", "pending"]) {
    await t.test(mode, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const events = [];
      let released = false;
      let failCalled;
      let rejectFail;
      const failing = new Promise((resolve) => { failCalled = resolve; });
      const pending = new Promise((_resolve, reject) => { rejectFail = reject; });
      const execution = executeVerifyStream({
        input, checkId: `primary-error-preserved-${mode}`, guard: guard(),
        slot: { async release() { released = true; } },
        recoverySettlementTimeoutMs: 40,
        recoveryStore: {
          start: startRecovery,
          complete: async () => { assert.fail("failed inference must not complete recovery"); },
          fail() {
            failCalled();
            if (mode === "sync-throw") throw new Error("write failed");
            return pending;
          },
        },
        onEvent(event) { events.push(event); },
      });
      await failing;
      if (mode === "pending") {
        assert.equal(released, false);
        assert.deepEqual(events.map((event) => event.type), ["accepted"]);
        t.mock.timers.tick(40);
      }
      await execution;
      assert.equal(released, true);
      assert.deepEqual(events.map((event) => event.type), ["accepted", "error"]);
      const error = events.find((event) => event.type === "error");
      assert.equal(error.code, primary.code);
      assert.equal(error.message, primary.message);
      assert.notEqual(error.code, "recovery_unavailable");
      if (mode === "pending") {
        rejectFail(new Error("late Blob failure"));
        await new Promise(setImmediate);
        assert.equal(events.filter((event) => event.type === "error").length, 1);
      }
    });
  }
});

test("pending completion expires, delivers cached result and releases without recharging usage", async (t) => {
  const input = { kind: "text", text: "cached analysis with never-settling completion" };
  const config = await getAiConfigState();
  const evidence = evidenceConfig();
  const policy = moderationPolicyFingerprint(moderationConfig());
  const namespace = `${PROMPT_VERSION}:media-context-v6:${config.revision}:${policy}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "stored-pending-completion", tokenUsage: { total: 900 }, result: { outcome: "checked", verdict: "unproven", score: null, claims: [], sources: [], summary: "Análise concluída." } }, namespace, policy);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const g = guard();
  g.reconcileTokens = async () => { assert.fail("historical cached usage must not be charged again"); };
  let completeCalled;
  let rejectComplete;
  let released = false;
  let failCalls = 0;
  const completing = new Promise((resolve) => { completeCalled = resolve; });
  const pending = new Promise((_resolve, reject) => { rejectComplete = reject; });
  const events = [];
  const execution = executeVerifyStream({
    input, checkId: "pending-completion-id", guard: g,
    slot: { async release() { released = true; } },
    recoverySettlementTimeoutMs: 40,
    recoveryStore: {
      start: startRecovery,
      complete() { completeCalled(); return pending; },
      fail() { failCalls++; return new Promise(() => {}); },
    },
    onEvent(event) { events.push(event); },
  });
  await completing;
  assert.equal(events[0].recoveryAvailable, true);
  assert.equal(typeof events[0].recoveryToken, "string");
  assert.equal(released, false);
  assert.equal(events.some((event) => event.type === "result"), false);
  t.mock.timers.tick(40);
  await execution;
  assert.equal(released, true);
  const terminal = events.filter((event) => event.type === "result" || event.type === "error");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "result");
  assert.equal(terminal[0].recoveryAvailable, false);
  assert.equal(terminal[0].envelope.cached, true);
  assert.equal(terminal[0].envelope.result.summary, "Análise concluída.");
  assert.equal(terminal[0].envelope.tokenUsage.total, 900);
  rejectComplete(new Error("late completion rejection"));
  await new Promise(setImmediate);
  assert.equal(failCalls, 0, "expired completion must not start another persistence attempt");
  assert.equal(events.filter((event) => event.type === "result" || event.type === "error").length, 1);
});

test("completion and pending fallback failure share one settlement deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completeCalled;
  let failCalled;
  let rejectComplete;
  let rejectFail;
  let released = false;
  const completing = new Promise((resolve) => { completeCalled = resolve; });
  const failing = new Promise((resolve) => { failCalled = resolve; });
  const pendingComplete = new Promise((_resolve, reject) => { rejectComplete = reject; });
  const pendingFail = new Promise((_resolve, reject) => { rejectFail = reject; });
  const events = [];
  const execution = executeVerifyStream({
    input: { kind: "text", text: "escreva um poema sobre o mar" },
    checkId: "shared-settlement-deadline", guard: guard(),
    slot: { async release() { released = true; } },
    recoverySettlementTimeoutMs: 40,
    recoveryStore: {
      start: startRecovery,
      complete() { completeCalled(); return pendingComplete; },
      fail(_capability, error) {
        assert.equal(error.code, "recovery_unavailable");
        failCalled();
        return pendingFail;
      },
    },
    onEvent(event) { events.push(event); },
  });
  await completing;
  t.mock.timers.tick(30);
  rejectComplete(new Error("completion unavailable after consuming most of the budget"));
  await failing;
  assert.equal(released, false);
  assert.equal(events.some((event) => event.type === "result"), false);
  t.mock.timers.tick(10);
  await execution;
  assert.equal(released, true);
  const terminal = events.filter((event) => event.type === "result" || event.type === "error");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "result");
  assert.equal(terminal[0].recoveryAvailable, false);
  assert.equal(terminal[0].envelope.result.outcome, "no_verifiable_claims");
  rejectFail(new Error("late fallback rejection"));
  await new Promise(setImmediate);
  assert.equal(events.filter((event) => event.type === "result" || event.type === "error").length, 1);
});
