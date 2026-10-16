-- Configuração, catálogo, cache, recuperação e correções privados, sem Blob.
begin;

create table if not exists public.iev_state (
  namespace text not null check (namespace in ('config', 'catalog', 'cache', 'recovery', 'corrections')),
  key text not null check (length(key) between 1 and 256),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (namespace, key)
);
create index if not exists iev_state_expiry_idx on public.iev_state (expires_at) where expires_at is not null;
alter table public.iev_state enable row level security;
alter table public.iev_state force row level security;
revoke all on table public.iev_state from public, anon, authenticated;
grant select, insert, update, delete on table public.iev_state to service_role;

-- Limpa lotes expirados a cada gravação; cache e recuperação não crescem sem TTL.
create or replace function public.iev_put_state(
  p_namespace text, p_key text, p_value jsonb, p_expires_at timestamptz default null
) returns void
language plpgsql security invoker
set search_path = public, pg_catalog
as $$
begin
  delete from public.iev_state where (namespace, key) in (
    select namespace, key from public.iev_state
    where expires_at <= now() order by expires_at limit 200 for update skip locked
  );
  insert into public.iev_state (namespace, key, value, expires_at, updated_at)
  values (p_namespace, p_key, p_value, p_expires_at, now())
  on conflict (namespace, key) do update
    set value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.iev_put_state(text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.iev_put_state(text, text, jsonb, timestamptz) to service_role;

commit;
