import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeApplication,
  analyzeWarehouse,
  findDuplicateIdCandidates,
  KNOWN_OPERATIONAL_STATES
} from '../config-health.js';

const config = (overrides = {}) => ({
  id: overrides.id ?? 'config-1',
  network: overrides.network ?? 'Admob',
  groupTag: overrides.groupTag ?? 'L',
  placementId: overrides.placementId ?? '',
  metaSourceId: overrides.metaSourceId ?? '',
  ...overrides
});

function application(name, configs = [], overrides = {}) {
  return {
    id: overrides.id ?? `app-${name}`,
    name,
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
          name: '20',
          priority: 1,
          eCPM: 20,
          idConfigs: configs
        }]
      }]
    }]
  };
}

test('analyzes an application with no ID configs as empty', () => {
  const result = analyzeApplication(application('empty'));
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.counts, {
    totalIdConfigs: 0,
    filledPlacementIds: 0,
    missingPlacementIds: 0,
    filledMetaIds: 0,
    missingMetaIds: 0,
    placementIdCompletionRate: null
  });
});

test('matches appSt semantics when every placementId is truthy', () => {
  const result = analyzeApplication(application('complete', [
    config({ id: 'c1', placementId: 'ad-1' }),
    config({ id: 'c2', placementId: 'ad-2' })
  ]));
  assert.equal(result.status, 'ok');
  assert.equal(result.counts.filledPlacementIds, 2);
  assert.equal(result.counts.missingPlacementIds, 0);
  assert.equal(result.counts.placementIdCompletionRate, 1);
});

test('reports a partially configured application', () => {
  const result = analyzeApplication(application('partial', [
    config({ id: 'c1', placementId: 'ad-1' }),
    config({ id: 'c2', placementId: '' })
  ]));
  assert.equal(result.status, 'partial');
  assert.equal(result.counts.totalIdConfigs, 2);
  assert.equal(result.counts.filledPlacementIds, 1);
  assert.equal(result.counts.missingPlacementIds, 1);
  assert.equal(result.counts.placementIdCompletionRate, 0.5);
});

test('preserves current truthiness rules for null, missing, empty, and whitespace IDs', () => {
  const missingField = config({ id: 'missing-field' });
  delete missingField.placementId;
  const result = analyzeApplication(application('truthiness', [
    config({ id: 'null', placementId: null }),
    config({ id: 'empty', placementId: '' }),
    config({ id: 'spaces', placementId: '   ' }),
    missingField
  ]));
  assert.equal(result.counts.filledPlacementIds, 1);
  assert.equal(result.counts.missingPlacementIds, 3);
  assert.equal(result.status, 'partial');
  assert.ok(result.candidates.values.some(x => x.kind === 'whitespace_only' && x.location.configId === 'spaces'));
});

test('counts complete, partial, and fully missing Meta IDs independently', () => {
  const complete = analyzeApplication(application('meta-complete', [
    config({ id: 'c1', metaSourceId: 'meta-1' }),
    config({ id: 'c2', metaSourceId: 'meta-2' })
  ]));
  const partial = analyzeApplication(application('meta-partial', [
    config({ id: 'c1', metaSourceId: 'meta-1' }),
    config({ id: 'c2', metaSourceId: '' })
  ]));
  const missing = analyzeApplication(application('meta-missing', [
    config({ id: 'c1' }),
    config({ id: 'c2', metaSourceId: null })
  ]));
  assert.deepEqual(
    [complete.counts.filledMetaIds, partial.counts.filledMetaIds, missing.counts.filledMetaIds],
    [2, 1, 0]
  );
  assert.deepEqual(
    [complete.counts.missingMetaIds, partial.counts.missingMetaIds, missing.counts.missingMetaIds],
    [0, 1, 2]
  );
  assert.equal(partial.status, 'partial');
});

test('separates known, missing, and unknown operational states', () => {
  const result = analyzeApplication(application('states', [
    config({ id: 'running', opState: 'running' }),
    config({ id: 'idle', opState: 'idle' }),
    config({ id: 'mediation', opState: 'mediation' }),
    config({ id: 'meta', opState: 'meta' }),
    config({ id: 'missing' }),
    config({ id: 'empty-state', opState: '' }),
    config({ id: 'unknown', opState: 'paused' })
  ]));
  assert.deepEqual(KNOWN_OPERATIONAL_STATES, ['running', 'idle', 'mediation', 'meta']);
  assert.deepEqual(result.operationalStates.raw, {
    running: 1,
    idle: 1,
    mediation: 1,
    meta: 1,
    missing: 2,
    unknown: 1
  });
  assert.deepEqual(result.operationalStates.effective, {
    running: 1,
    idle: 4,
    mediation: 1,
    meta: 1
  });
  assert.equal(result.candidates.unknownOperationalStates[0].rawValue, 'paused');
});

test('aggregates multiple applications and their statuses', () => {
  const result = analyzeWarehouse([
    application('empty'),
    application('ok', [config({ placementId: 'ad-1' })]),
    application('partial', [config({ placementId: '' })])
  ]);
  assert.equal(result.summary.totalApplications, 3);
  assert.deepEqual(result.summary.applicationStatuses, { empty: 1, ok: 1, partial: 1 });
  assert.equal(result.summary.counts.totalIdConfigs, 2);
  assert.equal(result.summary.counts.filledPlacementIds, 1);
});

test('returns exact duplicate placement ID candidates with locations', () => {
  const result = findDuplicateIdCandidates([
    application('one', [config({ id: 'one-config', placementId: 'same-id' })]),
    application('two', [config({ id: 'two-config', placementId: 'same-id' })])
  ]);
  assert.equal(result.placementIds.length, 1);
  assert.equal(result.placementIds[0].classification, 'candidate');
  assert.equal(result.placementIds[0].rawValue, 'same-id');
  assert.deepEqual(
    result.placementIds[0].occurrences.map(x => [x.applicationName, x.placementCode, x.segmentName, x.configId]),
    [
      ['one', 'one_inter', '20', 'one-config'],
      ['two', 'two_inter', '20', 'two-config']
    ]
  );
});

test('returns exact duplicate Meta ID candidates with locations', () => {
  const result = findDuplicateIdCandidates([
    application('one', [config({ id: 'one-config', metaSourceId: 'same-meta' })]),
    application('two', [config({ id: 'two-config', metaSourceId: 'same-meta' })])
  ]);
  assert.equal(result.metaIds.length, 1);
  assert.equal(result.metaIds[0].rawValue, 'same-meta');
  assert.equal(result.metaIds[0].occurrences[1].network, 'Admob');
});

test('keeps duplicate candidates across platforms without declaring an error', () => {
  const result = analyzeWarehouse([
    application('admob', [config({ id: 'a', network: 'Admob', placementId: 'shared' })], { mediation: 'Admob' }),
    application('topon', [config({ id: 'b', network: 'Topon', placementId: 'shared' })], { mediation: 'Topon' })
  ]);
  const candidate = result.candidates.duplicatePlacementIds[0];
  assert.equal(candidate.classification, 'candidate');
  assert.deepEqual(candidate.occurrences.map(x => x.network), ['Admob', 'Topon']);
});

test('does not merge IDs that differ only by case', () => {
  const result = analyzeWarehouse([
    application('lower', [config({ placementId: 'case-id' })]),
    application('upper', [config({ placementId: 'CASE-ID' })])
  ]);
  assert.equal(result.candidates.duplicatePlacementIds.length, 0);
});

test('reports non-string ID values as candidates without inventing a format rule', () => {
  const result = analyzeApplication(application('non-string', [
    config({ placementId: 12345, metaSourceId: false })
  ]));
  assert.equal(result.counts.filledPlacementIds, 1);
  assert.equal(result.counts.missingMetaIds, 1);
  assert.deepEqual(
    result.candidates.values.map(x => [x.field, x.kind, x.rawValue]),
    [
      ['placementId', 'non_string', 12345],
      ['metaSourceId', 'non_string', false]
    ]
  );
});

test('reports platform casing variants without selecting a canonical value', () => {
  const result = analyzeWarehouse([
    application('upper', [config({ network: 'ADMOB' })], { mediation: 'TRADPLUS' }),
    application('title', [config({ network: 'Admob' })], { mediation: 'TradPlus' })
  ]);
  assert.equal(result.candidates.platformCaseVariants.length, 2);
  const byField = Object.fromEntries(
    result.candidates.platformCaseVariants.map(x => [x.field, x.variants.sort()])
  );
  assert.deepEqual(byField, {
    mediation: ['TRADPLUS', 'TradPlus'],
    network: ['ADMOB', 'Admob']
  });
});

test('does not mutate input data', () => {
  const input = [
    application('immutable', [
      config({ placementId: 'ad-1', metaSourceId: null, opState: 'running' })
    ])
  ];
  const before = structuredClone(input);
  analyzeWarehouse(input);
  assert.deepEqual(input, before);
});

test('defines empty warehouse and abnormal input behavior', () => {
  const empty = analyzeWarehouse([]);
  assert.equal(empty.summary.totalApplications, 0);
  assert.equal(empty.summary.counts.placementIdCompletionRate, null);
  assert.deepEqual(empty.summary.applicationStatuses, { empty: 0, ok: 0, partial: 0 });
  assert.throws(() => analyzeWarehouse(null), /applications must be an array/);
  assert.throws(() => analyzeApplication(null), /application must be an object/);
  assert.throws(
    () => analyzeApplication({ name: 'bad', formats: {} }),
    /application\.formats must be an array/
  );
});

test('warehouse totals equal the sum of application analyses', () => {
  const result = analyzeWarehouse([
    application('one', [
      config({ id: '1', placementId: 'ad-1', metaSourceId: 'meta-1', opState: 'running' }),
      config({ id: '2', placementId: '', metaSourceId: '', opState: 'mediation' })
    ]),
    application('two', [
      config({ id: '3', placementId: 'ad-3', metaSourceId: '', opState: 'unknown' })
    ])
  ]);
  const summed = result.applications.reduce((total, item) => ({
    totalIdConfigs: total.totalIdConfigs + item.counts.totalIdConfigs,
    filledPlacementIds: total.filledPlacementIds + item.counts.filledPlacementIds,
    missingPlacementIds: total.missingPlacementIds + item.counts.missingPlacementIds,
    filledMetaIds: total.filledMetaIds + item.counts.filledMetaIds,
    missingMetaIds: total.missingMetaIds + item.counts.missingMetaIds
  }), {
    totalIdConfigs: 0,
    filledPlacementIds: 0,
    missingPlacementIds: 0,
    filledMetaIds: 0,
    missingMetaIds: 0
  });
  assert.deepEqual(
    {
      totalIdConfigs: result.summary.counts.totalIdConfigs,
      filledPlacementIds: result.summary.counts.filledPlacementIds,
      missingPlacementIds: result.summary.counts.missingPlacementIds,
      filledMetaIds: result.summary.counts.filledMetaIds,
      missingMetaIds: result.summary.counts.missingMetaIds
    },
    summed
  );
});
