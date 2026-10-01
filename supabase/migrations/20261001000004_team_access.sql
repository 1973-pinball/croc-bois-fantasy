-- Account-to-franchise links require an explicit commissioner decision.
-- An empty assignment interval represents cancellation before a scheduled start;
-- the original start remains recorded and the interval can never grant access.
alter table public.manager_assignments drop constraint manager_assignments_check;
alter table public.manager_assignments add constraint manager_assignments_dates_check
  check (effective_to is null or effective_from is null or effective_to>=effective_from);

create table public.team_access_requests (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  franchise_id uuid not null,
  user_id uuid not null references auth.users,
  applicant_email text not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  request_note text not null default '' check (length(request_note)<=2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users,
  reviewed_at timestamptz,
  review_note text,
  manager_id uuid,
  assignment_id uuid references public.manager_assignments,
  assigned_role text check (assigned_role in ('manager','co_manager')),
  cancelled_at timestamptz,
  foreign key (franchise_id,league_id) references public.franchises(id,league_id),
  foreign key (manager_id,league_id) references public.managers(id,league_id),
  check (status<>'approved' or (reviewed_by is not null and reviewed_at is not null and manager_id is not null and assignment_id is not null and assigned_role is not null)),
  check (status<>'rejected' or (reviewed_by is not null and reviewed_at is not null and length(btrim(coalesce(review_note,'')))>0)),
  check (status<>'cancelled' or cancelled_at is not null)
);
create unique index one_pending_team_access_request on public.team_access_requests(league_id,user_id) where status='pending';
create index team_access_request_review on public.team_access_requests(league_id,status,created_at);
alter table public.team_access_requests enable row level security;
revoke all on public.team_access_requests from anon,authenticated;
grant select on public.team_access_requests to anon,authenticated;
create policy team_access_request_read on public.team_access_requests for select
  using ((select auth.uid()) is not null and (user_id=(select auth.uid()) or private.is_commissioner(league_id)));

create function public.request_team_access(p_franchise uuid,p_display_name text,p_note text default '') returns public.team_access_requests
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); f public.franchises; result public.team_access_requests; email_snapshot text;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before requesting team access'; end if;
  select * into f from public.franchises where id=p_franchise;
  if not found or not private.can_read_league(f.league_id) then raise exception using errcode='42501',message='This franchise is not available for an access request'; end if;
  if length(btrim(coalesce(p_display_name,''))) not between 1 and 100 or length(coalesce(p_note,''))>2000 then raise exception 'Provide a display name of 1 to 100 characters and a note of at most 2000 characters'; end if;
  select email into email_snapshot from auth.users where id=actor;
  if nullif(btrim(email_snapshot),'') is null then raise exception 'A signed-in account with an email address is required'; end if;
  perform 1 from public.leagues where id=f.league_id for update;
  if not private.can_read_league(f.league_id) then raise exception using errcode='42501',message='This franchise is not available for an access request'; end if;
  if exists(select 1 from public.team_access_requests where league_id=f.league_id and user_id=actor and status='pending') then raise exception 'You already have a pending access request for this league'; end if;
  if exists(select 1 from public.manager_assignments a where a.league_id=f.league_id and a.franchise_id=f.id and a.user_id=actor and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then raise exception 'Current or scheduled access to this team already exists'; end if;
  insert into public.team_access_requests(league_id,franchise_id,user_id,applicant_email,display_name,request_note)
    values(f.league_id,f.id,actor,email_snapshot,btrim(p_display_name),btrim(coalesce(p_note,''))) returning * into result;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(f.league_id,actor,'team_access_requested',result.id,jsonb_build_object('franchise_id',f.id));
  return result;
end $$;

create function public.cancel_team_access(p_request uuid) returns public.team_access_requests
language plpgsql security definer set search_path='' as $$
declare result public.team_access_requests;
begin
  select * into result from public.team_access_requests where id=p_request;
  if not found or auth.uid() is null or result.user_id<>auth.uid() then raise exception using errcode='42501',message='Only the applicant can cancel this request'; end if;
  perform 1 from public.leagues where id=result.league_id for update;
  select * into result from public.team_access_requests where id=p_request for update;
  if result.status<>'pending' then raise exception 'This request is no longer pending'; end if;
  update public.team_access_requests set status='cancelled',cancelled_at=now() where id=result.id returning * into result;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(result.league_id,auth.uid(),'team_access_cancelled',result.id);
  return result;
end $$;

create function public.review_team_access(p_request uuid,p_action text,p_manager uuid default null,p_role text default 'manager',p_note text default '') returns public.team_access_requests
language plpgsql security definer set search_path='' as $$
declare result public.team_access_requests; selected_manager uuid; linked_assignment uuid;
begin
  select * into result from public.team_access_requests where id=p_request;
  if not found or not private.is_commissioner(result.league_id) then raise exception using errcode='42501',message='Commissioner access required for this league'; end if;
  if p_action is null or p_action not in ('approve','reject') or length(coalesce(p_note,''))>2000 then raise exception 'Choose approve or reject and provide at most 2000 characters of review notes'; end if;
  if p_action='reject' and nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'A rejection reason is required'; end if;
  if p_action='approve' and (p_role is null or p_role not in ('manager','co_manager')) then raise exception 'Choose manager or co_manager access'; end if;
  perform 1 from public.leagues where id=result.league_id for update;
  if not private.is_commissioner(result.league_id) then raise exception using errcode='42501',message='Commissioner access required for this league'; end if;
  select * into result from public.team_access_requests where id=p_request for update;
  if result.status<>'pending' then raise exception 'This request is no longer pending'; end if;
  if p_action='reject' then
    update public.team_access_requests set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_note) where id=result.id returning * into result;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(result.league_id,auth.uid(),'team_access_rejected',result.id,jsonb_build_object('note',btrim(p_note)));
    return result;
  end if;
  if exists(select 1 from public.manager_assignments a where a.league_id=result.league_id and a.franchise_id=result.franchise_id and a.user_id=result.user_id and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then raise exception 'Current or scheduled access to this team already exists'; end if;
  if p_role='manager' and exists(select 1 from public.manager_assignments a join public.league_memberships m on m.league_id=a.league_id and m.user_id=a.user_id where a.franchise_id=result.franchise_id and a.role='manager' and a.user_id<>result.user_id and m.active and m.role in ('manager','commissioner') and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then raise exception 'This team already has a primary manager; choose co_manager or revoke the previous assignment first'; end if;
  if exists(select 1 from public.league_memberships where league_id=result.league_id and user_id=result.user_id and role='commissioner' and not active) then raise exception 'An inactive commissioner membership requires trusted administrator review'; end if;
  -- Re-enabling a league membership must not silently revive other old team links.
  if not exists(select 1 from public.league_memberships where league_id=result.league_id and user_id=result.user_id and active and role in ('manager','commissioner'))
    and exists(select 1 from public.manager_assignments a where a.league_id=result.league_id and a.user_id=result.user_id and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then raise exception 'End the inactive account''s existing assignments before granting access to a new team'; end if;
  if p_manager is not null then
    if not exists(select 1 from public.managers m join public.manager_assignments a on a.manager_id=m.id and a.league_id=m.league_id where m.id=p_manager and m.league_id=result.league_id and a.franchise_id=result.franchise_id) then raise exception 'The selected manager identity must already belong to this franchise and league'; end if;
    if exists(select 1 from public.manager_assignments a where a.manager_id=p_manager and a.user_id is not null and a.user_id<>result.user_id and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then raise exception 'This manager identity is already linked to another current or scheduled account'; end if;
    selected_manager:=p_manager;
  else
    insert into public.managers(league_id,display_name) values(result.league_id,result.display_name) returning id into selected_manager;
  end if;
  insert into public.league_memberships(league_id,user_id,role,active) values(result.league_id,result.user_id,'manager',true)
    on conflict (league_id,user_id) do update set role=case when public.league_memberships.role='commissioner' then 'commissioner' else 'manager' end,active=true;
  insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,role,effective_from,historical_note)
    values(result.league_id,result.franchise_id,selected_manager,result.user_id,p_role,now(),'Approved account link; access request '||result.id::text) returning id into linked_assignment;
  update public.team_access_requests set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(coalesce(p_note,'')),manager_id=selected_manager,assignment_id=linked_assignment,assigned_role=p_role where id=result.id returning * into result;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(result.league_id,auth.uid(),'team_access_approved',result.id,jsonb_build_object('franchise_id',result.franchise_id,'manager_id',selected_manager,'assignment_id',linked_assignment,'role',p_role,'note',btrim(coalesce(p_note,''))));
  return result;
end $$;

create function public.revoke_team_access(p_assignment uuid,p_note text) returns void
language plpgsql security definer set search_path='' as $$
declare target public.manager_assignments; previous public.manager_assignments;
begin
  select * into target from public.manager_assignments where id=p_assignment;
  if not found or not private.is_commissioner(target.league_id) then raise exception using errcode='42501',message='Commissioner access required for this league'; end if;
  if length(btrim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'A revocation reason of 1 to 2000 characters is required'; end if;
  perform 1 from public.leagues where id=target.league_id for update;
  if not private.is_commissioner(target.league_id) then raise exception using errcode='42501',message='Commissioner access required for this league'; end if;
  select * into target from public.manager_assignments where id=p_assignment for update;
  if target.user_id is null or target.effective_from is null then raise exception 'This historical assignment has no linked account to revoke'; end if;
  if target.effective_to is not null and target.effective_to<=greatest(target.effective_from,now()) then raise exception 'This assignment is already ended or cancelled'; end if;
  previous:=target;
  update public.manager_assignments set effective_to=greatest(now(),effective_from) where id=target.id returning * into target;
  if not exists(select 1 from public.manager_assignments a where a.league_id=target.league_id and a.user_id=target.user_id and a.effective_from is not null and (a.effective_to is null or a.effective_to>greatest(a.effective_from,now()))) then
    update public.league_memberships set role='viewer' where league_id=target.league_id and user_id=target.user_id and role='manager';
  end if;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(target.league_id,auth.uid(),'team_access_revoked',target.id,jsonb_build_object('previous',to_jsonb(previous),'updated',to_jsonb(target),'note',btrim(p_note)));
end $$;

revoke all on function public.request_team_access(uuid,text,text) from public,anon;
revoke all on function public.cancel_team_access(uuid) from public,anon;
revoke all on function public.review_team_access(uuid,text,uuid,text,text) from public,anon;
revoke all on function public.revoke_team_access(uuid,text) from public,anon;
grant execute on function public.request_team_access(uuid,text,text) to authenticated;
grant execute on function public.cancel_team_access(uuid) to authenticated;
grant execute on function public.review_team_access(uuid,text,uuid,text,text) to authenticated;
grant execute on function public.revoke_team_access(uuid,text) to authenticated;

-- Future-dated team links preserve membership without granting today's trade access.
create function private.is_current_league_manager(p_league uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.league_memberships m where m.league_id=p_league and m.user_id=(select auth.uid()) and m.active and
    (m.role='commissioner' or (m.role='manager' and exists(select 1 from public.manager_assignments a where a.league_id=m.league_id and a.user_id=m.user_id and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())))));
$$;
revoke all on function private.is_current_league_manager(uuid) from public;
grant execute on function private.is_current_league_manager(uuid) to anon,authenticated;

create or replace function private.can_read_trade(p_trade uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.trades t where t.id=p_trade and
    ((t.status='finalized' and private.can_read_league(t.league_id)) or private.is_current_league_manager(t.league_id)));
$$;

-- Existing trade creation is unchanged apart from the dated-access guard, checked
-- again under the league lock so a queued request cannot outlive revocation.
create or replace function public.create_trade(p_season uuid,p_category text,p_terms text,p_players jsonb,p_picks jsonb,p_obligations jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.seasons; trade_id uuid; entry jsonb; team_id uuid;
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
