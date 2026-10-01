# Automatic ESPN league history

The app stores ESPN season results in Supabase and refreshes them from the server. It does not require a recurring spreadsheet or JSON upload. Historical JSON export remains a recovery option for unsupported seasons.

## One-time private connection

For this private league, the importer needs the `espn_s2` and `SWID` cookies from your own signed-in ESPN session. These are session credentials, not Google OAuth credentials. Do not paste their values in chat, screenshots, GitHub, or source files.

1. Sign in normally at [Croc Bois on ESPN](https://fantasy.espn.com/basketball/league?leagueId=139935).
2. In Chrome or Edge, open Developer Tools → **Application** → **Storage → Cookies**. Select the ESPN origin that holds the cookies. Find `espn_s2` and `SWID`.
3. In [Vercel environment settings](https://vercel.com/studiopinball/croc-bois-fantasy/settings/environment-variables), add two **Production** secrets:
   - `ESPN_S2`: the exact `espn_s2` value.
   - `ESPN_SWID`: the exact `SWID` value, including its braces if present.
4. Redeploy after saving the environment changes. Open **Commissioner review → ESPN history** and choose **Update ESPN history** to verify the connection and start backfill.

The Supabase server key and random cron secret are configured separately by the app administrator. Neither is sent to the browser. If ESPN expires the session, replace the two ESPN values and redeploy. The app displays the connection failure and retains previously saved results.

## What runs automatically

- A production Vercel cron invokes `/api/cron/espn-history` daily at the scheduled 10:00 UTC hour. It requires the private `CRON_SECRET` header. Vercel Hobby schedules may run later within that hour.
- Each bounded batch backfills missing seasons from 2018 onward, prioritizing 2025 and 2026, and refreshes recent/current results. The commissioner button can advance backfill sooner.
- The current, unfinished ESPN season is retained separately from completed-season podium totals. An ESPN year is its ending year: `2026` means the 2025–26 basketball season.
- Each successful import preserves season identity, fantasy franchise identity, observed category wins, bracket evidence where available, retrieval time, and an input hash. Raw responses, members, account IDs and cookies are not published.
- Database leases prevent overlapping imports. Failures and missing brackets do not erase verified prior results, and changes retain audit snapshots.

The four participants in the first championship-bracket round determine playoff qualification. A champion requires declared semifinal winners and a declared winner of the final between those teams. Standings, seed, zero scores and missing values never substitute for a bracket. Unknown championship years prevent an all-time championship ranking. A season without a verified bracket can still contribute verified category-win totals.

The overview and Luckbox load stored Supabase history. Until the full ESPN win history is available, the overview labels the earlier recorded 2018–2024 totals and shows backfill coverage. Once all completed years have results, the podium uses ESPN totals including 2025, 2026 and future completed seasons. The wins-versus-trades correlation retains its separately labeled historical sample until comparable annual trade counts are available.

These are statistics imports only. They do not change keeper costs, tenure, frozen eligible rosters, pick ownership, trade terms, or Google team assignments.

References: [Vercel cron security and timing](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Supabase server-only secret keys](https://supabase.com/docs/guides/getting-started/api-keys).
