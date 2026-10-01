# Croc Bois Fantasy Basketball

A public league portal and private keeper workflow for Croc Bois. Next.js, TypeScript, Supabase Postgres and Vercel. Google sign-in is implemented but deliberately disabled until provider setup and manager onboarding are complete.

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
- The initial draft season is tenure year one. Five completed tenure seasons make the player ineligible for a sixth.
- Re-drafting resets the cycle. Trades and waiver claims preserve it.
- Commissioner-supplied provisional values remain reviewable. Historical facts are not rewritten to force agreement with current rules.
- The eight-team lottery reproduces the charter's marginal probabilities. It produces the order of choosing draft positions. Expansion requires a new explicit lottery configuration.
- Keeper drafts and review notes remain private to their managers and the commissioner. Final player/pick selections reveal publicly only after every participating team is locked.

## Workbook audit

The original workbook is read-only and stays out of Git. The extractor preserves values, cached formula results, formula text, formatting evidence and cell references for local source work. The audit report is included; rerunning it currently requires the local source inputs listed below.

```sh
pnpm audit:keepers
```

To refresh local workbook evidence, run `python scripts/extract-workbook.py "/path/to/Croc Bois Fantasy Basketball Asset Management Master Sheet.xlsx" .local/workbook.json`. Also supply `.local/marked-2025-draft.tsv`, `keeper_costs_2025_source.json`, and `croc_bois_139935_2025-26_migration.json`. The audit script accepts explicit input paths and supports a sanitized `data/audit-inputs` fallback when supplied. Original exports remain local. The historical integration test skips when those source inputs are unavailable; domain and database tests run without them.

The audit compares independently calculated costs with historical targets. A cached Excel result is evidence of the saved workbook, not proof that the formula was recalculated. The source workbook has both corrected and legacy keeper-cost logic; differences remain in the report.

The current replay matches 137 of 139 canonical 2025 targets. Giannis differs, and Dort has conflicting source targets. The `/audit` page explains these exceptions and the earlier-season checks. The 2026 projection covers 111 final-roster players: 100 pass the cost/tenure rules, including two provisional cost rulings, and 11 are ineligible. Seventeen keeper tenures and the initial tenure convention for 30 undrafted players require review before official submission. A rules match alone does not confirm available payment picks.

`data/league.json` is the sanitized public migration preview. Raw ESPN responses, account/member identifiers, the workbook extract and local reconciliation inputs are ignored by Git. To regenerate the preview, place the local source files referenced in `scripts/build-preview-data.ts` and run `pnpm import:preview`.

## Cloud setup

See [SETUP.md](SETUP.md) for the connected projects, Google OAuth and Vercel setup. Supabase has the reviewed bootstrap data; running the app does not create projects or seed a database. Copy `.env.example` to `.env.local` and supply your project settings.

League Lab includes draft-position history, player preferences, the workbook Graph correlation, and awards. Rebuild its public artifact from local source evidence with `pnpm exec tsx scripts/build-analytics.ts`. Reconstructed original pick owners, incomplete keeper flags, and mismatched wins/trade reporting windows remain visible. Luckbox is pending actual playoff history.

Implemented workflows include roster/cost review, keeper planning, commissioner approval and locking, public reveal, current-season trade entry/review, obligation resolution, pick ownership and historical draft visibility. Google onboarding, trade vetoes and payment reconciliation, stream lottery operations, periodic ESPN synchronization and full historical migration are tracked in [ROADMAP.md](ROADMAP.md).
