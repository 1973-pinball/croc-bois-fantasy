# Delivery plan

## Parallel tracks now underway

| Track | Concrete deliverable | Acceptance |
| --- | --- | --- |
| Domain rules | Keeper rollover, owner-chosen pick allocation, snake boards, exact lottery, trade validation | Boundary cases, 8/10-team support, no duplicate assets, auditable lottery |
| Backend | Supabase migrations, RLS, Google OAuth, revisioned keeper APIs and atomic trade finalization | Cross-owner access denied, all-team reveal, stale revisions rejected, rollback on conflicts |
| Frontend | Responsive public dashboard, teams/costs, keeper planner, historical drafts, trade history and charter | Mobile navigation, real imported data, visible provisional values, explicit local-preview behavior |
| Migration/audit | Full workbook inventory and independent historical cost replay | Source cells, separate nominal cost/payment, mismatches retained, 2026 projections reproducible |
| Integration | Repository, CI, cloud setup, database bootstrap and deployment | Build/type checks and meaningful rule/database tests pass; secrets/raw account data excluded |

## First usable release

Public roster and keeper-cost review, Google sign-in with commissioner-assigned memberships, private owner submissions, commissioner approve/lock, all-team reveal and upcoming pick board. Bring all eight franchises and co-managers on board. Two provisional free-agent cost rulings remain flagged until the commissioner verifies them.

## Before draft day

Trade logging and complex-obligation review; post-lock pick-reassignment workflow that does not change base cost; manual stream lottery with saved audit and separate position choices; live draft-board operations with correction history.

## Later migration and automation

Migrate every historical draft (2018–2025), retained keeper-point ledgers and historical owner attribution. Add periodic ESPN import staging and a commissioner reconciliation queue. Expansion adds season participants and a new approved lottery configuration without rewriting existing seasons.

## Commissioner decisions still needed before live operations

Keeper deadline and draft time/timezone; four-veto voting unit with co-managers and multi-team trades; draft-day exception to the 24-hour trade review; current status of legacy keeper points/obligations; expansion's lottery odds and initial player-allocation policy when expansion actually occurs. These do not block building the initial portal.

## Historical audit policy

The workbook and older charters are evidence. The commissioner's explicit later clarifications take precedence for the upcoming season. Differences between corrected formulas and what historically happened are reported, not silently normalized. Pending data is never presented as independently verified.
