# Export league history from ESPN

This export supplies evidence for **Luckbox playoff history and the overview championship/wins podiums** across ESPN seasons **2018–2026**, nine completed seasons. ESPN's season ID is the ending year: `2018` means 2017–18, and `2026` means 2025–26. This is a manual, read-only export from your signed-in browser.

1. Open [Croc Bois on ESPN](https://fantasy.espn.com/basketball/league?leagueId=139935) in your normal browser. Sign in to ESPN normally if prompted, and confirm you can open the league. Keep the page on `https://fantasy.espn.com`.
2. Open the [complete export script](../scripts/export-espn-playoffs.browser.js). In GitHub, use **Raw** so you can copy the file's contents. Copy the entire script, beginning with its comment and ending with `})();`.
3. On the ESPN tab, open Developer Tools and select **Console**. In Chrome or Edge on Windows, `Ctrl+Shift+J` opens it directly.
4. Paste the complete script into the Console and press **Enter** once. It uses your existing ESPN browser session; you do not enter a password, token, or cookie into the script. If the browser prevents pasting, use the manual alternative below rather than changing browser security settings.
5. Wait for the console message **“Croc Bois export finished”**. The script requests each year sequentially. A slow request times out after 25 seconds; successful years are retained if another year fails.
6. Save **`croc-bois-playoff-history.json`**. If the automatic download does not start, click the green download link added to the bottom-right corner of the ESPN page. The link remains available while that page is open.
7. Attach that JSON file in this chat. If the console reports failures, attach the partial export anyway and supply the missing years with the manual list below.

The script does not change the ESPN league. The downloaded file contains only league/season IDs, the playoff-team count, fantasy team IDs and optional team labels, `WINNERS_BRACKET` matchup IDs/periods/team IDs, and source URL/fetch time. When ESPN supplies them, it also includes each team's `record.overall.wins/losses/ties`, positive `playoffSeed` and `rankCalculatedFinal`, and each championship matchup's `winner` and finite `home/away.totalPoints`. Missing optional statistics stay absent; a recorded zero remains zero. It excludes league members, owner/account IDs, rosters, passwords, cookies, tokens, and response headers. Nothing is uploaded automatically.

ESPN's `record.overall.wins` may count category results rather than weekly matchup victories, depending on the league format. The export preserves ESPN's recorded numbers without relabeling or recalculating them. Championship scores can be zero even when ESPN records a winner; championship verification must check the actual final bracket and winner/rank evidence, not just compare scores.

## What happens when a year is unavailable

Each year starts with ESPN's standard read endpoint:

```text
https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/YEAR/segments/0/leagues/139935
```

The requests use the `mTeam`, `mSettings`, `mMatchupScore`, and `mMatchup` views. Only a standard-route **HTTP 404** permits one fallback to ESPN's historical route:

```text
https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/leagueHistory/139935?seasonId=YEAR
```

The same view parameters are attached to that fallback. An HTTP 401 or 403 records a failure for that year; it never triggers another authentication method or an alternative route. Sign in normally and verify league access before trying again. Network/cross-origin restrictions, timeouts, rate limits, and unsupported historical responses are also recorded separately by year.

The file's `failures` array names each missing or partial season and its status/message. A status of `0` means no usable HTTP response was available; `200` with a failure means ESPN responded but required data was missing or inconsistent. When the league, season, team list, and playoff setting are valid but the bracket is absent or malformed, the file retains the observed team records with an empty `schedule` and an explicit failure for that same season. This preserves possible wins evidence, including a season that ended without playoffs, without inventing qualifiers or a champion. A season can therefore appear in both `seasons` and `failures`.

Missing playoff counts, team IDs, or matchups are never inferred from standings. Invalid league/season identity or team/settings data prevents that season's export. An unusual bracket or bye needs manual review. The importer will independently validate the four-team championship bracket before accepting its qualifiers; an empty schedule provides no playoff qualification or championship evidence.

## Manual alternative

For any unsupported year, use ESPN's season selector and open that season's playoff bracket. List the **four teams that entered the championship bracket**. Include the semifinal teams, not only the two finalists, and exclude the consolation bracket.

Copy this list into chat and replace each blank with the four team names or team IDs shown by ESPN. Leave an unknown year marked **unknown** rather than guessing from final standings.

| ESPN season | Basketball season | Four championship-bracket teams |
|---|---|---|
| 2018 | 2017–18 | — |
| 2019 | 2018–19 | — |
| 2020 | 2019–20 | — |
| 2021 | 2020–21 | — |
| 2022 | 2021–22 | — |
| 2023 | 2022–23 | — |
| 2024 | 2023–24 | — |
| 2025 | 2024–25 | — |
| 2026 | 2025–26 | — |

If a season ended without a championship bracket, say so explicitly. The absence of a bracket is not evidence that no teams qualified.

For missing podium evidence, also provide that season's champion and each team's recorded overall wins/losses/ties, including whether ESPN is displaying category wins or matchup wins. Unknown values can stay unknown.
