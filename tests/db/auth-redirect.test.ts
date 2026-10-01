import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupabaseConfig, isGoogleSignInEnabled, safeNextPath } from '../../src/lib/supabase/config';

test('OAuth next only permits local paths, including after decoding', () => {
  assert.equal(safeNextPath('/keepers?team=2#selection'),'/keepers?team=2#selection');
  for (const next of [null,'https://example.com','//example.com','/\\example.com','/%5cexample.com','/%2fexample.com','/%00evil','/%0d%0aLocation:evil','/%']) assert.equal(safeNextPath(next),'/',String(next));
});

test('Google sign-in requires an explicit release flag, independently of database configuration', () => {
  const previous = {
    flag: process.env.GOOGLE_OAUTH_ENABLED,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ']) {
      if (value === undefined) delete process.env.GOOGLE_OAUTH_ENABLED;
      else process.env.GOOGLE_OAUTH_ENABLED = value;
      assert.equal(isGoogleSignInEnabled(), false, `Flag ${String(value)} must not enable sign-in`);
      assert.notEqual(getSupabaseConfig(), null, 'The public database remains configured while Google sign-in is disabled');
    }
    process.env.GOOGLE_OAUTH_ENABLED = 'true';
    assert.equal(isGoogleSignInEnabled(), true);
  } finally {
    for (const [key, value] of Object.entries({
      GOOGLE_OAUTH_ENABLED: previous.flag,
      NEXT_PUBLIC_SUPABASE_URL: previous.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: previous.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
