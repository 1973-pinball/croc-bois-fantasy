# Croc Bois delivery roadmap

Updated October 3, 2026.

The first release should let every manager sign in, review keeper eligibility, submit a private keeper list, and receive commissioner approval. The next release should carry the league through trades, the lottery, draft-position choices, and draft day. ESPN continues to handle matchups and in-game roster execution.

## Release status

The [public app](https://croc-bois-fantasy.vercel.app) is deployed on Vercel, and the [repository](https://github.com/1973-pinball/croc-bois-fantasy) is public. Supabase is provisioned with the applied league migrations, eight franchises, 111 frozen roster entries/profiles, and 104 picks. Production checks verified the homepage, audit page, manifest, connected league API, the Google sign-in release gate, and anonymous rejection by the private keeper/trade APIs. Local domain/database checks and GitHub CI validate releases.

Google is enabled in Supabase and the production app environment. Preview sign-in remains disabled. The team onboarding workflow is implemented, and the season remains in `setup`. The initial Google sign-in, commissioner setup and team approval have succeeded. The commissioner sent the manager sign-up link on October 3; owner onboarding is now underway. Approve each franchise-access request and verify private saving with the incoming owners/co-managers before opening official submissions.

The keeper-readiness release is deployed: the all-team commissioner overview, explicit deadline/draft scheduling, co-manager edit conflict protection, authorization rechecks after queued revocations, and Node 22-compatible history maintenance. Migrations 00007–00008 shipped October 1. Migration 00009 and the matching [October 3 app deployment](https://vercel.com/studiopinball/croc-bois-fantasy/FVg3HTEyfNAfWvNL7zyKss9zxFty) complete the established undrafted rule application. Production now has **100 confirmed, 11 ineligible, zero provisional profiles and zero items to reconcile**. Thirty new audited confirmations preserved six existing commissioner confirmations and all costs, tenure values, roster and pick ownership.

The [October 3 League Lab/draft release](https://vercel.com/studiopinball/croc-bois-fantasy/7e5XmzdW1w8d6eJBcYnPhXycxg9z) is also deployed with migration 00010. Production checks verified both preference tabs, the 1,095-player catalog, 104 blank draft spaces, unchanged keeper reconciliation, anonymous write rejection, and desktop/mobile layouts. The season remains in setup, with no assigned order, keeper reveal or live selections. See [League Lab methodology](docs/LEAGUE_LAB.md) and [the draft walkthrough](docs/LIVE_DRAFT.md).

The [private-save and roster follow-up](https://vercel.com/studiopinball/croc-bois-fantasy/4E6oykBDpB4vzhHCfPYArogfaYcj) adds migration 00011, private saving during setup, compact roster details, draft eligibility filters and 10/25-row Lab pagination. All 163 tests, type checking, the production build and public desktop/mobile checks passed. Setup and all existing costs/ownership remain unchanged.

The [lottery and Commissioner Tools release](https://vercel.com/studiopinball/croc-bois-fantasy/7oyMQNXkEUfbpL5fMUcFdnkYMXJT) is deployed with migration 00012. It includes the verified ESPN manager list, the original weighted lottery method, a 32-second ball reveal, disabled commissioner navigation for other accounts, read-only public draft slots, both requested headings, and compact pick/keeper pools. All 177 tests, type checking, production build and browser checks passed. The commissioner's subsequent practice draw and order marked “testing” were cleared at their request on October 3 at 17:09 UTC. There are no saved draws, test-result events, shared replays or assigned slots. The official drawing has not happened; the season remains in setup with no keeper reveal or live selections.

The [presentation follow-up](https://vercel.com/studiopinball/croc-bois-fantasy/BwrHMAVoqrEqHptGGpv2Wf5C1qtq) is deployed: the desktop overview hero is 68px tall (about 20% of its previous height), and the lottery uses a charcoal stage, red/blue balls, confetti and no countdown. Replay animation repeats the saved result without another draw. Read-only production desktop/mobile checks passed.

The [sharing and draft-order follow-up](https://vercel.com/studiopinball/croc-bois-fantasy/3osKmoagPFYnG9TvyBX8L9gbExsy) is deployed with migration 00013. Share Lottery Results copies a standalone replay link; lottery-prefilled draft slots stay editable until explicitly published. Standings are 51–59% shorter, and light team colors match slot headings, the team key and current-owner pick cells. All 184 tests and the production build passed. Live checks verified empty test state, private permissions, unavailable-link handling, and desktop/mobile replay presentation using browser-only fixtures with no production mutations.

The [ESPN draft-roster and heading release](https://vercel.com/studiopinball/croc-bois-fantasy/CGTNUhyKS697pm5LYkpCc7cmahhg) is deployed October 3. Draft rosters shows each team's public picks and keepers fitted to the programmatically verified ESPN lineup: 13 regular slots plus separate IR. All 1,095 player eligibilities and 111 frozen roster identities are covered; no ownership or ESPN lineup writes occur. Main app/audit page headings now share responsive typography. All 206 tests, type checking, production build and public desktop/mobile checks passed, including exact slot counts for all eight teams and matching computed heading styles.

## Current delivery checklist

Update this checklist as each implementation, verification or deployment finishes. A local test pass does not mark a production release or real-account check complete.

- [x] Fix co-manager draft overwrite, queued keeper writes after revocation, and Node 22 history maintenance.
- [x] Add every-team readiness, explicit schedule administration, phase copy and mobile layouts.
- [x] Audit all 111 current keeper profiles and compare all 111 roster owners and 104 pick identities/owners with the reviewed baseline.
- [x] Prepare guarded, audited confirmations for eleven source-supported tenures; preserve historical discrepancies and the other 36 provisional profiles.
- [x] Pass 131 tests, type checking, production build and isolated desktop/mobile browser checks; verify the history CLI on Node 22.14.
- [x] Apply migrations 00007–00008. A pre-migration snapshot and post-migration comparison verified eleven verification-only confirmations, unchanged costs/tenures and unchanged roster/pick ownership.
- [x] Deploy the matching app. Vercel's production build passed and the public alias points to the keeper-readiness release.
- [x] Verify the October 1 schedule fields, anonymous readiness/private-route rejection, expanded audit page and desktop/mobile layouts. That release had 64 eligible, 36 awaiting review and 11 ineligible; October 3 resolved the remaining profiles below. Read-only production smoke passed without browser errors or horizontal overflow. Authenticated production checks remain below.
- [x] Record that the initial undrafted season counts as tenure one under the established rule. The commissioner authorized all matching cost confirmations, including Hart/Grimes after their matching history was checked.
- [x] Apply migration 00009 and publish the matching audit/import updates. Verified 30 new audit events, all six existing commissioner confirmations preserved, 100 confirmed / 11 ineligible, and zero live items to reconcile. Tests, type checking and production build passed.
- [x] Replace incomplete keeper classifications with Players/all appearances and add Category Preferences across nine verified seasons. Desktop/mobile, filters, counts and category standings reconciliation passed.
- [x] Implement and apply migration 00010 for the live draft board, 1,095-player catalog, audited order/selection/correction/removal, five-second refresh and revision protection. All 158 tests and type checking passed. Snapshot comparison verified unchanged profiles, roster ownership, picks and existing season settings; order remains unset, revision zero and no selections recorded.
- [x] Guard player transfers after keeper reveal until roster finalization exists, and invalidate draft choices after pick-owner transfers. Regression checks cover queued player trades, used picks, future-season revision scope and unchanged obligation-only behavior.
- [x] Deploy the matching app and pass public desktop/mobile smoke checks for League Lab and the draft board. Production build passed; anonymous draft writes return 401. No runtime errors or viewport overflow, and no league actions were performed by the browser checks.
- [x] Add an eligible/ineligible keeper filter to both draft-pool controls, and compact My Team / Teams & players. Local desktop roster views fit 13–14 rows instead of eight; mobile fits eleven instead of six, with full explanations under accessible Details controls. Remove the requested sidebar promotional text.
- [x] Add pagination to League Lab's Players tab: all 526 player/franchise pairs are reachable, with 10/25 rows per page, full-list search/year/franchise filters and retained appearance receipts. Desktop/mobile and keyboard checks passed.
- [x] Remove the setup-phase private-save blocker for every assigned owner/co-manager. Migration 00011 is applied and the matching app is deployed. Official submission remains gated by explicit season opening; privacy, ownership, frozen-roster and revision controls passed 163 tests plus mocked owner/co-manager browser checks. Snapshot comparison verified unchanged league data and season settings.
- [x] Complete public production smoke checks for the private-save/roster/filter/pagination follow-up: real eligibility filters, all 526 paginated pairings, expanded reasons, mobile layout and removed sidebar text verified with zero errors or browser writes.
- [x] Limit the draft pool to the top 200 matching players by default while keeping full-catalog search. The [display adjustment](https://vercel.com/studiopinball/croc-bois-fantasy/DugHhiLf26x7mDiSKmyi1Q7nx623) is deployed: production checks found ranked and unranked players beyond 200, retained combined filters/off-board protection, and confirmed mobile fit without errors or writes.
- [x] Implement the saved draft-slot choice lottery and apply migration 00012. Verified regular-season standings, current manager labels, original Python source, secure server randomness, an immutable result and eight replayable steps are available. All 177 tests and type checking pass. Migration comparison verified unchanged season, all eight slots, keeper profiles, roster/pick ownership and live selections. Production has zero runs, zero lottery audit events and no assigned order; the matching app release remains below.
- [x] Locate the commissioner's original Python notebook and reconcile the lottery method with the October 3 clarification: first-choice weights are 24% per non-playoff team and 1% per playoff team; subsequent choices use the remaining weighted pool. Derived top-four odds are 92.6372% per non-playoff team and 28.0416% for at least one playoff team. Original notebook remains unchanged. The implementation follows this method, independently checked against all 40,320 complete orders.
- [x] Make Manage draft order visible to everyone as a read-only slot list; keep edit/save controls and server authorization commissioner-only. Public production checks verified eight unassigned slots and no editing form.
- [x] Publish the requested headings: “Your keeper gameplan.” and “Every saint has a past. Every sinner has a future.” Both are verified in production.
- [x] Pull ESPN's 2026 regular-season standings and 2027 owners directly and verify all eight W–L–T records against the supplied screenshot. Confirm last-to-first inputs: Wyndham, Sebastian, Shane, Alex, Jon, Arod, Amber, James. Preserve postseason finishes separately and verify Sebastian's new team name, The ManyFacedBron.
- [x] Add and deploy the saved-result lottery-ball presentation: reveals at 10, 17, 22, 24, 26, 28, 30 and 32 seconds, with reduced-motion support, skip and no reroll on refresh. Mocked browser checks verified every boundary, one POST, lost-response recovery and private-result clearing on role loss.
- [x] Rename the navigation to Commissioner Tools and place it directly above Keeper cost audit. Per the latest instruction, disable it for non-commissioners and show a grey hover/focus state with “get out of here james”. Guard navigation and remove the view on role loss. Production desktop/mobile and keyboard checks passed.
- [x] Compact the 2026 draft capital pick inventory while preserving all rounds, original-owner and trade information. Panel height is 51–55% smaller; production checks verified the 13 rounds and mobile fit.
- [x] Compact the Keeper planner's keeper pool while retaining visible cost/tenure/eligibility, selection and payment-pick controls, with longer reasons under expandable details. Deployed 49px rows with 44px selection targets; local checks verified dropdown options, keyboard details and unchanged private-save validation.
- [x] Deploy the matching lottery/Commissioner Tools app and complete read-only production smoke checks. Verified actual API input order/weights and no saved draw, disabled navigation, public draft slots, headings and compact inventory with no runtime errors or browser writes. Leave the official Run Lottery button for the commissioner to press.
- [x] Shrink the overview hero to approximately 20% of its former desktop height, preserving a readable headline, 44px planner button and small mascot. Deployed and verified at 68px desktop and 123–127px mobile.
- [x] Deploy charcoal/red-and-blue lottery presentation with confetti, no countdown, and a Replay animation control that never creates a new draw.
- [x] Clear the commissioner-authorized test lottery and published test order, including their saved result history. Completed October 3 at 17:09 UTC: zero runs/result-bearing test events, eight unassigned slots, restored immutability triggers and unchanged keeper/ownership/season records. No official drawing has happened.
- [x] Deploy lottery-prefilled Manage draft order: editable local suggestion, existing published order takes precedence, explicit Publish draft order required. Local privacy, stale-revision, connection-loss and mobile checks passed.
- [x] Deploy compressed lottery standings and stable light franchise colors on draft slots, team key and current-owner pick cells. Table height is 51–59% smaller; color/traded-pick checks passed.
- [x] Add Share Lottery Results: an explicit commissioner action creates a read-only replay link and copies it to the clipboard. Migration 00013 and the matching app are deployed. The standalone page contains only the animation and results; draft order publication stays separate.
- [x] Add and deploy live drafted-team rosters using programmatically verified ESPN slot counts and player eligibility. Fresh October 3 ESPN 2027 settings confirm PG, SG, SF, PF, C, G and F once each, UTIL three times and BENCH three times (13 regular spots), plus one separate IR slot. Each team's public keepers and drafted players, occupied/open slots, counts and fit warnings update with the board. This display does not finalize ownership or write lineups to ESPN. Domain matching, private-keeper suppression, correction/undo, owner changes and desktop/mobile checks passed; all eight public team views verified in production.
- [x] Standardize and deploy all main application and keeper-audit page headings to the shared responsive typography, removing per-page font-size overrides. Matching font family, weight, size and line height verified on desktop/mobile. Smaller section headings and the compact replay presentation remain distinct.
- [ ] Set actual deadline/draft dates when decided. Leaving them unset does not block deploying the controls.
- [x] Send the manager sign-up link. The commissioner confirmed invitations were sent October 3; account completion and franchise approvals remain below.
- [ ] Complete real manager/co-manager onboarding and private-workflow checks before opening official keeper submissions.

Use the first incoming owner/co-manager accounts to verify onboarding, cross-team privacy, shared editing and revocation before opening official submissions; each manager assignment still needs checking. Invitations have been sent, but this does not mark the account checks complete. The queued-revocation fix has local coverage, but a true two-connection PostgreSQL concurrency test remains to be run in an isolated environment. Later feature development does not depend on manager registration.

**Current release:** Keeper reconciliation, League Lab and live draft-board improvements are deployed and verified. Players now uses all appearances; Category Preferences uses verified position snapshots and category results. The board includes blank owners until order is set, ESPN category rankings, purple revealed keepers, unavailable-player indicators, and audited commissioner entry/corrections with automatic refresh.

**Next launch step:** approve incoming manager access requests, verify the commissioner's readiness overview, and complete the real owner/co-manager checks using the first approved accounts. Owners can save private plans during setup. Enter dates when decided, then explicitly open keeper selection for official submissions. Final-lock/reveal tests must use an isolated test season or database rather than locking the live league merely for testing. Lottery and later trade features do not block onboarding.

## Implemented

| Area | What exists now | Current boundary |
| --- | --- | --- |
| Public league portal | Responsive dashboard, teams, searchable player costs, pick inventory, historical draft boards, trade archive, charter summary, and keeper-cost audit. | New trade records are not yet connected to the public ledger. |
| League Lab and history highlights | Original-pick heatmap and first-pick award filters, wins/trades scatterplot, years active and trophy podiums. Players counts all appearances without incomplete keeper classifications. Category Preferences shows average position composition and nine-category records across nine verified ESPN seasons (2018–2026). Championship/Luckbox totals have daily refresh and commissioner sync controls. | Position averages use captured end-of-season rosters, not daily averages. Category preferences and the draft catalog are dated artifacts with an explicit rebuild process. Wins/trades correlation retains its labeled workbook window. |
| Keeper planning | Owner-selected player-to-pick assignments, eligibility explanations, duplicate-pick protection, and payment validation. | Signed-out visitors can experiment locally. Official writes require a connected league and an authorized account. |
| Private keeper workflow | Save/reload drafts; submit; commissioner approve or return with a note; lock; reveal all teams together. Status, revisions, and stale-write protection are connected to the API. | Keeper data and live services are ready. Remaining owner/co-manager assignments and real-account workflow checks must be completed before official submissions. |
| Commissioner season readiness | Deployed all-team overview including missing submissions, onboarding/profile review counts, original pick completeness, audited deadline/draft schedule with timezone and revision checks, and explicit season opening. | Actual dates and real-account workflow verification remain. Deadlines never automatically lock submissions. |
| Draft board and display | Live grid above pick inventories; blank owners before order, ESPN category-ranked pool, keeper eligibility, purple keeper accents and disabled off-board players. Stable light colors follow pick owners and match slot headings/controls. Lottery-prefilled order remains editable until explicit publication; selection/correction/removal, traded-pick attribution and five-second refresh are implemented. | Guided position choices remain pending. Rankings are ESPN's supplied ROTO order, not custom projections. Correction history is stored but has no viewer yet. Future live inventories require setup; filling the board does not perform roster/season rollover. |
| Authentication and permissions | Google OAuth routes, private team-access requests, commissioner approval/rejection, primary/co-manager identity linking, dated access removal, My Team navigation, session refresh, and database access policies. | Initial Google sign-in and commissioner/team assignment are verified. Remaining owner onboarding and real keeper-workflow verification remain. |
| Keeper data review | Commissioner correction form with before/after audit, explanation and refreshed approval guards. All upcoming profiles reconciled: 100 confirmed, 11 ineligible, zero pending. | Newly discovered conflicting evidence remains reviewable; historical source discrepancies are preserved. Real-account workflow verification remains. |
| Trade workspace | Authenticated multi-team player/pick/obligation composer, review queue, commissioner finalization, and obligation-resolution controls. Ownership checks and the 24-hour review period are enforced by the server. | Current-season inventory only. Player trades pause after keeper reveal until a draft-roster finalization workflow exists; pick-only trades retain current controls. Vetoes, future-pick creation, public live ledger, and post-lock keeper payment changes remain pending. |
| Rule calculations and lottery | Keeper lifecycle, nominal cost independent of payment, pick allocation and snake ordering. The deployed eight-team lottery follows the commissioner's original weighted sampling without replacement, with verified ESPN inputs, source code, a timed ball reveal and replayable audit. Share Lottery Results explicitly publishes a standalone replay link; draft-slot publication is a separate commissioner action. | Guided slot choices remain future work. Expansion needs an approved configuration. The official production lottery has not happened; the practice result and test order were cleared. |
| Migration and audit | Eight franchises, 111 roster players, 104 upcoming picks, eight historical draft boards, and 93 historical trade records, including voided records. Cost comparisons retain source evidence and discrepancies. | Displaying history does not certify a complete replay of every past transfer, loan, or keeper rule. |
| Mobile/PWA foundation | Responsive navigation, web app manifest, app icons, and installation metadata. | Offline mode and push notifications are outside the initial requirement. |

Local checks cover domain calculations, database workflows, build/type checks, and desktop/mobile interactions. Authenticated browser interactions have also been exercised with mocked API responses. These checks do not substitute for real Google sign-in and production database testing.

## P0 — before the keeper deadline

### Frontend and visual workflows

- Complete live Google onboarding verification using the implemented request/approval screens, co-manager assignments and My Team landing page.
- Verify the deployed all-team readiness overview with the real commissioner account; confirm the dates when decided. Missing submissions and private review/lock state are visible to the commissioner without publishing selections.
- Complete the real-account mobile walkthrough from Google sign-in to submitted keepers. Loading/errors, phase copy and explicit co-manager conflict recovery are implemented and tested with mocked browser accounts.

### Backend, data, and release work

- Google OAuth provider and production activation are configured, and the first real account round trip succeeded. Repository publication, Supabase migrations/bootstrap data and Vercel environment setup are complete.
- The first verified commissioner is assigned. Complete remaining owners’ access requests and approval, and verify co-manager and revocation behavior with real accounts.
- Eleven source-supported keeper confirmations are applied in production through migration 00008. Migration 00009 applies the established undrafted rule to the remaining matching profiles while preserving manual confirmations. The reviewed 111 live roster owners and 104 pick identities/owners match the frozen bootstrap evidence. Preserve that frozen eligibility baseline and all original source discrepancies.
- Set the keeper deadline and draft date/time in the implemented schedule controls when decided. Keep commissioner locking explicit; the agreed workflow allows edits until the commissioner locks a submission.
- Verify actual account permissions and the complete workflow against the deployed database: assigned manager, co-manager, other owner, commissioner, and anonymous visitor. Verify that selections remain private until the final team is locked.

**Acceptance:** every manager can use their own account to save and submit a valid keeper list, including an empty list if desired. The commissioner can resolve data questions, see missing submissions, approve or return selections, and lock all teams. The final lock publishes keeper assignments on the draft board without exposing selections early.

## P1 — before the lottery and draft

### Frontend and visual workflows

- Extend the connected trade composer to future seasons once their pick inventories exist.
- Connect finalized live trades to public history and add the agreed veto controls. The authenticated review queue, 24-hour state, commissioner finalization, and obligation-resolution controls are implemented.
- The manually triggered lottery, verified inputs/code, timed presentation, saved result and explicit Share Lottery Results publication are deployed. The commissioner decides when to share the replay.
- Add the separate draft-position selection step: lottery priority determines who chooses next; it does not directly assign draft slots.
- Live selection, correction and removal controls are implemented with audit records. Add an audit-history viewer, ESPN drafting-on-behalf instructions and outstanding player-transfer tracking.
- Add commissioner keeper-payment reassignment for post-lock pick trades. Show the original and replacement payment while keeping the player's nominal cost unchanged.
- Live draft polling is implemented. Add equivalent controlled refresh for trade views and authorized private submission updates.

### Backend and data work

- Persisted lottery runs, production randomness/audit capture and authorized execution are implemented in migration 00012; migration 00013 adds explicit replay publication. Manual draft-order publication enforces unique positions and commissioner authority. Add guided draft-position choice APIs that enforce whose turn it is.
- Authenticated draft-selection, correction and removal operations are implemented with revision guards, immutable keeper picks and a separate selection ledger. Complete the real-account rehearsal in an isolated environment and retain the frozen eligibility baseline. Add draft-roster finalization before enabling player transfers after keeper reveal; the pre-draft ownership pool cannot authorize released or re-drafted players.
- Implement a transactional post-lock payment-reconciliation operation. The current backend deliberately rejects transfers of committed or used picks; adding a dropdown alone would not satisfy this requirement.
- Implement veto eligibility, counting, trade rejection/cancellation, and the agreed draft-day review exception. The current 24-hour timer alone is not a complete trade-governance workflow.
- Connect new trades to public history and team/player histories. The current public league response still carries the imported trade archive.
- Add future season/pick creation and trade-composer support without an arbitrary trade horizon. Retrieval/display of existing future pick inventories is implemented. New future picks still need stable identities and recorded ownership before they can be selected in a trade.
- Public draft refresh is implemented; extend controlled refresh to authorized private submission updates.

**Acceptance:** the commissioner can run and preserve a lottery on stream; owners choose positions in the resulting order; trades and keeper-payment adjustments update ownership and the board consistently; live selections and corrections are visible to the league. Every asset transfer and payment change has an attributable record.

## Later — full spreadsheet replacement and ongoing seasons

### Frontend and visual workflows

- Add player and franchise history pages linking draft origins, keeper cycles, trades, loans, and pick ownership changes.
- Supply comparable season-level trade totals for a cleaner correlation view. Automatic ESPN backfill is complete for 2018–2026 playoff results and category wins, including 2025 onward. The current correlation chart preserves the workbook's historical aggregate rather than inventing missing trade data.
- Complete the searchable historical archive, including the full charter and historical rule versions alongside the current rules summary.
- Add an ESPN import review screen with last-sync status, proposed changes, conflicts, and commissioner resolution.
- Add season rollover and expansion administration, including manager changes, participating teams, and future pick inventories.
- Consider offline viewing or push notifications only if the league later requests them.

### Backend and data work

- The daily historical-statistics sync is connected with stable external IDs, leases, snapshots and visible failures; all nine completed seasons are covered. Add a separate staged roster-sync/reconciliation workflow; statistics imports do not update rosters or keeper rights.
- Keep ESPN roster placement separate from league ownership, keeper rights, and trade obligations. A sync must not overwrite a frozen eligibility snapshot or bespoke league records.
- Reconcile remaining historical transfers, loans, keeper-point records, owner changes, and source inconsistencies before declaring the spreadsheet fully retired.
- Complete season rollover so finalized keeper tenure and nominal cost become the next season's baseline, while players returning to the draft begin a new cycle under the applicable rules.
- Support expansion through season-specific participants and an approved lottery matrix. Preserve existing eight-team seasons.
- Add routine database backup/export and a documented restoration procedure for the official league record.

## Commissioner decisions still needed

| Decision | Needed for |
| --- | --- |
| Keeper deadline and draft date/timezone | Season display, commissioner locking process, and draft-order release timing. |
| Whether vetoes count people or franchises, with co-managers and multi-team trades | Correct implementation of the charter's four-other-members veto rule. |
| Draft-day exception, if any, to the 24-hour trade review | Usable live trading during the draft. |
| Legacy obligations and any newly discovered conflicting evidence | Complete historical reconciliation. The reviewed upcoming undrafted profiles are covered by the established rule and October 3 authorization. |
| Expansion timing, initial player allocation, and lottery probabilities | Adding franchises without inventing league rules. |

## Historical audit policy

The workbook and older charters are evidence. Explicit later commissioner clarifications govern the upcoming season. Differences between corrected calculations and historical outcomes remain visible; migration does not silently rewrite what happened. Nominal keeper cost, actual pick payment, and inferred tenure remain distinguishable. An arithmetic match is not a certification of the entire historical ownership chain.

The `2026 Draft` workbook tab is the upcoming draft workspace; blank player inputs are expected until selections are entered. Keeper validation uses the confirmed rules, frozen roster, approved 2025 nominal-cost baseline and commissioner rulings. The upcoming tab does not add a historical-reconciliation task to this roadmap. This clarification was published to the audit page on October 2, 2026; the production build and live wording check passed, with all calculations and player records unchanged.
