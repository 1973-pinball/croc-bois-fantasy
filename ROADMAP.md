# Croc Bois delivery roadmap

Updated October 1, 2026.

The first release should let every manager sign in, review keeper eligibility, submit a private keeper list, and receive commissioner approval. The next release should carry the league through trades, the lottery, draft-position choices, and draft day. ESPN continues to handle matchups and in-game roster execution.

## Release status

The [public app](https://croc-bois-fantasy.vercel.app) is deployed on Vercel, and the [repository](https://github.com/1973-pinball/croc-bois-fantasy) is public. Supabase is provisioned with the applied league migrations, eight franchises, 111 frozen roster entries/profiles, and 104 picks. Production checks verified the homepage, audit page, manifest, connected league API, the Google sign-in release gate, and anonymous rejection by the private keeper/trade APIs. Local domain/database checks and GitHub CI validate releases.

Google is enabled in Supabase and the production app environment. Preview sign-in remains disabled. The team onboarding workflow is implemented, and the season remains in `setup`. The initial Google sign-in, commissioner setup and team approval have succeeded. Live keeper-workflow verification and remaining owner onboarding are still required before official submissions.

## Implemented

| Area | What exists now | Current boundary |
| --- | --- | --- |
| Public league portal | Responsive dashboard, teams, searchable player costs, pick inventory, historical draft boards, trade archive, charter summary, and keeper-cost audit. | New trade records are not yet connected to the public ledger. |
| League Lab and history highlights | Original-pick heatmap and first-pick award share filters; historical wins/trades scatterplot, player preferences, years active, and compact basketball trophy podiums. All nine completed seasons (2018–2026) have verified ESPN brackets and stored category wins, feeding championships and Luckbox. Daily refresh and commissioner sync controls are connected. | Historical wins/trades correlation retains its labeled workbook reporting window until comparable season-level trade counts are available. Unfinished seasons remain outside completed-season rankings. |
| Keeper planning | Owner-selected player-to-pick assignments, eligibility explanations, duplicate-pick protection, and payment validation. | Signed-out visitors can experiment locally. Official writes require a connected league and an authorized account. |
| Private keeper workflow | Save/reload drafts; submit; commissioner approve or return with a note; lock; reveal all teams together. Status, revisions, and stale-write protection are connected to the API. | Account assignments, live services, and final data review must be completed before league use. |
| Commissioner season opening | Review note and authenticated control to open keeper selection. | Deadline administration and a complete team-by-team readiness overview still need work. |
| Draft display | Current-owner pick grids with round counts and totals, all configured future seasons with transferred picks, a separate 2018–2025 historical-grid selector, published snake order, revealed keepers, and historical player boards. Team inventories show missing rounds and acquired origins. | No interface yet to conduct the lottery, choose positions, or record ordinary draft selections. Refresh is manual. The 2027 unchanged workbook grid is labeled reference data; future database inventories still require season setup. |
| Authentication and permissions | Google OAuth routes, private team-access requests, commissioner approval/rejection, primary/co-manager identity linking, dated access removal, My Team navigation, session refresh, and database access policies. | Initial Google sign-in and commissioner/team assignment are verified. Remaining owner onboarding and real keeper-workflow verification remain. |
| Keeper data review | Commissioner correction form for cost, tenure, and verification, with before/after values, required explanation, and refreshed approval guards. | Provisional and inferred history still needs commissioner review. Remaining managers can now be onboarded for live account testing. |
| Trade workspace | Authenticated multi-team player/pick/obligation composer, review queue, commissioner finalization, and obligation-resolution controls. Ownership checks and the 24-hour review period are enforced by the server. | Current-season inventory only. Vetoes, future-pick creation, public live ledger, and post-lock keeper payment changes remain pending. Google/account setup is required before official use. |
| Rule calculations | Keeper lifecycle, nominal cost independent of payment, pick allocation, snake ordering, and an eight-team lottery calculation preserving the supplied probability table. | Lottery execution is a calculation library, not a saved league operation or stream-ready screen. Expansion needs an approved configuration. |
| Migration and audit | Eight franchises, 111 roster players, 104 upcoming picks, eight historical draft boards, and 93 historical trade records, including voided records. Cost comparisons retain source evidence and discrepancies. | Displaying history does not certify a complete replay of every past transfer, loan, or keeper rule. |
| Mobile/PWA foundation | Responsive navigation, web app manifest, app icons, and installation metadata. | Offline mode and push notifications are outside the initial requirement. |

Local checks cover domain calculations, database workflows, build/type checks, and desktop/mobile interactions. Authenticated browser interactions have also been exercised with mocked API responses. These checks do not substitute for real Google sign-in and production database testing.

## P0 — before the keeper deadline

### Frontend and visual workflows

- Complete live Google onboarding verification using the implemented request/approval screens, co-manager assignments and My Team landing page.
- Add a season overview listing every participating franchise, including teams that have not saved or submitted anything. Show the deadline, submission state, review state, and lock state without revealing private selections to other owners.
- Finish the connected-account experience: clear loading/errors, accurate season-phase copy, and a practical mobile walkthrough from Google sign-in to submitted keepers.

### Backend, data, and release work

- Google OAuth provider and production activation are configured, and the first real account round trip succeeded. Repository publication, Supabase migrations/bootstrap data and Vercel environment setup are complete.
- The first verified commissioner is assigned. Complete remaining owners’ access requests and approval, and verify co-manager and revocation behavior with real accounts.
- Reconcile current roster ownership, pick ownership, inferred tenure, and remaining provisional keeper profiles. Preserve the frozen end-of-season roster as the eligibility baseline.
- Store and display the keeper deadline and draft date/time. Keep commissioner locking explicit; the agreed workflow allows edits until the commissioner locks a submission.
- Verify actual account permissions and the complete workflow against the deployed database: assigned manager, co-manager, other owner, commissioner, and anonymous visitor. Verify that selections remain private until the final team is locked.

**Acceptance:** every manager can use their own account to save and submit a valid keeper list, including an empty list if desired. The commissioner can resolve data questions, see missing submissions, approve or return selections, and lock all teams. The final lock publishes keeper assignments on the draft board without exposing selections early.

## P1 — before the lottery and draft

### Frontend and visual workflows

- Extend the connected trade composer to future seasons once their pick inventories exist.
- Connect finalized live trades to public history and add the agreed veto controls. The authenticated review queue, 24-hour state, commissioner finalization, and obligation-resolution controls are implemented.
- Build the manually triggered lottery presentation for streaming. Show the configured categories and probabilities, result, and saved run record.
- Add the separate draft-position selection step: lottery priority determines who chooses next; it does not directly assign draft slots.
- Add draft-day controls to record selections, show who drafts on behalf of whom in ESPN, track outstanding player transfers, and correct mistakes with a visible history.
- Add commissioner keeper-payment reassignment for post-lock pick trades. Show the original and replacement payment while keeping the player's nominal cost unchanged.
- Refresh draft and trade views when another owner or the commissioner changes a record. A board left open on stream should remain current.

### Backend and data work

- Add persisted lottery runs, production randomness/audit capture, authorized execution, and draft-position choice APIs. Enforce unique positions, choice order, and the agreed publication timing.
- Add authenticated draft-selection and correction operations. Historical import tables and the board display already exist; ordinary live draft writes do not.
- Implement a transactional post-lock payment-reconciliation operation. The current backend deliberately rejects transfers of committed or used picks; adding a dropdown alone would not satisfy this requirement.
- Implement veto eligibility, counting, trade rejection/cancellation, and the agreed draft-day review exception. The current 24-hour timer alone is not a complete trade-governance workflow.
- Connect new trades to public history and team/player histories. The current public league response still carries the imported trade archive.
- Add future season/pick creation and retrieval without an arbitrary trade horizon. Future picks need stable identities and recorded ownership before they can be selected in a trade.
- Add controlled refresh or subscriptions for public draft changes and authorized private submission updates.

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
| Remaining provisional cost/tenure rulings and legacy obligations | Final keeper eligibility and complete historical reconciliation. |
| Expansion timing, initial player allocation, and lottery probabilities | Adding franchises without inventing league rules. |

## Historical audit policy

The workbook and older charters are evidence. Explicit later commissioner clarifications govern the upcoming season. Differences between corrected calculations and historical outcomes remain visible; migration does not silently rewrite what happened. Nominal keeper cost, actual pick payment, and inferred tenure remain distinguishable. An arithmetic match is not a certification of the entire historical ownership chain.
