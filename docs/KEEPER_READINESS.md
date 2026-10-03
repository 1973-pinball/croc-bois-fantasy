# Keeper release readiness

This release prepares the commissioner workflow before the remaining managers join. It does not open the season automatically or set dates that the league has not decided.

Released to production on October 1, 2026: migrations 00007–00008 and the matching Vercel app. The database comparison verified 64 confirmed, 36 provisional and 11 ineligible profiles, with unchanged costs, tenures, roster ownership and pick records. The eleven confirmations each have an audit event. The live season remains in `setup`; dates are unset and keepers remain unrevealed.

The October 3 follow-up applied migration 00009 and published the established-rule audit/import updates. All 36 matching undrafted profiles are confirmed: six existing commissioner decisions were preserved and 30 remaining profiles received audited confirmations. Current totals are **100 confirmed, 11 ineligible and zero items to reconcile**. The season remains in setup with unchanged numeric costs, tenure and ownership. Commissioner profile review is verified by the six real saved decisions; remaining authenticated workflow checks are listed below.

Migration 00011 removes the setup-phase private-save blocker. Every assigned owner and co-manager can save and reload their team's private draft during setup; commissioners retain their existing team-review access. Unassigned and anonymous users receive no team-edit rights. Saving does not submit, reserve picks, open trading, or reveal selections. Official submission, approval and locking still require the commissioner to open keeper selection. See the roadmap for deployment verification.

## Commissioner preparation

1. Apply the additive database migrations before deploying the matching app. Never replay the bootstrap seed over the existing league. For a fresh installation only, apply all migrations, run `supabase/seed.sql` once, then run `supabase/apply-keeper-evidence-review.sql` to apply the same reviewed historical confirmations as an existing deployment.
2. Open **Commissioner Tools → Every team, every step.** The overview includes all season participants, even teams without saved submissions. Check the frozen snapshot, original pick inventory, account coverage and profile review counts. A team holding 11 or 14 picks can be correct after trades; counts alone do not establish missing assets.
3. The current keeper-profile reconciliation is complete. Use source evidence and the commissioner review form if new discrepancies arise. The public reason should explain league evidence, not private account information. Keep nominal cost separate from the pick actually paid.
4. In **Manage keeper deadline & draft schedule**, enter wall-clock times in the displayed league time zone and a change reason. Blank dates remain explicitly unscheduled. Daylight-saving gaps and ambiguous repeated times are rejected. Schedule changes use revision checks and an audit event.
5. Managers may save private drafts during setup. When ready for official submissions, record the season-opening review note and explicitly open keeper selection. Managers can then submit those drafts. A scheduled deadline does not automatically lock any team.

## Manager walkthrough

1. Sign in with Google and request the correct franchise in **My Team**. Wait for commissioner approval; sign-in alone grants no team rights.
2. After approval, **My Team** opens the assigned roster. Cost, tenure and eligibility remain visible in compact rows; **Details** expands the supporting explanation. **Team access & account** expands account-management controls. Profiles awaiting verification cannot be submitted.
3. Select players and choose owned payment picks. An empty keeper list is valid.
4. Choose **Save private draft**. Saving and reloading work during setup. **Submit for review** becomes available when keeper selection is opened; saving alone does not submit anything.
5. If a co-manager changes the saved draft, the editor preserves local choices but blocks saving/submitting until the saved draft is explicitly loaded. It must never send stale choices with a newer background revision.
6. The commissioner approves or returns the list with a note. Managers may revise it until it is explicitly locked; revisions require another review. Only the final team lock reveals everyone together.

## Validation before invitations

Local domain/database tests cover the keeper lifecycle, cost/payment distinction, stale revisions, access revocation, schedule validation, overview privacy, teams without submissions, empty keeper lists and all-team reveal. Browser checks with isolated mock APIs cover desktop/mobile conflict recovery, in-flight edits, empty submissions, schedule editing, timezone conversion and permission changes. They do not create real accounts or write production keeper selections.

The October 1 production smoke passed for the public homepage, expanded audit, league/history/pick APIs and schedule display. Anonymous season-readiness, keeper, trade, team-access and history-sync requests were rejected with HTTP 401. Desktop (1365px) and mobile (390px) checks found no horizontal overflow or browser runtime errors. This read-only smoke did not verify authenticated production actions.

The historical audit must distinguish applying an established rule from a genuinely missing fact. The first active undrafted season counts as tenure one; matching undrafted profiles do not need repeated individual approvals. The commissioner authorized the matching 36 confirmations on October 3, including Hart and Grimes after their history check. Original workbook disagreements remain evidence; they are not rewritten to manufacture an arithmetic match. See `data/keeper-readiness-audit.json` for the reviewed upcoming roster and resolutions.

## Remaining authenticated checks

Start with the existing commissioner account to verify the readiness overview and deployed administration controls. A small owner/co-manager pilot can cover the checks below before inviting the full league. Final-lock/reveal testing belongs in an isolated test season or database. Also run a true two-connection PostgreSQL test of queued writes racing with access revocation; the current local coverage does not reproduce two concurrent database connections.

- Complete Google onboarding with each real manager; verify the franchise assignment and a co-manager's shared access.
- Verify a different owner and an anonymous visitor cannot read private selections or review notes in the deployed database.
- Exercise save, reload, submit, return, approve and lock with real accounts, including an empty list and co-manager conflict.
- Verify revoked accounts lose their permissions and the final lock reveals all teams without early disclosure.

Do not mark these checks complete based only on mocked browser sessions or local PostgreSQL tests. Live draft entry/corrections, the persisted lottery, explicitly shared replay links and manual draft-order publication are implemented separately; see [the draft walkthrough](LIVE_DRAFT.md), [lottery guide](DRAFT_LOTTERY.md) and [current roadmap](../ROADMAP.md) for deployment status. Guided slot choices, veto governance, future-pick trading and roster/season rollover remain later work.
