// Annual additive comparisons only. Documentary semantics are reviewed separately
// on the complete claim group; this module never asks a model to invent operands.
const OPERATORS = new Set(["greater_than", "less_than", "equal"]);
const FIELDS = ["metric", "region", "unit", "dataset"];
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Portuguese grouping/decimal convention; mixed separators also accept en-US. */
function numberLiteral(valueText, numberFormat = null) {
  if (typeof valueText !== "string") return null;
  let text = valueText.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!/^\d+(?:[., ]\d+)*$/.test(text)) return null;
  if (text.includes(" ")) {
    if (!/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(text)) return null;
    text = text.replace(/ /g, "");
  }
  if (numberFormat != null) {
    if (!["pt-BR", "en-US"].includes(numberFormat)) return null;
    const decimal = numberFormat === "pt-BR" ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    const parts = text.split(decimal);
    if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) return null;
    const integer = parts[0];
    if (!/^\d+$/.test(integer) && !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integer)) return null;
    text = integer.split(grouping).join("") + (parts.length === 2 ? `.${parts[1]}` : "");
  } else if (text.includes(",") && text.includes(".")) {
    const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    const [integer, fraction, extra] = text.split(decimal);
    if (extra != null || !fraction || !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integer)) return null;
    text = integer.split(grouping).join("") + "." + fraction;
  } else if (text.includes(",")) {
    if ((text.match(/,/g) ?? []).length !== 1) return null;
    text = text.replace(",", ".");
  } else if (text.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
    else if ((text.match(/\./g) ?? []).length !== 1) return null;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER || (text.split(".")[1]?.length ?? 0) > 6) return null;
  return text;
}

export function parseComparisonNumber(valueText, numberFormat = null) {
  const literal = numberLiteral(valueText, numberFormat);
  return literal == null ? null : Number(literal);
}

function exactValue(valueText, scale, numberFormat) {
  const [integer, fraction = ""] = numberLiteral(valueText, numberFormat).split(".");
  return (BigInt(integer) * 1000000n + BigInt(fraction.padEnd(6, "0"))) * BigInt(scale);
}

function unitPattern(unit) {
  const value = normalize(unit);
  if (["ha", "hectare", "hectares"].includes(value)) return /\b(?:ha|hectares?)\b/i;
  if (["km2", "km²", "quilometros quadrados"].includes(value)) return /\bkm(?:2|²)|quilometros quadrados/i;
  return new RegExp(`(?:^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i");
}

function sourcedRow(row, citation, proposal) {
  if (citation?.locator?.found !== true || !citation.quote || !citation.excerpt) return null;
  if (row.numberFormat == null && /^\d{1,3}[.,]\d{3}$/.test(String(row.valueText).trim())) return null;
  const number = parseComparisonNumber(row.valueText, row.numberFormat);
  if (number == null || ![1, 1000, 1000000].includes(row.scale)) return null;
  const text = normalize(citation.excerpt);
  const literal = normalize(row.valueText);
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(literal, cursor);
    if (index < 0) return null;
    cursor = index + literal.length;
    if (/[\d.,+-]/.test(text[index - 1] ?? "") || /[\d.,]/.test(text[cursor] ?? "")) continue;
    const window = text.slice(Math.max(0, index - 160), cursor + 160);
    if (!new RegExp(`\\b${row.year}\\b`).test(window) || !unitPattern(proposal.unit).test(window)) continue;
    const suffix = text.slice(cursor, cursor + 35);
    const scale = /^\s*(?:milhoes|milhao|million)\b/.test(suffix) ? 1000000 : /^\s*(?:mil|thousand)\b/.test(suffix) ? 1000 : 1;
    if (scale !== row.scale) continue;
    const value = number * row.scale;
    return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : null;
  }
  return null;
}

export function calculateComparison(comparison, { citations = [], claimIndex = 0, now = new Date() } = {}) {
  const base = { ...comparison, status: "invalid", eligible: false, relation: null, scope: "partial", equalLength: false, groups: [] };
  const invalid = (reason, groups = base.groups) => ({ ...base, groups, reason });
  if (!comparison || !OPERATORS.has(comparison.operator) || FIELDS.some((field) => !normalize(comparison[field])) || !Array.isArray(comparison.groups) || comparison.groups.length !== 2) return invalid("A comparação precisa identificar indicador, região, unidade, dataset, operador e dois períodos.");
  const located = (citations ?? []).filter((item) => item.claimIndex === claimIndex && item.locator?.found === true);
  // Metadata homogeneity is structural. Only the grouped documentary review
  // can establish semantic scope; identifiers need not be literal quotations.
  const currentYear = new Date(now).getUTCFullYear();
  const yearsSeen = new Set();
  const groups = [];
  const totals = [];
  for (const group of comparison.groups) {
    if (!Number.isInteger(group?.startYear) || !Number.isInteger(group?.endYear) || group.startYear < 1900 || group.endYear < group.startYear || group.endYear - group.startYear > 200 || !normalize(group.label) || !Array.isArray(group.rows)) return invalid("Período anual ou grupo inválido.", groups);
    if (FIELDS.some((field) => group[field] != null && normalize(group[field]) !== normalize(comparison[field]))) return invalid("Os grupos usam indicadores, regiões, unidades ou datasets incompatíveis.", groups);
    const rows = [];
    for (const row of group.rows) {
      if (!Number.isInteger(row?.year) || row.year < group.startYear || row.year > group.endYear || row.year > currentYear || yearsSeen.has(row.year) || typeof row.complete !== "boolean" || typeof row.evidenceId !== "string" || !row.evidenceId || FIELDS.some((field) => row[field] != null && normalize(row[field]) !== normalize(comparison[field]))) return invalid("Ano duplicado, sobreposto, futuro ou escopo incompatível nos dados anuais.", groups);
      yearsSeen.add(row.year);
      const candidates = located.filter((item) => item.evidenceId === row.evidenceId);
      if (candidates.length !== 1) return invalid("Um valor anual não possui uma evidência localizada inequívoca.", groups);
      const value = sourcedRow(row, candidates[0], comparison);
      if (value == null) return invalid("Valor, escala, unidade ou ano não conferem com o trecho localizado.", groups);
      rows.push({ ...row, value, complete: row.complete && row.year < currentYear });
    }
    rows.sort((a, b) => a.year - b.year);
    const missingYears = [];
    for (let year = group.startYear; year <= group.endYear; year++) if (!rows.some((row) => row.year === year && row.complete)) missingYears.push(year);
    const exactTotal = rows.reduce((sum, row) => sum + exactValue(row.valueText, row.scale, row.numberFormat), 0n);
    const total = Number(exactTotal) / 1000000;
    if (!Number.isFinite(total) || exactTotal > BigInt(Number.MAX_SAFE_INTEGER) * 1000000n) return invalid("O total excede a precisão numérica segura.", groups);
    totals.push(exactTotal);
    groups.push({ ...group, rows, total, coverage: { expected: group.endYear - group.startYear + 1, available: rows.length, complete: missingYears.length === 0, missingYears } });
  }
  const [a, b] = groups;
  if (!(a.endYear < b.startYear || b.endYear < a.startYear)) return invalid("Os períodos se sobrepõem.", groups);
  const equalLength = a.coverage.expected === b.coverage.expected;
  const bothComplete = a.coverage.complete && b.coverage.complete;
  const order = totals[0] > totals[1] ? 1 : totals[0] < totals[1] ? -1 : 0;
  const wanted = comparison.operator === "greater_than" ? 1 : comparison.operator === "less_than" ? -1 : 0;
  // Nonnegative additive area alone admits a rigorous bound. Counts and
  // percentages do not become area totals, and no forecast is extrapolated.
  const area = ["ha", "hectare", "hectares", "km2", "km²", "quilometros quadrados"].includes(normalize(comparison.unit));
  const boundOrder = area && !bothComplete ? (!a.coverage.complete && b.coverage.complete && order === 1 ? 1 : a.coverage.complete && !b.coverage.complete && order === -1 ? -1 : null) : null;
  const eligible = bothComplete || boundOrder != null;
  const actualOrder = bothComplete ? order : boundOrder;
  return {
    ...comparison, groups, equalLength, eligible,
    status: bothComplete ? "complete" : boundOrder != null ? "lower_bound" : "partial",
    scope: bothComplete ? equalLength ? "whole_period" : "shorter_recorte" : boundOrder != null ? "lower_bound" : "partial",
    relation: eligible ? actualOrder === wanted ? "supports" : "refutes" : null,
    reason: bothComplete ? equalLength ? "Totais anuais completos em períodos de igual duração." : "Totais de recortes com durações diferentes; não representam comparação de períodos equivalentes."
      : boundOrder != null ? "O subtotal de área não negativa já supera o total completo do outro período; apenas a desigualdade está estabelecida."
        : "Dados parciais: os subtotais e a cobertura disponíveis não estabelecem a comparação dos períodos completos.",
  };
}

export function applyComparisons({ claims = [], citations = [], now = new Date() } = {}) {
  return (claims ?? []).map((claim, claimIndex) => claim?.comparison ? { ...claim, comparison: calculateComparison(claim.comparison, { citations, claimIndex, now }) } : claim);
}
