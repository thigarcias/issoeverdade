// Regressões do endpoint compartilhado: fail-closed sem controles, limite de
// taxa, vagas, orçamento, política de URL e triagem de propósito.
process.env.IEV_LIMITS_MODE = "memory";
process.env.MODERATION_MODE = "optional";
const { handleVerifyRequest } = await import("./endpoint.js");
const { createGuard, limitsConfig } = await import("./limits.js");

import { test } from "node:test";
import assert from "node:assert/strict";

const post = (body, extra = {}) => ({ method: "POST", headers: {}, body, socketAddress: "203.0.113.9", ...extra });

function guardWith(env = {}) {
  return createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory", ...env }));
}

test("produção sem backend compartilhado recusa a checagem (fail-closed)", async () => {
  const guard = createGuard(limitsConfig({ VERCEL_ENV: "production" }));
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação" }, { guard }));
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "limits_unavailable");
});

test("endpoint recusa método, tipo, entrada vazia e URL interna", async () => {
  const guard = guardWith();
  assert.equal((await handleVerifyRequest({ method: "GET", guard })).status, 405);
  assert.equal((await handleVerifyRequest(post({ kind: "pdf" }, { guard }))).status, 400);
  assert.equal((await handleVerifyRequest(post({ kind: "text", text: "" }, { guard }))).status, 400);
  const interna = await handleVerifyRequest(post({ kind: "link", text: "http://169.254.169.254/latest/meta-data/" }, { guard }));
  assert.equal(interna.status, 400);
  assert.equal(interna.body.error, "private_url");
});

test("limite de taxa por origem responde 429 com Retry-After", async () => {
  const guard = guardWith({ IEV_RATE_LIMIT_PER_WINDOW: "1" });
  const primeira = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(primeira.status, 200);
  const segunda = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(segunda.status, 429);
  assert.equal(segunda.body.error, "rate_limited");
  assert.ok(Number(segunda.headers["Retry-After"]) > 0);
  const outroIp = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard, socketAddress: "198.51.100.7" }));
  assert.equal(outroIp.status, 200);
});

test("capacidade esgotada responde 429 antes de executar a checagem", async () => {
  const guard = guardWith({ IEV_MAX_CONCURRENT_CHECKS: "1", IEV_SLOT_WAIT_MS: "150", IEV_SLOT_POLL_MS: "50" });
  const slot = await guard.acquireSlot();
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável" }, { guard }));
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "capacity_full");
  await slot.release();
});

test("orçamento diário esgotado responde 429 e não chama o modelo", async () => {
  const guard = guardWith({ IEV_DAILY_CHECK_UNITS: "1" });
  await guard.chargeUnits(undefined, "text");
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável" }, { guard }));
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "daily_budget");
});

test("moderação obrigatória indisponível é erro operacional, não recusa de conteúdo", async () => {
  const guard = guardWith();
  const anterior = process.env.MODERATION_MODE;
  const chave = process.env.OPENAI_API_KEY;
  process.env.MODERATION_MODE = "required";
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável sobre um número" }, { guard }));
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "moderation_unavailable");
    assert.doesNotMatch(JSON.stringify(out.body), /content_refused/);
  } finally {
    process.env.MODERATION_MODE = anterior ?? "optional";
    if (chave) process.env.OPENAI_API_KEY = chave;
  }
});

test("pedido direto ao assistente recebe abstenção sem chamar o modelo", async () => {
  const guard = guardWith();
  const out = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(out.status, 200);
  assert.equal(out.body.result.outcome, "no_verifiable_claims");
  assert.equal(out.body.result.verdict, null);
  assert.equal(out.body.result.score, null);
  assert.match(out.body.result.summary, /pedido direto ao assistente/);
});

test("IP confiável do proxy é usado quando configurado", async () => {
  const { clientIp } = await import("./endpoint.js");
  assert.equal(clientIp({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }, "127.0.0.1"), "1.1.1.1");
  assert.equal(clientIp({}, "127.0.0.1"), "127.0.0.1");
  assert.equal(clientIp({ "x-forwarded-for": "9.9.9.9" }, "127.0.0.1", { IEV_TRUST_PROXY: "0" }), "127.0.0.1");
});
