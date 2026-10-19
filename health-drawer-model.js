const CATEGORY_DEFINITIONS = {
  missingPlacementId: {
    label: '缺失广告 ID',
    description: '已确认 placementId 为缺失值的配置项。',
    classification: 'confirmed'
  },
  missingMetaId: {
    label: '缺失 Meta ID 候选',
    description: 'Meta ID 缺失不影响当前配置完整度，仅供核查。',
    classification: 'candidate'
  },
  suspiciousValue: {
    label: '空白或类型可疑值',
    description: '纯空格或非字符串 ID，保留原始值供人工核查。',
    classification: 'candidate'
  },
  duplicatePlacementId: {
    label: '重复广告 ID 候选',
    description: '按原始字符串精确分组，不代表业务上一定错误。',
    classification: 'candidate'
  },
  duplicateMetaId: {
    label: '重复 Meta ID 候选',
    description: '按原始字符串精确分组，不代表业务上一定错误。',
    classification: 'candidate'
  },
  unknownOperationalState: {
    label: '未知运营状态候选',
    description: '状态不属于 running、idle、mediation 或 meta。',
    classification: 'candidate'
  },
  platformCaseVariant: {
    label: '平台大小写差异候选',
    description: '同一字段存在大小写不同的原始平台或网络名称。',
    classification: 'candidate'
  },
  otherCandidate: {
    label: '其他待核查候选',
    description: '尚未归入其他分类的只读候选。',
    classification: 'candidate'
  }
};

function findNode(collection, id, index) {
  if (!Array.isArray(collection)) return null;
  return collection.find(item => id != null && item?.id === id) ?? collection[index] ?? null;
}

function resolveNodes(application, location = {}) {
  const format = findNode(application.formats, location.formatId, location.formatIndex);
  const placement = findNode(format?.placements, location.placementNodeId, location.placementIndex);
  const segment = findNode(placement?.segments, location.segmentId, location.segmentIndex);
  const config = findNode(segment?.idConfigs, location.configId, location.configIndex);
  return { format, placement, segment, config };
}

function matchesApplication(location, application, applicationIndex) {
  if (location?.applicationIndex != null) return location.applicationIndex === applicationIndex;
  if (location?.applicationId != null && application.id != null) {
    return location.applicationId === application.id;
  }
  return location?.applicationName === application.name;
}

function rawKind(value, hasField = true) {
  if (!hasField) return 'missing_field';
  if (value === null) return 'null';
  if (value === '') return 'empty_string';
  if (typeof value === 'string' && value.trim() === '') return 'whitespace_only';
  if (typeof value !== 'string') return 'non_string';
  return 'value';
}

export function describeRawValue(value, hasField = true) {
  const kind = rawKind(value, hasField);
  if (kind === 'missing_field') return { kind, label: '缺失字段', copyValue: null };
  if (kind === 'null') return { kind, label: 'null', copyValue: null };
  if (kind === 'empty_string') return { kind, label: '空字符串', copyValue: '' };
  if (kind === 'whitespace_only') {
    return { kind, label: JSON.stringify(value), copyValue: value };
  }
  if (kind === 'non_string') {
    return { kind, label: String(value), copyValue: String(value) };
  }
  return { kind, label: value, copyValue: value };
}

function createDetail(application, applicationIndex, occurrence, field, rawValue) {
  const location = occurrence?.location ?? occurrence ?? {};
  const { format, placement, segment, config } = resolveNodes(application, location);
  const hasField = config ? Object.prototype.hasOwnProperty.call(config, field) : rawValue !== undefined;
  const actualRawValue = rawValue !== undefined ? rawValue : config?.[field];
  return {
    id: [
      field,
      location.configId ?? location.configIndex ?? 'none',
      location.segmentId ?? location.segmentIndex ?? 'none',
      String(actualRawValue)
    ].join(':'),
    field,
    rawValue: actualRawValue,
    rawDisplay: describeRawValue(actualRawValue, hasField),
    applicationId: application.id ?? null,
    applicationName: application.name ?? '',
    formatId: format?.id ?? location.formatId ?? null,
    formatKey: format?.key ?? location.formatKey ?? '',
    formatName: format?.name ?? location.formatName ?? '',
    placementNodeId: placement?.id ?? location.placementNodeId ?? null,
    placementCode: placement?.code ?? location.placementCode ?? '',
    mediation: placement?.mediation ?? location.mediation ?? '',
    segmentId: segment?.id ?? location.segmentId ?? null,
    segmentName: segment?.name ?? location.segmentName ?? '',
    segmentPriority: segment?.priority ?? location.segmentPriority ?? null,
    configId: config?.id ?? location.configId ?? null,
    network: config?.network ?? location.network ?? '',
    groupTag: config?.groupTag ?? location.groupTag ?? '',
    placementId: config?.placementId,
    metaSourceId: config?.metaSourceId,
    opState: config?.opState,
    applicationIndex
  };
}

function singleOccurrenceGroup(key, detail) {
  return { key, rawValue: detail.rawValue, variants: null, occurrences: [detail] };
}

function category(id, groups) {
  const definition = CATEGORY_DEFINITIONS[id];
  return {
    id,
    ...definition,
    groupCount: groups.length,
    itemCount: groups.reduce((total, group) => total + group.occurrences.length, 0),
    groups
  };
}

function candidateLocations(candidate, application, applicationIndex) {
  return candidate.occurrences.filter(occurrence => {
    const location = occurrence?.location ?? occurrence;
    return matchesApplication(location, application, applicationIndex);
  });
}

export function buildApplicationIssueReport(application, healthEntry, warehouseAnalysis) {
  if (!application || typeof application !== 'object') {
    throw new TypeError('application must be an object');
  }
  if (!healthEntry?.health || !healthEntry?.candidates) {
    throw new TypeError('healthEntry must contain health and candidates');
  }
  if (!warehouseAnalysis?.candidates) {
    throw new TypeError('warehouseAnalysis must contain candidates');
  }

  const applicationIndex = healthEntry.health.application.index;
  const valueCandidates = healthEntry.health.candidates.values;
  const categories = [];

  const missingPlacement = valueCandidates
    .filter(item => item.field === 'placementId' && !Boolean(item.rawValue))
    .map((item, index) => {
      const detail = createDetail(application, applicationIndex, item, item.field, item.rawValue);
      return singleOccurrenceGroup(`missing-placement:${detail.configId ?? index}`, detail);
    });
  if (missingPlacement.length) categories.push(category('missingPlacementId', missingPlacement));

  const missingMeta = valueCandidates
    .filter(item => item.field === 'metaSourceId' && !Boolean(item.rawValue))
    .map((item, index) => {
      const detail = createDetail(application, applicationIndex, item, item.field, item.rawValue);
      return singleOccurrenceGroup(`missing-meta:${detail.configId ?? index}`, detail);
    });
  if (missingMeta.length) categories.push(category('missingMetaId', missingMeta));

  const suspiciousValues = valueCandidates
    .filter(item => ['whitespace_only', 'non_string'].includes(item.kind))
    .map((item, index) => {
      const detail = createDetail(application, applicationIndex, item, item.field, item.rawValue);
      return singleOccurrenceGroup(`suspicious:${item.field}:${detail.configId ?? index}`, detail);
    });
  if (suspiciousValues.length) categories.push(category('suspiciousValue', suspiciousValues));

  const duplicatePlacement = warehouseAnalysis.candidates.duplicatePlacementIds
    .map((candidate, index) => {
      const occurrences = candidateLocations(candidate, application, applicationIndex)
        .map(item => createDetail(application, applicationIndex, item, 'placementId', candidate.rawValue));
      return occurrences.length
        ? { key: `duplicate-placement:${index}`, rawValue: candidate.rawValue, variants: null, occurrences }
        : null;
    })
    .filter(Boolean);
  if (duplicatePlacement.length) {
    categories.push(category('duplicatePlacementId', duplicatePlacement));
  }

  const duplicateMeta = warehouseAnalysis.candidates.duplicateMetaIds
    .map((candidate, index) => {
      const occurrences = candidateLocations(candidate, application, applicationIndex)
        .map(item => createDetail(application, applicationIndex, item, 'metaSourceId', candidate.rawValue));
      return occurrences.length
        ? { key: `duplicate-meta:${index}`, rawValue: candidate.rawValue, variants: null, occurrences }
        : null;
    })
    .filter(Boolean);
  if (duplicateMeta.length) categories.push(category('duplicateMetaId', duplicateMeta));

  const unknownStates = healthEntry.health.candidates.unknownOperationalStates.map((item, index) => {
    const detail = createDetail(application, applicationIndex, item, 'opState', item.rawValue);
    return singleOccurrenceGroup(`unknown-state:${detail.configId ?? index}`, detail);
  });
  if (unknownStates.length) {
    categories.push(category('unknownOperationalState', unknownStates));
  }

  const platformVariants = warehouseAnalysis.candidates.platformCaseVariants
    .map((candidate, index) => {
      const matching = candidateLocations(candidate, application, applicationIndex);
      const occurrences = matching.map(item => {
        const field = candidate.field;
        return createDetail(application, applicationIndex, item, field, item.rawValue);
      });
      return occurrences.length
        ? {
            key: `platform-case:${index}`,
            rawValue: null,
            variants: candidate.variants,
            occurrences
          }
        : null;
    })
    .filter(Boolean);
  if (platformVariants.length) {
    categories.push(category('platformCaseVariant', platformVariants));
  }

  const status = healthEntry.health.status;
  return {
    application: {
      id: application.id ?? null,
      name: application.name ?? '',
      title: application.title ?? '',
      pkg: application.pkg ?? ''
    },
    overview: {
      status,
      totalIdConfigs: healthEntry.health.counts.totalIdConfigs,
      filledPlacementIds: healthEntry.health.counts.filledPlacementIds,
      missingPlacementIds: healthEntry.health.counts.missingPlacementIds,
      candidateCategoryCount: categories.filter(item => item.classification === 'candidate').length
    },
    categories
  };
}

function detailSearchText(detail) {
  return [
    detail.applicationName,
    detail.formatName,
    detail.formatKey,
    detail.placementCode,
    detail.mediation,
    detail.segmentName,
    detail.network,
    detail.groupTag,
    detail.placementId,
    detail.metaSourceId,
    detail.rawDisplay.label
  ].map(value => String(value ?? '').toLocaleLowerCase()).join(' ');
}

export function selectIssueCategory(report, categoryId, query = '') {
  if (!report?.categories) throw new TypeError('report must contain categories');
  const source = report.categories.find(item => item.id === categoryId) ?? null;
  if (!source) return null;
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  if (!normalizedQuery) return source;

  const groups = source.groups
    .map(group => ({
      ...group,
      occurrences: group.occurrences.filter(detail => detailSearchText(detail).includes(normalizedQuery))
    }))
    .filter(group => group.occurrences.length > 0);
  return {
    ...source,
    groupCount: groups.length,
    itemCount: groups.reduce((total, group) => total + group.occurrences.length, 0),
    groups
  };
}

export function navigationTargetForIssue(detail) {
  if (!detail?.applicationId) return null;
  return {
    appId: detail.applicationId,
    formatId: detail.formatId ?? null,
    placementId: detail.placementNodeId ?? null,
    segmentId: detail.segmentId ?? null,
    configId: detail.configId ?? null
  };
}

export { CATEGORY_DEFINITIONS };
