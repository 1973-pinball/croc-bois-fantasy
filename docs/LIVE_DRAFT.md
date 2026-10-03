# Live draft board

Updated October 3, 2026. Open **Draft → Live draft board**, above Draft Pick Grids.

Migration 00010 and the matching app are deployed. All 158 tests, type checking and the production build passed. Read-only production smoke verified the 1,095-player pool, 104 blank spaces, unchanged reconciled profiles, anonymous write rejection, and desktop/mobile layouts without runtime errors or viewport overflow. The release did not set order, record selections, reveal keepers or open the season.

## Before draft day

The board starts with 13 rounds and eight original slots. Owners stay blank until the commissioner saves a complete order. The existing pick grids below remain available for reviewing pick inventory and history.

Sign in as commissioner and expand **Manage draft order**. If slots have not been published, the editor loads the saved lottery order as an editable suggestion. Existing published slots take precedence when revisiting an assigned board. Adjust the franchises as needed, review the source note, and press **Publish draft order**. Opening the editor, loading the lottery, changing a dropdown and closing/reopening the editor do not publish anything. Edits remain local; if the board revision changes, explicitly load the current order before publishing. Losing the signed-in account, commissioner role or live connection clears the private editor.

The separate [lottery panel](DRAFT_LOTTERY.md) in Commissioner Tools generates the priority for choosing slots. Using that priority as the editor's default is the commissioner's requested starting point; it remains adjustable until submitted. Existing traded picks retain their current owners and original slots. Order changes stop after the first live selection, even if that selection is later removed.

Eight stable light franchise colors identify teams in the key, assigned slot headings, pick cells and order controls. Slot headings identify the original franchise; each pick cell uses its current owner's color, including traded picks. Names and trade attribution remain visible. Keeper cells retain a purple badge and accent; unassigned slots remain neutral.

Owners and visitors can also expand **Manage draft order** to view the slots. They see a read-only list, with unassigned slots labeled explicitly. Only commissioner accounts receive editing controls; the API and database independently enforce that permission.

Keeper selections remain private until every team's submission is locked. Once keepers are revealed and the order is complete, their payment picks appear purple on the grid. Kept players are greyed out in the player pool, with a purple keeper label, and cannot be selected again. Revealed keeper picks cannot be changed through draft corrections.

## Live team rosters

Deployed October 3 with 206 passing tests, a successful production build and desktop/mobile verification of all eight team views. The ESPN settings and eligibility were pulled directly at 2:55 p.m. Eastern time that day.

The live roster panel uses the public draft board to show each team's revealed keepers and recorded selections, with total players and occupied/open ESPN roster slots. It refreshes with the board and follows the current owner of traded picks; corrections and removed selections are reflected in the next board state. Choose a team to inspect its roster. Before publication/reveal, the panel shows the pending state rather than private keeper choices or the previous season's roster.

A fresh programmatic pull from ESPN league 139935, season 2027, on October 3 confirmed **PG ×1, SG ×1, SF ×1, PF ×1, C ×1, G ×1, F ×1, UTIL ×3 and BENCH ×3**: ten active slots and three bench slots. ESPN also configures **IR ×1**, shown separately. The public artifact records the source URLs, capture time and hashes. The player eligibility capture covers all 1,095 draft-catalog players and all 111 frozen keeper-roster players. Slot counts come from `settings.rosterSettings.lineupSlotCounts`; fit uses each player's actual `eligibleSlots`, including flexible positions, instead of inferring them from a primary position.

The suggested arrangement maximizes active-slot coverage and regular roster fit, with stable assignments when possible. It exposes unfilled slots, players without a fit and roster-size excess instead of hiding players. Each player counts once toward the team total. ESPN's configured lineup slots are distinct from per-position roster maximums: the current primary-position limits are unlimited, so a PG slot filled at 1/1 does not mean the team cannot draft another point guard. ESPN describes those settings separately in its [roster-settings guide](https://support.espn.com/hc/en-us/articles/115003902651-Roster-Settings).

IR is not automatically filled or counted as an extra ordinary draft slot. ESPN controls injury eligibility and placement; its [IR guide](https://support.espn.com/hc/en-us/articles/46839854416916-Move-a-Player-On-or-Off-Injured-Reserve-IR-or-Injured-List-IL) explains that only qualifying injury designations can use that slot. The panel is a suggested fit for planning, not a write to ESPN or a finalization of league player ownership. Position eligibility and league settings reflect the dated capture; live polling updates draft selections, not the ESPN settings snapshot.

Refresh the settings and eligibility with `node --import tsx scripts/build-draft-roster-settings.ts --fetch`, using the existing private ESPN environment credentials. Without `--fetch`, the command rebuilds from hash-verified private captures. It only makes GET requests, stores raw responses under ignored `.local/draft-roster-source/`, and publishes allowlisted `data/draft-roster-settings.json` and `data/draft-roster-eligibility.json`. It independently parses ESPN's official client constants for slot names and the unlimited-position sentinel without executing downloaded JavaScript. Wrong seasons, unknown slots, malformed settings and incomplete player coverage stop the build before either public artifact is replaced. The ranking catalog and database selection rules are unchanged.

## Recording and correcting picks

Live entry requires commissioner access, a complete draft order, revealed keepers, and the `draft_ready` phase. Choose an available player from the dropdown or ranking list and select **Record draft pick**. The server accepts only the next available pick in snake order, skipping keeper picks. The board records the franchise that owns the pick, including acquired picks.

Use **Edit** on a recorded selection to replace the player or remove that selection. Both actions require a reason. Removal makes that pick available again; the next entry fills the earliest available pick. Corrections retain the previous selection in the audit record. They do not change frozen keeper eligibility or current roster ownership.

All visible boards refresh every five seconds and when the page regains focus. A choice remains tied to the pick and revision visible when it was made. If another action changes the board, load the latest pick before submitting. The backend independently rejects stale revisions and duplicate players. An unsuccessful refresh preserves the last visible board and disables draft entry until a successful read.

Player trades pause once keepers are revealed, including proposals logged before reveal. The current ownership records still describe the pre-draft player pool; they cannot authorize a former owner to transfer a released or re-drafted player. Player trading can resume only after a future roster-finalization workflow is implemented. Pick-only trades and recorded obligations retain their existing review and ownership controls. Used or keeper-committed picks remain unavailable for transfer.

## Player pool and ranking source

The October 3 capture contains 1,095 players from ESPN's 2026–27 league pool, including unsigned and unranked players. ESPN supplies ROTO category ranks for 410; the remaining 685 follow alphabetically. By default, the list and dropdown show the top 200 players matching the selected filters. Searching by name searches the full catalog, including lower-ranked and unranked players; clearing the search returns to the top 200 matches. Search, position, keeper eligibility and availability filters apply to both controls. Keeper eligibility offers All players, Eligible keepers and Ineligible keepers; an unresolved profile appears only under All players. Already-kept players remain disabled when included by an eligibility filter, and Available players only hides them. Source metadata and the league's nine categories accompany the catalog.

The order uses ESPN's supplied `player.draftRanksByRankType.ROTO.rank`, not a newly calculated custom projection. The configured categories are PTS, REB, AST, STL, BLK, 3PM, FG%, FT% and TO. ESPN does not supply a separate verified custom-league weighted ranking in this capture; `rankingSource.customLeagueWeighting` is false. Keeper eligibility comes from the reviewed league profiles, independently of ranking or draft availability. An ineligible keeper can still be drafted.

The player pool is a dated artifact, not a live ESPN ranking feed. Rebuild `data/draft-player-catalog.json` from verified private captures using `scripts/build-team-preferences.ts`. Before deploying a refreshed pool, import the matching reduced `id`, `name`, and `selectable` fields through the database-owner-only `private.import_draft_player_catalog` function, supplying the capture SHA-256 and ESPN season. Omitted players cease to be selectable; previous selections retain their recorded names. Never expose ESPN session credentials or raw member/account data in public artifacts.

## Data and release contract

Migration `20261003000010_live_draft_board.sql` adds the catalog, append-only selection history with explicit voids, season draft revisions, and guarded read/write RPCs. The migration creates no draft selections or order assignments.

`GET /api/draft-board?seasonId=…` returns an allowlisted public board. Before keeper reveal, player and selection fields stay empty; before complete order, pick owners and positions stay empty. `POST /api/draft-board` requires a same-origin authenticated commissioner and dispatches `set_order`, `record`, `correct`, or `undo`. The database rechecks authorization after acquiring the league lock and records every mutation with its actor and revision. Direct browser writes to the underlying tables are prohibited.

Domain and PGlite checks cover authorization, privacy, exact catalog correspondence, duplicate players, snake order, traded pick ownership, stale revisions, corrections, and keeper protection. Browser checks use mocked writes for public/setup and commissioner flows, polling conflicts and mobile layouts. A full real-account draft rehearsal belongs in an isolated test season/database; do not reveal the live league merely to test these controls.

The commissioner can explicitly share a read-only lottery replay and separately publish an adjusted draft order. A guided position-choice workflow enforcing whose turn it is remains on the roadmap, along with ESPN draft delegation/transfer tracking, post-lock keeper payment changes, a user-facing correction history, and final roster/season rollover. Filling every pick does not automatically move the season into `in_season`.
