import { register } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load the server service without requiring Next's bundler or Node 22.15+. */
export async function loadHistoryService() {
  // Next normally resolves this build-time marker. Keep the exception scoped to
  // this explicit server CLI; node:module.register is supported throughout Node 22.
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context);
    }
  `)}`, import.meta.url);
  return import('../src/lib/espn-history-sync');
}

/** Trusted local server entrypoint; uses the same lease, extraction, protection and finish RPC as the app. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: pnpm exec tsx scripts/sync-espn-history.ts [--batches 1..5 | --status]');
    return;
  }
  const statusOnly = args.length === 1 && args[0] === '--status';
  const batches = args.length === 0 || statusOnly ? 1 : args.length === 2 && args[0] === '--batches' ? Number(args[1]) : NaN;
  if (!Number.isSafeInteger(batches) || batches < 1 || batches > 5) throw new Error('Use --batches with an integer from 1 through 5.');
  for (const name of ['.env.local', '.env.sync.local', '.env.espn.local']) {
    const file = path.resolve(process.cwd(), name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const { synchronizeHistory, readHistorySyncStatus, readPublicHistory } = await loadHistoryService();
  if (statusOnly) {
    const [status, saved] = await Promise.all([readHistorySyncStatus(), readPublicHistory()]);
    console.log(JSON.stringify({ configured: status.configured, needsConnection: status.needsConnection, running: status.running,
      coveredYears: status.coveredYears, pendingYears: status.pendingYears, failedYears: status.failedYears.map(item => ({ seasonId: item.seasonId, code: item.code })),
      seasons: saved.history.seasons.map(item => ({ year: item.espnSeasonId, qualifiers: item.qualifiedFranchiseIds, champion: item.championFranchiseId, proof: item.source.championship?.method || 'declared-winner' })),
      statisticsYears: saved.history.statsOnlySeasons?.map(item => item.espnSeasonId) || [] }));
    return;
  }
  for (let batch = 1; batch <= batches; batch++) {
    const result = await synchronizeHistory({ manual: true });
    console.log(JSON.stringify({ batch, configured: result.configured, needsConnection: result.needsConnection, running: result.running,
      attemptedYears: result.attemptedYears, savedYears: result.savedYears, coveredYears: result.coveredYears, pendingYears: result.pendingYears,
      failedYears: result.failedYears.map(item => ({ seasonId: item.seasonId, code: item.code })) }));
    if (result.needsConnection || result.running || result.attemptedYears.length === 0 || result.failedYears.some(item => item.code === 'ESPN_AUTH_REQUIRED')) break;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('ESPN history sync did not complete. Existing records were retained; inspect the private sync status before retrying.'); process.exitCode = 1; });
}
