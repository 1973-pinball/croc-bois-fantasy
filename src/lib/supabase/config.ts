export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return { url, key };
}

/** Server-side release gate: connecting the database does not enable a Google provider. */
export function isGoogleSignInEnabled(): boolean {
  return process.env.GOOGLE_OAUTH_ENABLED === 'true';
}

export const SETUP_MESSAGE =
  'Connect a Supabase project and configure Google sign-in to enable league accounts and saved changes.';

/** Reject protocol-relative URLs, backslashes, controls and encoded redirect tricks. */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')) return '/';
    const url = new URL(value, 'https://local.invalid');
    if (url.origin !== 'https://local.invalid') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
