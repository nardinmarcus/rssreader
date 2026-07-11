const EDITORIAL_PRIORITIES = Object.freeze(['high', 'normal', 'low']);

function normalizeEditorialPriority(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  return EDITORIAL_PRIORITIES.includes(normalized) ? normalized : fallback;
}

function assertEditorialPriority(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!EDITORIAL_PRIORITIES.includes(normalized)) {
    const error = new Error('editorial priority must be high, normal, or low');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeLabels(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(label => String(label || '').trim()).filter(Boolean))];
}

function preferenceMap(rows = []) {
  return new Map(rows
    .filter(row => row && row.sourceId)
    .map(row => [String(row.sourceId), row]));
}

function mergeSourcesWithPreferences(sources = [], rows = []) {
  const preferences = preferenceMap(rows);
  return sources
    .map((source, index) => {
      const preference = preferences.get(source.id) || {};
      const configuredOrder = Number(preference.displayOrder);
      const defaultOrder = Number(source.displayOrder);
      return {
        ...source,
        labels: normalizeLabels(source.labels),
        enabled: typeof preference.enabled === 'boolean' ? preference.enabled : Boolean(source.enabled),
        editorialPriority: normalizeEditorialPriority(
          preference.editorialPriority,
          normalizeEditorialPriority(source.editorialPriority),
        ),
        displayOrder: Number.isFinite(configuredOrder)
          ? configuredOrder
          : Number.isFinite(defaultOrder) ? defaultOrder : index,
        _catalogIndex: index,
      };
    })
    .sort((a, b) => (a.displayOrder - b.displayOrder) || (a._catalogIndex - b._catalogIndex))
    .map((source, index) => {
      const normalized = { ...source, displayOrder: index };
      delete normalized._catalogIndex;
      return normalized;
    });
}

function moveSourceWithinCategory(sources = [], sourceId, direction) {
  if (direction !== 'up' && direction !== 'down') {
    const error = new Error('direction must be up or down');
    error.statusCode = 400;
    throw error;
  }
  const ordered = mergeSourcesWithPreferences(sources);
  const source = ordered.find(item => item.id === sourceId);
  if (!source) {
    const error = new Error('source not found');
    error.statusCode = 404;
    throw error;
  }
  const categorySources = ordered.filter(item => item.category === source.category);
  const categoryIndex = categorySources.findIndex(item => item.id === sourceId);
  const neighbor = categorySources[categoryIndex + (direction === 'up' ? -1 : 1)];
  if (!neighbor) return { moved: false, neighborId: '', sources: ordered };

  const sourceIndex = ordered.findIndex(item => item.id === source.id);
  const neighborIndex = ordered.findIndex(item => item.id === neighbor.id);
  [ordered[sourceIndex], ordered[neighborIndex]] = [ordered[neighborIndex], ordered[sourceIndex]];
  return {
    moved: true,
    neighborId: neighbor.id,
    sources: ordered.map((item, index) => ({ ...item, displayOrder: index })),
  };
}

module.exports = {
  EDITORIAL_PRIORITIES,
  assertEditorialPriority,
  mergeSourcesWithPreferences,
  moveSourceWithinCategory,
  normalizeEditorialPriority,
  normalizeLabels,
};
