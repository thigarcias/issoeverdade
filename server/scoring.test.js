import assert from "node:assert/strict";
import test from "node:test";
import { validateResult } from "./scoring.js";

const currentPeriod = { start: "2026-10-10", end: "2026-10-12" };
const previousPeriod = { start: "2026-10-05", end: "2026-10-07" };

function resultFor(status, evidence, period = currentPeriod) {
  return {
    outcome: "checked",
    claims: [{
      text: "A rejeição do candidato aumentou na rodada atual.",
      status,
      score: status === "false" ? 20 : 95,
      note: status === "false" ? "Refutado pela pesquisa." : "Confirmado pela pesquisa.",
      referencePeriod: period,
      sourceIds: [0],
      evidence,
    }],
    sources: [{ outlet: "Instituto", url: "https://example.com/pesquisa" }],
  };
}

for (const [status, relation] of [["true", "supports"], ["false", "refutes"]]) {
  test(`evidência de outra rodada não sustenta classificação ${status}`, () => {
    const { fixed } = validateResult(resultFor(status, [{
      sourceId: 0, relation, quote: "Rejeição na rodada anterior: 43%.", referencePeriod: previousPeriod,
    }]));
    assert.equal(fixed.claims[0].status, "unproven");
    assert.equal(fixed.claims[0].evidence[0].relation, "context");
    assert.equal(fixed.verdict, "unproven");
    assert.match(fixed.claims[0].note, /Não foi possível confirmar nem refutar/);
    assert.doesNotMatch(fixed.claims[0].note, /Confirmado pela pesquisa|Refutado pela pesquisa/);
  });
}

test("evidência da rodada correta preserva refutação", () => {
  const { fixed } = validateResult(resultFor("false", [{
    sourceId: 0, relation: "refutes", quote: "A rejeição permaneceu estável na rodada atual.", referencePeriod: currentPeriod,
  }]));
  assert.equal(fixed.claims[0].status, "false");
  assert.equal(fixed.claims[0].score, 20);
  assert.equal(fixed.claims[0].note, "Refutado pela pesquisa.");
});

test("vínculo inexistente não mantém alegação de confirmação", () => {
  const { fixed } = validateResult(resultFor("true", [{
    sourceId: 1, relation: "supports", quote: "Trecho de uma fonte que foi descartada.", referencePeriod: currentPeriod,
  }]));
  assert.equal(fixed.claims[0].status, "unproven");
  assert.equal(fixed.claims[0].score, 35);
  assert.deepEqual(fixed.claims[0].evidence, []);
  assert.doesNotMatch(fixed.claims[0].note, /Confirmado pela pesquisa/);
});

test("segunda evidência compatível não é perdida por contexto de rodada anterior", () => {
  const { fixed } = validateResult(resultFor("true", [
    { sourceId: 0, relation: "supports", quote: "Rejeição na rodada anterior: 43%.", referencePeriod: previousPeriod },
    { sourceId: 0, relation: "supports", quote: "Rejeição na rodada atual: 44%.", referencePeriod: currentPeriod },
  ]));
  assert.equal(fixed.claims[0].status, "true");
  assert.deepEqual(fixed.claims[0].evidence.map((item) => item.relation), ["context", "supports"]);
});

test("síntese antiga não sobrevive a mudança de classificação por período", () => {
  const raw = resultFor("true", [{
    sourceId: 0, relation: "supports", quote: "Rejeição na rodada anterior: 43%.", referencePeriod: previousPeriod,
  }]);
  raw.summary = "O aumento da rejeição foi confirmado pela pesquisa atual.";
  const { fixed } = validateResult(raw);
  assert.equal(fixed.claims[0].status, "unproven");
  assert.ok(fixed.summary.length > 0);
  assert.ok(!fixed.summary.includes(raw.summary));
  assert.match(fixed.summary, /A rejeição do candidato aumentou/);
  assert.ok(fixed.summary.includes(currentPeriod.start));
  assert.ok(fixed.summary.includes(currentPeriod.end));
});

test("ajuste só de nota e selo preserva síntese factual", () => {
  const raw = resultFor("true", [{
    sourceId: 0, relation: "supports", quote: "A pesquisa atual registra aumento da rejeição.", referencePeriod: currentPeriod,
  }]);
  raw.score = 1;
  raw.verdict = "false";
  raw.summary = "A pesquisa atual registra aumento da rejeição no mesmo universo de entrevistados.";
  const { fixed, corrections } = validateResult(raw);
  assert.match(fixed.summary, /mesmo universo de entrevistados/);
  assert.equal(fixed.verdict, "true");
  assert.equal(fixed.score, 95);
  assert.ok(corrections.length > 0);
});

