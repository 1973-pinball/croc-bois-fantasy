import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNextPath } from '@/lib/supabase/config';
import { json, setupResponse } from '@/lib/supabase/http';

export async function GET(request: Request) {
  const client = await createClient();
  if (!client) return setupResponse();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) return json({ error: 'OAUTH_FAILED', message: 'Google sign-in was cancelled or could not be completed. Return to the app and try again.' }, 400);
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return json({ error: 'OAUTH_FAILED', message: 'The sign-in link has expired or could not be verified. Start Google sign-in again.' }, 400);
  const origin = process.env.NEXT_PUBLIC_SITE_URL || url.origin;
  return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get('next')), origin), { headers: { 'Cache-Control': 'private, no-store' } });
}
