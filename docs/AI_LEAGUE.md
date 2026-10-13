# League Lab: the automated league

League Lab includes **What changes when AI takes over?** Both the upcoming **2026–27** live experiment and the **2025–26** replay offer whole-league AI, one team after the real draft, and one team drafting plus managing. ESPN season identifiers use the ending year (2027 and 2026). The experiments use an automated numerical strategy and do not require an OpenAI account or API key.

## What is simulated

Eight franchises participate in one fresh 13-round snake draft with a deterministic season-based draft order. Each has ten active slots and three bench places. Player ownership is exclusive across the experiment. Existing keepers, traded picks, manager submissions, live draft selections and official ESPN rosters are not changed or incorporated into this fresh-redraft scenario.

The manager evaluates nine-category contributions, including volume-sensitive shooting percentages and reversed turnovers. Draft selections consider unfilled positions. Daily maximum-weight lineup matching respects ESPN position eligibility. The shared acquisition market rotates the team processing order each day, allows at most one add/drop per team/day and four acquisitions per matchup period, and holds dropped players until the next calendar day. Three-day retention value discourages dropping core players merely to add a streamer. It does not negotiate trades or use the extra IR slot.

**AI draft results** displays all 104 original selections for either season. The board keeps franchises in first-round order, marks the snake direction for each round, and supports a chronological pick list and round filter. Names and positions prefer the saved initial player snapshot. Later pickups and roster changes never replace the draft selections. Selecting a franchise also updates the owner comparison.

This first version has explicit simplifying rules: all lineups lock at the day's first NBA game, waiver priority rotates instead of reproducing ESPN priority, and the acquisition ceiling remains four even in extended matchup periods. These are displayed under **How this experiment works**. It is a reproducible strategy experiment, not a claim of perfectly optimal management.

## Upcoming season

The initial player values come from complete ESPN per-game season projections, with prior-season averages as a fallback. The initial forecasts and capture timestamp are retained separately from the estimates learned during the season. Forecasts are updated only after completed game results; current injury information and new player IDs may affect an on-time live decision. Daily decisions are saved before the earliest tipoff and are not reconstructed after that deadline. A missed lock remains a visible gap and can prevent final standings/championship certification.

The scheduled job reads the source each day at the configured 10:15 UTC hour (Vercel may execute later within the hour). It scores prior saved lineups from complete box scores and prepares today's decisions. The page checks saved results every minute while visible; this is not a real-time play-by-play feed. Before the season starts it displays the completed simulation draft and scheduled matchups, without inventing scores or a champion.

The two **one-team live variations** wait for the complete real 2026 draft in the app's public board: all 104 slots, including revealed keeper payments and traded picks, must have verified players and order. ESPN's offline-import order is not substituted. Each variation runs eight independent franchises; the existing whole-league AI draft stays unchanged. `labAiVariation` and `labAiTeam` bookmark the choice in either season.

After-draft experiments start from the selected franchise's real draft roster. Redraft experiments reserve the other seven franchises' real selections and choose players in the selected team's actual slots. This constrained redraft happens after the real draft is published, using forecasts available at that capture; it is not a claim that AI predicted the opponents' draft choices. Extra players are cut to the common thirteen-player, no-IR limit, with receipts. AI management starts on the first NBA scoring date, so offseason changes to the controlled team's actual roster are not copied into its simulation.

Every daily AI decision requires all eight owner rosters captured before first tipoff. Owner claims known at that boundary take priority; later intraday changes cannot rewrite a saved AI lineup. Opponents receive their final observed daily lineups and NBA scoring. Current injury and eligibility evidence may inform the next decision, while forecasts learn only from previously completed dates. Missed game-day locks remain visible gaps. An experiment that did not capture its starting draft/forecasts before opening tipoff cannot fabricate a season afterward. A thirty-second safety margin allows the pending database write to finish; the database independently rejects any new game-day receipt arriving after tipoff.

Owner daily totals are compared with all nine official matchup categories before win-change or championship claims are certified. While the experiment is active, later official totals are checked again; a discrepancy removes period verification and stays visible. The saved player statistics and decisions are never altered to force agreement. A verified empty NBA date can settle with empty lineups after its date. Completed experiments retain their saved receipts; subsequent provider corrections require a reviewed rebuild rather than silently rewriting them.

The live table shows completed category records, verified changes, the selected team's draft and current roster, latest lineup, pickups and owner-claim receipts. Champions appear only after the full calendar and official owner totals are verified. Before the real draft, both choices explicitly show that their starting evidence is pending, without invented picks or scores.

## Last-season replay

The 2025–26 replay starts from **2024–25 actual per-game averages** and learns forward after each simulated day's decisions. It ignores target-season totals, today's rankings, and current injuries when selecting players. This is a reconstructed statistical baseline, not a recording of decisions actually made in 2025. Players without prior-season averages have a zero baseline, which disadvantages rookies and newcomers.

Historical eligibility and the player universe come from the season endpoint and can reflect later changes. Historical daily availability comes from box-score rosters, including DNP players; archived injury announcements and the exact available-at-lock player universe are not supplied. These limitations are shown in the UI. No hindsight-perfect claim is made.

## Comparing AI with the actual owners

The **AI vs. the actual owners** panel highlights the largest category-win increases and decreases and the largest difference in pickup activity. Its franchise selector is shared with the roster and decision trail, and can be bookmarked with `labAiTeam`. Each franchise shows draft overlap, its earliest different selections, real keeper labels, category records, and pickup totals.

Actual 2025–26 draft selections come from the commissioner-verified 2025 draft board. ESPN's offline draft import does not preserve that board's pick order or keeper flags, so it is not used as the historical draft authority. ESPN supplies official category outcomes and acquisition counts by matchup period. Only matching completed regular-season periods contribute to numerical comparisons; missing data remains unavailable. Upcoming-season comparisons appear as verified draft and completed matchup evidence arrives.

These are differences between whole-league scenarios, including their different draft orders and keeper rules. They do not estimate the causal value of a single choice. This comparison panel uses draft, matchup and acquisition summaries; the separate one-team experiments below reconstruct daily lineups. Detailed intraday transaction history is unavailable, so the panel cannot claim a specific pickup was available to an owner at a particular time. Historical draft-owner labels follow the source board rather than today's manager assignment.

In the whole-league experiment, owner evidence is allowlisted into the saved run separately from simulation decisions. It never enters that manager's draft, lineup, pickup, or scoring calculations. An owner-source outage preserves the last snapshot and leaves the simulation refresh independent.

## Three replay variations

The 2025–26 replay offers three variations, selected with `labAiVariation`:

1. **Whole league AI** (`all`): the existing fresh draft and shared automated player market for all eight franchises.
2. **One team · after draft** (`post_draft`): eight independent experiments, each starting one franchise from its actual opening-day roster and letting AI manage its lineups and acquisitions.
3. **One team · draft + season** (`redraft`): eight independent experiments, each replacing one franchise's draft selections and subsequent management.

Each row in either one-team table represents a separate season. The other seven owners retain their recorded daily rosters and starter selections. Their NBA statistics remain fixed, while regular-season category results, playoff qualification, matchups and champions are recalculated. Frozen postseason and consolation lineups are reused if qualification changes.

Keeping other owners fixed requires an explicit constrained draft: their actual draft selections and keepers are reserved in advance. AI chooses fresh players in the controlled franchise's actual owned pick positions, including its keeper slots. Traded picks can produce 12 or 14 selections. This is not an unrestricted redraft against adaptive opponents.

Post-draft simulations retain the full actual opening roster before applying the common AI policy: 13 players, ten active positions, three bench places and no IR. Any extra opening player is removed by preseason value and shown as an initial cut. Opponents' dated ownership takes priority: if an owner later acquires a player held by AI, that player is returned and the conflict is recorded. A replacement uses the normal four-per-period acquisition budget, so exhausted budgets can leave vacancies. Newly observed opponent releases and AI drops are unavailable until the following day. The controlled team's later actual acquisitions and drops are ignored.

The historical source reconstructs each day's eight owner lineups and full player statistics. Only archived roster snapshots determine ownership; the historical player-pool API's final-season ownership, waiver, injury and ranking fields are ignored. Daily NBA availability comes from historical stat-record presence, including DNPs. This remains a reconstruction rather than archived pregame knowledge. The player universe is frozen to the 1,097 players returned by the fantasy season endpoint. Where an NBA contributor falls outside that universe, a supplemental public box score must account for the NBA point-total difference and exactly confirm all known players' eleven counting statistics. This never fills a missing known player's line with zero or adds new players retroactively.

Before publishing, the builder requires a complete actual-season baseline: all 160 dates, all nine official category totals for each franchise in every period, all eight regular-season records and the actual champion. It then requires all 16 one-team scenarios to complete. The site displays each franchise's actual/replay record, change in category wins, champion, draft choices, initial/final rosters, acquisitions and forced returns. Missing or unverified evidence never becomes a championship or improvement claim.

One source discrepancy is explicitly reconciled: franchise 8's period-18 blocks sum to 20 in the dated fantasy statistics and independently checked NBA box scores, while its official matchup total is 19. A recorded −1 block adjustment preserves the official total only in the actual baseline and when that franchise is a frozen opponent. No player statistic, forecast, lineup or controlled-team result is changed to invent a player-level correction. Its actual opponent had 44 blocks, so the discrepancy does not change the actual category result. A ±1 block sensitivity check also leaves every replay category outcome, seed, qualifier and champion unchanged: controlled franchise 6 records 48 blocks versus 19, and controlled franchise 8 records 34 versus 44, in both modes. The builder accepts only this exact documented 20→19 discrepancy; any other counting-stat disagreement still prevents publication.

## Scoring and source verification

All nine categories use actual NBA regular-season box scores, including fantasy free agents. FG% and FT% use summed makes/attempts. The experiment treats percentage categories as ties when either side has no attempts. Only complete matchup periods enter category W/L/T standings. Four-team playoffs use simulated regular-season seeds and the real playoff date ranges; ties in a playoff series advance the higher seed. The actual league's playoff participants are never substituted for simulated qualifiers.

The feed checks ESPN league/season identity, reconciles scoreboard event IDs against the NBA scoring calendar, and rejects incomplete box scores. Explicit DNPs may contribute zero; missing scored data does not. Dates use America/New_York. The 2026 and 2027 matchup calendar constants are verified against ESPN's client, including their different extended All-Star periods, with source URLs recorded in `src/lib/ai-league-feed.ts`. Later official stat corrections require an explicit reviewed rebuild; finalized experiment dates are not silently rewritten.

## Storage and operation

Migration `20261007000015_ai_league.sql` adds isolated `ai_league_runs` and `ai_league_refresh` tables. Public reads follow the existing league visibility policy. Only the server service role can write; revision comparison prevents a stale worker from replacing a newer run. Credentials and raw league/member responses never enter the experiment payload.

Migration `20261008000020_ai_live_decision_locks.sql` adds the database receipt guard for the sixteen live one-team scenarios stored under the 2027 run's `liveSingles` field. Starting draft evidence, prior source locks, lineups and decision receipts cannot be overwritten or extended retrospectively. Duplicate scenario/receipt identities and orphan lineups are rejected. A late receipt leaves a visible gap while the previous saved state remains intact. No official league table is changed by this simulation migration or refresh.

- `GET /api/ai-league` reads saved runs, their live one-team state when available, and refresh health.
- `GET /api/ai-single-team-replays` reads the verified historical one-team artifact through the same public league-visibility gate.
- `GET /api/cron/ai-league` requires the existing `CRON_SECRET` and refreshes bounded batches. It shares the existing private ESPN and Supabase connections.
- `pnpm exec tsx scripts/sync-ai-league.ts --season 2027 --export` initializes/refreshes the upcoming season and exports the public fallback.
- `pnpm exec tsx scripts/sync-ai-league.ts --season 2026 --batches 60 --export` advances last season in batches of at most three dates, stopping on source failures or completion.
- `pnpm exec tsx scripts/build-ai-single-team-replays.ts` resumes collection of sanitized historical snapshots in ignored `.local/ai-single-team/`, verifies the actual season, and atomically writes `data/ai-single-team-replays.json` only when all 16 scenarios are complete. `--fetch-only` collects evidence without publishing a report.

The CLI reads ignored `.env.local`, `.env.sync.local`, and `.env.espn.local`. `--export` writes the allowlisted `data/ai-league.json` fallback; local mode without a database can show that saved snapshot. Production reads the database. The cron is part of the site's `vercel.json`, not a separate chat reminder.

Live one-team imports reuse the current NBA feed and request at most three owner scoring dates in parallel under a shared eight-second deadline. Pending prior dates settle before today's decision. A source outage retains prior one-team receipts and reports the error without replacing them with zeroes. Apply migration 00020 before deploying this writer; the standard 2027 refresh also initializes its honest waiting-for-draft state.

## Validation

Domain checks cover exclusive ownership, deterministic drafting, position matching, turnover/percentage scoring, irreversible daily locks, delayed data, acquisition limits/cooldowns, independent playoff seeding, prior-data-only decisions, idempotence, and forecast preservation. Provider checks reject mismatched seasons, truncated schedules and missing scoring categories. Database tests verify public/private visibility, forbidden browser writes, and stale-worker protection. Browser checks cover both season tabs, draft/roster views, decision filters, missing-data states and mobile layout.

Single-team checks additionally cover fixed opponent statistics, constrained draft reservations and traded pick positions, explicit initial roster cuts, forced ownership returns, exhausted acquisition budgets, official-period reconciliation, the narrowly allowed scoring adjustment, and unchanged decisions when later scoring data changes. The saved 16-scenario audit recomputed all 1,200 matchup results from 2,560 daily lineups and checked every reconstructed playoff bracket. Browser checks verify all three variations, all eight rows per one-team mode, draft comparisons, bookmarked selections, mobile scrolling, retry behavior and suppressed claims for unverified evidence.

Live-specific tests cover complete real-draft gating, before-opening initialization, sixteen isolated scenarios, idempotent pre-tipoff decisions, missed locks, later claims, actual-owner lineup scoring, official corrections and strict source identity. PGlite receipt tests use the database clock, reject late or retroactively appended decisions, preserve starting evidence, and separately exercise verified empty dates.
