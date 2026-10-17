// PostgreSQL real em WebAssembly, em memória: executa a migração do repositório.
// Nenhuma credencial, conexão externa ou escrita no Supabase de produção.
import { describe, test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { audienceSnapshot } from "../server/audience.js";
import { PGlite } from "@electric-sql/pglite";
const hash = (value) => createHash("sha256").update(value).digest("hex");
let db;
async function record({ event = "page_view", checkId = "a", visitor = "one", id = randomUUID(), source = "whatsapp", country = "BR", state = "SP", region = "Sudeste" } = {}) {
  await db.query("select public.iev_record_audience($1,$2,$3,$4,$5,$6,$7,$8)", [id, hash(visitor), event, checkId, source, country, state, region]);
}
async function seed({ event = "page_view", checkId = "a", visitor = "one", source = "whatsapp", country = "BR", state = "SP", region = "Sudeste", ago = "1 minute" } = {}) {
  await db.query("insert into iev_audience_events(event_id,at,visitor_hash,event,check_id,source,country,state,region) values($1,now()-$2::interval,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), ago, hash(visitor), event, checkId, source, country, state, region]);
}
async function snapshot(extra = {}) {
  const args = { checkId: null, scope: "all", region: null, state: null, source: null, q: "", offset: 0, limit: 15, ...extra };
  const result = await db.query("select iev_audience_snapshot(now()-interval '7 days',now(),$1,$2,$3,$4,$5,$6,$7,$8) as audience", Object.values(args));
  return result.rows[0].audience;
}

describe("contrato de audiência no PostgreSQL", () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;
      create table public.iev_checks(id text primary key,outcome text,published_at timestamptz,public_envelope jsonb,log jsonb);
      grant select on public.iev_checks to service_role;`);
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    const migration = (await readdir(migrations)).find((name) => name.endsWith("_link_audience_tracking.sql"));
    assert.ok(migration, "a migração de produção precisa estar versionada");
    await db.exec(await readFile(new URL(migration, migrations), "utf8"));
  });
  beforeEach(async () => {
    await db.exec(`begin;
      insert into iev_checks values
        ('a','checked',now()-interval '2 days','{"origin":{"title":"Vacinação no Brasil"}}','{"secret":"PRIVATE-LOG-SENTINEL"}'),
        ('b','checked',now()-interval '1 day','{"result":{"claims":[{"text":"Contexto de uma imagem"}]}}','{}'),
        ('zero','checked',now()-interval '1 day','{}','{}'),
        ('private','checked',null,'{}','{}'),
        ('refused','content_refused',now()-interval '1 day','{}','{}');`);
  });
  afterEach(async () => { await db.exec("rollback"); });
  after(async () => { await db.close(); });

  test("UUID idempotente não duplica acessos, mas recarregamentos reais contam", async () => {
    await db.exec("set local role service_role");
    const id = randomUUID();
    await record({ id }); await record({ id }); await record({ visitor: "one" }); await record({ visitor: "two" });
    await db.exec("update iev_audience_events set at=now()-interval '1 second'");
    const a = await snapshot();
    assert.equal(a.summary.views, 3); assert.equal(a.summary.visitors, 2);
    assert.equal(a.summary.sharedViews, 3); assert.equal(a.links.find((link) => link.id === "a").visitors, 2);
  });

  test("IDs privados, inexistentes e conteúdo recusado não recebem contador público", async () => {
    await db.exec("set local role service_role");
    for (const checkId of ["private", "missing", "refused"]) await record({ checkId });
    assert.equal((await db.query("select count(*)::int as total from iev_audience_events")).rows[0].total, 0);
    assert.deepEqual((await snapshot()).links.map((link) => link.id).sort(), ["a", "b", "zero"]);
  });

  test("home é audiência do site, sem inflar aberturas de links", async () => {
    await seed({ checkId: null }); await seed({ visitor: "two" });
    const all = await snapshot(); assert.equal(all.summary.views, 2); assert.equal(all.summary.sharedViews, 1);
    const shared = await snapshot({ scope: "shared" }); assert.equal(shared.summary.views, 1);
    assert.equal(shared.summary.reachedLinks, 1);
  });

  test("filtros por UF, região, origem e link são combinados no banco", async () => {
    await seed(); await seed({ visitor: "two", state: "BA", region: "Nordeste", source: "instagram", checkId: "b" });
    await seed({ visitor: "three", state: "RJ" });
    assert.equal((await snapshot({ state: "SP" })).summary.views, 1);
    assert.equal((await snapshot({ region: "Sudeste" })).summary.views, 2);
    assert.equal((await snapshot({ source: "instagram", region: "Nordeste", checkId: "b" })).summary.views, 1);
    assert.equal((await snapshot({ source: "instagram", state: "SP" })).summary.views, 0);
    assert.equal((await snapshot({ checkId: "b" })).links[0].id, "b");
  });

  test("geografia separa Brasil, país estrangeiro, localização desconhecida e UF ausente", async () => {
    await seed();
    await seed({ visitor: "two", country: "US", state: null, region: null });
    await seed({ visitor: "three", country: null, state: null, region: null });
    await seed({ visitor: "four", country: "BR", state: null, region: null });
    const a = await snapshot();
    assert.equal(a.summary.brazilViews, 2); assert.equal(a.summary.unknownLocation, 2);
    assert.deepEqual(a.regions.map((row) => row.name).sort(), ["Sudeste", "international", "unknown", "unknown_br"]);
    assert.deepEqual(a.states.map((row) => row.name).sort(), ["SP", "unknown"]);
  });

  test("ranking inclui links sem visitas, títulos públicos, paginação e busca literal", async () => {
    await seed({ checkId: "a" }); await seed({ checkId: "b" }); await seed({ checkId: "b", visitor: "two" });
    const all = await snapshot(); assert.equal(all.linkTotal, 3); assert.deepEqual(all.links.map((row) => row.id), ["b", "a", "zero"]);
    assert.equal(all.links[0].title, "Contexto de uma imagem"); assert.equal(all.links[2].views, 0);
    const first = await snapshot({ offset: 0, limit: 1 }), second = await snapshot({ offset: 1, limit: 1 });
    assert.equal(first.links.length, 1); assert.equal(second.links.length, 1); assert.notEqual(first.links[0].id, second.links[0].id);
    assert.equal((await snapshot({ q: "VACINAÇÃO" })).linkTotal, 1);
    assert.equal((await snapshot({ q: "%'; drop table iev_checks;--" })).linkTotal, 0);
    assert.equal((await snapshot({ q: "não existe" })).summary.views, 3, "busca do ranking não altera o agregado da audiência");
    assert.doesNotMatch(JSON.stringify(all), /PRIVATE-LOG-SENTINEL|visitor_hash|event_id/);
  });

  test("funnel exige abertura anterior, CTA e mesmo visitante/link dentro de 30 minutos", async () => {
    await db.exec("set local role service_role");
    await record({ event: "new_check" }); await record({ event: "check_completed" });
    assert.equal((await db.query("select count(*)::int as total from iev_audience_events")).rows[0].total, 0);
    await record();
    await record({ event: "check_completed" }); // sem CTA: ignora
    await record({ event: "new_check", visitor: "stranger" });
    await record({ event: "new_check", checkId: "b" });
    await record({ event: "new_check" }); await record({ event: "check_completed" });
    await record({ event: "new_check" }); await record({ event: "check_completed" });
    await db.exec("update iev_audience_events set at=now()-interval '1 second'");
    const a = await snapshot();
    assert.equal(a.summary.clicks, 1); assert.equal(a.summary.conversions, 1); assert.equal(a.links.find((l) => l.id === "a").conversions, 1);
    await db.exec("update iev_audience_events set at=now()-interval '31 minutes'");
    const before = (await db.query("select count(*)::int as total from iev_audience_events")).rows[0].total;
    await record({ event: "new_check" }); await record({ event: "check_completed" });
    assert.equal((await db.query("select count(*)::int as total from iev_audience_events")).rows[0].total, before);
  });

  test("CTA sem abertura na janela filtrada não cria taxa acima de 100%", async () => {
    await seed({ ago: "8 days" }); await seed({ event: "new_check", ago: "1 minute" });
    const a = await snapshot(); assert.equal(a.summary.sharedVisitors, 0); assert.equal(a.summary.clicks, 0);
  });

  test("série diária usa fronteira de Brasília e únicos não são somados entre dias", async () => {
    const result = await db.query(`select (date_trunc('day',now() at time zone 'America/Sao_Paulo') - interval '1 day') at time zone 'America/Sao_Paulo' as boundary`);
    const boundary = new Date(result.rows[0].boundary);
    for (const delta of [-1000, 1000]) await db.query("insert into iev_audience_events(event_id,at,visitor_hash,event,check_id,source) values($1,$2,$3,'page_view','a','direct')", [randomUUID(), new Date(boundary.getTime() + delta).toISOString(), hash("same-browser")]);
    const a = await snapshot(); const active = a.daily.filter((day) => day.views > 0);
    assert.equal(active.length, 2); assert.equal(active[0].views, 1); assert.equal(active[1].views, 1);
    assert.equal(a.summary.visitors, 1); assert.equal(active.reduce((sum, d) => sum + d.visitors, 0), 2);
    assert.ok(a.daily.some((day) => day.views === 0), "dias sem acessos também aparecem");
  });

  test("limpeza em lotes remove eventos vencidos sem apagar acessos recentes", async () => {
    await db.query("insert into iev_audience_events(event_id,at,visitor_hash,event,source) select gen_random_uuid(),now()-interval '91 days',$1,'page_view','direct' from generate_series(1,501)", [hash("old")]);
    await seed();
    await db.exec("set local role service_role");
    await record({ checkId: null });
    assert.equal((await db.query("select count(*)::int as total from iev_audience_events where at<now()-interval '90 days'")).rows[0].total, 1);
    assert.equal((await snapshot()).summary.views, 1, "eventos vencidos nunca entram no painel");
    await record({ checkId: null });
    assert.equal((await db.query("select count(*)::int as total from iev_audience_events where at<now()-interval '90 days'")).rows[0].total, 0);
    assert.equal((await snapshot()).summary.views, 1);
  });

  test("resposta real da RPC satisfaz o contrato do endpoint administrativo", async () => {
    await seed();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const p = JSON.parse(options.body);
      const { rows } = await db.query("select iev_audience_snapshot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as audience", [p.p_from,p.p_to,p.p_check_id,p.p_scope,p.p_region,p.p_state,p.p_source,p.p_query,p.p_offset,p.p_limit]);
      return Response.json(rows[0].audience);
    };
    try {
      const result = await audienceSnapshot({}, { SUPABASE_URL: "https://isolated.test", SUPABASE_SERVICE_ROLE_KEY: "dummy-local-key" });
      assert.equal(result.status, 200);
      assert.equal(result.body.audience.summary.views, 1);
      assert.equal(result.body.audience.links.length, 3);
    } finally { globalThis.fetch = previousFetch; }
  });

  test("RLS forçado, roles públicas sem acesso e RPCs sem elevação de privilégio", async () => {
    const table = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='iev_audience_events'::regclass")).rows[0];
    assert.equal(table.relrowsecurity, true); assert.equal(table.relforcerowsecurity, true);
    assert.ok((await db.query("select prosecdef from pg_proc where proname in ('iev_record_audience','iev_audience_snapshot')")).rows.every((row) => row.prosecdef === false));
    for (const role of ["anon", "authenticated"]) for (const sql of ["select * from iev_audience_events", "select iev_audience_snapshot(now()-interval '7 days',now())", "select iev_record_audience(gen_random_uuid(),repeat('a',64),'page_view',null,'direct',null,null,null)"]) {
      await db.exec(`savepoint denied; set local role ${role}`);
      await assert.rejects(db.query(sql), /permission denied/);
      await db.exec("rollback to savepoint denied; release savepoint denied");
    }
  });
});
