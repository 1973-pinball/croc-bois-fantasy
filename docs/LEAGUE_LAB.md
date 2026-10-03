# League Lab preferences

The **Everybody has a type** panel has two completed views: **Players** and **Category Preferences**. The league-wide franchise spotlight filters both views. Each view retains its own year selection when switching tabs.

## Players: complete draft-board appearances

Players uses [analytics.json](../data/analytics.json), which contains 832 draft-board entries from draft years **2018–2025**. It ranks all 526 recorded player/franchise pairings by total appearances. Choose 10 or 25 rows per page and use First, Previous, Next or Last to browse every match. The displayed ranks and result range refer to the full filtered list. The search field, draft-year selector, and franchise spotlight filter all records, not just the current page; changing these filters or page size resets to the first page. Selecting a row opens its recorded years, rounds, overall picks, and historical owners. Changing pages closes the previous row's history.

Every recorded appearance counts, including retained players. There are no separate **New selections** or **Keepers** controls, classification segments, or classification legend. Historical keeper flags are incomplete, so they do not determine the displayed count. The source artifact can retain those flags as evidence without presenting them as complete keeper histories.

The current full-archive leaders have six appearances: Domantas Sabonis with franchise 4 and LaMelo Ball with franchise 2. An absent draft-board entry is not added from a separate keeper list. For example, the historical Marcus Smart keeper-list discrepancy does not create an invented board appearance. Name normalization and franchise aliases come from [build-analytics.ts](../scripts/build-analytics.ts).

## Category Preferences: roster mix and category results

This view uses two independently described sources:

| Public artifact | What it supplies |
| --- | --- |
| `data/roster-position-history.json` | One captured end-of-season roster per franchise and ESPN season, with primary-position counts. |
| `data/category-preferences.json` | Completed regular-season matchup results for each scoring category and franchise. |

The captures were collected on **October 3, 2026**. They cover all eight franchises across ESPN seasons **2018–2026**, displayed as **2017–18 through 2025–26**. ESPN identifies a season by its ending year; the artifact's `draftYear` is its starting year. The Category Preferences selector therefore offers nine basketball seasons, while Players offers the eight draft years supported by its separate archive.

Current coverage is 72 franchise-season roster snapshots, 986 player observations, and zero unknown primary positions. Category coverage contains 688 distinct regular-season head-to-head matchups, or 172 matchup observations per franchise across the selected nine seasons. The extracted category W/L/T totals reconcile with ESPN's recorded regular-season standings for all 72 franchise-season records.

### Average recorded roster mix

Each rostered player contributes once to PG, SG, SF, PF, or C using the primary position returned by that season's ESPN endpoint. Multiple eligible positions do not produce multiple counts. Bench and injured-reserve players remain in the roster. Earlier seasons use their own position records; the current roster is not substituted for historical data.

For a selected set of recorded seasons:

- **Average count** is the sum of a position's player counts divided by the number of recorded season snapshots.
- **Average share** is the mean of each snapshot's position count divided by that snapshot's roster size. Each season receives equal weight, even when roster sizes differ.
- **Average roster size** is the mean roster size across those snapshots.

These are averages of saved end-of-season snapshots. They do not measure average daily roster composition, draft selections, active lineup slots, minutes, or how long a player was held during a season. A single selected season shows its one captured roster. Unknown positions remain in the roster-size denominator and are reported separately. Missing snapshots are omitted from the average and identified as missing; they never become empty rosters or zero-position seasons.

The calculations are in `src/lib/roster-position-history.ts`. The UI shows its snapshot count, covered seasons, average roster size, and any missing coverage alongside the position breakdown.

### Nine-category results and strongest categories

The recorded scoring categories are **FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, and TO**. Extraction follows the league's scoring settings and ESPN's official paired `WIN`, `LOSS`, and `TIE` outcomes in `cumulativeScore.scoreByStat`. A turnover win already reflects the lower-is-better scoring rule.

Only completed regular-season matchups with observed scoring contribute. Playoffs, current or future undecided periods, and unscored cancelled weeks are excluded. A category must have valid, finite scores and consistent outcomes for both opponents. Missing or ineligible category results do not become losses or ties.

For each category, the denominator is its own recorded decisions:

```text
decisions = wins + losses + ties
win rate = (wins + 0.5 × ties) / decisions
```

Results are pooled across the selected seasons, so each recorded category decision has equal weight. This differs from the equal-season weighting used for roster snapshots. A category without decisions has no win rate. If a category covers fewer matchups than the franchise total, its table row shows that smaller denominator.

Each franchise card highlights its three highest recorded category win rates, with ties ordered by win count and then label. The expandable table exposes all nine W/L/T records and rates. These strengths describe results; they do not prove an owner's intended strategy or a deliberate category punt. See `src/lib/category-preferences.ts` for extraction and aggregation.

## Franchise continuity

All preference results belong to stable franchise identities. Current team names and abbreviations make the history recognizable, while earlier records remain part of the same franchise through manager changes. For example, franchise 4 includes its earlier Edwin/Julian history as well as Sebastian's tenure. Those earlier results are not attributed personally to the current owner. Players' detailed receipts retain the historical owner recorded for each appearance.

## Provenance and rebuilding

Each published season preserves its source URL, capture timestamp, and SHA-256 hash. Roster seasons also retain the ESPN scoring-period ID; category seasons retain completed matchup periods, excluded unscored-matchup counts, and the standings reconciliation result. Public preference artifacts contain aggregate franchise data rather than the private raw responses or ESPN member/account information.

`scripts/build-team-preferences.ts` reads private captures from `.local/category-preferences` by default. Each input has a paired `<name>.source.json` file containing `sha256`, `url`, and `capturedAt`. The builder verifies the raw file's hash before extracting data and rejects mismatched season identities or category totals that conflict with the supplied standings.

The current builder requires:

- `espn-2018.json` through `espn-2026.json`, with their matching source files, for historical roster and category data. These captures include season-specific team rosters, league scoring settings, standings, and matchup category scores.
- `espn-2027.json` and `espn-2027-players.json`, with their matching source files, because the same builder also regenerates the current draft-player catalog.

With those private inputs available, run from the project root:

```sh
pnpm exec tsx scripts/build-team-preferences.ts
```

Optional positional arguments select an input directory and an existing output directory:

```sh
pnpm exec tsx scripts/build-team-preferences.ts .local/category-preferences data
```

The command writes `data/roster-position-history.json`, `data/category-preferences.json`, and `data/draft-player-catalog.json`. It does not fetch ESPN, require credentials for the local rebuild, or publish a deployment. The current historical extraction range is explicitly 2018–2026; extending it requires updating the builder and supplying verified additional captures. The 2027 capture currently supplies the draft catalog, not an additional completed Category Preferences season.

The Players archive has a separate rebuild path: `pnpm exec tsx scripts/build-analytics.ts`, using the local workbook evidence required by that script. Rebuilding team preferences does not alter historical draft-board appearances.

## Refresh boundary and validation

Both preference views read checked-in artifacts bundled with the application. Their deployed contents change after source review, regeneration, and deployment. Changing a filter recalculates the selected records locally; it does not fetch a fresh ESPN roster or category history.

The existing [automatic ESPN history sync](ESPN_HISTORY_SYNC.md) is separate. Its daily production job and commissioner refresh control update saved Supabase season history used by playoff qualification, championships, and overall category-win comparisons. That job does **not** rebuild these roster-position or per-category preference artifacts. Its successful refresh timestamp is not evidence that Category Preferences has been refreshed. Daily roster sampling and automatic regeneration of these artifacts remain outside the current implementation.

`tests/domain/team-preferences.test.ts` verifies equal-season roster weighting, primary-position counting, unknown and missing observations, exclusion of incomplete or unscored periods, category-specific denominators, reversed categories, standings reconciliation, and public-data boundaries. Run the focused checks with:

```sh
pnpm exec tsx --test tests/domain/analytics.test.ts tests/domain/team-preferences.test.ts
pnpm typecheck
```

Browser validation also covers complete appearance totals, receipts, search and empty results, independent year filters, franchise filtering, exact single-season and combined category records, keyboard tab navigation, and desktop/mobile layouts.
