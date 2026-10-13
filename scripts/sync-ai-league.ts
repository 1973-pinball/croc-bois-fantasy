import { existsSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: pnpm exec tsx scripts/sync-ai-league.ts [--season 2026|2027] [--batches 1..100] [--export]'); return; }
  const season = args.includes('--season') ? Number(args[args.indexOf('--season') + 1]) : undefined;
  const batches = args.includes('--batches') ? Number(args[args.indexOf('--batches') + 1]) : 1;
  if (season !== undefined && ![2026, 2027].includes(season) || !Number.isInteger(batches) || batches < 1 || batches > 100) throw new Error('Invalid CLI arguments');
  for (const name of ['.env.local', '.env.sync.local', '.env.espn.local']) if (existsSync(name)) process.loadEnvFile(path.resolve(name));
  register(`data:text/javascript,${encodeURIComponent("export async function resolve(s,c,n){return n(s==='server-only'?'next/dist/compiled/server-only/empty.js':s,c)}")}`, import.meta.url);
  const { synchronizeAiLeague, readAiLeague } = await import('../src/lib/ai-league-service');
  for (let batch = 0; batch < batches; batch++) {
    const result = await synchronizeAiLeague({ ...(season ? { seasons: [season] } : {}), maxDays: 3 });
    console.log(JSON.stringify({ batch: batch + 1, ...result }));
    if (result.errors.length) { process.exitCode = 1; break; }
    if (!result.saved.length) break;
  }
  const response = await readAiLeague();
  console.log(JSON.stringify(response.runs.map(run => ({ season: run.season, status: run.status, teams: run.teams.length, drafted: run.decisions.filter(d => d.kind === 'draft').length, dates: run.scoredDates.length, through: run.dataThrough, champion: run.champion }))));
  if (args.includes('--export')) {
    response.refresh.automatic = false;
    writeFileSync('data/ai-league.json', JSON.stringify(response));
  }
}
void main().catch(() => { console.error('Simulation refresh could not complete. Saved results were retained.'); process.exitCode = 1; });
