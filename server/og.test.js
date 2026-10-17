import { test } from "node:test";
import assert from "node:assert/strict";
import { handleOg, isCrawler, ogDescription, ogTitle, siteOrigin } from "./og.js";

const TWITTER = { "user-agent": "Twitterbot/1.0", host: "example.org" };
const HUMAN = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120.0", host: "example.org" };
const FALLBACK = "Verificador automático de afirmações públicas no Brasil, com fontes e limites explícitos.";
const noFetch = () => { throw new Error("humans must not reach the check endpoint"); };
const published = (result) => async () => ({ status: 200, body: { checkId: "private-check", result } });

test("only link-preview crawlers get HTML; Googlebot and browsers do not", () => {
  assert.equal(isCrawler("Twitterbot/1.0"), true);
  assert.equal(isCrawler("facebookexternalhit/1.1"), true);
  assert.equal(isCrawler("Googlebot/2.1"), false);
  assert.equal(isCrawler(HUMAN["user-agent"]), false);
  assert.equal(isCrawler(undefined), false);
});

test("humans get a 302 that keeps only utm params, without touching the check endpoint", async () => {
  const out = await handleOg({
    method: "GET",
    headers: HUMAN,
    query: { id: "private-check", utm_source: "isso-e-verdade", utm_medium: "share", utm_campaign: "private-check", other: "drop" },
    fetchCheck: noFetch,
  });
  assert.equal(out.status, 302);
  assert.equal(out.headers.Location, "/?check=private-check&utm_source=isso-e-verdade&utm_medium=share&utm_campaign=private-check");
  assert.equal(out.body, null);
});

test("humans with an invalid id are sent to the home page, never echoed into Location", async () => {
  const out = await handleOg({ method: "GET", headers: HUMAN, query: { id: "bad id/<x>" }, fetchCheck: noFetch });
  assert.equal(out.status, 302);
  assert.equal(out.headers.Location, "/");
});

test("Googlebot follows the same 302 as a visitor", async () => {
  const out = await handleOg({ method: "GET", headers: { "user-agent": "Googlebot/2.1" }, query: { id: "private-check" }, fetchCheck: noFetch });
  assert.equal(out.status, 302);
});

test("crawler HTML escapes user-controlled title and summary and marks itself noindex", async () => {
  const result = { title: 'Checagem: <img src=x onerror="alert(1)"> & "aspas"', verdict: "false", score: 12, summary: "Resumo & fontes" };
  const out = await handleOg({ method: "GET", headers: TWITTER, query: { id: "private-check" }, fetchCheck: published(result) });
  assert.equal(out.status, 200);
  assert.equal(out.headers["X-Robots-Tag"], "noindex");
  assert.equal(out.headers["Cache-Control"], "no-store");
  assert.match(out.body, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(out.body, /<img/);
  assert.match(out.body, /property="og:title" content="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &quot;aspas&quot; · isso é verdade\?"/);
  assert.match(out.body, /property="og:description" content="Falso · Nota 12\/100\. Resumo &amp; fontes"/);
  assert.match(out.body, /property="og:url" content="https:\/\/example\.org\/check\/private-check"/);
});

test("HEAD from a crawler returns headers without a body", async () => {
  const out = await handleOg({ method: "HEAD", headers: TWITTER, query: { id: "private-check" }, fetchCheck: published({ title: "t", verdict: "true", score: 99 }) });
  assert.equal(out.status, 200);
  assert.equal(out.body, null);
});

test("unpublished, rate-limited, or failing checks fail open to a generic noindex page", async () => {
  const unpublished = await handleOg({ method: "GET", headers: TWITTER, query: { id: "private-check" }, fetchCheck: async () => ({ status: 404, body: { error: "not_found" } }) });
  const limited = await handleOg({ method: "GET", headers: TWITTER, query: { id: "private-check" }, fetchCheck: async () => ({ status: 429, body: { error: "rate_limited" } }) });
  const thrown = await handleOg({ method: "GET", headers: TWITTER, query: { id: "private-check" }, fetchCheck: async () => { throw new Error("storage down"); } });
  for (const out of [unpublished, limited, thrown]) {
    assert.equal(out.status, 200);
    assert.equal(out.headers["X-Robots-Tag"], "noindex");
    assert.match(out.body, new RegExp(`content="${FALLBACK}"`));
    assert.doesNotMatch(out.body, /private-check/);
    assert.doesNotMatch(out.body, /storage down/);
  }
});

test("a non-object check body is not rendered as a preview", async () => {
  const out = await handleOg({ method: "GET", headers: TWITTER, query: { id: "private-check" }, fetchCheck: async () => ({ status: 200, body: { result: "text" } }) });
  assert.match(out.body, /property="og:title" content="isso é verdade\?"/);
});

test("host header is accepted only as a plain hostname, otherwise og:url is omitted", async () => {
  assert.equal(siteOrigin({ host: 'evil.com/"><script>' }), null);
  assert.equal(siteOrigin({ host: "localhost:5173" }), "http://localhost:5173");
  assert.equal(siteOrigin({ "x-forwarded-host": "isso.example, other.example", host: "x" }), "https://isso.example");
  const out = await handleOg({ method: "GET", headers: { "user-agent": "Twitterbot/1.0", host: 'evil.com/"><script>' }, query: { id: "private-check" }, fetchCheck: published({ title: "t" }) });
  assert.doesNotMatch(out.body, /og:url/);
  assert.doesNotMatch(out.body, /<script>/);
});

test("title and description are bounded and fall back when the check has no verdict", () => {
  const long = ogTitle({ title: `Checagem: ${"palavra ".repeat(60)}` });
  assert.ok(long.length <= 90 + " · isso é verdade?".length);
  assert.ok(long.endsWith("· isso é verdade?"));
  assert.equal(ogDescription({}), FALLBACK);
  assert.ok(ogDescription({ summary: "x".repeat(500) }).length <= 200);
});

test("non-GET methods are rejected", async () => {
  const out = await handleOg({ method: "POST", headers: TWITTER, query: { id: "private-check" }, fetchCheck: noFetch });
  assert.equal(out.status, 405);
});
