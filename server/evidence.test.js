// Regressões do dossiê de evidências: extração de texto (HTML/PDF), tetos de
// transferência, localização de trechos e rebaixamento por revisão de fidelidade.
process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
const evidence = await import("./evidence.js");

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { clip, decodeEntities, locateQuote } from "./text.js";
import { validateResult } from "./scoring.js";

const MINIMAL_PDF = (text) => {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF
`, "latin1");
};

const htmlResponse = (body, type = "text/html; charset=utf-8") => ({ headers: { "content-type": type }, body: Buffer.from(body, "utf8") });

test("extrai texto de HTML e de PDF, e recusa formatos sem texto", async () => {
  const html = await evidence.extractDocumentText(htmlResponse("<html><body><p>O instituto divulgou 52% na rodada de outubro.</p></body></html>"));
  assert.equal(html.ok, true);
  assert.equal(html.kind, "html");
  assert.match(html.text, /52%/);

  const pdf = await evidence.extractDocumentText({ headers: { "content-type": "application/pdf" }, body: MINIMAL_PDF("Rodada de outubro com 52 por cento das intencoes de voto") });
  assert.equal(pdf.ok, true);
  assert.equal(pdf.kind, "pdf");
  assert.match(pdf.text, /52 por cento/);

  const zip = await evidence.extractDocumentText({ headers: { "content-type": "application/zip" }, body: Buffer.from("PK\u0003\u0004lixo") });
  assert.equal(zip.ok, false);
  assert.match(zip.reason, /unsupported-type/);

  const curto = await evidence.extractDocumentText(htmlResponse("<html><body>oi</body></html>"));
  assert.equal(curto.ok, false);
  assert.equal(curto.reason, "document-too-short");
});

async function comServidor(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const previousPorts = process.env.IEV_HTTP_PORTS;
  process.env.IEV_HTTP_PORTS = String(port);
  try {
    return await fn(port);
  } finally {
    if (previousPorts === undefined) delete process.env.IEV_HTTP_PORTS;
    else process.env.IEV_HTTP_PORTS = previousPorts;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("fetchDocument obtém documento, respeita teto e registra recusas", async () => {
  await comServidor((req, res) => {
    if (req.url === "/noticia") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><article>O instituto divulgou 52% das intenções de voto na rodada de outubro, contra 48%.</article></body></html>");
      return;
    }
    if (req.url === "/relatorio.pdf") {
      const pdf = MINIMAL_PDF("Pesquisa de outubro registrada com 52 por cento");
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(pdf.length) });
      res.end(pdf);
      return;
    }
    if (req.url === "/gigante") {
      const body = `<html><body><article>${"x".repeat(900_000)}</article></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("não encontrado");
  }, async (port) => {
    const ok = await evidence.fetchDocument(`http://127.0.0.1:${port}/noticia`, { config: evidence.evidenceConfig({ IEV_MAX_DOC_BYTES: "500000" }) });
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, "html");
    assert.match(ok.text, /52%/);

    const pdf = await evidence.fetchDocument(`http://127.0.0.1:${port}/relatorio.pdf`, { config: evidence.evidenceConfig({ IEV_MAX_DOC_BYTES: "500000" }) });
    assert.equal(pdf.ok, true);
    assert.equal(pdf.kind, "pdf");

    const grande = await evidence.fetchDocument(`http://127.0.0.1:${port}/gigante`, { config: evidence.evidenceConfig({ IEV_MAX_DOC_BYTES: "1000" }) });
    assert.equal(grande.ok, true);
    assert.equal(grande.truncated, true);
    assert.equal(grande.bytes, 1000);
    assert.ok(grande.text.length > 40);

    const faltando = await evidence.fetchDocument(`http://127.0.0.1:${port}/nada`, { config: evidence.evidenceConfig() });
    assert.equal(faltando.ok, false);
    assert.equal(faltando.reason, "http-404");
  });
});

test("extrai entidades latinas preservando caixa e localiza citação no HTML", async () => {
  const quote = "Ação, Órgão e São Paulo: preço & qualidade";
  const extracted = await evidence.extractDocumentText(htmlResponse(
    "<html><body><article>A&ccedil;&atilde;o, &Oacute;rg&atilde;o e S&atilde;o Paulo: pre&ccedil;o &amp; qualidade; &#231; &unknown;</article></body></html>",
  ));
  assert.equal(extracted.ok, true);
  assert.match(extracted.text, /Ação, Órgão e São Paulo: preço & qualidade; ç &unknown;/);
  const located = await evidence.collectEvidence({
    sources: [{ url: "https://example.test/artigo" }],
    claims: [{ evidence: [{ sourceId: 0, relation: "supports", quote }] }],
    fetchImpl: async (url) => ({ ok: true, url, kind: "html", text: extracted.text }),
  });
  assert.equal(located.citations[0].locator.found, true);
  assert.equal(located.citations[0].locator.kind, "exact");
  assert.equal(decodeEntities("&Aacute;&aacute;&Otilde;&otilde;&copy;&unknown;&#231;"), "ÁáÕõ©&unknown;ç");
});

test("listas null ou ausentes são listas vazias nos contratos do dossiê", async () => {
  assert.deepEqual(evidence.prioritizeSources(null, null), []);
  assert.deepEqual(evidence.prioritizeSources(undefined, undefined), []);
  const dossier = await evidence.collectEvidence({ sources: null, claims: null });
  assert.deepEqual(dossier.documents, []);
  assert.deepEqual(dossier.citations, []);
  assert.deepEqual(evidence.reviewableCitations(null), []);
  assert.equal(evidence.buildReviewInput({ claims: null, citations: null }), null);
  const reviewed = evidence.applyReview({ claims: null, citations: null });
  assert.deepEqual(reviewed.claims, []);
  assert.deepEqual(reviewed.corrections, []);
  assert.equal(reviewed.summary.reviewed, 0);
});

test("clip respeita limites zero, negativos e positivos", () => {
  assert.equal(clip("abcdef", 0), "");
  assert.equal(clip("abcdef", -1), "");
  assert.equal(clip("abcdef", 1), "…");
  assert.equal(clip("abc", 3), "abc");
  assert.equal(clip("abcdef", 4), "abc…");
});

test("citações longas só são confirmadas por correspondência completa", () => {
  const tokens = Array.from({ length: 500 }, (_, index) => `palavra${index}`);
  const fullQuote = tokens.join(" ");
  const full = locateQuote(`Antes: ${fullQuote} depois.`, fullQuote);
  assert.equal(full.found, true);
  assert.equal(full.kind, "exact");

  const longQuote = Array.from({ length: 40 }, (_, index) => `termo${index}`).join(" ");
  const misleadingPrefix = longQuote.split(" ").slice(0, 37).join(" ");
  const partial = locateQuote(misleadingPrefix, longQuote);
  assert.equal(partial.found, false);
  assert.equal(partial.kind, "prefix");

  const noThreshold = locateQuote("documento sem relação com o trecho alegado", fullQuote);
  assert.equal(noThreshold.found, false);
});

test("prioriza fontes de claims decididos e coleta trechos localizados", async () => {
  const sources = [
    { url: "https://a.example/contexto", outlet: "A" },
    { url: "https://b.example/principal", outlet: "B" },
  ];
  const claims = [
    { status: "true", evidence: [{ sourceId: 1, relation: "supports", quote: "o instituto divulgou 52% das intenções de voto na rodada de outubro" }] },
    { status: "context", evidence: [{ sourceId: 0, relation: "context", quote: "" }] },
  ];
  assert.deepEqual(evidence.prioritizeSources(sources, claims).map((source) => source.sourceId), [1, 0]);

  const documentos = {
    "https://b.example/principal": "O instituto divulgou 52% das intenções de voto, na rodada de outubro, contra 48% do adversário.",
    "https://a.example/contexto": "Página sem relação com o número citado.",
  };
  const dossier = await evidence.collectEvidence({
    sources,
    claims,
    config: evidence.evidenceConfig({ IEV_EVIDENCE_MAX_DOCS: "4" }),
    fetchImpl: async (url) => ({ ok: true, url, kind: "html", text: documentos[url], bytes: 100 }),
  });
  assert.equal(dossier.summary.documents, 2);
  assert.equal(dossier.summary.citations, 2);
  assert.equal(dossier.summary.located, 1);
  assert.equal(dossier.summary.missing, 0, "citação sem trecho é estado próprio, não 'não localizada'");
  const principal = dossier.citations.find((citation) => citation.sourceId === 1);
  assert.equal(principal.locator.found, true);
  assert.ok(["exact", "normalized", "approximate"].includes(principal.locator.kind));
  const semTrecho = dossier.citations.find((citation) => citation.sourceId === 0);
  assert.equal(semTrecho.locator.kind, "empty_quote");
});

test("dossiê respeita teto de documentos e orçamento de bytes", async () => {
  const sources = Array.from({ length: 5 }, (_, index) => ({ url: `https://s${index}.example/x`, outlet: `S${index}` }));
  const claims = sources.map((_, index) => ({ status: "true", evidence: [{ sourceId: index, relation: "supports", quote: "trecho citado de teste com mais de oito caracteres" }] }));
  let chamadas = 0;
  const dossier = await evidence.collectEvidence({
    sources,
    claims,
    config: evidence.evidenceConfig({ IEV_EVIDENCE_MAX_DOCS: "2" }),
    fetchImpl: async (url) => { chamadas++; return { ok: false, url, reason: "blocked:private_address" }; },
  });
  assert.equal(chamadas, 2);
  assert.equal(dossier.summary.blocked, 2);
  assert.equal(dossier.documents.length, 2);
});

test("conjunto de dois operandos sustenta claim sem atribuir conclusão a cada trecho", () => {
  const quotes = ["O grupo A registrou 20 hectares em 2020.", "O grupo B registrou 10 hectares em 2021."];
  const claim = { text: "A teve mais área queimada que B.", status: "true", sourceIds: [0, 1],
    evidence: quotes.map((quote, sourceId) => ({ sourceId, evidenceId: `e${sourceId + 1}`, relation: "supports", quote })) };
  const citations = quotes.map((quote, evidenceIndex) => ({ claimIndex: 0, evidenceIndex, quote, excerpt: quote, locator: { found: true } }));
  const applied = evidence.applyReview({ claims: [claim], citations, review: { claims: [{ claimIndex: 0, verdict: "supports" }] } });
  assert.equal(applied.claims[0].status, "true");
  assert.equal(applied.claims[0].text, claim.text);
  assert.equal(applied.claims[0].evidenceReview.verdict, "supports");
  assert.deepEqual(applied.claims[0].evidence.map((item) => item.relation), ["context", "context"]);
  assert.deepEqual(applied.claims[0].evidence.map((item) => item.verification), ["verified", "verified"]);
  const { fixed } = validateResult({ outcome: "checked", claims: applied.claims, sources: [{}, {}] });
  assert.equal(fixed.claims[0].status, "true");
  assert.equal(fixed.claims[0].evidenceSupport, "supports");
  assert.equal(fixed.score, 95);
});

for (const status of ["true", "false"]) {
  test(`contexto agrupado não mantém classificação decisiva ${status}`, () => {
    const quote = "A pessoa pediu apoio financeiro; a notícia não documenta pagamento.";
    const claim = { text: "A pessoa recebeu o dinheiro.", status, sourceIds: [0], evidence: [{ sourceId: 0, relation: "supports", quote }] };
    const applied = evidence.applyReview({
      claims: [claim],
      citations: [{ claimIndex: 0, evidenceIndex: 0, quote, excerpt: quote, locator: { found: true } }],
      review: { claims: [{ claimIndex: 0, verdict: "context", note: "O pedido não documenta recebimento." }] },
    });
    assert.equal(applied.claims[0].status, "unproven");
    assert.equal(applied.claims[0].evidenceReview.verdict, "context");
    const { fixed } = validateResult({ outcome: "checked", claims: applied.claims, sources: [{}] });
    assert.equal(fixed.score, null);
  });
}

test("nenhum excerpt não localizado participa como prova, mesmo com resultado supports", () => {
  const quote = "Trecho atribuído a uma página que recusou acesso.";
  for (const locator of [{ found: false }, undefined]) {
    const applied = evidence.applyReview({
      claims: [{ text: "A afirmação foi comprovada.", status: "true", sourceIds: [0], evidence: [{ sourceId: 0, relation: "supports", quote }] }],
      citations: [{ claimIndex: 0, evidenceIndex: 0, quote, excerpt: quote, locator }],
      review: { claims: [{ claimIndex: 0, verdict: "supports" }] },
    });
    assert.equal(applied.claims[0].status, "unproven");
    assert.equal(applied.claims[0].evidence[0].verification, "unavailable");
    const { fixed } = validateResult({ outcome: "checked", claims: applied.claims, sources: [{}] });
    assert.equal(fixed.claims[0].evidenceSupport, "insufficient");
  }
});

test("limite da revisão marca grupo incompleto e não sustenta claim", () => {
  const quote = "Trecho documental com dados anuais.";
  const citations = [0, 1].map((evidenceIndex) => ({ claimIndex: 0, evidenceIndex, quote, excerpt: quote, locator: { found: true } }));
  const claims = [{ text: "A supera B", status: "true", evidence: [{ quote }, { quote }] }];
  const config = { ...evidence.evidenceConfig(), maxReviewItems: 1 };
  const groups = evidence.buildReviewGroups({ claims, citations, config });
  assert.equal(groups[0].incomplete, true);
  assert.equal(groups[0].locatedCount, 2);
  const applied = evidence.applyReview({ claims, citations, config, review: { claims: [{ claimIndex: 0, verdict: "supports" }] } });
  assert.equal(applied.claims[0].status, "unproven");
  assert.equal(applied.claims[0].evidenceReview.incomplete, true);
});

test("revisão por claim é independente, duplicatas e falhas não confirmam", () => {
  const quote = "Uma estimativa foi apresentada em audiência pública.";
  const claims = [0, 1].map((sourceId) => ({ text: "A estimativa ocorreu.", status: "true", sourceIds: [sourceId], evidence: [{ sourceId, relation: "supports", quote }] }));
  const citations = [0, 1].map((claimIndex) => ({ claimIndex, evidenceIndex: 0, quote, excerpt: quote, locator: { found: true } }));
  const applied = evidence.applyReview({ claims, citations, review: { claims: [{ claimIndex: 0, verdict: "supports" }, { claimIndex: 1, verdict: "context" }] } });
  assert.deepEqual(applied.claims.map((claim) => claim.status), ["true", "unproven"]);
  for (const review of [null, { claims: [{ claimIndex: 0, verdict: "supports" }, { claimIndex: 0, verdict: "refutes" }] }]) {
    const failed = evidence.applyReview({ claims, citations, review });
    assert.equal(failed.claims[0].status, "unproven");
  }
});

test("dossiê localiza corpo e título JSON-LD, sem aceitar outros scripts como texto", async () => {
  const title = "Senadora promete apoiar a proposta na votação";
  const quote = "A senadora declarou que apoiará a proposta de jornada nesta votação.";
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: title, datePublished: "2026-10-10", articleBody: quote })}</script><script>prova inventada em script</script></head></html>`;
  const document = await evidence.extractDocumentText(htmlResponse(html));
  assert.equal(document.ok, true);
  assert.ok(locateQuote(document.text, title).found);
  assert.ok(locateQuote(document.text, quote).found);
  assert.match(document.text, /2026-10-10/);
  assert.doesNotMatch(document.text, /prova inventada/);
});

test("páginas de vídeo sem transcrição preservam impossibilidade e não participam da revisão", async () => {
  const url = "https://www.youtube.com/shorts/fixture";
  const claims = [{ text: "A senadora anunciou a revisão.", status: "true", sourceIds: [0],
    evidence: [{ sourceId: 0, quote: "A senadora anunciou a revisão da proposta.", relation: "supports" }] }];
  const dossier = await evidence.collectEvidence({ sources: [{ url, outlet: "Vídeo" }], claims });
  assert.equal(dossier.documents[0].ok, false);
  assert.equal(dossier.documents[0].reason, "media-transcript-unavailable");
  assert.equal(dossier.summary.located, 0);
  assert.equal(evidence.buildReviewInput({ claims, citations: dossier.citations }), null);
  const research = evidence.buildResearchEvidence(dossier, claims);
  assert.deepEqual(research.gaps[0].reasons, ["media-transcript-unavailable"]);
  const applied = evidence.applyReview({ claims, citations: dossier.citations });
  assert.equal(applied.claims[0].status, "unproven");
  assert.match(applied.claims[0].note, /não forneceram transcrição/);
  assert.equal(applied.claims[0].evidence[0].verification, "unavailable");
  assert.equal(validateResult({ outcome: "checked", claims: applied.claims, sources: [{ url }] }).fixed.score, null);
});

test("prévia e dossiê final compartilham documentos, teto e orçamento de bytes", async () => {
  const calls = [];
  const config = { ...evidence.evidenceConfig(), maxDocuments: 2, maxTotalBytes: 1000 };
  const fetchDocument = evidence.createEvidenceFetcher(config, async (url, { budget }) => {
    calls.push({ url, budget });
    return { ok: true, url, kind: "html", text: "Texto documental disponível para localização literal." };
  });
  const first = await Promise.all([fetchDocument("https://example.com/a"), fetchDocument("https://example.com/a")]);
  assert.strictEqual(first[0], first[1]);
  await fetchDocument("https://example.com/b");
  assert.equal((await fetchDocument("https://example.com/c")).reason, "document-limit");
  assert.deepEqual(calls.map((item) => item.url), ["https://example.com/a", "https://example.com/b"]);
  assert.strictEqual(calls[0].budget, calls[1].budget);
});

test("comparação qualitativa recebe os dois lados sem exigir cálculo anual", () => {
  const quotes = ["A senadora apoiou a votação da proposta.", "A senadora anunciou que proporá revisar o texto no ano seguinte."];
  const claims = [{ text: "As duas posições da senadora são incompatíveis.", status: "unproven", comparison: null,
    evidence: quotes.map((quote, sourceId) => ({ sourceId, quote, relation: "context" })) }];
  const citations = quotes.map((quote, evidenceIndex) => ({ claimIndex: 0, evidenceIndex, sourceId: evidenceIndex, quote, excerpt: quote, locator: { found: true } }));
  const groups = evidence.buildReviewGroups({ claims, citations });
  assert.equal(groups[0].snippets.length, 2);
  assert.equal(groups[0].comparison, null);
  const applied = evidence.applyReview({ claims, citations, review: { claims: [{ claimIndex: 0, verdict: "context", note: "Votação atual e revisão futura são ações diferentes." }] } });
  assert.equal(applied.claims[0].evidenceReview.verification, "verified");
  assert.equal(applied.claims[0].status, "unproven");
  assert.equal(validateResult({ outcome: "checked", claims: applied.claims, sources: [{}, {}] }).fixed.score, null);
});

test("metadados estruturados sem articleBody documentam apenas título e data", async () => {
  const title = "Jornal publica entrevista sobre proposta de jornada e votação";
  const result = await evidence.extractDocumentText(htmlResponse(`<html><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: title, datePublished: "2026-10-12" })}</script></html>`));
  assert.equal(result.ok, true);
  assert.ok(locateQuote(result.text, title).found);
  assert.equal(locateQuote(result.text, "A entrevistada confirmou a promessa de votar favoravelmente.").found, false);
});
