import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../src/lib/audience.js", import.meta.url), "utf8");
const VISITOR_KEY = "iev-audience-visitor-v1", ATTRIBUTION_KEY = "iev-audience-source-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const flush = () => new Promise((resolve) => setImmediate(resolve));
function storage(initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { values, writes, getItem(key) { if (blocked) throw new Error("blocked"); return values.get(key) ?? null; }, setItem(key, value) { if (blocked) throw new Error("blocked"); writes.push(key); values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
function browser(options = {}) {
  let time = options.time ?? Date.parse("2026-10-17T12:00:00Z"), nextId = 0;
  const calls = [], listeners = new Map();
  const localStorage = options.localStorage ?? storage({}, options.blockStorage);
  const sessionStorage = options.sessionStorage ?? storage();
  const document = { referrer: options.referrer ?? "", visibilityState: options.visibility ?? "visible", addEventListener(event, fn) { listeners.set(fn, event); }, removeEventListener(_event, fn) { listeners.delete(fn); } };
  const context = { URL, URLSearchParams, Promise, navigator: options.navigator ?? {}, location: new URL(options.url ?? "https://site.test/"), document, localStorage, sessionStorage,
    Date: class extends Date { static now() { return time; } },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` },
    fetch: (_url, init) => { calls.push({ ...init, payload: JSON.parse(init.body) }); return options.fetch ? options.fetch(init) : Promise.resolve({ ok: true }); },
  };
  vm.runInNewContext(`${source.replace(/^export /gm, "")}\nglobalThis.subject = { trackPageView, trackNewCheck, trackCheckCompleted };`, context);
  return { ...context.subject, calls, localStorage, sessionStorage, context, listeners, advance(ms) { time += ms; }, visible() { document.visibilityState = "visible"; for (const fn of [...listeners.keys()]) fn(); } };
}

test("StrictMode, renderizações e retries da mesma página produzem só uma abertura", async () => {
  const b = browser();
  b.trackPageView("published-a"); b.trackPageView("published-a"); b.trackPageView("published-a"); await flush();
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].payload.checkId, "published-a");
  assert.equal(b.calls[0].keepalive, true); assert.equal(b.calls[0].payload.event, "page_view");
  assert.match(b.calls[0].payload.eventId, UUID); assert.match(b.calls[0].payload.visitorId, UUID);
});

test("recarregar a página gera outro acesso, mantendo o visitante dentro dos 30 dias", async () => {
  const sharedStorage = storage();
  const a = browser({ localStorage: sharedStorage }); a.trackPageView(); await flush();
  const b = browser({ localStorage: sharedStorage }); b.trackPageView(); await flush();
  assert.equal(a.calls.length + b.calls.length, 2);
  assert.equal(a.calls[0].payload.visitorId, b.calls[0].payload.visitorId);
});

test("página oculta não conta; tornar visível conta uma vez e remover listener cancela", async () => {
  const b = browser({ visibility: "hidden" });
  b.trackPageView("published-a"); assert.equal(b.calls.length, 0);
  b.visible(); b.visible(); await flush(); assert.equal(b.calls.length, 1); assert.equal(b.listeners.size, 0);
  const c = browser({ visibility: "hidden" }); const stop = c.trackPageView(); stop(); c.visible(); await flush();
  assert.equal(c.calls.length, 0);
});

test("DNT, GPC e páginas de admin não geram eventos nem identificador local", async (t) => {
  for (const options of [{ navigator: { doNotTrack: "1" } }, { navigator: { globalPrivacyControl: true } }, { url: "https://site.test/admin" }, { url: "https://site.test/#/admin" }]) await t.test(JSON.stringify(options), async () => {
    const b = browser(options); b.trackPageView("published-a"); b.trackNewCheck("published-a"); await flush();
    assert.equal(b.calls.length, 0); assert.equal(b.localStorage.writes.length, 0);
  });
});

test("armazenamento bloqueado e falha de rede não interrompem a interface", async () => {
  const b = browser({ blockStorage: true, fetch: () => Promise.reject(new Error("offline")) });
  assert.doesNotThrow(() => { b.trackPageView("a"); b.trackPageView("b"); }); await flush();
  assert.equal(b.calls.length, 2); assert.equal(b.calls[0].payload.visitorId, b.calls[1].payload.visitorId);
});

test("identificador expirado ou corrompido é substituído por UUID válido", async (t) => {
  for (const item of [{ id: "corrupted", expiresAt: Date.now() + 10 ** 12 }, { id: "00000000-0000-4000-8000-999999999999", expiresAt: 1 }, null]) await t.test(JSON.stringify(item), async () => {
    const b = browser({ localStorage: storage({ [VISITOR_KEY]: JSON.stringify(item) }) }); b.trackPageView(); await flush();
    assert.match(b.calls[0].payload.visitorId, UUID);
    assert.notEqual(b.calls[0].payload.visitorId, item?.id);
  });
});

test("origens são categorias fechadas; parâmetros e URLs completos não são enviados", async (t) => {
  const cases = [
    ["https://site.test/?check=a&utm_source=whatsapp&token=private", "https://google.com/?q=secret", "whatsapp"],
    ["https://site.test/?utm_source=ig", "", "instagram"],
    ["https://site.test/?utm_source=arbitrary-secret", "", "direct"],
    ["https://site.test/", "https://l.instagram.com/?token=secret", "instagram"],
    ["https://site.test/", "https://www.google.com.br/search?q=secret", "google"],
    ["https://site.test/", "https://t.co/secret", "x"],
    ["https://site.test/", "https://site.test/?secret=private", "internal"],
    ["https://site.test/", "https://somewhere.test/?token=private", "other"],
  ];
  for (const [url, referrer, expected] of cases) await t.test(expected, async () => {
    const b = browser({ url, referrer }); b.trackPageView(); await flush();
    assert.equal(b.calls[0].payload.source, expected);
    assert.doesNotMatch(JSON.stringify(b.calls[0].payload), /secret|token|https:/);
  });
});

test("CTA espera a abertura persistir e conclusão espera o CTA, sem bloquear a UI", async () => {
  let finishView, finishClick;
  const b = browser({ fetch: (init) => {
    const event = JSON.parse(init.body).event;
    if (event === "page_view") return new Promise((resolve) => { finishView = resolve; });
    if (event === "new_check") return new Promise((resolve) => { finishClick = resolve; });
    return Promise.resolve({ ok: true });
  } });
  b.trackPageView("a"); b.trackNewCheck("a"); await flush(); assert.equal(b.calls.length, 1);
  finishView({ ok: true }); await flush(); assert.equal(b.calls[1].payload.event, "new_check");
  b.trackCheckCompleted(); await flush(); assert.equal(b.calls.length, 2);
  finishClick({ ok: true }); await flush(); assert.equal(b.calls[2].payload.event, "check_completed");
  b.trackCheckCompleted(); await flush(); assert.equal(b.calls.length, 3);
});

test("atribuição expira em 30 minutos e não inventa conversão sem CTA", async () => {
  const b = browser(); b.trackCheckCompleted(); await flush(); assert.equal(b.calls.length, 0);
  b.trackPageView("a"); b.trackNewCheck("a"); await flush(); b.advance(30 * 60000 + 1); b.trackCheckCompleted(); await flush();
  assert.equal(b.calls.filter((c) => c.payload.event === "check_completed").length, 0);
});

test("atribuição preserva a origem do link após recarregar a página", async () => {
  const localStorage = storage(), sessionStorage = storage();
  const a = browser({ localStorage, sessionStorage, url: "https://site.test/?check=a&utm_source=whatsapp" });
  a.trackPageView("a"); a.trackNewCheck("a"); await flush();
  const b = browser({ localStorage, sessionStorage, url: "https://site.test/" });
  b.trackCheckCompleted(); await flush();
  assert.equal(b.calls[0].payload.event, "check_completed"); assert.equal(b.calls[0].payload.source, "whatsapp");
  assert.equal(sessionStorage.getItem(ATTRIBUTION_KEY), null);
});

test("conclusão rápida não ultrapassa o CTA quando a gravação da abertura está lenta", async () => {
  let release;
  const b = browser({ fetch: (init) => JSON.parse(init.body).event === "page_view" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ ok: true }) });
  b.trackPageView("a"); b.trackNewCheck("a"); b.trackCheckCompleted(); await flush();
  assert.equal(b.calls.length, 1);
  release({ ok: true }); await flush();
  assert.deepEqual(b.calls.map((call) => call.payload.event), ["page_view", "new_check", "check_completed"]);
});

test("utm_source que coincide com propriedade de Object continua sendo origem desconhecida", async () => {
  const b = browser({ url: "https://site.test/?utm_source=constructor" }); b.trackPageView(); await flush();
  assert.equal(b.calls[0].payload.source, "direct");
});
