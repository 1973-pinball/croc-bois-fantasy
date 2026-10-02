# Historical playoff qualification

Luckbox counts original top-four draft positions earned by franchises that reached the preceding season’s four-team championship playoff bracket. Pick recipients after trades, final consolation standings, win totals, and guessed tiebreakers do not establish qualification.

ESPN labels a basketball season by its ending year. ESPN `seasonId: 2018` is the 2017–18 season and supplies qualification for the 2018 draft. The exporter/importer always uses the payload’s actual `seasonId`; filenames and manually supplied draft-year labels cannot change it.

## Current coverage

The verified local 2025–26 ESPN snapshot supplies draft-2026 qualification: franchises **1, 2, 6, and 7**. Championship matchup period 19 contains matches 73 (7 vs 1) and 74 (6 vs 2). ESPN’s settings specify four playoff teams. The sanitized record is stored in `data/playoff-history.json` for future use.

As of October 1, 2026, the live Supabase history has complete qualification, championship, and category-win coverage for all nine completed ESPN seasons **2018–2026**, with eight participating franchises per season. The three repair batches completed with no pending years or failed years. The commissioner confirmed that the league recognizes ESPN’s 2020 championship despite that archived bracket’s 0–0 score fields. The observed 2027 season is retained separately and excluded from completed-season awards.

The live app reads those saved records from Supabase; authenticated backfill stores the evidence through a protected, audited RPC. The checked-in 2026 record remains a clearly labeled local fallback. The workbook’s Graph tab has annual wins and generic lottery probabilities, but no franchise-by-season playoff qualification. Awards use only the years actually verified in saved history.

## Automatic history sync

The server requests `mTeam`, `mSettings`, `mMatchup`, `mMatchupScore`, and `mStandings` from fixed ESPN league endpoints. `mMatchupScore` is required: historical `mMatchup` responses omit playoff bracket tiers. Requests never send credentials to caller-supplied URLs or follow redirects. Only a 404 invokes the fixed historical endpoint fallback.

Each run processes at most three seasons, prioritizing missing 2025/2026 records and maintaining a recent-season refresh slot. Incomplete brackets remain in the retry rotation. Ordinary retries back off for a day; a commissioner can immediately retry connection/source errors after a repair. An authentication failure stops the batch. Existing verified records survive errors, and a conflicting champion is held for review without blocking other seasons in the batch.

Completed-season coverage advances conservatively each July. The current ESPN season can contribute a separate observation of category wins but cannot enter completed-season awards. New observations may coexist with older verified bracket records for the same year so refreshed wins retain their own provenance.

The trusted local maintenance entrypoint uses the same server service, lease, and finish RPC. It loads ignored `.env.local`, `.env.sync.local`, and `.env.espn.local` files and never prints credential values:

```powershell
pnpm exec tsx scripts/sync-espn-history.ts --status
pnpm exec tsx scripts/sync-espn-history.ts --batches 3
```

`--status` is read-only. `--batches` accepts one through five bounded runs. Regular operation uses the commissioner control or authenticated daily cron; a JSON upload is not required.

## Importing a manually exported file

The importer reads explicit local JSON paths. It makes no network requests and never reads credentials. Supported inputs are:

- One raw ESPN league-season object.
- An array of raw league-season objects.
- A browser-export envelope with `source: "espn-browser-export"`, `leagueId`, `exportedAt`, `seasons`, and optional `failures`. Each successful season must include `exportSource: { url, fetchedAt }`.

Use the existing TypeScript runner and an explicit, verified mapping of ESPN team IDs to continuing league franchise IDs:

```powershell
pnpm exec tsx scripts/import-playoff-history.ts --league-id 139935 --map 1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8 --output data/playoff-history.json "C:\path\to\espn-playoff-export.json"
```

The current franchise mapping follows the verified ESPN import. Owner-name changes do not change franchise identity. A new or conflicting ESPN team ID requires an explicit mapping review. Do not select a mapping merely to make a bracket pass validation.

Only `WINNERS_BRACKET` matchups from the first championship matchup period identify qualifiers. That round must contain exactly two games with four distinct, known teams. Missing sides, byes, six-team brackets, missing participant mappings, duplicate teams/games/seasons, or different league IDs stop qualification import for review. An absent bracket stays unknown even if standings are present. Browser-export failures do not become non-playoff teams.

An export with a valid participant/record snapshot but no championship bracket is retained separately in optional `statsOnlySeasons`, with `qualificationStatus: "unverified"`. These records have the same season/year IDs, participant IDs, optional observed category wins, and sanitized source metadata, but have no `qualified` flags or champion. They may complete a category-win comparison after its full participant/year coverage is checked. They must never feed Luckbox or championship counts. If a championship season is later verified, prefer its qualification data; a separate statistics-only observation remains provenance of what the earlier export actually contained.

New verified years merge with existing sanitized history. Reimporting identical evidence leaves the same result. A fresh export corroborating the same facts adds its sanitized hash, URL, capture date, and field paths as `additionalSourceEvidence`. Conflicting facts for an already stored year stop for explicit review; the importer does not silently replace them. Repeated years within the supplied input files are rejected.

## Published data and provenance

The sanitized file contains:

```text
{ version: 1, leagueId, seasons: [{
  draftYear, espnSeasonId, priorSeasonStartYear,
  playoffTeamCount: 4, firstChampionshipMatchupPeriod,
  participants: [{ espnTeamId, franchiseId, qualified, regularSeasonWins? }],
  qualifiedFranchiseIds, championFranchiseId?,
  source: {
    kind, leagueId, sha256, url?, capturedAt?,
    method: "first-complete-winners-bracket", paths,
    matchups: [{ id, homeEspnTeamId, awayEspnTeamId, winnerEspnTeamId? }],
    championship?: { id, matchupPeriod, homeEspnTeamId, awayEspnTeamId, winnerEspnTeamId }
  }
}] }
```

The SHA256 identifies the supplied local file or exact server response. Source kind distinguishes local imports, browser exports, and `espn-server-sync`. Source URLs and capture timestamps are retained after validation. Published data excludes raw member objects, emails, cookies, authorization information, roster details, local filenames, and arbitrary export error messages.

Optional `regularSeasonWins` come only from ESPN’s numeric `teams[].record.overall.wins`. These are category-result wins in the verified nine-category league, not weekly matchup victories: the 2026 example 82 wins + 77 losses + 3 ties equals 162 category results across 18 weeks. Missing wins stay absent; a recorded zero stays zero.

The primary championship proof requires both semifinals to declare winners, exactly one later championship matchup to pair those winners, and that final to declare a winner. Zero score fields do not override explicit ESPN winner fields.

A narrow legacy proof handles ESPN seasons whose completed category games incorrectly say `TIE`. Both semifinals and the sole later final must have finite, strictly positive, unequal scores. Any explicit winner must agree with its score. The semifinal score winners must be the exact final participants; the final score winner must have official `rankCalculatedFinal: 1` and the opponent rank 2. Every raw participant’s final rank must form a complete unique order. Missing/zero/tied scores, undecided games, conflicting ranks, or inconsistent bracket paths leave the title unverified. Scores or standings alone are insufficient.

This proof is stored as `source.championship.method: "score-and-final-rank"`, with semifinal/final `homePoints` and `awayPoints`, plus final `homeFinalRank` and `awayFinalRank`. Migration 00006 validates these additional fields while preserving the original declared-winner validator. The verified 2018 example has semifinal winners 6 and 1, a 5–4 final win for franchise 6, and corroborating final ranks 1/2. Overview comparisons require complete coverage for their stated year range.

## Award calculation

`calculateLuckbox` joins each selected original draft order to the verified qualification record with the same ending/draft year and franchise ID. A point requires both `qualified === true` and original position 1–4. Each covered draft must contain every season participant exactly once. Ties share the award; a zero count does not create a winner.

Results include requested, covered, and missing draft years plus evidence and counts for covered years. If any requested year lacks qualification or draft order, overall `winners` remains empty and status is `insufficient-data`. Missing years never turn into zero-score seasons. An explicitly selected, fully covered year range can have its own correctly scoped award.

The tests use invented bracket fixtures for boundary checks and never write to production. They cover year alignment, consolation exclusion, duplicated/unknown participants, incomplete brackets, tied awards, partial coverage, and sanitized multi-season import.
