-- Prospective one-team experiments share the existing isolated AI JSON state.
-- Enforce receipt time at the database boundary, not only a browser/server clock.
create function private.protect_ai_live_decisions() returns trigger
language plpgsql set search_path='' as $$
declare previous jsonb; current_state jsonb; lock_row jsonb; previous_row jsonb;
  scenario jsonb; old_scenario jsonb; item jsonb; matched jsonb; field text; receipt timestamptz;
begin
  previous := case when tg_op='UPDATE' then old.payload->'liveSingles' else null end;
  current_state := new.payload->'liveSingles';
  if current_state is null or current_state='null'::jsonb then
    if previous is not null and previous<>'null'::jsonb then raise exception 'Saved live experiments cannot be removed'; end if;
    return new;
  end if;
  if new.season<>2027 or current_state->>'season'<>'2027' or current_state->>'version'<>'1'
    or jsonb_typeof(current_state->'locks') is distinct from 'array'
    or jsonb_typeof(current_state->'scenarios') is distinct from 'array' then raise exception 'Invalid live experiment receipt'; end if;
  if exists(select 1 from jsonb_array_elements(current_state->'locks') r(value) group by r.value->>'date' having count(*)>1) then raise exception 'Duplicate live decision dates'; end if;
  if exists(select 1 from jsonb_array_elements(current_state->'scenarios') r(value) group by r.value->>'teamId',r.value->>'mode' having count(*)>1) then raise exception 'Duplicate live scenario identities'; end if;
  if current_state->'ownerDraft' is not null and current_state->'ownerDraft'<>'null'::jsonb then
    if jsonb_array_length(current_state->'scenarios')<>16 or exists(select 1 from jsonb_array_elements(current_state->'scenarios') r(value)
      where coalesce(r.value->>'teamId','') !~ '^[1-8]$' or coalesce(r.value->>'mode','') not in ('post_draft','redraft')) then raise exception 'All sixteen unique live scenarios are required'; end if;
  end if;
  for scenario in select value from jsonb_array_elements(current_state->'scenarios') loop
    if jsonb_typeof(scenario->'lineups') is distinct from 'array' or jsonb_typeof(scenario->'decisions') is distinct from 'array' then raise exception 'Missing live scenario receipts'; end if;
    if exists(select 1 from jsonb_array_elements(scenario->'lineups') r(value) group by r.value->>'date' having count(*)>1)
      or exists(select 1 from jsonb_array_elements(scenario->'decisions') r(value) group by r.value->>'id' having count(*)>1) then raise exception 'Duplicate live scenario receipts'; end if;
    select value into old_scenario from jsonb_array_elements(coalesce(previous->'scenarios','[]'::jsonb)) where value->>'teamId'=scenario->>'teamId' and value->>'mode'=scenario->>'mode';
    for item in select value from jsonb_array_elements(scenario->'lineups') loop
      select value into lock_row from jsonb_array_elements(current_state->'locks') where value->>'date'=item->>'date';
      if lock_row is null then raise exception 'Every live lineup requires a source lock'; end if;
      if exists(select 1 from jsonb_array_elements(coalesce(previous->'locks','[]'::jsonb)) where value->>'date'=item->>'date')
        and not exists(select 1 from jsonb_array_elements(coalesce(old_scenario->'lineups','[]'::jsonb)) where value=item) then raise exception 'Cannot append a lineup to a previously saved lock'; end if;
    end loop;
    for item in select value from jsonb_array_elements(scenario->'decisions') loop
      if exists(select 1 from jsonb_array_elements(coalesce(previous->'locks','[]'::jsonb)) where value->>'date'=item->>'date')
        and not exists(select 1 from jsonb_array_elements(coalesce(old_scenario->'decisions','[]'::jsonb)) where value=item) then raise exception 'Cannot append a decision to a previously saved lock'; end if;
      if item->>'kind' in ('draft','initial_drop') and previous->'ownerDraft' is not null and previous->'ownerDraft'<>'null'::jsonb
        and not exists(select 1 from jsonb_array_elements(coalesce(old_scenario->'decisions','[]'::jsonb)) where value=item) then raise exception 'Live initial draft decisions are immutable'; end if;
    end loop;
  end loop;
  for previous_row in select value from jsonb_array_elements(coalesce(previous->'locks','[]'::jsonb)) loop
    select value into matched from jsonb_array_elements(current_state->'locks') where value->>'date'=previous_row->>'date';
    if matched is distinct from previous_row then raise exception 'Saved live decision sources are immutable'; end if;
  end loop;
  if previous->'ownerDraft' is not null and previous->'ownerDraft'<>'null'::jsonb then
    if current_state->'ownerDraft' is distinct from previous->'ownerDraft'
      or current_state->'draftCapturedAt' is distinct from previous->'draftCapturedAt'
      or current_state->'initialPlayers' is distinct from previous->'initialPlayers'
      or current_state->'forecastAsOf' is distinct from previous->'forecastAsOf' then raise exception 'Live starting draft evidence is immutable'; end if;
  end if;
  for old_scenario in select value from jsonb_array_elements(coalesce(previous->'scenarios','[]'::jsonb)) loop
    select value into scenario from jsonb_array_elements(current_state->'scenarios')
      where value->>'teamId'=old_scenario->>'teamId' and value->>'mode'=old_scenario->>'mode';
    if scenario is null then raise exception 'A saved live scenario cannot be removed'; end if;
    foreach field in array array['lineups','decisions'] loop
      for item in select value from jsonb_array_elements(coalesce(old_scenario->field,'[]'::jsonb)) loop
        select value into matched from jsonb_array_elements(scenario->field)
          where case when field='lineups' then value->>'date'=item->>'date' else value->>'id'=item->>'id' end;
        if matched is distinct from item then raise exception 'Saved live decision receipts are immutable'; end if;
      end loop;
    end loop;
  end loop;
  for lock_row in select value from jsonb_array_elements(current_state->'locks') loop
    if exists(select 1 from jsonb_array_elements(coalesce(previous->'locks','[]'::jsonb)) where value->>'date'=lock_row->>'date') then continue; end if;
    receipt := clock_timestamp();
    if lock_row->>'date' is null or lock_row->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
      or (lock_row->>'capturedAt')::timestamptz is null or (lock_row->>'startsAt')::timestamptz is null
      or not isfinite((lock_row->>'startsAt')::timestamptz)
      or (lock_row->>'capturedAt')::timestamptz>receipt then raise exception 'Invalid dated live source receipt'; end if;
    if coalesce((lock_row->>'empty')::boolean,false) is not true then
      if receipt>=(lock_row->>'startsAt')::timestamptz or (lock_row->>'capturedAt')::timestamptz>=(lock_row->>'startsAt')::timestamptz then
        raise exception 'The live decision missed first tipoff; preserve the gap instead' using errcode='40001';
      end if;
    end if;
    for scenario in select value from jsonb_array_elements(current_state->'scenarios') loop
      select value into item from jsonb_array_elements(scenario->'lineups') where value->>'date'=lock_row->>'date';
      if item is null or (item->>'decidedAt')::timestamptz is null or (item->>'decidedAt')::timestamptz>receipt
        or (item->>'decidedAt')::timestamptz<(lock_row->>'capturedAt')::timestamptz then raise exception 'Live lineup receipt is missing or invalid'; end if;
      if coalesce((lock_row->>'empty')::boolean,false) then
        if jsonb_typeof(item->'slots') is distinct from 'array' or jsonb_array_length(item->'slots')<>0 then raise exception 'An empty NBA day cannot contain a lineup'; end if;
      elsif (item->>'decidedAt')::timestamptz>=(lock_row->>'startsAt')::timestamptz then raise exception 'Live lineup was decided after first tipoff'; end if;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function private.protect_ai_live_decisions() from public,anon,authenticated;
create trigger ai_live_decision_receipt before insert or update on public.ai_league_runs
  for each row execute function private.protect_ai_live_decisions();
