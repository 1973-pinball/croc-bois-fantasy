-- Subscriber-supplied ranks belong to one commissioner account and season.
-- This migration contains no provider data and exposes no direct table access.
create table private.draft_provider_rank_snapshots (
  user_id uuid not null references auth.users on delete cascade,
  season_id uuid not null references public.seasons,
  source text not null check (source in ('basketball-monster','yahoo')),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object'),
  imported_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id,season_id,source),
  check (snapshot->>'source'=source)
);
alter table private.draft_provider_rank_snapshots enable row level security;
revoke all on private.draft_provider_rank_snapshots from public,anon,authenticated;

create function public.get_draft_provider_ranks(p_season uuid,p_source text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; result jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if auth.uid() is null or not private.is_commissioner(s.league_id) then
    raise exception 'Commissioner access required' using errcode='42501';
  end if;
  if p_source is null or p_source not in ('basketball-monster','yahoo') then raise exception 'Invalid rank source'; end if;
  select snapshot into result from private.draft_provider_rank_snapshots
    where user_id=auth.uid() and season_id=s.id and source=p_source;
  return result;
end $$;

create function public.save_draft_provider_ranks(p_season uuid,p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; row jsonb; source_name text; imported timestamptz; result jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if auth.uid() is null or not private.is_commissioner(s.league_id) then
    raise exception 'Commissioner access required' using errcode='42501';
  end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into strict s from public.seasons where id=p_season;
  if auth.uid() is null or not private.is_commissioner(s.league_id) then
    raise exception 'Commissioner access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text)>200000
    or not (p_snapshot ?& array['source','seasonId','importedAt','ranks'])
    or p_snapshot-array['source','seasonId','importedAt','ranks']<>'{}'::jsonb
    or jsonb_typeof(p_snapshot->'source') is distinct from 'string'
    or p_snapshot->>'source' not in ('basketball-monster','yahoo')
    or jsonb_typeof(p_snapshot->'seasonId') is distinct from 'number'
    or p_snapshot->>'seasonId' !~ '^[0-9]{4}$'
    or jsonb_typeof(p_snapshot->'importedAt') is distinct from 'string'
    or p_snapshot->>'importedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or jsonb_typeof(p_snapshot->'ranks') is distinct from 'array' then raise exception 'Invalid private rank snapshot'; end if;
  if (p_snapshot->>'seasonId')::integer<>s.draft_year+1 then raise exception 'Rank snapshot does not match this draft season'; end if;
  source_name:=p_snapshot->>'source'; imported:=(p_snapshot->>'importedAt')::timestamptz;
  if not isfinite(imported) then raise exception 'Invalid rank import timestamp'; end if;
  if jsonb_array_length(p_snapshot->'ranks') not between 1 and 2000 then raise exception 'Include between 1 and 2000 provider ranks'; end if;
  for row in select value from jsonb_array_elements(p_snapshot->'ranks') loop
    if jsonb_typeof(row) is distinct from 'object' or not (row ?& array['id','providerRank'])
      or row-array['id','providerRank']<>'{}'::jsonb
      or jsonb_typeof(row->'id') is distinct from 'number' or row->>'id' !~ '^[1-9][0-9]{0,15}$'
      or jsonb_typeof(row->'providerRank') is distinct from 'number' or row->>'providerRank' !~ '^[1-9][0-9]{0,15}$' then
      raise exception 'Each rank requires a positive integer ESPN player ID and provider rank';
    end if;
    if (row->>'id')::numeric>9007199254740991 or (row->>'providerRank')::numeric>9007199254740991 then
      raise exception 'Player identities and ranks must be safe integers';
    end if;
    if not exists(select 1 from public.draft_player_catalog c where c.player_id=(row->>'id')::bigint and c.source_season=s.draft_year+1) then
      raise exception 'A ranked player is not in the verified ESPN catalog for this season';
    end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_snapshot->'ranks'))<>jsonb_array_length(p_snapshot->'ranks') then
    raise exception 'Each player may appear only once in a rank snapshot';
  end if;
  -- Browser caches cannot replace a newer saved import. Equal timestamps are
  -- idempotent: retain the existing snapshot rather than accepting conflicting data.
  insert into private.draft_provider_rank_snapshots(user_id,season_id,source,snapshot,imported_at)
    values(auth.uid(),s.id,source_name,p_snapshot,imported)
    on conflict(user_id,season_id,source) do update set snapshot=excluded.snapshot,imported_at=excluded.imported_at,updated_at=clock_timestamp()
      where excluded.imported_at>draft_provider_rank_snapshots.imported_at;
  select snapshot into strict result from private.draft_provider_rank_snapshots
    where user_id=auth.uid() and season_id=s.id and source=source_name;
  return result;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'Invalid rank import timestamp';
end $$;

revoke all on function public.get_draft_provider_ranks(uuid,text),public.save_draft_provider_ranks(uuid,jsonb) from public,anon;
grant execute on function public.get_draft_provider_ranks(uuid,text),public.save_draft_provider_ranks(uuid,jsonb) to authenticated;
