import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { audienceGeo, handleAudienceRequest, parseAudienceQuery, audienceSnapshot } from "./audience.js";
import { handleAdminRequest } from "./admin-endpoint.js";
import handler from "../api/audience.js";

const EVENT = "11111111-1111-4111-8111-111111111111";
const VISITOR = "22222222-2222-4222-8222-222222222222";
const ENV = { SUPABASE_URL: "https://audience.test", SUPABASE_SERVICE_ROLE_KEY: "private-service-key", ADMIN_SECRET: "a-private-admin-secret-at-least-32-chars", IEV_ANALYTICS_SECRET: "private-hmac-key", VERCEL: "1", IEV_LIMITS_MODE: "memory" };
const headers = { host: "site.example", origin: "https://site.example", "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0", "x-forwarded-for": "203.0.113.8", "x-vercel-ip-country": "BR", "x-vercel-ip-country-region": "SP" };
const body = { eventId: EVENT, visitorId: VISITOR, event: "page_view", checkId: "published-a", source: "whatsapp" };
const NOW = new Date("2026-10-17T02:30:00.000Z"); // ainda é dia 16 em Brasília
const SUMMARY = { views: 0, visitors: 0, sharedViews: 0, sharedVisitors: 0, reachedLinks: 0, clicks: 0, conversions: 0, publishedLinks: 0, brazilViews: 0, unknownLocation: 0 };
const snapshot = () => ({ summary: { ...SUMMARY }, daily: [], links: [], sources: [], regions: [], states: [], linkTotal: 0, capturedAt: NOW.toISOString(), retentionDays: 90, timeZone: "America/Sao_Paulo", trackingSince: null });

async function transport(run, response = () => new Response(null, { status: 204 })) {
  const previous = globalThis.fetch, previousError = console.error;
  const calls = [], errors = [], rates = [];
  const guard = { async rateLimit(...args) { rates.push(args); return { allowed: true }; } };
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options, payload: options.body ? JSON.parse(options.body) : null }); return response(url, options); };
  console.error = (...args) => errors.push(args);
  try { await run({ calls, errors, rates, guard }); }
  finally { globalThis.fetch = previous; console.error = previousError; }
}

const request = (extra = {}) => ({ method: "POST", headers: { ...headers }, body: { ...body }, env: { ...ENV }, ...extra });

test("coleta envia somente o contrato privado, HMAC e geolocalização da Vercel", async () => {
  await transport(async ({ calls, rates, guard }) => {
    const out = await handleAudienceRequest(request({ guard, body: { ...body, country: "US", state: "CA", ip: "secret-ip", referrer: "https://origin.test/?token=secret-ref" } }));
    assert.equal(out.status, 204);
    assert.equal(out.headers["Cache-Control"], "no-store");
    assert.equal(calls.length, 1);
    const saved = calls[0].payload;
    assert.deepEqual(saved, { p_event_id: EVENT, p_visitor: createHmac("sha256", ENV.IEV_ANALYTICS_SECRET).update(`audience-v1:${VISITOR}`).digest("hex"), p_event: "page_view", p_check_id: "published-a", p_source: "whatsapp", p_country: "BR", p_state: "SP", p_region: "Sudeste" });
    assert.equal(calls[0].headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.doesNotMatch(JSON.stringify(saved), /203\.0\.113|secret-ip|secret-ref|private-|22222222/);
    assert.equal(rates[0][1].bucket, "audience");
    assert.deepEqual(rates[0][1], { bucket: "audience", max: 120, windowSec: 600 });
  });
});

test("robôs, prévias, DNT e GPC não consomem gravações ou limite", async (t) => {
  const cases = [
    ...["Googlebot/2.1", "facebookexternalhit/1.1", "WhatsApp/2.24", "TelegramBot", "Twitterbot", "Slackbot", "Mozilla/5.0 HeadlessChrome", "curl/8.1", "python-requests/2"].map((ua) => ({ "user-agent": ua })),
    { dnt: "1" }, { "sec-gpc": "1" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { "user-agent": "" },
  ];
  for (const override of cases) await t.test(JSON.stringify(override), async () => {
    await transport(async ({ calls, rates, guard }) => {
      assert.equal((await handleAudienceRequest(request({ guard, headers: { ...headers, ...override } }))).status, 204);
      assert.equal(calls.length, 0); assert.equal(rates.length, 0);
    });
  });
});

test("navegador real dentro do WhatsApp não é confundido com a prévia", async () => {
  await transport(async ({ calls, guard }) => {
    await handleAudienceRequest(request({ guard, headers: { ...headers, "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 WhatsApp/2.24" } }));
    assert.equal(calls.length, 1);
  });
});

test("métodos, origens e payloads inválidos são rejeitados antes da persistência", async (t) => {
  const cases = [
    [{ method: "GET" }, 405], [{ headers: { ...headers, origin: "https://evil.example" } }, 403], [{ headers: { ...headers, origin: "null" } }, 403], [{ headers: { ...headers, "sec-fetch-site": "cross-site" } }, 403],
    ...[null, {}, { ...body, eventId: "invalid" }, { ...body, visitorId: "invalid" }, { ...body, event: "share_sent" }, { ...body, checkId: "../private" }, { ...body, event: "new_check", checkId: null }, { ...body, event: "check_completed", checkId: null }].map((value) => [{ body: value }, 400]),
  ];
  for (const [extra, status] of cases) await t.test(JSON.stringify(extra), async () => {
    await transport(async ({ calls, rates, guard }) => { assert.equal((await handleAudienceRequest(request({ guard, ...extra }))).status, status); assert.equal(calls.length, 0); assert.equal(rates.length, 0); });
  });
});

test("coleta desativada, ausência de banco e limites não afetam o site", async () => {
  await transport(async ({ calls, rates, guard }) => {
    assert.equal((await handleAudienceRequest(request({ guard, env: { ...ENV, IEV_AUDIENCE_ENABLED: "0" } }))).status, 204);
    assert.equal((await handleAudienceRequest(request({ guard, env: {} }))).status, 204);
    assert.equal(calls.length, 0); assert.equal(rates.length, 0);
    assert.equal((await handleAudienceRequest(request({ guard: { rateLimit: async () => ({ allowed: false }) } }))).status, 429);
    assert.equal(calls.length, 0);
    assert.equal((await handleAudienceRequest(request({ guard: { rateLimit: async () => { throw new Error("private-key"); } } }))).status, 204);
  });
});

test("falha de rede ou banco é best-effort e não revela dados sensíveis", async () => {
  for (const response of [() => { throw new Error("private-service-key"); }, () => new Response("private-service-key", { status: 500 })]) {
    await transport(async ({ errors, guard }) => {
      const out = await handleAudienceRequest(request({ guard }));
      assert.equal(out.status, 204); assert.equal(out.body, null);
      assert.doesNotMatch(JSON.stringify(errors), /private-service-key|203\.0\.113/);
    }, response);
  }
});

test("origem desconhecida é normalizada; home e todos os eventos suportados usam o mesmo contrato", async () => {
  await transport(async ({ calls, guard }) => {
    for (const event of ["page_view", "new_check", "check_completed"]) await handleAudienceRequest(request({ guard, body: { ...body, event, source: "untrusted-value" } }));
    await handleAudienceRequest(request({ guard, body: { ...body, checkId: null } }));
    assert.equal(calls.length, 4);
    assert.equal(calls[0].payload.p_source, "direct");
    assert.equal(calls[3].payload.p_check_id, null);
  });
});

test("todas as UFs pertencem à macrorregião correta e dados externos não forjam Brasil", () => {
  const regions = { Norte: "AC AP AM PA RO RR TO", Nordeste: "AL BA CE MA PB PE PI RN SE", "Centro-Oeste": "DF GO MT MS", Sudeste: "ES MG RJ SP", Sul: "PR RS SC" };
  for (const [region, states] of Object.entries(regions)) for (const state of states.split(" ")) assert.deepEqual(audienceGeo({ "x-vercel-ip-country": "br", "x-vercel-ip-country-region": `BR-${state}` }, ENV), { country: "BR", state, region });
  assert.deepEqual(audienceGeo(headers, {}), { country: null, state: null, region: null });
  assert.deepEqual(audienceGeo({ ...headers, "x-vercel-ip-country": "US" }, ENV), { country: "US", state: null, region: null });
  assert.deepEqual(audienceGeo({ ...headers, "x-vercel-ip-country-region": "ZZ" }, ENV), { country: "BR", state: null, region: null });
});

test("períodos respeitam meia-noite de Brasília, inclusive quando a data UTC já mudou", () => {
  const starts = { today: "2026-10-16", "7d": "2026-10-10", "30d": "2026-09-17", "90d": "2026-07-19" };
  for (const [period, date] of Object.entries(starts)) {
    const result = parseAudienceQuery({ period }, NOW);
    assert.equal(result.from, `${date}T03:00:00.000Z`); assert.equal(result.to, NOW.toISOString());
  }
  const custom = parseAudienceQuery({ period: "custom", from: "2026-10-10", to: "2026-10-11" }, NOW);
  assert.equal(custom.from, "2026-10-10T03:00:00.000Z"); assert.equal(custom.to, "2026-10-12T03:00:00.000Z");
  assert.equal(parseAudienceQuery({ period: "custom", from: "2026-10-15", to: "2026-10-30" }, NOW).to, NOW.toISOString());
});

test("datas impossíveis, filtros desconhecidos e parâmetros repetidos não derrubam o endpoint", () => {
  const invalid = [{ period: "year" }, { period: ["7d", "30d"] }, { scope: ["all"] }, { scope: "private" }, { state: "ZZ" }, { source: "unknown" }, { region: "Sul;select" }, { q: ["x"] }, { q: "x".repeat(101) }, { page: "-1" }, { page: "1.2" }, { page: "Infinity" }, { page: ["1"] }, { page: "10001" }, { checkId: "../id" }, ...[
    ["2026-02-30", "2026-10-12"], ["2026-99-01", "2026-10-12"], ["2026-10-12", "2026-10-01"], ["2026-01-01", "2026-10-12"], ["2026-10-18", "2026-10-19"], ["", "2026-10-11"],
  ].map(([from, to]) => ({ period: "custom", from, to }))];
  for (const value of invalid) assert.equal(parseAudienceQuery(value, NOW), null, JSON.stringify(value));
});

test("consulta envia filtros e paginação ao SQL, sem transferir eventos individuais", async () => {
  await transport(async ({ calls }) => {
    const out = await audienceSnapshot({ period: "7d", state: "SP", source: "whatsapp", checkId: "published-a", scope: "shared", q: "assunto", page: "2" }, ENV);
    assert.equal(out.status, 200);
    assert.equal(calls[0].payload.p_offset, 30); assert.equal(calls[0].payload.p_limit, 15);
    assert.equal(calls[0].payload.p_state, "SP"); assert.equal(calls[0].payload.p_source, "whatsapp"); assert.equal(calls[0].payload.p_check_id, "published-a"); assert.equal(calls[0].payload.p_query, "assunto");
    assert.deepEqual(out.body.audience.summary, SUMMARY);
  }, () => Response.json(snapshot()));
});

test("indisponibilidade ou snapshot malformado nunca é apresentado como zero acessos", async () => {
  for (const response of [() => new Response("secret", { status: 404 }), () => new Response("secret", { status: 503 }), () => Response.json(null), () => Response.json({ summary: {}, links: [] }), () => Response.json({ ...snapshot(), regions: null }), () => Response.json({ ...snapshot(), summary: { ...SUMMARY, views: -1 } }), () => Response.json({ ...snapshot(), links: [{ id: "private-invalid/" }] })]) {
    await transport(async () => {
      const out = await audienceSnapshot({}, ENV);
      assert.equal(out.status, 502); assert.equal(out.body.error, "audience_unavailable"); assert.equal(out.body.audience, undefined);
      assert.doesNotMatch(JSON.stringify(out.body), /secret/);
    }, response);
  }
  assert.equal((await audienceSnapshot({ period: "invalid" }, ENV)).status, 400);
  assert.equal((await audienceSnapshot({}, {})).body.audience, null);
});

test("dashboard de audiência exige a mesma autenticação administrativa", async () => {
  await transport(async ({ calls }) => {
    const denied = await handleAdminRequest({ method: "GET", headers: {}, query: { audience: "1" }, env: ENV });
    assert.equal(denied.status, 401); assert.equal(calls.length, 0);
    const allowed = await handleAdminRequest({ method: "GET", headers: { authorization: `Bearer ${ENV.ADMIN_SECRET}` }, query: { audience: "1" }, env: ENV });
    assert.equal(allowed.status, 200); assert.deepEqual(allowed.body.audience.summary, SUMMARY);
  }, () => Response.json(snapshot()));
});

test("adaptador HTTP recusa corpo grande ou JSON inválido antes de coletar", async () => {
  for (const [req, expected] of [[{ method: "GET", headers: {} }, 405], [{ method: "POST", headers: { "content-length": "3000" } }, 413], [{ method: "POST", headers: {}, body: "{" }, 400], [{ method: "POST", headers: {}, body: JSON.stringify({ data: "x".repeat(2048) }) }, 413]]) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, end() { return this; } };
    await handler(req, res); assert.equal(res.code, expected);
  }
});
