-- Fresh installations: run once after the source-preserving seed and all migrations.
-- Existing installations apply these through migrations 00008 and 00009.
-- Reruns preserve matching commissioner confirmations and are idempotent.
-- Requires the database migration owner; no browser or service-role grants are added.
begin;
select private.apply_keeper_evidence_review_20261001();
select private.apply_undrafted_keeper_rule_20261003();
-- Apply the later charter version only after historical evidence reconciliations.
do $$ begin
  if to_regprocedure('private.apply_keeper_deadline_payment_rule_20261014()') is not null then
    perform private.apply_keeper_deadline_payment_rule_20261014();
  end if;
end $$;
commit;
