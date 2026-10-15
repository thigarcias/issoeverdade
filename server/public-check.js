// Allowlist recursiva: nenhum objeto arbitrário do modelo ou do log atravessa
// esta fronteira pública, inclusive quando um registro antigo é lido.
const period = { start: "string", end: "string" };
const coverage = { total: "number", assessed: "number", unproven: "number", omitted: "number" };
const comparison = {
  metric: "string", region: "string", unit: "string", dataset: "string", operator: "string",
  status: "string", eligible: "boolean", relation: "string", scope: "string", equalLength: "boolean", reason: "string",
  groups: [{ label: "string", startYear: "number", endYear: "number", total: "number",
    coverage: { expected: "number", available: "number", complete: "boolean", missingYears: ["number"] },
    rows: [{ year: "number", value: "number", valueText: "string", numberFormat: "string", scale: "number", complete: "boolean", evidenceId: "string" }],
  }],
};
const claim = {
  text: "string", note: "string", status: "string", score: "number", evidenceSupport: "string", sourceIds: ["number"],
  referencePeriod: period, comparison,
  evidenceReview: { verification: "string", verdict: "string", incomplete: "boolean", evidenceIndices: ["number"], reason: "string" },
  evidence: [{ evidenceId: "string", sourceId: "number", relation: "string", quote: "string", verification: "string", referencePeriod: period }],
};
const resultSchema = {
  outcome: "string", verdict: "string", score: "number", summary: "string", coverage,
  omittedClaimsCount: "number", notCheckedClaims: [{ text: "string", reason: "string" }], claims: [claim],
  sources: [{ url: "url", title: "string", citationTitle: "string", outlet: "string", detail: "string", date: "string", publishedAt: "string", referencePeriod: period }],
};
const originSchema = { url: "url", title: "string", author: "string", platform: "string", thumbnail: "url", publishedAt: "string", duration: "number", durationSec: "number" };

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|auth|signature|credential|password|^sig$|^x-amz-/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function project(value, schema) {
  if (value == null) return null;
  if (schema === "url") return typeof value === "string" ? publicUrl(value) : null;
  if (typeof schema === "string") {
    if (typeof value !== schema || (schema === "number" && !Number.isFinite(value))) return null;
    return schema === "string" ? value.slice(0, 12000) : value;
  }
  if (Array.isArray(schema)) return Array.isArray(value) ? value.slice(0, 200).map((item) => project(item, schema[0])).filter((item) => item !== null) : [];
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, child] of Object.entries(schema)) {
    if (Object.hasOwn(value, key)) result[key] = project(value[key], child);
  }
  return result;
}

export function publicCheckEnvelope(envelope, { checkId = envelope?.checkId, createdAt = envelope?.createdAt } = {}) {
  return {
    checkId: typeof checkId === "string" && /^[a-z0-9-]{1,100}$/i.test(checkId) ? checkId : null,
    result: project(envelope?.result, resultSchema),
    origin: project(envelope?.origin, originSchema),
    createdAt: typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : null,
  };
}
