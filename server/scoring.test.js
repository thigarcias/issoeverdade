import assert from "node:assert/strict";
import test from "node:test";
import { rebuildResultSummary, validateResult, VERDICT_BANDS, verdictForScore } from "./scoring.js";

const currentPeriod = { start: "2026-10-10", end: "2026-10-12" };
const previousPeriod = { start: "2026-10-05", end: "2026-10-07" };

function evidenceFor(relation, overrides = {}) {
  return { sourceId: 0, relation, quote: "A pesquisa atual registra aumento da rejeição.", referencePeriod: currentPeriod, ...overrides };
}

function resultFor(status, evidence = [evidenceFor(status === "false" ? "refutes" : "supports")], period = currentPeriod) {
  return {
    outcome: "checked",
    claims: [{
      text: "A rejeição do candidato aumentou na rodada atual.",
      status,
      score: status === "false" ? 5 : 95,
      note: "Justificativa original da avaliação.",
      referencePeriod: period,
      sourceIds: [0],
      evidence,
    }],
    sources: [{ outlet: "Instituto", url: "https://example.com/pesquisa" }],
  };
}

function assertUnknown(result, expectedCoverage = { total: 1, assessed: 0, unproven: 1, omitted: 0 }) {
  assert.equal(result.score, null);
  assert.equal(result.verdict, "unproven");
  assert.deepEqual(result.coverage, expectedCoverage);
  for (const claim of result.claims.filter((item) => item.status === "unproven")) {
    assert.equal(claim.score, null);
  }
}

for (const [status, relation] of [["true", "supports"], ["false", "refutes"]]) {
  test(`evidência de outra rodada não sustenta classificação ${status}`, () => {
    const raw = resultFor(status, [evidenceFor(relation, { referencePeriod: previousPeriod })]);
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims[0].status, "unproven");
    assert.equal(fixed.claims[0].evidence[0].relation, "context");
    assert.notEqual(fixed.claims[0].note, raw.claims[0].note);
    assertUnknown(fixed);
  });
}

test("evidência da rodada correta preserva refutação e justificativa", () => {
  const raw = resultFor("false");
  const { fixed } = validateResult(raw);
  assert.equal(fixed.claims[0].status, "false");
  assert.equal(fixed.claims[0].score, 5);
  assert.equal(fixed.claims[0].evidenceSupport, "refutes");
  assert.equal(fixed.claims[0].note, raw.claims[0].note);
  assert.equal(fixed.score, 5);
  assert.equal(fixed.verdict, "false");
  assert.deepEqual(fixed.coverage, { total: 1, assessed: 1, unproven: 0, omitted: 0 });
});

test("segunda evidência compatível não é perdida por contexto de rodada anterior", () => {
  const { fixed } = validateResult(resultFor("true", [
    evidenceFor("supports", { referencePeriod: previousPeriod }),
    evidenceFor("supports"),
  ]));
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidenceSupport, "supports");
  assert.deepEqual(fixed.claims[0].evidence.map((item) => item.relation), ["context", "supports"]);
});

test("períodos que compartilham um dia não são disjuntos", () => {
  const { fixed } = validateResult(resultFor("true", [evidenceFor("supports", {
    referencePeriod: { start: "2026-10-07", end: currentPeriod.start },
  })]));
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidence[0].relation, "supports");
});

test("períodos inválidos permanecem desconhecidos sem fabricar conflito temporal", () => {
  const { fixed } = validateResult(resultFor("true", [evidenceFor("supports", {
    referencePeriod: { start: "2026-02-30", end: "2026-03-01" },
  })], { start: "2026-10-12", end: "2026-10-10" }));
  assert.equal(fixed.claims[0].referencePeriod, null);
  assert.equal(fixed.claims[0].evidence[0].referencePeriod, null);
  assert.equal(fixed.claims[0].status, "true");
});

for (const relation of ["supports", "refutes", "context"]) {
  test(`context aceita evidência válida ${relation} sem exigir rótulo context`, () => {
    const raw = resultFor("context", [evidenceFor(relation)]);
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims[0].status, "context");
    assert.equal(fixed.claims[0].score, 70);
    assert.equal(fixed.claims[0].evidenceSupport, relation);
    assert.equal(fixed.claims[0].note, raw.claims[0].note);
    assert.equal(fixed.score, 70);
    assert.equal(fixed.verdict, "partially_true");
  });
}

for (const [status, relation, score] of [["true", "supports", 95], ["context", "context", 70], ["false", "refutes", 5]]) {
  test(`score ${status} é canônico, não inferido da nota do modelo`, () => {
    for (const proposed of [undefined, null, "95", 0, 5, 35, 55, 70, 85, 90, 95, 100, NaN, Infinity]) {
      const raw = resultFor(status, [evidenceFor(relation)]);
      raw.claims[0].score = proposed;
      const { fixed } = validateResult(raw);
      assert.equal(fixed.claims[0].score, score);
      assert.equal(fixed.score, score);
    }
  });
}

test("múltiplas fontes não presumem independência ou condição primária", () => {
  const raw = resultFor("true", [evidenceFor("supports"), evidenceFor("supports", { sourceId: 1 })]);
  raw.sources.push({ outlet: "Outro veículo", url: "https://example.com/segunda" });
  raw.claims[0].sourceIds = [0, 1];
  const { fixed } = validateResult(raw);
  assert.equal(fixed.score, 95);
  assert.equal(fixed.claims[0].score, 95);
});

test("claim unproven não recebe score mesmo com indício vinculado", () => {
  const raw = resultFor("unproven");
  raw.claims[0].evidenceSupport = "supports";
  const { fixed } = validateResult(raw);
  assert.equal(fixed.claims[0].status, "unproven");
  assert.equal(fixed.claims[0].note, raw.claims[0].note);
  assertUnknown(fixed);
  assert.equal(fixed.claims[0].evidenceSupport, "supports");
});

for (const [status, relation] of [["true", "refutes"], ["false", "supports"], ["context", "unknown"]]) {
  test(`relação ${relation} não valida status ${status}`, () => {
    const { fixed } = validateResult(resultFor(status, [evidenceFor(relation)]));
    assert.equal(fixed.claims[0].status, "unproven");
    assertUnknown(fixed);
  });
}

test("causas estruturais diferentes produzem razões distintas, sem manter confirmação antiga", () => {
  const inputs = [
    resultFor("true", [evidenceFor("supports", { sourceId: 1 })]),
    resultFor("true", [evidenceFor("supports", { quote: "curto" })]),
    resultFor("true", [evidenceFor("refutes")]),
    resultFor("true", [evidenceFor("supports", { referencePeriod: previousPeriod })]),
    resultFor("true", []),
  ];
  inputs[0].claims[0].sourceIds = [];
  const notes = inputs.map((raw) => {
    const { fixed } = validateResult(raw);
    assertUnknown(fixed);
    assert.notEqual(fixed.claims[0].note, raw.claims[0].note);
    assert.ok(fixed.claims[0].note.length > 0);
    return fixed.claims[0].note;
  });
  assert.equal(new Set(notes).size, inputs.length);
});

for (const sourceId of [-1, 1, 0.5, "0", undefined]) {
  test(`índice inválido ${String(sourceId)} não conta como evidência`, () => {
    const { fixed } = validateResult(resultFor("true", [evidenceFor("supports", { sourceId })]));
    assertUnknown(fixed);
    assert.deepEqual(fixed.claims[0].evidence, []);
  });
}

test("fonte existente mas não vinculada ao claim não conta", () => {
  const raw = resultFor("true");
  raw.claims[0].sourceIds = [];
  const { fixed } = validateResult(raw);
  assertUnknown(fixed);
  assert.deepEqual(fixed.claims[0].evidence, []);
});

test("trecho literal exige pelo menos oito caracteres após trim", () => {
  for (const quote of [undefined, null, 12345678, "", "       ", "1234567", " 1234567 "]) {
    const { fixed } = validateResult(resultFor("true", [evidenceFor("supports", { quote })]));
    assertUnknown(fixed);
  }
  const { fixed } = validateResult(resultFor("true", [evidenceFor("supports", { quote: " 12345678 " })]));
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidence[0].quote, "12345678");
});

test("texto ausente ou status inválido não recebem pontuação", () => {
  for (const alter of [
    (claim) => { claim.text = "   "; },
    (claim) => { claim.status = "invalid"; },
  ]) {
    const raw = resultFor("true");
    alter(raw.claims[0]);
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims[0].status, "unproven");
    assertUnknown(fixed);
  }
});

for (const verification of ["unavailable", "unclear"]) {
  for (const status of ["true", "false", "context"]) {
    test(`revisão ${verification} não valida claim ${status}, nem evidência context`, () => {
      const { fixed } = validateResult(resultFor(status, [evidenceFor("context", { verification })]));
      assert.equal(fixed.claims[0].status, "unproven");
      assertUnknown(fixed);
    });
  }
}

test("revisão verified preserva relação válida e razão semântica anterior de unproven", () => {
  const { fixed: supported } = validateResult(resultFor("true", [evidenceFor("supports", { verification: "verified" })]));
  assert.equal(supported.claims[0].status, "true");
  const raw = resultFor("unproven", [evidenceFor("context", { verification: "unclear" })]);
  raw.claims[0].evidenceReviewReason = "A revisão não resolveu a correspondência entre a hipótese e o trecho.";
  const { fixed } = validateResult(raw);
  assertUnknown(fixed);
  assert.equal(fixed.claims[0].note, raw.claims[0].evidenceReviewReason);
  assert.equal(fixed.claims[0].evidenceReviewReason, raw.claims[0].evidenceReviewReason);
});

test("uma revisão indisponível não invalida outra evidência válida", () => {
  const { fixed } = validateResult(resultFor("true", [
    evidenceFor("context", { verification: "unavailable" }),
    evidenceFor("supports", { verification: "verified" }),
  ]));
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidenceSupport, "supports");
});

test("suporte agrupado respeita vínculos estruturais de TODOS os trechos", () => {
  const raw = resultFor("true", [
    evidenceFor("context", { verification: "verified" }),
    evidenceFor("context", { verification: "verified" }),
  ]);
  raw.claims[0].evidenceReview = { verdict: "supports", verification: "verified", incomplete: false, evidenceIndices: [0, 1] };
  assert.equal(validateResult(raw).fixed.claims[0].status, "true");
  for (const mutate of [
    (claim) => { claim.evidence[1].sourceId = 4; },
    (claim) => { claim.evidence[1].verification = "unavailable"; },
    (claim) => { claim.evidence[1].quote = ""; },
    (claim) => { claim.evidence[1].referencePeriod = previousPeriod; },
    (claim) => { claim.evidenceReview.incomplete = true; },
    (claim) => { claim.evidenceReview.evidenceIndices = [0, 0]; },
  ]) {
    const broken = structuredClone(raw);
    mutate(broken.claims[0]);
    assertUnknown(validateResult(broken).fixed);
  }
});

test("comparação calculada exige suporte do grupo e só então promove unproven", () => {
  const raw = resultFor("unproven", [
    evidenceFor("context", { evidenceId: "a", verification: "verified" }),
    evidenceFor("context", { evidenceId: "b", verification: "verified" }),
  ]);
  raw.claims[0].comparison = { eligible: true, relation: "supports", groups: [{ rows: [{ evidenceId: "a" }] }, { rows: [{ evidenceId: "b" }] }] };
  assertUnknown(validateResult(raw).fixed);
  raw.claims[0].evidenceReview = { verdict: "supports", verification: "verified", incomplete: false, evidenceIndices: [0, 1] };
  const fixed = validateResult(raw).fixed;
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidenceSupport, "supports");
  for (const mutate of [
    (claim) => { claim.comparison.eligible = false; },
    (claim) => { claim.comparison.relation = "refutes"; },
    (claim) => { claim.comparison.groups[1].rows[0].evidenceId = "missing"; },
    (claim) => { claim.evidenceReview.verification = "unclear"; },
  ]) {
    const broken = structuredClone(raw);
    broken.claims[0].status = "true";
    mutate(broken.claims[0]);
    assertUnknown(validateResult(broken).fixed);
  }
});

test("mistura de claim comprovado com desconhecidos nunca cria score agregado", () => {
  for (const unknownCount of [1, 3, 49]) {
    const raw = resultFor("true");
    raw.claims.push(...Array.from({ length: unknownCount }, () => resultFor("unproven", []).claims[0]));
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims[0].score, 95);
    assertUnknown(fixed, { total: unknownCount + 1, assessed: 1, unproven: unknownCount, omitted: 0 });
  }
});

test("média arredondada só é calculada com todos os claims avaliados", () => {
  const raw = resultFor("true");
  raw.claims.push(resultFor("context", [evidenceFor("supports")]).claims[0]);
  raw.notCheckedClaims = [{ text: "Acho isso bom.", reason: "Opinião" }];
  const { fixed } = validateResult(raw);
  assert.equal(fixed.score, 83);
  assert.equal(fixed.verdict, "mostly_true");
  assert.deepEqual(fixed.coverage, { total: 2, assessed: 2, unproven: 0, omitted: 0 });
  assert.deepEqual(fixed.notCheckedClaims, raw.notCheckedClaims);
});

test("claim refutado impede selo de confirmação em cobertura completa", () => {
  const raw = resultFor("true");
  raw.claims.push(resultFor("true").claims[0], resultFor("true").claims[0], resultFor("false").claims[0]);
  const { fixed } = validateResult(raw);
  assert.equal(fixed.score, 64);
  assert.equal(fixed.verdict, "distorted");
  assert.deepEqual(fixed.coverage, { total: 4, assessed: 4, unproven: 0, omitted: 0 });
  raw.claims.push(resultFor("unproven", []).claims[0]);
  assertUnknown(validateResult(raw).fixed, { total: 5, assessed: 4, unproven: 1, omitted: 0 });
});

test("limite de cinquenta claims mantém omissões separadas e revalidação coerente", () => {
  for (const count of [50, 51, 53]) {
    const raw = resultFor("true");
    raw.claims = Array.from({ length: count }, () => resultFor("true").claims[0]);
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims.length, 50);
    assert.equal(fixed.omittedClaimsCount, count - 50);
    assert.deepEqual(fixed.coverage, { total: count, assessed: 50, unproven: 0, omitted: count - 50 });
    assert.equal(fixed.outcome, count === 50 ? "checked" : "partial_coverage");
    assert.equal(fixed.score, count === 50 ? 95 : null);
    assert.equal(fixed.verdict, count === 50 ? "true" : "unproven");
    assert.deepEqual(validateResult(fixed).fixed, fixed);
  }
});

test("omissões declaradas somam-se ao limite sem duplicação na revalidação", () => {
  const raw = resultFor("true");
  raw.claims = Array.from({ length: 51 }, () => resultFor("true").claims[0]);
  raw.omittedClaimsCount = 3;
  const { fixed } = validateResult(raw);
  assertUnknown(fixed, { total: 54, assessed: 50, unproven: 0, omitted: 4 });
  assert.equal(fixed.omittedClaimsCount, 4);
  assert.equal(fixed.outcome, "partial_coverage");
  assert.deepEqual(validateResult(fixed).fixed, fixed);
});

test("partial_coverage aceito não descarta claims já avaliados", () => {
  for (const omitted of [0, 2]) {
    const raw = resultFor("true");
    raw.outcome = "partial_coverage";
    raw.omittedClaimsCount = omitted;
    const { fixed } = validateResult(raw);
    assert.equal(fixed.outcome, "partial_coverage");
    assert.equal(fixed.claims[0].status, "true");
    assertUnknown(fixed, { total: 1 + omitted, assessed: 1, unproven: 0, omitted });
    assert.deepEqual(validateResult(fixed).fixed, fixed);
  }
});

test("omissões em coverage são preservadas quando contador separado não veio", () => {
  const raw = resultFor("true");
  raw.outcome = "partial_coverage";
  raw.coverage = { total: 3, assessed: 1, unproven: 0, omitted: 2 };
  const { fixed } = validateResult(raw);
  assertUnknown(fixed, raw.coverage);
  assert.equal(fixed.omittedClaimsCount, 2);
});

test("claims todos omitidos não se tornam no_verifiable_claims", () => {
  const { fixed } = validateResult({ outcome: "checked", claims: [], omittedClaimsCount: 2 });
  assert.equal(fixed.outcome, "partial_coverage");
  assertUnknown(fixed, { total: 2, assessed: 0, unproven: 0, omitted: 2 });
  assert.equal(fixed.summary, rebuildResultSummary(fixed));
  assert.deepEqual(validateResult(fixed).fixed, fixed);
});

test("contagens inválidas não produzem cobertura fracionária ou não finita", () => {
  for (const omittedClaimsCount of [-1, 0.5, Infinity, NaN, "invalid"]) {
    const { fixed } = validateResult({ ...resultFor("true"), omittedClaimsCount });
    assert.deepEqual(fixed.coverage, { total: 1, assessed: 1, unproven: 0, omitted: 0 });
    assert.equal(fixed.score, 95);
  }
});

test("outcomes sem avaliação factual retornam cobertura vazia e nenhum score", () => {
  for (const outcome of ["insufficient_input", "inaccessible_media", "no_verifiable_claims", "content_refused", "moderation_uncovered"]) {
    const { fixed } = validateResult({ ...resultFor("true"), outcome });
    assert.equal(fixed.outcome, outcome);
    assert.equal(fixed.score, null);
    assert.equal(fixed.verdict, null);
    assert.deepEqual(fixed.claims, []);
    assert.deepEqual(fixed.coverage, { total: 0, assessed: 0, unproven: 0, omitted: 0 });
  }
  const { fixed } = validateResult({ outcome: "checked", claims: [] });
  assert.equal(fixed.outcome, "no_verifiable_claims");
  assert.equal(fixed.score, null);
});

test("síntese antiga não sobrevive a mudança de classificação ou cobertura incompleta", () => {
  const raw = resultFor("true", [evidenceFor("supports", { referencePeriod: previousPeriod })]);
  raw.summary = "O aumento da rejeição foi confirmado pela pesquisa atual.";
  const { fixed } = validateResult(raw);
  assert.notEqual(fixed.summary, raw.summary);
  assert.equal(fixed.summary, rebuildResultSummary(fixed));
  const omitted = validateResult({ ...resultFor("true"), omittedClaimsCount: 2, summary: raw.summary }).fixed;
  assert.notEqual(omitted.summary, raw.summary);
  assert.equal(omitted.summary, rebuildResultSummary(omitted));
  const unknown = validateResult({ ...resultFor("unproven", []), summary: raw.summary }).fixed;
  assert.notEqual(unknown.summary, raw.summary);
  assert.equal(unknown.summary, rebuildResultSummary(unknown));
});

test("ajuste só de nota e selo preserva síntese factual", () => {
  const raw = resultFor("true");
  raw.score = 1;
  raw.verdict = "false";
  raw.summary = "A pesquisa atual registra aumento da rejeição no mesmo universo de entrevistados.";
  const { fixed, corrections } = validateResult(raw);
  assert.equal(fixed.summary, raw.summary);
  assert.equal(fixed.verdict, "true");
  assert.equal(fixed.score, 95);
  assert.ok(corrections.length > 0);
});

test("faixas históricas preservam todos os limites numéricos", () => {
  assert.deepEqual(VERDICT_BANDS, [
    { min: 90, max: 100, verdict: "true" },
    { min: 75, max: 89, verdict: "mostly_true" },
    { min: 65, max: 74, verdict: "partially_true" },
    { min: 55, max: 64, verdict: "distorted" },
    { min: 35, max: 54, verdict: "unproven" },
    { min: 15, max: 34, verdict: "misleading" },
    { min: 0, max: 14, verdict: "false" },
  ]);
  for (const { min, max, verdict } of VERDICT_BANDS) {
    assert.equal(verdictForScore(min), verdict);
    assert.equal(verdictForScore(max), verdict);
  }
  for (const score of [null, undefined, NaN, Infinity, "85"]) assert.equal(verdictForScore(score), null);
});

test("contexto verificável não vira confirmação nem perde sua relação quando claim continua desconhecido", () => {
  const raw = resultFor("unproven", [evidenceFor("context", { verification: "verified" })]);
  const { fixed } = validateResult(raw);
  assertUnknown(fixed);
  assert.equal(fixed.claims[0].evidenceSupport, "context");
});

test("suporte e refutação no mesmo claim não são resumidos como suporte unilateral", () => {
  const raw = resultFor("unproven", [evidenceFor("supports"), evidenceFor("refutes")]);
  const { fixed } = validateResult(raw);
  assertUnknown(fixed);
  assert.equal(fixed.claims[0].evidenceSupport, "insufficient");
});

for (const status of ["true", "false", "context"]) {
  test(`relações conflitantes não mantêm classificação ${status} nem nota`, () => {
    const raw = resultFor(status, [evidenceFor("supports"), evidenceFor("refutes")]);
    const { fixed } = validateResult(raw);
    assert.equal(fixed.claims[0].status, "unproven");
    assert.equal(fixed.claims[0].evidenceSupport, "insufficient");
    assertUnknown(fixed);
  });
}

test("texto integral do claim não é truncado durante a validação", () => {
  const raw = resultFor("unproven", []);
  raw.claims[0].text = `Afirmação literal longa: ${"limite documental ".repeat(60)}sem alterar o escopo final.`;
  assert.equal(validateResult(raw).fixed.claims[0].text, raw.claims[0].text);
});
