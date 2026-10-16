import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { saveCheckLog } from "./checklog.js";
import { durableSnapshot, parseMetricsFilters, recordCheck, resetMetrics, snapshot } from "./metrics.js";
import { handleAdminRequest } from "./admin-endpoint.js";

const SECRET = "00000000-0000-4000-8000-000000000123";
const auth = { authorization: `Bearer ${SECRET}` };
const storageNames = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BLOB_READ_WRITE_TOKEN", "VERCEL_BLOB_API_URL", "ADMIN_SECRET", "IEV_LIMITS_MODE"];
const row = (id, log = {}) => ({ id, at: "2025-01-01T00:00:00.000Z", kind: "text", outcome: "checked", log: { id, totalMs: 100, ...log } });

// Simulated transport only: real production PostgREST requests and validation,
// without a live Supabase project or service-role key.
async function withStore(fn, initial = []) {
  const savedEnv = Object.fromEntries(storageNames.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  for (const name of storageNames) delete process.env[name];
  Object.assign(process.env, { SUPABASE_URL: "https://metrics.example", SUPABASE_SERVICE_ROLE_KEY: "private-service-key", ADMIN_SECRET: SECRET, IEV_LIMITS_MODE: "memory" });
  const store = { rows: [...initial], requests: [], pageCap: 200, failure: null, malformed: false };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, "metrics.example");
    assert.equal(options.headers.apikey, "private-service-key");
    assert.equal(options.headers.Authorization, "Bearer private-service-key");
    store.requests.push({ url, options });
    if (store.failure === "network") throw new TypeError("PRIVATE NETWORK private-service-key");
    if (store.failure) return new Response("PRIVATE DB private-service-key", { status: store.failure });
    if (store.failAfterFirstPage && url.searchParams.has("or")) return new Response("PRIVATE PAGE FAILURE", { status: 500 });
    if (store.malformed) return Response.json({ private: "PRIVATE DATA" });
    if (options.method === "POST") {
      store.rows.push(JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    assert.equal(url.searchParams.get("select"), "id,at,kind,outcome,log");
    assert.equal(url.searchParams.get("order"), "at.desc,id.desc");
    let rows = [...store.rows].filter((item) => Date.parse(item.at) <= Date.parse(url.searchParams.get("at").slice(4)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const cursor = url.searchParams.get("or");
    if (cursor) {
      const match = cursor.match(/^\(at\.lt\.(.*?),and\(at\.eq\..*?,id\.lt\.([^)]*)\)\)$/);
      assert.ok(match, cursor);
      rows = rows.filter((item) => Date.parse(item.at) < Date.parse(match[1]) || (Date.parse(item.at) === Date.parse(match[1]) && item.id < match[2]));
    }
    return Response.json(rows.slice(0, Math.min(Number(url.searchParams.get("limit")), store.pageCap)));
  };
  try { await fn(store); }
  finally {
    globalThis.fetch = previousFetch;
    resetMetrics();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const adminMetrics = (env = process.env) => handleAdminRequest({ method: "GET", headers: auth, query: { metrics: "1" }, env });

test("admin aggregates retained historical logs without merging local instance counters", async () => {
  await withStore(async () => {
    resetMetrics();
    const first = await adminMetrics();
    assert.equal(first.status, 200);
    assert.equal(first.body.metrics.checks, 5);
    recordCheck({ kind: "video", outcome: "error", error: "local-only", totalMs: 99999 });
    const out = await adminMetrics();
    assert.equal(out.status, 200);
    const metrics = out.body.metrics;
    assert.equal(metrics.source, "supabase");
    assert.equal(metrics.checks, 5);
    assert.equal(metrics.cached, 1);
    assert.deepEqual(metrics.byKind, { text: 5 });
    assert.equal(metrics.errors.moderation_unavailable, 1);
    assert.equal(metrics.errors["local-only"], undefined);
    assert.equal(metrics.abstentions, 1);
    assert.equal(metrics.byOutcome.content_refused, 1);
    assert.deepEqual(metrics.tokens, { input: 100, output: 50, total: 150 });
    assert.deepEqual(metrics.media, { transcript: 2, vision: 2, frames: 7 });
    assert.deepEqual(metrics.moderation, { refused: 1, uncovered: 0, unavailable: 1, sensitive: 2 });
    assert.deepEqual(metrics.corrections, { created: null, corrected: 1 });
    assert.equal(metrics.latency.avg, 100);
    assert.equal(metrics.latency.p95, 100);
    assert.equal(metrics.window.startedAt, "2025-01-01T00:00:00.000Z");
    assert.equal(metrics.lastCheckAt, "2025-01-01T00:00:00.000Z");
    assert.equal(metrics.window.correctionsScope, "editorial_corrections_in_window");
    assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE|private-service-key/);
  }, [
    row("a", { verdict: "true", tokenUsage: { input: 100, output: 50 }, mediaCoverage: { transcript: "text-only", frames: "sampled-and-described", sampledFrameCount: 4 }, moderationReports: [{ checked: true, categories: ["violence"] }], editorialCorrections: [{ protocol: "corr-one", status: "corrected" }] }),
    row("b", { cachedFrom: "a", tokenUsage: { input: 100, output: 50 }, mediaCoverage: { transcript: "text-only", frames: "sampled-and-described", sampledFrameCount: 4 }, moderationReports: [{ checked: true, categories: ["violence"] }] }),
    { ...row("c", { error: "moderation_unavailable", moderationReports: [{ checked: false, reason: "no_key" }] }), outcome: "error" },
    { ...row("d", { moderationReports: [{ checked: true, categories: ["sexual"] }] }), outcome: "content_refused" },
    row("e", { mediaAttempts: ["transcribe:openai:whisper-1:0 segmentos", "frames:direct:3", "vision:openai:vision:ok"], editorialCorrections: [{ protocol: "corr-one", status: "corrected" }], inputPreview: "PRIVATE INPUT" }),
  ]);
});

test("persisted logs survive a separate metrics process with no recordCheck calls", async () => {
  await withStore(async (store) => {
    await saveCheckLog({ id: "persisted-elsewhere", at: "2024-03-01T12:00:00.000Z", kind: "audio", outcome: "checked", totalMs: 12, tokenUsage: { input: 40, output: 10 } });
    const script = `
      import { readFileSync } from 'node:fs';
      import { durableSnapshot, snapshot } from ${JSON.stringify(new URL("./metrics.js", import.meta.url).href)};
      const rows = JSON.parse(readFileSync(0, 'utf8'));
      globalThis.fetch = async (input, options) => {
        if (options.headers.apikey !== 'private-service-key') throw new Error('wrong auth');
        const url = new URL(input);
        return Response.json(url.searchParams.has('or') ? [] : rows);
      };
      console.log(JSON.stringify({ localChecks: snapshot().checks, metrics: await durableSnapshot() }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify(store.rows), encoding: "utf8", env: process.env, timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.localChecks, 0);
    assert.equal(result.metrics.checks, 1);
    assert.equal(result.metrics.source, "supabase");
    assert.equal(result.metrics.tokens.total, 50);
    assert.equal(result.metrics.lastCheckAt, "2024-03-01T12:00:00.000Z");
  });
});

test("keyset pagination handles server page caps, equal timestamps and explicit bounded windows", async () => {
  const rows = Array.from({ length: 1002 }, (_, index) => row(`check-${String(index).padStart(4, "0")}`, { totalMs: index + 1 }));
  await withStore(async (store) => {
    store.pageCap = 37;
    const metrics = await durableSnapshot();
    assert.equal(metrics.checks, 1000);
    assert.equal(metrics.window.sample, 1000);
    assert.equal(metrics.window.limit, 1000);
    assert.equal(metrics.window.limited, true);
    assert.equal(metrics.window.latencySample, 1000);
    assert.equal(metrics.latency.avg, 503);
    assert.equal(metrics.latency.p50, 502);
    assert.equal(metrics.latency.p95, 952);
    assert.equal(metrics.cached, 0);
    assert.ok(store.requests.length > 20);
    assert.ok(store.requests.slice(1).every(({ url }) => url.searchParams.has("or")));
    assert.match(metrics.note, /registros anteriores fora desta janela/);
  }, rows);
});

test("an unreadable later page fails instead of publishing a partial historical total", async () => {
  await withStore(async (store) => {
    store.pageCap = 1;
    store.failAfterFirstPage = true;
    await assert.rejects(durableSnapshot(), { code: "storage_request_failed" });
    assert.equal(store.requests.length, 2);
  }, [row("first"), row("second")]);
});

test("empty durable history remains a durable source rather than local instance data", async () => {
  await withStore(async () => {
    recordCheck({ kind: "text", outcome: "checked" });
    const metrics = await durableSnapshot();
    assert.equal(metrics.source, "supabase");
    assert.equal(metrics.checks, 0);
    assert.equal(metrics.lastCheckAt, null);
    assert.equal(metrics.window.startedAt, null);
    assert.equal(metrics.window.limited, false);
    assert.equal(metrics.latency.avg, null);
    assert.equal(metrics.timeZone, "America/Sao_Paulo");
    assert.deepEqual(metrics.daily, []);
    assert.equal(metrics.dailyExcludedInvalidAt, 0);
  });
});

test("storage failures are explicit, sanitized, and never fall back to memory zeros", async () => {
  await withStore(async (store) => {
    resetMetrics();
    const previousError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(" "));
    try {
      for (const failure of [401, 403, 404, 500, "network"]) {
        store.failure = failure;
        const out = await adminMetrics();
        assert.equal(out.status, 502);
        assert.equal(out.body.error, "metrics_failed");
        assert.equal(out.body.mode, "supabase");
        assert.equal(out.body.metrics, undefined);
        assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE|private-service-key/);
      }
      store.failure = null;
      store.malformed = true;
      assert.equal((await adminMetrics()).body.errorCode, "storage_invalid_response");
      const missingKey = await adminMetrics({ ...process.env, SUPABASE_SERVICE_ROLE_KEY: "" });
      assert.equal(missingKey.status, 502);
      assert.equal(missingKey.body.errorCode, "storage_not_configured");
      assert.match(missingKey.body.message, /Supabase incompleto/);
      assert.doesNotMatch(errors.join(" "), /PRIVATE|private-service-key/);
    } finally { console.error = previousError; }
  });
});

test("memory fallback is scoped to this instance only when durable storage is disabled", async () => {
  resetMetrics();
  try {
    recordCheck({ kind: "text", outcome: "checked", totalMs: 7 });
    const metrics = await durableSnapshot({}, {});
    assert.equal(metrics.source, "memory");
    assert.equal(metrics.checks, 1);
    assert.equal(metrics.window.scope, "instance");
    assert.match(metrics.note, /sem persistência/);
    assert.equal(snapshot().checks, 1);
    assert.equal(metrics.timeZone, "America/Sao_Paulo");
    assert.equal(metrics.daily, null);
    assert.match(metrics.note, /diário indisponível/);
  } finally { resetMetrics(); }
});

test("daily snapshots use Brasilia midnight, chronological dates and independent statistics", async () => {
  const dated = (id, at, log, outcome = "checked") => ({ ...row(id, log), at, outcome });
  await withStore(async () => {
    recordCheck({ kind: "video", tokens: { input: 9999 }, outcome: "error" });
    const metrics = await durableSnapshot({ limitsMode: "blocked" }, {
      ...process.env, IEV_ALERT_MIN_SAMPLE: "1",
    });
    assert.equal(metrics.checks, 4);
    assert.deepEqual(metrics.daily.map((day) => day.date), ["2024-12-31", "2025-01-01", "2025-01-03"]);
    const [before, after, later] = metrics.daily;
    assert.equal(before.checks, 1);
    assert.equal(before.latency.avg, 100);
    assert.deepEqual(before.tokens, { input: 10, output: 5, total: 15 });
    assert.equal(after.checks, 2);
    assert.equal(after.cached, 1);
    assert.deepEqual(after.byOutcome, { error: 1, checked: 1 });
    assert.deepEqual(after.errors, { provider_failed: 1 });
    assert.equal(after.errorRate, 0.5);
    assert.equal(after.latency.avg, 300);
    assert.equal(after.latency.p50, 200);
    assert.equal(after.latency.p95, 400);
    assert.deepEqual(after.tokens, { input: 20, output: 8, total: 28 });
    assert.deepEqual(after.media, { transcript: 1, vision: 0, frames: 0 });
    assert.equal(after.window.startedAt, "2025-01-01T03:00:00.000Z");
    assert.equal(after.window.endedAt, "2025-01-01T23:59:59-03:00");
    assert.equal(after.window.latencySample, 2);
    assert.equal(later.checks, 1);
    assert.equal(metrics.tokens.total, 43);
    assert.equal(metrics.cached, 1);
    for (const day of metrics.daily) {
      assert.equal(day.source, "supabase");
      assert.equal(day.timeZone, "America/Sao_Paulo");
      assert.equal(day.daily, undefined);
      assert.deepEqual(day.corrections, { created: null, corrected: null });
      assert.equal(day.window.correctionsScope, "unavailable_by_day");
      assert.ok(day.alerts.some((alert) => alert.id === "limits"));
    }
    assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE INPUT/);
  }, [
    dated("late", "2025-01-03T06:00:00+03:00", { totalMs: 50 }),
    dated("cached", "2025-01-01T23:59:59-03:00", { totalMs: 400, cachedFrom: "before", tokenUsage: { input: 10, output: 5 }, mediaCoverage: { transcript: "text-only" } }),
    dated("after", "2025-01-01T03:00:00.000Z", { totalMs: 200, errorCode: "provider_failed", tokenUsage: { input: 20, output: 8 }, mediaCoverage: { transcript: "text-only" } }, "error"),
    dated("before", "2025-01-01T02:59:59.999Z", { totalMs: 100, tokenUsage: { input: 10, output: 5 }, inputPreview: "PRIVATE INPUT", editorialCorrections: [{ protocol: "correction", status: "corrected" }] }),
  ]);
});

test("Blob scans every listing page and full retained objects, not the truncated index", async () => {
  await withStore(async () => {
    const previousDispatcher = getGlobalDispatcher();
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    dispatcher.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);
    const previousApi = process.env.VERCEL_BLOB_API_URL;
    const requests = [];
    const records = new Map([
      ["iev-logs/old.json", { id: "old", at: "2020-01-01T00:00:00Z", kind: "video", outcome: "error", error: "provider_unavailable", totalMs: 20 }],
      ["iev-logs/new.json", { id: "new", at: "2025-01-01T00:00:00Z", kind: "audio", outcome: "checked", totalMs: 10, tokenUsage: { input: 20, output: 5 } }],
      ["iev-corrections/corr-one.json", { protocol: "corr-one", status: "corrected" }],
      ["iev-corrections/corr-two.json", { protocol: "corr-two", status: "received" }],
    ]);
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      requests.push(url);
      const prefix = url.searchParams.get("prefix");
      const page = url.searchParams.get("cursor");
      const paths = prefix === "iev-logs/" ? (page ? ["iev-logs/new.json"] : ["iev-logs/index.json", "iev-logs/old.json"]) : (page ? ["iev-corrections/corr-two.json"] : ["iev-corrections/index.json", "iev-corrections/corr-one.json"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ blobs: paths.map((pathname) => ({ pathname, url: `https://teststore.private.blob.vercel-storage.com/${pathname}`, uploadedAt: "2025-01-01T00:00:00Z", size: 100 })), hasMore: !page, cursor: page ? undefined : "second-page" }));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${server.address().port}`;
    let failedObject = false;
    dispatcher.get("https://teststore.private.blob.vercel-storage.com")
      .intercept({ path: /^\/iev-(?:logs|corrections)\//, method: "GET", headers: { authorization: "Bearer vercel_blob_rw_teststore_secret" } })
      .reply((options) => {
        const url = new URL(options.path, "https://teststore.private.blob.vercel-storage.com");
        assert.equal(url.searchParams.get("cache"), "0");
        assert.ok(!url.pathname.endsWith("index.json"));
        if (failedObject && url.pathname.endsWith("old.json")) return { statusCode: 500, data: "PRIVATE FAILURE" };
        return { statusCode: 200, data: JSON.stringify(records.get(url.pathname.slice(1))), responseOptions: { headers: { "content-type": "application/json" } } };
      }).persist();
    setGlobalDispatcher(dispatcher);
    const env = { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_secret" };
    try {
      const metrics = await durableSnapshot({}, env);
      assert.equal(metrics.source, "blob");
      assert.equal(metrics.checks, 2);
      assert.equal(metrics.errors.provider_unavailable, 1);
      assert.equal(metrics.tokens.total, 25);
      assert.equal(metrics.latency.avg, 15);
      assert.equal(metrics.window.startedAt, "2020-01-01T00:00:00Z");
      assert.equal(metrics.window.correctionsScope, "all_retained_reports");
      assert.deepEqual(metrics.corrections, { created: 2, corrected: 1 });
      assert.equal(requests.length, 4);
      records.get("iev-logs/new.json").at = "invalid-date";
      await assert.rejects(durableSnapshot({}, env), { code: "storage_invalid_response" });
      records.get("iev-logs/new.json").at = "2025-01-01T00:00:00Z";
      failedObject = true;
      await assert.rejects(durableSnapshot({}, env));
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await dispatcher.close();
      if (previousApi === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = previousApi;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("usage estima unidades vigentes e expõe capacidades sem tokens por etapa", async () => {
  await withStore(async () => {
    const metrics = await durableSnapshot({}, process.env, { period: "all", provider: null, model: null, kind: null });
    assert.equal(metrics.usage.scope, "estimated_from_retained_logs");
    assert.deepEqual(metrics.usage.filtersApplied, { period: "all", provider: null, model: null, kind: null });
    assert.deepEqual(metrics.usage.units.unitCosts, { text: 1, link: 2, image: 2, video: 4 });
    // text(1) + cache-hit(0) + 2×video(4) = 9 unidades estimadas.
    assert.equal(metrics.usage.units.estimated, 9);
    assert.deepEqual(metrics.usage.units.byKind, { text: { checks: 2, units: 1 }, video: { checks: 2, units: 8 } });
    assert.deepEqual(metrics.usage.tokens, { input: 30, output: 15, total: 45 });
    assert.deepEqual(metrics.usage.steps, { judge: { calls: 2 }, transcribe: { calls: 1 }, vision: { calls: 1 } });
    assert.deepEqual(metrics.usage.webSearch, { checksWithQueries: 2, queries: 3 });
    assert.deepEqual(metrics.usage.evidence, { checksWithDossier: 1, checksReviewed: 1 });
    assert.deepEqual(metrics.usage.moderation, { checks: 1, refused: 0, unavailable: 0, sensitive: 1 });
    assert.deepEqual(metrics.usage.media, { transcriptions: 1, visions: 1, frames: 4 });
    assert.deepEqual(metrics.usage.providers.byProvider, { openai: { checks: 1, calls: 2 }, opencode: { checks: 1, calls: 2 } });
    assert.deepEqual(metrics.usage.providers.byModel, {
      "openai:gpt-4o": { checks: 1, calls: 1 },
      "openai:whisper-1": { checks: 1, calls: 1 },
      "opencode:muse-spark-1.3-contributor": { checks: 1, calls: 2 },
    });
    for (const capability of metrics.usage.capabilities) {
      assert.ok(capability.id && capability.label && Number.isFinite(capability.calls));
      assert.equal(capability.tokens, undefined);
    }
    const judge = metrics.usage.capabilities.find((capability) => capability.id === "judge");
    assert.equal(judge.calls, 2);
    assert.equal(metrics.usage.capabilities.find((capability) => capability.id === "web_search").calls, 4);
    assert.deepEqual(metrics.usageOptions.models, [
      { provider: "openai", model: "gpt-4o", label: "openai:gpt-4o" },
      { provider: "openai", model: "whisper-1", label: "openai:whisper-1" },
      { provider: "opencode", model: "muse-spark-1.3-contributor", label: "opencode:muse-spark-1.3-contributor" },
    ]);
    assert.deepEqual(metrics.usageOptions.providers, ["openai", "opencode"]);
    assert.deepEqual(metrics.usageOptions.kinds, ["text", "video"]);
    assert.deepEqual(metrics.usageOptions.days, ["2024-12-31"]);
    assert.equal(metrics.daily.length, 1);
    assert.equal(metrics.daily[0].usage.unitsEstimated, 9);
    assert.deepEqual(metrics.daily[0].usage.tokens, metrics.tokens);
    assert.equal(metrics.window.filters.period, "all");
    assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE INPUT/);
  }, [
    row("full", {
      provider: "openai", model: "gpt-4o", tokenUsage: { input: 10, output: 5 },
      modelsUsed: { judge: { provider: "openai", model: "gpt-4o" }, transcribe: { provider: "openai", model: "whisper-1" } },
      phases: [{ name: "judge", ok: true }],
      researchQueries: ["q1", "q2"], researchDiagnostics: [{ step: "judge" }],
      evidence: { summary: {}, verification: "verified" }, evidenceVerification: "verified",
      moderationReports: [{ checked: true, categories: ["violence"] }],
      mediaCoverage: { transcript: "text-only", frames: "sampled-and-described", sampledFrameCount: 4 },
    }),
    row("cached", { cachedFrom: "full", provider: "openai", model: "gpt-4o", tokenUsage: { input: 999, output: 999 }, modelsUsed: { judge: { provider: "openai", model: "gpt-4o" } }, researchQueries: ["ignored"] }),
    { ...row("old-video", { provider: "opencode", model: "muse-spark-1.3-contributor", tokenUsage: { input: 20, output: 10 }, modelsUsed: { judge: { provider: "opencode", model: "muse-spark-1.3-contributor" }, vision: { provider: "opencode", model: "muse-spark-1.3-contributor" } }, researchQueries: ["q3"] }), at: "2024-12-31T03:00:00.000Z", kind: "video" },
    { ...row("ignored-private", { inputPreview: "PRIVATE INPUT" }), at: "2024-12-31T03:00:00.000Z", kind: "video" },
  ]);
});

test("filtros recortam uso e qualidade; opções ignoram filtros; sem match zera com nota", async () => {
  await withStore(async () => {
    const provider = await durableSnapshot({}, process.env, { period: "all", provider: "openai", model: null, kind: null });
    assert.equal(provider.checks, 1);
    assert.equal(provider.usage.units.estimated, 1);
    assert.equal(provider.daily.length, 1);
    // Opções permanecem estáveis mesmo com filtro ativo.
    assert.deepEqual(provider.usageOptions.providers, ["openai", "opencode"]);
    const model = await durableSnapshot({}, process.env, { period: "all", provider: null, model: "opencode:muse-spark-1.3-contributor", kind: null });
    assert.equal(model.checks, 1);
    assert.equal(model.usage.providers.byModel["opencode:muse-spark-1.3-contributor"].checks, 1);
    const bareModel = await durableSnapshot({}, process.env, { period: "all", provider: null, model: "gpt-4o", kind: null });
    assert.equal(bareModel.checks, 1);
    const kind = await durableSnapshot({}, process.env, { period: "all", provider: null, model: null, kind: "video" });
    assert.equal(kind.checks, 1);
    assert.equal(kind.daily.length, 1);
    const day = await durableSnapshot({}, process.env, { period: "2024-12-31", provider: null, model: null, kind: null });
    assert.equal(day.checks, 1);
    assert.equal(day.daily.length, 1);
    assert.equal(day.daily[0].date, "2024-12-31");
    const windowed = await durableSnapshot({}, process.env, { period: "2024-12-30", provider: null, model: null, kind: null });
    assert.equal(windowed.checks, 0);
    assert.match(windowed.note, /Nenhum registro corresponde aos filtros/);
    const empty = await durableSnapshot({}, process.env, { period: "all", provider: "missing", model: null, kind: null });
    assert.equal(empty.checks, 0);
    assert.equal(empty.usage.units.estimated, 0);
    assert.deepEqual(empty.daily, []);
    assert.match(empty.note, /Nenhum registro corresponde aos filtros/);
    // Agregado filtrado também usa granularidade diária limitada.
    assert.match(empty.note, /últimas 1000|1000 checagens/);
  }, [
    { ...row("new-text", { provider: "openai", model: "gpt-4o" }), at: "2025-06-15T12:00:00.000Z" },
    { ...row("old-video", { provider: "opencode", model: "muse-spark-1.3-contributor", modelsUsed: { judge: { provider: "opencode", model: "muse-spark-1.3-contributor" } } }), at: "2024-12-31T12:00:00.000Z", kind: "video" },
  ]);
});

test("sinais ausentes geram capacidades vazias sem quebrar a estimativa", async () => {
  await withStore(async () => {
    const metrics = await durableSnapshot({}, process.env, { period: "all", provider: null, model: null, kind: null });
    assert.equal(metrics.usage.units.estimated, 1);
    assert.deepEqual(metrics.usage.steps, {});
    assert.deepEqual(metrics.usage.capabilities, []);
    assert.deepEqual(metrics.usage.webSearch, { checksWithQueries: 0, queries: 0 });
  }, [row("bare")]);
});

test("memória sem granularidade: usage null e opções vazias documentadas", async () => {
  resetMetrics();
  try {
    recordCheck({ kind: "text", outcome: "checked", totalMs: 7 });
    const metrics = await durableSnapshot({}, {});
    assert.equal(metrics.source, "memory");
    assert.equal(metrics.usage, null);
    assert.deepEqual(metrics.usageOptions, { periods: ["7d", "30d", "all"], providers: [], models: [], kinds: [], days: [] });
    assert.equal(metrics.daily, null);
    assert.match(metrics.note, /sem persistência/);
  } finally { resetMetrics(); }
});

test("parseMetricsFilters valida período, modelo e rejeita vetor", async () => {
  assert.deepEqual(parseMetricsFilters({}), { ok: true, filters: { period: "7d", provider: null, model: null, kind: null } });
  assert.deepEqual(parseMetricsFilters({ period: "2025-01-31" }).filters.period, "2025-01-31");
  assert.equal(parseMetricsFilters({ period: "ontem" }).ok, false);
  assert.equal(parseMetricsFilters({ period: "2025-02-30" }).ok, false);
  assert.equal(parseMetricsFilters({ period: "7d", model: "openai:" }).ok, false);
  assert.equal(parseMetricsFilters({ provider: ["openai", "x"] }).ok, false);
  assert.equal(parseMetricsFilters({ period: "7d; DROP" }).error, "invalid_metrics_query");
});
