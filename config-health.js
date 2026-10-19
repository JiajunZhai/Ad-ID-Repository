const KNOWN_OPERATIONAL_STATES = Object.freeze(['running', 'idle', 'mediation', 'meta']);

const emptyOperationalCounts = () => ({
  running: 0,
  idle: 0,
  mediation: 0,
  meta: 0,
  missing: 0,
  unknown: 0
});

const emptyCounts = () => ({
  totalIdConfigs: 0,
  filledPlacementIds: 0,
  missingPlacementIds: 0,
  filledMetaIds: 0,
  missingMetaIds: 0
});

function expectRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function readCollection(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function isFilledByCurrentRule(value) {
  return Boolean(value);
}

function locate(context, config, configIndex) {
  const { application, applicationIndex, format, formatIndex, placement, placementIndex, segment, segmentIndex } = context;
  return {
    applicationIndex,
    applicationId: application.id ?? null,
    applicationName: application.name ?? '',
    formatIndex,
    formatId: format.id ?? null,
    formatKey: format.key ?? '',
    formatName: format.name ?? '',
    placementIndex,
    placementNodeId: placement.id ?? null,
    placementCode: placement.code ?? '',
    mediation: placement.mediation ?? '',
    segmentIndex,
    segmentId: segment.id ?? null,
    segmentName: segment.name ?? '',
    segmentPriority: segment.priority ?? null,
    configIndex,
    configId: config.id ?? null,
    network: config.network ?? '',
    groupTag: config.groupTag ?? ''
  };
}

function valueCandidate(field, rawValue, location) {
  if (rawValue == null) {
    return { classification: 'candidate', kind: 'missing', field, rawValue, location };
  }
  if (typeof rawValue !== 'string') {
    return { classification: 'candidate', kind: 'non_string', field, rawValue, location };
  }
  if (rawValue === '') {
    return { classification: 'candidate', kind: 'empty_string', field, rawValue, location };
  }
  if (rawValue.trim() === '') {
    return { classification: 'candidate', kind: 'whitespace_only', field, rawValue, location };
  }
  return null;
}

function addExactIdOccurrence(map, rawValue, location) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') return;
  const key = `string:${rawValue}`;
  const entry = map.get(key) || { rawValue, occurrences: [] };
  entry.occurrences.push(location);
  map.set(key, entry);
}

function addPlatformOccurrence(map, field, rawValue, location) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') return;
  const comparisonKey = rawValue.toLocaleLowerCase();
  const key = `${field}:${comparisonKey}`;
  const entry = map.get(key) || { field, comparisonKey, variants: new Set(), occurrences: [] };
  entry.variants.add(rawValue);
  entry.occurrences.push({ rawValue, location });
  map.set(key, entry);
}

function duplicateCandidates(map, field) {
  return [...map.values()]
    .filter(entry => entry.occurrences.length > 1)
    .map(entry => ({
      classification: 'candidate',
      kind: 'exact_duplicate',
      field,
      rawValue: entry.rawValue,
      occurrences: entry.occurrences
    }));
}

function platformCaseCandidates(map) {
  return [...map.values()]
    .filter(entry => entry.variants.size > 1)
    .map(entry => ({
      classification: 'candidate',
      kind: 'case_variant',
      field: entry.field,
      comparisonKey: entry.comparisonKey,
      variants: [...entry.variants],
      occurrences: entry.occurrences
    }));
}

function deriveStatus(counts) {
  if (counts.totalIdConfigs === 0) return 'empty';
  return counts.filledPlacementIds >= counts.totalIdConfigs ? 'ok' : 'partial';
}

function effectiveOperationalCounts(raw) {
  return {
    running: raw.running,
    idle: raw.idle + raw.missing + raw.unknown,
    mediation: raw.mediation,
    meta: raw.meta
  };
}

function collectApplication(app, applicationIndex = null) {
  const application = expectRecord(app, 'application');
  const counts = emptyCounts();
  const operationalRaw = emptyOperationalCounts();
  const valueCandidates = [];
  const unknownOperationalStates = [];
  const placementIds = new Map();
  const metaIds = new Map();
  const platformValues = new Map();

  const formats = readCollection(application.formats, 'application.formats');
  formats.forEach((formatValue, formatIndex) => {
    const format = expectRecord(formatValue, `application.formats[${formatIndex}]`);
    const placements = readCollection(format.placements, `application.formats[${formatIndex}].placements`);
    placements.forEach((placementValue, placementIndex) => {
      const placement = expectRecord(placementValue, `application.formats[${formatIndex}].placements[${placementIndex}]`);
      const placementLocation = {
        applicationIndex,
        applicationId: application.id ?? null,
        applicationName: application.name ?? '',
        formatIndex,
        formatId: format.id ?? null,
        formatKey: format.key ?? '',
        formatName: format.name ?? '',
        placementIndex,
        placementNodeId: placement.id ?? null,
        placementCode: placement.code ?? ''
      };
      addPlatformOccurrence(platformValues, 'mediation', placement.mediation, placementLocation);

      const segments = readCollection(placement.segments, `application.formats[${formatIndex}].placements[${placementIndex}].segments`);
      segments.forEach((segmentValue, segmentIndex) => {
        const segment = expectRecord(segmentValue, `application.formats[${formatIndex}].placements[${placementIndex}].segments[${segmentIndex}]`);
        const configs = readCollection(segment.idConfigs, `application.formats[${formatIndex}].placements[${placementIndex}].segments[${segmentIndex}].idConfigs`);
        configs.forEach((configValue, configIndex) => {
          const config = expectRecord(configValue, `application.formats[${formatIndex}].placements[${placementIndex}].segments[${segmentIndex}].idConfigs[${configIndex}]`);
          const location = locate({
            application,
            applicationIndex,
            format,
            formatIndex,
            placement,
            placementIndex,
            segment,
            segmentIndex
          }, config, configIndex);

          counts.totalIdConfigs++;

          if (isFilledByCurrentRule(config.placementId)) counts.filledPlacementIds++;
          else counts.missingPlacementIds++;

          if (isFilledByCurrentRule(config.metaSourceId)) counts.filledMetaIds++;
          else counts.missingMetaIds++;

          const placementCandidate = valueCandidate('placementId', config.placementId, location);
          if (placementCandidate) valueCandidates.push(placementCandidate);
          const metaCandidate = valueCandidate('metaSourceId', config.metaSourceId, location);
          if (metaCandidate) valueCandidates.push(metaCandidate);

          addExactIdOccurrence(placementIds, config.placementId, location);
          addExactIdOccurrence(metaIds, config.metaSourceId, location);
          addPlatformOccurrence(platformValues, 'network', config.network, location);

          if (config.opState == null || config.opState === '') {
            operationalRaw.missing++;
          } else if (KNOWN_OPERATIONAL_STATES.includes(config.opState)) {
            operationalRaw[config.opState]++;
          } else {
            operationalRaw.unknown++;
            unknownOperationalStates.push({
              classification: 'candidate',
              kind: 'unknown_operational_state',
              rawValue: config.opState,
              location
            });
          }
        });
      });
    });
  });

  const status = deriveStatus(counts);
  return {
    analysis: {
      application: {
        index: applicationIndex,
        id: application.id ?? null,
        name: application.name ?? ''
      },
      status,
      counts: {
        ...counts,
        placementIdCompletionRate: counts.totalIdConfigs === 0
          ? null
          : counts.filledPlacementIds / counts.totalIdConfigs
      },
      operationalStates: {
        raw: operationalRaw,
        effective: effectiveOperationalCounts(operationalRaw)
      },
      candidates: {
        duplicatePlacementIds: duplicateCandidates(placementIds, 'placementId'),
        duplicateMetaIds: duplicateCandidates(metaIds, 'metaSourceId'),
        values: valueCandidates,
        unknownOperationalStates,
        platformCaseVariants: platformCaseCandidates(platformValues)
      }
    },
    indexes: { placementIds, metaIds, platformValues }
  };
}

function mergeMap(target, source) {
  for (const [key, sourceEntry] of source) {
    const targetEntry = target.get(key);
    if (!targetEntry) {
      if (sourceEntry.variants) {
        target.set(key, {
          ...sourceEntry,
          variants: new Set(sourceEntry.variants),
          occurrences: [...sourceEntry.occurrences]
        });
      } else {
        target.set(key, { ...sourceEntry, occurrences: [...sourceEntry.occurrences] });
      }
      continue;
    }
    targetEntry.occurrences.push(...sourceEntry.occurrences);
    if (targetEntry.variants) {
      for (const variant of sourceEntry.variants) targetEntry.variants.add(variant);
    }
  }
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

export function analyzeApplication(app) {
  return collectApplication(app).analysis;
}

export function analyzeWarehouse(apps) {
  if (!Array.isArray(apps)) throw new TypeError('applications must be an array');

  const counts = emptyCounts();
  const operationalRaw = emptyOperationalCounts();
  const applicationStatuses = { empty: 0, ok: 0, partial: 0 };
  const applicationAnalyses = [];
  const placementIds = new Map();
  const metaIds = new Map();
  const platformValues = new Map();
  const valueCandidates = [];
  const unknownOperationalStates = [];

  apps.forEach((app, applicationIndex) => {
    const collected = collectApplication(app, applicationIndex);
    const analysis = collected.analysis;
    applicationAnalyses.push(analysis);
    addCounts(counts, {
      totalIdConfigs: analysis.counts.totalIdConfigs,
      filledPlacementIds: analysis.counts.filledPlacementIds,
      missingPlacementIds: analysis.counts.missingPlacementIds,
      filledMetaIds: analysis.counts.filledMetaIds,
      missingMetaIds: analysis.counts.missingMetaIds
    });
    addCounts(operationalRaw, analysis.operationalStates.raw);
    applicationStatuses[analysis.status]++;
    valueCandidates.push(...analysis.candidates.values);
    unknownOperationalStates.push(...analysis.candidates.unknownOperationalStates);
    mergeMap(placementIds, collected.indexes.placementIds);
    mergeMap(metaIds, collected.indexes.metaIds);
    mergeMap(platformValues, collected.indexes.platformValues);
  });

  return {
    applications: applicationAnalyses,
    summary: {
      totalApplications: apps.length,
      applicationStatuses,
      counts: {
        ...counts,
        placementIdCompletionRate: counts.totalIdConfigs === 0
          ? null
          : counts.filledPlacementIds / counts.totalIdConfigs
      },
      operationalStates: {
        raw: operationalRaw,
        effective: effectiveOperationalCounts(operationalRaw)
      }
    },
    candidates: {
      duplicatePlacementIds: duplicateCandidates(placementIds, 'placementId'),
      duplicateMetaIds: duplicateCandidates(metaIds, 'metaSourceId'),
      values: valueCandidates,
      unknownOperationalStates,
      platformCaseVariants: platformCaseCandidates(platformValues)
    }
  };
}

export function findDuplicateIdCandidates(apps) {
  const analysis = analyzeWarehouse(apps);
  return {
    placementIds: analysis.candidates.duplicatePlacementIds,
    metaIds: analysis.candidates.duplicateMetaIds
  };
}

export { KNOWN_OPERATIONAL_STATES };
