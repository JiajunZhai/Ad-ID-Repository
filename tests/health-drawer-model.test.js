import test from 'node:test';
import assert from 'node:assert/strict';

import { createApplicationHealthStore } from '../app-list-health.js';
import {
  buildApplicationIssueReport,
  describeRawValue,
  navigationTargetForIssue,
  selectIssueCategory
} from '../health-drawer-model.js';

const config = (id, placementId, overrides = {}) => ({
  id,
  network: overrides.network ?? 'Admob',
  groupTag: overrides.groupTag ?? 'L',
  placementId,
  metaSourceId: overrides.metaSourceId ?? '',
  ...overrides
});

function application(name, configs, overrides = {}) {
  return {
    id: `app-${name}`,
    name,
    title: overrides.title ?? '',
    pkg: overrides.pkg ?? '',
    formats: [{
      id: `format-${name}`,
      key: 'interstitial',
      name: '插屏',
      placements: [{
        id: `placement-${name}`,
        code: `${name}_inter`,
        mediation: overrides.mediation ?? 'Admob',
        segments: [{
          id: `segment-${name}`,
          name: overrides.segmentName ?? '20',
          priority: 1,
          eCPM: 20,
          idConfigs: configs
        }]
      }]
    }]
  };
}

function reportFor(apps, target) {
  const store = createApplicationHealthStore();
  store.refresh(apps);
  return buildApplicationIssueReport(target, store.get(target), store.analysis());
}

test('builds only categories that exist for the application', () => {
  const clean = application('clean', [
    config('clean-id', 'ad-1', { metaSourceId: 'meta-1', opState: 'running' })
  ]);
  const report = reportFor([clean], clean);
  assert.deepEqual(report.categories, []);
  assert.equal(report.overview.status, 'ok');
});

test('separates confirmed missing placement IDs from missing Meta candidates', () => {
  const target = application('missing', [
    config('one', '', { metaSourceId: '' }),
    config('two', 'ad-2', { metaSourceId: null })
  ]);
  const report = reportFor([target], target);
  const missingPlacement = report.categories.find(item => item.id === 'missingPlacementId');
  const missingMeta = report.categories.find(item => item.id === 'missingMetaId');
  assert.equal(missingPlacement.classification, 'confirmed');
  assert.equal(missingPlacement.itemCount, 1);
  assert.equal(missingMeta.classification, 'candidate');
  assert.equal(missingMeta.itemCount, 2);
  assert.equal(report.overview.status, 'partial');
});

test('keeps duplicate value group count separate from affected item count', () => {
  const first = application('first', [
    config('first-a', 'shared'),
    config('first-b', 'shared')
  ]);
  const second = application('second', [config('second-a', 'shared')]);
  const report = reportFor([first, second], first);
  const duplicate = report.categories.find(item => item.id === 'duplicatePlacementId');
  assert.equal(duplicate.groupCount, 1);
  assert.equal(duplicate.itemCount, 2);
  assert.equal(duplicate.groups[0].rawValue, 'shared');
});

test('enriches details with real format, placement, segment, and config locations', () => {
  const target = application('located', [config('config-located', '')], {
    segmentName: '高价值用户'
  });
  const report = reportFor([target], target);
  const detail = report.categories
    .find(item => item.id === 'missingPlacementId')
    .groups[0].occurrences[0];
  assert.deepEqual(
    {
      applicationName: detail.applicationName,
      formatName: detail.formatName,
      placementCode: detail.placementCode,
      segmentName: detail.segmentName,
      configId: detail.configId
    },
    {
      applicationName: 'located',
      formatName: '插屏',
      placementCode: 'located_inter',
      segmentName: '高价值用户',
      configId: 'config-located'
    }
  );
});

test('preserves readable representations for missing and whitespace values', () => {
  assert.deepEqual(describeRawValue(undefined, false), {
    kind: 'missing_field',
    label: '缺失字段',
    copyValue: null
  });
  assert.equal(describeRawValue(null).label, 'null');
  assert.equal(describeRawValue('').label, '空字符串');
  assert.equal(describeRawValue('   ').label, '"   "');
});

test('searches placement, segment, network, placement ID, and Meta ID fields', () => {
  const target = application('search', [
    config('one', 'ad-long-value', { network: 'Topon', metaSourceId: 'meta-search' }),
    config('two', '', { network: 'Admob', metaSourceId: '' })
  ], { segmentName: 'Premium Segment' });
  const report = reportFor([target], target);
  const missingMeta = report.categories.find(item => item.id === 'missingMetaId');
  assert.equal(selectIssueCategory(report, missingMeta.id, 'premium').itemCount, 1);
  assert.equal(selectIssueCategory(report, missingMeta.id, 'admob').itemCount, 1);
  assert.equal(selectIssueCategory(report, missingMeta.id, 'not-found').itemCount, 0);
});

test('preserves long original IDs without truncation in the model', () => {
  const longId = 'ca-app-pub-' + '1234567890'.repeat(20);
  const first = application('long-one', [config('one', longId)]);
  const second = application('long-two', [config('two', longId)]);
  const report = reportFor([first, second], first);
  const detail = report.categories
    .find(item => item.id === 'duplicatePlacementId')
    .groups[0].occurrences[0];
  assert.equal(detail.rawValue, longId);
  assert.equal(detail.rawDisplay.copyValue, longId);
});

test('returns navigation targets using existing model IDs', () => {
  const target = application('navigate', [config('config-nav', '')]);
  const report = reportFor([target], target);
  const detail = report.categories[0].groups[0].occurrences[0];
  assert.deepEqual(navigationTargetForIssue(detail), {
    appId: 'app-navigate',
    formatId: 'format-navigate',
    placementId: 'placement-navigate',
    segmentId: 'segment-navigate',
    configId: 'config-nav'
  });
});

test('candidate categories do not change the existing application status', () => {
  const first = application('status-one', [
    config('one', 'shared', { metaSourceId: '' })
  ]);
  const second = application('status-two', [config('two', 'shared')]);
  const report = reportFor([first, second], first);
  assert.equal(report.overview.status, 'ok');
  assert.ok(report.categories.some(item => item.id === 'missingMetaId'));
  assert.ok(report.categories.some(item => item.id === 'duplicatePlacementId'));
});

test('a refreshed store produces a fresh report without stale candidates', () => {
  const target = application('refresh', [config('one', '')]);
  const store = createApplicationHealthStore();
  store.refresh([target]);
  const before = buildApplicationIssueReport(target, store.get(target), store.analysis());
  assert.ok(before.categories.some(item => item.id === 'missingPlacementId'));

  target.formats[0].placements[0].segments[0].idConfigs[0].placementId = 'filled';
  target.formats[0].placements[0].segments[0].idConfigs[0].metaSourceId = 'meta';
  store.refresh([target]);
  const after = buildApplicationIssueReport(target, store.get(target), store.analysis());
  assert.equal(after.categories.some(item => item.id === 'missingPlacementId'), false);
  assert.equal(after.categories.some(item => item.id === 'missingMetaId'), false);
});
