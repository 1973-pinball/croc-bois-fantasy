import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest } from 'next/server';
import { updateSession } from '../../src/lib/supabase/proxy';

// All credentials and identities in this file are invented. The fetch stub rejects
// every URL outside this fixture's auth endpoint; no real account/network is used.
const project = 'https://persistence-fixture.supabase.co';
const publicKey = 'fixture-public-key';
const cookieName = 'sb-persistence-fixture-auth-token';
const user = { id: '00000000-0000-4000-8000-000000000123', email: 'returning-manager@example.invalid', aud: 'authenticated', role: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'google' }, user_metadata: { full_name: 'Fixture Manager' }, identities: [] };
type Cookie = { name: string; value: string; options: CookieOptions };
type Call = { path: string; method: string; body: Record<string, unknown> | null };
function token(expiresAt: number) {
  return [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: expiresAt - 3600, exp: expiresAt })).toString('base64url'), Buffer.from('fixture-signature-verified-by-fake-auth-server').toString('base64url')].join('.');
}
function session(expiresAt: number, refreshToken = 'fixture-original-refresh') {
  return { access_token: token(expiresAt), refresh_token: refreshToken, expires_at: expiresAt, expires_in: 3600, token_type: 'bearer', user };
}
function encoded(value: unknown) { return 'base64-' + Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decoded(value: string) { assert.ok(value.startsWith('base64-')); return JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8')); }
function cookieHeader(cookies: { name: string; value: string }[]) { return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '); }
function cookieClient(initial: { name: string; value: string }[] = []) {
  const jar = new Map(initial.map(cookie => [cookie.name, cookie.value]));
  const writes: Cookie[] = [];
  const client = createServerClient(project, publicKey, { cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (cookies) => { for (const cookie of cookies) { writes.push(cookie); if (cookie.options.maxAge === 0) jar.delete(cookie.name); else jar.set(cookie.name, cookie.value); } },
  } });
  return { client, jar, writes, header: () => cookieHeader([...jar].map(([name, value]) => ({ name, value }))) };
}
async function withFakeAuth(run: (calls: Call[], refreshed: ReturnType<typeof session>) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, oldKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const calls: Call[] = [], refreshed = session(Math.floor(Date.now() / 1000) + 3600, 'fixture-rotated-refresh');
  process.env.NEXT_PUBLIC_SUPABASE_URL = project; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publicKey;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    assert.equal(url.origin, project, 'A fixture must never call an external service');
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ path: url.pathname + url.search, method, body });
    if (url.pathname === '/auth/v1/user' && method === 'GET') return Response.json(user);
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token' && method === 'POST') {
      assert.equal(body?.refresh_token, 'fixture-original-refresh');
      return Response.json(refreshed);
    }
    if (url.pathname === '/auth/v1/logout' && url.searchParams.get('scope') === 'local' && method === 'POST') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture auth request: ${url.pathname}`);
  };
  try { await run(calls, refreshed); }
  finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = oldKey;
  }
}

test('real Supabase SSR writes persistent cookies instead of cookies limited to one browser session', () => withFakeAuth(async () => {
  const stored = cookieClient(), fresh = session(Math.floor(Date.now() / 1000) + 3600);
  const result = await stored.client.auth.setSession({ access_token: fresh.access_token, refresh_token: fresh.refresh_token });
  assert.equal(result.error, null); assert.equal(result.data.user?.email, user.email);
  const authCookie = stored.writes.find(cookie => cookie.name === cookieName);
  assert.ok(authCookie); assert.equal(authCookie.options.maxAge, 400 * 24 * 60 * 60); assert.equal(authCookie.options.path, '/'); assert.equal(authCookie.options.sameSite, 'lax');
  assert.equal(decoded(authCookie.value).refresh_token, fresh.refresh_token);
}));

test('actual app proxy refreshes an expired token and forwards renewed cookies to both request and response', () => withFakeAuth(async (calls, refreshed) => {
  const expired = session(Math.floor(Date.now() / 1000) - 3600);
  const request = new NextRequest('https://league.example.invalid/', { headers: { cookie: cookieHeader([{ name: cookieName, value: encoded(expired) }]) } });
  const response = await updateSession(request);
  assert.equal(calls.filter(call => call.path === '/auth/v1/token?grant_type=refresh_token').length, 1);
  assert.equal(calls.some(call => call.path === '/auth/v1/user'), true);
  const saved = response.cookies.get(cookieName);
  assert.ok(saved); assert.equal(saved.maxAge, 400 * 24 * 60 * 60); assert.equal(saved.sameSite, 'lax'); assert.equal(saved.path, '/');
  assert.equal(decoded(saved.value).access_token, refreshed.access_token);
  assert.equal(decoded(request.cookies.get(cookieName)!.value).refresh_token, refreshed.refresh_token);
  assert.match(response.headers.get('x-middleware-request-cookie') || '', new RegExp(cookieName));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
}));

test('a new returning request recovers the same verified email from the renewed cookie without Google sign-in', () => withFakeAuth(async (calls) => {
  const old = session(Math.floor(Date.now() / 1000) - 3600);
  const first = await updateSession(new NextRequest('https://league.example.invalid/', { headers: { cookie: cookieHeader([{ name: cookieName, value: encoded(old) }]) } }));
  const retained = first.cookies.getAll().filter(cookie => cookie.maxAge !== 0);
  calls.length = 0;
  const second = await updateSession(new NextRequest('https://league.example.invalid/', { headers: { cookie: cookieHeader(retained) } }));
  const reopened = cookieClient(retained);
  const result = await reopened.client.auth.getUser();
  assert.equal(result.error, null); assert.equal(result.data.user?.id, user.id); assert.equal(result.data.user?.email, user.email);
  assert.equal(calls.some(call => call.path.startsWith('/auth/v1/token') || call.path.includes('authorize')), false);
  assert.equal(second.cookies.getAll().some(cookie => cookie.maxAge === 0), false);
}));

test('explicit local sign-out clears the persisted auth cookie so later visits do not silently sign back in', () => withFakeAuth(async (calls) => {
  const stored = cookieClient([{ name: cookieName, value: encoded(session(Math.floor(Date.now() / 1000) + 3600)) }]);
  const result = await stored.client.auth.signOut({ scope: 'local' });
  assert.equal(result.error, null); assert.equal(calls.some(call => call.path === '/auth/v1/logout?scope=local'), true);
  assert.ok(stored.writes.some(cookie => cookie.name === cookieName && cookie.options.maxAge === 0));
  assert.equal(stored.jar.has(cookieName), false);
  calls.length = 0;
  const reopened = cookieClient([...stored.jar].map(([name, value]) => ({ name, value })));
  const missing = await reopened.client.auth.getUser();
  assert.equal(missing.data.user, null); assert.equal(calls.length, 0);
}));
