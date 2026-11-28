const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
const stateFile = path.join(dataDir, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({
  'qiaomu-blog': { enabled: false },
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
  openai: {
    fetchedAt: Date.now(),
    status: 'ok',
    entries: [{
      id: 'cache-only-entry',
      sourceId: 'openai',
      title: 'Cache-only entry',
      link: 'https://example.com/cache-only-entry',
      published: '2026-07-01T00:00:00.000Z',
      publishedTs: Date.parse('2026-07-01T00:00:00.000Z'),
      summary: 'This row exists only in the rebuildable cache.',
      content: '<p>cache only</p>',
    }],
  },
}));
process.env.NAMOO_READER_DATA_DIR = dataDir;
const fetcher = require('../lib/fetcher');
const store = require('../lib/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('startup ignores retired state.json source overrides', () => {
  const before = fetcher.getSourceById('qiaomu-blog').enabled;
  fetcher.loadDisk();
  assert.equal(fetcher.getSourceById('qiaomu-blog').enabled, before);
  assert.equal(store.getSourcePreferences().some(item => item.sourceId === 'qiaomu-blog'), false);
});

test('startup does not copy cache-only entries into SQLite', () => {
  fetcher.loadDisk();
  assert.equal(store.getEntry('cache-only-entry'), null);
});

test('flushDisk leaves the retired state.json untouched', () => {
  const before = fs.readFileSync(stateFile, 'utf8');
  fetcher.flushDisk();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});
