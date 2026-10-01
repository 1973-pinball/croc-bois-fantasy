import { NextResponse } from 'next/server';
import { createClient } from './server';
import { SETUP_MESSAGE } from './config';

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function setupResponse() {
  return json({ error: 'SETUP_REQUIRED', message: SETUP_MESSAGE, configured: false }, 503);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

export async function authenticatedClient() {
  const client = await createClient();
  if (!client) return { response: setupResponse() } as const;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { response: json({ error: 'UNAUTHENTICATED', message: 'Sign in to continue.' }, 401) } as const;
  return { client, user: data.user } as const;
}

export function rpcError(error: { code?: string; message: string }) {
  const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 :
    ['P0001', '23505', '23503', '23514', '40001'].includes(error.code ?? '') ? 409 : 500;
  return json({ error: status === 500 ? 'DATABASE_ERROR' : 'VALIDATION_FAILED', message: status === 500 ? 'The database could not complete this request. Check the project migrations and try again.' : error.message }, status);
}

export async function readJson(request: Request) {
  const body = await request.text();
  if (body.length > 32_768) throw new Error('Request body too large');
  return JSON.parse(body) as unknown;
}
