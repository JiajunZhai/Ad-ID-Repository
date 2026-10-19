import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportDiff, findImportConflicts, isImportPreviewCurrent } from '../import-diff.js';

const app = () => ({ id: 'a1', name: 'Demo', pkg: 'com.demo.app', formats: [{ id: 'f1', key: 'interstitial', name: '插屏', placements: [{ id: 'p1', code: 'demo_inter', mediation: 'Admob', segments: [{ id: 's1', name: 'Base', priority: 1, eCPM: 10, idConfigs: [{ id: 'c1', network: 'Admob', groupTag: 'L', placementId: 'old', metaSourceId: 'meta-old', floorPrice: 13.5, adName: 'old-name', isLocked: true }] }] }] }] });
const entry = (overrides = {}) => ({ app: 'Demo', code: 'demo_inter', platform: 'Admob', typeKey: 'interstitial', typeName: '插屏', unknown: false, segments: [{ name: 'Base', eCPM: 10, tiers: { L: { id: 'old', meta: 'meta-old' } } }], ...overrides });
const model = (...entries) => ({ entries, mismatches: [], nameMismatches: [], unknown: [] });

test('identifies newly added application and configuration objects', () => {
  const diff = createImportDiff([], model(entry({ app: 'NewApp' })));
  assert.ok(diff.additions.some(item => item.level === 'application'));
  assert.ok(diff.additions.some(item => item.level === 'config'));
});

test('reports field-level ID, Meta ID, floor and generated-name changes', () => {
  const current = [app()]; current[0].formats[0].placements[0].segments[0].idConfigs[0].floorPrice = 1;
  const next = entry(); next.segments[0].tiers.L = { id: 'new-id', meta: 'new-meta' };
  const diff = createImportDiff(current, model(next));
  for (const field of ['placementId', 'metaSourceId', 'floorPrice', 'adName']) assert.ok(diff.modifications.some(item => item.field === field));
});

test('counts touched configurations with no business change as unchanged', () => {
  const current = [app()]; current[0].formats[0].placements[0].segments[0].idConfigs[0].adName = 'Demo_Admob_demo_inter_Base_L_13.5';
  const diff = createImportDiff(current, model(entry()));
  assert.equal(diff.modifications.length, 0);
  assert.equal(diff.unchanged.length, 1);
});

test('incremental merge never treats absent current objects as deletions', () => {
  const current = [app(), { id: 'a2', name: 'Keep', formats: [] }];
  const diff = createImportDiff(current, model(entry()));
  assert.equal(diff.mode, 'incremental-merge');
  assert.deepEqual(diff.potentialDeletions, []);
});

test('missing critical identifiers are blocking conflicts', () => {
  const conflicts = findImportConflicts([app()], model(entry({ code: '' })));
  assert.equal(conflicts[0].kind, 'missingKey');
  assert.equal(conflicts[0].blocking, true);
});

test('rows skipped by the legacy model builder remain visible as blocking conflicts', () => {
  const input = model(entry()); input.skipped = [{ row: 3, kind: 'missingKey', message: '应用缺失' }];
  const conflicts = findImportConflicts([app()], input);
  assert.match(conflicts[0].message, /第 3 行/);
});

test('multiple matches for one target are reported as conflicts', () => {
  const duplicate = app(); duplicate.id = 'a2';
  assert.ok(findImportConflicts([app(), duplicate], model(entry())).some(item => item.kind === 'ambiguousApplication'));
});

test('platform, ID and Meta changes use existing importer matching rules', () => {
  const next = entry({ platform: 'Topon' }); next.segments[0].tiers.L = { id: 'id2', meta: 'meta2' };
  const diff = createImportDiff([app()], model(next));
  for (const field of ['mediation', 'network', 'placementId', 'metaSourceId']) assert.ok(diff.modifications.some(item => item.field === field));
});

test('preview leaves current warehouse and model unchanged', () => {
  const current = [app()], input = model(entry()), before = JSON.stringify({ current, input });
  createImportDiff(current, input);
  assert.equal(JSON.stringify({ current, input }), before);
});

test('cancel has no side effects because candidate is isolated', () => {
  const current = [app()], before = JSON.stringify(current), diff = createImportDiff(current, model(entry()));
  diff.candidate[0].name = 'Changed only in candidate';
  assert.equal(JSON.stringify(current), before);
});

test('stale preview is rejected after current data changes', () => {
  const current = [app()], diff = createImportDiff(current, model(entry()));
  assert.equal(isImportPreviewCurrent(diff, current), true);
  current[0].name = 'Changed';
  assert.equal(isImportPreviewCurrent(diff, current), false);
});

test('legacy importer semantics remain compatible for same-name and same-eCPM matching', () => {
  const diff = createImportDiff([app()], model(entry()));
  assert.equal(diff.candidate.length, 1);
  assert.equal(diff.candidate[0].formats[0].placements[0].segments.length, 1);
  assert.equal(diff.candidate[0].formats[0].placements[0].segments[0].idConfigs.length, 1);
});
