import { test, expect } from "@playwright/test";

const PUBLIC = { checkId: "published-a", createdAt: "2026-10-16T15:00:00Z", origin: { title: "Vacinação no Brasil" }, result: { outcome: "checked", verdict: "true", score: 92, summary: "Resultado público de demonstração para o teste.", claims: [], sources: [] } };
const summary = { views: 120, visitors: 80, sharedViews: 100, sharedVisitors: 70, reachedLinks: 1, clicks: 14, conversions: 5, publishedLinks: 2, brazilViews: 90, unknownLocation: 10 };
const link = (id, title, views = 0) => ({ id, title, views, visitors: views ? 20 : 0, clicks: views ? 4 : 0, conversions: 0, published_at: "2026-10-16T15:00:00Z", last_view: views ? "2026-10-17T12:00:00Z" : null });
function audience(query) {
  const detailed = query.get("checkId") === "published-a";
  const links = detailed ? [link("published-a", "Vacinação no Brasil", 30)] : [link("published-a", "Vacinação no Brasil", 30), link("published-zero", "Imagem ainda sem visitas")];
  return { audience: {
    summary: { ...summary, ...(detailed ? { views: 30 } : {}) },
    links: query.get("q") ? links.filter((l) => l.title.toLowerCase().includes(query.get("q").toLowerCase())) : links,
    linkTotal: query.get("q") ? 1 : links.length,
    daily: [{ date: "2026-10-15", views: 40, visitors: 30, sharedViews: 30 }, { date: "2026-10-16", views: 0, visitors: 0, sharedViews: 0 }, { date: "2026-10-17", views: 80, visitors: 50, sharedViews: 70 }],
    regions: [{ name: "Sudeste", views: 90, visitors: 65 }, { name: "international", views: 20, visitors: 10 }, { name: "unknown", views: 10, visitors: 5 }],
    states: [{ name: "SP", views: 90, visitors: 65 }], sources: [{ name: "whatsapp", views: 70, visitors: 50 }, { name: "direct", views: 50, visitors: 30 }],
    capturedAt: "2026-10-17T12:00:00Z", timeZone: "America/Sao_Paulo", retentionDays: 90, trackingSince: "2026-10-15T12:00:00Z",
  }, enabled: true };
}
async function setup(page, { admin = false, override } = {}) {
  const events = [], queries = [], errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (admin) await page.addInitScript(() => sessionStorage.setItem("iev-admin-secret", "local-e2e-dummy-secret-at-least-32-chars"));
  // Apenas localhost é permitido. Não há chamadas a Supabase/IA/Vercel nos testes.
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (override && await override({ url, route })) return;
    if (url.pathname === "/api/audience") { events.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); }
    if (url.pathname === "/api/checks") return route.fulfill({ json: PUBLIC });
    if (url.pathname === "/api/verify") {
      const envelope = { ...PUBLIC, checkId: "new-check" };
      const body = [{ type: "accepted", checkId: "new-check", recoveryAvailable: false }, { type: "result", checkId: "new-check", envelope }].map(JSON.stringify).join("\n") + "\n";
      return route.fulfill({ contentType: "application/x-ndjson", body });
    }
    if (url.pathname !== "/api/admin") return route.fulfill({ status: 503, json: { error: "external_api_not_allowed_in_tests" } });
    if (url.searchParams.has("audience")) { queries.push(url.searchParams); return route.fulfill({ json: audience(url.searchParams) }); }
    if (url.searchParams.has("config")) return route.fulfill({ json: { catalog: { providers: {}, steps: [] }, config: {}, persisted: true, source: "supabase" } });
    if (url.searchParams.has("metrics")) return route.fulfill({ json: { metrics: { source: "supabase", checks: 3, daily: [], cached: 0, byKind: { text: 3 }, byOutcome: { checked: 3 }, verdicts: {}, errors: {}, tokens: {}, media: {}, moderation: {}, corrections: {}, alerts: [], thresholds: { minSample: 10 }, window: { sample: 3 }, usageOptions: {} } } });
    return route.fulfill({ json: { items: [], total: 0, mode: "supabase" } });
  });
  return { events, queries, errors };
}
const openAdmin = async (page) => { await page.goto("/admin?section=metrics"); await expect(page.getByRole("heading", { name: "Até onde a checagem chega." })).toBeVisible(); await expect(page.locator(".audience-kpis article")).toHaveCount(4); };
async function choose(page, label, value) {
  await page.locator(".audience-filters label").filter({ hasText: label }).getByRole("combobox").click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

test("abertura compartilhada conta uma vez, mesmo com StrictMode e renderizações", async ({ page }) => {
  const { events, errors } = await setup(page);
  await page.goto("/?check=published-a&utm_source=whatsapp");
  await expect(page.getByRole("button", { name: "Fazer uma checagem", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(events.filter((e) => e.event === "page_view" && e.checkId === "published-a")).toHaveLength(1);
  expect(events[0].source).toBe("whatsapp"); expect(errors).toEqual([]);
});

test("home conta acesso e recarregar preserva o visitante estimado", async ({ page }) => {
  const { events } = await setup(page);
  await page.goto("/"); await expect.poll(() => events.length).toBe(1);
  const visitor = events[0].visitorId;
  await page.reload(); await expect.poll(() => events.length).toBe(2);
  expect(events[1].visitorId).toBe(visitor); expect(events[1].eventId).not.toBe(events[0].eventId);
});

test("link não publicado não conta; recuperação depois de erro conta uma única abertura", async ({ page }) => {
  let missing = true;
  const { events } = await setup(page, { override: async ({ url, route }) => {
    if (url.pathname === "/api/checks" && missing) { await route.fulfill({ status: 404, json: { error: "not_found" } }); return true; }
    return false;
  } });
  await page.goto("/?check=published-a"); await expect(page.getByRole("heading", { name: "Checagem não encontrada" })).toBeVisible(); expect(events).toHaveLength(0);
  missing = false; await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect.poll(() => events.length).toBe(1); expect(events[0].checkId).toBe("published-a");
});

test("CTA e checagem concluída preservam a atribuição do link", async ({ page }) => {
  const { events } = await setup(page);
  await page.goto("/?check=published-a&utm_source=whatsapp");
  await page.getByRole("button", { name: "Fazer uma checagem", exact: true }).click();
  await expect.poll(() => events.some((e) => e.event === "new_check")).toBe(true);
  await page.getByRole("tab", { name: "Texto", exact: true }).click();
  await page.locator("textarea#verify-input").fill("O Brasil tem mais de duzentos milhões de habitantes.");
  await page.getByRole("button", { name: "Checar agora", exact: true }).click();
  await expect.poll(() => events.some((e) => e.event === "check_completed")).toBe(true);
  const attributed = events.filter((e) => e.event !== "page_view");
  expect(attributed.map((e) => e.event)).toEqual(["new_check", "check_completed"]);
  expect(attributed.every((e) => e.checkId === "published-a" && e.source === "whatsapp")).toBe(true);
});

test("falha de analytics não impede abrir o resultado público", async ({ page }) => {
  const { errors } = await setup(page, { override: async ({ url, route }) => {
    if (url.pathname === "/api/audience") { await route.abort(); return true; } return false;
  } });
  await page.goto("/?check=published-a");
  await expect(page.getByRole("button", { name: "Fazer uma checagem", exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test("admin mostra cards, ranking com zero e operação separada, sem registrar visitas", async ({ page }) => {
  const { events, errors } = await setup(page, { admin: true }); await openAdmin(page);
  await expect(page.getByRole("button", { name: "Imagem ainda sem visitas", exact: true })).toBeVisible();
  await expect(page.locator(".audience-links").getByText("Sem visitas", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Operação & IA" }).click();
  await expect(page.getByRole("heading", { name: "Métricas", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Audiência & links" }).click();
  await expect(page.getByRole("heading", { name: "Até onde a checagem chega." })).toBeVisible();
  expect(events).toEqual([]); expect(errors).toEqual([]);
});

test("filtros chegam ao servidor; estado e região não ficam em conflito", async ({ page }) => {
  const { queries } = await setup(page, { admin: true }); await openAdmin(page);
  await choose(page, "Região", "Sudeste"); await expect.poll(() => queries.at(-1)?.get("region")).toBe("Sudeste");
  await choose(page, "Estado", "SP · São Paulo"); await expect.poll(() => queries.at(-1)?.get("state")).toBe("SP"); expect(queries.at(-1).has("region")).toBe(false);
  await choose(page, "Origem", "WhatsApp"); await expect.poll(() => queries.at(-1)?.get("source")).toBe("whatsapp");
  await choose(page, "Período", "Personalizado");
  await page.locator('.audience-filters input[type="date"]').nth(0).fill("2026-10-10"); await page.locator('.audience-filters input[type="date"]').nth(1).fill("2026-10-15");
  await expect.poll(() => queries.at(-1)?.get("to")).toBe("2026-10-15"); expect(queries.at(-1).get("from")).toBe("2026-10-10");
  await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("period")).toBe("7d"); expect(queries.at(-1).has("source")).toBe(false);
});

test("detalhamento de um link filtra todos os gráficos e pode voltar ao agregado", async ({ page }) => {
  const { queries } = await setup(page, { admin: true }); await openAdmin(page);
  await page.getByRole("button", { name: "Vacinação no Brasil", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get("checkId")).toBe("published-a");
  await expect(page.locator(".audience-selected")).toContainText("Vacinação no Brasil");
  await expect(page.locator(".audience-kpis article").first().locator("strong")).toHaveText("30");
  await page.getByRole("button", { name: "Voltar a todos os links" }).click();
  await expect(page.locator(".audience-selected")).toHaveCount(0);
  await expect.poll(() => queries.at(-1)?.has("checkId")).toBe(false);
});

test("busca permanece focada durante atualizações e não perde texto digitado", async ({ page }) => {
  const { queries } = await setup(page, { admin: true }); await openAdmin(page);
  const search = page.getByRole("searchbox");
  await search.fill("v"); await expect.poll(() => queries.at(-1)?.get("q")).toBe("v"); await expect(search).toBeFocused();
  await search.pressSequentially("acinação", { delay: 25 }); await expect(search).toHaveValue("vacinação");
  await expect.poll(() => queries.at(-1)?.get("q")).toBe("vacinação"); await expect(search).toBeFocused();
});

test("resposta antiga não substitui dados de uma busca mais recente", async ({ page }) => {
  let release, slowRequested = false;
  const gate = new Promise((resolve) => { release = resolve; });
  await setup(page, { admin: true, override: async ({ url, route }) => {
    if (url.searchParams.get("q") === "slow") { slowRequested = true; await gate; const data = audience(url.searchParams); data.audience.summary.views = 1; await route.fulfill({ json: data }); return true; }
    if (url.searchParams.get("q") === "fast") { const data = audience(url.searchParams); data.audience.summary.views = 42; await route.fulfill({ json: data }); return true; }
    return false;
  } });
  await openAdmin(page); const search = page.getByRole("searchbox");
  await search.fill("slow"); await expect.poll(() => slowRequested).toBe(true);
  await search.fill("fast"); await expect(page.locator(".audience-kpis article").first().locator("strong")).toHaveText("42");
  release(); await page.waitForLoadState("networkidle");
  await expect(page.locator(".audience-kpis article").first().locator("strong")).toHaveText("42");
});

test("indisponibilidade é exibida como erro, não como zero, e permite recarregar", async ({ page }) => {
  let failed = true;
  await setup(page, { admin: true, override: async ({ url, route }) => {
    if (url.searchParams.has("audience") && failed) { await route.fulfill({ status: 502, json: { error: "audience_unavailable", message: "Contadores indisponíveis, não zerados." } }); return true; } return false;
  } });
  await page.goto("/admin?section=metrics"); await expect(page.getByRole("alert")).toContainText("não zerados");
  await expect(page.locator(".audience-kpis article")).toHaveCount(0);
  failed = false; await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.locator(".audience-kpis article")).toHaveCount(4);
});

test("layout cabe na tela e copiar link não inclui credenciais", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.__copiedPublicLink = text; } }, configurable: true }); });
  const { errors } = await setup(page, { admin: true }); await openAdmin(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Copiar link de Vacinação no Brasil" }).click();
  expect(await page.evaluate(() => window.__copiedPublicLink)).toMatch(/^http:\/\/127\.0\.0\.1:4175\/check\/published-a$/);
  await page.getByText("Ver valores por dia", { exact: true }).click();
  await expect(page.locator(".audience-data-table table")).toBeVisible(); expect(errors).toEqual([]);
});
