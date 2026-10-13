#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const VERDICTS = new Set(["true", "mostly_true", "partially_true", "distorted", "unproven", "misleading", "false", "no_verdict"]);
const CLAIM_STATUSES = new Set(["true", "false", "context", "unproven"]);
const MODALITIES = new Set(["text", "link", "image", "audio", "video"]);
const LABELS = [...VERDICTS];
const BOOTSTRAP_ITERATIONS = 1000;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function validate(record, line) {
  const prefix = `JSONL line ${line}`;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${prefix}: esperado um objeto.`);
  for (const field of ["caseId", "runId", "groupId", "methodologyVersion", "modelConfiguration"]) {
    if (typeof record[field] !== "string" || !record[field].trim()) throw new Error(`${prefix}: ${field} obrigatório.`);
  }
  if (!MODALITIES.has(record.modality)) throw new Error(`${prefix}: modality inválida.`);
  if (!Array.isArray(record.annotations) || record.annotations.length !== 2) throw new Error(`${prefix}: são exigidos exatamente dois anotadores independentes.`);
  const annotators = new Set();
  for (const annotation of record.annotations) {
    if (typeof annotation?.annotatorId !== "string" || !annotation.annotatorId || annotation.independent !== true || annotators.has(annotation.annotatorId)) {
      throw new Error(`${prefix}: annotatorId único e independent=true obrigatórios.`);
    }
    annotators.add(annotation.annotatorId);
    if (!VERDICTS.has(annotation.verdict) || !Array.isArray(annotation.claims)) throw new Error(`${prefix}: anotação humana sem verdict/claims válidos.`);
  }
  const { adjudicated, prediction } = record;
  if (!adjudicated || !prediction || !VERDICTS.has(adjudicated.verdict)) throw new Error(`${prefix}: adjudicated.verdict e prediction obrigatórios.`);
  if (prediction.verdict !== null && !VERDICTS.has(prediction.verdict)) throw new Error(`${prefix}: prediction.verdict inválido.`);
  if (!Array.isArray(adjudicated.claims) || !Array.isArray(prediction.claims)) throw new Error(`${prefix}: adjudicated.claims e prediction.claims devem ser listas.`);
  const claimIds = new Set();
  const verifiableClaimIds = new Set();
  for (const claim of adjudicated.claims) {
    if (typeof claim?.id !== "string" || !claim.id || claimIds.has(claim.id) || typeof claim.verifiable !== "boolean") {
      throw new Error(`${prefix}: cada claim adjudicado precisa de id único e verifiable booleano.`);
    }
    claimIds.add(claim.id);
    if (claim.verifiable) {
      if (!CLAIM_STATUSES.has(claim.status)) throw new Error(`${prefix}: status factual inválido no claim ${claim.id}.`);
      verifiableClaimIds.add(claim.id);
    }
  }
  const predictedClaimIds = new Set();
  for (const claim of prediction.claims) {
    if (claim?.claimId != null && !verifiableClaimIds.has(claim.claimId)) throw new Error(`${prefix}: claimId previsto sem claim verificável adjudicado.`);
    if (claim?.claimId != null) predictedClaimIds.add(claim.claimId);
    if (!CLAIM_STATUSES.has(claim?.status)) throw new Error(`${prefix}: status previsto inválido.`);
  }
  if (!Array.isArray(prediction.citations) || !Array.isArray(adjudicated.citations) || !Array.isArray(adjudicated.requiredCitations)) {
    throw new Error(`${prefix}: prediction.citations, adjudicated.citations e adjudicated.requiredCitations devem ser listas.`);
  }
  const predictedCitationIds = new Set();
  for (const citation of prediction.citations) {
    if (typeof citation?.citationId !== "string" || !citation.citationId.trim() || predictedCitationIds.has(citation.citationId) ||
      typeof citation.claimId !== "string" || !verifiableClaimIds.has(citation.claimId) || !predictedClaimIds.has(citation.claimId) ||
      !isHttpUrl(citation.url) || !["supports", "refutes", "context"].includes(citation.relation) ||
      typeof citation.quote !== "string") {
      throw new Error(`${prefix}: cada citação prevista precisa de id, claim, URL, relação e trecho válidos.`);
    }
    predictedCitationIds.add(citation.citationId);
  }
  const judgedCitationIds = new Set();
  for (const citation of adjudicated.citations) {
    if (typeof citation?.citationId !== "string" || !citation.citationId.trim() || judgedCitationIds.has(citation.citationId) ||
      !["relevant", "relationCorrect", "quoteSupported"].every((key) => typeof citation?.[key] === "boolean")) {
      throw new Error(`${prefix}: cada citação precisa de adjudicação humana completa e id único.`);
    }
    judgedCitationIds.add(citation.citationId);
  }
  if ([...predictedCitationIds].some((id) => !judgedCitationIds.has(id))) throw new Error(`${prefix}: cada citação prevista precisa de julgamento humano adjudicado.`);
  if (predictedCitationIds.size !== judgedCitationIds.size) throw new Error(`${prefix}: adjudicated.citations não pode conter julgamentos sem citação prevista.`);
  const requiredKeys = new Set();
  for (const citation of adjudicated.requiredCitations) {
    if (typeof citation?.claimId !== "string" || !verifiableClaimIds.has(citation.claimId) || !isHttpUrl(citation.url)) {
      throw new Error(`${prefix}: requiredCitations requer claim verificável adjudicado e URL HTTP(S) válida.`);
    }
    const key = sourceKey(citation.claimId, citation.url);
    if (requiredKeys.has(key)) throw new Error(`${prefix}: requiredCitations contém referências duplicadas.`);
    requiredKeys.add(key);
  }
}

function verdictOf(record, key) {
  return record[key].verdict ?? "no_verdict";
}

function confusion(records, getGold = (r) => verdictOf(r, "adjudicated"), getPrediction = (r) => verdictOf(r, "prediction")) {
  const matrix = Object.fromEntries(LABELS.map((label) => [label, Object.fromEntries(LABELS.map((column) => [column, 0]))]));
  for (const record of records) matrix[getGold(record)][getPrediction(record)] += 1;
  return matrix;
}

function macroF1(records, getGold, getPrediction, labels = LABELS) {
  if (!records.length) return null;
  const values = labels.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const record of records) {
      const gold = getGold(record);
      const prediction = getPrediction(record);
      if (gold === label && prediction === label) tp++;
      else if (gold !== label && prediction === label) fp++;
      else if (gold === label && prediction !== label) fn++;
    }
    return 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);
  }).filter((value) => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rate(records, count) {
  const { success, total } = count(records);
  return total ? success / total : null;
}

function wordTokens(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordDistance(reference, hypothesis) {
  const a = wordTokens(reference);
  const b = wordTokens(hypothesis);
  if (!a.length) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return { errors: previous[b.length], words: a.length };
}

function aggregateWordError(records, field) {
  let errors = 0;
  let words = 0;
  for (const record of records) {
    const distance = wordDistance(record.adjudicated[field], record.prediction[field]);
    if (distance) {
      errors += distance.errors;
      words += distance.words;
    }
  }
  return words ? errors / words : null;
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sourceKey(claimId, url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${claimId}\u0000${parsed.href}`;
  } catch {
    return `${claimId}\u0000${url}`;
  }
}

function citationCounts(records) {
  let relevant = 0;
  let evaluated = 0;
  let relationCorrect = 0;
  let relationEvaluated = 0;
  let quoteSupported = 0;
  let quoteEvaluated = 0;
  let retrievedRequired = 0;
  let required = 0;
  for (const record of records) {
    const judgments = new Map((record.adjudicated.citations ?? []).map((citation) => [citation.citationId, citation]));
    for (const citation of record.prediction.citations ?? []) {
      const judgment = judgments.get(citation.citationId);
      if (!judgment) continue;
      evaluated++;
      if (judgment.relevant) relevant++;
      relationEvaluated++;
      if (judgment.relationCorrect) relationCorrect++;
      quoteEvaluated++;
      if (judgment.quoteSupported) quoteSupported++;
    }
    const retrieved = new Set((record.prediction.citations ?? []).map((citation) => sourceKey(citation.claimId, citation.url)));
    for (const citation of record.adjudicated.requiredCitations ?? []) {
      required++;
      if (retrieved.has(sourceKey(citation.claimId, citation.url))) retrievedRequired++;
    }
  }
  return {
    relevancePrecision: evaluated ? relevant / evaluated : null,
    relevanceCount: evaluated,
    relationAccuracy: relationEvaluated ? relationCorrect / relationEvaluated : null,
    relationCount: relationEvaluated,
    quoteSupportPrecision: quoteEvaluated ? quoteSupported / quoteEvaluated : null,
    quoteCount: quoteEvaluated,
    requiredCitationRecall: required ? retrievedRequired / required : null,
    requiredCitationCount: required,
  };
}

function claimCounts(records) {
  let matched = 0;
  let predicted = 0;
  let required = 0;
  for (const record of records) {
    const gold = new Set(record.adjudicated.claims.filter((claim) => claim.verifiable).map((claim) => claim.id));
    const found = new Set();
    for (const claim of record.prediction.claims) {
      predicted++;
      if (claim.claimId != null && gold.has(claim.claimId)) found.add(claim.claimId);
    }
    matched += found.size;
    required += gold.size;
  }
  return {
    precision: predicted ? matched / predicted : null,
    recall: required ? matched / required : null,
    matched,
    predicted,
    required,
  };
}

function accusationCounts(records) {
  let falseAccusations = 0;
  let eligible = 0;
  for (const record of records) {
    const gold = verdictOf(record, "adjudicated");
    const prediction = verdictOf(record, "prediction");
    if (gold === "false" || gold === "misleading") continue;
    eligible++;
    if (prediction === "false" || prediction === "misleading") falseAccusations++;
  }
  return { falseAccusations, eligible, rate: eligible ? falseAccusations / eligible : null };
}

function abstentionCounts(records) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const record of records) {
    const gold = verdictOf(record, "adjudicated") === "no_verdict";
    const predicted = verdictOf(record, "prediction") === "no_verdict";
    if (gold && predicted) tp++;
    else if (!gold && predicted) fp++;
    else if (gold && !predicted) fn++;
  }
  return {
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    tp, fp, fn,
  };
}

function clusterBootstrap(records, metric, seedKey) {
  const clusters = new Map();
  for (const record of records) {
    const group = clusters.get(record.caseId) ?? [];
    group.push(record);
    clusters.set(record.caseId, group);
  }
  if (clusters.size < 2) return null;
  const groups = [...clusters.values()];
  let seed = createHash("sha256").update(seedKey).digest().readUInt32LE(0);
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const samples = [];
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration++) {
    const sample = [];
    for (let index = 0; index < groups.length; index++) sample.push(...groups[Math.floor(random() * groups.length)]);
    const value = metric(sample);
    if (Number.isFinite(value)) samples.push(value);
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return { lower95: samples[Math.floor((samples.length - 1) * 0.025)], upper95: samples[Math.ceil((samples.length - 1) * 0.975)] };
}

function metrics(records, seedKey) {
  const accuracy = (rows) => rate(rows, (items) => ({
    success: items.filter((record) => verdictOf(record, "adjudicated") === verdictOf(record, "prediction")).length,
    total: items.length,
  }));
  const claim = (rows) => claimCounts(rows);
  const citation = (rows) => citationCounts(rows);
  const accusation = (rows) => accusationCounts(rows);
  const claimStatusScore = (rows) => {
    const claimStatusRows = rows.flatMap((record) => {
      const gold = new Map(record.adjudicated.claims.filter((item) => item.verifiable).map((item) => [item.id, item.status]));
      return record.prediction.claims
        .filter((item) => item.claimId != null && gold.has(item.claimId))
        .map((item) => ({ adjudicated: { verdict: gold.get(item.claimId) }, prediction: { verdict: item.status }, caseId: record.caseId }));
    });
    return macroF1(claimStatusRows, (r) => r.adjudicated.verdict, (r) => r.prediction.verdict, [...CLAIM_STATUSES]);
  };
  const cases = new Map();
  for (const record of records) cases.set(record.caseId, true);
  const repeated = new Map();
  for (const record of records) {
    const key = `${record.methodologyVersion}\u0000${record.modelConfiguration}\u0000${record.caseId}`;
    const group = repeated.get(key) ?? [];
    group.push(record);
    repeated.set(key, group);
  }
  let stablePairs = 0;
  let matchingPairs = 0;
  for (const group of repeated.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        stablePairs++;
        if (verdictOf(group[a], "prediction") === verdictOf(group[b], "prediction")) matchingPairs++;
      }
    }
  }
  const claimData = claim(records);
  const citationData = citation(records);
  const accusationData = accusation(records);
  const abstentionData = abstentionCounts(records);
  const transcriptWer = (rows) => aggregateWordError(rows, "transcriptText");
  const ocrWer = (rows) => aggregateWordError(rows, "ocrText");
  const conf = confusion(records);
  return {
    runCount: records.length,
    uniqueCaseCount: cases.size,
    verdict: {
      accuracy: accuracy(records),
      accuracyCi95: clusterBootstrap(records, accuracy, `${seedKey}:accuracy`),
      macroF1: macroF1(records, (r) => verdictOf(r, "adjudicated"), (r) => verdictOf(r, "prediction")),
      macroF1Ci95: clusterBootstrap(records, (rows) => macroF1(rows, (r) => verdictOf(r, "adjudicated"), (r) => verdictOf(r, "prediction")), `${seedKey}:macro-f1`),
      confusion: conf,
      falsePositiveAccusationRate: accusationData.rate,
      falsePositiveAccusations: accusationData.falseAccusations,
      nonAccusatoryGoldCases: accusationData.eligible,
      falsePositiveAccusationCi95: clusterBootstrap(records, (rows) => accusation(rows).rate, `${seedKey}:false-accusation`),
    },
    abstention: {
      ...abstentionData,
      precisionCi95: clusterBootstrap(records, (rows) => abstentionCounts(rows).precision, `${seedKey}:abstention-precision`),
      recallCi95: clusterBootstrap(records, (rows) => abstentionCounts(rows).recall, `${seedKey}:abstention-recall`),
    },
    claims: {
      precision: claimData.precision,
      recall: claimData.recall,
      matched: claimData.matched,
      predicted: claimData.predicted,
      adjudicatedVerifiable: claimData.required,
      statusMacroF1: claimStatusScore(records),
      precisionCi95: clusterBootstrap(records, (rows) => claim(rows).precision, `${seedKey}:claim-precision`),
      claimRecallCi95: clusterBootstrap(records, (rows) => claim(rows).recall, `${seedKey}:claim-recall`),
      statusMacroF1Ci95: clusterBootstrap(records, claimStatusScore, `${seedKey}:claim-status-f1`),
    },
    citations: {
      ...citationData,
      relevancePrecisionCi95: clusterBootstrap(records, (rows) => citation(rows).relevancePrecision, `${seedKey}:citation-relevance`),
      relationAccuracyCi95: clusterBootstrap(records, (rows) => citation(rows).relationAccuracy, `${seedKey}:citation-relation`),
      quoteSupportPrecisionCi95: clusterBootstrap(records, (rows) => citation(rows).quoteSupportPrecision, `${seedKey}:citation-quote`),
      requiredCitationRecallCi95: clusterBootstrap(records, (rows) => citation(rows).requiredCitationRecall, `${seedKey}:citation-recall`),
    },
    media: {
      transcriptWer: transcriptWer(records),
      transcriptWerCi95: clusterBootstrap(records, transcriptWer, `${seedKey}:transcript-wer`),
      ocrWer: ocrWer(records),
      ocrWerCi95: clusterBootstrap(records, ocrWer, `${seedKey}:ocr-wer`),
    },
    stability: {
      comparablePairs: stablePairs,
      agreement: stablePairs ? matchingPairs / stablePairs : null,
    },
  };
}

function interAnnotatorAgreement(records) {
  const uniqueCases = new Map();
  for (const record of records) uniqueCases.set(record.caseId, record);
  const pairs = [...uniqueCases.values()].map((record) => [record.annotations[0].verdict, record.annotations[1].verdict]);
  if (!pairs.length) return { cases: 0, agreement: null, cohenKappa: null };
  const observed = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const labels = new Set(pairs.flat());
  const expected = [...labels].reduce((sum, label) => {
    const a = pairs.filter(([left]) => left === label).length / pairs.length;
    const b = pairs.filter(([, right]) => right === label).length / pairs.length;
    return sum + a * b;
  }, 0);
  return { cases: pairs.length, agreement: observed, cohenKappa: expected === 1 ? null : (observed - expected) / (1 - expected) };
}

async function main() {
  const path = process.argv[2];
  if (!path || path === "--help") {
    console.log("Uso: node scripts/evaluate-factual.mjs <corpus.jsonl>");
    console.log("Cada linha precisa de duas anotações humanas independentes, adjudicação, predição e mapeamento de claims/citações.");
    return;
  }
  const contents = await readFile(path, "utf8");
  const records = [];
  const runIds = new Set();
  const caseGold = new Map();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
      validate(record, index + 1);
    } catch (error) {
      throw new Error(error instanceof SyntaxError ? `JSONL line ${index + 1}: JSON inválido.` : error.message);
    }
    if (runIds.has(record.runId)) throw new Error(`JSONL line ${index + 1}: runId duplicado (${record.runId}).`);
    runIds.add(record.runId);
    const gold = JSON.stringify({
      annotations: record.annotations.map(({ annotatorId, verdict }) => ({ annotatorId, verdict })).sort((a, b) => a.annotatorId.localeCompare(b.annotatorId)),
      adjudicated: {
        verdict: record.adjudicated.verdict,
        claims: record.adjudicated.claims.map(({ id, verifiable, status }) => ({ id, verifiable, status })).sort((a, b) => a.id.localeCompare(b.id)),
        requiredCitations: record.adjudicated.requiredCitations.map(({ claimId, url }) => sourceKey(claimId, url)).sort(),
      },
    });
    if (caseGold.has(record.caseId) && caseGold.get(record.caseId) !== gold) {
      throw new Error(`JSONL line ${index + 1}: annotations/adjudicated inconsistentes para caseId ${record.caseId}.`);
    }
    caseGold.set(record.caseId, gold);
    records.push(record);
  }
  if (!records.length) throw new Error("O corpus não contém linhas avaliáveis.");

  const groups = new Map();
  for (const record of records) {
    const key = `${record.methodologyVersion}\u0000${record.modelConfiguration}\u0000${record.modality}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const results = [...groups.entries()].map(([key, rows]) => {
    const [methodologyVersion, modelConfiguration, modality] = key.split("\u0000");
    return {
      methodologyVersion,
      modelConfiguration,
      modality,
      metrics: metrics(rows, key),
      annotatorAgreement: interAnnotatorAgreement(rows),
    };
  });
  const totalUniqueCases = new Set(records.map((record) => record.caseId)).size;
  console.log(JSON.stringify({
    protocol: "iev-factual-evaluation-1",
    annotationRequirements: "2 anotadores independentes e adjudicação declarados no corpus; o harness não verifica sua autenticidade ou qualidade",
    runCount: records.length,
    uniqueCaseCount: totalUniqueCases,
    uniqueGroupCount: new Set(records.map((record) => record.groupId)).size,
    minimumUniqueCasesRecommended: 200,
    minimumUniqueCaseCountMet: totalUniqueCases >= 200,
    benchmarkReadiness: "not_assessed_by_harness",
    confidenceIntervals: "bootstrap percentile de 95%, 1000 amostras, reprodutível e agrupado por caseId; null quando há menos de dois casos distintos",
    results,
    limitation: "A validade depende da composição do corpus, independência real dos anotadores, qualidade da adjudicação e protocolo. O harness valida apenas estrutura; 200 casos são um limiar inicial de corpus, não prova de representatividade ou precisão.",
  }, null, 2));
}

main().catch((error) => fail(error?.message ?? String(error)));
