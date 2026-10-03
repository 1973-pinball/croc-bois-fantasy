import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('history maintenance help works without loading credentials or making requests', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sync-espn-history.ts', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*--status/);
});

test('history maintenance CLI can load the Next server service on the supported Node runtime', () => {
  const entrypoint = pathToFileURL(path.resolve('scripts/sync-espn-history.ts')).href;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    globalThis.fetch = () => { throw new Error('Loading must not make requests'); };
    const { loadHistoryService } = await import(${JSON.stringify(entrypoint)});
    const service = await loadHistoryService();
    if (typeof service.synchronizeHistory !== 'function' || typeof service.readHistorySyncStatus !== 'function') throw new Error('Service exports missing');
    console.log('History service loaded');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'History service loaded');
});
