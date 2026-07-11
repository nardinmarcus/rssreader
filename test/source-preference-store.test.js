const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('source preferences persist enabled, priority, and order', () => {
  store.saveSourcePreference({
    sourceId: 'openai',
    enabled: true,
    editorialPriority: 'high',
    displayOrder: 2,
  });
  assert.deepEqual(store.getSourcePreferences().map(item => ({
    sourceId: item.sourceId,
    enabled: item.enabled,
    editorialPriority: item.editorialPriority,
    displayOrder: item.displayOrder,
  })), [{
    sourceId: 'openai',
    enabled: true,
    editorialPriority: 'high',
    displayOrder: 2,
  }]);
});

test('legacy import never overwrites a newer SQLite preference', () => {
  store.saveSourcePreference({
    sourceId: 'legacy-source',
    enabled: false,
    editorialPriority: 'low',
    displayOrder: 4,
  });
  store.importLegacySourcePreferences([{
    sourceId: 'legacy-source',
    enabled: true,
    editorialPriority: 'normal',
    displayOrder: 0,
  }]);
  const preference = store.getSourcePreferences().find(item => item.sourceId === 'legacy-source');
  assert.equal(preference.enabled, false);
  assert.equal(preference.editorialPriority, 'low');
  assert.equal(preference.displayOrder, 4);
});

test('batch writes validate all rows before opening a transaction', () => {
  assert.throws(() => store.saveSourcePreferences([
    { sourceId: 'valid', enabled: true, editorialPriority: 'normal', displayOrder: 1 },
    { sourceId: 'invalid', enabled: true, editorialPriority: 'urgent', displayOrder: 2 },
  ]), /high, normal, or low/);
  assert.equal(store.getSourcePreferences().some(item => item.sourceId === 'valid'), false);
});
