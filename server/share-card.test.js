import assert from "node:assert/strict";
import test from "node:test";
import { buildShareText } from "../src/lib/shareCard.js";
import { VERDICTS } from "../src/data/constants.js";

const result = {
  id: "checagem/123", title: "Checagem: é verdade que houve pagamento?", outcome: "checked",
  verdict: "unproven", score: 45,
  summary: "A reportagem documenta um pedido de financiamento, mas não demonstra transferência ou recebimento.",
  claims: [{
    text: "A pessoa recebeu financiamento do empresário.", status: "unproven", score: 45,
    note: "As mensagens registram um pedido; não há comprovante de transferência.",
    evidence: [{ sourceId: 0, relation: "context", quote: "The messages describe a request for funding." }],
  }],
  sources: [{ outlet: "Arquivo público", url: "https://example.com/documentos" }],
};


test("texto compartilhado inclui conclusão, limite e endereço de correções", () => {
  const text = buildShareText(result, { origin: "https://example.com", pathname: "/" });
  assert.match(text, /recebeu financiamento/);
  assert.match(text, /45\/100/);
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
  assert.doesNotMatch(text, /nota\s*(?:null|\d+)|\d+\/100/i);
  for (const { label } of Object.values(VERDICTS)) assert.ok(!text.includes(label));
});
