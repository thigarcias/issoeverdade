-- Audiência privada: acesso somente pelo servidor. IPs e referências completas
-- não entram na tabela; eventos são deduplicados e agregados no PostgreSQL.
begin;
create table public.iev_audience_events (
  event_id uuid primary key,
  at timestamptz not null default now(),
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  event text not null check (event in ('page_view', 'new_check', 'check_completed')),
  check_id text references public.iev_checks(id) on delete cascade,
  source text not null check (source in ('direct','whatsapp','instagram','facebook','google','youtube','tiktok','x','telegram','other','internal')),
  country text check (country ~ '^[A-Z]{2}$'),
  state text check (state in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
  region text check (region in ('Norte','Nordeste','Centro-Oeste','Sudeste','Sul')),
  check (event = 'page_view' or check_id is not null),
  check (state is null or country = 'BR')
);
create index iev_audience_at_idx on public.iev_audience_events (at desc);
create index iev_audience_check_at_idx on public.iev_audience_events (check_id, at desc) where check_id is not null;
create index iev_audience_visitor_check_idx on public.iev_audience_events (visitor_hash, check_id, at desc);
alter table public.iev_audience_events enable row level security;
alter table public.iev_audience_events force row level security;
revoke all on public.iev_audience_events from public, anon, authenticated;
grant select, insert, update, delete on public.iev_audience_events to service_role;

create function public.iev_record_audience(
  p_event_id uuid, p_visitor text, p_event text, p_check_id text,
  p_source text, p_country text, p_state text, p_region text
) returns void language plpgsql security invoker
set search_path = public, pg_catalog as $$
begin
  -- Um ID privado/inexistente nunca recebe um contador de link público.
  if p_check_id is not null and not exists (
    select 1 from public.iev_checks where id = p_check_id and published_at is not null and outcome <> 'content_refused'
  ) then return; end if;
  if p_event <> 'page_view' and not exists (
    select 1 from public.iev_audience_events
    where visitor_hash = p_visitor and check_id = p_check_id and event = case when p_event = 'check_completed' then 'new_check' else 'page_view' end
      and at >= now() - interval '30 minutes'
  ) then return; end if;
  delete from public.iev_audience_events where event_id in (
    select event_id from public.iev_audience_events where at < now() - interval '90 days'
    order by at limit 500 for update skip locked
  );
  insert into public.iev_audience_events(event_id, visitor_hash, event, check_id, source, country, state, region)
  values(p_event_id, p_visitor, p_event, p_check_id, p_source, p_country, p_state, p_region)
  on conflict(event_id) do nothing;
end;
$$;
revoke all on function public.iev_record_audience(uuid,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.iev_record_audience(uuid,text,text,text,text,text,text,text) to service_role;

create function public.iev_audience_snapshot(
  p_from timestamptz, p_to timestamptz, p_check_id text default null,
  p_scope text default 'all', p_region text default null, p_state text default null,
  p_source text default null, p_query text default '', p_offset integer default 0, p_limit integer default 15
) returns jsonb language sql stable security invoker
set search_path = public, pg_catalog as $$
with filtered as materialized (
  select * from public.iev_audience_events
  where at >= greatest(p_from, date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' - interval '89 days')
    and at < least(p_to, now())
    and (p_check_id is null or check_id = p_check_id)
    and (p_scope = 'all' or check_id is not null)
    and (p_region is null or region = p_region)
    and (p_state is null or state = p_state)
    and (p_source is null or source = p_source)
), views as materialized (
  select * from filtered where event = 'page_view'
), per_link as (
  select check_id, count(*) filter(where event = 'page_view') as views,
    count(distinct visitor_hash) filter(where event = 'page_view') as visitors,
    count(distinct visitor_hash) filter(where event = 'new_check' and exists(select 1 from views v where v.check_id = filtered.check_id and v.visitor_hash = filtered.visitor_hash)) as clicks,
    count(distinct visitor_hash) filter(where event = 'check_completed' and exists(select 1 from views v where v.check_id = filtered.check_id and v.visitor_hash = filtered.visitor_hash)) as conversions,
    max(at) filter(where event = 'page_view') as last_view
  from filtered where check_id is not null group by check_id
), link_catalog as materialized (
  select c.id, left(coalesce(nullif(c.public_envelope #>> '{origin,title}', ''),
      c.public_envelope #>> '{result,claims,0,text}', 'Checagem compartilhada'), 180) as title,
    c.published_at, coalesce(l.views,0) as views, coalesce(l.visitors,0) as visitors,
    coalesce(l.clicks,0) as clicks, coalesce(l.conversions,0) as conversions, l.last_view
  from public.iev_checks c left join per_link l on l.check_id = c.id
  where c.published_at is not null and c.outcome <> 'content_refused'
    and (p_check_id is null or c.id = p_check_id)
), links as materialized (
  select * from link_catalog where p_query = '' or position(lower(p_query) in lower(title)) > 0 or position(lower(p_query) in lower(id)) > 0
), days as (
  select generate_series((p_from at time zone 'America/Sao_Paulo')::date,
    ((least(p_to, now()) - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date, interval '1 day')::date as day
), daily as (
  select (at at time zone 'America/Sao_Paulo')::date as day, count(*) as views,
    count(distinct visitor_hash) as visitors, count(*) filter(where check_id is not null) as shared_views
  from views group by 1
), regions as (
  select case when country is null then 'unknown' when country <> 'BR' then 'international' else coalesce(region,'unknown_br') end as name,
    count(*) as views, count(distinct visitor_hash) as visitors
  from views group by 1
), states as (
  select coalesce(state,'unknown') as name, count(*) as views, count(distinct visitor_hash) as visitors
  from views where country = 'BR' group by 1
), sources as (
  select source as name, count(*) as views, count(distinct visitor_hash) as visitors from views group by source
)
select jsonb_build_object(
  'summary', jsonb_build_object(
    'views', (select count(*) from views),
    'visitors', (select count(distinct visitor_hash) from views),
    'sharedViews', (select count(*) from views where check_id is not null),
    'sharedVisitors', (select count(distinct visitor_hash) from views where check_id is not null),
    'reachedLinks', (select count(distinct check_id) from views),
    'clicks', (select count(distinct visitor_hash) from filtered f where event = 'new_check' and exists(select 1 from views v where v.check_id = f.check_id and v.visitor_hash = f.visitor_hash)),
    'conversions', (select count(distinct visitor_hash) from filtered f where event = 'check_completed' and exists(select 1 from views v where v.check_id = f.check_id and v.visitor_hash = f.visitor_hash)),
    'publishedLinks', (select count(*) from public.iev_checks where published_at >= p_from and published_at < p_to and outcome <> 'content_refused'),
    'brazilViews', (select count(*) from views where country = 'BR'),
    'unknownLocation', (select count(*) from views where country is null or (country = 'BR' and state is null))
  ),
  'daily', coalesce((select jsonb_agg(jsonb_build_object('date',d.day,'views',coalesce(v.views,0),'visitors',coalesce(v.visitors,0),'sharedViews',coalesce(v.shared_views,0)) order by d.day) from days d left join daily v using(day)), '[]'::jsonb),
  'regions', coalesce((select jsonb_agg(r order by views desc, name) from regions r), '[]'::jsonb),
  'states', coalesce((select jsonb_agg(s order by views desc, name) from states s), '[]'::jsonb),
  'sources', coalesce((select jsonb_agg(s order by views desc, name) from sources s), '[]'::jsonb),
  'links', coalesce((select jsonb_agg(l) from (
    select * from links order by views desc, published_at desc, id
    offset greatest(0,least(p_offset,150000)) limit greatest(1,least(p_limit,50))
  ) l), '[]'::jsonb),
  'linkTotal', (select count(*) from links),
  'capturedAt', now(), 'timeZone', 'America/Sao_Paulo', 'retentionDays', 90,
  'trackingSince', (select min(at) from public.iev_audience_events)
);
$$;
revoke all on function public.iev_audience_snapshot(timestamptz,timestamptz,text,text,text,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.iev_audience_snapshot(timestamptz,timestamptz,text,text,text,text,text,text,integer,integer) to service_role;
commit;
