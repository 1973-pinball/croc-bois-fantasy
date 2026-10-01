create function public.review_keeper_profile(p_season uuid,p_player bigint,p_base_round integer,p_tenure integer,p_verification text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; r public.rule_versions; previous public.keeper_profiles; result public.keeper_profiles;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if s.keepers_revealed_at is not null or s.phase not in ('setup','keeper_selection') then raise exception 'Keeper profiles are frozen for this season'; end if;
  if p_verification not in ('confirmed','provisional','unresolved','ineligible') or length(btrim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'A verification status and review explanation are required'; end if;
  if p_base_round is not null and (p_base_round<1 or p_base_round>r.draft_rounds) then raise exception 'Base cost is outside the draft rounds'; end if;
  if p_tenure is not null and (p_tenure<1 or p_tenure>100) then raise exception 'Invalid tenure: the initial season counts as year one'; end if;
  if p_verification='confirmed' and (p_base_round is null or p_tenure is null or p_tenure>=r.tenure_limit) then raise exception 'Confirmed eligibility requires a valid cost and tenure below the limit'; end if;
  if not exists(select 1 from public.player_ownerships where season_id=s.id and player_id=p_player) then raise exception 'Player is outside the frozen keeper pool'; end if;
  if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id where a.season_id=s.id and a.player_id=p_player and k.is_current and k.status in ('approved','locked')) then raise exception 'Reject the approved submission before changing its keeper profile'; end if;
  select * into previous from public.keeper_profiles where season_id=s.id and player_id=p_player;
  insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation)
    values(s.id,p_player,s.league_id,s.rule_version_id,p_base_round,p_tenure,p_verification,p_note)
    on conflict (season_id,player_id) do update set rule_version_id=excluded.rule_version_id,base_round=excluded.base_round,tenure_years=excluded.tenure_years,verification=excluded.verification,explanation=excluded.explanation
    returning * into result;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_profile_reviewed',s.id,jsonb_build_object('player_id',p_player,'previous',to_jsonb(previous),'updated',to_jsonb(result),'note',p_note));
  return to_jsonb(result);
end $$;

create function public.resolve_trade_obligation(p_obligation uuid,p_status text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare obligation public.trade_obligations; t public.trades;
begin
  select * into obligation from public.trade_obligations where id=p_obligation;
  if not found then raise exception using errcode='P0002',message='Obligation not found'; end if;
  select * into strict t from public.trades where id=obligation.trade_id;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=t.league_id for update;
  select * into obligation from public.trade_obligations where id=p_obligation for update;
  if t.status<>'finalized' or obligation.status<>'open' then raise exception 'Only an open obligation from a finalized trade can be resolved'; end if;
  if p_status not in ('fulfilled','waived') or length(btrim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'A resolution and explanation are required'; end if;
  update public.trade_obligations set status=p_status,resolved_by=auth.uid(),resolved_at=now(),resolution_note=p_note where id=p_obligation returning * into obligation;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(t.league_id,auth.uid(),'trade_obligation_resolved',p_obligation,jsonb_build_object('status',p_status,'note',p_note));
  return to_jsonb(obligation);
end $$;

revoke all on function public.review_keeper_profile(uuid,bigint,integer,integer,text,text) from public,anon;
revoke all on function public.resolve_trade_obligation(uuid,text,text) from public,anon;
grant execute on function public.review_keeper_profile(uuid,bigint,integer,integer,text,text) to authenticated;
grant execute on function public.resolve_trade_obligation(uuid,text,text) to authenticated;
