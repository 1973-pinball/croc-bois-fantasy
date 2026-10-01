# Cloud setup

## Current league deployment

- Repository: [1973-pinball/croc-bois-fantasy](https://github.com/1973-pinball/croc-bois-fantasy).
- Public app: [croc-bois-fantasy.vercel.app](https://croc-bois-fantasy.vercel.app).
- Supabase: [croc-bois-fantasy](https://supabase.com/dashboard/project/jpdawgtemwfipdsvcqlb), project ref `jpdawgtemwfipdsvcqlb`, US East. The four migrations and one-time bootstrap seed have already been applied; do not run the seed again.
- Vercel: `studiopinball/croc-bois-fantasy`, connected to the repository. Production and Preview have the publishable Supabase settings and Google-disabled release gate.
- Google provider setup is deferred. No manager or commissioner account is authorized yet; the league is in `setup`.

The future Google Web application's authorized redirect URI is `https://jpdawgtemwfipdsvcqlb.supabase.co/auth/v1/callback`. Production app redirects already allow `https://croc-bois-fantasy.vercel.app/auth/callback`. Enter the client ID and secret directly in the project's Google provider settings, then enable the release flag and complete account assignments.

The instructions below cover configuration and recovery, not a request to create duplicate projects.

## Supabase

1. Create a Supabase project in your own organization and retain its database password in your password manager.
2. Apply the SQL files in `supabase/migrations` in filename order using the Supabase CLI or SQL editor. Do not put the service-role/secret key in browser code.
3. Run `supabase/seed.sql` once on the fresh database. It creates eight franchises, 111 frozen roster entries/profiles and 104 picks in the `setup` phase. It deliberately fails if the league already exists; never replay it over live state. Review provisional cost and tenure data before accepting submissions.
4. Copy the project URL and publishable key into `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
5. Once you have signed in, assign your actual auth user as commissioner through the trusted SQL process below. Owners cannot self-assign franchises or commissioner rights. The commissioner can then open keeper selection from the review screen.

The stable league ID is `4bda6ccb-0b37-47b2-8d9e-fe452603738d`. In Supabase's SQL editor, replace the placeholder with your verified user UUID from Authentication → Users:

```sql
insert into public.league_memberships (league_id, user_id, role)
values ('4bda6ccb-0b37-47b2-8d9e-fe452603738d', 'YOUR_VERIFIED_AUTH_USER_UUID', 'commissioner');
```

For each manager, add a membership with role `manager`, then attach the verified user UUID and confirmed effective dates to the matching imported `manager_assignments` row. The imported display names alone grant no access. Preserve historical assignments when an owner changes; create a new dated assignment for the same franchise. Do not match access by display name or email alone.

## Google sign-in

1. Create a Google Cloud project and configure its OAuth consent screen and an OAuth client of type Web application.
2. In Supabase Authentication → Sign In / Providers → Google, enter the Google client ID and secret.
3. Add the callback URL shown by Supabase (normally `https://<project-ref>.supabase.co/auth/v1/callback`) to Google's authorized redirect URIs.
4. In Supabase URL Configuration, set the deployed site URL and allow the exact app callback URLs: `http://localhost:3000/auth/callback` for development and `https://<your-domain>/auth/callback` for production.
5. Set `NEXT_PUBLIC_SITE_URL` to the app's canonical origin. Keep Google credentials in Supabase's provider configuration, never the public repository.
6. After the provider is configured, set `GOOGLE_OAUTH_ENABLED=true` in the app environment and redeploy. It is intentionally false while Google setup is deferred; public league data stays connected to Supabase.

Configure only the profile sign-in scopes (`openid`, email and profile). If the Google app is in testing mode, add the league's users as test users. Add your app's origin under authorized JavaScript origins. If you use `127.0.0.1` instead of `localhost` locally, allow its exact app callback too and use the same origin consistently.

References: [Google provider](https://supabase.com/docs/guides/auth/social-login/auth-google), [SSR clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client).

## Vercel

1. Import the public GitHub repository `1973-pinball/croc-bois-fantasy`.
2. Select Next.js and the repository root. The build command is `pnpm build`.
   The committed `vercel.json` supplies the Next.js preset and frozen-lockfile install. Set `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the exact pnpm version from `packageManager`.
3. Add the three public environment values above to the appropriate Vercel environments. Preview deployments need their own allowed callback origins if sign-in will be enabled there.
4. Deploy, then update Supabase's production site URL and redirect allowlist to the assigned Vercel domain.
5. Verify public browsing, Google login, invitation/membership mapping, private-submission isolation, owner editing, commissioner approval/locking and all-team reveal before league onboarding.

Reference: [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs).

## ESPN synchronization

The initial import is verified for March 29, 2026, scoring period 160. It is immutable eligibility evidence. Periodic imports must be staged for reconciliation and must never overwrite this frozen roster pool, keeper cost, tenure, committed picks or private submissions. Authenticated ESPN access and a scheduler still need configuration. Never commit ESPN cookies or use a current roster as a substitute for a historical snapshot.
