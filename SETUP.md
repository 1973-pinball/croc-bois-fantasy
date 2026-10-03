# Cloud setup

## Current league deployment

- Repository: [1973-pinball/croc-bois-fantasy](https://github.com/1973-pinball/croc-bois-fantasy).
- Public app: [croc-bois-fantasy.vercel.app](https://croc-bois-fantasy.vercel.app).
- Supabase: [croc-bois-fantasy](https://supabase.com/dashboard/project/jpdawgtemwfipdsvcqlb), project ref `jpdawgtemwfipdsvcqlb`, US East. The one-time bootstrap seed has already been applied; do not run it again. Apply new migrations with `supabase db push`.
- Vercel: `studiopinball/croc-bois-fantasy`, connected to the repository. Production and Preview have the publishable Supabase settings. Production has `GOOGLE_OAUTH_ENABLED=true`; Preview remains false until its callback URLs are configured.
- Google is enabled in Supabase, using the `croc_bois_fantasy` OAuth client. The initial verified commissioner and their team assignment are active; the league remains in `setup` pending the owner pilot and explicit season opening.
- Keeper-readiness migrations 00007–00008 shipped October 1, followed by migration 00009 and the established-rule audit/import updates on October 3. Production now has 100 confirmed, 11 ineligible profiles and zero items to reconcile. Dates remain unset; real-account keeper-workflow checks are still required.
- Migration 00010 and the League Lab/live draft release shipped October 3. The production build, 158 tests, type checking and desktop/mobile smoke checks passed. The live board has 104 blank spaces and a 1,095-player catalog; no order or selections were set by the release. See [draft administration](docs/LIVE_DRAFT.md) and [Lab methodology](docs/LEAGUE_LAB.md).
- Migration 00011 and its October 3 app follow-up allow assigned owners/co-managers to save private drafts during setup. Official submissions still require explicit opening. All 163 tests and the production build passed; no season settings or league records changed during migration. The app also includes keeper-eligibility filters, compact roster layouts and paginated Lab player appearances.
- Migrations 00012–00013 and the matching commissioner lottery/replay app are deployed. All 184 tests, type checking, production build and browser checks pass. The commissioner's October 3 practice draw and test order were cleared at their request; the official drawing has not happened. Explicit sharing creates a replay link, while draft slots require a separate Publish draft order action. See the [lottery guide](docs/DRAFT_LOTTERY.md).

The Google Web application's authorized redirect URI is `https://jpdawgtemwfipdsvcqlb.supabase.co/auth/v1/callback`. Production app redirects allow `https://croc-bois-fantasy.vercel.app/auth/callback`. Client credentials are entered directly in Supabase's Google provider settings, never committed. Initial Google sign-in, commissioner setup and team approval have been verified. Keeper-data reconciliation is complete. Verify the real owner/co-manager workflow and remaining assignments before official league-wide submissions.

The instructions below cover configuration and recovery, not a request to create duplicate projects.

## Supabase

1. Create a Supabase project in your own organization and retain its database password in your password manager.
2. Apply the SQL files in `supabase/migrations` in filename order using the Supabase CLI or SQL editor. Do not put the service-role/secret key in browser code.
3. Run the checked-in `supabase/seed.sql` once on the fresh database, then `supabase/apply-keeper-evidence-review.sql`. The seed preserves the original eight franchises, 111 frozen roster entries/profiles and 104 picks in the `setup` phase. The helper applies the eleven source-supported confirmations from migration 00008, followed by the 36 matching established-rule confirmations from migration 00009, producing 100 confirmed and 11 ineligible profiles without changing costs or ownership. Preserve the canonical seed and its source metadata; later corrections belong in guarded migrations. The seed deliberately fails if the league already exists; never replay it over live state. Existing deployments receive the same confirmations through the migrations.
4. Copy the project URL and publishable key into `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
5. Once you have signed in, assign your actual auth user as commissioner through the trusted SQL process below. Owners cannot self-assign franchises or commissioner rights. The commissioner can then open keeper selection from the review screen.

The stable league ID is `4bda6ccb-0b37-47b2-8d9e-fe452603738d`. In Supabase's SQL editor, replace the placeholder with your verified user UUID from Authentication → Users:

```sql
begin;
do $$
declare
  target_user uuid := 'YOUR_VERIFIED_AUTH_USER_UUID';
  target_league uuid := '4bda6ccb-0b37-47b2-8d9e-fe452603738d';
begin
  perform 1 from public.leagues where id=target_league for update;
  if not found then raise exception 'League not found'; end if;
  if exists (select 1 from public.league_memberships where league_id=target_league and role='commissioner' and active)
    then raise exception 'Initial commissioner already exists'; end if;
  if not exists (select 1 from auth.users u join auth.identities i on i.user_id=u.id
    where u.id=target_user and u.email_confirmed_at is not null and i.provider='google')
    then raise exception 'Verify the signed-in Google account before assigning access'; end if;
  insert into public.league_memberships (league_id,user_id,role,active)
    values (target_league,target_user,'commissioner',true)
    on conflict (league_id,user_id) do update set role='commissioner',active=true;
  insert into public.audit_events(league_id,event_type,entity_id,detail)
    values(target_league,'commissioner_bootstrapped',target_user,
      jsonb_build_object('method','trusted SQL administrator','user_id',target_user));
end $$;
commit;
```

This is a one-time trusted administrator step, never a public API or a first-person-to-sign-in rule. Independently verify the user's Google identity in Authentication → Users. The app's **My account → Account ID for setup** shows the signed-in user's UUID for comparison.

After bootstrap, use the app: owners sign in and request a franchise under **My Team**; **Commissioner Tools → Team access** lists pending requests with their account email. Confirm the person, select the matching historical manager identity (or create a new manager), and approve as manager or co-manager. Display names and email similarity never grant access automatically. A commissioner can request and approve their own team without changing their commissioner role.

An approved account receives a new dated assignment; imported historical rows stay intact. Future sign-ins open **My Team**, and refresh/window focus checks for newly approved or revoked access. Declined requests show the review reason and can be resubmitted; pending requests can be cancelled. Requests, account emails and review notes are private to the applicant and commissioner.

For a handover, end the outgoing account's access with a reason, then approve the incoming primary manager. Existing co-managers retain their own assignments. Ending a person's last current/future assignment downgrades their manager membership to viewer; future-only assignments cannot use trade tools before they begin. Ending a commissioner’s team assignment preserves their commissioner authority, which requires trusted administration to remove.

Migration 00007 adds the commissioner season-readiness overview and schedule administration, and strengthens keeper authorization after queued access changes. Apply the migrations before deploying the app version that reads the new schedule fields. No deadline or draft date is supplied automatically. See [keeper release readiness](docs/KEEPER_READINESS.md) for the account walkthrough and [cost review](docs/KEEPER_COST_REVIEW.md) for the established-rule resolution and retained historical exceptions.

## Google sign-in

1. Create a Google Cloud project and configure its OAuth consent screen and an OAuth client of type Web application.
2. In Supabase Authentication → Sign In / Providers → Google, enter the Google client ID and secret.
3. Add the callback URL shown by Supabase (normally `https://<project-ref>.supabase.co/auth/v1/callback`) to Google's authorized redirect URIs.
4. In Supabase URL Configuration, set the deployed site URL and allow the exact app callback URLs: `http://localhost:3000/auth/callback` for development and `https://<your-domain>/auth/callback` for production.
5. Set `NEXT_PUBLIC_SITE_URL` to the app's canonical origin. Keep Google credentials in Supabase's provider configuration, never the public repository.
6. After the provider is configured, set `GOOGLE_OAUTH_ENABLED=true` in the app environment and redeploy. Production is enabled; local and Preview environments remain disabled unless their own redirect configuration has been verified.

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

The initial import is verified for March 29, 2026, scoring period 160. It is immutable eligibility evidence. Periodic imports must be staged for reconciliation and must never overwrite this frozen roster pool, keeper cost, tenure, committed picks or private submissions. A separate daily statistics importer now stores ESPN season wins and playoff evidence in Supabase. See [automatic history setup](docs/ESPN_HISTORY_SYNC.md) for its private ESPN session connection and commissioner controls. Roster synchronization/reconciliation remains separate and unimplemented. Never commit ESPN cookies or use a current roster as a substitute for a historical snapshot.
