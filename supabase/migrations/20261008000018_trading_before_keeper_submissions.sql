-- Trade review is independent of keeper-submission progress.
-- Retain commissioner authorization, review time, ownership, keeper reservations,
-- draft participation, post-reveal player protection and atomic ledger updates.
-- trading_opened_at remains a legacy submission milestone; it is not a trade gate.
create or replace function public.finalize_trade(p_trade uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.trades; s public.seasons; leg record;
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
  if now()<t.review_deadline then raise exception 'The mandatory 24-hour trade review period has not ended'; end if;
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  if s.keepers_revealed_at is not null and exists(select 1 from public.trade_player_transfers where trade_id=t.id) then
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
  end loop;
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
  -- A changed owner invalidates any player choice made against the prior board, including future drafts.
  update public.seasons ds set draft_revision=ds.draft_revision+1 where ds.id in (
    select dp.season_id from public.trade_pick_transfers x join public.draft_picks dp on dp.id=x.pick_id where x.trade_id=t.id
  );
  -- Receiving a later payment pick can invalidate an already approved allocation.
  -- Validate against the prospective ledger before committing any transfer. Include
  -- future pick seasons, but exclude revealed seasons whose picks are already used.
  for leg in
    select k.id from public.keeper_submissions k join public.seasons ks on ks.id=k.season_id
    where ks.league_id=t.league_id and ks.keepers_revealed_at is null
      and k.is_current and k.status in ('approved','locked')
      and (k.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id
        where x.trade_id=t.id and p.season_id=k.season_id))
  loop
    perform private.validate_keeper_submission(leg.id);
  end loop;
  update public.trades set status='finalized',finalized_at=now(),finalized_by=auth.uid() where id=t.id returning * into t;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(t.league_id,auth.uid(),'trade_finalized',t.id);
  return to_jsonb(t);
end $$;

revoke all on function public.finalize_trade(uuid) from public,anon;
grant execute on function public.finalize_trade(uuid) to authenticated;
