// Regressões do endpoint compartilhado: fail-closed sem controles, limite de
// taxa, vagas, orçamento, política de URL e triagem de propósito.
process.env.IEV_LIMITS_MODE = "memory";
process.env.MODERATION_MODE = "optional";
const { handleVerifyRequest } = await import("./endpoint.js");
const { createGuard, limitsConfig } = await import("./limits.js");

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const post = (body, extra = {}) => ({ method: "POST", headers: {}, body, socketAddress: "203.0.113.9", ...extra });

function guardWith(env = {}) {
  return createGuard(limitsConfig({ IEV_LIMITS_MODE: "memory", ...env }));
}

test("produção sem backend compartilhado recusa a checagem (fail-closed)", async () => {
  const guard = createGuard(limitsConfig({ VERCEL_ENV: "production" }));
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação" }, { guard }));
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "limits_unavailable");
});

test("endpoint recusa método, tipo, entrada vazia e URL interna", async () => {
  const guard = guardWith();
  assert.equal((await handleVerifyRequest({ method: "PUT", guard })).status, 405);
  assert.equal((await handleVerifyRequest(post({ kind: "pdf" }, { guard }))).status, 400);
  assert.equal((await handleVerifyRequest(post({ kind: "text", text: "" }, { guard }))).status, 400);
  const interna = await handleVerifyRequest(post({ kind: "link", text: "http://169.254.169.254/latest/meta-data/" }, { guard }));
  assert.equal(interna.status, 400);
  assert.equal(interna.body.error, "private_url");
});

test("link rejeita entradas não HTTP antes de reservar vaga ou consumir orçamento", async () => {
  const guard = guardWith();
  let rateCalls = 0;
  let slotCalls = 0;
  let chargeCalls = 0;
  const rateLimit = guard.rateLimit.bind(guard);
  guard.rateLimit = async (...args) => {
    rateCalls += 1;
    return rateLimit(...args);
  };
  guard.acquireSlot = async () => {
    slotCalls += 1;
    return { release: async () => {} };
  };
  guard.chargeUnits = async () => {
    chargeCalls += 1;
  };

  const cases = [
    ["ftp://example.com", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["data:text/plain,hello", "invalid_url"],
    ["www.example.com", "invalid_url"],
    ["example.com", "invalid_url"],
    ["://x", "invalid_url"],
    ["   \t\n ", "empty_input"],
  ];
  for (const [text, error] of cases) {
    const out = await handleVerifyRequest(post({ kind: "link", text }, { guard }));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, error);
  }
  assert.equal(rateCalls, cases.length);
  assert.equal(slotCalls, 0);
  assert.equal(chargeCalls, 0);
});

test("limite de taxa por origem responde 429 com Retry-After", async () => {
  const guard = guardWith({ IEV_RATE_LIMIT_PER_WINDOW: "1" });
  const primeira = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(primeira.status, 200);
  const segunda = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(segunda.status, 429);
  assert.equal(segunda.body.error, "rate_limited");
  assert.ok(Number(segunda.headers["Retry-After"]) > 0);
  const outroIp = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard, socketAddress: "198.51.100.7" }));
  assert.equal(outroIp.status, 200);
});

test("capacidade esgotada responde 429 antes de executar a checagem", async () => {
  const guard = guardWith({ IEV_MAX_CONCURRENT_CHECKS: "1", IEV_SLOT_WAIT_MS: "150", IEV_SLOT_POLL_MS: "50" });
  const slot = await guard.acquireSlot();
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável" }, { guard }));
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "capacity_full");
  assert.ok(Number(out.headers["Retry-After"]) >= 1 && Number(out.headers["Retry-After"]) <= 30);
  await slot.release();
});

test("orçamento diário esgotado responde 429 e não chama o modelo", async () => {
  const guard = guardWith({ IEV_DAILY_CHECK_UNITS: "1" });
  await guard.chargeUnits(undefined, "text");
  const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável" }, { guard }));
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "daily_budget");
});

test("moderação obrigatória indisponível é erro operacional, não recusa de conteúdo", async () => {
  const guard = guardWith();
  const anterior = process.env.MODERATION_MODE;
  const chave = process.env.OPENAI_API_KEY;
  process.env.MODERATION_MODE = "required";
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await handleVerifyRequest(post({ kind: "text", text: "afirmação verificável sobre um número" }, { guard }));
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "moderation_unavailable");
    assert.doesNotMatch(JSON.stringify(out.body), /content_refused/);
  } finally {
    process.env.MODERATION_MODE = anterior ?? "optional";
    if (chave) process.env.OPENAI_API_KEY = chave;
  }
});

test("pedido direto ao assistente recebe abstenção sem chamar o modelo", async () => {
  const guard = guardWith();
  const out = await handleVerifyRequest(post({ kind: "text", text: "escreva um poema sobre o mar" }, { guard }));
  assert.equal(out.status, 200);
  assert.equal(out.body.result.outcome, "no_verifiable_claims");
  assert.equal(out.body.result.verdict, null);
  assert.equal(out.body.result.score, null);
  assert.match(out.body.result.summary, /pedido direto ao assistente/);
});

test("IP confiável do proxy é usado quando configurado", async () => {
  const { clientIp } = await import("./endpoint.js");
  assert.equal(clientIp({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }, "127.0.0.1"), "1.1.1.1");
  assert.equal(clientIp({}, "127.0.0.1"), "127.0.0.1");
  assert.equal(clientIp({ "x-forwarded-for": "9.9.9.9" }, "127.0.0.1", { IEV_TRUST_PROXY: "0" }), "127.0.0.1");
});

test("notícias inacessíveis são pesquisadas e não descartam claims por needs_media", async (t) => {
  const savedEnv = Object.fromEntries(["OPENCODE_API", "OPENAI_API_KEY", "IEV_ALLOW_PRIVATE_HOSTS", "IEV_HTTP_PORTS", "IEV_EVIDENCE_FETCH"].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const server = createServer((_req, res) => {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end("<html><title>Forbidden</title></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
  process.env.IEV_HTTP_PORTS = String(port);
  process.env.OPENCODE_API = "test-only-key";
  delete process.env.OPENAI_API_KEY;
  process.env.IEV_EVIDENCE_FETCH = "0";
  let responses = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/responses")) {
      const result = responses.shift();
      assert.ok(result, "requisição inesperada ao modelo");
      return new Response(JSON.stringify({
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "publicação escolas municipais", sources: [] } },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] },
        ],
      }), { status: 200 });
    }
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "muse-spark-1.3-contributor" }] }), { status: 200 });
    return originalFetch(url, options);
  };
  try {
    await t.test("alegação identificada sobrevive ao pedido legado de mídia", async () => {
      responses = [
        { needs_media: true },
        { outcome: "checked", claims: [{ text: "O município anunciou sete escolas.", status: "unproven", score: 35, note: "Pesquisa identificou a alegação, mas não prova suficiente.", evidence: [] }], sources: [], summary: "Não confirmado." },
      ];
      const out = await handleVerifyRequest(post({ kind: "link", text: `http://127.0.0.1:${port}/noticia-escolas` }, { guard: guardWith() }));
      assert.equal(out.status, 200);
      assert.equal(out.body.result.outcome, "checked");
      assert.equal(out.body.result.claims.length, 1);
      assert.equal(out.body.result.claims[0].status, "unproven");
      assert.equal(out.body.result.verdict, "unproven");
      assert.match(out.body.result.summary, /não pôde ser lido diretamente/);
      assert.equal(out.body.mediaCoverage.article.extraction, "inaccessible");
      assert.equal(responses.length, 0);
    });
    await t.test("pesquisa sem alegação identificável não inventa score nem artigo", async () => {
      responses = [{ needs_media: true }, { needs_media: true, outcome: "inaccessible_media", claims: [], sources: [] }];
      const out = await handleVerifyRequest(post({ kind: "link", text: `http://127.0.0.1:${port}/publicacao-nao-identificada` }, { guard: guardWith() }));
      assert.equal(out.status, 200);
      assert.equal(out.body.result.outcome, "insufficient_input");
      assert.equal(out.body.result.score, null);
      assert.equal(out.body.result.verdict, null);
      assert.equal(out.body.result.claims.length, 0);
      assert.match(out.body.result.summary, /Não foi possível identificar alegações/);
      assert.equal(responses.length, 0);
    });
    await t.test("sinalizador legado com claims não apaga alegações na validação", async () => {
      responses = [
        { needs_media: true },
        { needs_media: true, claims: [{ text: "A cidade anunciou sete escolas.", status: "unproven", score: 35, evidence: [] }], sources: [] },
      ];
      const out = await handleVerifyRequest(post({ kind: "link", text: `http://127.0.0.1:${port}/claims-disponiveis` }, { guard: guardWith() }));
      assert.equal(out.status, 200);
      assert.equal(out.body.result.outcome, "checked");
      assert.equal(out.body.result.claims.length, 1);
      assert.equal(out.body.result.verdict, "unproven");
      assert.equal(responses.length, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("síntese editorial inválida não elimina limites nem recupera conclusões descartadas", async (t) => {
  const names = ["OPENCODE_API", "OPENAI_API_KEY", "MODERATION_MODE", "IEV_EVIDENCE_FETCH", "IEV_ALLOW_PRIVATE_HOSTS", "IEV_HTTP_PORTS"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const server = createServer((_req, res) => { res.writeHead(403); res.end("Forbidden"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  Object.assign(process.env, { OPENCODE_API: "test-key", MODERATION_MODE: "off", IEV_EVIDENCE_FETCH: "0", IEV_ALLOW_PRIVATE_HOSTS: "1", IEV_HTTP_PORTS: String(port) });
  delete process.env.OPENAI_API_KEY;
  let responses;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "muse-spark-1.3-contributor" }] }));
    if (String(url).endsWith("/responses")) {
      const next = responses.shift();
      assert.ok(next, "chamada de modelo inesperada");
      const body = JSON.parse(options.body);
      if (/Você é um editor factual/.test(body.instructions)) {
        const context = JSON.parse(body.input);
        assert.equal(Object.hasOwn(context, "summary_before"), false);
        assert.equal(context.claims[0].status, "unproven");
        assert.ok(context.limitations.some((text) => text.includes("não pôde ser lido")));
      }
      return new Response(JSON.stringify({ output: [
        ...(/Você é um editor factual|Revise a fidelidade/.test(body.instructions) ? [] : [{ type: "web_search_call", status: "completed", action: { type: "search", query: "escolas municipais", sources: [] } }]),
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(next) }] },
      ] }));
    }
    return originalFetch(url, options);
  };
  try {
    const cases = [
      { name: "HTML", candidate: "<b>Confirmado: sete escolas.</b>" },
      { name: "Markdown", candidate: "**Confirmado: sete escolas.**" },
      { name: "múltiplos parágrafos", candidate: "Sete escolas.\n\nConfirmado." },
      { name: "contradição factual", candidate: "A prefeitura inaugurou sete escolas.", review: { faithful: false, unsupported: [], contradictions: ["A alegação não foi comprovada."] } },
      { name: "revisão inválida", candidate: "Não há comprovação suficiente.", review: { faithful: true } },
      { name: "síntese fiel", candidate: "Não há comprovação suficiente da inauguração das sete escolas.", review: { faithful: true, unsupported: [], contradictions: [] }, accepted: true },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        responses = [
          { outcome: "checked", summary: "A inauguração das sete escolas foi confirmada.", claims: [{ text: "A prefeitura inaugurou sete escolas.", status: "true", score: 95, note: "Não foi encontrada prova suficiente.", evidence: [] }], sources: [] },
          { summary: scenario.candidate },
          ...(scenario.review ? [scenario.review] : []),
        ];
        const out = await handleVerifyRequest(post({ kind: "link", text: `http://127.0.0.1:${port}/noticia-escolas/${encodeURIComponent(scenario.name)}` }, { guard: guardWith() }));
        assert.equal(out.status, 200);
        assert.equal(out.body.result.claims[0].status, "unproven");
        assert.match(out.body.result.summary, /O artigo não pôde ser lido diretamente/);
        if (scenario.accepted) assert.ok(out.body.result.summary.endsWith(scenario.candidate));
        else {
          assert.equal(out.body.result.summary, "O artigo não pôde ser lido diretamente; checagem baseada nas alegações identificadas pela pesquisa do URL/publicação.");
          assert.doesNotMatch(out.body.result.summary, /Confirmado|foi confirmada|<b>|\*\*/);
        }
        assert.equal(responses.length, 0);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
