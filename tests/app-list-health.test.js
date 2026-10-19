import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApplicationHealthStore,
  selectApplicationRows,
  summarizeApplicationRows
} from '../app-list-health.js';

const idConfig = (id, placementId, overrides = {}) => ({
  id,
  network: overrides.network ?? 'Admob',
  groupTag: overrides.groupTag ?? 'L',
  placementId,
  metaSourceId: overrides.metaSourceId ?? '',
  ...overrides
});

function app(name, configs = [], overrides = {}) {
  return {
    id: overrides.id ?? `app-${name}`,
    name,
    title: overrides.title ?? '',
    pkg: overrides.pkg ?? '',
    dev: overrides.dev ?? '',
    formats: [{
      id: `format-${name}`,
      key: overrides.type ?? 'interstitial',
      name: '插屏',
      placements: [{
        id: `placement-${name}`,
        code: `${name}_inter`,
        mediation: overrides.mediation ?? 'Admob',
        segments: [{
          id: `segment-${name}`,
          name: '20',
          priority: 1,
          eCPM: 20,
          idConfigs: configs
        }]
      }]
    }]
  };
}

test('health store preserves existing application status semantics', () => {
  const apps = [
    app('empty'),
    app('ok', [idConfig('ok-1', 'ad-1')]),
    app('partial', [idConfig('partial-1', '')])
  ];
  const store = createApplicationHealthStore();
  store.refresh(apps);
  assert.deepEqual(apps.map(item => store.get(item).health.status), ['empty', 'ok', 'partial']);
});

test('top status counts are mutually exclusive and sum to total', () => {
  const apps = [
    app('empty'),
    app('ok', [idConfig('ok-1', 'ad-1')]),
    app('partial', [idConfig('partial-1', '')])
  ];
  const store = createApplicationHealthStore();
  store.refresh(apps);
  const summary = store.analysis().summary;
  assert.equal(
    summary.applicationStatuses.empty
      + summary.applicationStatuses.ok
      + summary.applicationStatuses.partial,
    summary.totalApplications
  );
});

test('exposes exact missing placement ID counts', () => {
  const target = app('missing', [
    idConfig('one', 'ad-1'),
    idConfig('two', ''),
    idConfig('three', null)
  ]);
  const store = createApplicationHealthStore();
  store.refresh([target]);
  assert.equal(store.get(target).health.counts.missingPlacementIds, 2);
  assert.equal(store.get(target).health.counts.filledPlacementIds, 1);
});

test('missing Meta IDs create candidates without changing application status', () => {
  const target = app('meta', [
    idConfig('one', 'ad-1', { metaSourceId: '' }),
    idConfig('two', 'ad-2', { metaSourceId: null })
  ]);
  const store = createApplicationHealthStore();
  store.refresh([target]);
  const entry = store.get(target);
  assert.equal(entry.health.status, 'ok');
  assert.equal(entry.candidates.missingMetaIds, 2);
  assert.equal(entry.candidates.hasCandidates, true);
});

test('duplicate candidates do not change confirmed application status', () => {
  const first = app('first', [idConfig('first-id', 'duplicate')]);
  const second = app('second', [idConfig('second-id', 'duplicate')]);
  const store = createApplicationHealthStore();
  store.refresh([first, second]);
  assert.equal(store.get(first).health.status, 'ok');
  assert.equal(store.get(second).health.status, 'ok');
  assert.equal(store.get(first).candidates.duplicatePlacementIds, 1);
  assert.equal(store.get(second).candidates.duplicatePlacementIds, 1);
});

test('combines search, status, type, size, and issue filters', () => {
  const alpha = app('alpha', [idConfig('a', '')], { title: 'Alpha Store', type: 'native' });
  const beta = app('beta', [idConfig('b', 'ad-b')], { title: 'Beta Store', type: 'native' });
  const gamma = app('gamma', [idConfig('g', '')], { type: 'interstitial' });
  const apps = [alpha, beta, gamma];
  const store = createApplicationHealthStore();
  store.refresh(apps);

  const result = selectApplicationRows(apps, {
    query: 'alpha',
    filters: { status: 'partial', issue: 'missing', type: 'native', size: '1-3' },
    healthFor: item => store.get(item)
  });
  assert.deepEqual(result.map(item => item.name), ['alpha']);
});

test('issue-first sorting keeps every application and prioritizes confirmed gaps', () => {
  const ok = app('ok', [idConfig('ok', 'ad-ok', { metaSourceId: 'meta-ok' })]);
  const candidate = app('candidate', [
    idConfig('candidate', 'ad-candidate', { metaSourceId: '' })
  ]);
  const missingOne = app('missing-one', [idConfig('one', '')]);
  const missingTwo = app('missing-two', [idConfig('two-a', ''), idConfig('two-b', '')]);
  const apps = [ok, missingOne, candidate, missingTwo];
  const store = createApplicationHealthStore();
  store.refresh(apps);

  const result = selectApplicationRows(apps, {
    filters: { sort: 'issue' },
    healthFor: item => store.get(item)
  });
  assert.equal(result.length, apps.length);
  assert.deepEqual(result.map(item => item.name), [
    'missing-two',
    'missing-one',
    'candidate',
    'ok'
  ]);
});

test('filter summaries report matching status and issue counts', () => {
  const empty = app('empty');
  const missing = app('missing', [idConfig('missing-id', '')]);
  const candidate = app('candidate', [
    idConfig('candidate-id', 'ad-candidate', { metaSourceId: '' })
  ]);
  const apps = [empty, missing, candidate];
  const store = createApplicationHealthStore();
  store.refresh(apps);
  assert.deepEqual(summarizeApplicationRows(apps, item => store.get(item)), {
    total: 3,
    statuses: { empty: 1, ok: 1, partial: 1 },
    missingApplications: 1,
    candidateApplications: 2
  });
});

test('refresh updates list health after an application mutation', () => {
  const target = app('mutable', [idConfig('id-1', '')]);
  const store = createApplicationHealthStore();
  store.refresh([target]);
  const firstRevision = store.revision();
  assert.equal(store.get(target).health.status, 'partial');

  target.formats[0].placements[0].segments[0].idConfigs[0].placementId = 'filled';
  store.refresh([target]);
  assert.equal(store.revision(), firstRevision + 1);
  assert.equal(store.get(target).health.status, 'ok');
  assert.equal(store.get(target).health.counts.missingPlacementIds, 0);
});

test('refresh after warehouse replacement does not retain stale entries', () => {
  const oldApp = app('old', [idConfig('old-id', '')]);
  const newApp = app('new', [idConfig('new-id', 'filled')]);
  const store = createApplicationHealthStore();
  store.refresh([oldApp]);
  assert.equal(store.get(oldApp).health.status, 'partial');

  store.refresh([newApp]);
  assert.equal(store.get(oldApp), null);
  assert.equal(store.get(newApp).health.status, 'ok');
  assert.equal(store.analysis().summary.totalApplications, 1);
});

test('name and recent sorting retain original functionality', () => {
  const alpha = app('alpha', [idConfig('a', 'a')], { id: 'app-100' });
  const beta = app('beta', [idConfig('b', 'b')], { id: 'app-200' });
  const store = createApplicationHealthStore();
  store.refresh([beta, alpha]);
  const healthFor = item => store.get(item);

  assert.deepEqual(
    selectApplicationRows([beta, alpha], { filters: { sort: 'name' }, healthFor })
      .map(item => item.name),
    ['alpha', 'beta']
  );
  assert.deepEqual(
    selectApplicationRows([alpha, beta], { filters: { sort: 'recent' }, healthFor })
      .map(item => item.name),
    ['beta', 'alpha']
  );
});
