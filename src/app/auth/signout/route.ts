import { createClient } from '@/lib/supabase/server';
import { json, sameOrigin, setupResponse } from '@/lib/supabase/http';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const client = await createClient();
  if (!client) return setupResponse();
  const { error } = await client.auth.signOut({ scope: 'local' });
  return error ? json({ error: 'SIGNOUT_FAILED' }, 500) : json({ signedOut: true });
}
