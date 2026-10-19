-- Preserve the keeper eligibility snapshot; publish a separate opening roster.
create table public.draft_finalizations (
  season_id uuid primary key references public.seasons,
  roster_snapshot_id uuid not null unique,
  keeper_profile_season_id uuid not null references public.seasons,
  source_revision integer not null check (source_revision >= 0),
  player_count integer not null check (player_count > 0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  finalized_at timestamptz not null default clock_timestamp(),
  finalized_by uuid not null references auth.users,
  note text not null,
  foreign key (roster_snapshot_id,season_id) references public.roster_snapshots(id,season_id),
  check (keeper_profile_season_id <> season_id)
);
alter table public.draft_finalizations enable row level security;
revoke all on public.draft_finalizations from public,anon,authenticated;
grant select on public.draft_finalizations to anon,authenticated;
create policy draft_finalization_read on public.draft_finalizations for select
  using (private.can_read_season(season_id));
create trigger immutable_draft_finalization before update or delete on public.draft_finalizations
  for each row execute function private.prevent_immutable_change();

-- This snapshot is immutable evidence, but is NOT next year's final keeper pool.
create function private.protect_finalized_draft_roster() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='roster_snapshots' then
    if exists(select 1 from public.draft_finalizations where roster_snapshot_id=old.id) then
      raise exception 'Finalized draft roster is immutable';
    end if;
  else
    if exists(select 1 from public.draft_finalizations where roster_snapshot_id=
      case when tg_op='DELETE' then old.snapshot_id else new.snapshot_id end)
      or (tg_op='UPDATE' and exists(select 1 from public.draft_finalizations where roster_snapshot_id=old.snapshot_id)) then
      raise exception 'Finalized draft roster entries are immutable';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.protect_finalized_draft_roster() from public,anon,authenticated;
create trigger finalized_draft_snapshot before update or delete on public.roster_snapshots
  for each row execute function private.protect_finalized_draft_roster();
create trigger finalized_draft_entries before insert or update or delete on public.roster_entries
  for each row execute function private.protect_finalized_draft_roster();

create function public.finalize_draft(p_season uuid,p_expected_revision integer,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; target public.seasons; rules public.rule_versions; next_rules public.rule_versions;
  receipt public.draft_finalizations; snapshot_id uuid; frozen_id uuid; rows_json jsonb;
  previous_ownerships jsonb; source_hash text; total integer; kept integer; finalized_time timestamptz;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  select * into receipt from public.draft_finalizations where season_id=s.id;
  -- Retries must never restore opening ownership over later in-season trades.
  if found then return to_jsonb(receipt); end if;
  if p_expected_revision is distinct from s.draft_revision then
    raise exception 'The draft board changed. Refresh before finalizing.' using errcode='40001';
  end if;
  if length(btrim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'Describe the finalization in 5 to 2000 characters'; end if;
  if s.phase<>'draft_ready' or s.keepers_revealed_at is null or not coalesce(private.draft_order_complete(s.id),false) then
    raise exception 'A revealed, ordered draft in draft_ready is required';
  end if;
  if not exists(select 1 from private.live_draft_clocks where season_id=s.id and status='completed') then
    raise exception 'Complete the draft clock before finalizing';
  end if;
  select * into strict rules from public.rule_versions where id=s.rule_version_id;
  total := s.participant_count * rules.draft_rounds;
  if (select count(*) from public.draft_picks where season_id=s.id)<>total
    or exists(select 1 from public.season_teams st cross join generate_series(1,rules.draft_rounds) n
      where st.season_id=s.id and not exists(select 1 from public.draft_picks p
        where p.season_id=s.id and p.original_franchise_id=st.franchise_id and p.round=n))
    or exists(select 1 from public.draft_picks where season_id=s.id and status<>'used') then
    raise exception 'Every original draft pick must be present and used';
  end if;
  if exists(select 1 from public.draft_picks p
      left join public.keeper_season_records k on k.season_id=p.season_id and k.pick_id=p.id
      left join public.live_draft_selections d on d.season_id=p.season_id and d.pick_id=p.id and d.voided_at is null
      where p.season_id=s.id and (k.player_id is null)=(d.player_id is null)) then
    raise exception 'Each pick must have exactly one active selection or keeper';
  end if;
  if exists(select 1 from public.historical_draft_selections where season_id=s.id) then
    raise exception 'Draft history already exists without a finalization receipt; reconcile it first';
  end if;
  select id into frozen_id from public.roster_snapshots where season_id=s.id and frozen_at is not null;
  if frozen_id is null then raise exception 'The original frozen keeper snapshot is required'; end if;
  select * into target from public.seasons where league_id=s.league_id and draft_year=s.draft_year+1 for update;
  if not found or target.phase<>'setup' or target.keepers_revealed_at is not null then
    raise exception 'Prepare the next season in setup before finalizing';
  end if;
  select * into strict next_rules from public.rule_versions where id=target.rule_version_id;
  if exists(select 1 from public.keeper_profiles where season_id=target.id) then
    raise exception 'Next-season keeper profiles already exist; reconcile them before finalizing';
  end if;
  if exists(select 1 from public.roster_snapshots where season_id=target.id and frozen_at is not null) then
    raise exception 'Next-season keeper eligibility must not already be frozen';
  end if;

  select jsonb_agg(jsonb_build_object(
    'player_id',coalesce(k.player_id,d.player_id),
    'player_name',coalesce(kp.full_name,d.player_name),
    'pick_id',p.id,'selection_id',d.id,'original_franchise_id',p.original_franchise_id,
    'franchise_id',coalesce(k.franchise_id,d.franchise_id),
    'roster_franchise_id',coalesce(o.franchise_id,k.franchise_id,d.franchise_id),
    'round',p.round,'overall_pick',(p.round-1)*s.participant_count+
      case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end,
    'was_keeper',k.player_id is not null,'base_keeper_round',k.base_round,
    'tenure_after',coalesce(k.tenure_after,1),
    'next_base_round',case when k.player_id is not null then k.base_round-1 else p.round-1 end
    ) order by p.round,st.draft_position) into rows_json
  from public.draft_picks p
  join public.season_teams st on st.season_id=p.season_id and st.franchise_id=p.original_franchise_id
  left join public.keeper_season_records k on k.season_id=p.season_id and k.pick_id=p.id
  left join public.players kp on kp.id=k.player_id
  left join public.live_draft_selections d on d.season_id=p.season_id and d.pick_id=p.id and d.voided_at is null
  left join public.live_draft_roster_ownership o on o.season_id=p.season_id and o.player_id=coalesce(k.player_id,d.player_id)
  where p.season_id=s.id;
  if jsonb_array_length(rows_json)<>total
    or (select count(distinct value->>'player_id') from jsonb_array_elements(rows_json))<>total
    or exists(select 1 from jsonb_array_elements(rows_json) x where x->>'player_name' is null
      or not exists(select 1 from public.season_teams st where st.season_id=s.id and st.franchise_id=(x->>'roster_franchise_id')::uuid)) then
    raise exception 'The completed roster must contain unique identified players and participating owners';
  end if;
  if exists(select 1 from public.live_draft_roster_ownership o where o.season_id=s.id
    and not exists(select 1 from jsonb_array_elements(rows_json) x where (x->>'player_id')::bigint=o.player_id)) then
    raise exception 'An ownership override has no active draft player';
  end if;
  source_hash := encode(sha256(convert_to(rows_json::text,'UTF8')),'hex');
  finalized_time := clock_timestamp();
  select count(*) into kept from public.keeper_season_records where season_id=s.id;
  select coalesce(jsonb_agg(to_jsonb(o) order by o.player_id),'[]'::jsonb) into previous_ownerships
    from public.player_ownerships o where season_id=s.id;

  insert into public.players(id,full_name,metadata)
    select x.player_id,x.player_name,jsonb_build_object('source','live_draft_finalization','season_id',s.id)
    from jsonb_to_recordset(rows_json) x(player_id bigint,player_name text)
    on conflict(id) do nothing;
  insert into public.roster_snapshots(league_id,season_id,snapshot_date,source_sha256,source_metadata)
    values(s.league_id,s.id,(finalized_time at time zone coalesce(s.season_time_zone,'UTC'))::date,source_hash,
      jsonb_build_object('kind','draft_finalization','draft_revision',s.draft_revision,'keeper_snapshot_id',frozen_id,
        'lineup_assignment','unassigned','includes_all_draft_players',true,'player_count',total)) returning id into snapshot_id;
  insert into public.roster_entries(snapshot_id,season_id,franchise_id,player_id,lineup_slot,source_pointer,acquisition_type,acquisition_at)
    select snapshot_id,s.id,x.roster_franchise_id,x.player_id,-1,'draft_picks/'||x.pick_id::text,
      case when x.was_keeper then 'KEEPER' else 'DRAFT' end,finalized_time
    from jsonb_to_recordset(rows_json) x(roster_franchise_id uuid,player_id bigint,pick_id uuid,was_keeper boolean);
  insert into public.historical_draft_selections(season_id,franchise_id,player_id,round,overall_pick,was_keeper,base_keeper_round,tenure_after,source_metadata)
    select s.id,x.franchise_id,x.player_id,x.round,x.overall_pick,x.was_keeper,x.base_keeper_round,x.tenure_after,
      jsonb_build_object('source','live_draft_finalization','source_revision',s.draft_revision,'pick_id',x.pick_id,
        'selection_id',x.selection_id,'original_franchise_id',x.original_franchise_id,'roster_franchise_id',x.roster_franchise_id,
        'source_sha256',source_hash)
    from jsonb_to_recordset(rows_json) x(franchise_id uuid,player_id bigint,round integer,overall_pick integer,was_keeper boolean,
      base_keeper_round integer,tenure_after integer,pick_id uuid,selection_id uuid,original_franchise_id uuid,roster_franchise_id uuid);
  delete from public.player_ownerships where season_id=s.id;
  insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id,updated_at)
    select s.id,x.player_id,x.roster_franchise_id,snapshot_id,finalized_time
    from jsonb_to_recordset(rows_json) x(player_id bigint,roster_franchise_id uuid);
  insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation,source_metadata)
    select target.id,x.player_id,s.league_id,target.rule_version_id,
      case when x.next_base_round between 1 and next_rules.draft_rounds then x.next_base_round else null end,x.tenure_after,
      case when x.next_base_round<1 or x.next_base_round>next_rules.draft_rounds or x.tenure_after>=next_rules.tenure_limit then 'ineligible' else 'confirmed' end,
      case when x.next_base_round<1 then 'No keeper round remains after the completed draft.'
        when x.tenure_after>=next_rules.tenure_limit then 'Keeper tenure limit reached in the completed season cycle.'
        when x.next_base_round>next_rules.draft_rounds then 'Keeper cost is outside the next season rules.'
        else 'Cost and tenure confirmed from the completed draft; eligibility still requires the final season roster.' end,
      jsonb_build_object('kind','draft_finalization','source_season_id',s.id,'source_revision',s.draft_revision,
        'pick_id',x.pick_id,'source_sha256',source_hash,'was_keeper',x.was_keeper,'actual_round',x.round,
        'underlying_keeper_round',x.base_keeper_round,'computed_next_base_round',x.next_base_round,
        'first_round_draft_ineligible',not x.was_keeper and x.round=1,'requires_final_roster',true)
    from jsonb_to_recordset(rows_json) x(player_id bigint,next_base_round integer,tenure_after integer,pick_id uuid,
      was_keeper boolean,round integer,base_keeper_round integer);
  insert into public.draft_finalizations(season_id,roster_snapshot_id,keeper_profile_season_id,source_revision,player_count,source_sha256,finalized_at,finalized_by,note)
    values(s.id,snapshot_id,target.id,s.draft_revision,total,source_hash,finalized_time,auth.uid(),btrim(p_note)) returning * into receipt;
  update public.seasons set phase='in_season',draft_revision=draft_revision+1 where id=s.id;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'draft_finalized',s.id,to_jsonb(receipt)||jsonb_build_object(
      'fresh_selections',total-kept,'keepers',kept,'previous_ownerships',previous_ownerships,
      'preserved_keeper_snapshot_id',frozen_id,'new_revision',s.draft_revision+1));
  return to_jsonb(receipt);
end $$;
revoke all on function public.finalize_draft(uuid,integer,text) from public,anon;
grant execute on function public.finalize_draft(uuid,integer,text) to authenticated;
