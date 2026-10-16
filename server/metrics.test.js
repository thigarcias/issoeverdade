import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { saveCheckLog } from "./checklog.js";
import { durableSnapshot, recordCheck, resetMetrics, snapshot } from "./metrics.js";
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
  } finally { resetMetrics(); }
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
