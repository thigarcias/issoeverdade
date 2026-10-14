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
  const namespace = `${PROMPT_VERSION}:media-context-v5:${config.revision}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "historical-id", tokenUsage: { total: 900 }, result: { outcome: "checked", claims: [], sources: [], summary: "Stored result" } }, namespace);
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
  const namespace = `${PROMPT_VERSION}:media-context-v5:${config.revision}:${evidence.enabled}:${evidence.reviewEnabled}:${evidence.reviewProvider}:${evidence.reviewModel}`;
  await setCached(input, { checkId: "stored-analysis", result: { outcome: "checked", verdict: "unproven", score: null, claims: [], sources: [], summary: "Análise concluída." } }, namespace);
  const events = [];
  await executeVerifyStream({
    input, guard: guard(), slot: { async release() {} },
    recoveryStore: { start: startRecovery, complete: async () => { throw new Error("storage unavailable"); }, fail: failRecovery },
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
