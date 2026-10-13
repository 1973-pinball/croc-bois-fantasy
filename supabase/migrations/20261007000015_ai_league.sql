-- Isolated numerical League Lab experiment. Official assets are never updated.
create table public.ai_league_runs (
  league_id uuid not null references public.leagues,
  season integer not null check (season in (2026,2027)),
  revision integer not null default 1 check (revision > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and (payload->>'season')::integer = season and payload->>'version' = '1'),
  updated_at timestamptz not null default now(),
  primary key (league_id,season)
);
alter table public.ai_league_runs enable row level security;
revoke all on public.ai_league_runs from public,anon,authenticated;
grant select on public.ai_league_runs to anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant select,insert,update on public.ai_league_runs to service_role;
  end if;
end $$;
create policy ai_league_public_read on public.ai_league_runs for select using (private.can_read_league(league_id));

create table public.ai_league_refresh (
  league_id uuid primary key references public.leagues,
  attempted_at timestamptz not null default now(),
  error text check (length(error) <= 300)
);
alter table public.ai_league_refresh enable row level security;
revoke all on public.ai_league_refresh from public,anon,authenticated;
grant select on public.ai_league_refresh to anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant select,insert,update on public.ai_league_refresh to service_role;
  end if;
end $$;
create policy ai_league_refresh_read on public.ai_league_refresh for select using (private.can_read_league(league_id));

comment on table public.ai_league_runs is 'Public, allowlisted automated season state. Service uses revision compare-and-swap; no official roster, pick, or keeper mutations.';
