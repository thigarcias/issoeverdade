import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewWithJev } from "./jev.js";

const config = { maxReviewItems: 12, reviewModel: "jev-1.13-free", reviewTimeoutMs: 1000 };
const claim = { text: "O investimento causou um aumento de 25% na produção nacional em 2025." };
const citation = { claimIndex: 0, evidenceIndex: 0, locator: { found: true }, quote: "O ministro estimou um aumento de 25%.", excerpt: "O ministro estimou um aumento de 25% na produção após o investimento; o relatório não estabeleceu causalidade." };
function setEnv(t, value) {
  const previous = process.env.OPENCODE_API;
  if (value === undefined) delete process.env.OPENCODE_API;
  else process.env.OPENCODE_API = value;
  t.after(() => { if (previous === undefined) delete process.env.OPENCODE_API; else process.env.OPENCODE_API = previous; });
}
const answer = (choice, probabilities) => ({ type: "choice", choice, probabilities });
const validRefutation = answer("refutes", { supports: 0.01, refutes: 0.95, context: 0.02, unclear: 0.02 });
async function review(response, overrides = {}) {
  return reviewWithJev({ claims: [claim], citations: [citation], config, fetchImpl: async () => ({ ok: true, json: async () => response }), ...overrides });
}

test("limiares de ambiguidade incluem a fronteira decimal exata", async (t) => {
  setEnv(t, "test-only-secret");
  const cases = [
    [{ supports: 0.699999, refutes: 0.1, context: 0.2, unclear: 0.000001 }, "unclear"],
    [{ supports: 0.7, refutes: 0.3, context: 0, unclear: 0 }, "supports"],
    [{ supports: 0.72, refutes: 0.03, context: 0.21, unclear: 0.04 }, "supports"],
    [{ supports: 0.85, refutes: 0.650001, context: 0, unclear: 0 }, "unclear"],
    [{ supports: 0.85, refutes: 0.65, context: 0, unclear: 0 }, "supports"],
    [{ supports: 0.8, refutes: 0.6, context: 0, unclear: 0 }, "supports"],
  ];
  for (const [probabilities, expected] of cases) {
    const result = await review({ answers: { "0": answer("supports", probabilities) } });
    assert.equal(result.result.claims[0].verdict, expected);
    assert.equal(result.result.claims[0].claimIndex, 0);
  }
});

test("respostas ausentes ou inválidas não inventam refutação", async (t) => {
  setEnv(t, "test-only-secret");
  const responses = [null, {}, { answers: {} }, { answers: { "2": validRefutation } }];
  const invalid = [
    { ...validRefutation, type: "text" }, { ...validRefutation, choice: "insufficient" },
    { ...validRefutation, probabilities: undefined }, { ...validRefutation, probabilities: { refutes: 0.99 } },
    { ...validRefutation, probabilities: { supports: 0.01, refutes: "0.95", context: 0.02, unclear: 0.02 } },
    { ...validRefutation, probabilities: { supports: 0.01, refutes: 1.2, context: 0.02, unclear: 0.02 } },
    { ...validRefutation, probabilities: { supports: 0.01, refutes: NaN, context: 0.02, unclear: 0.02 } },
    { ...validRefutation, probabilities: { supports: 0.95, refutes: 0.01, context: 0.02, unclear: 0.02 } },
  ];
  for (const response of [...responses, ...invalid.map((value) => ({ answers: { "0": value } }))]) {
    assert.equal((await review(response)).result.claims[0].verdict, "unclear");
  }
  assert.deepEqual((await review(null, { claims: [] })).result.claims, []);
});

test("aceita refutação explícita sem propagar raciocínio inventado", async (t) => {
  setEnv(t, "test-only-secret");
  const result = await review({ answers: { "0": { ...validRefutation, reasoning: "Dado inventado: a produção caiu 74%." } } });
  assert.equal(result.result.claims[0].verdict, "refutes");
  assert.doesNotMatch(result.result.claims[0].note, /74|95|%|produção caiu/);
});

test("respostas permanecem vinculadas ao claim original quando outro claim não tem fonte", async (t) => {
  setEnv(t, "test-only-secret");
  const claims = [{ text: "Alegação sem fonte." }, { text: "A área A foi maior que B." }, { text: "A área C foi maior que D." }];
  const citations = [
    { claimIndex: 1, evidenceIndex: 0, locator: { found: true }, quote: "A: 400 hectares; B: 40 hectares.", excerpt: "A: 400 hectares; B: 40 hectares." },
    { claimIndex: 2, evidenceIndex: 0, locator: { found: true }, quote: "C: 10 hectares; D: 40 hectares.", excerpt: "C: 10 hectares; D: 40 hectares." },
  ];
  const result = await review({
    answers: {
      "0": validRefutation,
      "1": answer("supports", { supports: 0.95, refutes: 0.01, context: 0.02, unclear: 0.02 }),
      "2": validRefutation,
    },
  }, { claims, citations });
  assert.deepEqual(result.result.claims.map(({ claimIndex, verdict }) => ({ claimIndex, verdict })), [
    { claimIndex: 1, verdict: "supports" },
    { claimIndex: 2, verdict: "refutes" },
  ]);
});

test("cap de trechos marca conjunto incompleto e impede conclusão", async (t) => {
  setEnv(t, "test-only-secret");
  const result = await review({ answers: { "0": validRefutation } }, { citations: [citation, { ...citation, evidenceIndex: 1 }], config: { ...config, maxReviewItems: 1 } });
  assert.equal(result.result.claims[0].verdict, "unclear");
});

test("sem localização efetiva ou trecho não chama modelo", async () => {
  for (const item of [{ ...citation, excerpt: "" }, { ...citation, locator: { found: false } }, { ...citation, locator: undefined }]) {
    const result = await review(null, { citations: [item], fetchImpl: async () => { assert.fail("Não deve chamar serviço"); } });
    assert.deepEqual(result.result.claims, []);
    assert.deepEqual(result.usage, { input: 0, output: 0, total: 0 });
  }
});

test("JSON ilegível permanece inconclusivo", async (t) => {
  setEnv(t, "test-only-secret");
  const result = await review(null, { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }) });
  assert.equal(result.result.claims[0].verdict, "unclear");
});

test("erros não expõem segredo ou corpo, sem retry ou fallback", async (t) => {
  setEnv(t, "test-only-secret");
  for (const mode of ["http", "transport"]) {
    let calls = 0;
    await assert.rejects(review(null, { fetchImpl: async () => {
      calls++;
      if (mode === "transport") throw new Error("test-only-secret PRIVATE_BODY");
      return { ok: false, json: async () => { assert.fail("Não deve ler corpo"); } };
    } }), (error) => { assert.equal(error.code, "jev_review_failed"); assert.doesNotMatch(error.message, /test-only-secret|PRIVATE_BODY/); return true; });
    assert.equal(calls, 1);
  }
});

test("sem chave falha sem chamada", async (t) => {
  setEnv(t, undefined);
  await assert.rejects(review(null, { fetchImpl: async () => { assert.fail("Não deve chamar serviço"); } }), { code: "jev_review_failed" });
});

test("timeout de revisão interrompe transporte", async (t) => {
  setEnv(t, "test-only-secret");
  let signal;
  await assert.rejects(review(null, { config: { ...config, reviewTimeoutMs: 1, timeoutMs: 10000 }, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("PRIVATE_BODY")), { once: true }));
  } }), { code: "jev_review_failed" });
  assert.equal(signal.aborted, true);
});

test("revisão em batches alcança o último claim e mantém os vínculos originais", async (t) => {
  setEnv(t, "test-only-secret");
  const claims = Array.from({ length: 15 }, (_, index) => ({ text: `A proposta ${index} foi apresentada.` }));
  const citations = claims.flatMap((_, claimIndex) => claimIndex === 0 ? [] : [{
    ...citation, claimIndex,
  }]);
  const calls = [];
  const result = await review(null, {
    claims, citations, config: { ...config, maxReviewItems: 12 },
    fetchImpl: async (_url, options) => {
      const groups = JSON.parse(JSON.parse(options.body).state).claims;
      calls.push(groups.map((group) => group.claimIndex));
      const answers = Object.fromEntries(groups.map(({ claimIndex }) => [
        String(claimIndex), claimIndex === 14 ? validRefutation : answer("supports", { supports: 0.95, refutes: 0.01, context: 0.02, unclear: 0.02 }),
      ]));
      answers["0"] = validRefutation;
      return { ok: true, json: async () => ({ answers, usage: { input_tokens: 10, output_tokens: 2 } }) };
    },
  });
  assert.deepEqual(calls.map((batch) => batch.length), [12, 2]);
  assert.deepEqual(result.result.claims.map((item) => item.claimIndex), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.equal(result.result.claims[13].verdict, "refutes");
  assert.ok(result.result.claims.slice(0, 13).every((item) => item.verdict === "supports"));
  assert.deepEqual(result.usage, { input: 20, output: 4, total: 24 });
});

test("falha em batch posterior não devolve conclusão parcial nem transforma erro em refutação", async (t) => {
  setEnv(t, "test-only-secret");
  let calls = 0;
  await assert.rejects(review(null, {
    claims: [{ text: "Primeira alegação." }, { text: "Segunda alegação." }],
    citations: [{ ...citation, claimIndex: 0 }, { ...citation, claimIndex: 1 }],
    config: { ...config, maxReviewItems: 1 },
    fetchImpl: async () => {
      calls++;
      if (calls === 2) throw new Error("PRIVATE_BODY");
      return { ok: true, json: async () => ({ answers: { "0": validRefutation } }) };
    },
  }), (error) => {
    assert.equal(error.code, "jev_review_failed");
    assert.doesNotMatch(error.message, /PRIVATE_BODY|test-only-secret/);
    return true;
  });
  assert.equal(calls, 2);
});
