const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertEditorialPriority,
  mergeSourcesWithPreferences,
  moveSourceWithinCategory,
} = require('../lib/source-preferences');

const catalog = [
  { id: 'a', category: 'article', enabled: true, editorialPriority: 'high', labels: ['官方'] },
  { id: 'b', category: 'article', enabled: true, editorialPriority: 'normal', labels: ['创作'] },
  { id: 'c', category: 'news', enabled: false, editorialPriority: 'low', labels: ['产业'] },
];

test('catalog defaults are used when no preferences exist', () => {
  const sources = mergeSourcesWithPreferences(catalog);
  assert.deepEqual(sources.map(source => ({
    id: source.id,
    enabled: source.enabled,
    priority: source.editorialPriority,
    order: source.displayOrder,
  })), [
    { id: 'a', enabled: true, priority: 'high', order: 0 },
    { id: 'b', enabled: true, priority: 'normal', order: 1 },
    { id: 'c', enabled: false, priority: 'low', order: 2 },
  ]);
});

test('stored preferences override defaults and normalize duplicate order values', () => {
  const sources = mergeSourcesWithPreferences(catalog, [
    { sourceId: 'a', enabled: false, editorialPriority: 'low', displayOrder: 4 },
    { sourceId: 'b', enabled: true, editorialPriority: 'high', displayOrder: 4 },
  ]);
  assert.equal(sources.find(source => source.id === 'a').enabled, false);
  assert.equal(sources.find(source => source.id === 'b').editorialPriority, 'high');
  assert.deepEqual(sources.map(source => source.displayOrder), [0, 1, 2]);
});

test('new catalog sources appear without a stored preference', () => {
  const existing = mergeSourcesWithPreferences(catalog.slice(0, 2), [
    { sourceId: 'a', enabled: false, editorialPriority: 'low', displayOrder: 0 },
  ]);
  const expanded = mergeSourcesWithPreferences([...catalog, { id: 'd', category: 'news', enabled: true }], existing);
  assert.equal(expanded.find(source => source.id === 'd').enabled, true);
});

test('priority validation rejects unknown values', () => {
  assert.equal(assertEditorialPriority('HIGH'), 'high');
  assert.throws(() => assertEditorialPriority('urgent'), /high, normal, or low/);
});

test('move swaps adjacent sources only inside the same category', () => {
  const down = moveSourceWithinCategory(catalog, 'a', 'down');
  assert.equal(down.moved, true);
  assert.deepEqual(down.sources.map(source => source.id), ['b', 'a', 'c']);
  const edge = moveSourceWithinCategory(down.sources, 'a', 'down');
  assert.equal(edge.moved, false);
  assert.deepEqual(edge.sources.map(source => source.id), ['b', 'a', 'c']);
});

test('move validates direction and source id', () => {
  assert.throws(() => moveSourceWithinCategory(catalog, 'a', 'left'), /up or down/);
  assert.throws(() => moveSourceWithinCategory(catalog, 'missing', 'up'), /source not found/);
});
