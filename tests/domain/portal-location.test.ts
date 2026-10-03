import assert from 'node:assert/strict';
import test from 'node:test';
import { portalHref, readPortalLocation } from '../../src/lib/portal-location';

test('shared team and draft destinations restore their filters', () => {
  const href = portalHref('?view=teams&labTeam=3', { view: 'draft', team: 4, draftView: 'archive', year: 2025, roster: 'Curry', sort: 'cost:descending' });
  const location = readPortalLocation(href.slice(1));
  assert.equal(location.view, 'draft');
  assert.equal(location.teamId, 4);
  assert.equal(location.draftView, 'archive');
  assert.equal(location.draftYear, '2025');
  assert.equal(location.search, 'Curry');
  assert.deepEqual(location.sort, { column: 'cost', direction: 'descending' });
  assert.match(href, /labTeam=3/);
});
test('invalid URL choices fall back safely and charter anchors preserve context', () => {
  const value = readPortalLocation('?view=unknown&team=oops&sort=invalid:up&year=no&draftView=wrong');
  assert.equal(value.view, 'overview');
  assert.equal(value.teamId, null);
  assert.equal(value.draftYear, null);
  assert.deepEqual(value.sort, { column: 'player', direction: 'ascending' });
  assert.equal(readPortalLocation('', '#charter-2').view, 'charter');
  assert.equal(readPortalLocation('', '', 'audit').view, 'audit');
});
test('clearing filters removes them without dropping other context', () => {
  assert.equal(portalHref('?view=teams&team=2&roster=Curry&all=1', { roster: '', all: false }), '/?view=teams&team=2');
  assert.equal(portalHref('?view=teams', { view: 'audit' }), '/audit');
});

test('expansion franchises retain their negative public IDs', () => {
  assert.equal(readPortalLocation('?view=teams&team=-4').teamId, -4);
  assert.equal(readPortalLocation('?team=0').teamId, null);
});
