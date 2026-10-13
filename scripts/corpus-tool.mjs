#!/usr/bin/env node
// Ferramenta de corpus para avaliação factual: anotação dupla independente, adjudicação e separação dev/eval.
// Sem dependências externas. Determinística: nenhuma saída depende de relógio, ordem de diretório ou aleatoriedade.
import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

const VERDICTS = new Set(["true", "mostly_true", "partially_true", "distorted", "unproven", "misleading", "false", "no_verdict"]);
const CLAIM_STATUSES = new Set(["true", "false", "context", "unproven"]);
const MODALITIES = new Set(["text", "link", "image", "audio", "video"]);
const SPLITS = new Set(["dev", "eval"]);
const DECISION_FIELDS = new Set(["verdict", "claims", "claim.status", "claim.verifiable"]);
const DATE_FIELDS = ["publishedAt", "collectedAt", "annotatedAt", "adjudicatedAt"];
const SPLIT_SEED = "iev-split-v1";
const CLAIM_STATUS_GATE = 0.9;
const MIN_STRATUM = 10;
const COMMENT_PREFIX = "#";
const MAX_ISSUES = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const COMMANDS = ["init", "validate", "agreement", "adjudicate", "split"];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && Boolean(value.trim());
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

function parseOptions(argv, { booleans = [], values = [], maxPositional = 1 } = {}) {
  const options = { positionals: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = (equals === -1 ? arg : arg.slice(0, equals)).slice(2);
      if (booleans.includes(name)) {
        if (equals !== -1) throw new Error(`Opção --${name} não aceita valor.`);
        options[name] = true;
        continue;
      }
      if (values.includes(name)) {
        const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
        if (!isText(value)) throw new Error(`Opção --${name} exige um valor não vazio.`);
        options[name] = value;
        continue;
      }
      throw new Error(`Opção desconhecida: --${name}.`);
    }
    options.positionals.push(arg);
  }
  if (options.positionals.length > maxPositional) {
    throw new Error(`Argumentos demais: ${options.positionals.slice(maxPositional).join(" ")}.`);
  }
  return options;
}

function usage(command) {
  const header = [
    "Ferramenta de corpus (anotação dupla, adjudicação e separação dev/eval).",
    "",
    "Uso: node scripts/corpus-tool.mjs <subcomando> [arquivo.jsonl] [opções]",
    "",
    "Subcomandos:",
    "  init         escreve um template JSONL comentado para começar as anotações",
    "  validate     valida schema, caseId único, enums, coerência de datas e decisões de adjudicação",
    "  agreement    concordância por campo entre annotatorA/annotatorB (+ kappa de Cohen) e divergências",
    "  adjudicate   gera adjudicated a partir de A/B usando um arquivo de decisões para as divergências",
    "  split        atribui dev/eval por hash de eventId (reprodutível) e controla vazamento entre splits",
    "",
    "Formato do corpus: JSONL, uma linha por registro. Linhas em branco e linhas iniciadas por \"#\" são ignoradas.",
    "Campos do registro, além dos já exigidos pelo harness scripts/evaluate-factual.mjs:",
    "  caseId, modality, annotatorA, annotatorB (ou annotations com exatamente dois itens), eventId, split, category,",
    "  publishedAt, collectedAt, annotatedAt, adjudicatedAt (ISO 8601), adjudicated, prediction.",
    "annotatorA/annotatorB aceitam dois formatos: objeto completo {annotatorId, verdict, claims} ou",
    "apenas {annotatorId} para referenciar o item correspondente de annotations.",
    "",
    "Anotação: {annotatorId, independent: true, verdict, claims:[{id, verifiable, status}]}.",
    "Decisão de adjudicação (JSONL): {caseId, field, key?, decision, adjudicatorId, decidedAt?, note?},",
    "  field em verdict | claims | claim.status | claim.verifiable; key é o id do claim quando o campo for de claim;",
    "  decision em verdict: rótulo de veredito; em claims: include|exclude; em claim.verifiable: true|false;",
    "  em claim.status: status factual.",
    "",
    `Seeds e limiares: split usa hash sha256 de "${SPLIT_SEED}" + eventId; gate proposto de acordo de status factual >= ${CLAIM_STATUS_GATE};`,
    `amostra insuficiente quando n < ${MIN_STRATUM}.`,
  ];
  const perCommand = {
    init: [
      "Uso: node scripts/corpus-tool.mjs init --out <arquivo.jsonl> [--force]",
      "  --out <arquivo>   destino do template (obrigatório)",
      "  --force           sobrescreve o destino, se existir",
    ],
    validate: [
      "Uso: node scripts/corpus-tool.mjs validate <arquivo.jsonl> [--decisions <arquivo.jsonl>] [--allow-repeated-runs] [--json]",
      "  --decisions <arquivo>      exige decisão registrada para cada divergência entre A e B",
      "  --allow-repeated-runs      permite repetir o mesmo caseId quando o gabarito for idêntico (rodadas repetidas)",
      "  --json                     imprime o resultado como JSON",
    ],
    agreement: [
      "Uso: node scripts/corpus-tool.mjs agreement <arquivo.jsonl> [--json]",
      "  --json    imprime o resultado como JSON",
    ],
    adjudicate: [
      "Uso: node scripts/corpus-tool.mjs adjudicate <arquivo.jsonl> --out <arquivo.jsonl> [--decisions <arquivo.jsonl>] [--template-out <arquivo.jsonl>] [--json]",
      "  --out <arquivo>            destino do corpus com adjudicated preenchido (obrigatório)",
      "  --decisions <arquivo>       decisões humanas para divergências (obrigatório quando há divergência)",
      "  --template-out <arquivo>    escreve esqueleto de decisões com as divergências encontradas",
      "  --json                     imprime o resumo como JSON",
    ],
    split: [
      "Uso: node scripts/corpus-tool.mjs split <arquivo.jsonl> [--eval-ratio 0.2] [--seed texto] [--out <arquivo.jsonl>] [--json]",
      "  --eval-ratio <0..1>    fração alvo de eventos no conjunto eval (padrão 0.2)",
      "  --seed <texto>         sal do hash (padrão \"" + SPLIT_SEED + "\"); mude só se precisar de outra divisão",
      "  --out <arquivo>        escreve o corpus com o campo split; sem --out apenas mostra a divisão calculada",
      "  --json                 imprime o resumo como JSON",
    ],
  };
  return [...header, "", ...(perCommand[command] ?? [])].join("\n");
}

function printUsage(command) {
  console.log(usage(command));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(path) {
  const contents = await readFile(path, "utf8");
  const entries = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(COMMENT_PREFIX)) continue;
    try {
      const record = JSON.parse(trimmed);
      if (!isPlainObject(record)) throw new Error("esperado um objeto JSON por linha.");
      entries.push({ record, line: index + 1 });
    } catch (error) {
      throw new Error(`${path} linha ${index + 1}: ${error instanceof SyntaxError ? "JSON inválido." : error.message}`);
    }
  }
  return entries;
}

function resolveAnnotation(record, slot) {
  const named = record[slot];
  if (!named) return null;
  const listed = Array.isArray(record.annotations) ? record.annotations.find((item) => item?.annotatorId === named.annotatorId) : null;
  const complete = named.verdict != null || named.claims != null;
  const annotation = complete ? named : listed;
  if (!annotation) throw new Error(`caseId ${record.caseId}: ${slot} referencia annotatorId "${named.annotatorId}" ausente de annotations.`);
  if (complete && listed && signatureOf(named) !== signatureOf(listed)) {
    throw new Error(`caseId ${record.caseId}: ${slot} divergente da anotação correspondente em annotations.`);
  }
  return annotation;
}

function annotatorsOf(record) {
  if (record.annotatorA && !record.annotatorB) throw new Error(`caseId ${record.caseId}: informar annotatorA e annotatorB juntos.`);
  if (record.annotatorB && !record.annotatorA) throw new Error(`caseId ${record.caseId}: informar annotatorA e annotatorB juntos.`);
  const named = [resolveAnnotation(record, "annotatorA"), resolveAnnotation(record, "annotatorB")];
  if (named[0] && named[1]) return { slots: named, source: "annotatorA/annotatorB" };
  const listed = Array.isArray(record.annotations) ? record.annotations : null;
  if (listed && listed.length === 2) return { slots: listed, source: "annotations" };
  throw new Error(`caseId ${record.caseId}: informe duas anotações (annotations com dois itens ou annotatorA + annotatorB).`);
}

function claimList(annotation) {
  return Array.isArray(annotation?.claims) ? annotation.claims.filter((claim) => isPlainObject(claim)) : [];
}

function claimMap(annotation) {
  const map = new Map();
  for (const claim of claimList(annotation)) {
    if (isText(claim.id)) map.set(claim.id, claim);
  }
  return map;
}

function signatureOf(annotation) {
  return JSON.stringify({
    annotatorId: annotation?.annotatorId ?? null,
    verdict: annotation?.verdict ?? null,
    claims: claimList(annotation)
      .map((claim) => ({ id: claim.id ?? null, verifiable: claim.verifiable ?? null, status: claim.status ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
}

function sameClaimSet(left, right) {
  const signature = (claims) => JSON.stringify(claims
    .map((claim) => ({ id: claim.id ?? null, verifiable: claim.verifiable ?? null, status: claim.status ?? null }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))));
  return signature(left) === signature(right);
}

function cohenKappa(pairs) {
  const total = pairs.length;
  if (!total) return { n: 0, agreement: null, expected: null, kappa: null, applicable: false };
  const agreement = pairs.filter(([a, b]) => a === b).length / total;
  const labels = new Set(pairs.flat());
  const expected = [...labels].reduce((sum, label) => {
    const left = pairs.filter(([a]) => a === label).length / total;
    const right = pairs.filter(([, b]) => b === label).length / total;
    return sum + left * right;
  }, 0);
  const applicable = total >= 2 && labels.size >= 2 && expected < 1;
  return { n: total, agreement, expected, kappa: applicable ? (agreement - expected) / (1 - expected) : null, applicable };
}

function divergenceList(entries, { tolerant = false } = {}) {
  const divergences = [];
  for (const { record } of entries) {
    let slots;
    try {
      slots = annotatorsOf(record).slots;
    } catch (error) {
      if (tolerant) continue;
      throw error;
    }
    const [left, right] = [...slots].sort((a, b) => String(a.annotatorId).localeCompare(String(b.annotatorId)));
    if (left.verdict !== right.verdict) {
      divergences.push({ caseId: record.caseId, field: "verdict", key: null, a: left.verdict ?? null, b: right.verdict ?? null });
    }
    const claimsA = claimMap(left);
    const claimsB = claimMap(right);
    for (const id of [...new Set([...claimsA.keys(), ...claimsB.keys()])].sort()) {
      const a = claimsA.get(id);
      const b = claimsB.get(id);
      if (a && !b) divergences.push({ caseId: record.caseId, field: "claims", key: id, a: "presente", b: "ausente" });
      else if (b && !a) divergences.push({ caseId: record.caseId, field: "claims", key: id, a: "ausente", b: "presente" });
      else if (a && b) {
        if (a.verifiable !== b.verifiable) divergences.push({ caseId: record.caseId, field: "claim.verifiable", key: id, a: a.verifiable, b: b.verifiable });
        const leftStatus = CLAIM_STATUSES.has(a.status) ? a.status : null;
        const rightStatus = CLAIM_STATUSES.has(b.status) ? b.status : null;
        if (leftStatus !== rightStatus) divergences.push({ caseId: record.caseId, field: "claim.status", key: id, a: leftStatus, b: rightStatus });
      }
    }
  }
  return divergences;
}

function decisionKey(caseId, field, key) {
  return `${caseId}\u0000${field}\u0000${key ?? ""}`;
}

function parseDecision(entry, path) {
  const { record, line } = entry;
  const issues = [];
  if (!isText(record.caseId)) issues.push(`${path} linha ${line}: caseId obrigatório na decisão.`);
  if (!DECISION_FIELDS.has(record.field)) issues.push(`${path} linha ${line}: field inválido (${JSON.stringify(record.field)}); use ${[...DECISION_FIELDS].join(" | ")}.`);
  if (record.field !== "verdict" && !isText(record.key)) issues.push(`${path} linha ${line}: key (id do claim) obrigatório para ${record.field}.`);
  if (!isText(record.adjudicatorId)) issues.push(`${path} linha ${line}: adjudicatorId obrigatório (a adjudicação precisa ser atribuível).`);
  if (record.decidedAt != null && !isIsoDate(record.decidedAt)) issues.push(`${path} linha ${line}: decidedAt precisa ser data ISO 8601.`);
  const decision = record.decision;
  if (record.field === "verdict" && !VERDICTS.has(decision)) issues.push(`${path} linha ${line}: decision precisa ser um veredito válido.`);
  if (record.field === "claims" && !["include", "exclude"].includes(decision)) issues.push(`${path} linha ${line}: decision precisa ser "include" ou "exclude".`);
  if (record.field === "claim.status" && !CLAIM_STATUSES.has(decision)) issues.push(`${path} linha ${line}: decision precisa ser um status factual válido.`);
  if (record.field === "claim.verifiable" && typeof decision !== "boolean") issues.push(`${path} linha ${line}: decision precisa ser true ou false.`);
  return { issues, decision: { caseId: record.caseId, field: record.field, key: record.field === "verdict" ? null : record.key, value: decision, adjudicatorId: record.adjudicatorId, decidedAt: record.decidedAt ?? null, note: record.note ?? null } };
}

function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function decisionIndex(entries, path) {
  const issues = [];
  const index = new Map();
  for (const entry of entries) {
    const parsed = parseDecision(entry, path);
    issues.push(...parsed.issues);
    if (parsed.issues.length) continue;
    const key = decisionKey(parsed.decision.caseId, parsed.decision.field, parsed.decision.key);
    if (index.has(key)) issues.push(`${path} linha ${entry.line}: decisão duplicada para ${parsed.decision.caseId}/${parsed.decision.field}/${parsed.decision.key ?? "-"}.`);
    index.set(key, parsed.decision);
  }
  return { index, issues };
}

function checkDecisionCoverage(entries, index, divergences) {
  const issues = [];
  const missing = [];
  for (const divergence of divergences) {
    if (!index.has(decisionKey(divergence.caseId, divergence.field, divergence.key))) missing.push(`${divergence.caseId}/${divergence.field}/${divergence.key ?? "-"}`);
  }
  if (missing.length) {
    issues.push(`faltam ${missing.length} decisão(ões) de adjudicação para divergências entre A e B: ${missing.slice(0, MAX_ISSUES).join(", ")}${missing.length > MAX_ISSUES ? ` … e mais ${missing.length - MAX_ISSUES}` : ""}.`);
    issues.push("Gere o esqueleto com `adjudicate <corpus> --template-out <decisoes.jsonl>` e preencha as decisões.");
  }
  const used = new Set(divergences.map((divergence) => decisionKey(divergence.caseId, divergence.field, divergence.key)));
  const extra = [...index.keys()].filter((key) => !used.has(key));
  return { issues, extra };
}

function validateAnnotation(annotation, label, issues, prefix, strict) {
  if (!isPlainObject(annotation)) {
    issues.error(`${prefix}: ${label} precisa ser um objeto {annotatorId, verdict, claims}.`);
    return;
  }
  if (!isText(annotation.annotatorId)) issues.error(`${prefix}: ${label}.annotatorId obrigatório.`);
  if (!VERDICTS.has(annotation.verdict)) issues.error(`${prefix}: ${label}.verdict inválido (${JSON.stringify(annotation.verdict)}).`);
  if (annotation.independent === false) issues.error(`${prefix}: ${label}.independent precisa ser true (anotação humana independente).`);
  if (annotation.independent !== true && annotation.independent !== false) issues.warn(`${prefix}: ${label}.independent ausente; declare independent: true para registrar a independência.`);
  if (!Array.isArray(annotation.claims)) {
    issues.error(`${prefix}: ${label}.claims precisa ser uma lista.`);
    return;
  }
  const ids = new Set();
  for (const claim of annotation.claims) {
    if (!isPlainObject(claim) || !isText(claim.id)) {
      issues.error(`${prefix}: ${label}.claims precisa de itens com id.`);
      continue;
    }
    if (ids.has(claim.id)) issues.error(`${prefix}: ${label} repete o id de claim ${claim.id}.`);
    ids.add(claim.id);
    if (typeof claim.verifiable !== "boolean") issues.error(`${prefix}: ${label} claim ${claim.id} precisa de verifiable booleano.`);
    if (claim.verifiable === true && !CLAIM_STATUSES.has(claim.status)) issues.error(`${prefix}: ${label} claim ${claim.id} verificável precisa de status válido.`);
    if (claim.status != null && claim.verifiable !== true && strict) issues.warn(`${prefix}: ${label} claim ${claim.id} não verificável com status declarado; o status não entra nas métricas.`);
  }
}

function validateAdjudicated(record, issues, prefix) {
  const adjudicated = record.adjudicated;
  if (!isPlainObject(adjudicated)) {
    issues.error(`${prefix}: adjudicated precisa ser um objeto.`);
    return null;
  }
  if (!VERDICTS.has(adjudicated.verdict)) issues.error(`${prefix}: adjudicated.verdict inválido.`);
  if (!Array.isArray(adjudicated.claims)) {
    issues.error(`${prefix}: adjudicated.claims precisa ser uma lista.`);
    return null;
  }
  const ids = new Set();
  const verifiable = new Set();
  for (const claim of adjudicated.claims) {
    if (!isPlainObject(claim) || !isText(claim.id)) {
      issues.error(`${prefix}: adjudicated.claims precisa de itens com id.`);
      continue;
    }
    if (ids.has(claim.id)) issues.error(`${prefix}: adjudicated repete o id de claim ${claim.id}.`);
    ids.add(claim.id);
    if (typeof claim.verifiable !== "boolean") issues.error(`${prefix}: adjudicated claim ${claim.id} precisa de verifiable booleano.`);
    if (claim.verifiable === true) {
      if (!CLAIM_STATUSES.has(claim.status)) issues.error(`${prefix}: adjudicated claim ${claim.id} verificável precisa de status válido.`);
      verifiable.add(claim.id);
    }
  }
  for (const field of ["citations", "requiredCitations"]) {
    if (adjudicated[field] != null && !Array.isArray(adjudicated[field])) issues.error(`${prefix}: adjudicated.${field} precisa ser uma lista.`);
  }
  return verifiable;
}

function validatePrediction(record, issues, prefix, verifiableIds) {
  const prediction = record.prediction;
  if (!isPlainObject(prediction)) {
    issues.error(`${prefix}: prediction precisa ser um objeto.`);
    return;
  }
  if (prediction.verdict !== null && prediction.verdict !== undefined && !VERDICTS.has(prediction.verdict)) issues.error(`${prefix}: prediction.verdict inválido.`);
  if (!Array.isArray(prediction.claims)) {
    issues.error(`${prefix}: prediction.claims precisa ser uma lista.`);
    return;
  }
  for (const claim of prediction.claims) {
    if (!isPlainObject(claim)) {
      issues.error(`${prefix}: prediction.claims precisa conter objetos.`);
      continue;
    }
    if (!CLAIM_STATUSES.has(claim.status)) issues.error(`${prefix}: prediction claim ${claim.claimId ?? "(sem claimId)"} com status inválido.`);
    if (claim.claimId != null && !isText(claim.claimId)) issues.error(`${prefix}: prediction claim com claimId inválido.`);
    if (claim.claimId != null && verifiableIds && !verifiableIds.has(claim.claimId)) {
      issues.error(`${prefix}: prediction claim ${claim.claimId} não corresponde a claim verificável adjudicado.`);
    }
  }
}

function validateDates(record, issues, prefix) {
  const parsed = new Map();
  for (const field of DATE_FIELDS) {
    if (record[field] == null) continue;
    if (!isIsoDate(record[field])) issues.error(`${prefix}: ${field} precisa ser data ISO 8601 (${JSON.stringify(record[field])}).`);
    else parsed.set(field, Date.parse(record[field]));
  }
  const order = ["publishedAt", "collectedAt", "annotatedAt", "adjudicatedAt"];
  for (let index = 1; index < order.length; index++) {
    const previous = order[index - 1];
    const current = order[index];
    if (parsed.has(previous) && parsed.has(current) && parsed.get(current) < parsed.get(previous)) {
      issues.error(`${prefix}: datas incoerentes: ${current} (${record[current]}) é anterior a ${previous} (${record[previous]}).`);
    }
  }
}

function createIssues() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(message) {
      errors.push(message);
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

function printIssues(issues) {
  for (const error of issues.errors.slice(0, MAX_ISSUES)) console.log(`ERRO: ${error}`);
  if (issues.errors.length > MAX_ISSUES) console.log(`ERRO: … e mais ${issues.errors.length - MAX_ISSUES} erro(s).`);
  for (const warning of issues.warnings.slice(0, MAX_ISSUES)) console.log(`AVISO: ${warning}`);
  if (issues.warnings.length > MAX_ISSUES) console.log(`AVISO: … e mais ${issues.warnings.length - MAX_ISSUES} aviso(s).`);
}

function goldSignature(record) {
  const { slots } = annotatorsOf(record);
  const adjudicated = isPlainObject(record.adjudicated) ? record.adjudicated : null;
  return JSON.stringify({
    annotations: slots.map((slot) => signatureOf(slot)).sort(),
    adjudicated: adjudicated
      ? {
        verdict: adjudicated.verdict ?? null,
        claims: (adjudicated.claims ?? []).map((claim) => ({ id: claim?.id ?? null, verifiable: claim?.verifiable ?? null, status: claim?.status ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      }
      : null,
  });
}

function validateCorpus(entries, { allowRepeatedRuns = false, decisions = null } = {}) {
  const issues = createIssues();
  const caseIds = new Map();
  const runIds = new Set();
  for (const { record, line } of entries) {
    const prefix = `linha ${line}`;
    if (!isText(record.caseId)) issues.error(`${prefix}: caseId obrigatório.`);
    if (!MODALITIES.has(record.modality)) issues.error(`${prefix}: modality inválida (${JSON.stringify(record.modality)}).`);
    for (const field of ["eventId", "category", "runId", "groupId", "methodologyVersion", "modelConfiguration"]) {
      if (record[field] != null && !isText(record[field])) issues.error(`${prefix}: ${field}, quando presente, precisa ser texto não vazio.`);
    }
    if (record.split != null && !SPLITS.has(record.split)) issues.error(`${prefix}: split precisa ser "dev" ou "eval".`);
    validateDates(record, issues, prefix);
    if (JSON.stringify(record).includes("PREENCHER")) {
      issues.error(`${prefix}: marcador PREENCHER não substituído; preencha o template (init) antes de validar.`);
    }
    let slots = null;
    try {
      slots = annotatorsOf(record).slots;
    } catch (error) {
      issues.error(`${prefix}: ${error.message}`);
    }
    if (slots) {
      if (slots[0]?.annotatorId && slots[0].annotatorId === slots[1]?.annotatorId) issues.error(`${prefix}: as duas anotações precisam ter annotatorId distintos.`);
      validateAnnotation(slots[0], "annotatorA", issues, prefix, true);
      validateAnnotation(slots[1], "annotatorB", issues, prefix, true);
    }
    let verifiableIds = null;
    if (record.adjudicated != null) verifiableIds = validateAdjudicated(record, issues, prefix);
    if (record.prediction != null) validatePrediction(record, issues, prefix, verifiableIds);
    if (slots && slots[0] && slots[1] && isPlainObject(record.adjudicated)) {
      if (slots[0].verdict === slots[1].verdict && VERDICTS.has(record.adjudicated.verdict) && record.adjudicated.verdict !== slots[0].verdict) {
        issues.warn(`${prefix}: adjudicated.verdict difere do consenso dos anotadores (${slots[0].verdict}); registre a decisão em arquivo de decisões.`);
      }
      if (Array.isArray(slots[0].claims) && Array.isArray(slots[1].claims) && Array.isArray(record.adjudicated.claims)
        && sameClaimSet(slots[0].claims, slots[1].claims) && !sameClaimSet(slots[0].claims, record.adjudicated.claims)) {
        issues.warn(`${prefix}: adjudicated.claims difere do consenso dos anotadores; registre a decisão em arquivo de decisões.`);
      }
    }
    if (isText(record.runId)) {
      if (runIds.has(record.runId)) issues.error(`${prefix}: runId duplicado (${record.runId}).`);
      runIds.add(record.runId);
    }
    if (!isText(record.caseId)) continue;
    let signature;
    try {
      signature = goldSignature(record);
    } catch {
      signature = `linha ${line}: gabarito ilegível (anotações inválidas)`;
    }
    if (caseIds.has(record.caseId)) {
      const previous = caseIds.get(record.caseId);
      if (!allowRepeatedRuns) {
        issues.error(`${prefix}: caseId duplicado (${record.caseId}), já visto na linha ${previous.line}; use --allow-repeated-runs apenas para rodadas repetidas com gabarito idêntico.`);
      } else if (previous.signature !== signature) {
        issues.error(`${prefix}: caseId ${record.caseId} repetido com gabarito diferente do da linha ${previous.line}.`);
      }
    } else {
      caseIds.set(record.caseId, { line, signature });
    }
  }
  let divergences = [];
  try {
    divergences = divergenceList(entries, { tolerant: true });
  } catch (error) {
    issues.error(error.message);
  }
  let extraDecisions = [];
  if (decisions) {
    const coverage = checkDecisionCoverage(entries, decisions.index, divergences);
    for (const issue of coverage.issues) issues.error(issue);
    extraDecisions = coverage.extra;
  } else if (divergences.length) {
    issues.warn(`${divergences.length} divergência(s) entre anotadores; rode \`agreement\` para listá-las e \`adjudicate\` para resolver com decisões registradas.`);
  }
  return { issues, divergences, extraDecisions, caseCount: caseIds.size, uniqueCases: caseIds.size };
}

async function commandInit(argv) {
  const options = parseOptions(argv, { booleans: ["force"], values: ["out"], maxPositional: 0 });
  if (options.help) return printUsage("init");
  if (!options.out) throw new Error(`init: --out é obrigatório.\n${usage("init")}`);
  if (!options.force && await exists(options.out)) throw new Error(`init: ${options.out} já existe; use --force para sobrescrever.`);
  const lines = [
    "# Template de corpus para avaliação factual (scripts/corpus-tool.mjs + scripts/evaluate-factual.mjs).",
    "# Linhas iniciadas por # são comentários ignorados pelas ferramentas. Apague-as se preferir um JSONL puro.",
    "# Cada caso precisa de DUAS anotações humanas independentes (annotations) e, depois, adjudicação das divergências.",
    "# Forma usada abaixo: annotations com dois itens + annotatorA/annotatorB como referência {annotatorId}.",
    "# Alternativa aceita: annotatorA/annotatorB como objeto completo {annotatorId, verdict, claims}, sem annotations.",
    "# Campos por linha: caseId, modality, eventId, split, category e, para o harness, runId, groupId,",
    "# methodologyVersion, modelConfiguration, adjudicated e prediction.",
    "# Opcionais: publishedAt, collectedAt, annotatedAt, adjudicatedAt (ISO 8601, em ordem crescente).",
    "# Substitua TODOS os marcadores PREENCHER: o validate falha enquanto houver marcador.",
    "# 1) Caso com acordo entre anotadores (adjudicação mecânica, sem decisão).",
    JSON.stringify({
      caseId: "PREENCHER-caso-001",
      eventId: "PREENCHER-evento-001",
      split: "dev",
      category: "PREENCHER-categoria",
      modality: "text",
      runId: "PREENCHER-rodada-001",
      groupId: "PREENCHER-lote",
      methodologyVersion: "PREENCHER-versao",
      modelConfiguration: "PREENCHER-modelo",
      publishedAt: "2026-01-01",
      collectedAt: "2026-01-02",
      annotatedAt: "2026-01-03",
      adjudicatedAt: "2026-01-04",
      annotatorA: { annotatorId: "anotador-a" },
      annotatorB: { annotatorId: "anotador-b" },
      annotations: [
        { annotatorId: "anotador-a", independent: true, verdict: "true", claims: [{ id: "c1", verifiable: true, status: "true" }] },
        { annotatorId: "anotador-b", independent: true, verdict: "true", claims: [{ id: "c1", verifiable: true, status: "true" }] },
      ],
      adjudicated: { verdict: "true", claims: [{ id: "c1", verifiable: true, status: "true" }], citations: [], requiredCitations: [] },
      prediction: { verdict: "true", claims: [{ claimId: "c1", status: "true" }], citations: [] },
    }),
    "# 2) Caso com divergência entre anotadores: exige decisão em arquivo de decisões (adjudicate).",
    JSON.stringify({
      caseId: "PREENCHER-caso-002",
      eventId: "PREENCHER-evento-002",
      split: "eval",
      category: "PREENCHER-categoria",
      modality: "link",
      runId: "PREENCHER-rodada-002",
      groupId: "PREENCHER-lote",
      methodologyVersion: "PREENCHER-versao",
      modelConfiguration: "PREENCHER-modelo",
      publishedAt: "2026-02-01",
      collectedAt: "2026-02-02",
      annotatedAt: "2026-02-03",
      adjudicatedAt: "2026-02-04",
      annotatorA: { annotatorId: "anotador-a" },
      annotatorB: { annotatorId: "anotador-b" },
      annotations: [
        { annotatorId: "anotador-a", independent: true, verdict: "false", claims: [{ id: "c1", verifiable: true, status: "false" }] },
        { annotatorId: "anotador-b", independent: true, verdict: "distorted", claims: [{ id: "c1", verifiable: true, status: "unproven" }] },
      ],
      adjudicated: { verdict: "false", claims: [{ id: "c1", verifiable: true, status: "false" }], citations: [], requiredCitations: [] },
      prediction: { verdict: "unproven", claims: [{ claimId: "c1", status: "unproven" }], citations: [] },
    }),
    "# Arquivo de decisões (outro arquivo JSONL) para o caso acima:",
    "# {\"caseId\":\"PREENCHER-caso-002\",\"field\":\"verdict\",\"decision\":\"false\",\"adjudicatorId\":\"adjudicador-1\"}",
    "# {\"caseId\":\"PREENCHER-caso-002\",\"field\":\"claim.status\",\"key\":\"c1\",\"decision\":\"false\",\"adjudicatorId\":\"adjudicador-1\"}",
    "# Fluxo: validate -> agreement -> adjudicate (com decisões) -> validate --decisions -> split -> evaluate-factual.",
    "",
  ];
  await writeFile(options.out, lines.join("\n"), "utf8");
  console.log(`Template escrito em ${options.out}.`);
  console.log("Substitua os marcadores PREENCHER; rode `node scripts/corpus-tool.mjs validate " + options.out + "` depois.");
}

async function commandValidate(argv) {
  const options = parseOptions(argv, { booleans: ["allow-repeated-runs", "json"], values: ["decisions"], maxPositional: 1 });
  if (options.help) return printUsage("validate");
  const path = options.positionals[0];
  if (!path) throw new Error(`validate: informe o arquivo JSONL.\n${usage("validate")}`);
  const entries = await readJsonl(path);
  if (!entries.length) throw new Error(`validate: ${path} não contém registros.`);
  let decisions = null;
  if (options.decisions) {
    const decisionEntries = await readJsonl(options.decisions);
    decisions = decisionIndex(decisionEntries, options.decisions);
    if (decisions.issues.length) {
      const issues = createIssues();
      for (const issue of decisions.issues) issues.error(issue);
      printIssues(issues);
      process.exitCode = 1;
      return;
    }
  }
  const result = validateCorpus(entries, { allowRepeatedRuns: Boolean(options["allow-repeated-runs"]), decisions });
  const summary = {
    path,
    records: entries.length,
    uniqueCases: result.caseCount,
    divergences: result.divergences.length,
    errors: result.issues.errors.length,
    warnings: result.issues.warnings.length,
    valid: result.issues.errors.length === 0,
    extraDecisions: result.extraDecisions,
  };
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`-- Validação de corpus --`);
    console.log(`Arquivo: ${path}`);
    console.log(`Registros: ${entries.length} | casos únicos: ${result.caseCount} | divergências entre A e B: ${result.divergences.length}`);
    if (decisions) console.log(`Decisões de adjudicação: nenhuma faltando; ${result.extraDecisions.length} decisão(ões) sem divergência correspondente (ignoradas).`);
    printIssues(result.issues);
    console.log(result.issues.errors.length ? "FALHOU: corrija os erros acima." : "OK: schema, caseId único, enums e datas coerentes.");
  }
  if (result.issues.errors.length) process.exitCode = 1;
}

async function commandAgreement(argv) {
  const options = parseOptions(argv, { booleans: ["json"], maxPositional: 1 });
  if (options.help) return printUsage("agreement");
  const path = options.positionals[0];
  if (!path) throw new Error(`agreement: informe o arquivo JSONL.\n${usage("agreement")}`);
  const entries = await readJsonl(path);
  if (!entries.length) throw new Error(`agreement: ${path} não contém registros.`);
  const verdictPairs = [];
  const statusPairs = [];
  const verifiablePairs = [];
  const setPairs = [];
  const jaccards = [];
  const perModality = new Map();
  const divergences = [];
  for (const { record } of entries) {
    const { slots } = annotatorsOf(record);
    const [left, right] = [...slots].sort((a, b) => String(a.annotatorId).localeCompare(String(b.annotatorId)));
    if (!VERDICTS.has(left.verdict) || !VERDICTS.has(right.verdict)) throw new Error(`caseId ${record.caseId}: anotação sem verdict válido; rode validate.`);
    verdictPairs.push([left.verdict, right.verdict]);
    const claimsA = claimMap(left);
    const claimsB = claimMap(right);
    const idsA = [...claimsA.keys()].sort();
    const idsB = [...claimsB.keys()].sort();
    setPairs.push([JSON.stringify(idsA), JSON.stringify(idsB)]);
    const union = new Set([...idsA, ...idsB]);
    const shared = idsA.filter((id) => claimsB.has(id));
    jaccards.push(union.size ? shared.length / union.size : 1);
    for (const id of shared) {
      const a = claimsA.get(id);
      const b = claimsB.get(id);
      verifiablePairs.push([a.verifiable === true, b.verifiable === true]);
      if (CLAIM_STATUSES.has(a.status) && CLAIM_STATUSES.has(b.status)) statusPairs.push([a.status, b.status]);
    }
    const modality = perModality.get(record.modality) ?? [];
    modality.push(left.verdict === right.verdict);
    perModality.set(record.modality, modality);
  }
  divergences.push(...divergenceList(entries));
  const verdict = cohenKappa(verdictPairs);
  const status = cohenKappa(statusPairs);
  const verifiable = cohenKappa(verifiablePairs);
  const claimsSet = cohenKappa(setPairs);
  const claimSetJaccard = jaccards.reduce((sum, value) => sum + value, 0) / (jaccards.length || 1);
  const report = {
    path,
    cases: entries.length,
    fields: {
      verdict: { ...verdict, description: "veredito final do caso" },
      "claim.status": { ...status, description: "status factual por claim presente nas duas anotações" },
      "claim.verifiable": { ...verifiable, description: "claim verificável ou não" },
      "claims": { ...claimsSet, description: "conjunto de ids de claim", jaccardMean: claimSetJaccard },
    },
    claimStatusGate: status.agreement == null ? null : status.agreement >= CLAIM_STATUS_GATE,
    claimStatusGateThreshold: CLAIM_STATUS_GATE,
    claimStatusInsufficientSample: status.n < MIN_STRATUM,
    divergences,
    divergencesShown: Math.min(divergences.length, MAX_ISSUES),
    byModality: [...perModality.entries()].map(([modality, matches]) => ({
      modality,
      cases: matches.length,
      verdictAgreement: matches.reduce((sum, match) => sum + (match ? 1 : 0), 0) / matches.length,
      insufficientSample: matches.length < MIN_STRATUM,
    })).sort((a, b) => a.modality.localeCompare(b.modality, "pt-BR")),
    note: "kappa de Cohen só é calculado quando há pelo menos dois rótulos distintos; nulo quando a concordância esperada é 1. Concordância observada é a fração de campos idênticos.",
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("-- Acordo entre anotadores A/B --");
  console.log(`Arquivo: ${path} | casos: ${entries.length}`);
  const headers = ["campo", "n", "acordo", "kappa", "aplicavel"];
  const rows = Object.entries(report.fields).map(([field, data]) => [
    field,
    String(data.n),
    number(data.agreement),
    data.kappa == null ? "n/d" : number(data.kappa),
    data.applicable ? "sim" : "nao",
  ]);
  console.log(renderTable(headers, rows));
  if (report.fields.claims.n) console.log(`Conjunto de claims: Jaccard médio = ${number(claimSetJaccard)}.`);
  console.log("");
  console.log(`Meta do plano para status factual por claim (>= ${CLAIM_STATUS_GATE}): ${report.claimStatusGate == null ? "n/d" : report.claimStatusGate ? "PASSOU" : "FALHOU"} (n = ${status.n}).`);
  if (report.claimStatusInsufficientSample) console.log(`AVISO: ${status.n} claims comparáveis < ${MIN_STRATUM}; amostra insuficiente para tratar o acordo como validado.`);
  console.log("");
  console.log(`-- Por modalidade --`);
  console.log(renderTable(["modalidade", "casos", "acordo_veredito", "amostra"], report.byModality.map((row) => [
    row.modality,
    String(row.cases),
    number(row.verdictAgreement),
    row.insufficientSample ? `SIM (n < ${MIN_STRATUM})` : "nao",
  ])));
  console.log("");
  console.log(`-- Divergências (${divergences.length}) --`);
  if (!divergences.length) {
    console.log("Nenhuma divergência entre A e B; a adjudicação é mecânica.");
  } else {
    const headersDivergence = ["caseId", "campo", "chave", "A", "B"];
    const rowsDivergence = divergences.slice(0, MAX_ISSUES).map((divergence) => [
      divergence.caseId,
      divergence.field,
      divergence.key ?? "-",
      String(divergence.a),
      String(divergence.b),
    ]);
    console.log(renderTable(headersDivergence, rowsDivergence));
    if (divergences.length > MAX_ISSUES) console.log(`… e mais ${divergences.length - MAX_ISSUES} divergência(s); use --json para a lista completa.`);
    console.log("Cada divergência precisa de uma decisão humana registrada antes da adjudicação (adjudicate --decisions).");
  }
}

async function commandAdjudicate(argv) {
  const options = parseOptions(argv, { booleans: ["json"], values: ["out", "decisions", "template-out"], maxPositional: 1 });
  if (options.help) return printUsage("adjudicate");
  const path = options.positionals[0];
  if (!path) throw new Error(`adjudicate: informe o arquivo JSONL.\n${usage("adjudicate")}`);
  if (!options.out) throw new Error(`adjudicate: --out é obrigatório.\n${usage("adjudicate")}`);
  const entries = await readJsonl(path);
  if (!entries.length) throw new Error(`adjudicate: ${path} não contém registros.`);
  const divergences = divergenceList(entries);
  if (options["template-out"]) {
    const lines = [
      "# Esqueleto de decisões de adjudicação. Preencha decision (e adjudicatorId) nas linhas marcadas com PREENCHER,",
      "# apague esta linha e as linhas PREENCHER que não se aplicarem, e passe o arquivo em --decisions.",
      ...(divergences.length ? [] : ["# Este corpus não tem divergências entre A e B; nenhuma decisão é necessária."]),
      ...divergences.map((divergence) => JSON.stringify({
        caseId: divergence.caseId,
        field: divergence.field,
        ...(divergence.key ? { key: divergence.key } : {}),
        decision: "PREENCHER",
        adjudicatorId: "PREENCHER",
        note: `A=${JSON.stringify(divergence.a)} B=${JSON.stringify(divergence.b)}`,
      })),
      "",
    ];
    await writeFile(options["template-out"], lines.join("\n"), "utf8");
    console.log(`Esqueleto de decisões escrito em ${options["template-out"]} com ${divergences.length} divergência(s).`);
    if (!options.decisions && divergences.length) {
      process.exitCode = 1;
      console.log("FALHOU: preencha as decisões e rode adjudicate novamente com --decisions.");
      return;
    }
  }
  let decisions = null;
  let extraDecisions = [];
  if (options.decisions) {
    const decisionEntries = await readJsonl(options.decisions);
    decisions = decisionIndex(decisionEntries, options.decisions);
    if (decisions.issues.length) {
      const issues = createIssues();
      for (const issue of decisions.issues) issues.error(issue);
      printIssues(issues);
      process.exitCode = 1;
      return;
    }
    const coverage = checkDecisionCoverage(entries, decisions.index, divergences);
    if (coverage.issues.length) {
      const issues = createIssues();
      for (const issue of coverage.issues) issues.error(issue);
      printIssues(issues);
      process.exitCode = 1;
      return;
    }
    extraDecisions = coverage.extra;
  } else if (divergences.length) {
    const issues = createIssues();
    issues.error(`faltam decisões de adjudicação para ${divergences.length} divergência(s) entre A e B; rode com --decisions (gere o esqueleto com --template-out).`);
    issues.error(`Divergências: ${divergences.slice(0, MAX_ISSUES).map((divergence) => `${divergence.caseId}/${divergence.field}/${divergence.key ?? "-"}`).join(", ")}${divergences.length > MAX_ISSUES ? ` … e mais ${divergences.length - MAX_ISSUES}` : ""}`);
    printIssues(issues);
    process.exitCode = 1;
    return;
  }
  const output = [];
  let decisionCount = 0;
  for (const { record } of entries) {
    const { slots } = annotatorsOf(record);
    const [left, right] = [...slots].sort((a, b) => String(a.annotatorId).localeCompare(String(b.annotatorId)));
    const pick = (field, key) => decisions?.index.get(decisionKey(record.caseId, field, key)) ?? null;
    let verdict = left.verdict === right.verdict ? left.verdict : null;
    if (verdict == null) {
      const decision = pick("verdict", null);
      if (!decision) throw new Error(`caseId ${record.caseId}: veredito divergente sem decisão.`);
      verdict = decision.value;
      decisionCount++;
    }
    const claimsA = claimMap(left);
    const claimsB = claimMap(right);
    const claims = [];
    for (const id of [...new Set([...claimsA.keys(), ...claimsB.keys()])].sort()) {
      const a = claimsA.get(id);
      const b = claimsB.get(id);
      let include = Boolean(a && b);
      if (!include) {
        const decision = pick("claims", id);
        if (!decision) throw new Error(`caseId ${record.caseId}: claim ${id} presente em apenas uma anotação sem decisão.`);
        include = decision.value === "include";
        decisionCount++;
      }
      if (!include) continue;
      const source = a ?? b;
      let verifiable = a && b && a.verifiable === b.verifiable ? a.verifiable : null;
      if (verifiable == null) {
        const decision = pick("claim.verifiable", id);
        if (!decision && a && b) throw new Error(`caseId ${record.caseId}: claim ${id} com verifiable divergente sem decisão.`);
        verifiable = decision ? decision.value : source.verifiable === true;
        if (decision) decisionCount++;
      }
      let status = a && b && a.status === b.status ? a.status : null;
      if (verifiable === true && status == null) {
        const decision = pick("claim.status", id);
        if (!decision) throw new Error(`caseId ${record.caseId}: claim ${id} com status divergente sem decisão.`);
        status = decision.value;
        decisionCount++;
      }
      claims.push({ id, verifiable, ...(status != null ? { status } : {}) });
    }
    const previous = isPlainObject(record.adjudicated) ? record.adjudicated : {};
    output.push({
      ...record,
      adjudicated: {
        ...previous,
        verdict,
        claims,
        citations: Array.isArray(previous.citations) ? previous.citations : [],
        requiredCitations: Array.isArray(previous.requiredCitations) ? previous.requiredCitations : [],
      },
    });
  }
  await writeFile(options.out, `${output.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const summary = {
    path,
    out: options.out,
    records: output.length,
    divergences: divergences.length,
    decisionsApplied: decisionCount,
    extraDecisionsIgnored: extraDecisions.length,
    adjudicatorIds: [...new Set((decisions ? [...decisions.index.values()] : []).map((decision) => decision.adjudicatorId))].sort(),
  };
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`-- Adjudicação --`);
  console.log(`Entrada: ${path} | saída: ${options.out}`);
  console.log(`Registros: ${output.length} | divergências resolvidas: ${divergences.length} | decisões aplicadas: ${decisionCount}`);
  if (summary.adjudicatorIds.length) console.log(`Adjudicador(es) registrado(s): ${summary.adjudicatorIds.join(", ")}.`);
  if (extraDecisions.length) console.log(`AVISO: ${extraDecisions.length} decisão(ões) sem divergência correspondente foram ignoradas: ${extraDecisions.slice(0, MAX_ISSUES).join(", ")}.`);
  if (!divergences.length) console.log("Nenhuma divergência entre A e B; adjudicação mecânica (consenso das anotações).");
  console.log("Próximo passo: node scripts/corpus-tool.mjs validate " + options.out + " e, no harness, o mapeamento de claims/citações precisa conferir com prediction.");
}

async function commandSplit(argv) {
  const options = parseOptions(argv, { booleans: ["json"], values: ["eval-ratio", "seed", "out"], maxPositional: 1 });
  if (options.help) return printUsage("split");
  const path = options.positionals[0];
  if (!path) throw new Error(`split: informe o arquivo JSONL.\n${usage("split")}`);
  const ratio = options["eval-ratio"] == null ? 0.2 : Number(options["eval-ratio"]);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error(`split: --eval-ratio precisa estar entre 0 e 1 (exclusive); recebido ${options["eval-ratio"]}.`);
  const seed = options.seed ?? SPLIT_SEED;
  const entries = await readJsonl(path);
  if (!entries.length) throw new Error(`split: ${path} não contém registros.`);
  const missing = entries.filter(({ record }) => !isText(record.eventId));
  if (missing.length) {
    throw new Error(`split: ${missing.length} registro(s) sem eventId (linhas ${missing.slice(0, MAX_ISSUES).map((entry) => entry.line).join(", ")}); a separação é por evento e exige eventId em todo caso.`);
  }
  const assignment = new Map();
  for (const { record } of entries) {
    if (!assignment.has(record.eventId)) assignment.set(record.eventId, splitForEventId(record.eventId, seed, ratio));
  }
  const rows = entries.map(({ record }) => ({
    caseId: record.caseId,
    eventId: record.eventId,
    modality: record.modality,
    previousSplit: SPLITS.has(record.split) ? record.split : "(sem split)",
    split: assignment.get(record.eventId),
    changed: SPLITS.has(record.split) && record.split !== assignment.get(record.eventId),
  }));
  const eventSplits = [...assignment.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const evalEvents = eventSplits.filter(([, split]) => split === "eval").length;
  const summary = {
    path,
    seed,
    evalRatioRequested: ratio,
    records: rows.length,
    events: eventSplits.length,
    evalEvents,
    devEvents: eventSplits.length - evalEvents,
    evalRatioAchieved: eventSplits.length ? evalEvents / eventSplits.length : null,
    evalRuns: rows.filter((row) => row.split === "eval").length,
    devRuns: rows.filter((row) => row.split === "dev").length,
    changedRecords: rows.filter((row) => row.changed).length,
    insufficientEvalSample: evalEvents < MIN_STRATUM,
    assignment: eventSplits.map(([eventId, split]) => ({ eventId, split })),
    splitFunction: `sha256("${seed}" + "\\0" + eventId) -> primeiros 4 bytes como inteiro / 2^32 < eval-ratio ? "eval" : "dev"`,
    note: "todas as execuções do mesmo eventId recebem o mesmo split; congele o conjunto eval antes de ajustar prompts",
  };
  if (options.out) {
    await writeFile(options.out, `${entries.map(({ record }) => JSON.stringify({ ...record, split: assignment.get(record.eventId) })).join("\n")}\n`, "utf8");
  }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("-- Divisão dev/eval por evento (reprodutível) --");
  console.log(`Arquivo: ${path}${options.out ? ` | saída: ${options.out}` : ""}`);
  console.log(`Sal: ${seed} | eval-ratio pedido: ${ratio} | eventos: ${eventSplits.length} (eval=${evalEvents}, dev=${summary.devEvents}, razão efetiva=${number(summary.evalRatioAchieved)})`);
  console.log(`Execuções: eval=${summary.evalRuns}, dev=${summary.devRuns} | registros com split diferente do atual: ${summary.changedRecords}`);
  if (summary.insufficientEvalSample) console.log(`AVISO: conjunto eval com ${evalEvents} evento(s) < ${MIN_STRATUM}; amostra insuficiente para conclusão sobre o conjunto reservado.`);
  console.log("");
  console.log(renderTable(["caseId", "eventId", "modalidade", "split_calculado", "split_atual"], rows.map((row) => [
    row.caseId,
    row.eventId,
    row.modality,
    row.split,
    row.changed ? `${row.previousSplit} (muda)` : row.previousSplit,
  ])));
  if (!options.out) console.log("Sem --out: nada foi gravado. Use --out <arquivo.jsonl> para materializar o campo split.");
  console.log("Regra: o mesmo eventId nunca pode aparecer em dev e eval; confirme com `node scripts/evaluate-factual.mjs --check-split <arquivo>`.");
}

function splitForEventId(eventId, seed, ratio) {
  const digest = createHash("sha256").update(`${seed}\u0000${eventId}`, "utf8").digest();
  const unit = digest.readUInt32BE(0) / 4294967296;
  return unit < ratio ? "eval" : "dev";
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (!COMMANDS.includes(command)) throw new Error(`Subcomando desconhecido: ${command}. Use um de: ${COMMANDS.join(", ")}.`);
  const handlers = { init: commandInit, validate: commandValidate, agreement: commandAgreement, adjudicate: commandAdjudicate, split: commandSplit };
  await handlers[command](rest);
}

main().catch((error) => fail(error?.message ?? String(error)));
