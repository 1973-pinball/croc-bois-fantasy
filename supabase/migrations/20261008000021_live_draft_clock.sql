-- The database owns draft deadlines. Browser clocks are display-only, and every
-- mutation follows the existing league -> season lock order.
create table private.live_draft_clocks (
  season_id uuid primary key references public.seasons(id),
  status text not null default 'waiting' check (status in ('waiting','running','paused','completed')),
  duration_seconds integer not null default 90 check (duration_seconds between 10 and 600),
  remaining_seconds numeric check (remaining_seconds between 0 and 600),
  deadline_at timestamptz,
  started_at timestamptz,
  check ((status='running')=(deadline_at is not null)),
  check (status='waiting' or started_at is not null)
);
create index live_draft_due on private.live_draft_clocks(deadline_at) where status='running';
revoke all on private.live_draft_clocks from public,anon,authenticated;

-- Existing drafts migrate paused, so installing this feature never starts one.
insert into private.live_draft_clocks(season_id,status,remaining_seconds,started_at)
  select s.id,case when exists(select 1 from public.draft_picks p where p.season_id=s.id and p.status='available') then 'paused' else 'completed' end,
    90,min(d.selected_at)
  from public.seasons s join public.live_draft_selections d on d.season_id=s.id group by s.id;

create table private.draft_queues (
  season_id uuid not null,
  franchise_id uuid not null,
  revision integer not null default 0 check (revision>=0),
  player_ids bigint[] not null default '{}',
  primary key(season_id,franchise_id),
  foreign key(season_id,franchise_id) references public.season_teams,
  check (cardinality(player_ids)<=100)
);
revoke all on private.draft_queues from public,anon,authenticated;

-- Separate from the catalog so existing reviewed catalog imports retain their
-- shape. A rank is trusted only while its artifact hash/season matches catalog.
create table private.draft_player_rankings (
  player_id bigint primary key references public.draft_player_catalog(player_id),
  espn_rank integer check (espn_rank>0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_season integer not null
);
revoke all on private.draft_player_rankings from public,anon,authenticated;

create function private.next_live_draft_pick(p_season uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select p.id from public.draft_picks p join public.seasons s on s.id=p.season_id
    join public.season_teams st on st.season_id=p.season_id and st.franchise_id=p.original_franchise_id
  where p.season_id=p_season and p.status='available'
    and not exists(select 1 from public.keeper_season_records k where k.season_id=p_season and k.pick_id=p.id)
    and not exists(select 1 from public.live_draft_selections d where d.pick_id=p.id and d.voided_at is null)
  order by p.round,case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end,p.id limit 1;
$$;
revoke all on function private.next_live_draft_pick(uuid) from public,anon,authenticated;

create function private.draft_clock_snapshot(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.live_draft_clocks; receipt timestamptz:=clock_timestamp();
begin
  select * into c from private.live_draft_clocks where season_id=p_season;
  return jsonb_build_object('status',coalesce(c.status,'waiting'),'durationSeconds',coalesce(c.duration_seconds,90),
    'remainingSeconds',case when c.status='running' then greatest(0,ceil(extract(epoch from c.deadline_at-receipt)))
      when c.status='paused' then ceil(c.remaining_seconds) when c.status='completed' then null else coalesce(c.duration_seconds,90) end,
    'deadlineAt',c.deadline_at,'startedAt',c.started_at,'serverNow',receipt);
end $$;
revoke all on function private.draft_clock_snapshot(uuid) from public,anon,authenticated;

-- Caller already holds the league and season locks. Advance only one expired
-- pick, and give its successor a fresh full interval even after a long outage.
create function private.process_expired_draft(p_season uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.seasons; c private.live_draft_clocks; p public.draft_picks;
  chosen public.draft_player_catalog; selected public.live_draft_selections;
  next_revision integer; from_queue boolean:=false; receipt timestamptz;
begin
  select * into c from private.live_draft_clocks where season_id=p_season for update;
  receipt:=clock_timestamp();
  if not found or c.status<>'running' or c.deadline_at>receipt then return; end if;
  select * into strict s from public.seasons where id=p_season;
  if s.phase<>'draft_ready' or s.keepers_revealed_at is null or not coalesce(private.draft_order_complete(s.id),false) then
    update private.live_draft_clocks set status='paused',deadline_at=null,remaining_seconds=0 where season_id=s.id;
    update public.seasons set draft_revision=draft_revision+1 where id=s.id;
    return;
  end if;
  select * into p from public.draft_picks where id=private.next_live_draft_pick(s.id) for update;
  if not found then
    update private.live_draft_clocks set status='completed',deadline_at=null,remaining_seconds=null where season_id=s.id;
    update public.seasons set draft_revision=draft_revision+1 where id=s.id;
    return;
  end if;
  select catalog.* into chosen from private.draft_queues q
    cross join lateral unnest(q.player_ids) with ordinality queued(player_id,position)
    join public.draft_player_catalog catalog on catalog.player_id=queued.player_id and catalog.selectable
  where q.season_id=s.id and q.franchise_id=p.current_owner_id
    and not exists(select 1 from public.keeper_season_records k where k.season_id=s.id and k.player_id=catalog.player_id)
    and not exists(select 1 from public.live_draft_selections d where d.season_id=s.id and d.player_id=catalog.player_id and d.voided_at is null)
  order by queued.position limit 1;
  from_queue:=found;
  if not from_queue then
    select catalog.* into chosen from public.draft_player_catalog catalog
      join private.draft_player_rankings ranking on ranking.player_id=catalog.player_id
        and ranking.source_sha256=catalog.source_sha256 and ranking.source_season=catalog.source_season
    where catalog.selectable
      and not exists(select 1 from public.keeper_season_records k where k.season_id=s.id and k.player_id=catalog.player_id)
      and not exists(select 1 from public.live_draft_selections d where d.season_id=s.id and d.player_id=catalog.player_id and d.voided_at is null)
    order by ranking.espn_rank nulls last,catalog.full_name collate "C",catalog.player_id limit 1;
  end if;
  if chosen.player_id is null then
    update private.live_draft_clocks set status='paused',deadline_at=null,remaining_seconds=0 where season_id=s.id;
    update public.seasons set draft_revision=draft_revision+1 where id=s.id;
    insert into public.audit_events(league_id,event_type,entity_id,detail)
      values(s.league_id,'draft_autopick_unavailable',s.id,jsonb_build_object('reason','No available player in the verified ESPN ranking artifact'));
    return;
  end if;
  next_revision:=s.draft_revision+1;
  insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision)
    values(s.id,p.id,p.current_owner_id,chosen.player_id,chosen.full_name,next_revision) returning * into selected;
  update public.draft_picks set status='used' where id=p.id;
  update public.seasons set draft_revision=next_revision where id=s.id;
  -- Removing unavailable entries from every team is private and independently
  -- revisioned; an outstanding co-manager queue save cannot restore stale data.
  update private.draft_queues set player_ids=array_remove(player_ids,chosen.player_id),revision=revision+1
    where season_id=s.id and chosen.player_id=any(player_ids);
  if private.next_live_draft_pick(s.id) is null then
    update private.live_draft_clocks set status='completed',deadline_at=null,remaining_seconds=null where season_id=s.id;
  else
    update private.live_draft_clocks set deadline_at=clock_timestamp()+make_interval(secs=>duration_seconds),remaining_seconds=null where season_id=s.id;
  end if;
  insert into public.audit_events(league_id,event_type,entity_id,detail)
    values(s.league_id,'draft_selection_autodrafted',p.id,jsonb_build_object('updated',to_jsonb(selected),'revision',next_revision,
      'source',case when from_queue then 'queue' else 'espn_rank' end,'expiredDeadlineAt',c.deadline_at));
end $$;
revoke all on function private.process_expired_draft(uuid) from public,anon,authenticated;

create function public.tick_draft_clock(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_read_season(s.id) then raise exception 'League access required' using errcode='42501'; end if;
  -- Most one-second polls are reads and do not contend with private team edits.
  if exists(select 1 from private.live_draft_clocks where season_id=s.id and status='running' and deadline_at<=clock_timestamp()) then
    perform 1 from public.leagues where id=s.league_id for update;
    perform 1 from public.seasons where id=s.id for update;
    if not private.can_read_season(s.id) then raise exception 'League access required' using errcode='42501'; end if;
    perform private.process_expired_draft(s.id);
  end if;
  return public.get_draft_board(s.id);
end $$;
revoke all on function public.tick_draft_clock(uuid) from public;
grant execute on function public.tick_draft_clock(uuid) to anon,authenticated;

create function public.control_draft_clock(p_season uuid,p_expected_revision integer,p_action text,p_duration_seconds integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; c private.live_draft_clocks; receipt timestamptz;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=s.id for update;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  if p_expected_revision is distinct from s.draft_revision then raise exception 'The draft board changed. Refresh before making another change.' using errcode='40001'; end if;
  if p_action is null or p_action not in ('configure','start','pause','resume') then raise exception 'Unknown draft clock action'; end if;
  if p_action<>'configure' and p_duration_seconds is not null then raise exception 'Unexpected draft timer duration'; end if;
  insert into private.live_draft_clocks(season_id) values(s.id) on conflict do nothing;
  select * into c from private.live_draft_clocks where season_id=s.id for update;
  receipt:=clock_timestamp();
  if p_action='configure' then
    if c.started_at is not null then raise exception 'Draft timer can only be configured before the draft starts'; end if;
    if s.phase not in ('setup','keeper_selection','draft_ready') then raise exception 'Draft timer cannot change in this phase'; end if;
    if p_duration_seconds is null or p_duration_seconds not between 10 and 600 then raise exception 'Draft timer must be between 10 and 600 seconds'; end if;
    update private.live_draft_clocks set duration_seconds=p_duration_seconds where season_id=s.id;
  elsif p_action='start' then
    if c.status<>'waiting' or c.started_at is not null then raise exception 'The draft has already started'; end if;
    if s.phase<>'draft_ready' or s.keepers_revealed_at is null then raise exception 'Draft picks open only after every keeper is locked and revealed'; end if;
    if not coalesce(private.draft_order_complete(s.id),false) then raise exception 'Set the complete draft order before starting the draft'; end if;
    if private.next_live_draft_pick(s.id) is null then raise exception 'There are no available draft picks'; end if;
    update private.live_draft_clocks set status='running',started_at=receipt,remaining_seconds=null,
      deadline_at=receipt+make_interval(secs=>duration_seconds) where season_id=s.id;
  elsif p_action='pause' then
    if c.status<>'running' then raise exception 'Only a running draft can be paused'; end if;
    -- An expired pick belongs to autodraft even if pause arrives before cron.
    perform private.process_expired_draft(s.id);
    select * into c from private.live_draft_clocks where season_id=s.id;
    if c.status='running' then
      update private.live_draft_clocks set status='paused',remaining_seconds=greatest(0,extract(epoch from deadline_at-clock_timestamp())),deadline_at=null where season_id=s.id;
    end if;
  else
    if c.status<>'paused' then raise exception 'Only a paused draft can be resumed'; end if;
    if s.phase<>'draft_ready' or s.keepers_revealed_at is null or not coalesce(private.draft_order_complete(s.id),false) then raise exception 'The draft is not ready to resume'; end if;
    if private.next_live_draft_pick(s.id) is null then raise exception 'There are no available draft picks'; end if;
    update private.live_draft_clocks set status='running',deadline_at=receipt+make_interval(secs=>coalesce(remaining_seconds,duration_seconds)::double precision),remaining_seconds=null where season_id=s.id;
  end if;
  update public.seasons set draft_revision=draft_revision+1 where id=s.id returning * into s;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'draft_clock_'||p_action,s.id,jsonb_build_object('revision',s.draft_revision,'durationSeconds',p_duration_seconds));
  return public.get_draft_board(s.id);
end $$;
revoke all on function public.control_draft_clock(uuid,integer,text,integer) from public,anon;
grant execute on function public.control_draft_clock(uuid,integer,text,integer) to authenticated;

create function public.get_draft_queue(p_season uuid,p_franchise uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.draft_queues;
begin
  if not exists(select 1 from public.season_teams where season_id=p_season and franchise_id=p_franchise)
    or not private.can_manage_franchise(p_franchise) then raise exception 'Only an assigned manager may access this draft queue' using errcode='42501'; end if;
  select * into q from private.draft_queues where season_id=p_season and franchise_id=p_franchise;
  return jsonb_build_object('seasonId',p_season,'franchiseId',p_franchise,'revision',coalesce(q.revision,0),'playerIds',coalesce(q.player_ids,'{}'::bigint[]));
end $$;
revoke all on function public.get_draft_queue(uuid,uuid) from public,anon;
grant execute on function public.get_draft_queue(uuid,uuid) to authenticated;

create function public.save_draft_queue(p_season uuid,p_franchise uuid,p_expected_revision integer,p_player_ids bigint[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; q private.draft_queues;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_manage_franchise(p_franchise) then raise exception 'Only an assigned manager may access this draft queue' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=s.id for update;
  if not private.can_manage_franchise(p_franchise) then raise exception 'Only an assigned manager may access this draft queue' using errcode='42501'; end if;
  if not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=p_franchise) then raise exception 'Team is not a participant in this season'; end if;
  if s.phase not in ('setup','keeper_selection','draft_ready') or exists(select 1 from private.live_draft_clocks where season_id=s.id and status='completed') then raise exception 'The draft queue is closed'; end if;
  if exists(select 1 from private.live_draft_clocks where season_id=s.id and status='running' and deadline_at<=clock_timestamp()) then raise exception 'Draft timer expired; refresh before editing the queue' using errcode='40001'; end if;
  if p_player_ids is null or cardinality(p_player_ids)>100 or coalesce(array_ndims(p_player_ids),1)>1
    or (select count(distinct player_id) from unnest(p_player_ids) player_id)<>cardinality(p_player_ids) then raise exception 'Queue up to 100 unique players'; end if;
  if exists(select 1 from unnest(p_player_ids) ids(player_id) where not exists(select 1 from public.draft_player_catalog c where c.player_id=ids.player_id and c.selectable)) then raise exception 'Select active players from the verified ESPN catalog'; end if;
  if exists(select 1 from unnest(p_player_ids) ids(player_id) where exists(select 1 from public.keeper_season_records k where k.season_id=s.id and k.player_id=ids.player_id)
    or exists(select 1 from public.live_draft_selections d where d.season_id=s.id and d.player_id=ids.player_id and d.voided_at is null)) then raise exception 'A queued player is already kept or drafted'; end if;
  insert into private.draft_queues(season_id,franchise_id) values(s.id,p_franchise) on conflict do nothing;
  select * into q from private.draft_queues where season_id=s.id and franchise_id=p_franchise for update;
  if p_expected_revision is distinct from q.revision then raise exception 'The draft queue changed. Refresh before saving again.' using errcode='40001'; end if;
  update private.draft_queues set player_ids=p_player_ids,revision=revision+1 where season_id=s.id and franchise_id=p_franchise;
  return public.get_draft_queue(s.id,p_franchise);
end $$;
revoke all on function public.save_draft_queue(uuid,uuid,integer,bigint[]) from public,anon;
grant execute on function public.save_draft_queue(uuid,uuid,integer,bigint[]) to authenticated;

-- Other administration RPCs must observe the same start boundary, including a
-- keeper payment amendment during the first pick's countdown.
create function private.protect_started_draft() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='season_teams' then
    if new.draft_position is not distinct from old.draft_position then return new; end if;
  end if;
  if exists(select 1 from private.live_draft_clocks where season_id=new.season_id and started_at is not null) then
    raise exception 'Draft order and keeper payments are fixed after the draft has started';
  end if;
  return new;
end $$;
revoke all on function private.protect_started_draft() from public,anon,authenticated;
create trigger started_draft_order before update of draft_position on public.season_teams
  for each row execute function private.protect_started_draft();
create trigger started_draft_payments before insert on public.keeper_payment_amendments
  for each row execute function private.protect_started_draft();

-- The scheduled worker uses the same locks/checks as an explicit tick. It can
-- operate on private leagues without borrowing a browser identity.
create function private.tick_live_drafts() returns integer
language plpgsql security definer set search_path='' as $$
declare due record; processed integer:=0;
begin
  for due in select s.id,s.league_id from private.live_draft_clocks c join public.seasons s on s.id=c.season_id
    where c.status='running' and c.deadline_at<=clock_timestamp() order by s.league_id,s.id loop
    perform 1 from public.leagues where id=due.league_id for update skip locked;
    if not found then continue; end if;
    perform 1 from public.seasons where id=due.id for update;
    perform private.process_expired_draft(due.id);
    processed:=processed+1;
  end loop;
  return processed;
end $$;
revoke all on function private.tick_live_drafts() from public,anon,authenticated;

create or replace function public.get_draft_board(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; complete_order boolean; result jsonb; rounds integer;
begin
  -- Keep the revision, selected players, and clock in one consistent snapshot.
  select * into s from public.seasons where id=p_season for share;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_read_season(p_season) then raise exception 'League access required' using errcode='42501'; end if;
  complete_order := coalesce(private.draft_order_complete(p_season),false);
  select draft_rounds into rounds from public.rule_versions where id=s.rule_version_id;
  select jsonb_build_object(
    'seasonId',s.id,'draftYear',s.draft_year,'phase',s.phase,'draftFormat',s.draft_format,'roundCount',rounds,
    'clock',private.draft_clock_snapshot(s.id),'revision',s.draft_revision,'keepersRevealedAt',s.keepers_revealed_at,'orderComplete',complete_order,
    'orderLocked',exists(select 1 from public.live_draft_selections where season_id=s.id) or exists(select 1 from private.live_draft_clocks where season_id=s.id and started_at is not null),
    'teams',(select coalesce(jsonb_agg(jsonb_build_object(
      'franchiseId',st.franchise_id,'espnTeamId',f.espn_team_id,'displayName',st.display_name,
      'draftPosition',case when complete_order then st.draft_position else null end)
      order by case when complete_order then st.draft_position else null end,st.franchise_id),'[]'::jsonb)
      from public.season_teams st join public.franchises f on f.id=st.franchise_id where st.season_id=s.id),
    'picks',coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,'round',p.round,'overallPick',case when complete_order then
        (p.round-1)*s.participant_count + case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end else null end,
      'originalFranchiseId',case when complete_order then p.original_franchise_id else null end,
      'currentOwnerId',case when complete_order then p.current_owner_id else null end,
      'status',case when s.keepers_revealed_at is not null and k.pick_id is not null then 'keeper'
        when s.keepers_revealed_at is not null and d.id is not null then 'selected' else 'available' end,
      'playerId',case when s.keepers_revealed_at is not null then coalesce(k.player_id,d.player_id) else null end,
      'playerName',case when s.keepers_revealed_at is not null then coalesce(kp.full_name,d.player_name) else null end,
      'selectionId',case when s.keepers_revealed_at is not null then d.id else null end)
      order by p.round,case when complete_order then case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end else null end,p.id),'[]'::jsonb),
    'nextPickId',case when complete_order and s.phase='draft_ready' and s.keepers_revealed_at is not null then
      (select dp.id from public.draft_picks dp join public.season_teams dt on dt.season_id=dp.season_id and dt.franchise_id=dp.original_franchise_id
       where dp.season_id=s.id and dp.status='available'
       order by dp.round,case when s.draft_format='snake' and dp.round%2=0 then s.participant_count+1-dt.draft_position else dt.draft_position end limit 1) else null end
  ) into result
  from public.draft_picks p join public.season_teams st on st.season_id=p.season_id and st.franchise_id=p.original_franchise_id
  left join public.keeper_season_records k on k.pick_id=p.id and k.season_id=s.id
  left join public.players kp on kp.id=k.player_id
  left join public.live_draft_selections d on d.pick_id=p.id and d.voided_at is null
  where p.season_id=s.id;
  return result;
end $$;
revoke all on function public.get_draft_board(uuid) from public;
grant execute on function public.get_draft_board(uuid) to anon,authenticated;


create or replace function public.update_draft_board(p_season uuid,p_expected_revision integer,p_action text,p_order uuid[],p_pick uuid,p_player bigint,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; p public.draft_picks; previous_selection public.live_draft_selections;
  new_selection public.live_draft_selections; catalog public.draft_player_catalog; c private.live_draft_clocks;
  previous_order jsonb; next_pick uuid; rounds integer; next_revision integer;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if p_action='record' then
    if not (private.is_commissioner(s.league_id) or exists(select 1 from public.draft_picks owned where owned.id=p_pick and owned.season_id=s.id and private.can_manage_franchise(owned.current_owner_id))) then
      raise exception 'Only the current pick owner or commissioner may draft' using errcode='42501'; end if;
  elsif not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  -- A queued operation must not retain authority after another transaction revoked it.
  if p_action='record' then
    if not (private.is_commissioner(s.league_id) or exists(select 1 from public.draft_picks owned where owned.id=p_pick and owned.season_id=s.id and private.can_manage_franchise(owned.current_owner_id))) then
      raise exception 'Only the current pick owner or commissioner may draft' using errcode='42501'; end if;
  elsif not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  if p_expected_revision is null or p_expected_revision<>s.draft_revision then raise exception 'The draft board changed. Refresh before making another change.' using errcode='40001'; end if;
  if p_action is null or p_action not in ('set_order','record','undo','correct') then raise exception 'Unknown draft action'; end if;
  if length(coalesce(p_note,''))>2000 or (p_action<>'record' and length(trim(coalesce(p_note,'')))<5) then raise exception 'Explain the draft change in 5 to 2000 characters'; end if;
  next_revision := s.draft_revision+1;
  select draft_rounds into rounds from public.rule_versions where id=s.rule_version_id;

  if p_action='set_order' then
    if p_pick is not null or p_player is not null then raise exception 'Unexpected selection fields'; end if;
    if s.phase not in ('setup','keeper_selection','draft_ready') then raise exception 'Draft order cannot change in this phase'; end if;
    if exists(select 1 from public.live_draft_selections where season_id=s.id) or exists(select 1 from private.live_draft_clocks where season_id=s.id and started_at is not null) then raise exception 'Draft order is fixed after the draft has started'; end if;
    if p_order is null or cardinality(p_order)<>s.participant_count
      or (select count(distinct entry) from unnest(p_order) entry)<>s.participant_count
      or (select count(*) from public.season_teams where season_id=s.id)<>s.participant_count
      or exists(select 1 from unnest(p_order) entry where not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=entry)) then
      raise exception 'Provide each season franchise exactly once in draft order';
    end if;
    if exists(select 1 from public.season_teams st where st.season_id=s.id and
      (select count(*) from public.draft_picks dp where dp.season_id=s.id and dp.original_franchise_id=st.franchise_id and dp.round between 1 and rounds)<>rounds)
      or exists(select 1 from public.draft_picks where season_id=s.id and round>rounds) then raise exception 'The original draft pick inventory is incomplete'; end if;
    select jsonb_agg(jsonb_build_object('franchiseId',franchise_id,'draftPosition',draft_position) order by franchise_id)
      into previous_order from public.season_teams where season_id=s.id;
    update public.season_teams set draft_position=null where season_id=s.id;
    update public.season_teams st set draft_position=o.position
      from unnest(p_order) with ordinality o(franchise,position) where st.season_id=s.id and st.franchise_id=o.franchise;
    update public.seasons set draft_revision=next_revision where id=s.id;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
      values(s.league_id,auth.uid(),'draft_order_updated',s.id,jsonb_build_object('previous',previous_order,'franchiseIds',p_order,'revision',next_revision,'note',trim(p_note)));
    return public.get_draft_board(s.id);
  end if;

  if p_order is not null or p_pick is null or (p_action='undo' and p_player is not null) then raise exception 'Invalid draft selection fields'; end if;
  if s.phase<>'draft_ready' or s.keepers_revealed_at is null then raise exception 'Draft picks open only after every keeper is locked and revealed'; end if;
  if not coalesce(private.draft_order_complete(s.id),false) then raise exception 'Set the complete draft order before recording selections'; end if;
  select * into p from public.draft_picks where id=p_pick and season_id=s.id for update;
  if not found then raise exception 'Draft pick not found in this season' using errcode='P0002'; end if;
  if exists(select 1 from public.keeper_season_records where season_id=s.id and pick_id=p.id) then raise exception 'Revealed keeper picks are immutable'; end if;
  select * into previous_selection from public.live_draft_selections where pick_id=p.id and voided_at is null for update;

  if p_action='record' then
    if p.status<>'available' or previous_selection.id is not null then raise exception 'This draft pick is already used'; end if;
    select dp.id into next_pick from public.draft_picks dp join public.season_teams dt on dt.season_id=dp.season_id and dt.franchise_id=dp.original_franchise_id
      where dp.season_id=s.id and dp.status='available'
      order by dp.round,case when s.draft_format='snake' and dp.round%2=0 then s.participant_count+1-dt.draft_position else dt.draft_position end limit 1;
    if next_pick is distinct from p.id then raise exception 'Record the next available draft pick in order'; end if;
    select * into c from private.live_draft_clocks where season_id=s.id for update;
    if not found or c.status<>'running' then raise exception 'Start or resume the draft before recording a selection'; end if;
    if c.deadline_at<=clock_timestamp() then raise exception 'Draft timer expired; refresh for the automatic selection' using errcode='40001'; end if;
  else
    if previous_selection.id is null or p.status<>'used' then raise exception 'Only a recorded live draft selection can be corrected or undone'; end if;
  end if;

  if p_action in ('record','correct') then
    select * into catalog from public.draft_player_catalog where player_id=p_player and selectable;
    if not found then raise exception 'Select an active player from the verified ESPN catalog'; end if;
    if p_action='correct' and previous_selection.player_id=p_player then raise exception 'Choose a different player for a correction'; end if;
    if exists(select 1 from public.keeper_season_records where season_id=s.id and player_id=p_player)
      or exists(select 1 from public.live_draft_selections where season_id=s.id and player_id=p_player and voided_at is null) then raise exception 'This player is already kept or drafted'; end if;
  end if;

  if previous_selection.id is not null then
    update public.live_draft_selections set voided_at=clock_timestamp(),voided_revision=next_revision where id=previous_selection.id;
  end if;
  if p_action='undo' then
    update public.draft_picks set status='available' where id=p.id;
  else
    insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision)
      values(s.id,p.id,p.current_owner_id,catalog.player_id,catalog.full_name,next_revision) returning * into new_selection;
    update public.draft_picks set status='used' where id=p.id;
  end if;
  update public.seasons set draft_revision=next_revision where id=s.id;
  if p_action in ('record','correct') then
    update private.draft_queues set player_ids=array_remove(player_ids,catalog.player_id),revision=revision+1
      where season_id=s.id and catalog.player_id=any(player_ids);
  end if;
  insert into private.live_draft_clocks(season_id,status,remaining_seconds,started_at)
    values(s.id,'paused',90,clock_timestamp()) on conflict do nothing;
  select * into c from private.live_draft_clocks where season_id=s.id for update;
  if private.next_live_draft_pick(s.id) is null then
    update private.live_draft_clocks set status='completed',deadline_at=null,remaining_seconds=null where season_id=s.id;
  elsif c.status='running' then
    update private.live_draft_clocks set deadline_at=clock_timestamp()+make_interval(secs=>duration_seconds),remaining_seconds=null where season_id=s.id;
  else
    -- Undoing a completed draft reopens it paused for explicit commissioner resume.
    update private.live_draft_clocks set status='paused',deadline_at=null,remaining_seconds=duration_seconds where season_id=s.id;
  end if;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),case p_action when 'record' then 'draft_selection_recorded' when 'undo' then 'draft_selection_undone' else 'draft_selection_corrected' end,p.id,
      jsonb_build_object('previous',case when previous_selection.id is not null then to_jsonb(previous_selection) else null end,
        'updated',case when new_selection.id is not null then to_jsonb(new_selection) else null end,'revision',next_revision,'note',nullif(trim(p_note),'')));
  return public.get_draft_board(s.id);
end $$;
revoke all on function public.update_draft_board(uuid,integer,text,uuid[],uuid,bigint,text) from public,anon;
grant execute on function public.update_draft_board(uuid,integer,text,uuid[],uuid,bigint,text) to authenticated;



-- Exact checked-in ESPN ROTO artifact, captured 2026-10-03T15:58:56.638Z.
insert into private.draft_player_rankings(player_id,espn_rank,source_sha256,source_season) values
(3112335,1,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5104157,2,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278073,3,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3945274,4,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4594268,5,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431678,6,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908809,7,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065648,8,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701230,9,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433134,10,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432166,11,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396993,12,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684740,13,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6583,14,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066261,15,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5041939,16,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3078576,17,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6450,18,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136195,19,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3032977,20,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3936299,21,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432816,22,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433621,23,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3149673,24,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3992,25,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3147657,26,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432158,27,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3202,28,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871144,29,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934672,30,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278039,31,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3155942,32,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3975,33,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066336,34,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593803,35,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871145,36,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396971,37,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4869342,38,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5061575,39,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136193,40,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066320,41,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278104,42,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105565,43,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431680,44,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433136,45,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397688,46,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277905,47,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6442,48,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066328,49,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066457,50,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433255,51,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066259,52,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396907,53,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433287,54,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3032976,55,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5095151,56,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907497,57,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4711272,58,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4711294,59,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683021,60,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5160992,61,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3917376,62,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395725,63,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595516,64,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4566434,65,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4709138,66,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105623,67,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934719,68,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5124612,69,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6606,70,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277961,71,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065733,72,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(1966,73,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991230,74,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432573,75,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066383,76,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5041935,77,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684742,78,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3913176,79,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102531,80,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017837,81,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2490149,82,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4594327,83,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431671,84,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5142718,85,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064514,86,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059319,87,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059318,88,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433627,89,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395724,90,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4251,91,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4845367,92,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133628,93,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6440,94,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4869780,95,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395628,96,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3062679,97,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066354,98,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908845,99,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278585,100,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5037871,101,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3978,102,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6478,103,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4576087,104,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4591725,105,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395651,106,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397140,107,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397002,108,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683692,109,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3468,109,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432639,110,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592479,111,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3448,112,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4600663,113,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278049,114,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4351852,115,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3134908,116,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397424,117,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397014,118,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278067,119,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592691,120,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5175643,121,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4601023,122,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5041955,123,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4903027,124,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4712849,125,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5174563,126,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4873138,127,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395630,128,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144091,129,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4437244,130,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3995,131,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431736,132,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4279888,133,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397136,134,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4222252,135,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432194,136,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991350,137,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3155526,138,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5142620,139,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395625,140,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138196,141,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432165,142,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433083,143,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683688,143,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431785,144,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684793,145,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432810,146,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991070,147,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432848,148,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395712,149,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277811,150,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278078,151,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395723,152,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431679,153,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064290,154,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2583632,155,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528210,156,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3135045,157,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064440,158,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066262,159,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433249,160,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6589,161,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397020,162,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4576060,163,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5061589,164,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066211,165,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4873153,166,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065804,167,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102530,168,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3157465,169,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064482,170,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593125,171,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277847,172,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5175737,173,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5093267,174,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278053,175,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433192,176,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396909,177,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432582,178,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395626,179,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066436,180,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5104155,181,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133603,182,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066372,183,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991139,184,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433247,185,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432241,186,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683634,187,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395702,188,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683747,189,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530530,190,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105550,191,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278129,192,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702177,193,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277813,194,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397227,194,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3936099,195,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107173,196,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3134903,196,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066648,197,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5101761,198,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3213,199,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397189,200,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4578893,201,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5203685,202,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065732,203,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065778,204,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6580,205,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683678,206,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683689,207,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5254165,208,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137259,209,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278594,209,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3032979,210,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106258,211,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431767,212,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593841,213,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6430,214,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5149077,215,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4888725,216,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4845374,217,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5211175,218,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907498,219,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3913174,220,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4351851,221,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433137,222,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3134907,223,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6475,224,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5082206,225,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105839,226,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397183,227,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683766,228,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702382,229,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5112087,230,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683778,231,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066421,231,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432823,232,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432170,233,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278541,234,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702384,234,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431823,235,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397475,236,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065670,236,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432174,237,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4896372,237,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684272,238,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278355,239,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277956,240,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278562,241,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6477,242,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5214640,242,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4900671,243,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683771,244,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5238230,245,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2581018,246,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990992,247,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997536,248,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5175647,249,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5281370,250,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6585,251,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433218,252,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997528,252,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277869,253,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066757,254,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6578,255,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277848,256,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592829,256,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3449,257,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064560,257,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4610139,258,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990969,259,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5279130,259,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102529,260,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907823,261,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991043,262,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4348700,263,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3899664,264,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105637,265,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432809,266,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431684,266,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4712863,267,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580365,268,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4712896,269,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2993874,270,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990984,271,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278572,272,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431828,273,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4595400,273,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3134932,274,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431687,274,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3912848,275,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432822,276,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102532,276,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3037789,277,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432813,277,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6429,278,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136196,278,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066218,279,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683686,279,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397077,280,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4280151,281,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3914044,282,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592492,283,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684275,284,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106060,285,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6609,286,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4594326,287,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277843,288,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997537,289,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4895758,290,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3155535,291,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528693,291,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432847,292,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278077,293,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064447,294,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5164559,294,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3913180,295,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3135046,295,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3032978,296,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934723,296,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133626,297,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528426,298,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489663,298,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5239590,299,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4873201,300,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433076,301,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432181,302,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3150844,303,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3416,304,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066650,304,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3195,305,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138160,306,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432819,307,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990962,308,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5044385,309,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277922,310,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3914285,311,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133635,311,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107897,312,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278076,312,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578185,313,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701232,314,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136776,315,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4565201,316,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432107,316,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432247,317,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017844,318,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432811,318,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531367,319,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5099752,319,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5157066,320,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907387,321,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397018,321,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3948153,322,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431714,322,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065654,323,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4868423,324,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2960236,324,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5081727,325,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433159,326,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3134916,326,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683750,327,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683736,327,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105806,328,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3922230,329,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991235,329,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432190,330,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4914336,330,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4897943,331,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683774,332,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578239,333,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432735,334,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4591259,334,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431752,335,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2999547,336,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136777,337,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5289900,338,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5239561,339,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488653,339,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5242496,340,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105553,341,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4398390,342,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5211983,343,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5217746,344,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432171,345,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397886,346,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4023,347,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433569,347,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934673,348,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396818,349,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277964,353,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395620,354,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433623,356,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397885,359,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064230,361,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105592,363,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683024,370,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968436,373,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3012,374,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3209,375,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397102,376,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580782,378,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2779,379,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2993370,380,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2566769,382,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3074752,383,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059409,384,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3431,385,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102528,386,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067017,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528231,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064510,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397209,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595175,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397654,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4349241,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702023,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5174983,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5060631,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531100,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432585,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991178,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5170947,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579326,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528479,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3062897,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432452,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432971,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4917149,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528355,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596107,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991283,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5170949,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530923,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702656,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5149115,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907525,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592216,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3893020,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105638,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702745,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3074748,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982249,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066387,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990972,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136479,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531362,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2581184,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066790,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3276,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431705,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907386,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592686,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064237,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991281,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871141,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5104156,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066450,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968439,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3893015,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395722,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3037805,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5075626,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136469,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3057189,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5242502,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5241364,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059356,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6427,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059280,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396963,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683935,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4376,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4906923,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5214989,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138192,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592712,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6507,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105854,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592435,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595211,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432162,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3057198,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907385,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397040,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277882,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595229,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982330,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4407254,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684208,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105837,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277952,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531054,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4565698,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4576086,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2994526,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2325499,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2608716,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433144,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4845363,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066315,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395627,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528354,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5113969,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3928275,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3057240,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067735,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5061568,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059266,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907526,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5174655,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2988387,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580898,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278045,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4700852,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3147366,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5142621,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137795,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3906603,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592402,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2325975,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433622,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702972,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3153165,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3923253,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4706557,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5060701,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431778,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3058254,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4590360,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278052,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702602,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991227,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133600,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2994416,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138161,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433378,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397134,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397204,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6446,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991134,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701233,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3113587,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4898369,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432820,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4279318,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4848625,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432176,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064516,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136991,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102534,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431766,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595209,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2309097,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3033042,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991050,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2451037,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107199,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991155,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3913220,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433607,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578259,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066243,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397107,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4713010,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017875,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3062744,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593041,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489664,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578232,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3442,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2327630,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066796,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908807,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059358,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431811,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3056273,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138256,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3906977,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433188,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137798,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397016,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3946974,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580913,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3924880,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702159,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106283,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3899663,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489563,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701231,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4870562,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907408,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3129674,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528588,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5037873,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2327465,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397689,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431695,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066993,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397235,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528244,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066268,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3001309,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6503,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433174,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432821,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5258459,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3033031,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2583639,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144071,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397449,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432872,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106058,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4355392,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433620,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592699,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531045,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528646,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3065284,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531352,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2994165,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278516,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066410,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968334,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105841,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396638,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277886,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3929321,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871139,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3132042,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017846,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137694,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991009,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2594920,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433618,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066221,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4291678,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105571,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6634,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871138,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432180,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433281,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489785,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871140,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3926491,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107818,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017845,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3936294,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990983,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592857,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5061585,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3074765,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277957,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432815,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432117,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059336,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431727,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4305,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059307,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997529,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4348701,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107251,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3055,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528374,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136483,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982331,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107968,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580784,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432446,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5234862,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3911893,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065653,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066889,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278378,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592461,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2995079,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432737,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432164,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6581,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3135048,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683934,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433133,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702785,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396682,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2608891,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432946,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105797,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579476,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4423887,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066731,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4398207,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4280245,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982185,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059276,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3999,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2594818,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144059,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2326411,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3079021,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432808,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488977,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4606840,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431893,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278566,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2327577,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066496,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395695,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066248,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397119,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133843,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2614962,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4703115,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579293,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066486,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065650,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397511,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4781746,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4597259,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596112,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065731,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5101845,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133874,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395688,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5149711,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3952343,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4708972,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4576085,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066786,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067469,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431816,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5279133,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3146557,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3058269,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528386,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4280150,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138155,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2983551,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2959753,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593043,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059306,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064528,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432356,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432817,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066378,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579466,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2993873,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278402,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595592,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3064520,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4895528,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579279,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2327449,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432168,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3001308,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433157,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531364,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4064727,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4687718,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432068,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065663,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2581190,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4870564,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702233,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144070,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4401416,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683742,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579492,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432907,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4711297,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2284101,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066373,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278111,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3945566,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934721,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431699,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4697268,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5231919,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432528,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997538,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3062892,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4279118,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133629,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596247,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431689,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531097,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133596,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3152335,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433254,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3056247,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432646,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4585610,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6637,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432192,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431786,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397693,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278075,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4411057,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2583962,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067858,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395714,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997530,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578240,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066651,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2566741,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683834,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5041953,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702352,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066335,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065635,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528327,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3950760,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4873090,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5091709,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5108969,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488721,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066405,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6485,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530572,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2325495,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4596528,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395650,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431720,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397347,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066317,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059286,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277890,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528787,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397103,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3037792,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3032980,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3911666,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277951,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3899662,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997539,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397071,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066668,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4871137,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2282205,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580980,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907822,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3907359,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277880,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105337,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5184016,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3947156,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991054,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968363,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3934670,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3904015,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277892,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982261,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982329,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579458,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432179,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4703530,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066636,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6461,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4230554,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065805,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065652,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2566748,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6428,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395704,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2999546,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3149036,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908336,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059311,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991295,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997532,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489716,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3063982,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701992,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4898371,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684286,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278507,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5041951,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5211981,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432185,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066399,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530751,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991255,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2566747,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528096,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982337,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4696317,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2992564,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138120,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991041,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4236300,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2328615,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277854,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277919,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5091677,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2751,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059310,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397126,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277871,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701208,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3936298,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2579251,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431772,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592401,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106268,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5363895,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067069,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396629,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397371,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397821,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2491079,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4067325,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2990968,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105832,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3929314,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968338,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4341,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144067,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3892893,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3902065,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5159925,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5214637,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4702134,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017857,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528473,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982192,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278046,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3074213,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4438552,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593049,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432827,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278031,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106270,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997526,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2594816,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3033,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592714,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2527926,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433246,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4004,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3058030,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3893023,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4601025,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397233,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530722,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578204,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3923250,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701225,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432070,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2566745,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4593016,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3893060,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596110,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137733,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105977,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066334,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431941,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908819,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432187,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6443,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531214,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105462,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4701234,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5177362,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2490620,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5157587,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488826,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982332,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2580349,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397251,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531038,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991047,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489693,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5107157,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433629,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2968458,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5281137,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278580,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3902067,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2328418,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488689,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3908903,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2983526,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2959745,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5279129,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2326307,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431775,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2993875,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3915195,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596158,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991274,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432173,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2581180,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2491063,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2594885,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2596402,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4602025,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3936296,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592427,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4279532,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3133602,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3904625,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4703421,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2992257,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3986,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4396991,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683933,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5148538,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105809,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4684806,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066808,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3919454,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4279815,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3102533,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3138154,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5061603,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5211176,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2488945,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4064730,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106040,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397882,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065673,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4597865,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431675,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4065656,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5165257,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4409222,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2595231,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136481,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4698719,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4277842,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432645,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433268,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4395623,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4897438,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2327832,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431734,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(6474,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592965,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3074743,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489530,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3078286,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278555,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5105626,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2982349,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066367,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3947078,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059281,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2578269,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2530276,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4433225,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4838721,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5167876,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4397179,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5023693,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4432887,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4683749,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2184,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5037878,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5211984,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2531039,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3057304,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4237215,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4700818,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4230557,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5358755,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2528586,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4017850,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059316,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4592187,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066264,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4032,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2489897,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278783,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4897262,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5144126,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2326015,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3914075,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2983512,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059247,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066303,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5108024,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4997531,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3136183,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2991018,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5159486,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5159895,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4278116,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3059430,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066649,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4066377,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(4431690,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3892894,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(2560823,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(5106262,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027),
(3137713,null,'526e90471cb7756bc5fad0e10fcf5fb6a080609350f3697ca5666efe0aa57b86',2027);

-- Supabase Cron supports [1-59] seconds schedules. Local PGlite has no extension;
-- keep migrations portable and tell operators when independent ticking needs setup.
-- https://supabase.com/docs/guides/cron/quickstart
do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    begin
      execute 'create extension if not exists pg_cron';
      execute $schedule$select cron.schedule('live-draft-clock','1 second','select private.tick_live_drafts()')$schedule$;
    exception when others then
      raise warning 'Live draft cron was not installed: %. Enable pg_cron and schedule private.tick_live_drafts() every second. Browser polling still processes expirations.',sqlerrm;
    end;
  else
    raise notice 'pg_cron unavailable. Schedule private.tick_live_drafts() every second for drafts to advance without connected browsers.';
  end if;
end $$;

