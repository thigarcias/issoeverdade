import { test } from "node:test";
import assert from "node:assert/strict";
import { getCached, setCached } from "./cache.js";

async function withoutExternalStorage(fn) {
  const old = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try { await fn(); } finally {
    if (old === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = old;
  }
}

test("indisponibilidade documental ou revisão inconclusiva não congela abstenção no cache", async () => {
  await withoutExternalStorage(async () => {
    for (const verification of ["unavailable", "unclear", undefined]) {
      const input = { kind: "text", text: `Cache limitação ${verification}` };
      const namespace = "cache-limitation-regression";
      await setCached(input, { checkId: "old", result: { claims: [{ status: "true" }] } }, namespace);
      assert.equal((await getCached(input, namespace)).checkId, "old");
      await setCached(input, { result: { claims: [{ status: "unproven", evidenceReview: { verification } }] } }, namespace);
      assert.equal(await getCached(input, namespace), null);
    }
  });
});

test("conclusão documental e insuficiência semântica revisada continuam reutilizáveis", async () => {
  await withoutExternalStorage(async () => {
    for (const status of ["true", "false", "unproven"]) {
      const input = { kind: "text", text: `Cache conclusão ${status}` };
      const value = { checkId: status, result: { claims: [{ status, evidenceReview: { verification: "verified", verdict: status === "unproven" ? "context" : "supports" } }] } };
      await setCached(input, value, "cache-conclusion-regression");
      const restored = await getCached(input, "cache-conclusion-regression");
      assert.equal(restored.checkId, status);
      assert.equal(restored.result.claims[0].status, status);
    }
  });
});
