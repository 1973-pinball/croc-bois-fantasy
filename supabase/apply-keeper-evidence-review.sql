-- Fresh installations: run once after the source-preserving seed and all migrations.
-- Existing installations apply these through migrations 00008 and 00009.
-- Reruns preserve matching commissioner confirmations and are idempotent.
-- Requires the database migration owner; no browser or service-role grants are added.
begin;
select private.apply_keeper_evidence_review_20261001();
select private.apply_undrafted_keeper_rule_20261003();
commit;
