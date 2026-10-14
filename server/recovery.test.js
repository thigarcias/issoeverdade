import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryStore, RecoveryUnavailable } from "./recovery.js";

const envelope = (checkId) => ({ checkId, result: { outcome: "checked", claims: [] } });

test("capability isolates pending/completed/failed results without exposing input or other checks", async () => {
  const store = createRecoveryStore({ blobToken: () => "" });
  const a = await store.start("check-a");
  const b = await store.start("check-b");
  assert.match(a.recoveryToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.recoveryToken, b.recoveryToken);
  assert.deepEqual(await store.read(a.checkId, a.recoveryToken), { status: "pending" });
  assert.equal(await store.read(a.checkId), null);
  assert.equal(await store.read(a.checkId, b.recoveryToken), null);
  assert.equal(await store.read(b.checkId, a.recoveryToken), null);
  assert.equal(await store.read("../admin", a.recoveryToken), null);
  await assert.rejects(store.complete(a, envelope(b.checkId)), RecoveryUnavailable);
  await store.complete(a, envelope(a.checkId));
  await store.fail(a, { code: "delivery_error", message: "disconnected" });
  assert.deepEqual(await store.read(a.checkId, a.recoveryToken), { status: "completed", envelope: envelope(a.checkId) });
  await store.fail(b, { code: "upstream_error", message: "Execution failed" });
  assert.deepEqual(await store.read(b.checkId, b.recoveryToken), { status: "failed", error: { code: "upstream_error", message: "Execution failed" } });
});

test("expired results disappear and stalled pending checks become explicit failure", async () => {
  let time = 1000;
  const store = createRecoveryStore({ now: () => time, blobToken: () => "", ttlMs: 100, pendingMs: 20 });
  const done = await store.start("done");
  const stalled = await store.start("stalled");
  await store.complete(done, envelope(done.checkId));
  time += 20;
  const failed = await store.read(stalled.checkId, stalled.recoveryToken);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "recovery_timeout");
  assert.equal((await store.read(done.checkId, done.recoveryToken)).status, "completed");
  time += 80;
  assert.equal(await store.read(done.checkId, done.recoveryToken), null);
  assert.equal(await store.read(stalled.checkId, stalled.recoveryToken), null);
});

test("memory recovery is bounded without leaking evicted checks", async () => {
  const store = createRecoveryStore({ blobToken: () => "", maxMemory: 2 });
  const first = await store.start("first");
  const second = await store.start("second");
  const third = await store.start("third");
  assert.equal(await store.read(first.checkId, first.recoveryToken), null);
  assert.equal((await store.read(second.checkId, second.recoveryToken)).status, "pending");
  assert.equal((await store.read(third.checkId, third.recoveryToken)).status, "pending");
});

test("private persistence hashes capabilities, awaits writes and never falls back on failed Blob writes", async () => {
  const records = new Map();
  let failWrites = false;
  let pendingWrite;
  const blob = {
    async put(path, body, options) {
      assert.equal(options.access, "private");
      assert.equal(options.addRandomSuffix, false);
      assert.equal(options.cacheControlMaxAge, 0);
      if (pendingWrite) await pendingWrite;
      if (failWrites) throw new Error("storage down");
      records.set(path, body);
    },
    async list({ prefix }) { return { blobs: records.has(prefix) ? [{ pathname: prefix, url: `https://private.test/${prefix}` }] : [] }; },
  };
  const store = createRecoveryStore({ blobToken: () => "storage-secret", loadBlob: async () => blob, fetchBlob: async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer storage-secret");
    assert.equal(options.cache, "no-store");
    return new Response(records.get(new URL(url).pathname.slice(1)));
  } });
  const capability = await store.start("persisted");
  const [path, body] = records.entries().next().value;
  assert.doesNotMatch(path, /persisted|storage-secret/);
  assert.equal(path.includes(capability.recoveryToken), false);
  assert.equal(body.includes(capability.recoveryToken), false);
  let release;
  pendingWrite = new Promise((resolve) => { release = resolve; });
  let completed = false;
  const completing = store.complete(capability, envelope(capability.checkId)).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  await completing;
  assert.equal((await store.read(capability.checkId, capability.recoveryToken)).status, "completed");
  pendingWrite = null;
  failWrites = true;
  await assert.rejects(store.start("unpersisted"), RecoveryUnavailable);
  failWrites = false;
  const failing = await store.start("failing");
  failWrites = true;
  await assert.rejects(store.complete(failing, envelope(failing.checkId)), RecoveryUnavailable);
  assert.equal((await store.read(failing.checkId, failing.recoveryToken)).status, "pending");
});
