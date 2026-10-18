import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as candidateRanks from '../../src/lib/draft-candidate-ranks';
import type { DraftAdvisorReport } from '../../src/lib/draft-advisor';
import type { DraftCatalogPlayer, DraftPlayerCatalog } from '../../src/lib/draft-player-catalog';
import type { DraftProjectionDataset } from '../../src/lib/draft-projections';
import type { DraftCandidateTable } from '../../src/components/draft-candidate-table';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../../src/components/draft-candidate-table.tsx', import.meta.url), 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
const exports: Record<string, unknown> = {};
const dependencies: Record<string, unknown> = {
  react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
  '@/lib/draft-candidate-ranks': candidateRanks, './commissioner-strategy.module.css': {},
};
new Function('require', 'exports', code)((name: string) => {
  assert.ok(name in dependencies, `Unexpected component dependency: ${name}`);
  return dependencies[name];
}, exports);
const Component = exports.DraftCandidateTable as typeof DraftCandidateTable;
const players: DraftCatalogPlayer[] = [1, 2].map(id => ({ id, name: `Fixture player ${id}`, nbaTeam: 'BOS', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: id * 10, rankSource: 'ROTO', active: true, selectable: true }));
const catalog = { espnSeasonId: 2027, players } as DraftPlayerCatalog;
const candidates = players.map(player => ({ player, hasProjection: true, categoryWinRate: .5, categoryGain: 0, scheduleWinRate: .5, scheduleGain: 0, fitScore: .5,
  fitAdjustment: 0, scheduledGames: null, usableGames: null, reasons: [], blocked: false }));
const report: DraftAdvisorReport = { candidates, evaluatedCandidates: 2, available: true, unavailableReason: null, franchiseId: 'fixture-team', revision: 1,
  teams: [], selectedTeam: null, matchups: [], scheduleMatchups: [], topAvailable: [], fitRanking: [],
  categoryRecommendation: null, scheduleRecommendation: null, fitRecommendation: null, warnings: [], methodology: [], scheduleMode: 'equal_games' };
function dataset(source: DraftProjectionDataset['source'], ranked = true): DraftProjectionDataset {
  return { source, sourceLabel: source, seasonId: 2027, importedAt: '2026-10-18T00:00:00Z', warnings: [],
    players: players.map(player => ({ id: player.id, name: player.name, games: 70, ...(ranked ? { providerRank: player.id === 1 ? 20 : 1 } : {}),
      stats: { pts: 20, reb: 5, ast: 5, stl: 1, blk: 1, tov: 2, three: 2, fgm: 7, fga: 14, ftm: 4, fta: 5 } })) };
}
const base: ComponentProps<typeof DraftCandidateTable> = {
  catalog, report, seasonLoaded: false, forecastMode: true,
  library: { yahoo: dataset('yahoo'), 'basketball-monster': dataset('basketball-monster') },
  rankSnapshots: { 'basketball-monster': { source: 'basketball-monster', seasonId: 2027, importedAt: '2026-10-18T00:00:00Z', ranks: [{ id: 1, providerRank: 987 }] } },
  rankStatus: 'Private rank status fixture',
};
const render = (overrides: Partial<ComponentProps<typeof DraftCandidateTable>> = {}) => renderToStaticMarkup(createElement(Component, { ...base, ...overrides }));
const bodyRows = (html: string) => [...(html.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? '').matchAll(/<tr>(.*?)<\/tr>/g)].map(match => match[1]);

test('restricted available players use ESPN by default and expose only usable public rankings and forecast controls', () => {
  const html = render({ publicSourcesOnly: true });
  assert.match(html, /Available players · ESPN rank/);
  assert.match(html, /<option value="espn" selected="">ESPN rank<\/option>/);
  const select = html.match(/<select aria-label="Player ranking"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['espn', 'espn-after-keepers', 'yahoo', 'fit']);
  assert.match(select, /Completed-roster forecast/);
  assert.doesNotMatch(html, /BBM|Basketball Monster|Private rank status fixture|privately saved|Import |Upload |Refresh Yahoo projections above/);
  const rows = bodyRows(html);
  assert.match(rows[0], /Fixture player 1/); assert.match(rows[1], /Fixture player 2/);
  assert.equal((html.match(/<thead>(.*?)<\/thead>/)?.[1].match(/<th /g) ?? []).length, 9);
  assert.ok(rows.every(row => (row.match(/<td(?: |>)/g) ?? []).length === 9));
});

test('restricted missing Yahoo ranks and empty pools never direct users to unavailable import tools', () => {
  const html = render({ publicSourcesOnly: true, library: { yahoo: dataset('yahoo', false) } });
  assert.match(html, /Yahoo preseason ranks are unavailable\. ESPN ranks remain available\./);
  assert.doesNotMatch(html, /Import |Upload |Refresh Yahoo projections above|BBM/);
  assert.match(render({ publicSourcesOnly: true, report: null }), /<td colSpan="9">/);
});

test('commissioner available players retain the BBM default, private-source controls, status, and all comparison columns', () => {
  const html = render();
  assert.match(html, /Available players · ESPN − BBM/);
  assert.match(html, /<option value="bbm-value" selected="">/);
  assert.match(html, /<option value="bbm">/); assert.match(html, /Saved BBM ranked list:/);
  assert.match(html, /<option value="bbm-after-keepers">BBM after keepers<\/option>/);
  assert.match(html, /aria-label="Sort by BBM after keepers, ascending"/);
  assert.match(html, /Private rank status fixture/);
  assert.equal((html.match(/<thead>(.*?)<\/thead>/)?.[1].match(/<th /g) ?? []).length, 12);
  assert.ok(bodyRows(html).every(row => (row.match(/<td(?: |>)/g) ?? []).length === 12));
  assert.match(bodyRows(html)[0], /Fixture player 2/);
  assert.match(render({ library: {}, rankSnapshots: {} }), /Import Basketball Monster projections above/);
  assert.match(render({ report: null }), /<td colSpan="12">/);
});
