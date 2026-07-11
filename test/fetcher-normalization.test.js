const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const fetcher = require('../lib/fetcher');
const { normalizeFeedAuthor } = fetcher;

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('feed author objects and arrays become SQLite-safe text', () => {
  assert.equal(normalizeFeedAuthor({
    name: ['Philipp Schmid'],
    title: ['Developer Relations Engineer'],
  }), 'Philipp Schmid');
  assert.equal(normalizeFeedAuthor(['Alice', { name: ['Bob'] }]), 'Alice、Bob');
  assert.equal(normalizeFeedAuthor(null), '');
});

test('SQLite remains the article and source-count truth when cache.json is empty', () => {
  store.upsertEntries([{
    id: 'sqlite-only-entry',
    sourceId: 'openai',
    title: 'SQLite survives an empty runtime cache',
    link: 'https://example.com/sqlite-entry',
    author: 'Namoo',
    published: '2026-07-11T00:00:00.000Z',
    publishedTs: Date.parse('2026-07-11T00:00:00.000Z'),
    summary: 'The persisted article must remain visible without cache.json.',
    content: '<p>Persisted content</p>',
  }]);

  fetcher.loadDisk({ upsert: false });
  const entries = fetcher.getEntries({ limit: 5 });
  const openai = fetcher.getSourcesMeta().find(source => source.id === 'openai');
  assert.equal(entries.some(entry => entry.id === 'sqlite-only-entry'), true);
  assert.equal(openai.entryCount, 1);
  assert.equal(openai.status, 'cached');
});
