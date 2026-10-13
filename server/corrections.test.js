// Regressões do canal de correções: validação do pedido, modo fail-closed sem
// armazenamento durável, protocolo, histórico e visão pública sem contato.
process.env.IEV_LIMITS_MODE = "memory";
const {
  CORRECTION_STATUSES,
  correctionsMode,
  createCorrection,
  getCorrection,
  normalizeCorrection,
  publicCorrection,
  updateCorrection,
} = await import("./corrections.js");
const { handleCorrectionsRequest } = await import("./corrections-endpoint.js");
const { createGuard, limitsConfig } = await import("./limits.js");

import { test } from "node:test";
import assert from "node:assert/strict";

const validBody = (extra = {}) => ({
  message: "O trecho citado pertence a outra rodada da pesquisa e o número não corresponde ao período indicado.",
  checkId: "mv6y75tx-3qqrxr",
  ...extra,
});

test("validação do pedido recusa curto, longo, id e URL inválidos", () => {
  assert.equal(normalizeCorrection({ message: "curto" }).error, "message_too_short");
  assert.equal(normalizeCorrection({ message: "a".repeat(4001) }).error, "message_too_long");
  assert.equal(normalizeCorrection(validBody({ checkId: "id com espaço" })).error, "bad_check_id");
  assert.equal(normalizeCorrection(validBody({ evidenceUrl: "ftp://exemplo.com/x" })).error, "bad_evidence_url");
  const ok = normalizeCorrection(validBody({ contact: "  pessoa@exemplo.com  ", kind: "right_of_reply" }));
  assert.equal(ok.ok, true);
  assert.match(ok.value.protocol, /^corr-/);
  assert.equal(ok.value.contact, "pessoa@exemplo.com");
  assert.equal(ok.value.kind, "right_of_reply");
  assert.equal(normalizeCorrection(validBody({ kind: "inventado" })).value.kind, "correction");
});

test("produção sem armazenamento durável recusa o canal", () => {
  assert.equal(correctionsMode({ VERCEL_ENV: "production" }), "blocked");
  assert.equal(correctionsMode({}), "memory");
});

test("protocolo é criado, consultado e atualizado com histórico", async () => {
  const created = await createCorrection(normalizeCorrection(validBody()).value);
  assert.equal(created.status, "received");
  assert.equal(created.persisted, false, "sem Blob, o registro é apenas local");
  const found = await getCorrection(created.protocol);
  assert.equal(found.checkId, "mv6y75tx-3qqrxr");
  const publico = publicCorrection(found);
  assert.equal(publico.contact, undefined);
  assert.equal(publico.statusLabel, "Recebido");
  const updated = await updateCorrection(created.protocol, { status: "in_review", note: "triagem inicial", actor: "editor" });
  assert.equal(updated.ok, true);
  assert.equal(updated.record.status, "in_review");
  assert.equal(updated.record.history.length, 2);
  const invalido = await updateCorrection(created.protocol, { status: "inventado" });
  assert.equal(invalido.error, "bad_status");
  const inexistente = await updateCorrection("corr-nao-existe", { status: "in_review" });
  assert.equal(inexistente.error, "not_found");
  assert.ok(CORRECTION_STATUSES.some((status) => status.id === "corrected"));
});

test("endpoint público cria protocolo e recusa limite, armadilha e produção sem storage", async () => {
  const guard = createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory", IEV_CORRECTIONS_RATE_LIMIT_PER_WINDOW: "1" }));
  const criado = await handleCorrectionsRequest({
    method: "POST",
    headers: {},
    body: validBody(),
    socketAddress: "203.0.113.10",
    guard,
    env: {},
  });
  assert.equal(criado.status, 201);
  assert.match(criado.body.protocol, /^corr-/);
  assert.equal(criado.body.persisted, false);

  const limitado = await handleCorrectionsRequest({
    method: "POST",
    headers: {},
    body: validBody(),
    socketAddress: "203.0.113.10",
    guard,
    env: {},
  });
  assert.equal(limitado.status, 429);
  assert.ok(Number(limitado.headers["Retry-After"]) > 0);

  const armadilha = await handleCorrectionsRequest({
    method: "POST",
    headers: {},
    body: validBody({ website: "http://spam.example" }),
    socketAddress: "203.0.113.11",
    guard,
    env: {},
  });
  assert.equal(armadilha.status, 400);

  const prod = await handleCorrectionsRequest({
    method: "POST",
    headers: {},
    body: validBody(),
    socketAddress: "203.0.113.12",
    guard,
    env: { VERCEL_ENV: "production" },
  });
  assert.equal(prod.status, 503);
  assert.equal(prod.body.error, "corrections_unavailable");
});

test("consulta pública exige protocolo existente", async () => {
  const guard = createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory" }));
  const semProtocolo = await handleCorrectionsRequest({ method: "GET", headers: {}, query: {}, guard, env: {} });
  assert.equal(semProtocolo.status, 400);
  const criado = await handleCorrectionsRequest({ method: "POST", headers: {}, body: validBody(), socketAddress: "203.0.113.20", guard, env: {} });
  const consulta = await handleCorrectionsRequest({ method: "GET", headers: {}, query: { protocol: criado.body.protocol }, guard, env: {} });
  assert.equal(consulta.status, 200);
  assert.equal(consulta.body.correction.status, "received");
  const inexistente = await handleCorrectionsRequest({ method: "GET", headers: {}, query: { protocol: "corr-nada" }, guard, env: {} });
  assert.equal(inexistente.status, 404);
});

test("link do card consulta o estado por checagem sem expor contato nem mensagem", async () => {
  const guard = createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory" }));
  const criado = await handleCorrectionsRequest({
    method: "POST",
    headers: {},
    body: validBody({ checkId: "mv-card-123", contact: "leitor@example.org" }),
    socketAddress: "203.0.113.30",
    guard,
    env: {},
  });
  assert.equal(criado.status, 201);
  const porChecagem = await handleCorrectionsRequest({ method: "GET", headers: {}, query: { checkId: "mv-card-123" }, guard, env: {} });
  assert.equal(porChecagem.status, 200);
  assert.equal(porChecagem.body.correctedAt, null);
  assert.equal(porChecagem.body.corrections.length, 1);
  assert.equal(porChecagem.body.corrections[0].status, "received");
  const serializado = JSON.stringify(porChecagem.body);
  assert.doesNotMatch(serializado, /leitor@example\.org|pertence a outra rodada|@example/);
  const idInvalido = await handleCorrectionsRequest({ method: "GET", headers: {}, query: { checkId: "id com espaço" }, guard, env: {} });
  assert.equal(idInvalido.status, 400);
  const semContestacao = await handleCorrectionsRequest({ method: "GET", headers: {}, query: { checkId: "mv-sem-nada" }, guard, env: {} });
  assert.equal(semContestacao.status, 200);
  assert.deepEqual(semContestacao.body.corrections, []);
  assert.equal(semContestacao.body.correctedAt, null);
});
