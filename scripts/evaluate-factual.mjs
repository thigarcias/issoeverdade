#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const VERDICTS = new Set(["true", "mostly_true", "partially_true", "distorted", "unproven", "misleading", "false", "no_verdict"]);
const CLAIM_STATUSES = new Set(["true", "false", "context", "unproven"]);
const MODALITIES = new Set(["text", "link", "image", "audio", "video"]);
const SPLITS = new Set(["dev", "eval"]);
const LABELS = [...VERDICTS];
const BOOTSTRAP_ITERATIONS = 1000;
const MIN_SAMPLE_PER_STRATUM = 10;
const PUBLICATION_WARNING = "Nenhuma métrica deste relatório deve ser publicada isoladamente: todo número precisa vir acompanhado do recorte (modalidade, categoria, split), do n, do intervalo de incerteza e do aviso de amostra insuficiente (n < 10). Um resultado global pode esconder falha em vídeo, em uma categoria ou em um tipo de alegação.";
const COMMENT_PREFIX = "#";

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
  for (const field of ["eventId", "category"]) {
    if (record[field] != null && (typeof record[field] !== "string" || !record[field].trim())) {
      throw new Error(`${prefix}: ${field}, quando presente, precisa ser texto não vazio.`);
    }
  }
  if (record.split != null && !SPLITS.has(record.split)) throw new Error(`${prefix}: split, quando presente, precisa ser "dev" ou "eval".`);
  for (const field of ["annotatorA", "annotatorB"]) {
    const named = record[field];
    if (named == null) continue;
    if (typeof named !== "object" || Array.isArray(named) || typeof named.annotatorId !== "string" || !named.annotatorId.trim()) {
      throw new Error(`${prefix}: ${field}, quando presente, precisa de annotatorId; use apenas {annotatorId} para referenciar annotations.`);
    }
    const isComplete = named.verdict != null || named.claims != null;
    if (isComplete && (!VERDICTS.has(named.verdict) || !Array.isArray(named.claims))) {
      throw new Error(`${prefix}: ${field} completo precisa de verdict válido e claims (ou apenas {annotatorId} para referenciar annotations).`);
    }
  }
  if ((record.annotatorA == null) !== (record.annotatorB == null)) throw new Error(`${prefix}: annotatorA e annotatorB precisam ser informados juntos.`);
  if (record.annotatorA && Array.isArray(record.annotations) && record.annotations.length === 2) {
    for (const field of ["annotatorA", "annotatorB"]) {
      if (record[field].verdict == null) continue;
      const listed = record.annotations.find((item) => item?.annotatorId === record[field].annotatorId);
      if (!listed) throw new Error(`${prefix}: ${field} referencia annotatorId ausente em annotations.`);
      if (annotationSignature(record[field]) !== annotationSignature(listed)) throw new Error(`${prefix}: ${field} divergente da anotação correspondente em annotations.`);
    }
  }
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

function annotationSignature(annotation) {
  return JSON.stringify({
    annotatorId: annotation.annotatorId,
    verdict: annotation.verdict,
    claims: (annotation.claims ?? [])
      .map((claim) => ({ id: claim?.id ?? null, verifiable: claim?.verifiable ?? null, status: claim?.status ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
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
  const cases = [...uniqueCases.values()];
  const pairs = cases.map((record) => [record.annotations[0].verdict, record.annotations[1].verdict]);
  let claimStatusShared = 0;
  let claimStatusMatches = 0;
  for (const record of cases) {
    const [left, right] = record.annotations;
    const rightStatuses = new Map(
      (right.claims ?? [])
        .filter((claim) => typeof claim?.id === "string" && CLAIM_STATUSES.has(claim.status))
        .map((claim) => [claim.id, claim.status]),
    );
    for (const claim of left.claims ?? []) {
      if (typeof claim?.id !== "string" || !CLAIM_STATUSES.has(claim.status) || !rightStatuses.has(claim.id)) continue;
      claimStatusShared++;
      if (rightStatuses.get(claim.id) === claim.status) claimStatusMatches++;
    }
  }
  const claimStatusAgreement = claimStatusShared ? claimStatusMatches / claimStatusShared : null;
  const claimStatus = {
    claimStatusShared,
    claimStatusAgreement,
    claimStatusGate90: claimStatusAgreement == null ? null : claimStatusAgreement >= 0.9,
    claimStatusInsufficientSample: claimStatusShared < MIN_SAMPLE_PER_STRATUM,
  };
  if (!pairs.length) return { cases: 0, agreement: null, cohenKappa: null, ...claimStatus };
  const observed = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const labels = new Set(pairs.flat());
  const expected = [...labels].reduce((sum, label) => {
    const a = pairs.filter(([left]) => left === label).length / pairs.length;
    const b = pairs.filter(([, right]) => right === label).length / pairs.length;
    return sum + a * b;
  }, 0);
  return {
    cases: pairs.length,
    agreement: observed,
    cohenKappa: expected === 1 ? null : (observed - expected) / (1 - expected),
    ...claimStatus,
    note: "acordo e kappa de veredito por caso único; o acordo de status factual considera apenas claims presentes nas duas anotações; kappa é nulo quando a concordância esperada é 1",
  };
}

function stratumRow(label, rows) {
  const uniqueCases = new Set(rows.map((record) => record.caseId));
  const abstained = rows.filter((record) => verdictOf(record, "prediction") === "no_verdict").length;
  const goldAbstained = rows.filter((record) => verdictOf(record, "adjudicated") === "no_verdict").length;
  const correct = rows.filter((record) => verdictOf(record, "adjudicated") === verdictOf(record, "prediction")).length;
  const claims = claimCounts(rows);
  const citations = citationCounts(rows);
  return {
    label,
    runCount: rows.length,
    uniqueCaseCount: uniqueCases.size,
    verdictCoverage: rows.length ? (rows.length - abstained) / rows.length : null,
    abstentionRate: rows.length ? abstained / rows.length : null,
    goldAbstentionRate: rows.length ? goldAbstained / rows.length : null,
    verdictAccuracy: rows.length ? correct / rows.length : null,
    verdictMacroF1: macroF1(rows, (record) => verdictOf(record, "adjudicated"), (record) => verdictOf(record, "prediction")),
    claimPrecision: claims.precision,
    claimRecall: claims.recall,
    requiredCitationRecall: citations.requiredCitationRecall,
    transcriptWer: aggregateWordError(rows, "transcriptText"),
    ocrWer: aggregateWordError(rows, "ocrText"),
    insufficientSample: rows.length < MIN_SAMPLE_PER_STRATUM,
    note: "cobertura de veredito, abstenção, precisão e revocação no mesmo recorte; recorte com amostra insuficiente não pode ser anunciado como validado",
  };
}

function strata(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const label = keyOf(record);
    const group = groups.get(label) ?? [];
    group.push(record);
    groups.set(label, group);
  }
  return [...groups.entries()]
    .map(([label, rows]) => stratumRow(label, rows))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

function number(value, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/d";
}

function renderTable(headers, rows) {
  const cells = rows.map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((header, index) => Math.max(header.length, ...cells.map((cell) => cell[index]?.length ?? 0)));
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join("  ").replace(/\s+$/, "");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
}

function stratumTable(title, rows, labelHeader) {
  const headers = [labelHeader, "n", "casos", "cob_veredito", "abstencao", "abst_gabarito", "acuracia", "macro_f1", "amostra_insuficiente"];
  const body = rows.map((row) => [
    row.label,
    String(row.runCount),
    String(row.uniqueCaseCount),
    number(row.verdictCoverage),
    number(row.abstentionRate),
    number(row.goldAbstentionRate),
    number(row.verdictAccuracy),
    number(row.verdictMacroF1),
    row.insufficientSample ? `SIM (n < ${MIN_SAMPLE_PER_STRATUM})` : "nao",
  ]);
  return [
    `-- ${title} --`,
    renderTable(headers, body),
    `n = execuções no recorte; casos = caseId únicos; cob_veredito = fração de execuções com veredito emitido; abstencao = fração sem veredito do modelo; abst_gabarito = fração do gabarito sem veredito; frações em decimal (0–1).`,
    "",
  ].join("\n");
}

function splitSummary(records) {
  const runsPerSplit = { dev: 0, eval: 0 };
  const eventsPerSplit = { dev: new Set(), eval: new Set() };
  const eventSplits = new Map();
  let missingSplit = 0;
  let missingEventId = 0;
  for (const record of records) {
    const hasSplit = SPLITS.has(record.split);
    const hasEventId = typeof record.eventId === "string" && Boolean(record.eventId.trim());
    if (!hasSplit) missingSplit++;
    if (!hasEventId) missingEventId++;
    if (hasSplit) runsPerSplit[record.split]++;
    if (hasSplit && hasEventId) {
      eventsPerSplit[record.split].add(record.eventId);
      const splits = eventSplits.get(record.eventId) ?? new Set();
      splits.add(record.split);
      eventSplits.set(record.eventId, splits);
    }
  }
  const leakedEventIds = [...eventSplits.entries()].filter(([, splits]) => splits.size > 1).map(([eventId]) => eventId).sort();
  return {
    runsPerSplit,
    eventsPerSplit: { dev: eventsPerSplit.dev.size, eval: eventsPerSplit.eval.size },
    eventCount: eventSplits.size,
    missingSplit,
    missingEventId,
    leakedEventIds,
    leakCheck: leakedEventIds.length ? "vazamento_entre_dev_e_eval" : "sem_evento_repetido_entre_dev_e_eval",
  };
}

function checkSplit(records, path) {
  const summary = splitSummary(records);
  const uniqueCases = new Set(records.map((record) => record.caseId)).size;
  const issues = [];
  if (summary.missingSplit) issues.push(`${summary.missingSplit} execução(ões) sem campo "split" válido ("dev"|"eval").`);
  if (summary.missingEventId) issues.push(`${summary.missingEventId} execução(ões) sem "eventId" (sem ele não dá para verificar separação por evento).`);
  if (summary.leakedEventIds.length) issues.push(`vazamento de evento: ${summary.leakedEventIds.length} eventId(s) aparecem em dev e eval: ${summary.leakedEventIds.join(", ")}.`);
  console.log("-- Verificação de split (--check-split) --");
  console.log(`Corpus: ${path}`);
  console.log(`Execuções: ${records.length} | casos únicos: ${uniqueCases} | eventos com eventId: ${summary.eventCount}`);
  console.log(`Execuções por split: dev=${summary.runsPerSplit.dev}, eval=${summary.runsPerSplit.eval}, sem split=${summary.missingSplit}`);
  console.log(`Eventos por split: dev=${summary.eventsPerSplit.dev}, eval=${summary.eventsPerSplit.eval}`);
  if (issues.length) {
    for (const issue of issues) console.log(`FALHOU: ${issue}`);
    console.log("Corrija o corpus (scripts/corpus-tool.mjs split) antes de avaliar o conjunto reservado.");
    process.exitCode = 1;
    return;
  }
  console.log("OK: todo caso tem split e eventId; nenhum eventId aparece em dev e eval.");
  console.log("Lembrete: o conjunto eval deve ser congelado antes do ajuste de prompts; esta checagem cobre eventId, não vazamento de conteúdo.");
}

const REQUIRE_KEYS = [
  { key: "runs", description: "execuções no corpus", get: (context) => context.metrics.runCount },
  { key: "uniqueCases", description: "casos únicos no corpus", get: (context) => context.metrics.uniqueCaseCount },
  { key: "verdict.accuracy", description: "acurácia do veredito", get: (context) => context.metrics.verdict.accuracy },
  { key: "verdict.macroF1", description: "macro-F1 do veredito (meta proposta no plano: >= 0.85)", get: (context) => context.metrics.verdict.macroF1 },
  { key: "verdict.falsePositiveAccusationRate", description: "acusações falsas em casos não acusatórios (meta proposta: 0; menor é melhor)", lowerIsBetter: true, get: (context) => context.metrics.verdict.falsePositiveAccusationRate },
  { key: "abstention.precision", description: "precisão da abstenção", get: (context) => context.metrics.abstention.precision },
  { key: "abstention.recall", description: "revocação da abstenção sobre o gabarito sem veredito", get: (context) => context.metrics.abstention.recall },
  { key: "claims.precision", description: "precisão de claims preditos", get: (context) => context.metrics.claims.precision },
  { key: "claims.recall", description: "revocação de claims verificáveis adjudicados", get: (context) => context.metrics.claims.recall },
  { key: "claims.statusMacroF1", description: "macro-F1 do status factual por claim", get: (context) => context.metrics.claims.statusMacroF1 },
  { key: "citations.relevancePrecision", description: "precisão de pertinência de citações", get: (context) => context.metrics.citations.relevancePrecision },
  { key: "citations.relationAccuracy", description: "acurácia da relação claim↔citação", get: (context) => context.metrics.citations.relationAccuracy },
  { key: "citations.quoteSupportPrecision", description: "precisão de trecho fiel (meta proposta: >= 0.95)", get: (context) => context.metrics.citations.quoteSupportPrecision },
  { key: "citations.requiredRecall", description: "revocação de citações exigidas pelo gabarito", get: (context) => context.metrics.citations.requiredCitationRecall },
  { key: "media.transcriptWer", description: "WER de transcrição (menor é melhor)", lowerIsBetter: true, get: (context) => context.metrics.media.transcriptWer },
  { key: "media.ocrWer", description: "WER de OCR (menor é melhor)", lowerIsBetter: true, get: (context) => context.metrics.media.ocrWer },
  { key: "stability.agreement", description: "estabilidade entre rodadas repetidas (mesmo caseId e modelo)", get: (context) => context.metrics.stability.agreement },
  { key: "annotators.verdictAgreement", description: "concordância de veredito entre os dois anotadores", get: (context) => context.annotators.agreement },
  { key: "annotators.verdictKappa", description: "kappa de Cohen do veredito entre anotadores", get: (context) => context.annotators.cohenKappa },
  { key: "annotators.claimStatusAgreement", description: "acordo de status factual por claim entre anotadores (meta proposta: >= 0.90)", get: (context) => context.annotators.claimStatusAgreement },
];

function requireKeyList() {
  return REQUIRE_KEYS.map((spec) => `  ${spec.key} — ${spec.description}`).join("\n");
}

function parseRequirement(text) {
  const match = /^([A-Za-z][A-Za-z0-9_.]*)\s*(>=|<=|==|!=|>|<|=)\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/.exec(text.trim());
  if (!match) {
    const bare = /^[A-Za-z][A-Za-z0-9_.]*$/.test(text.trim());
    throw new Error([
      bare
        ? `--require: falta o operador e o limiar em "${text.trim()}". Em shell, cite a expressão: --require "${text.trim()}>=0.85".`
        : `--require: formato inválido em "${text}". Use chave>=valor (aceita também <=, >, <, =, !=) com limiar numérico.`,
      "Chaves válidas (formato chave>=valor; para métricas marcadas como \"menor é melhor\" use <=):",
      requireKeyList(),
    ].join("\n"));
  }
  const spec = REQUIRE_KEYS.find((item) => item.key === match[1]);
  if (!spec) {
    throw new Error([
      `--require: chave inexistente "${match[1]}".`,
      "Chaves válidas (formato chave>=valor; para métricas marcadas como \"menor é melhor\" use <=):",
      requireKeyList(),
    ].join("\n"));
  }
  const operator = match[2] === "==" ? "=" : match[2];
  return { key: spec.key, operator, threshold: Number(match[3]), description: spec.description, lowerIsBetter: Boolean(spec.lowerIsBetter) };
}

function compareValues(observed, operator, threshold) {
  switch (operator) {
    case ">=": return observed >= threshold;
    case "<=": return observed <= threshold;
    case ">": return observed > threshold;
    case "<": return observed < threshold;
    case "=": return observed === threshold;
    case "!=": return observed !== threshold;
    default: return false;
  }
}

function evaluateRequirements(requirements, context) {
  return requirements.map((requirement) => {
    const spec = REQUIRE_KEYS.find((item) => item.key === requirement.key);
    const observed = spec.get(context);
    const available = typeof observed === "number" && Number.isFinite(observed);
    return {
      key: requirement.key,
      operator: requirement.operator,
      threshold: requirement.threshold,
      observed: available ? observed : null,
      available,
      passed: available && compareValues(observed, requirement.operator, requirement.threshold),
      lowerIsBetter: requirement.lowerIsBetter,
      description: requirement.description,
      reason: available ? null : "métrica indisponível no corpus (n insuficiente ou nenhum caso aplicável); não pode ser considerada atendida",
    };
  });
}

function gateTable(requirements) {
  const headers = ["chave", "operador", "limiar", "observado", "resultado", "observacao"];
  const body = requirements.map((item) => [
    item.key,
    item.operator,
    number(item.threshold),
    item.observed == null ? "n/d" : number(item.observed),
    item.passed ? "PASSOU" : "FALHOU",
    item.available ? (item.lowerIsBetter ? "menor é melhor" : "") : "indisponível (n insuficiente)",
  ]);
  return [`-- Gates (--require) --`, renderTable(headers, body), ""].join("\n");
}

function usage() {
  return [
    "Uso: node scripts/evaluate-factual.mjs <corpus.jsonl> [opções]",
    "",
    "Cada linha precisa de duas anotações humanas independentes, adjudicação, predição e mapeamento de claims/citações.",
    "Campos opcionais aceitos por linha: split (\"dev\"|\"eval\"), eventId, category e annotatorA/annotatorB",
    "(objetos completos ou apenas {annotatorId} referenciando annotations). Linhas em branco e linhas iniciadas por \"#\" são ignoradas.",
    "",
    "Opções:",
    "  --check-split             valida o schema e falha (exit != 0) se algum caso não tiver split/eventId",
    "                            ou se o mesmo eventId aparecer em dev e eval; não calcula métricas nem gates",
    "  --require chave>=valor    gate repetível; falha (exit != 0) quando a métrica global não atinge o limiar",
    "                            ou quando a métrica está indisponível; aceita <= para métricas \"menor é melhor\"",
    "  --json                    imprime somente o relatório JSON (sem o resumo legível)",
    "  --help                    esta ajuda",
    "",
    "Chaves válidas em --require (avaliadas no corpus inteiro, com o n do relatório):",
    requireKeyList(),
    "",
    "Nenhuma métrica deve ser publicada isoladamente: sempre reportar recorte, n, intervalo de incerteza e o aviso de",
    `amostra insuficiente (n < ${MIN_SAMPLE_PER_STRATUM}).`,
  ].join("\n");
}

function printUsage() {
  console.log(usage());
}

function parseArgs(argv) {
  const options = { path: null, checkSplit: false, json: false, help: false, requirementTexts: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--check-split") { options.checkSplit = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--require") {
      const value = argv[++index];
      if (value == null) throw new Error("--require: informe a expressão chave>=valor.");
      options.requirementTexts.push(value);
      continue;
    }
    if (arg.startsWith("--require=")) { options.requirementTexts.push(arg.slice("--require=".length)); continue; }
    if (arg.startsWith("-")) throw new Error(`Opção desconhecida: ${arg}.\n${usage()}`);
    if (options.path) throw new Error(`Corpus informado mais de uma vez: ${arg}.`);
    options.path = arg;
  }
  return options;
}

function printHumanReport({ path, records, results, byModality, byCategory, split, gates }) {
  const uniqueCases = new Set(records.map((record) => record.caseId)).size;
  console.log("== Avaliação factual — resumo legível ==");
  console.log(`Corpus: ${path}`);
  console.log(`Execuções: ${records.length} | casos únicos: ${uniqueCases} | grupos (metodologia × modelo × modalidade): ${results.length}`);
  console.log(`Split: dev=${split.runsPerSplit.dev}, eval=${split.runsPerSplit.eval}, sem split=${split.missingSplit} | eventos: ${split.eventCount} (${split.leakCheck})`);
  console.log("");
  console.log(`AVISO: ${PUBLICATION_WARNING}`);
  console.log("");
  console.log(stratumTable("Por modalidade (n, cobertura e abstenção)", byModality, "modalidade"));
  console.log(stratumTable("Por categoria (n, cobertura e abstenção)", byCategory, "categoria"));
  const insufficient = [...byModality, ...byCategory].filter((row) => row.insufficientSample);
  if (insufficient.length) {
    console.log(`AVISO: amostra insuficiente (n < ${MIN_SAMPLE_PER_STRATUM}) em ${insufficient.length} recorte(s): ${insufficient.map((row) => `${row.label} (n=${row.runCount})`).join(", ")}.`);
    console.log("Recorte com amostra insuficiente não pode ser anunciado como validado; amplie a amostra ou aprove explicitamente um escopo menor.");
    console.log("");
  }
  if (gates.length) console.log(gateTable(gates));
  console.log("-- Relatório JSON --");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.path) {
    printUsage();
    return;
  }
  const requirements = options.requirementTexts.map(parseRequirement);
  const contents = await readFile(options.path, "utf8");
  const records = [];
  const runIds = new Set();
  const caseGold = new Map();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(COMMENT_PREFIX)) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
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

  if (options.checkSplit) {
    checkSplit(records, options.path);
    return;
  }

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
  const globalMetrics = metrics(records, "global");
  const globalAnnotators = interAnnotatorAgreement(records);
  const byModality = strata(records, (record) => record.modality);
  const byCategory = strata(records, (record) => (typeof record.category === "string" && record.category.trim() ? record.category : "(sem categoria)"));
  const split = splitSummary(records);
  const gates = evaluateRequirements(requirements, { metrics: globalMetrics, annotators: globalAnnotators });
  if (split.leakedEventIds.length) {
    console.warn(`AVISO: vazamento de evento entre splits: ${split.leakedEventIds.join(", ")}. Rode --check-split e corrija o corpus antes de interpretar o conjunto reservado.`);
  }
  if (!options.json) printHumanReport({ path: options.path, records, results, byModality, byCategory, split, gates });
  console.log(JSON.stringify({
    protocol: "iev-factual-evaluation-1",
    annotationRequirements: "2 anotadores independentes e adjudicação declarados no corpus; o harness não verifica sua autenticidade ou qualidade",
    publicationWarning: PUBLICATION_WARNING,
    runCount: records.length,
    uniqueCaseCount: totalUniqueCases,
    uniqueGroupCount: new Set(records.map((record) => record.groupId)).size,
    minimumUniqueCasesRecommended: 200,
    minimumUniqueCaseCountMet: totalUniqueCases >= 200,
    minimumRunsPerStratum: MIN_SAMPLE_PER_STRATUM,
    stratifiedReporting: "por modalidade e por categoria, com n, cobertura de veredito, abstenção e aviso de amostra insuficiente quando n < 10; recorte pequeno não pode ser anunciado como validado",
    benchmarkReadiness: "not_assessed_by_harness",
    confidenceIntervals: "bootstrap percentile de 95%, 1000 amostras, reprodutível e agrupado por caseId; null quando há menos de dois casos distintos",
    splitCoverage: split,
    globalMetrics,
    annotatorAgreement: globalAnnotators,
    byModality,
    byCategory,
    requirements: gates,
    requirementsMet: gates.length ? gates.every((gate) => gate.passed) : null,
    results,
    limitation: "A validade depende da composição do corpus, independência real dos anotadores, qualidade da adjudicação e protocolo. O harness valida apenas estrutura; 200 casos são um limiar inicial de corpus, não prova de representatividade ou precisão.",
  }, null, 2));
  if (gates.some((gate) => !gate.passed)) process.exitCode = 1;
}

main().catch((error) => fail(error?.message ?? String(error)));
