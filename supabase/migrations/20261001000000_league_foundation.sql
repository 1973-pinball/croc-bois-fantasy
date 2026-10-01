-- Croc Bois: season-scoped rights, immutable provenance, and private keeper review.
-- All application writes go through authenticated, authorized functions below.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  espn_league_id bigint unique,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.league_memberships (
  league_id uuid not null references public.leagues,
  user_id uuid not null references auth.users,
  role text not null check (role in ('viewer','manager','commissioner')),
  active boolean not null default true,
  primary key (league_id,user_id)
);
create table public.franchises (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  name text not null,
  espn_team_id integer,
  aliases text[] not null default '{}',
  unique (id,league_id),
  unique (league_id,espn_team_id)
);
create table public.managers (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  display_name text not null,
  unique (id,league_id)
);
create table public.manager_assignments (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  franchise_id uuid not null,
  manager_id uuid not null,
  user_id uuid references auth.users,
  role text not null default 'manager' check (role in ('manager','co_manager')),
  effective_from timestamptz,
  effective_to timestamptz,
  historical_note text,
  foreign key (franchise_id,league_id) references public.franchises(id,league_id),
  foreign key (manager_id,league_id) references public.managers(id,league_id),
  foreign key (league_id,user_id) references public.league_memberships(league_id,user_id),
  check (effective_to is null or effective_from is null or effective_to>effective_from),
  check (user_id is null or effective_from is not null)
);
create index manager_assignments_access on public.manager_assignments(user_id,franchise_id);
create table public.rule_versions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  version integer not null check (version>0),
  draft_rounds integer not null default 13 check (draft_rounds between 1 and 30),
  roster_capacity integer not null default 13 check (roster_capacity between 1 and 30),
  tenure_limit integer not null default 5 check (tenure_limit>0),
  undrafted_initial_round integer not null default 13 check (undrafted_initial_round>0),
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id,league_id), unique (league_id,version)
);
create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  label text not null,
  draft_year integer not null check (draft_year between 2000 and 2200),
  rule_version_id uuid not null,
  phase text not null default 'setup' check (phase in ('setup','keeper_selection','draft_ready','in_season','archived')),
  participant_count integer not null check (participant_count between 2 and 100),
  lottery_config jsonb not null default '{}'::jsonb,
  draft_format text not null default 'snake' check (draft_format in ('snake','linear')),
  keepers_revealed_at timestamptz,
  foreign key (rule_version_id,league_id) references public.rule_versions(id,league_id),
  unique (id,league_id), unique (league_id,draft_year)
);
create table public.season_teams (
  season_id uuid not null,
  franchise_id uuid not null,
  league_id uuid not null,
  display_name text not null,
  lottery_category text,
  lottery_choice_order integer check (lottery_choice_order>0),
  draft_position integer check (draft_position>0),
  primary key (season_id,franchise_id),
  foreign key (season_id,league_id) references public.seasons(id,league_id),
  foreign key (franchise_id,league_id) references public.franchises(id,league_id),
  unique (season_id,draft_position), unique (season_id,lottery_choice_order)
);
create table public.players (
  id bigint primary key check (id>0), -- Stable ESPN player identity; never use names as keys.
  full_name text not null,
  metadata jsonb not null default '{}'::jsonb
);
create table public.roster_snapshots (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  season_id uuid not null,
  snapshot_date date not null,
  scoring_period integer,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_metadata jsonb not null default '{}'::jsonb,
  frozen_at timestamptz,
  foreign key (season_id,league_id) references public.seasons(id,league_id),
  unique (id,season_id), unique (season_id,source_sha256)
);
create unique index one_frozen_snapshot_per_season on public.roster_snapshots(season_id) where frozen_at is not null;
create table public.roster_entries (
  snapshot_id uuid not null,
  season_id uuid not null,
  franchise_id uuid not null,
  player_id bigint not null references public.players,
  lineup_slot integer not null,
  source_pointer text not null,
  acquisition_type text,
  acquisition_at timestamptz,
  primary key (snapshot_id,player_id),
  foreign key (snapshot_id,season_id) references public.roster_snapshots(id,season_id),
  foreign key (season_id,franchise_id) references public.season_teams
);
create table public.player_ownerships (
  season_id uuid not null,
  player_id bigint not null references public.players,
  franchise_id uuid not null,
  source_snapshot_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (season_id,player_id),
  foreign key (season_id,franchise_id) references public.season_teams,
  foreign key (source_snapshot_id,player_id) references public.roster_entries(snapshot_id,player_id),
  foreign key (source_snapshot_id,season_id) references public.roster_snapshots(id,season_id)
);
create table public.keeper_profiles (
  season_id uuid not null,
  player_id bigint not null references public.players,
  league_id uuid not null,
  rule_version_id uuid not null,
  base_round integer check (base_round between 1 and 30),
  tenure_years integer check (tenure_years>=1),
  verification text not null default 'unresolved' check (verification in ('confirmed','provisional','unresolved','ineligible')),
  explanation text not null,
  source_metadata jsonb not null default '{}'::jsonb,
  primary key (season_id,player_id),
  foreign key (season_id,league_id) references public.seasons(id,league_id),
  foreign key (rule_version_id,league_id) references public.rule_versions(id,league_id)
);
create table public.draft_picks (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null,
  original_franchise_id uuid not null,
  current_owner_id uuid not null,
  round integer not null check (round between 1 and 30),
  status text not null default 'available' check (status in ('available','used')),
  foreign key (season_id,original_franchise_id) references public.season_teams,
  foreign key (season_id,current_owner_id) references public.season_teams,
  unique (season_id,original_franchise_id,round), unique (id,season_id)
);
create index draft_picks_owner on public.draft_picks(season_id,current_owner_id,round);
create table public.historical_draft_selections (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null,
  franchise_id uuid not null,
  player_id bigint not null references public.players,
  round integer not null check (round>0),
  overall_pick integer check (overall_pick>0),
  was_keeper boolean, -- Null preserves unknown historical keeper classification.
  base_keeper_round integer,
  tenure_after integer check (tenure_after>=0),
  source_metadata jsonb not null default '{}'::jsonb,
  foreign key (season_id,franchise_id) references public.season_teams,
  unique (season_id,player_id), unique (season_id,overall_pick)
);
create table public.keeper_submissions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null,
  franchise_id uuid not null,
  revision integer not null check (revision>0),
  is_current boolean not null default true,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','locked')),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid references auth.users,
  reviewed_at timestamptz,
  review_note text,
  locked_at timestamptz,
  foreign key (season_id,franchise_id) references public.season_teams,
  unique (season_id,franchise_id,revision), unique (id,season_id)
);
create unique index keeper_current_revision on public.keeper_submissions(season_id,franchise_id) where is_current;
create table public.keeper_assignments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null,
  season_id uuid not null,
  player_id bigint not null references public.players,
  pick_id uuid not null,
  base_round_at_submission integer,
  tenure_at_submission integer,
  reserved boolean not null default false,
  foreign key (submission_id,season_id) references public.keeper_submissions(id,season_id),
  foreign key (pick_id,season_id) references public.draft_picks(id,season_id),
  unique (submission_id,player_id), unique (submission_id,pick_id)
);
create unique index keeper_reserved_pick on public.keeper_assignments(pick_id) where reserved;
create unique index keeper_reserved_player on public.keeper_assignments(season_id,player_id) where reserved;
create table public.keeper_season_records (
  season_id uuid not null,
  player_id bigint not null references public.players,
  franchise_id uuid not null,
  submission_id uuid not null,
  pick_id uuid not null unique,
  base_round integer not null,
  actual_payment_round integer not null,
  tenure_before integer not null,
  tenure_after integer not null,
  rule_version_id uuid not null references public.rule_versions,
  finalized_at timestamptz not null default now(),
  primary key (season_id,player_id),
  foreign key (season_id,franchise_id) references public.season_teams,
  foreign key (submission_id,season_id) references public.keeper_submissions(id,season_id),
  foreign key (pick_id,season_id) references public.draft_picks(id,season_id)
);
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  season_id uuid not null,
  category text not null check (category in ('player_only','advanced')),
  status text not null default 'proposed' check (status in ('proposed','finalized','cancelled')),
  application_mode text not null default 'live' check (application_mode in ('live','record_only')),
  terms text not null default '',
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  review_deadline timestamptz not null default (now()+interval '24 hours'),
  created_by uuid references auth.users,
  finalized_by uuid references auth.users,
  finalized_at timestamptz,
  corrects_trade_id uuid references public.trades,
  source_metadata jsonb not null default '{}'::jsonb,
  foreign key (season_id,league_id) references public.seasons(id,league_id),
  check (review_deadline>=created_at+interval '24 hours')
);
create table public.trade_participants (
  trade_id uuid not null references public.trades,
  franchise_id uuid not null references public.franchises,
  historical_manager_names text[] not null default '{}',
  primary key (trade_id,franchise_id)
);
create table public.trade_player_transfers (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades,
  player_id bigint not null references public.players,
  from_franchise_id uuid not null,
  to_franchise_id uuid not null,
  espn_status text not null default 'pending' check (espn_status in ('pending','completed','not_required')),
  foreign key (trade_id,from_franchise_id) references public.trade_participants,
  foreign key (trade_id,to_franchise_id) references public.trade_participants,
  check (from_franchise_id<>to_franchise_id), unique (trade_id,player_id)
);
create table public.trade_pick_transfers (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades,
  pick_id uuid not null references public.draft_picks,
  from_franchise_id uuid not null,
  to_franchise_id uuid not null,
  foreign key (trade_id,from_franchise_id) references public.trade_participants,
  foreign key (trade_id,to_franchise_id) references public.trade_participants,
  check (from_franchise_id<>to_franchise_id), unique (trade_id,pick_id)
);
create table public.trade_obligations (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades,
  from_franchise_id uuid not null,
  to_franchise_id uuid not null,
  kind text not null check (kind in ('loan_return','conditional_pick','espn_action','other')),
  terms text not null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','fulfilled','waived')),
  resolved_by uuid references auth.users,
  resolved_at timestamptz,
  resolution_note text,
  foreign key (trade_id,from_franchise_id) references public.trade_participants,
  foreign key (trade_id,to_franchise_id) references public.trade_participants,
  check (from_franchise_id<>to_franchise_id)
);
create table public.audit_events (
  id bigint generated always as identity primary key,
  league_id uuid not null references public.leagues,
  actor_user_id uuid references auth.users,
  event_type text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function private.is_commissioner(p_league uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.league_memberships where league_id=p_league and user_id=(select auth.uid()) and active and role='commissioner');
$$;
create function private.can_read_league(p_league uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.leagues where id=p_league and is_public)
    or exists(select 1 from public.league_memberships where league_id=p_league and user_id=(select auth.uid()) and active);
$$;
create function private.can_manage_franchise(p_franchise uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.manager_assignments a join public.league_memberships m on m.league_id=a.league_id and m.user_id=a.user_id
    where a.franchise_id=p_franchise and a.user_id=(select auth.uid()) and m.active and m.role in ('manager','commissioner')
      and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()));
$$;
create function private.can_read_season(p_season uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.seasons where id=p_season and private.can_read_league(league_id));
$$;
create function private.can_read_submission(p_submission uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.keeper_submissions k join public.seasons s on s.id=k.season_id where k.id=p_submission and
    (private.is_commissioner(s.league_id) or private.can_manage_franchise(k.franchise_id)));
$$;
create function private.can_read_trade(p_trade uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.trades t where t.id=p_trade and
    (private.is_commissioner(t.league_id) or (t.status='finalized' and private.can_read_league(t.league_id)) or
      exists(select 1 from public.trade_participants p where p.trade_id=t.id and private.can_manage_franchise(p.franchise_id))));
$$;

-- Frozen snapshots, versioned rules, and finalized outcomes cannot be rewritten by imports.
create function private.prevent_immutable_change() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'Historical records are immutable; add an explicit correction record'; end $$;
create trigger immutable_rules before update or delete on public.rule_versions for each row execute function private.prevent_immutable_change();
create trigger immutable_draft_history before update or delete on public.historical_draft_selections for each row execute function private.prevent_immutable_change();
create trigger immutable_keeper_history before update or delete on public.keeper_season_records for each row execute function private.prevent_immutable_change();
create trigger immutable_audit before update or delete on public.audit_events for each row execute function private.prevent_immutable_change();
create function private.protect_frozen_roster() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_table_name='roster_snapshots' then
    if old.frozen_at is not null then raise exception 'Frozen snapshot is immutable'; end if;
  else
    if exists(select 1 from public.roster_snapshots where id=case when tg_op='DELETE' then old.snapshot_id else new.snapshot_id end and frozen_at is not null)
      or (tg_op='UPDATE' and exists(select 1 from public.roster_snapshots where id=old.snapshot_id and frozen_at is not null)) then
      raise exception 'Frozen roster entries are immutable';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger frozen_snapshot before update or delete on public.roster_snapshots for each row execute function private.protect_frozen_roster();
create trigger frozen_entries before insert or update or delete on public.roster_entries for each row execute function private.protect_frozen_roster();

-- Explicit grants: never let a signed-in user self-enroll or bypass the workflow.
do $$ declare t text; begin
  foreach t in array array['leagues','league_memberships','franchises','managers','manager_assignments','rule_versions','seasons','season_teams','players','roster_snapshots','roster_entries','player_ownerships','keeper_profiles','draft_picks','historical_draft_selections','keeper_submissions','keeper_assignments','keeper_season_records','trades','trade_participants','trade_player_transfers','trade_pick_transfers','trade_obligations','audit_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to anon, authenticated',t);
  end loop;
end $$;
create policy league_read on public.leagues for select using (private.can_read_league(id));
create policy membership_read on public.league_memberships for select using (user_id=(select auth.uid()) or private.is_commissioner(league_id));
create policy franchise_read on public.franchises for select using (private.can_read_league(league_id));
create policy manager_read on public.managers for select using (private.can_read_league(league_id));
create policy assignment_read on public.manager_assignments for select using (user_id=(select auth.uid()) or private.is_commissioner(league_id));
create policy rules_read on public.rule_versions for select using (private.can_read_league(league_id));
create policy season_read on public.seasons for select using (private.can_read_league(league_id));
create policy season_team_read on public.season_teams for select using (private.can_read_league(league_id));
create policy player_read on public.players for select using (true);
create policy snapshot_read on public.roster_snapshots for select using (private.can_read_league(league_id));
create policy roster_read on public.roster_entries for select using (private.can_read_season(season_id));
create policy ownership_read on public.player_ownerships for select using (private.can_read_season(season_id));
create policy keeper_profile_read on public.keeper_profiles for select using (private.can_read_league(league_id));
create policy pick_read on public.draft_picks for select using (private.can_read_season(season_id));
create policy draft_history_read on public.historical_draft_selections for select using (private.can_read_season(season_id));
create policy submission_read on public.keeper_submissions for select using (private.can_read_submission(id));
create policy keeper_assignment_read on public.keeper_assignments for select using (private.can_read_submission(submission_id));
create policy keeper_history_read on public.keeper_season_records for select using (private.can_read_season(season_id));
create policy trade_read on public.trades for select using (private.can_read_trade(id));
create policy trade_participant_read on public.trade_participants for select using (private.can_read_trade(trade_id));
create policy trade_player_read on public.trade_player_transfers for select using (private.can_read_trade(trade_id));
create policy trade_pick_read on public.trade_pick_transfers for select using (private.can_read_trade(trade_id));
create policy trade_obligation_read on public.trade_obligations for select using (private.can_read_trade(trade_id));
create policy audit_read on public.audit_events for select using (private.is_commissioner(league_id));
revoke all on all functions in schema private from public;
grant execute on all functions in schema private to anon,authenticated;
