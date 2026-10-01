# Database and authentication setup

The public preview needs no cloud credentials. Accounts and mutation routes return an explicit 503 until Supabase is configured. A Google login creates an authenticated identity, not a league membership or commissioner role.

1. Create a Supabase project and apply the SQL files in `migrations/` in filename order, using the SQL editor or `supabase db push` after linking the project. This repository does not create or bill for a hosted project automatically.
2. In Google Auth Platform, create a Web application OAuth client. Add the app origin to JavaScript origins and the callback shown on Supabase's Google provider page to Google's redirect URIs (`https://PROJECT.supabase.co/auth/v1/callback`). Configure the client ID and secret in Supabase's Google provider. Keep the secret in that dashboard, not in browser variables or Git.
3. In Supabase Auth URL Configuration, set the production Site URL and add the exact app callback `https://YOUR_APP/auth/callback` to allowed redirects. Add `http://localhost:3000/auth/callback` for local work. Each authorized preview domain needs its own allowed callback.
4. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_SITE_URL` in local environment/Vercel. The app uses no service-role key. These three values are public configuration; Google secrets remain server-side in Supabase.
5. Import reviewed league records using a trusted migration/import process. Insert snapshot headers with `frozen_at = null`, insert all entries, then set `frozen_at` once. Seed `player_ownerships` from the confirmed bootstrap state. Never replay historical transfers on top of that state. Import historical trades using `application_mode='record_only'`; insert their participants/assets before setting their status to `finalized`.
6. After the commissioner signs in, obtain the verified user UUID in Supabase Auth. A trusted SQL administrator must create the initial `league_memberships` row with role `commissioner`. Assign managers deliberately with `manager_assignments` rows tied to both their auth user and their persistent manager identity. Authenticated clients have no direct table write permission and cannot join themselves, claim a franchise, or promote their role.

For local Supabase, run `supabase start` and `supabase db reset`. Google auth is deliberately disabled in `config.toml` until real OAuth configuration exists. Configure the two `SUPABASE_AUTH_EXTERNAL_GOOGLE_*` environment variables and enable the provider when ready. Hosted provider settings are managed separately in the dashboard.

## Contracts and invariants

- Teams are stable `franchises`; names, participants, lottery settings, and draft positions are season-specific. Historical manager identities are separate from authenticated users. A manager assignment with an unknown date grants no app access.
- `keeper_profiles.base_round` is the next keeper's underlying cost. `tenure_years` is tenure already accrued, including the fresh draft as year one. `keeper_season_records` stores that base separately from the actual payment round. Eligibility must be `confirmed` before submission/review; provisional/unresolved values remain visible for review.
- A snapshot is immutable after freezing. Live trades update `player_ownerships` and `draft_picks`, never the snapshot. All future picks keep the same UUID and original franchise through trades and expansion.
- Keeper drafts/revisions, review notes, and approval reservations stay private to the team's actual managers and commissioner. The public sees the finalized selections through `keeper_season_records` after **all** season participants are locked, without private submission notes or user IDs. `participant_count` must match registered teams, avoiding an accidental early reveal during expansion setup.
- Saving a revision invalidates its previous approval. A locked submission cannot be edited. Keeper payment validation considers the entire set: for each keeper, an unused owned pick closer to its base cost prevents overpayment. List order does not matter.
- Once all teams submit, trading opens. Any active league manager can log a trade. Commissioner finalization requires the mandatory 24-hour review period to have elapsed, locks the league, verifies every asset, and applies all transfers in one transaction. There is no draft-day override. Approved keepers cannot move before reveal, and reserved/used picks cannot be traded. Historical `record_only` trades can never execute against current ownership. Voting/automatic veto resolution remains a future workflow; commissioner review is explicit.
- Finalized trade assets, historical draft/keeper outcomes, rules, frozen snapshots, and audit entries are immutable. Corrections need explicit new records. Terms/loans are recorded as obligations; future promises do not silently transfer ownership.

## HTTP routes

- `GET /auth/login?next=/keepers`: Google OAuth; `GET /auth/callback`: PKCE exchange with local-only next path; `POST /auth/signout`: local session sign-out.
- `GET /api/session`: authenticated user plus real league memberships and manager assignments. No fabricated account is returned when unconfigured.
- `GET /api/league`: anonymous Supabase overlay for the current draft year; returns `data` in the public `LeagueData` format, `seasonId`, `phase`, `franchiseIds` (numeric UI team ID to permanent UUID), `usedPickIds`, `draftOrder`, and `revealedKeepers`. Live ownership, costs, tenure, review status, and picks fully replace the preview snapshot. Historical draft/charter material and imported manager labels remain reference metadata. A failed live query returns 503, never a silently stale preview.
- `POST /api/season`: commissioner opens selections with `{ action: "open_keeper_selection", seasonId, note }` after verifying participant count, the frozen roster and ownership, keeper profiles, and a complete valid pick inventory. The note records the setup review; unresolved profiles still cannot be submitted until reviewed.
- `GET /api/keepers?seasonId=UUID`: current submissions permitted by database row-level security.
- `POST /api/keepers`: `{ action: "save", seasonId, franchiseId, expectedRevision: 0, assignments: [{ playerId: 123, pickId: "UUID" }] }`; later saves pass the current revision. Empty selections are valid.
- `POST /api/keepers`: `{ action: "submit" | "approve" | "reject" | "lock", submissionId, expectedRevision, note? }`. Rejection requires a reason; review and lock require commissioner membership.
- `POST /api/trades`: any active league manager logs `{ seasonId, category: "player_only" | "advanced", terms, players: [{playerId,fromFranchiseId,toFranchiseId}], picks: [{pickId,fromFranchiseId,toFranchiseId}], obligations: [{kind,terms,fromFranchiseId,toFranchiseId,dueAt?}] }`. Returns `tradeId` without transferring anything.
- `POST /api/trades/finalize`: `{ tradeId }` applies the transaction after revalidation.
- `POST /api/keeper-profiles`: commissioner review `{ seasonId, playerId, baseRound: number | null, tenureYears: number | null, verification: "confirmed" | "provisional" | "unresolved" | "ineligible", note }`. An approved selection must be rejected before changing its profile. Review creates an audit event.
- `POST /api/trades/obligations`: commissioner resolution `{ obligationId, status: "fulfilled" | "waived", note }`. Settlement is recorded; an obligation does not automatically execute a second asset transfer.

Older draft rows can preserve `was_keeper = null`. Historical players whose ESPN identity has not been resolved remain in import staging; do not fabricate player IDs or treat unknown keeper status as false.

Mutation routes require same-origin requests, a server-verified session, strict JSON validation, and database authorization. API/auth responses are not shared-cacheable. Before production launch, run database tests and verify Google callback, manager provisioning, and RLS against the actual hosted project.

Sources used for this integration: [Supabase SSR clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs), [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [Row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
