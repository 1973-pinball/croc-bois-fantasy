-- Withdrawal records an administrative correction; it does not implement a league veto.
alter table public.trades
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references auth.users,
  add column cancellation_reason text;

create function public.withdraw_trade(p_trade uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.trades; s public.seasons;
begin
  select * into t from public.trades where id=p_trade;
  if not found then raise exception using errcode='P0002',message='Trade not found'; end if;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 5 and 2000 then raise exception 'Withdrawal reason must contain 5 to 2000 characters'; end if;
  -- Use the same lock order as finalization, so only one transition can win.
  perform 1 from public.leagues where id=t.league_id for update;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into strict t from public.trades where id=p_trade for update;
  select * into strict s from public.seasons where id=t.season_id;
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  if t.application_mode<>'live' or t.status<>'proposed' then raise exception 'Only pending live trades can be withdrawn'; end if;
  update public.trades set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason=btrim(p_reason)
    where id=t.id returning * into t;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(t.league_id,auth.uid(),'trade_withdrawn',t.id,jsonb_build_object('reason',btrim(p_reason)));
  return to_jsonb(t);
end $$;

create function public.create_trade_revision(p_previous uuid,p_season uuid,p_category text,p_terms text,p_players jsonb,p_picks jsonb,p_obligations jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare previous public.trades; next_id uuid;
begin
  select * into previous from public.trades where id=p_previous;
  if not found then raise exception using errcode='P0002',message='Previous trade not found'; end if;
  if not private.is_commissioner(previous.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=previous.league_id for update;
  if not private.is_commissioner(previous.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into strict previous from public.trades where id=p_previous for update;
  if previous.status<>'cancelled' or previous.application_mode<>'live' or previous.season_id<>p_season then raise exception 'A revision must reference a withdrawn live trade in this season'; end if;
  if exists(select 1 from public.seasons where id=p_season and phase='archived') then raise exception 'Cannot change an archived season'; end if;
  next_id := public.create_trade(p_season,p_category,p_terms,p_players,p_picks,p_obligations);
  update public.trades set corrects_trade_id=previous.id where id=next_id;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(previous.league_id,auth.uid(),'trade_revision_created',next_id,jsonb_build_object('previous_trade_id',previous.id));
  return next_id;
end $$;

revoke all on function public.withdraw_trade(uuid,text) from public,anon;
revoke all on function public.create_trade_revision(uuid,uuid,text,text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.withdraw_trade(uuid,text) to authenticated;
grant execute on function public.create_trade_revision(uuid,uuid,text,text,jsonb,jsonb,jsonb) to authenticated;
