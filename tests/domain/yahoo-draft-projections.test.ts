import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftPlayerCatalog } from '../../src/lib/draft-player-catalog';
import { fetchYahooDraftProjections, parseYahooProjectionPage, YAHOO_PROJECTION_URL } from '../../src/lib/yahoo-draft-projections';

const columns = ['Players', 'Roster Status', 'Games Played', 'Field Goals Made', 'Field Goals Attempted', 'Free Throws Made', 'Free Throws Attempted', '3-point Shots Made', 'Points Scored', 'Total Rebounds', 'Assists', 'Steals', 'Blocked Shots', 'Turnovers'];
type Player = { id: number; name: string; label?: string; values?: Partial<Record<string, string>> };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function page(players: Player[], options: { next?: number; headings?: string[]; mode?: string; season?: number; status?: string; nextUrl?: string } = {}) {
  const headings = options.headings ?? columns;
  const next = options.nextUrl ?? (options.next === undefined ? null : `/nba/842/players?status=ALL&eteam=ALL&fteam=NONE&pos=P&cut_type=33&stat1=S_PSR&myteam=0&sort=OR&sdir=1&count=${options.next}`);
  const values: Record<string, string> = { 'Roster Status': 'Unrelated league owner', 'Games Played': '70', 'Field Goals Made': '700', 'Field Goals Attempted': '1,400', 'Free Throws Made': '350', 'Free Throws Attempted': '420', '3-point Shots Made': '140', 'Points Scored': '1890', 'Total Rebounds': '560', Assists: '420', Steals: '70', 'Blocked Shots': '35', Turnovers: '210' };
  return `<html><body><select name="status"><option value="${options.status ?? 'ALL'}" selected>All Players</option></select>
    <select name="stat1"><optgroup label="Projected Stats"><option selected value="${options.mode ?? 'S_PSR'}">Remaining Games (proj)</option></optgroup><option value="S_S_${options.season ?? 2026}">Season (total)</option><option value="S_S_2025">2025-26 Season (total)</option></select>
    <table><tr><th colspan="${headings.length}">Public projections</th></tr><tr>${headings.map(title => `<th class="heading" title="${title}">${title}</th>`).join('')}</tr>
      ${players.map(player => `<tr>${headings.map(title => `<td>${title === 'Players' ? `<a title="${escape(player.name)}" data-ys-playerid="${player.id}" href="https://sports.yahoo.com/nba/players/${player.id}" class="Nowrap name playernote">${escape(player.label ?? player.name)}</a>` : player.values?.[title] ?? values[title] ?? '0'}</td>`).join('')}</tr>`).join('')}
    </table>${next ? `<a href="${escape(next)}">Next 25</a>` : ''}</body></html><!-- Yahoo footer -->`;
}
const players = Array.from({ length: 27 }, (_, index) => ({ id: 9000 + index, name: `Player ${index}` }));
const catalog = { espnSeasonId: 2027, players: players.map((player, index) => ({ id: 1000 + index, name: player.name })) } as Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>;
const response = (html: string, status = 200) => new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('reads full names, not abbreviations, Yahoo IDs or unrelated public owners; handles reordered header columns', () => {
  const input = { id: 1, name: 'Nickeil Alexander-Walker', label: 'N. Alexander-Walker' };
  const result = parseYahooProjectionPage(page([input], { headings: [...columns].reverse() }), 2027);
  assert.equal(result.rowCount, 1); assert.equal(result.nextOffset, null);
  assert.equal(result.players[0].name, input.name);
  assert.deepEqual(result.players[0].totals, { fgm: 700, fga: 1400, ftm: 350, fta: 420, three: 140, pts: 1890, reb: 560, ast: 420, stl: 70, blk: 35, tov: 210 });
  assert.equal(result.players[0].games, 70);
  assert.ok(!JSON.stringify(result).includes('Unrelated league owner'));
});

test('rejects actual statistics, historical seasons, partial player filters and truncated HTML', () => {
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1), { mode: 'S_AS_2025' }), 2027), /did not return remaining-season/);
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1), { season: 2025 }), 2027), /does not match/);
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1), { status: 'A' }), 2027), /complete player pool/);
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1)).replace('</html>', ''), 2027), /incomplete projection page/);
});

test('requires all counting categories and shooting volumes and rejects malformed rows', () => {
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1), { headings: columns.filter(title => title !== 'Free Throws Attempted') }), 2027), /missing required/);
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1), { headings: [...columns, 'Assists'] }), 2027), /duplicate projection columns/);
  assert.throws(() => parseYahooProjectionPage(page([{ ...players[0], values: { 'Games Played': '83' } }]), 2027), /invalid projected games/);
  assert.throws(() => parseYahooProjectionPage(page([{ ...players[0], values: { 'Field Goals Made': '1,500' } }]), 2027), /inconsistent shooting/);
  assert.throws(() => parseYahooProjectionPage(page(players.slice(0, 1)).replace('<td>70</td>', ''), 2027), /incomplete player row/);
});

test('missing statistics and zero or missing games are excluded, never replaced with zeros', () => {
  const result = parseYahooProjectionPage(page([
    players[0], { ...players[1], values: { 'Games Played': '0' } },
    { ...players[2], values: { 'Games Played': '-' } }, { ...players[3], values: { Steals: '-' } },
  ]), 2027);
  assert.equal(result.players.length, 1); assert.equal(result.excluded, 3); assert.equal(result.rowCount, 4);
});

test('pagination rejects missing, partial, looping, foreign and wrong-mode next-page links', () => {
  const first = players.slice(0, 25);
  assert.throws(() => parseYahooProjectionPage(page(first), 2027), /complete projection pool/);
  assert.throws(() => parseYahooProjectionPage(page(first.slice(0, 24), { next: 25 }), 2027), /incomplete projection page before/);
  for (const nextUrl of [
    'https://attacker.invalid/nba/842/players?count=25',
    `${YAHOO_PROJECTION_URL}?status=ALL&pos=P&stat1=S_AS_2025&count=25`,
    `${YAHOO_PROJECTION_URL}?status=ALL&eteam=ALL&fteam=NONE&pos=P&cut_type=33&stat1=S_PSR&myteam=0&sort=OR&sdir=1&count=0`,
  ]) assert.throws(() => parseYahooProjectionPage(page(first, { nextUrl }), 2027), /unexpected projection page link/);
  assert.equal(parseYahooProjectionPage(page(first, { next: 25 }), 2027).nextOffset, 25);
});

test('fetches every page from the fixed public context, converts totals, preserves source identity and marks availability unknown', async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const dataset = await fetchYahooDraftProjections(2027, catalog, async (input, options) => {
    const url = String(input); requests.push({ url, options });
    return response(new URL(url).searchParams.has('count') ? page(players.slice(25)) : page(players.slice(0, 25), { next: 25 }));
  });
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, new URL(YAHOO_PROJECTION_URL).origin);
    assert.equal(options?.redirect, 'manual'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.cache, 'no-store');
    assert.equal(new Headers(options?.headers).get('cookie'), null); assert.equal(new Headers(options?.headers).get('authorization'), null);
    assert.ok(options?.signal);
  }
  assert.equal(dataset.players.length, 27); assert.equal(dataset.source, 'yahoo'); assert.equal(dataset.seasonId, 2027);
  assert.equal(dataset.sourceLabel, 'Yahoo remaining-season projections');
  assert.equal(dataset.players[0].id, 1000); assert.equal(dataset.players[0].stats.pts, 27); assert.equal(dataset.players[0].stats.fga, 20);
  assert.ok(dataset.players.every(player => player.games === null));
  assert.ok(dataset.warnings.some(warning => warning.includes('not scaled by remaining games / 82')));
  assert.ok(dataset.warnings.some(warning => warning.includes('27 Yahoo player rows across 2 pages')));
  assert.ok(Number.isFinite(Date.parse(dataset.importedAt)));
});

test('unique normalized full names map to ESPN catalog identities and unsupported names remain absent', async () => {
  const names = [ { id: 5352, name: 'Nikola Jokić' }, { id: 5, name: 'Unknown player' } ];
  const sourceCatalog = { espnSeasonId: 2027, players: [{ id: 3112335, name: 'Nikola Jokic' }] } as Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>;
  const dataset = await fetchYahooDraftProjections(2027, sourceCatalog, async () => response(page(names)));
  assert.deepEqual(dataset.players.map(({ id, name }) => ({ id, name })), [{ id: 3112335, name: 'Nikola Jokic' }]);
  assert.ok(dataset.warnings.some(warning => warning.includes('excluded')));
});

test('failed pages discard the whole refresh, do not retry rate limits or authentication, and reject repeated players', async () => {
  for (const status of [302, 401, 403, 429, 503]) {
    let calls = 0;
    await assert.rejects(fetchYahooDraftProjections(2027, catalog, async () => {
      calls++; return calls === 1 ? response(page(players.slice(0, 25), { next: 25 })) : response('', status);
    }), /Yahoo/);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(fetchYahooDraftProjections(2027, catalog, async () => {
    calls++; return response(calls === 1 ? page(players.slice(0, 25), { next: 25 }) : page(players.slice(0, 2)));
  }), /repeated a player across/);
});

test('wrong season and oversized or non-HTML responses fail before usable data can be returned', async () => {
  let calls = 0;
  await assert.rejects(fetchYahooDraftProjections(2026, catalog, async () => { calls++; return response(''); }), /does not cover/);
  assert.equal(calls, 0);
  await assert.rejects(fetchYahooDraftProjections(2027, catalog, async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })), /unexpected projection format/);
  await assert.rejects(fetchYahooDraftProjections(2027, catalog, async () => new Response('large', { headers: { 'Content-Type': 'text/html', 'Content-Length': '5000000' } })), /unexpectedly large/);
});
