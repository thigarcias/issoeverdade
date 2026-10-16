import test from "node:test";
import assert from "node:assert/strict";
import { applyComparisons, calculateComparison, parseComparisonNumber } from "./comparison.js";
import { applyEvidenceAssessment, applyReview, buildResearchCitations, buildReviewGroups, comparisonCitations } from "./evidence.js";
import { validateResult } from "./scoring.js";

const now = new Date("2026-10-14T00:00:00Z");
function fixture(a = "20", b = "10", years = [2020, 2021]) {
  const quotes = [a, b].map((value, index) => `Dataset Atlas: área de floresta queimada no Brasil em ${years[index]}: ${value} hectares.`);
  const citations = quotes.map((quote, evidenceIndex) => ({ claimIndex: 0, evidenceIndex, evidenceId: `e${evidenceIndex + 1}`, sourceId: evidenceIndex, quote, excerpt: quote, locator: { found: true } }));
  const comparison = {
    metric: "área de floresta queimada", region: "Brasil", unit: "hectares", dataset: "Atlas", operator: "greater_than",
    groups: years.map((year, index) => ({ label: index ? "B" : "A", startYear: year, endYear: year, rows: [{ year, valueText: [a, b][index], scale: 1, evidenceId: `e${index + 1}`, complete: true }] })),
  };
  const claims = [{ text: "A teve mais área de floresta queimada que B.", status: "unproven", sourceIds: [0, 1], comparison, evidence: citations.map((item) => ({ sourceId: item.sourceId, evidenceId: item.evidenceId, quote: item.quote, relation: "supports" })) }];
  return { claims, citations, comparison };
}
const calculate = (data) => calculateComparison(data.comparison, { citations: data.citations, now });

test("soma e compara dados literais de fontes distintas, sem exigir ambos operandos em cada trecho", () => {
  const data = fixture();
  const claims = applyComparisons({ claims: data.claims, citations: data.citations, now });
  assert.deepEqual(claims[0].comparison.groups.map((group) => group.total), [20, 10]);
  assert.equal(claims[0].comparison.status, "complete");
  assert.equal(claims[0].comparison.scope, "whole_period");
  assert.equal(claims[0].comparison.relation, "supports");
  const groups = buildReviewGroups({ claims, citations: data.citations });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].snippets.length, 2);
  assert.deepEqual(groups[0].comparison, claims[0].comparison);
  const applied = applyReview({ claims, citations: data.citations, review: { claims: [{ claimIndex: 0, verdict: "supports" }] } });
  const fixed = validateResult({ outcome: "checked", claims: applied.claims, sources: [{}, {}] }).fixed;
  assert.equal(fixed.claims[0].text, data.claims[0].text);
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.score, 95);
  assert.deepEqual(fixed.claims[0].evidence.map((item) => item.relation), ["context", "context"]);
});

test("números por convenção pt-BR e separadores mistos, escala explícita documentada", () => {
  for (const [literal, number] of [["1.234,56", 1234.56], ["1,234.56", 1234.56], ["1.234.567", 1234567], ["1 234,56", 1234.56], ["2,5", 2.5], ["0", 0]]) assert.equal(parseComparisonNumber(literal), number);
  for (const literal of ["-1", "NaN", "Infinity", "1e3", "1,2,3", "1.23.456", "1 23", "0,1234567", "9007199254740992"]) assert.equal(parseComparisonNumber(literal), null);
  const data = fixture("2,5", "1.234,56");
  data.citations[0].quote = data.citations[0].excerpt = data.citations[0].quote.replace("2,5 hectares", "2,5 milhões de hectares");
  data.comparison.groups[0].rows[0].scale = 1000000;
  assert.deepEqual(calculate(data).groups.map((group) => group.total), [2500000, 1234.56]);
  data.comparison.groups[0].rows[0].scale = 1;
  assert.equal(calculate(data).status, "invalid");
  const thousand = fixture("2", "1");
  thousand.citations[0].quote = thousand.citations[0].excerpt = thousand.citations[0].quote.replace("2 hectares", "2 mil hectares");
  thousand.comparison.groups[0].rows[0].scale = 1000;
  assert.equal(calculate(thousand).groups[0].total, 2000);
});

test("a soma decimal não cria desigualdade por arredondamento binário", () => {
  const data = fixture("0,1", "0,3", [2020, 2022]);
  data.comparison.operator = "equal";
  data.comparison.groups[0].endYear = 2021;
  const quote = "Dataset Atlas: área de floresta queimada no Brasil em 2021: 0,2 hectares.";
  data.citations.push({ claimIndex: 0, evidenceIndex: 2, evidenceId: "e3", quote, excerpt: quote, locator: { found: true } });
  data.comparison.groups[0].rows.push({ year: 2021, valueText: "0,2", scale: 1, evidenceId: "e3", complete: true });
  const result = calculate(data);
  assert.equal(result.groups[0].total, 0.3);
  assert.equal(result.relation, "supports");
  assert.equal(result.scope, "shorter_recorte");
});

test("dados ausentes ou não localizados, IDs ambíguos e números não literais abstêm", () => {
  for (const mutate of [
    (data) => { data.citations.pop(); },
    (data) => { data.citations[1].locator.found = false; },
    (data) => { delete data.citations[1].locator; },
    (data) => { data.citations[1].excerpt = ""; },
    (data) => { data.citations[1].claimIndex = 1; },
    (data) => { data.citations.push({ ...data.citations[1] }); },
    (data) => { data.comparison.groups[1].rows[0].valueText = "1000"; },
    (data) => { data.comparison.groups[1].rows[0].scale = 1000; },
  ]) {
    const data = fixture(); mutate(data);
    assert.equal(calculate(data).eligible, false);
    assert.equal(calculate(data).status, "invalid");
    const claims = applyComparisons({ claims: data.claims, citations: data.citations, now });
    const reviewed = applyReview({ claims, citations: data.citations, review: { claims: [{ claimIndex: 0, verdict: "supports" }] } });
    assert.equal(validateResult({ outcome: "checked", claims: reviewed.claims, sources: [{}, {}] }).fixed.score, 45);
  }
});

test("indicador, unidade, universo, dataset e períodos incompatíveis não autorizam comparação", () => {
  for (const mutate of [
    (data) => { data.comparison.groups[1].metric = "desmatamento PRODES"; },
    (data) => { data.comparison.unit = "km²"; },
    (data) => { data.comparison.groups[1].region = "Cerrado"; },
    (data) => { data.comparison.groups[1].dataset = "PRODES"; },
    (data) => { data.comparison.groups[1].unit = "km²"; },
    (data) => { data.comparison.groups[1].rows[0].metric = "focos de incêndio"; },
    (data) => { data.comparison.groups[1].rows[0].year = 2019; },
    (data) => { data.comparison.groups[0].endYear = 2021; },
    (data) => { data.comparison.groups[0].rows.push({ ...data.comparison.groups[0].rows[0] }); },
    (data) => { data.comparison.groups[1].startYear = 2020; data.comparison.groups[1].rows[0].year = 2020; },
  ]) { const data = fixture(); mutate(data); assert.equal(calculate(data).eligible, false); }
});

test("identificadores e paráfrases não precisam ocorrer literalmente no excerpt", () => {
  const data = fixture();
  data.comparison.metric = "burned_forest_area";
  data.comparison.region = "BR";
  data.comparison.dataset = "atlas_burned_area";
  data.citations = data.citations.map((item) => ({ ...item, excerpt: item.excerpt.replace("Dataset Atlas: ", ""), quote: item.quote.replace("Dataset Atlas: ", "") }));
  const claims = applyComparisons({ claims: data.claims, citations: data.citations, now });
  assert.equal(claims[0].comparison.eligible, true);
  assert.equal(claims[0].comparison.relation, "supports");
  const reviewed = applyReview({ claims, citations: data.citations, review: { claims: [{ claimIndex: 0, verdict: "supports" }] } });
  assert.equal(validateResult({ outcome: "checked", claims: reviewed.claims, sources: [{}, {}] }).fixed.claims[0].status, "true");
  // Arithmetic cannot settle semantic scope: a documentary review that finds
  // mismatched universes/indicators always prevents a decisive result.
  const rejected = applyReview({ claims, citations: data.citations, review: { claims: [{ claimIndex: 0, verdict: "context", note: "Os dados não cobrem o mesmo universo." }] } });
  assert.equal(validateResult({ outcome: "checked", claims: rejected.claims, sources: [{}, {}] }).fixed.score, 45);
});

test("cobertura incompleta preserva subtotais, lacunas e ano atual parcial", () => {
  const data = fixture("20", "10", [2020, 2026]);
  const result = calculate(data);
  assert.equal(result.status, "partial");
  assert.equal(result.eligible, false);
  assert.deepEqual(result.groups.map((group) => group.total), [20, 10]);
  assert.equal(result.groups[1].rows[0].complete, false);
  assert.deepEqual(result.groups[1].coverage.missingYears, [2026]);
  data.comparison.groups[1].endYear = 2028;
  const futureWindow = calculate(data);
  assert.equal(futureWindow.eligible, false);
  assert.deepEqual(futureWindow.groups[1].coverage.missingYears, [2026, 2027, 2028]);
  const missing = fixture();
  missing.comparison.groups[1].rows = [];
  assert.equal(calculate(missing).status, "partial");
  assert.equal(calculate(missing).groups[1].total, 0);
});

test("limite inferior rigoroso só conclui desigualdade contra total completo", () => {
  const data = fixture("30", "20", [2026, 2020]);
  const result = calculate(data);
  assert.equal(result.status, "lower_bound");
  assert.equal(result.relation, "supports");
  assert.equal(result.groups[0].coverage.complete, false);
  data.comparison.operator = "less_than";
  assert.equal(calculate(data).relation, "refutes");
  data.comparison.operator = "equal";
  assert.equal(calculate(data).relation, "refutes");
  data.comparison.groups[1].rows[0].complete = false;
  assert.equal(calculate(data).eligible, false);
  const reverse = fixture("10", "30", [2020, 2026]);
  reverse.comparison.operator = "less_than";
  assert.equal(calculate(reverse).relation, "supports");
  const same = fixture("20", "20", [2026, 2020]);
  assert.equal(calculate(same).eligible, false);
});

test("dados futuros, negativos, não finitos e previsão numérica não viram total", () => {
  for (const [a, year] of [["-20", 2020], ["Infinity", 2020], ["20", 2027]]) {
    const data = fixture(a, "10", [year, 2021]);
    assert.equal(calculate(data).status, "invalid");
  }
});

test("separador ambíguo exige convenção da fonte e não inverte a comparação", () => {
  const data = fixture("9,001", "400");
  assert.equal(calculate(data).status, "invalid");
  data.comparison.groups[0].rows[0].numberFormat = "en-US";
  const thousands = calculate(data);
  assert.equal(thousands.groups[0].total, 9001);
  assert.equal(thousands.relation, "supports");
  data.comparison.groups[0].rows[0].numberFormat = "pt-BR";
  const decimal = calculate(data);
  assert.equal(decimal.groups[0].total, 9.001);
  assert.equal(decimal.relation, "refutes");
});

test("formato explícito não aceita agrupamento de milhares ou escala em convenção incompatível", () => {
  assert.equal(parseComparisonNumber("1.234", "pt-BR"), 1234);
  assert.equal(parseComparisonNumber("1.234", "en-US"), 1.234);
  assert.equal(parseComparisonNumber("1,234.56", "pt-BR"), null);
  assert.equal(parseComparisonNumber("1.234,56", "en-US"), null);
  assert.equal(parseComparisonNumber("1.234", "desconhecido"), null);
});

function researchComparisonFixture(a = "20", b = "10", status = "true") {
  const data = fixture(a, b);
  data.sources = [{ outlet: "Atlas", url: "https://example.test/2020" }, { outlet: "Atlas", url: "https://example.test/2021" }];
  data.claims[0].status = status;
  data.claims[0].evidence = data.claims[0].evidence.map((item) => ({
    ...item, relation: status === "false" ? "refutes" : "supports",
  }));
  data.citations = buildResearchCitations(data);
  return data;
}

function assessResearchComparison(data, citations = data.citations) {
  const claims = applyComparisons({ claims: data.claims, citations, now });
  return applyEvidenceAssessment({ claims, sources: data.sources, config: { enabled: false, maxReviewItems: 12 } }).claims[0];
}

for (const [a, b, status] of [["20", "10", "true"], ["10", "20", "false"]]) {
  test(`comparação completa ${status} funciona apenas com pesquisa citada, sem HTTP/localizador`, () => {
    const data = researchComparisonFixture(a, b, status);
    assert.ok(data.citations.every((item) => item.basis === "web_research" && item.locator === undefined));
    const claim = assessResearchComparison(data);
    assert.equal(claim.status, status);
    assert.equal(claim.comparison.eligible, true);
    assert.deepEqual(claim.comparison.groups.map((group) => group.total), [Number(a), Number(b)]);
    assert.equal(claim.assessmentBasis, "web_research");
    assert.ok(claim.evidence.every((item) => item.verification === "research"));
    assert.equal(claim.score, status === "true" ? 95 : 5);
    assert.equal(claim.evidenceReview, undefined);
  });
}

test("cálculo da pesquisa não promove abstenção nem contradiz o julgamento semântico inicial", () => {
  for (const status of ["unproven", "false", "context"]) {
    assert.equal(assessResearchComparison(researchComparisonFixture("20", "10", status)).status, "unproven");
  }
});

test("comparação de pesquisa rejeita linhas inválidas, parciais, ambíguas e conflitantes", () => {
  for (const mutate of [
    (data) => { data.claims[0].comparison.groups[1].rows[0].complete = false; },
    (data) => { data.claims[0].comparison.groups[1].endYear = 2022; },
    (data) => { data.claims[0].comparison.groups[1].rows[0].evidenceId = "ausente"; },
    (data) => { data.claims[0].comparison.groups[1].rows[0].valueText = "1000"; },
    (data) => { data.claims[0].comparison.groups[1].rows[0].scale = 1000; },
    (data) => { data.claims[0].comparison.groups[1].unit = "km²"; },
    (data) => { data.claims[0].comparison.groups[1].dataset = "Outro"; },
    (data) => { data.claims[0].comparison.groups[1].rows[0].year = 2027; },
    (data) => { data.claims[0].comparison.groups[1].rows[0].year = 2020; },
    (data) => { data.claims[0].evidence[1].quote = "O Atlas informou um total sem indicar número ou período."; },
    (data) => { data.claims[0].evidence[1].quote = data.claims[0].evidence[1].quote.replace("hectares", "pessoas"); },
    (data) => { data.claims[0].evidence.push({ ...data.claims[0].evidence[1] }); },
    (data) => { data.claims[0].evidence[1].relation = "refutes"; },
  ]) {
    const data = researchComparisonFixture(); mutate(data);
    data.citations = buildResearchCitations(data);
    assert.equal(assessResearchComparison(data).status, "unproven");
  }
});

test("linhas research exigem fonte tipada e trecho literal, sem simular localização", () => {
  for (const mutate of [
    (item) => { delete item.basis; },
    (item) => { delete item.sourceId; },
    (item) => { delete item.evidenceIndex; },
    (item) => { item.sourceId = "1"; },
    (item) => { item.excerpt = `Conteúdo independente: ${item.quote}`; },
    (item) => { item.locator = { found: false }; },
  ]) {
    const data = researchComparisonFixture(); mutate(data.citations[1]);
    assert.equal(calculate(data).eligible, false);
  }
});

test("auditoria HTTP indisponível usa operandos da pesquisa, mas incompatibilidade documental não", () => {
  const data = researchComparisonFixture();
  const unavailable = data.citations.map((item) => ({ ...item, basis: undefined, excerpt: null,
    document: { ok: false, reason: "http-403" }, locator: { found: false, kind: "document_unavailable" } }));
  assert.equal(assessResearchComparison(data, comparisonCitations(unavailable, data.citations)).status, "true");
  unavailable[1] = { ...unavailable[1], document: { ok: true }, locator: { found: false, kind: "missing" } };
  assert.equal(assessResearchComparison(data, comparisonCitations(unavailable, data.citations)).status, "unproven");
});

test("score da comparação research revalida operandos em vez de confiar em eligible informado", () => {
  const data = researchComparisonFixture();
  const claims = applyComparisons({ claims: data.claims, citations: data.citations, now });
  claims[0].assessmentBasis = "web_research";
  claims[0].evidence = claims[0].evidence.map((item) => ({ ...item, verification: "research" }));
  assert.equal(validateResult({ ...data, claims }).fixed.claims[0].status, "true");
  for (const mutate of [
    (claim) => { claim.evidence[1].verification = "unavailable"; },
    (claim) => { claim.evidence[1].quote = "Sem valor anual literal."; },
    (claim) => { claim.comparison.groups[1].rows[0].complete = false; },
    (claim) => { claim.comparison.groups[1].rows[0].valueText = "1000"; },
    (claim) => { claim.comparison.groups[1].rows[0].evidenceId = "missing"; },
    (claim) => { claim.comparison.relation = "refutes"; },
  ]) {
    const broken = structuredClone(claims); mutate(broken[0]);
    assert.equal(validateResult({ ...data, claims: broken }).fixed.claims[0].status, "unproven");
  }
});

test("totais exibidos da comparação de pesquisa são recalculados dos valores literais", () => {
  const data = researchComparisonFixture();
  const claims = applyComparisons({ claims: data.claims, citations: data.citations, now });
  claims[0].assessmentBasis = "web_research";
  claims[0].evidence = claims[0].evidence.map((item) => ({ ...item, verification: "research" }));
  claims[0].comparison.groups[0].total = 999;
  const fixed = validateResult({ ...data, claims }).fixed;
  assert.deepEqual(fixed.claims[0].comparison.groups.map((group) => group.total), [20, 10]);
  assert.match(fixed.claims[0].note, /20 hectares/);
  assert.doesNotMatch(fixed.claims[0].note, /999/);
});
