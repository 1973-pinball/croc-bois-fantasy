# Historical playoff qualification

Luckbox counts original top-four draft positions earned by franchises that reached the preceding season’s four-team championship playoff bracket. Pick recipients after trades, final consolation standings, win totals, and guessed tiebreakers do not establish qualification.

ESPN labels a basketball season by its ending year. ESPN `seasonId: 2018` is the 2017–18 season and supplies qualification for the 2018 draft. The exporter/importer always uses the payload’s actual `seasonId`; filenames and manually supplied draft-year labels cannot change it.

## Current coverage

The verified local 2025–26 ESPN snapshot supplies draft-2026 qualification: franchises **1, 2, 6, and 7**. Championship matchup period 19 contains matches 73 (7 vs 1) and 74 (6 vs 2). ESPN’s settings specify four playoff teams. The sanitized record is stored in `data/playoff-history.json` for future use.

Draft years 2018–2025 still need their matching ESPN season exports. The workbook’s Graph tab has annual wins and generic lottery probabilities, but no franchise-by-season playoff qualification. The 2026 record cannot fill those historical gaps. The all-time 2018–2025 Luckbox winner remains unavailable until that coverage is verified.

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

The SHA256 identifies the supplied local file. Browser source URLs and capture timestamps are retained after validation. Published data excludes raw member objects, emails, cookies, authorization information, roster details, local filenames, and arbitrary export error messages.

Optional `regularSeasonWins` come only from ESPN’s numeric `teams[].record.overall.wins`. These are category-result wins in the verified nine-category league, not weekly matchup victories: the 2026 example 82 wins + 77 losses + 3 ties equals 162 category results across 18 weeks. Missing wins stay absent; a recorded zero stays zero. A championship is recorded only when both semifinals declare a winner, exactly one later championship matchup pairs those two winners, and that final declares a winner. Final rankings, scores, or a third-place matchup cannot substitute for that proof. The local 2026 snapshot proves franchise 2 won final matchup 77; earlier championships remain unknown until matching history is supplied. Overview all-time comparisons need complete coverage for their stated year range.

## Award calculation

`calculateLuckbox` joins each selected original draft order to the verified qualification record with the same ending/draft year and franchise ID. A point requires both `qualified === true` and original position 1–4. Each covered draft must contain every season participant exactly once. Ties share the award; a zero count does not create a winner.

Results include requested, covered, and missing draft years plus evidence and counts for covered years. If any requested year lacks qualification or draft order, overall `winners` remains empty and status is `insufficient-data`. Missing years never turn into zero-score seasons. An explicitly selected, fully covered year range can have its own correctly scoped award.

The tests use invented bracket fixtures for boundary checks and never write to production. They cover year alignment, consolation exclusion, duplicated/unknown participants, incomplete brackets, tied awards, partial coverage, and sanitized multi-season import.
