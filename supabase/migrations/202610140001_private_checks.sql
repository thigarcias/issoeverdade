-- Apply in the Supabase SQL editor before configuring the server service role.
-- Anonymous/authenticated clients have no direct read/write access, even after
-- publication. Public access is exclusively through the sanitized server API.
begin;

create table if not exists public.iev_checks (
  id text primary key check (id ~ '^[a-zA-Z0-9-]{1,100}$'),
  at timestamptz not null default now(),
  kind text not null,
  outcome text not null,
  input_preview text not null default '',
  index_entry jsonb not null,
  log jsonb not null,
  public_envelope jsonb,
  share_token_hash text check (share_token_hash is null or share_token_hash ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  constraint iev_checks_publication_requires_capability check (
    published_at is null or (public_envelope is not null and share_token_hash is not null and outcome <> 'content_refused')
  )
);

create index if not exists iev_checks_at_idx on public.iev_checks (at desc, id desc);
create index if not exists iev_checks_outcome_kind_at_idx on public.iev_checks (outcome, kind, at desc);
create index if not exists iev_checks_kind_at_idx on public.iev_checks (kind, at desc);
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
do $$
declare extension_schema text;
begin
  select n.nspname into extension_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm';
  execute format('create index if not exists iev_checks_preview_idx on public.iev_checks using gin (input_preview %I.gin_trgm_ops)', extension_schema);
end;
$$;

alter table public.iev_checks enable row level security;
alter table public.iev_checks force row level security;
revoke all on table public.iev_checks from public, anon, authenticated;
grant select, insert, update, delete on table public.iev_checks to service_role;

-- One snapshot gives exact filtered totals and a bounded page. Escaping makes
-- search a literal case-insensitive substring, while preserving the trigram
-- index for longer previews. All filters and sorting precede pagination.
create or replace function public.iev_list_checks(
  p_q text default '', p_outcome text default '', p_kind text default '',
  p_from timestamptz default null, p_to timestamptz default null,
  p_offset integer default 0, p_limit integer default 50,
  p_filter text default 'all', p_sort text default 'newest'
) returns jsonb
language sql stable security invoker
set search_path = public, pg_catalog
as $$
  with normalized as (
    select id, at, kind, outcome, input_preview, index_entry,
      case when index_entry->>'verdict' = 'mixed'
        then case when coalesce((index_entry->>'score')::numeric, 0) >= 65 then 'partially_true' else 'distorted' end
        else index_entry->>'verdict' end as verdict,
      (outcome = 'error' or coalesce(index_entry->>'error', '') <> '') as is_error
    from public.iev_checks
  ), filtered as materialized (
    select * from normalized
    where (p_q = '' or lower(id) = lower(p_q)
      or input_preview ilike ('%' || replace(replace(replace(p_q, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%') escape E'\\')
      and (p_outcome = '' or outcome = p_outcome)
      and (p_kind = '' or kind = p_kind)
      and (p_from is null or at >= p_from)
      and (p_to is null or at <= p_to)
      and (p_filter = 'all'
        or (p_filter = 'error' and is_error)
        or (p_filter = 'no-verdict' and verdict is null and not is_error)
        or (p_filter not in ('all', 'error', 'no-verdict') and verdict = p_filter))
  ), page as (
    select index_entry, at, id
    from filtered
    order by
      case when p_sort = 'oldest' then at end asc,
      case when p_sort = 'slowest' then (index_entry->>'totalMs')::numeric end desc nulls last,
      case when p_sort = 'lowest' then (index_entry->>'score')::numeric end asc nulls last,
      case when p_sort <> 'oldest' then at end desc,
      id desc
    offset greatest(0, least(p_offset, 1000000))
    limit greatest(1, least(p_limit, 100))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((select jsonb_agg(index_entry) from page), '[]'::jsonb)
  );
$$;

revoke all on function public.iev_list_checks(text, text, text, timestamptz, timestamptz, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.iev_list_checks(text, text, text, timestamptz, timestamptz, integer, integer, text, text) to service_role;

commit;
