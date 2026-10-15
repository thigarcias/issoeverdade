import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { runVerify } from "./verify.js";
import { mergeEvidenceResearch, changedEvidenceClaims } from "./evidence-research.js";

const quote = "O Projeto Horizonte propõe aposentadoria aos 67 anos para homens e mulheres.";
const receipt = "A associação entregou o Projeto Horizonte à candidata no encontro de outubro.";
const text = "O Projeto Horizonte propõe idade mínima de 67 anos para homens e mulheres.";
const answer = (choice) => ({ type: "choice", choice, probabilities: Object.fromEntries(
  ["supports", "refutes", "context", "unclear"].map((key) => [key, key === choice ? 0.97 : 0.01]),
) });

async function scenario(t, { repair = "recover", initialLocated = false, omitted = false, initialStatus = "true", collector = "1", reviewUnavailable = false } = {}) {
  let documentRequests = 0;
  const server = http.createServer((req, res) => {
    documentRequests++;
    if (req.url === "/blocked") { res.writeHead(403); res.end("Forbidden"); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<html><body><article><p>${receipt}</p><p>${quote}</p></article></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const documentUrl = `http://127.0.0.1:${port}/document`;
  const blockedUrl = `http://127.0.0.1:${port}/blocked`;
  const names = ["OPENCODE_API", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN", "MODERATION_MODE", "IEV_EVIDENCE_FETCH", "IEV_EVIDENCE_REVIEW", "IEV_ALLOW_PRIVATE_HOSTS", "IEV_HTTP_PORTS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { OPENCODE_API: "test-only", MODERATION_MODE: "off", IEV_EVIDENCE_FETCH: "1", IEV_EVIDENCE_REVIEW: "1", IEV_ALLOW_PRIVATE_HOSTS: "1", IEV_HTTP_PORTS: String(port) });
  if (collector === null) delete process.env.IEV_EVIDENCE_FETCH;
  else process.env.IEV_EVIDENCE_FETCH = collector;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const originalFetch = globalThis.fetch;
  let reviewed = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }));
    const body = JSON.parse(options.body);
    if (String(url).endsWith("/systemone")) {
      if (reviewUnavailable) return new Response("Unavailable", { status: 503 });
      const groups = JSON.parse(body.state).claims;
      const answers = Object.fromEntries(groups.map((group) => [String(group.claimIndex),
        answer(group.claimIndex === 1 && initialLocated ? (reviewed ? "refutes" : "unclear") : "supports")]));
      reviewed = true;
      return new Response(JSON.stringify({ answers }));
    }
    const recovering = body.instructions.startsWith("Você recupera evidências documentais");
    const result = recovering ? {
      sources: [{ url: repair === "unproven-url" ? `http://127.0.0.1:${port}/unopened` : documentUrl, outlet: "Associação" }],
      claims: [{ claimIndex: 1, text: "A candidata executou a reforma.", status: "true", referencePeriod: { start: "2030-01-01", end: "2030-01-01" },
        evidence: [{ source: 1, relation: "supports", quote: repair === "invented" ? "A reforma foi aprovada e executada integralmente em todos os estados brasileiros." : quote }] }],
      missingClaims: omitted ? [{ text, inputQuote: text, evidence: [] }] : [],
    } : {
      outcome: "checked", omittedClaimsCount: 0,
      claims: [
        { text: "A candidata recebeu o Projeto Horizonte.", status: "true", evidence: [{ source: 1, quote: receipt, relation: "supports" }] },
        ...(!omitted ? [{ text, status: initialStatus, referencePeriod: null, evidence: [{ evidenceId: "proposal", source: initialLocated ? 1 : 2, quote, relation: "supports" }] }] : []),
      ],
      sources: [{ url: documentUrl, outlet: "Associação" }, { url: blockedUrl, outlet: "Fonte indisponível" }],
    };
    return new Response(JSON.stringify({ output: [
      { type: "web_search_call", status: "completed", action: { type: "search", sources: recovering ? [] : [{ url: documentUrl }, { url: blockedUrl }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] },
    ] }));
  };
  try {
    return { ...await runVerify({ kind: "text", text: `${text} Registro de controle ${port}.` }), documentRequests };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test("recupera prova de outra passagem obtida sem transferir veredito ou mudar hipótese", async (t) => {
  const out = await scenario(t, { initialStatus: "unproven" });
  assert.equal(out.result.claims[1].text, text);
  assert.equal(out.result.claims[1].referencePeriod, null);
  assert.deepEqual(out.result.claims.map((claim) => claim.status), ["true", "true"]);
  assert.equal(out.result.claims[1].evidence.filter((item) => item.verification === "verified")[0].quote, quote);
  assert.equal(out.result.score, 95);
});

for (const repair of ["invented", "unproven-url"]) test(`recuperação ${repair} não transforma candidato em prova`, async (t) => {
  const out = await scenario(t, { repair, initialStatus: "unproven" });
  assert.deepEqual(out.result.claims.map((claim) => claim.status), ["true", "unproven"]);
  assert.equal(out.result.score, 95);
  assert.equal(out.result.claims[1].score, null);
  assert.equal(out.result.claims[1].text, text);
});

test("revisão opcional inconclusiva preserva a pesquisa sem rejulgar o mesmo conjunto até inverter", async (t) => {
  const out = await scenario(t, { initialLocated: true });
  assert.equal(out.result.claims[1].status, "true");
  assert.equal(out.result.claims[1].assessmentBasis, "web_research");
  assert.equal(out.result.claims[0].status, "true");
});

test("cobertura confere omissão mesmo quando todas as afirmações iniciais foram confirmadas", async (t) => {
  const out = await scenario(t, { omitted: true });
  assert.deepEqual(out.result.claims.map((claim) => claim.status), ["true", "unproven"]);
  assert.equal(out.result.claims[1].text, text);
  assert.equal(out.result.score, 95);
  assert.equal(out.result.claims[1].score, null);
  assert.equal(out.result.coverage.total, 2);
});

test("pesquisa citada funciona sem requisição documental no padrão atual", async (t) => {
  const out = await scenario(t, { collector: null });
  assert.equal(out.documentRequests, 0);
  assert.deepEqual(out.result.claims.map((claim) => claim.status), ["true", "true"]);
  assert.ok(out.result.claims.every((claim) => claim.assessmentBasis === "web_research"));
  assert.ok(out.result.claims.flatMap((claim) => claim.evidence).every((item) => item.verification === "research"));
});

test("HTTP 403 na auditoria opt-in não apaga pesquisa com fontes citadas", async (t) => {
  const out = await scenario(t);
  assert.equal(out.result.claims[1].status, "true");
  assert.equal(out.result.claims[1].assessmentBasis, "web_research");
  assert.equal(out.result.claims[1].evidence[0].verification, "research");
  assert.ok(out.evidence.documents.some((doc) => doc.status === 403));
});

test("indisponibilidade do JEV opcional mantém avaliação primária e não inventa verificação", async (t) => {
  const out = await scenario(t, { initialLocated: true, reviewUnavailable: true });
  assert.deepEqual(out.result.claims.map((claim) => claim.status), ["true", "true"]);
  assert.ok(out.result.claims.every((claim) => claim.assessmentBasis === "web_research"));
  assert.ok(out.result.claims.flatMap((claim) => claim.evidence).every((item) => item.verification !== "verified"));
});

test("recuperação preserva operandos existentes e só substitui citação ausente de mesmo identificador", () => {
  const original = { claims: [{ text, comparison: { rows: [{ evidenceId: "annual" }] }, evidence: [{ evidenceId: "annual", sourceId: 0, quote: "Citação incorreta", relation: "context" }] }], sources: [{ url: "https://source.test/report" }] };
  const response = { sources: [{ url: "https://other.test/report" }], claims: [{ claimIndex: 0, evidence: [{ evidenceId: "annual", source: 1, relation: "supports", quote }] }] };
  const merged = mergeEvidenceResearch(original, response, [0], [{ claimIndex: 0, evidenceIndex: 0, locator: { found: false } }]);
  assert.equal(merged.claims[0].evidence[0].evidenceId, "annual");
  assert.equal(merged.claims[0].evidence[0].quote, quote);
  assert.deepEqual(merged.claims[0].comparison, original.claims[0].comparison);
  const duplicates = mergeEvidenceResearch(original, { ...response, claims: [...response.claims, ...response.claims] }, [0]);
  assert.equal(duplicates.claims[0].evidence[0].quote, "Citação incorreta");
});

test("mudança de ordem ou duplicata não conta como evidência nova; mudança de período conta", () => {
  const a = { claimIndex: 0, locator: { found: true }, quote, excerpt: quote, document: { url: "https://source.test/report" } };
  assert.deepEqual(changedEvidenceClaims([a], [a, a], [0]), []);
  assert.deepEqual(changedEvidenceClaims([a], [{ ...a, referencePeriod: { start: "2020-01-01", end: "2020-01-01" } }], [0]), [0]);
  assert.deepEqual(changedEvidenceClaims([a], [{ ...a, document: { ...a.document, lead: "A reportagem trata de outra associação e de outra proposta." } }], [0]), [0]);
  assert.deepEqual(changedEvidenceClaims([a], [{ ...a, locator: { found: false } }], [1]), []);
});

test("cobertura não injeta afirmações ancoradas apenas em texto inexistente ou duplicado", () => {
  const original = { claims: [{ text, evidence: [] }], sources: [] };
  const material = "O Projeto Horizonte inclui BPC abaixo do salário mínimo.";
  const merged = mergeEvidenceResearch(original, { missingClaims: [
    { text: "O Projeto Horizonte inclui BPC abaixo do salário mínimo.", inputQuote: material, status: "true", evidence: [] },
    { text: "O projeto foi aprovado em 2030.", inputQuote: "O projeto foi aprovado em 2030.", evidence: [] },
    { text, inputQuote: material, evidence: [] },
  ] }, [], [], material);
  assert.equal(merged.claims.length, 2);
  assert.equal(merged.claims[1].status, "unproven");
  assert.equal(merged.claims[1].originalText, material);
});
