# Draft-slot choice lottery

Updated October 3, 2026. Open **Commissioner Tools → Run Lottery for Draft Order**, immediately above Official keeper submissions.

Migrations 00012–00013 and the [matching app](https://croc-bois-fantasy.vercel.app) are deployed. All 184 tests, type checking and the production build passed. Mocked browser checks verified every animation boundary and recovery path; read-only production checks verified actual ESPN inputs, permissions and the standalone replay page. On October 3 at 17:09 UTC, the commissioner's requested cleanup removed the practice draw, its saved test-result history and the published order marked “testing”. Production verification found zero saved draws/shares and eight unassigned slots, with unchanged keeper records, ownership and season settings. The official drawing has not happened.

The lottery determines the order in which franchises choose their draft slots. Priority 1 gets first choice of any slot. Under **Draft → Manage draft order**, a saved lottery now prefills an editable suggestion when no order has been published. The commissioner can adjust it and must explicitly press **Publish draft order** before the board changes. Existing published slots take precedence when editing. Everyone can view the published slot list; only commissioners can change it.

## Inputs and probabilities

The panel shows the completed 2025–26 ESPN regular-season standings, matching the commissioner's supplied screenshot. `data/lottery-standings.json` preserves source URLs, capture timestamps, SHA-256 hashes, regular-season ranks and records, and distinct postseason evidence. Regular-season ranks come from `playoffSeed` with the W–L–T records checked against the regular-season win percentages. Playoff qualification comes from the actual championship bracket. Postseason `rankCalculatedFinal` is separately corroborated by all four final placement games; it is not the displayed regular-season rank.

Fresh direct ESPN requests on October 3 verified both the 2026 standings and 2027 managers. The commissioner confirmed these aliases and last-to-first inputs:

| Regular-season place | Manager label | 2025–26 franchise | W–L–T | First-choice probability |
| --- | --- | --- | --- | --- |
| 8 | Wyndham | Antiques Roadshow | 62–98–2 | 24% |
| 7 | Sebastian | Luka Deez Nuts | 64–97–1 | 24% |
| 6 | Shane | Paramaribo Potoos | 70–91–1 | 24% |
| 5 | Alex | Double Trouble | 70–87–5 | 24% |
| 4 | Jon | Lo Fi Hip Hop Beats to Win To | 82–77–3 | 1% |
| 3 | Arod | Bizarre Bazaar | 89–71–2 | 1% |
| 2 | Amber | Sister Stumpy | 99–59–4 | 1% |
| 1 | James | DeepMind AI | 102–58–2 | 1% |

ESPN's current-season record confirms Sebastian owns franchise 4, now named The ManyFacedBron. Jon and Arod correspond to ESPN's Jonathan and Anthony. ESPN lists both Amber and Justin on Sister Stumpy; the commissioner explicitly selected Amber as that franchise's label. Each franchise receives one lottery entry, including co-managed teams. These display labels do not grant account access or rewrite historical manager assignments.

Each non-playoff team starts with **24%** of the first-choice probability; each playoff team starts with **1%**. After each selection, that franchise is removed and the same relative weights are renormalized over the remaining teams. All franchises in the same group have equal probabilities, regardless of their precise finishing place.

The commissioner clarified on October 3 that the first row governs and later rows are derived from it. The original Python notebook, `fantasy draft order.ipynb`, uses `numpy.random.choice(managers, len(managers), p=probabilities, replace=False)` with `[.24, .24, .24, .24, .01, .01, .01, .01]`. The website follows that weighted sampling without replacement. The original notebook is preserved unchanged; its historical manager list is not used to map the upcoming season's franchises.

The derived percentages for an individual team are:

| Choice priority | Non-playoff team | Playoff team |
| --- | ---: | ---: |
| 1 | 24.0000% | 1.0000% |
| 2 | 23.7065% | 1.2935% |
| 3 | 23.1611% | 1.8389% |
| 4 | 21.7695% | 3.2305% |
| 5 | 6.2564% | 18.7436% |
| 6 | 1.0060% | 23.9940% |
| 7 | 0.0960% | 24.9040% |
| 8 | 0.0044% | 24.9956% |

Each non-playoff team has a **92.6372%** chance of a top-four choice. There is a **28.0416%** chance that at least one playoff team receives a top-four choice. These are calculated from the script's actual distribution, rather than treating the charter's approximate later rows or “~33%” statement as additional constraints. The supplied sentence saying “one or more non-playoff teams” appears to mean playoff teams. The earlier implementation's fixed marginal matrix has been superseded for the production draw.

## Generate and preserve the result

A signed-in commissioner presses **Run Lottery** once. The database performs the same sequential weighted selection, using cryptographic randomness and unbiased integer tickets for each remaining weight total. It saves the result and audit record atomically. This production operation runs in PostgreSQL; TypeScript calculates the displayed probabilities. No Python process runs when the button is pressed. The code panel distinguishes the original Python method, the TypeScript probability calculation and the deployed SQL draw function, with hashes.

The saved result is presented through a lottery-ball animation on a charcoal stage with red and blue balls, confetti when a ball opens, and no visible countdown. The first choice appears after ten seconds, the second seven seconds later, the third five seconds later, and choices four through eight every two seconds afterward: 32 seconds total. These are choice priorities, not assigned draft slots. The animation does not generate additional randomness. Refreshing recovers the same saved result. **Replay animation** repeats it without a new draw or audit event. Reduced-motion preferences suppress the mixing effects, and Skip reveals the already saved order.

The saved result includes its time, eight-franchise priority order, per-choice tickets and entropy evidence, source hashes, weights and replay information. Only commissioners receive that full result. The public input endpoint reports whether a draw exists without exposing its priority order or random draws.

After a draw, **Share Lottery Results** creates a read-only replay link and copies it to the clipboard. Anyone with the link can view the charcoal animation and eight manager/team results without signing in; the page includes no commissioner controls, source panel or private audit. This is an explicit publication of the replay, separate from publishing draft slots. Repeat clicks return the same link. If clipboard access is blocked, a selectable link remains available for manual copying. The link replays the saved order and never runs another lottery. Deleted source results invalidate their shared replay.

A guided workflow enforcing the order in which owners choose positions remains future work. The commissioner can currently record and publish the agreed slots manually, using the lottery as an editable starting point.

There is one immutable official run per season. Double clicks or retries return the saved result; they do not reroll or create another audit event. If the response is interrupted, use **Refresh lottery** to recover the saved state. This screen has no reset/reroll control.

Commissioner Tools appears directly above Keeper cost audit in the main navigation. The tab is disabled for non-commissioners; hover or keyboard focus greys it and shows “get out of here james”. Commissioner access is also enforced when navigating and when the account role changes. Public league records and the read-only Manage draft order list remain accessible elsewhere. The draw does not assign draft slots, write public choice priority, reveal keepers, open selections, or alter roster/pick ownership. It is available only in setup, keeper selection or draft-ready phases with the verified eight participants and a four/four playoff split. Existing choice assignments, draft slots or any live selection history prevent the first draw.

## Source refresh and backend contract

`scripts/build-lottery-standings.ts` reconstructs the allowlisted public evidence from the private ESPN capture. Source responses and account identifiers stay out of public artifacts. A different season or participant set requires reviewed evidence and a matching immutable configuration; the app does not infer missing places or silently reuse another season's configuration.

Migration `20261003000012_draft_lottery.sql` installs the verified configuration, immutable run records and guarded read/draw functions. Applying it does not draw the lottery. `GET /api/draft-lottery?seasonId=UUID` checks league visibility and returns public inputs plus a commissioner-only result. `POST /api/draft-lottery` accepts only `{ "action": "generate", "seasonId": "UUID" }`, requires a same-origin authenticated request, and rechecks commissioner authority after the database league lock. The client cannot supply a seed, ticket, order or odds. Both responses are private and uncached.

Migration `20261003000013_draft_lottery_replays.sql` adds an immutable allowlisted replay snapshot with an unguessable UUID link. `POST /api/draft-lottery/share` accepts only `{ "seasonId": "UUID" }` from an authenticated same-origin commissioner and creates at most one share per saved run. It does not draw, assign slots or reveal keepers. `GET /api/draft-lottery/share?shareId=UUID` returns only dates, draft year and the eight ordered manager/team labels. Direct table reads/writes and share enumeration are unavailable to browser roles; source-run deletion cascades to the share. The public page is `/lottery-replay?shareId=UUID`.

Local database and mocked browser checks exercise generation, retry, privacy and access controls. Production verification must remain read-only until the commissioner intentionally runs the official draw. Do not generate a real result or assign real draft slots as a smoke test.
