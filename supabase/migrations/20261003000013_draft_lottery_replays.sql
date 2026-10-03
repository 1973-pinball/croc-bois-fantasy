-- Only an explicit commissioner share action creates a public replay link. The
-- saved snapshot contains names/order/dates, never the private draw audit.
create table public.draft_lottery_shares (
  share_id uuid primary key,
  run_id uuid not null unique references public.draft_lottery_runs(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null,
  snapshot jsonb not null
);
alter table public.draft_lottery_shares enable row level security;
revoke all on public.draft_lottery_shares from public,anon,authenticated;
-- Updates are immutable. Privileged cleanup of a removed source run must still
-- cascade to its share, so an authorized deletion invalidates the old link.
create trigger immutable_lottery_share before update on public.draft_lottery_shares
  for each row execute function private.prevent_immutable_change();

create function public.get_shared_draft_lottery(p_share uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare replay jsonb;
begin
  select snapshot into replay from public.draft_lottery_shares where share_id=p_share;
  if not found then raise exception 'This lottery replay is unavailable or has been removed.' using errcode='P0002'; end if;
  -- Possession of the unguessable link is the explicit publication boundary.
  -- There is no endpoint or table permission for enumerating links.
  return replay;
end $$;
revoke all on function public.get_shared_draft_lottery(uuid) from public;
grant execute on function public.get_shared_draft_lottery(uuid) to anon,authenticated;

create function public.share_draft_lottery(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; saved public.draft_lottery_runs; existing public.draft_lottery_shares;
  share_id uuid; shared_at timestamptz; replay_order jsonb; replay jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  select * into saved from public.draft_lottery_runs where season_id=s.id;
  if not found then raise exception 'A saved lottery is required before sharing a replay.'; end if;
  select * into existing from public.draft_lottery_shares where run_id=saved.id;
  if found then return existing.snapshot; end if;
  if s.participant_count<>8 or (select count(*) from public.season_teams where season_id=s.id)<>8
    or jsonb_array_length(saved.result->'priorityOrder')<>8
    or (select count(distinct value) from jsonb_array_elements_text(saved.result->'priorityOrder'))<>8
    or jsonb_array_length(saved.snapshot->'standings')<>8
    or (select count(distinct value->>'franchiseId') from jsonb_array_elements(saved.snapshot->'standings'))<>8
    or exists(select 1 from jsonb_array_elements_text(saved.result->'priorityOrder') p(id) where not exists(
      select 1 from public.season_teams st where st.season_id=s.id and st.franchise_id::text=p.id)) then
    raise exception 'The saved lottery must match all eight participating franchises before it can be shared.';
  end if;
  select jsonb_agg(jsonb_build_object('priority',p.position,'managerLabel',t->>'managerLabel','teamName',t->>'displayName') order by p.position)
    into replay_order from jsonb_array_elements_text(saved.result->'priorityOrder') with ordinality p(id,position)
      join jsonb_array_elements(saved.snapshot->'standings') t on t->>'franchiseId'=p.id;
  if replay_order is null or jsonb_array_length(replay_order)<>8 or exists(
    select 1 from jsonb_array_elements(replay_order) entry
      where nullif(btrim(entry->>'managerLabel'),'') is null or nullif(btrim(entry->>'teamName'),'') is null) then
    raise exception 'The saved lottery is missing verified manager or team labels.';
  end if;
  share_id := gen_random_uuid(); shared_at := clock_timestamp();
  replay := jsonb_build_object('shareId',share_id,'draftYear',s.draft_year,'drawnAt',saved.created_at,
    'sharedAt',shared_at,'order',replay_order);
  insert into public.draft_lottery_shares(share_id,run_id,created_by,created_at,snapshot)
    values(share_id,saved.id,auth.uid(),shared_at,replay);
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'draft_lottery_shared',s.id,jsonb_build_object('shareId',share_id,'runId',saved.id));
  return replay;
end $$;
revoke all on function public.share_draft_lottery(uuid) from public,anon;
grant execute on function public.share_draft_lottery(uuid) to authenticated;
