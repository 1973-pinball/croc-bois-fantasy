import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../../src/lib/supabase/config';

test('OAuth next only permits local paths, including after decoding', () => {
  assert.equal(safeNextPath('/keepers?team=2#selection'),'/keepers?team=2#selection');
  for (const next of [null,'https://example.com','//example.com','/\\example.com','/%5cexample.com','/%2fexample.com','/%00evil','/%0d%0aLocation:evil','/%']) assert.equal(safeNextPath(next),'/',String(next));
});
