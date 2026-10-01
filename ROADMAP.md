# Croc Bois delivery roadmap

Updated October 1, 2026.

The first release should let every manager sign in, review keeper eligibility, submit a private keeper list, and receive commissioner approval. The next release should carry the league through trades, the lottery, draft-position choices, and draft day. ESPN continues to handle matchups and in-game roster execution.

## Release status

Repository publication, Supabase provisioning, Google OAuth configuration, and Vercel deployment are pending production verification. The completed items below describe application code and local verification; cloud connection and live account access are a separate release milestone.

## Implemented

| Area | What exists now | Current boundary |
| --- | --- | --- |
| Public league portal | Responsive dashboard, teams, searchable player costs, pick inventory, historical draft boards, trade archive, charter summary, and keeper-cost audit. | New trade records are not yet connected to the public ledger. |
| Keeper planning | Owner-selected player-to-pick assignments, eligibility explanations, duplicate-pick protection, and payment validation. | Signed-out visitors can experiment locally. Official writes require a connected league and an authorized account. |
| Private keeper workflow | Save/reload drafts; submit; commissioner approve or return with a note; lock; reveal all teams together. Status, revisions, and stale-write protection are connected to the API. | Account assignments, live services, and final data review must be completed before league use. |
| Commissioner season opening | Review note and authenticated control to open keeper selection. | Deadline administration and a complete team-by-team readiness overview still need work. |
| Draft display | Upcoming pick ownership, published snake order, revealed keeper assignments, and 2018–2025 draft archives. | No interface yet to conduct the lottery, choose positions, or record ordinary draft selections. Other viewers do not yet receive automatic updates. |
| Authentication and permissions | Google OAuth routes, session handling, sign-out, current manager assignments, commissioner permissions, and database access policies. | Live Google sign-in and onboarding require configuration and verification. No manager-assignment administration screen yet. |
| Keeper data review | Authenticated API to correct a keeper profile and record an explanation. | The commissioner queue displays issues but has no correction form yet. |
| Trade backend | APIs to create multi-team player/pick trades, finalize transfers together, and resolve obligations. Ownership checks and the 24-hour review period are enforced. | No composer, review controls, veto workflow, or obligation-resolution interface. Post-lock keeper payment changes are not implemented. |
| Rule calculations | Keeper lifecycle, nominal cost independent of payment, pick allocation, snake ordering, and an eight-team lottery calculation preserving the supplied probability table. | Lottery execution is a calculation library, not a saved league operation or stream-ready screen. Expansion needs an approved configuration. |
| Migration and audit | Eight franchises, 111 roster players, 104 upcoming picks, eight historical draft boards, and 93 historical trade records, including voided records. Cost comparisons retain source evidence and discrepancies. | Displaying history does not certify a complete replay of every past transfer, loan, or keeper rule. |
| Mobile/PWA foundation | Responsive navigation, web app manifest, app icons, and installation metadata. | Offline mode and push notifications are outside the initial requirement. |

Local checks cover domain calculations, database workflows, build/type checks, and desktop/mobile interactions. Authenticated browser interactions have also been exercised with mocked API responses. These checks do not substitute for real Google sign-in and production database testing.

## P0 — before the keeper deadline

### Frontend and visual workflows

- Add manager onboarding and commissioner team-assignment controls, including co-managers. Managers should immediately see which franchise they can manage.
- Add a commissioner form for keeper-cost, tenure, and eligibility corrections using the existing keeper-profile API. Show the original value, proposed change, and required explanation.
- Add a season overview listing every participating franchise, including teams that have not saved or submitted anything. Show the deadline, submission state, review state, and lock state without revealing private selections to other owners.
- Finish the connected-account experience: clear loading/errors, accurate season-phase copy, and a practical mobile walkthrough from Google sign-in to submitted keepers.

### Backend, data, and release work

- Publish the public repository and deploy the application. Provision Supabase, apply migrations and reviewed bootstrap data, configure Google OAuth and production redirects, and connect the Vercel environment.
- Add authorized operations behind onboarding and team assignment. The underlying membership and dated manager-assignment records already exist.
- Reconcile current roster ownership, pick ownership, inferred tenure, and remaining provisional keeper profiles. Preserve the frozen end-of-season roster as the eligibility baseline.
- Store and display the keeper deadline and draft date/time. Keep commissioner locking explicit; the agreed workflow allows edits until the commissioner locks a submission.
- Verify actual account permissions and the complete workflow against the deployed database: assigned manager, co-manager, other owner, commissioner, and anonymous visitor. Verify that selections remain private until the final team is locked.

**Acceptance:** every manager can use their own account to save and submit a valid keeper list, including an empty list if desired. The commissioner can resolve data questions, see missing submissions, approve or return selections, and lock all teams. The final lock publishes keeper assignments on the draft board without exposing selections early.

## P1 — before the lottery and draft

### Frontend and visual workflows

- Build the trade composer with multiple participants, available players, specific current/future picks, and written conditions. Show exactly which assets move to each franchise before logging a trade.
- Connect a live trade ledger and review queue. Add the 24-hour review state, commissioner finalization, agreed veto controls, and visible outstanding obligations. Keep historical and live records distinguishable.
- Add commissioner resolution controls for loans, options, and other conditions using the existing obligation-resolution API.
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
- Complete the searchable historical archive, including the full charter and historical rule versions alongside the current rules summary.
- Add an ESPN import review screen with last-sync status, proposed changes, conflicts, and commissioner resolution.
- Add season rollover and expansion administration, including manager changes, participating teams, and future pick inventories.
- Consider offline viewing or push notifications only if the league later requests them.

### Backend and data work

- Schedule periodic ESPN imports with stable external IDs, repeatable imports, visible failures, and reconciliation. Current imported roster data is not a running ESPN synchronization service.
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
