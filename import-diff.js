import { applyImport, makeAdName, RATIO, round2 } from './importer.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const same = (a, b) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const text = value => value == null ? '' : String(value);

export function warehouseVersion(warehouse) {
  return JSON.stringify(warehouse ?? []);
}

function walk(warehouse) {
  const out = [];
  for (const app of warehouse || []) for (const format of app.formats || []) for (const placement of format.placements || []) for (const segment of placement.segments || []) for (const config of segment.idConfigs || []) {
    out.push({ app, format, placement, segment, config });
  }
  return out;
}

function locationOf(node) {
  return {
    applicationId: node.app?.id || null, application: node.app?.name || '',
    formatId: node.format?.id || null, format: node.format?.key || node.format?.name || '',
    placementId: node.placement?.id || null, placement: node.placement?.code || '',
    segmentId: node.segment?.id || null, segment: node.segment?.name || '',
    configId: node.config?.id || null, tier: node.config?.groupTag || ''
  };
}

function issue(kind, message, location = {}, blocking = true) {
  return { kind, message, blocking, location };
}

export function findImportConflicts(warehouse, model, platformMap = {}) {
  const conflicts = (model?.skipped || []).map(row => issue(row.kind || 'skippedRow', `第 ${row.row} 行：${row.message || '缺少导入所需字段'}。`, { application: row.app || '', placement: row.code || '', segment: row.group || '' }));
  const apps = warehouse || [];
  for (const entry of model?.entries || []) {
    const base = { application: text(entry?.app), placement: text(entry?.code), format: text(entry?.typeKey) };
    if (!entry?.app || !entry?.code || !entry?.typeKey) {
      conflicts.push(issue('missingKey', '应用、广告位代码或广告类型缺失，无法确定导入目标。', base));
      continue;
    }
    const appMatches = apps.filter(app => app?.name === entry.app);
    if (appMatches.length > 1) conflicts.push(issue('ambiguousApplication', `存在 ${appMatches.length} 个同名应用，导入器只会更新第一个。`, base));
    const app = appMatches[0];
    if (!app) continue;
    const formats = (app.formats || []).filter(format => format?.key === entry.typeKey);
    if (formats.length > 1) conflicts.push(issue('ambiguousFormat', `应用内存在 ${formats.length} 个相同类型的 Format。`, base));
    const format = formats[0];
    if (!format) continue;
    const placements = (format.placements || []).filter(placement => placement?.code === entry.code);
    if (placements.length > 1) conflicts.push(issue('ambiguousPlacement', `同一 Format 内存在 ${placements.length} 个同代码广告位。`, base));
    const placement = placements[0];
    if (!placement) continue;
    for (const segment of entry.segments || []) {
      if (!segment?.name || !Number.isFinite(Number(segment.eCPM))) {
        conflicts.push(issue('missingSegmentKey', 'Segment 名称或参考 eCPM 缺失。', { ...base, segment: text(segment?.name) }));
        continue;
      }
      const segments = (placement.segments || []).filter(current => current?.name === segment.name && Math.abs((Number(current.eCPM) || 0) - Number(segment.eCPM)) <= .001);
      if (segments.length > 1) conflicts.push(issue('ambiguousSegment', `存在 ${segments.length} 个同名且同 eCPM 的 Segment。`, { ...base, segment: segment.name }));
      const current = segments[0];
      if (!current) continue;
      for (const tier of Object.keys(segment.tiers || {})) {
        const configs = (current.idConfigs || []).filter(config => config?.groupTag === tier);
        if (configs.length > 1) conflicts.push(issue('ambiguousTier', `Segment 内存在 ${configs.length} 个 ${tier} 组配置，导入器只会更新第一个。`, { ...base, segment: segment.name, tier }));
      }
    }
    const platform = platformMap[`${entry.app}|${entry.code}`] || entry.platform;
    if (!platform) conflicts.push(issue('missingPlatform', '聚合平台为空，无法生成可靠的网络与广告名称。', base));
  }
  return conflicts;
}

function recalcTouchedApps(warehouse, touched) {
  const ids = new Set((touched || []).map(item => item.app?.id));
  for (const node of walk(warehouse)) {
    if (!ids.has(node.app.id) || node.config.isLocked === false) continue;
    const ratio = node.config.groupTag && RATIO[node.config.groupTag] ? RATIO[node.config.groupTag] : Number(node.config.discountRatio || 1);
    node.config.floorPrice = Number(node.segment.eCPM || 0) * ratio;
    node.config.adName = makeAdName(node.app.name, node.config.network, node.placement.code, node.segment.name, node.config.groupTag, round2(node.config.floorPrice));
  }
}

function indexById(warehouse) {
  const map = new Map();
  for (const node of walk(warehouse)) if (node.config?.id) map.set(node.config.id, node);
  return map;
}

export function createImportDiff(warehouse, model, platformMap = {}, options = {}) {
  const sourceVersion = warehouseVersion(warehouse);
  const before = clone(warehouse || []);
  const candidate = clone(warehouse || []);
  const safeModel = clone(model || { entries: [], mismatches: [] });
  const safePlatforms = clone(platformMap || {});
  const conflicts = findImportConflicts(before, safeModel, safePlatforms);
  const applied = applyImport(candidate, safeModel, safePlatforms);
  recalcTouchedApps(candidate, applied.touched);

  const beforeApps = new Map(before.map(app => [app.id, app]));
  const beforeConfigs = indexById(before), afterConfigs = indexById(candidate);
  const additions = [], modifications = [], unchanged = [];
  for (const app of candidate) if (!beforeApps.has(app.id)) additions.push({ level: 'application', key: app.name, location: { applicationId: app.id, application: app.name } });
  for (const created of applied.report.created.placements) additions.push({ level: 'placement', key: created });
  for (const created of applied.report.created.segments) additions.push({ level: 'segment', key: created });
  for (const node of walk(candidate)) if (!beforeConfigs.has(node.config.id)) additions.push({ level: 'config', key: `${node.app.name}/${node.placement.code}/${node.segment.name}/${node.config.groupTag}`, location: locationOf(node), value: clone(node.config) });

  const fields = ['network', 'placementId', 'metaSourceId', 'floorPrice', 'adName'];
  for (const [id, afterNode] of afterConfigs) {
    const beforeNode = beforeConfigs.get(id);
    if (!beforeNode) continue;
    let changed = false;
    for (const field of fields) if (!same(beforeNode.config[field], afterNode.config[field])) {
      changed = true;
      modifications.push({ level: 'config', field, before: clone(beforeNode.config[field]), after: clone(afterNode.config[field]), location: locationOf(afterNode) });
    }
    if (!same(beforeNode.placement.mediation, afterNode.placement.mediation)) {
      const key = `placement:${afterNode.placement.id}:mediation`;
      if (!modifications.some(item => item.key === key)) modifications.push({ key, level: 'placement', field: 'mediation', before: beforeNode.placement.mediation, after: afterNode.placement.mediation, location: locationOf(afterNode) });
      changed = true;
    }
    if (!changed && applied.touched.some(item => item.segment?.id === afterNode.segment.id)) unchanged.push({ level: 'config', location: locationOf(afterNode) });
  }

  return {
    mode: 'incremental-merge', sourceVersion, fileName: options.fileName || '', candidate,
    additions, modifications, unchanged, potentialDeletions: [], conflicts,
    blockingConflicts: conflicts.filter(item => item.blocking), report: applied.report,
    summary: {
      affectedApplications: new Set(applied.touched.map(item => item.app?.id)).size,
      additions: additions.length, modifications: modifications.length, unchanged: unchanged.length,
      potentialDeletions: 0, conflicts: conflicts.length
    }
  };
}

export function isImportPreviewCurrent(preview, warehouse) {
  return !!preview && preview.sourceVersion === warehouseVersion(warehouse);
}

