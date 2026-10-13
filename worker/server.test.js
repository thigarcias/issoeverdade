// Regressões do worker de mídia: autenticação obrigatória, bloqueio de destino
// interno, tetos de entrada e concorrência sinalizada.
process.env.WORKER_SECRET = "test-secret";
process.env.IEV_WORKER_CONCURRENCY = "1";
const { guardUrl, server } = await import("./server.js");

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

let base = "";

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const auth = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

test("worker recusa requisição sem Authorization", async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const semAuth = await fetch(`${base}/audio`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/x" }) });
  assert.equal(semAuth.status, 401);
  const senhaErrada = await fetch(`${base}/audio`, { method: "POST", headers: { ...auth, Authorization: "Bearer outra" }, body: JSON.stringify({ url: "https://example.com/x" }) });
  assert.equal(senhaErrada.status, 401);
});

test("worker recusa URL interna antes de chamar yt-dlp", async () => {
  const bloqueado = await fetch(`${base}/frames`, { method: "POST", headers: auth, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }) });
  const json = await bloqueado.json();
  assert.equal(json.ok, false);
  assert.match(json.reason, /^blocked:/);
  await assert.rejects(
    () => guardUrl("http://10.0.0.5/video"),
    (error) => error.code === "private_address",
  );
  await assert.rejects(
    () => guardUrl("file:///etc/passwd"),
    (error) => error.code === "bad_protocol",
  );
});

test("worker recusa URL malformada e upload fora do contrato", async () => {
  const ruim = await fetch(`${base}/fetch`, { method: "POST", headers: auth, body: JSON.stringify({ url: "não é url" }) });
  assert.equal(ruim.status, 400);
  const upload = await fetch(`${base}/upload`, { method: "POST", headers: auth, body: JSON.stringify({ file_b64: "AAAA", mime: "application/pdf" }) });
  const json = await upload.json();
  assert.equal(json.ok, false);
  assert.equal(json.reason, "unsupported-upload");
});

test("worker recusa corpo acima do limite de leitura", async () => {
  const grande = "a".repeat(80 * 1024);
  const resposta = await fetch(`${base}/fetch`, { method: "POST", headers: auth, body: JSON.stringify({ url: "https://example.com/x", padding: grande }) });
  assert.equal(resposta.status, 413);
});
