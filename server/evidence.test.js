// Regressões do dossiê de evidências: extração de texto (HTML/PDF), tetos de
// transferência, localização de trechos e rebaixamento por revisão de fidelidade.
process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
const evidence = await import("./evidence.js");

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { clip, decodeEntities, locateQuote } from "./text.js";
import { rebuildResultSummary, validateResult } from "./scoring.js";

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
  process.env.IEV_HTTP_PORTS = String(port);
  try {
    return await fn(port);
  } finally {
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

test("revisão de fidelidade rebaixa citação não confirmada e preserva confirmada", () => {
  const claims = [
    { status: "true", evidence: [{ sourceId: 0, relation: "supports", quote: "trecho do documento sobre a pesquisa" }] },
    { status: "false", evidence: [{ sourceId: 1, relation: "refutes", quote: "trecho do documento sobre o outro número" }] },
    { status: "true", evidence: [{ sourceId: 2, relation: "supports", quote: "trecho do terceiro documento" }] },
  ];
  const citations = [
    { claimIndex: 0, evidenceIndex: 0, sourceId: 0, relation: "supports", quote: "trecho do documento sobre a pesquisa", excerpt: "trecho do documento sobre a pesquisa" },
    { claimIndex: 1, evidenceIndex: 0, sourceId: 1, relation: "refutes", quote: "trecho do documento sobre o outro número", excerpt: "trecho do documento sobre o outro número" },
    { claimIndex: 2, evidenceIndex: 0, sourceId: 2, relation: "supports", quote: "trecho do terceiro documento", excerpt: "trecho do terceiro documento" },
  ];
  const applied = evidence.applyReview({
    claims,
    citations,
    review: { items: [{ id: 1, verdict: "supports" }, { id: 2, verdict: "unclear" }, { id: 3, verdict: "contradicts" }] },
    config: evidence.evidenceConfig(),
  });
  assert.equal(applied.claims[0].status, "true");
  assert.equal(applied.claims[1].status, "unproven");
  assert.equal(applied.claims[2].status, "unproven");
  assert.match(applied.claims[2].note, /diz algo diferente/);
  assert.equal(applied.downgraded.length, 2);
  assert.ok(applied.corrections.some((message) => /revisão de fidelidade/.test(message)));
  assert.match(evidence.evidenceNote({ enabled: true, citations: 3, located: 2, missing: 1, blocked: 1 }), /2\/3 trecho/);
  assert.equal(evidence.evidenceNote({ enabled: true, citations: 0 }), "");
});

test("prompt de revisão só inclui citações com trecho localizado", () => {
  const input = evidence.buildReviewInput({
    claims: [{ text: "afirmação" }],
    citations: [
      { claimIndex: 0, evidenceIndex: 0, quote: "citação localizada", excerpt: "trecho localizado no documento" },
      { claimIndex: 0, evidenceIndex: 1, quote: "citação ausente", excerpt: null },
    ],
  });
  assert.match(input, /citação localizada/);
  assert.doesNotMatch(input, /citação ausente/);
  assert.equal(evidence.buildReviewInput({ claims: [], citations: [] }), null);
});

for (const status of ["true", "false"]) {
  test(`contexto não mantém classificação decisiva ${status}`, () => {
    const relation = status === "true" ? "supports" : "refutes";
    const quote = "A pessoa pediu apoio financeiro; a notícia não documenta pagamento.";
    const claim = {
      text: "A pessoa recebeu o dinheiro.", status, score: status === "true" ? 95 : 5,
      sourceIds: [0], note: "O recebimento foi confirmado.", evidence: [{ sourceId: 0, relation, quote }],
    };
    const applied = evidence.applyReview({
      claims: [claim],
      citations: [{ claimIndex: 0, evidenceIndex: 0, quote, excerpt: quote }],
      review: { items: [{ id: 1, verdict: "context", note: "A notícia descreve um pedido, mas não documenta recebimento ou transferência." }] },
    });
    assert.equal(applied.claims[0].status, "unproven");
    assert.equal(applied.claims[0].evidence[0].relation, "context");
    assert.match(applied.claims[0].note, /pedido/);
    assert.ok(!applied.claims[0].note.includes(claim.note));
    const raw = {
      outcome: "checked", claims: applied.claims, sources: [{ outlet: "Notícia", url: "https://example.com/noticia" }],
      summary: rebuildResultSummary({ claims: applied.claims }),
    };
    const { fixed } = validateResult(raw);
    assert.equal(fixed.verdict, "unproven");
    assert.ok([35, 45].includes(fixed.score));
    assert.ok(fixed.summary.length > 0);
    assert.match(fixed.summary, /recebeu o dinheiro/);
    assert.match(fixed.summary, /pedido/);
    assert.ok(!fixed.summary.includes(claim.note));
  });
}

test("revisão preserva suporte confirmado e retira suporte de trecho inconclusivo", () => {
  const quote = "Documento sobre o mesmo evento público.";
  const applied = evidence.applyReview({
    claims: [{ status: "true", evidence: [
      { sourceId: 0, relation: "supports", quote },
      { sourceId: 1, relation: "supports", quote },
    ] }],
    citations: [0, 1].map((evidenceIndex) => ({ claimIndex: 0, evidenceIndex, quote, excerpt: quote })),
    review: { items: [{ id: 1, verdict: "supports" }, { id: 2, verdict: "unclear" }] },
  });
  assert.equal(applied.claims[0].status, "true");
  assert.deepEqual(applied.claims[0].evidence.map((item) => item.relation), ["supports", "context"]);
  assert.deepEqual(applied.downgraded, []);
});
