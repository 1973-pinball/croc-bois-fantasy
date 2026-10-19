-- A completed clock does not establish current roster ownership. Only the atomic
-- draft receipt and in-season phase open ordinary player trades after keeper reveal.
create function private.has_finalized_draft_roster(p_season uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.seasons s join public.draft_finalizations f on f.season_id=s.id
    where s.id=p_season and s.phase='in_season');
$$;
revoke all on function private.has_finalized_draft_roster(uuid) from public,anon,authenticated;

create or replace function public.create_trade(p_season uuid,p_category text,p_terms text,p_players jsonb,p_picks jsonb,p_obligations jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.seasons; trade_id uuid; entry jsonb; team_id uuid; roster_finalized boolean;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_current_league_manager(s.league_id) then raise exception using errcode='42501',message='Current league manager access is required to log a trade'; end if;
  if p_category not in ('player_only','advanced') or length(coalesce(p_terms,''))>10000 then raise exception 'Invalid trade terms'; end if;
  if p_players is null or p_picks is null or p_obligations is null or jsonb_typeof(p_players)<>'array' or jsonb_typeof(p_picks)<>'array' or jsonb_typeof(p_obligations)<>'array' then raise exception 'Trade assets must be arrays'; end if;
  if jsonb_array_length(p_players)+jsonb_array_length(p_picks)+jsonb_array_length(p_obligations) not between 1 and 100 then raise exception 'A trade requires between 1 and 100 assets or obligations'; end if;
  if p_category='player_only' and (jsonb_array_length(p_picks)>0 or jsonb_array_length(p_obligations)>0) then raise exception 'Player-only trades cannot include picks or obligations'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  if not private.is_current_league_manager(s.league_id) then raise exception using errcode='42501',message='Current league manager access is required to log a trade'; end if;
  select * into strict s from public.seasons where id=p_season;
  roster_finalized:=private.has_finalized_draft_roster(s.id);
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  if (s.keepers_revealed_at is not null or s.phase='in_season') and not roster_finalized and jsonb_array_length(p_players)>0 then
    raise exception 'Player trades pause after keeper reveal until the new draft roster is finalized. Pick-only trades remain available.';
  end if;
  insert into public.trades(league_id,season_id,category,terms,created_by) values(s.league_id,s.id,p_category,coalesce(p_terms,''),auth.uid()) returning id into trade_id;
  for entry in select value from jsonb_array_elements(p_players||p_picks||p_obligations) loop
    for team_id in select (entry->>'from_franchise_id')::uuid union select (entry->>'to_franchise_id')::uuid loop
      if not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=team_id) then raise exception 'Every trade participant must be in this season'; end if;
      insert into public.trade_participants(trade_id,franchise_id) values(trade_id,team_id) on conflict do nothing;
    end loop;
  end loop;
  for entry in select value from jsonb_array_elements(p_players) loop
    insert into public.trade_player_transfers(trade_id,player_id,from_franchise_id,to_franchise_id)
      values(trade_id,(entry->>'player_id')::bigint,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid);
  end loop;
  for entry in select value from jsonb_array_elements(p_picks) loop
    insert into public.trade_pick_transfers(trade_id,pick_id,from_franchise_id,to_franchise_id)
      values(trade_id,(entry->>'pick_id')::uuid,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid);
  end loop;
  for entry in select value from jsonb_array_elements(p_obligations) loop
    if length(coalesce(entry->>'terms','')) not between 1 and 10000 then raise exception 'Obligation terms are required'; end if;
    insert into public.trade_obligations(trade_id,from_franchise_id,to_franchise_id,kind,terms,due_at)
      values(trade_id,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid,entry->>'kind',entry->>'terms',(entry->>'due_at')::timestamptz);
  end loop;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(s.league_id,auth.uid(),'trade_created',trade_id);
  return trade_id;
end $$;

create or replace function public.finalize_trade(p_trade uuid,p_keeper_payments jsonb,p_note text,p_override_review boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.trades; s public.seasons; leg record; payment_context jsonb; roster_finalized boolean;
begin
  select * into t from public.trades where id=p_trade;
  if not found then raise exception using errcode='P0002',message='Trade not found'; end if;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=t.league_id for update;
  select * into t from public.trades where id=p_trade for update;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into strict s from public.seasons where id=t.season_id;
  if t.application_mode<>'live' then raise exception 'Historical records cannot be applied to bootstrap ownership'; end if;
  if t.status<>'proposed' then raise exception 'Trade has already been finalized or cancelled'; end if;
  if p_override_review is null then raise exception 'Explicit review override choice is required'; end if;
  if p_override_review and length(btrim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'A review override reason of 5 to 2000 characters is required'; end if;
  if now()<t.review_deadline and not p_override_review then raise exception 'The mandatory 24-hour trade review period has not ended'; end if;
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  roster_finalized:=private.has_finalized_draft_roster(s.id);
  if (s.keepers_revealed_at is not null or s.phase='in_season') and not roster_finalized and exists(select 1 from public.trade_player_transfers where trade_id=t.id) then
    raise exception 'Player trades pause after keeper reveal until the new draft roster is finalized. Pick-only trades remain available.';
  end if;
  if (select count(*) from public.trade_participants where trade_id=t.id)<2 then raise exception 'A trade needs at least two teams'; end if;
  if not exists(select 1 from public.trade_player_transfers where trade_id=t.id) and not exists(select 1 from public.trade_pick_transfers where trade_id=t.id) and not exists(select 1 from public.trade_obligations where trade_id=t.id) then raise exception 'Trade has no assets'; end if;
  if exists(select 1 from public.trade_participants tp where tp.trade_id=t.id and not exists(select 1 from public.season_teams st where st.season_id=s.id and st.franchise_id=tp.franchise_id)) then raise exception 'Trade includes a team outside this season'; end if;
  if t.category='player_only' and (exists(select 1 from public.trade_pick_transfers where trade_id=t.id) or exists(select 1 from public.trade_obligations where trade_id=t.id)) then raise exception 'Player-only trades cannot include advanced terms'; end if;
  for leg in select * from public.trade_player_transfers where trade_id=t.id order by player_id loop
    perform 1 from public.player_ownerships where season_id=s.id and player_id=leg.player_id and franchise_id=leg.from_franchise_id for update;
    if not found then raise exception 'Player % is no longer owned by the source team',leg.player_id; end if;
    if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id where a.season_id=s.id and a.player_id=leg.player_id and a.reserved and k.is_current and s.keepers_revealed_at is null) then raise exception 'Cannot trade an approved keeper before reveal'; end if;
    if not roster_finalized and s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline and exists(
      select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id
      where a.season_id=s.id and a.player_id=leg.player_id and k.is_current and (k.status='submitted' or (private.uses_deadline_keeper_payments(s.id) and k.status in ('approved','locked')))) then
      raise exception 'Submitted keeper players are fixed after the deadline; only payment picks may change';
    end if;
  end loop;
  payment_context:=private.prepare_keeper_payment_amendments(s.league_id,p_keeper_payments,p_note,p_trade);
  for leg in select x.*,p.season_id as pick_season from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id where x.trade_id=t.id order by x.pick_id loop
    if not exists(select 1 from public.seasons ps where ps.id=leg.pick_season and ps.league_id=t.league_id and ps.draft_year>=s.draft_year) then raise exception 'Pick must belong to this league and this or a future draft'; end if;
    if not exists(select 1 from public.season_teams where season_id=leg.pick_season and franchise_id=leg.to_franchise_id) then raise exception 'Pick recipient is not participating in its draft season'; end if;
    perform 1 from public.draft_picks where id=leg.pick_id and current_owner_id=leg.from_franchise_id and status='available' for update;
    if not found then raise exception 'Pick is no longer available to the source team'; end if;
    if exists(select 1 from public.keeper_assignments where pick_id=leg.pick_id and reserved) then raise exception 'Pick is committed to an approved keeper'; end if;
  end loop;
  -- Ownership checks all pass before any leg is written; transaction rollback is all-or-none.
  update public.player_ownerships o set franchise_id=x.to_franchise_id,updated_at=now() from public.trade_player_transfers x where x.trade_id=t.id and o.season_id=s.id and o.player_id=x.player_id;
  update public.draft_picks p set current_owner_id=x.to_franchise_id from public.trade_pick_transfers x where x.trade_id=t.id and p.id=x.pick_id;
  -- A predeadline player trade returns its prior official selection for editing;
  -- previews never reserve the transferred player or any payment pick.
  for leg in select distinct k.id from public.keeper_submissions k join public.keeper_assignments a on a.submission_id=k.id
    join public.trade_player_transfers x on x.trade_id=t.id and x.player_id=a.player_id and x.from_franchise_id=k.franchise_id
    where k.season_id=s.id and not roster_finalized and k.is_current and k.status in ('submitted','approved')
      and private.uses_deadline_keeper_payments(s.id) and (s.keeper_deadline is null or clock_timestamp()<s.keeper_deadline)
  loop
    update public.keeper_assignments set reserved=false where submission_id=leg.id;
    update public.keeper_submissions set status='rejected',reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),
      review_note='A selected keeper was traded before the deadline. Review this private selection and submit it again.' where id=leg.id;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
      values(s.league_id,auth.uid(),'keeper_returned_after_player_trade',leg.id,jsonb_build_object('tradeId',t.id));
  end loop;
  perform private.finish_keeper_payment_amendments(s.league_id,payment_context,p_note,p_trade);
  -- A changed owner invalidates any player choice made against the prior board, including future drafts.
  update public.seasons ds set draft_revision=ds.draft_revision+1 where ds.id in (
    select dp.season_id from public.trade_pick_transfers x join public.draft_picks dp on dp.id=x.pick_id where x.trade_id=t.id
    union select (value->>'season_id')::uuid from jsonb_array_elements(payment_context)
  );
  -- Receiving a later payment pick can invalidate an already approved allocation.
  -- Validate against the prospective ledger before committing any transfer. Include
  -- future pick seasons, using saved costs and matching revealed keeper payments.
  -- Completed keeper cycles remain history; their players may now have new owners.
  for leg in
    select k.id,k.season_id from public.keeper_submissions k join public.seasons ks on ks.id=k.season_id
    where ks.league_id=t.league_id
      and not private.has_finalized_draft_roster(ks.id)
      and k.is_current and k.status in ('approved','locked')
      and (k.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id
        where x.trade_id=t.id and p.season_id=k.season_id))
  loop
    if private.uses_deadline_keeper_payments(leg.season_id) and not exists(select 1 from public.keeper_assignments where submission_id=leg.id and reserved) then
      perform private.validate_keeper_players(leg.id);
    else perform private.validate_fixed_keeper_payments(leg.id); end if;
  end loop;
  update public.trades set status='finalized',finalized_at=now(),finalized_by=auth.uid() where id=t.id returning * into t;
  if p_override_review then
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(t.league_id,auth.uid(),'trade_review_overridden',t.id,
      jsonb_build_object('reason',btrim(p_note),'reviewDeadline',t.review_deadline,'finalizedEarly',now()<t.review_deadline));
  end if;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(t.league_id,auth.uid(),'trade_finalized',t.id,
    jsonb_build_object('reviewOverride',p_override_review,'paymentAmendmentCount',jsonb_array_length(payment_context)));
  return to_jsonb(t);
end $$;

revoke all on function public.create_trade(uuid,text,text,jsonb,jsonb,jsonb),public.finalize_trade(uuid,jsonb,text,boolean) from public,anon;
grant execute on function public.create_trade(uuid,text,text,jsonb,jsonb,jsonb),public.finalize_trade(uuid,jsonb,text,boolean) to authenticated;
