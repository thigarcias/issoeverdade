import { test } from "node:test";
import assert from "node:assert/strict";
import { runLimited } from "./proc.js";

test("subprocesso abortado encerra antes de esgotar seu timeout", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  const start = Date.now();
  try {
    const result = await runLimited(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "aborted");
    assert.equal(result.killed, true);
    assert.ok(Date.now() - start < 5000);
  } finally {
    clearTimeout(timer);
  }
});

test("sinal já abortado não inicia o subprocesso", async () => {
  const result = await runLimited("executavel-inexistente", [], { signal: AbortSignal.abort() });
  assert.equal(result.reason, "aborted");
  assert.equal(result.killed, false);
});
