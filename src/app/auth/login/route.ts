import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isGoogleSignInEnabled, safeNextPath } from '@/lib/supabase/config';
import { json, setupResponse } from '@/lib/supabase/http';

export async function GET(request: Request) {
  const client = await createClient();
  if (!client) return setupResponse();
  if (!isGoogleSignInEnabled()) return json({ configured: true, googleSignInEnabled: false, error: 'GOOGLE_SIGN_IN_DISABLED', message: 'Google sign-in is not enabled yet. You can still browse the public league pages.' }, 503);
  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configuredOrigin && process.env.NODE_ENV === 'production') return json({ error: 'SETUP_REQUIRED', message: 'Set NEXT_PUBLIC_SITE_URL to the deployed app origin before enabling Google sign-in.' }, 503);
  const callback = new URL('/auth/callback', configuredOrigin || requestUrl.origin);
  callback.searchParams.set('next', safeNextPath(requestUrl.searchParams.get('next')));
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback.toString(), queryParams: { prompt: 'select_account' } } });
  if (error || !data.url) return json({ error: 'OAUTH_UNAVAILABLE', message: 'Google sign-in is unavailable. Check the Google provider configuration in Supabase.' }, 503);
  return NextResponse.redirect(data.url, { headers: { 'Cache-Control': 'private, no-store' } });
}
