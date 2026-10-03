# Croc Bois Fantasy Basketball

A public league portal and private keeper workflow for Croc Bois. Next.js, TypeScript, Supabase Postgres and Vercel. Google sign-in and commissioner-approved team onboarding are implemented and enabled for production. The initial commissioner has verified Google access and an approved team assignment.

[Open the league app](https://croc-bois-fantasy.vercel.app) · [Delivery roadmap](ROADMAP.md)

## Local development

Requires Node 22+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. The included public migration snapshot works without cloud credentials. Keeper planning in this mode is a local preview: it does not submit keepers, run an official lottery or change ownership.

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Data and rules

- Permanent franchise identity is separate from season participation, team names and dated manager assignments.
- Picks are identified by season, originating franchise and round. Trading a pick changes ownership, never its identity.
- Keeper base cost and the pick actually paid are separate. Spending an earlier pick does not accelerate next year's base cost.
- Whole-set validation respects an owner's chosen assignments, rejects reused/unowned picks and rejects voluntary overpayment when a closer unassigned pick exists.
- The initial draft season, including the first active undrafted season, is tenure year one. Five completed tenure seasons make the player ineligible for a sixth.
- Re-drafting resets the cycle. Trades and waiver claims preserve it.
- Commissioner-supplied provisional values remain reviewable. Historical facts are not rewritten to force agreement with current rules.
- The eight-team lottery follows the commissioner's original Python method: weighted sampling without replacement, with each non-playoff team starting at 24% and each playoff team at 1%. Later-choice probabilities are derived from those weights. It produces the order of choosing draft positions. Expansion requires a reviewed configuration.
- Keeper drafts and review notes remain private to their managers and the commissioner. Final player/pick selections reveal publicly only after every participating team is locked.
- Assigned owners and co-managers can save private keeper drafts during setup. Official submission opens separately through the commissioner's season controls.

## Workbook audit

The original workbook is read-only and stays out of Git. The extractor preserves values, cached formula results, formula text, formatting evidence and cell references for local source work. The audit report is included; rerunning it currently requires the local source inputs listed below.

```sh
pnpm audit:keepers
```

To refresh local workbook evidence, run `python scripts/extract-workbook.py "/path/to/Croc Bois Fantasy Basketball Asset Management Master Sheet.xlsx" .local/workbook.json`. Also supply `.local/marked-2025-draft.tsv`, `keeper_costs_2025_source.json`, and `croc_bois_139935_2025-26_migration.json`. The audit script accepts explicit input paths and supports a sanitized `data/audit-inputs` fallback when supplied. Original exports remain local. The historical integration test skips when those source inputs are unavailable; domain and database tests run without them.

The audit compares independently calculated costs with historical targets. A cached Excel result is evidence of the saved workbook, not proof that the formula was recalculated. The source workbook has both corrected and legacy keeper-cost logic; differences remain in the report.

The current replay matches 137 of 139 canonical 2025 targets. Giannis differs, and Dort has conflicting source targets. The `/audit` page explains these exceptions and the earlier-season checks. The 2026 projection covers 111 final-roster players: 100 pass the cost/tenure rules and 11 are ineligible. The original projection's inferred-tenure flags were reviewed against draft/retention evidence and the established undrafted rule. A rules match alone does not confirm available payment picks.

The [keeper readiness cost review](docs/KEEPER_COST_REVIEW.md) checks all 111 current profiles against that approved baseline and the frozen roster. Migration 00008 confirms eleven inferred tenures from positive draft/retention evidence. Migration 00009 applies the established undrafted rule to the 36 matching profiles, including Hart and Grimes, preserving existing commissioner confirmations and all numeric costs. Historical disagreements stay visible. See [the release walkthrough](docs/KEEPER_READINESS.md) for the all-team readiness screen, schedule controls, and remaining real-account checks.

`data/league.json` is the sanitized public migration preview. Raw ESPN responses, account/member identifiers, the workbook extract and local reconciliation inputs are ignored by Git. To regenerate the preview, place the local source files referenced in `scripts/build-preview-data.ts` and run `pnpm import:preview`.

## Cloud setup

See [SETUP.md](SETUP.md) for the connected projects, Google OAuth and Vercel setup. Supabase has the reviewed bootstrap data; running the app does not create projects or seed a database. Copy `.env.example` to `.env.local` and supply your project settings.

League Lab includes draft-position history, player preferences, historical wins/trades correlation, and awards. The first-pick award and heatmap use the same year filters. Rebuild its public artifact from local source evidence with `pnpm exec tsx scripts/build-analytics.ts`. Reconstructed original pick owners and mismatched wins/trade reporting windows remain labeled; incomplete keeper flags stay in the source evidence and no longer divide the player appearance counts. Spreadsheet cell references are reserved for the keeper audit.

**Everybody has a type** now has **Players** (all recorded draft appearances) and **Category Preferences** (historical position averages and actual category results). See [League Lab methodology](docs/LEAGUE_LAB.md) for coverage and refresh instructions. The [live draft board](docs/LIVE_DRAFT.md), in the draft room’s Live draft view, adds the ESPN category-ranked player pool, blank slots until order is decided, revealed purple keeper picks, and audited commissioner selection/correction controls with automatic refresh.

Players offers 10/25-row pagination through every matching player/franchise pairing. The draft pool shows the top 200 matching players by default, with search across the full catalog, plus keeper eligibility, position and availability filters. My Team and Teams & players use compact roster rows, with eligibility explanations under **Details** and mobile sorting controls.

The draft-capital inventory uses round tiles, and the keeper pool pairs readable player names with 44px selection targets. Costs, tenure and eligibility stay visible; longer eligibility explanations open under **Details**.

The [draft-slot choice lottery](docs/DRAFT_LOTTERY.md) in Commissioner Tools shows compact verified standings, current manager labels and the original Python method. Commissioners generate one saved weighted choice order, with red/blue lottery-ball reveals and confetti over 32 seconds. **Share Lottery Results** explicitly creates and copies a standalone replay link. **Manage draft order** uses the lottery as an editable starting point and requires **Publish draft order** before changing the board. Stable light team colors identify slots and current pick owners. Commissioner Tools is disabled for other accounts; everyone can view published draft slots.

**Draft rosters** shows each team's public keepers and drafted players in the draft room’s Rosters workspace, with player totals and filled/open ESPN slots. The verified 2026–27 layout is PG, SG, SF, PF, C, G and F once each, UTIL ×3 and BENCH ×3, plus a separate IR slot. Suggested placement uses ESPN's actual player eligibility and updates with picks, corrections and removals. This display does not finalize player ownership or edit ESPN lineups; the [draft walkthrough](docs/LIVE_DRAFT.md) documents the source and repeatable refresh command.

The overview includes years active and compact basketball trophy podiums for championship and category-win totals. All nine completed seasons, 2018–2026, have verified playoff results and stored win totals in Supabase. The commissioner confirmed that Bizarre Bazaar's 2019–20 COVID championship counts. [Automatic ESPN history sync](docs/ESPN_HISTORY_SYNC.md) refreshes recent years daily; a commissioner can trigger another batch in the app. The private ESPN session connection is configured and authenticated imports have succeeded; no recurring JSON upload is needed. [Manual export](docs/ESPN_PLAYOFF_EXPORT.md) and [import notes](docs/PLAYOFF_HISTORY.md) remain recovery tools. Missing seasons are never counted as zero, and unfinished seasons do not enter completed-season rankings.

Implemented workflows include team-access requests and commissioner approval, co-manager access and dated revocation, automatic My Team navigation, roster/cost review, keeper planning, commissioner approval and locking, public reveal, current-season trade entry/review, obligation resolution, pick ownership and historical draft visibility. Remaining owner onboarding, live keeper-workflow verification, trade vetoes and payment reconciliation, guided slot choices, roster reconciliation and full historical migration are tracked in [ROADMAP.md](ROADMAP.md).

The approved Croc Bois mascot is `public/images/croc-bois-mascot.png`. Its generation prompt and reference notes are in `docs/croc-bois-mascot.txt`. Run `node scripts/render-icons.mjs` to regenerate browser and installation icons from that asset.

## UI and workflow polish

Views, selected teams, roster sorting/search, draft archive years and Lab filters use shareable URLs. Mobile navigation traps focus, closes with Escape and restores the menu button; browser Back/Forward restores context. Audit uses the shared league shell. Current manager names, roster snapshot dates and live refresh times are explicit, and overview leaders wait for verified history instead of showing temporary fallback totals.

The draft room separates **Live draft**, **Pick ownership**, and **Archive**. Its Board / Players / Rosters controls work at every size. Draft cards use a Sleeper-inspired 148px by 112px minimum size with player, NBA position/team, round.pick/overall number, keeper state and ownership context. Horizontal scrolling preserves readable cards; Present board enters fullscreen. Signed-in managers can keep a private account/season shortlist on this browser.

Unfinished trade and keeper-profile forms survive navigation and reload in account/season-scoped session storage; profile drafts also follow the player. Explicit discard and account-boundary cleanup are included. Commissioners can withdraw a pending live proposal with a reason, then prepare a linked revision with a fresh 24-hour review period. This requires migration 00014. The final keeper lock explicitly states when it reveals the league’s selections. See [the UI/UX review and implementation record](docs/UI_UX_REVIEW.md).
