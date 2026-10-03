import { NextResponse } from 'next/server';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isGoogleSignInEnabled, safeNextPath } from '@/lib/supabase/config';
import { json, setupResponse } from '@/lib/supabase/http';

export async function GET(request: Request) {
  const client = await createClient();
  if (!client) return setupResponse();
  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configuredOrigin && process.env.NODE_ENV === 'production') return json({ error: 'SETUP_REQUIRED', message: 'Set NEXT_PUBLIC_SITE_URL to the deployed app origin before enabling Google sign-in.' }, 503);
  const next = safeNextPath(requestUrl.searchParams.get('next'));
  // A returning PWA can reach this URL before its account UI has reloaded.
  // Validate the remembered session and reuse it instead of starting OAuth again.
  const { data: session, error: sessionError } = await client.auth.getUser();
  if (session.user && !sessionError) return NextResponse.redirect(new URL(next, configuredOrigin || requestUrl.origin), { headers: { 'Cache-Control': 'private, no-store' } });
  if (sessionError && (isAuthRetryableFetchError(sessionError) || (sessionError.status ?? 0) >= 500)) return json({ error: 'SESSION_UNAVAILABLE', message: 'Your saved sign-in could not be checked. Please try again when your connection returns.' }, 503);
  if (!isGoogleSignInEnabled()) return json({ configured: true, googleSignInEnabled: false, error: 'GOOGLE_SIGN_IN_DISABLED', message: 'Google sign-in is not enabled yet. You can still browse the public league pages.' }, 503);
  const callback = new URL('/auth/callback', configuredOrigin || requestUrl.origin);
  callback.searchParams.set('next', next);
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback.toString(), queryParams: { prompt: 'select_account' } } });
  if (error || !data.url) return json({ error: 'OAUTH_UNAVAILABLE', message: 'Google sign-in is unavailable. Check the Google provider configuration in Supabase.' }, 503);
  return NextResponse.redirect(data.url, { headers: { 'Cache-Control': 'private, no-store' } });
}
