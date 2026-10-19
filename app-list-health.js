import { analyzeWarehouse } from './config-health.js';

const EMPTY_FILTERS = Object.freeze({
  status: 'all',
  issue: '',
  type: '',
  size: '',
  sort: 'name'
});

const CANDIDATE_KEYS = [
  'missingMetaIds',
  'duplicatePlacementIds',
  'duplicateMetaIds',
  'suspiciousPlacementIds',
  'suspiciousMetaIds',
  'unknownOperationalStates',
  'platformCaseVariants'
];

function emptyCandidateSummary() {
  return {
    missingMetaIds: 0,
    duplicatePlacementIds: 0,
    duplicateMetaIds: 0,
    suspiciousPlacementIds: 0,
    suspiciousMetaIds: 0,
    unknownOperationalStates: 0,
    platformCaseVariants: 0,
    categoryCount: 0,
    totalFindings: 0,
    hasCandidates: false
  };
}

function finalizeCandidateSummary(summary) {
  summary.categoryCount = CANDIDATE_KEYS.filter(key => summary[key] > 0).length;
  summary.totalFindings = CANDIDATE_KEYS.reduce((total, key) => total + summary[key], 0);
  summary.hasCandidates = summary.categoryCount > 0;
  return summary;
}

function applicationIndexFromOccurrence(occurrence) {
  return occurrence?.location?.applicationIndex ?? occurrence?.applicationIndex ?? null;
}

function addDuplicateOccurrences(candidates, summaries, key) {
  for (const candidate of candidates) {
    for (const occurrence of candidate.occurrences) {
      const index = applicationIndexFromOccurrence(occurrence);
      if (index != null && summaries[index]) summaries[index][key]++;
    }
  }
}

function addPlatformCaseGroups(candidates, summaries) {
  for (const candidate of candidates) {
    const affected = new Set();
    for (const occurrence of candidate.occurrences) {
      const index = applicationIndexFromOccurrence(occurrence);
      if (index != null) affected.add(index);
    }
    for (const index of affected) {
      if (summaries[index]) summaries[index].platformCaseVariants++;
    }
  }
}

function buildEntries(applications, analysis) {
  const candidateSummaries = analysis.applications.map(item => ({
    ...emptyCandidateSummary(),
    missingMetaIds: item.counts.missingMetaIds,
    unknownOperationalStates: item.candidates.unknownOperationalStates.length
  }));

  analysis.applications.forEach((item, index) => {
    for (const candidate of item.candidates.values) {
      if (!['whitespace_only', 'non_string'].includes(candidate.kind)) continue;
      if (candidate.field === 'placementId') candidateSummaries[index].suspiciousPlacementIds++;
      if (candidate.field === 'metaSourceId') candidateSummaries[index].suspiciousMetaIds++;
    }
  });

  addDuplicateOccurrences(
    analysis.candidates.duplicatePlacementIds,
    candidateSummaries,
    'duplicatePlacementIds'
  );
  addDuplicateOccurrences(
    analysis.candidates.duplicateMetaIds,
    candidateSummaries,
    'duplicateMetaIds'
  );
  addPlatformCaseGroups(analysis.candidates.platformCaseVariants, candidateSummaries);

  return applications.map((application, index) => {
    const health = analysis.applications[index];
    return {
      application,
      health,
      candidates: finalizeCandidateSummary(candidateSummaries[index])
    };
  });
}

export function createApplicationHealthStore() {
  let revision = 0;
  let analysis = analyzeWarehouse([]);
  let entries = [];
  let byApplication = new WeakMap();

  return {
    refresh(applications) {
      if (!Array.isArray(applications)) throw new TypeError('applications must be an array');
      analysis = analyzeWarehouse(applications);
      entries = buildEntries(applications, analysis);
      byApplication = new WeakMap(entries.map(entry => [entry.application, entry]));
      revision++;
      return analysis;
    },
    get(application) {
      return byApplication.get(application) ?? null;
    },
    entries() {
      return entries;
    },
    analysis() {
      return analysis;
    },
    revision() {
      return revision;
    }
  };
}

function placementsOf(application) {
  return (application.formats || []).flatMap(format => format.placements || []);
}

function sizeMatches(size, count) {
  if (!size) return true;
  if (size === '0') return count === 0;
  if (size === '1-3') return count >= 1 && count <= 3;
  if (size === '4-9') return count >= 4 && count <= 9;
  if (size === '10+') return count >= 10;
  return true;
}

function defaultModifiedAt(application) {
  return +String(application.id ?? '').replace(/\D+/g, '') || 0;
}

export function selectApplicationRows(applications, options = {}) {
  if (!Array.isArray(applications)) throw new TypeError('applications must be an array');
  if (typeof options.healthFor !== 'function') {
    throw new TypeError('healthFor must be a function');
  }

  const query = String(options.query ?? '').trim().toLocaleLowerCase();
  const filters = { ...EMPTY_FILTERS, ...(options.filters || {}) };
  const modifiedAt = options.modifiedAt || defaultModifiedAt;

  const rows = applications.filter(application => {
    const entry = options.healthFor(application);
    if (!entry) throw new Error('missing health analysis for application');

    if (query) {
      const haystack = [
        application.name,
        application.title,
        application.pkg,
        application.dev,
        application.genre
      ].map(value => String(value ?? '').toLocaleLowerCase());
      if (!haystack.some(value => value.includes(query))) return false;
    }

    if (filters.status !== 'all' && entry.health.status !== filters.status) return false;
    if (filters.issue === 'missing' && entry.health.counts.missingPlacementIds === 0) return false;
    if (filters.issue === 'candidate' && !entry.candidates.hasCandidates) return false;
    if (filters.type && !(application.formats || []).some(format => format.key === filters.type)) {
      return false;
    }
    if (!sizeMatches(filters.size, placementsOf(application).length)) return false;
    return true;
  });

  const nameSort = (a, b) => String(a.name).localeCompare(String(b.name));
  const severity = { empty: 0, partial: 1, ok: 2 };
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const aEntry = options.healthFor(a);
    const bEntry = options.healthFor(b);
    if (filters.sort === 'recent') {
      return modifiedAt(b) - modifiedAt(a) || nameSort(a, b);
    }
    if (filters.sort === 'issue') {
      return (severity[aEntry.health.status] ?? 9) - (severity[bEntry.health.status] ?? 9)
        || bEntry.health.counts.missingPlacementIds - aEntry.health.counts.missingPlacementIds
        || bEntry.candidates.totalFindings - aEntry.candidates.totalFindings
        || nameSort(a, b);
    }
    return nameSort(a, b);
  });
  return sorted;
}

export function summarizeApplicationRows(applications, healthFor) {
  if (!Array.isArray(applications)) throw new TypeError('applications must be an array');
  if (typeof healthFor !== 'function') throw new TypeError('healthFor must be a function');

  const summary = {
    total: applications.length,
    statuses: { empty: 0, ok: 0, partial: 0 },
    missingApplications: 0,
    candidateApplications: 0
  };
  for (const application of applications) {
    const entry = healthFor(application);
    if (!entry) throw new Error('missing health analysis for application');
    summary.statuses[entry.health.status]++;
    if (entry.health.counts.missingPlacementIds > 0) summary.missingApplications++;
    if (entry.candidates.hasCandidates) summary.candidateApplications++;
  }
  return summary;
}

export { EMPTY_FILTERS };
