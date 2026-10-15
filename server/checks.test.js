import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleChecksRequest } from "./checks-endpoint.js";
import { handleAdminRequest } from "./admin-endpoint.js";
import { filterCheckLogIndex, getCheckLog, listCheckLogs, normalizeLogQuery, saveCheckLog, saveSuccessfulCheck } from "./checklog.js";
import { publicCheckEnvelope } from "./public-check.js";
import { runVerify } from "./verify.js";
import { getCached, invalidateCache } from "./cache.js";
import { evidenceConfig } from "./evidence.js";
import { PROMPT_VERSION } from "./scoring.js";

const guard = { config: { correctionsPerWindow: 100, windowSec: 60 }, rateLimit: async () => ({ allowed: true }) };
const auth = { authorization: "Bearer 00000000-0000-4000-8000-000000000001" };
const entry = (id = "private-check") => ({ id, kind: "text", outcome: "checked", verdict: "true", score: 95, inputPreview: "PRIVATE INPUT", phases: [{ name: "judge", ms: 12, ok: true }], totalMs: 12 });
const envelope = (id = "private-check") => ({
  checkId: id,
  result: { outcome: "checked", verdict: "true", score: 95, summary: "Conclusão pública", claims: [{ text: "Alegação", status: "true", sourceIds: [0], evidence: [{ sourceId: 0, quote: "Trecho público", relation: "supports", raw: "PRIVATE RAW" }], debug: "PRIVATE DEBUG" }], sources: [{ url: "https://example.org/report?token=PRIVATE_TOKEN&year=2026", citationTitle: "Documento", outlet: "Fonte", secret: "PRIVATE SOURCE" }], transcript: "PRIVATE TRANSCRIPT", aiConfig: { key: "PRIVATE KEY" } },
  origin: { title: "Origem", url: "https://example.org/post", transcript: "PRIVATE ORIGIN" },
  transcript: "PRIVATE ENVELOPE", storage: { shareToken: "PRIVATE TOKEN" },
});

// Simulated REST store, not a live Supabase/RLS integration. Requests still pass
// through the production transport, capability verification and projection.
async function withStore(fn, extraEnv = {}) {
  const names = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "BLOB_READ_WRITE_TOKEN", "ADMIN_SECRET", ...Object.keys(extraEnv)];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: "https://store.example", SUPABASE_SERVICE_ROLE_KEY: "server-secret", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-must-not-be-used", ADMIN_SECRET: "00000000-0000-4000-8000-000000000001", ...extraEnv });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const rows = new Map();
  const requests = [];
  let failure = false;
  const store = { rows, requests, fail(value = true) { failure = value; } };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname !== "store.example") throw new Error("Unexpected external request");
    assert.equal(options.headers.apikey, "server-secret");
    assert.equal(options.headers.Authorization, "Bearer server-secret");
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method, body });
    if (failure) return new Response("PRIVATE DB FAILURE server-secret https://private.example", { status: 500 });
    if (url.pathname.endsWith("/rpc/iev_list_checks")) return Response.json({ total: 37, items: [{ id: "match", outcome: "error" }] });
    if (options.method === "POST") {
      if (rows.has(body.id)) return new Response("duplicate", { status: 409 });
      rows.set(body.id, structuredClone(body));
      return new Response(null, { status: 201 });
    }
    const id = url.searchParams.get("id")?.slice(3);
    const row = rows.get(id);
    if (options.method === "PATCH") {
      if (!row || (url.searchParams.has("share_token_hash") && row.share_token_hash !== url.searchParams.get("share_token_hash").slice(3))) return Response.json([]);
      Object.assign(row, body);
      return options.headers.Prefer === "return=representation" ? Response.json([{ id }]) : new Response(null, { status: 204 });
    }
    if (url.searchParams.get("published_at") && (!row?.published_at || row.outcome === "content_refused")) return Response.json([]);
    if (!row) return Response.json([]);
    const selected = Object.fromEntries(url.searchParams.get("select").split(",").map((name) => [name, row[name]]));
    return Response.json([selected]);
  };
  try { await fn(store); }
  finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

const request = (args) => handleChecksRequest({ guard, ...args });

test("private records require explicit capability publication; reads never select private log", async () => {
  await withStore(async ({ rows, requests }) => {
    const saved = await saveSuccessfulCheck(entry(), envelope());
    assert.equal(saved.persisted, true);
    assert.match(saved.shareToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(rows.get("private-check").share_token_hash, createHash("sha256").update(saved.shareToken).digest("hex"));
    assert.doesNotMatch(JSON.stringify(rows.get("private-check")), new RegExp(saved.shareToken));
    const privateRead = await request({ method: "GET", query: { id: "private-check" } });
    const missingRead = await request({ method: "GET", query: { id: "missing-check" } });
    assert.equal(privateRead.status, 404);
    assert.deepEqual(privateRead.body, missingRead.body);
    const publicReads = requests.filter((call) => call.method === "GET");
    assert.ok(publicReads.every((call) => call.url.searchParams.get("select") === "public_envelope"));
    assert.equal((await request({ method: "POST", body: { checkId: "private-check", shareToken: "x".repeat(43) } })).status, 403);
    assert.equal((await request({ method: "POST", body: { checkId: "missing-check", shareToken: saved.shareToken } })).status, 403);
    assert.equal((await request({ method: "GET", query: { id: "private-check" } })).status, 404);
    const publication = await request({ method: "POST", body: { checkId: "private-check", shareToken: saved.shareToken } });
    assert.deepEqual(publication.body, { id: "private-check", url: "/?check=private-check" });
    const publishedAt = rows.get("private-check").published_at;
    assert.equal((await request({ method: "POST", body: { checkId: "private-check", shareToken: saved.shareToken } })).status, 200);
    assert.equal(rows.get("private-check").published_at, publishedAt);
    const published = await request({ method: "GET", query: { id: "private-check" } });
    assert.equal(published.status, 200);
    assert.deepEqual(Object.keys(published.body).sort(), ["checkId", "createdAt", "origin", "result"]);
    assert.equal(published.body.result.sources[0].citationTitle, "Documento");
    assert.equal(published.body.result.sources[0].url, "https://example.org/report?year=2026");
    assert.doesNotMatch(JSON.stringify(published.body), /PRIVATE|shareToken|tokenHash|transcript|aiConfig|debug|raw/);
    assert.equal((await getCheckLog("private-check")).inputPreview, "PRIVATE INPUT");
    assert.equal((await getCheckLog("private-check"))._sharing, undefined);
    assert.equal((await handleAdminRequest({ method: "GET", query: { id: "private-check" } })).status, 401);
  });
});

test("public projection drops nested unknown objects and reprojects stored legacy envelopes", async () => {
  const source = { ...envelope(), createdAt: "2026-10-14T00:00:00.000Z" };
  source.result.claims[0].comparison = { metric: "Área", groups: [{ label: "Período", coverage: { available: 2, token: "PRIVATE COVERAGE" }, rows: [{ year: 2025, value: 12, transcript: "PRIVATE ROW" }], config: "PRIVATE GROUP" }], raw: "PRIVATE COMPARISON" };
  const projected = publicCheckEnvelope(source);
  assert.equal(projected.result.claims[0].debug, undefined);
  assert.equal(projected.result.claims[0].evidence[0].raw, undefined);
  assert.equal(projected.origin.transcript, undefined);
  assert.equal(projected.result.claims[0].comparison.groups[0].rows[0].value, 12);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  const malformed = publicCheckEnvelope({ checkId: { token: "PRIVATE ID" }, createdAt: { token: "PRIVATE DATE" }, origin: { title: { token: "PRIVATE TITLE" } } });
  assert.equal(malformed.checkId, null);
  assert.equal(malformed.createdAt, null);
  assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE/);
  await withStore(async ({ rows }) => {
    const saved = await saveSuccessfulCheck(entry(), envelope());
    rows.get("private-check").public_envelope.result.claims[0].transcript = "PRIVATE LEGACY";
    await request({ method: "POST", body: { checkId: "private-check", shareToken: saved.shareToken } });
    assert.doesNotMatch(JSON.stringify((await request({ method: "GET", query: { id: "private-check" } })).body), /PRIVATE LEGACY/);
    const refused = await saveSuccessfulCheck({ ...entry("refused"), outcome: "content_refused" }, { result: { outcome: "content_refused" } });
    assert.deepEqual(refused, { persisted: true });
    // Even possession of an injected valid hash must not publish refusals.
    rows.get("refused").share_token_hash = createHash("sha256").update(saved.shareToken).digest("hex");
    assert.equal((await request({ method: "POST", body: { checkId: "refused", shareToken: saved.shareToken } })).status, 403);
  });
});

test("storage failures stay observable without leaking backend bodies or secrets", async () => {
  await withStore(async (store) => {
    store.fail();
    const errors = [];
    const previousError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.deepEqual(await saveSuccessfulCheck(entry(), envelope()), { persisted: false });
      assert.equal((await request({ method: "GET", query: { id: "private-check" } })).status, 502);
      assert.equal((await request({ method: "POST", body: { checkId: "private-check", shareToken: "a".repeat(43) } })).status, 502);
      const listed = await handleAdminRequest({ method: "GET", headers: auth });
      assert.equal(listed.status, 502);
      assert.equal(listed.body.error, "list_failed");
      assert.equal(listed.body.mode, "supabase");
      assert.match(errors.join(" "), /storage_request_failed/);
      assert.doesNotMatch(errors.join(" ") + JSON.stringify(listed.body), /server-secret|PRIVATE DB|private\.example/);
    } finally { console.error = previousError; }
  });
});

test("invalid admin query bounds and dates are rejected before accessing storage", async () => {
  await withStore(async ({ requests }) => {
    for (const query of [
      { limit: "101" }, { limit: "0" }, { offset: "-1" }, { from: "tomorrow" },
      { from: "2026-10-14", to: "2026-01-01" }, { sort: "arbitrary" },
    ]) {
      assert.throws(() => normalizeLogQuery(query), /invalid_log_query/);
      const rejected = await handleAdminRequest({ method: "GET", headers: auth, query });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, "invalid_log_query");
    }
    assert.equal(requests.length, 0);
  });
});

test("public checks are rate limited without executing paid work", async () => {
  const out = await handleChecksRequest({ method: "GET", query: { id: "some-id" }, guard: { config: guard.config, rateLimit: async () => ({ allowed: false, retryAfterSec: 7 }) } });
  assert.equal(out.status, 429);
  assert.equal(out.headers["Retry-After"], "7");
  assert.equal(out.headers["Cache-Control"], "no-store");
});

test("successful and cached executions persist distinct IDs/capabilities and cache holds no sharing token", async () => {
  await withStore(async (store) => {
    await invalidateCache();
    const restFetch = globalThis.fetch;
    let modelCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (new URL(url).hostname === "store.example") return restFetch(url, options);
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "muse-spark-1.3-contributor" }] });
      modelCalls++;
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ outcome: "no_verifiable_claims", verdict: null, score: null, summary: "Sem afirmação verificável.", claims: [], sources: [] }) }] }] });
    };
    const input = { kind: "text", text: "Saudação determinística para testar armazenamento e cache." };
    const first = await runVerify(input);
    const second = await runVerify(input);
    assert.equal(first.storage.persisted, true);
    assert.equal(second.storage.persisted, true);
    assert.equal(second.cached, true);
    assert.notEqual(first.checkId, second.checkId);
    assert.notEqual(first.storage.shareToken, second.storage.shareToken);
    assert.ok(modelCalls > 0);
    assert.equal(store.rows.size, 2);
    assert.equal(store.rows.get(second.checkId).log.cachedFrom, first.checkId);
    const ev = evidenceConfig();
    const namespace = `${PROMPT_VERSION}:media-context-v5:${first.configRevision}:${ev.enabled}:${ev.reviewEnabled}:${ev.reviewProvider}:${ev.reviewModel}`;
    const cached = await getCached(input, namespace);
    assert.ok(cached);
    assert.equal(cached.storage, undefined);
    assert.doesNotMatch(JSON.stringify(cached), new RegExp(first.storage.shareToken));
    assert.doesNotMatch(JSON.stringify([...store.rows.values()]), new RegExp(second.storage.shareToken));
    store.fail();
    const stillValid = await runVerify(input);
    assert.ok(stillValid.result);
    assert.deepEqual(stillValid.storage, { persisted: false });
  }, { OPENCODE_API: "test-key", OPENAI_API_KEY: "", MODERATION_MODE: "off", IEV_EVIDENCE_FETCH: "0", IEV_EVIDENCE_REVIEW: "0" });
});

test("pipeline failures durably retain safe error metadata and phase timing, never provider messages", async () => {
  await withStore(async (store) => {
    const restFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (new URL(url).hostname === "store.example") return restFetch(url, options);
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "muse-spark-1.3-contributor" }] });
      return new Response(JSON.stringify({ error: { message: "PRIVATE PROVIDER RESPONSE test-key" } }), { status: 500 });
    };
    await assert.rejects(runVerify({ kind: "text", text: "Entrada determinística diferente para exercitar falha operacional." }));
    assert.equal(store.rows.size, 1);
    const row = [...store.rows.values()][0];
    assert.equal(row.outcome, "error");
    assert.equal(row.log.errorStatus, 502);
    assert.ok(row.log.errorCode);
    assert.ok(row.log.failedPhase);
    assert.ok(row.log.phases.some((phase) => !phase.ok && typeof phase.ms === "number"));
    assert.equal(row.public_envelope, null);
    assert.equal(row.share_token_hash, null);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE PROVIDER RESPONSE|test-key/);
    assert.ok(row.index_entry.errorCode);
  }, { OPENCODE_API: "test-key", OPENAI_API_KEY: "", MODERATION_MODE: "off", IEV_EVIDENCE_FETCH: "0", IEV_EVIDENCE_REVIEW: "0" });
});

test("unconfigured storage stays disabled, partial Supabase config never falls back to Blob", async () => {
  await withStore(async ({ requests }) => {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const disabled = await listCheckLogs();
    assert.equal(disabled.mode, "disabled");
    assert.equal(disabled.enabled, false);
    assert.deepEqual(await saveSuccessfulCheck(entry(), envelope()), { persisted: false });
    assert.equal((await request({ method: "GET", query: { id: "private-check" } })).status, 404);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://store.example";
    process.env.BLOB_READ_WRITE_TOKEN = "must-not-be-used";
    assert.equal(await saveCheckLog(entry()), null);
    const listed = await listCheckLogs();
    assert.equal(listed.mode, "supabase");
    assert.equal(listed.error, "list_failed");
    assert.equal(listed.errorCode, "storage_not_configured");
    assert.match(listed.message, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.equal(requests.length, 0);
  });
});

test("Blob retained index filters globally before paging, including legacy verdict migration and stable sorting", () => {
  const rows = [
    { id: "a", at: "2026-01-01T00:00:00.000Z", kind: "text", outcome: "checked", verdict: "mixed", score: 70, totalMs: 15, inputPreview: "Literal % quote" },
    { id: "b", at: "2026-02-01T00:00:00.000Z", kind: "video", outcome: "checked", verdict: "mixed", score: 60, totalMs: 50, inputPreview: "Outro" },
    { id: "c", at: "2026-03-01T00:00:00.000Z", kind: "text", outcome: "error", verdict: null, error: "upstream_timeout", totalMs: 100 },
    { id: "d", at: "2026-04-01T00:00:00.000Z", kind: "text", outcome: "no_verifiable_claims", verdict: null, totalMs: 5 },
  ];
  const ids = (query) => filterCheckLogIndex(rows, normalizeLogQuery(query)).map((row) => row.id);
  assert.deepEqual(ids({ q: "%", kind: "text" }), ["a"]);
  assert.deepEqual(ids({ q: "B" }), ["b"]);
  assert.deepEqual(ids({ filter: "partially_true" }), ["a"]);
  assert.deepEqual(ids({ status: "distorted" }), ["b"]);
  assert.deepEqual(ids({ filter: "error", outcome: "error" }), ["c"]);
  assert.deepEqual(ids({ filter: "no-verdict" }), ["d"]);
  assert.deepEqual(ids({ from: "2026-02-01", to: "2026-03-01", sort: "oldest" }), ["b", "c"]);
  assert.deepEqual(ids({ sort: "slowest" }), ["c", "b", "a", "d"]);
  assert.deepEqual(ids({ sort: "lowest" }), ["b", "a", "d", "c"]);
  assert.deepEqual(ids({ limit: "1", offset: "1" }).slice(1, 2), ["c"]);
  assert.deepEqual(rows.map((row) => row.id), ["a", "b", "c", "d"], "não altera o índice de origem");
});
