import assert from "node:assert/strict";
import test from "node:test";
import { buildShareText, renderShareCards } from "../src/lib/shareCard.js";
import { VERDICTS, evidenceReviewLabel, evidenceVerificationLabel } from "../src/data/constants.js";

const result = {
  id: "checagem/123", title: "Checagem: é verdade que houve pagamento?", outcome: "checked",
  verdict: "unproven", score: 42,
  summary: "A reportagem documenta um pedido de financiamento, mas não demonstra transferência ou recebimento.",
  claims: [{
    text: "A pessoa recebeu financiamento do empresário.", status: "unproven", score: 42,
    note: "As mensagens registram um pedido; não há comprovante de transferência.",
    evidence: [{ sourceId: 0, relation: "context", quote: "The messages describe a request for funding." }],
  }],
  sources: [{ outlet: "Arquivo público", url: "https://example.com/documentos" }],
};


test("texto compartilhado inclui conclusão, limite e endereço de correções", () => {
  const text = buildShareText(result, { origin: "https://example.com", pathname: "/" });
  assert.match(text, /recebeu financiamento/);
  assert.match(text, /42\/100/);
  assert.match(text, /não demonstra transferência ou recebimento/);
  const correctionUrl = new URL(text.match(/https:\/\/example\.com\/correcoes\.html\S+/)?.[0]);
  assert.equal(correctionUrl.pathname, "/correcoes.html");
  assert.equal(correctionUrl.searchParams.get("checkId"), result.id);
  assert.doesNotMatch(text, /é verdade que houve pagamento/);
});

test("abstenção não recebe nota ou selo factual no texto de compartilhamento", () => {
  const abstention = { title: "Arquivo sem conteúdo legível", score: null, verdict: null, claims: [], summary: "O arquivo não contém texto legível suficiente." };
  const text = buildShareText(abstention, { origin: "https://example.com" });
  assert.match(text, /não contém texto legível/);
  assert.match(text, /sem nota \(registro anterior\)/i);
  assert.doesNotMatch(text, /nota\s*(?:null|\d+)|\d+\/100/i);
  for (const { label } of Object.values(VERDICTS)) assert.ok(!text.includes(label));
});

test("sem comprovação compartilha a nota da faixa decidida pelo modelo", () => {
  const text = buildShareText(result, { origin: "https://example.com", pathname: "/" });
  assert.match(text, /Sem comprovação · nota 42\/100/);
  assert.match(text, /SEM COMPROVAÇÃO · 42\/100/);
  assert.match(text, /a nota não é probabilidade calibrada/);
  assert.doesNotMatch(text, /sem nota/i);
});

test("registro anterior sem nota indica legado em vez de número", () => {
  const legacy = { ...result, verdict: "unproven", score: null, methodologyVersion: "fact-check-18", claims: [{ ...result.claims[0], score: null }] };
  const text = buildShareText(legacy, { origin: "https://example.com", pathname: "/" });
  assert.match(text, /sem nota \(registro anterior\)/i);
  assert.doesNotMatch(text, /\d+\/100/);
});

const researchResult = () => ({
  ...result, verdict: "true", score: 95,
  claims: [{
    text: "A alegação é sustentada pelas fontes citadas.", status: "true", score: 95,
    assessmentBasis: "web_research", assessmentNote: "Avaliação da pesquisa; documento não obtido pelo coletor.",
    evidenceSupport: "supports", sourceIds: [0],
    evidenceReview: { verification: "unavailable", verdict: "unclear", incomplete: true },
    evidence: [{ sourceId: 0, relation: "supports", verification: "research", quote: "A pesquisa informa este trecho da fonte citada." }],
  }],
});

test("research-confirmed sharing states its tier and never calls the quote independently verified", () => {
  const researched = researchResult();
  for (const verification of ["unavailable", "unclear"]) {
    researched.claims[0].evidenceReview.verification = verification;
    const shared = buildShareText(researched);
    assert.match(shared, /VERDADE.*95\/100/);
    assert.match(shared, /Base da avaliação: Pesquisa com fontes citadas/);
    assert.match(shared, /Trecho informado pela pesquisa · sem conferência documental independente/);
    assert.match(shared, /Revisão documental opcional:/);
    assert.doesNotMatch(shared, /Relação verificada|Trecho do conjunto revisado|trecho original|Inconclusiva|inconclusiva/);
    assert.equal(evidenceVerificationLabel(researched.claims[0], researched.claims[0].evidence[0]),
      "Trecho informado pela pesquisa · sem conferência documental independente");
  }
  assert.equal(evidenceReviewLabel(researchResult().claims[0]), "Revisão documental opcional: não realizada/indisponível.");
});

test("historical documentary sharing keeps reviewed quote labels without inferring research basis", () => {
  const documentary = structuredClone(result);
  documentary.claims[0].evidenceReview = { verification: "verified", verdict: "context", note: "Limite documental histórico." };
  documentary.claims[0].evidence[0].verification = "verified";
  const shared = buildShareText(documentary);
  assert.match(shared, /Revisão do conjunto: Contextualiza/);
  assert.match(shared, /Trecho do conjunto revisado/);
  assert.match(shared, /Limite documental histórico/);
  assert.doesNotMatch(shared, /Base da avaliação: Pesquisa/);
});

test("PNG cards visibly disclose research-primary assessment", async () => {
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const painted = [];
  const context = {
    measureText(value) { return { width: String(value).length * 10 }; },
    fillText(value) { painted.push(String(value)); },
    fillRect() {}, beginPath() {}, arc() {}, fill() {},
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    fonts: { async load() {}, ready: Promise.resolve() },
    createElement() { return { getContext() { return context; }, toBlob(callback) { callback(new Blob(["PNG"], { type: "image/png" })); } }; },
  } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { host: "example.org" } });
  try {
    const cards = await renderShareCards(researchResult());
    assert.ok(cards.length > 0);
    const content = painted.join(" ");
    assert.match(content, /Pesquisa com fontes citadas/);
    assert.match(content, /sem conferência documental independente/);
    assert.doesNotMatch(content, /Relação verificada|Trecho do conjunto revisado/);
  } finally {
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument); else delete globalThis.document;
    if (beforeLocation) Object.defineProperty(globalThis, "location", beforeLocation); else delete globalThis.location;
  }
});
