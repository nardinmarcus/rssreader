const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('entry-ordering-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const store = require('../lib/store');
const fetcher = require('../lib/fetcher');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function entry(overrides = {}) {
  return {
    id: 'entry-ordering-default',
    sourceId: 'openai',
    title: 'Entry ordering fixture',
    link: 'https://example.com/entry-ordering-default',
    author: '',
    published: null,
    publishedTs: 0,
    summary: '',
    content: '<p>Fixture content</p>',
    image: null,
    audio: null,
    ...overrides,
  };
}

function mixedEntries(limit = 100) {
  return fetcher.getEntries({
    limit,
    includeContent: false,
    includeAssetSummaries: false,
    includeStats: false,
  });
}

test('mixed entries use first ingestion time when upstream publication time is missing', () => {
  store.upsertEntries([
    entry({
      id: 'dated-older-entry',
      published: '2000-01-01T00:00:00.000Z',
      publishedTs: Date.parse('2000-01-01T00:00:00.000Z'),
    }),
    entry({
      id: 'date-less-new-entry',
      sourceId: 'github_trending',
      title: 'example/trending-repository',
      link: 'https://github.com/example/trending-repository',
    }),
  ]);

  const [first] = mixedEntries(1);

  assert.equal(first.id, 'date-less-new-entry');
  assert.equal(first.publishedTs, 0);
  assert.ok(first.createdAt > Date.parse('2000-01-01T00:00:00.000Z'));
});

test('repeat upserts preserve first ingestion ordering for date-less entries', () => {
  const originalNow = Date.now;
  const firstIngestedAt = 2_000_000_000_000;
  try {
    Date.now = () => firstIngestedAt;
    store.upsertEntries([entry({
      id: 'date-less-stable-entry',
      sourceId: 'github_trending',
      title: 'example/stable-repository',
      link: 'https://github.com/example/stable-repository',
    })]);

    Date.now = () => firstIngestedAt + 1000;
    store.upsertEntries([entry({
      id: 'date-less-later-entry',
      sourceId: 'github_trending',
      title: 'example/later-repository',
      link: 'https://github.com/example/later-repository',
    })]);

    Date.now = () => firstIngestedAt + 2000;
    store.upsertEntries([entry({
      id: 'date-less-stable-entry',
      sourceId: 'github_trending',
      title: 'example/stable-repository updated',
      link: 'https://github.com/example/stable-repository',
    })]);
  } finally {
    Date.now = originalNow;
  }

  const ordered = mixedEntries()
    .filter(item => item.id === 'date-less-stable-entry' || item.id === 'date-less-later-entry');

  assert.deepEqual(ordered.map(item => item.id), [
    'date-less-later-entry',
    'date-less-stable-entry',
  ]);
  assert.equal(ordered[1].createdAt, firstIngestedAt);
  assert.equal(ordered[1].publishedTs, 0);
});

test('dated entries remain ordered by upstream publication time', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 2_100_000_000_000;
    store.upsertEntries([entry({
      id: 'published-newer-entry',
      published: '2026-01-02T00:00:00.000Z',
      publishedTs: Date.parse('2026-01-02T00:00:00.000Z'),
    })]);

    Date.now = () => 2_100_000_001_000;
    store.upsertEntries([entry({
      id: 'published-older-entry',
      published: '2026-01-01T00:00:00.000Z',
      publishedTs: Date.parse('2026-01-01T00:00:00.000Z'),
    })]);
  } finally {
    Date.now = originalNow;
  }

  const ordered = mixedEntries()
    .filter(item => item.id === 'published-newer-entry' || item.id === 'published-older-entry');

  assert.deepEqual(ordered.map(item => item.id), [
    'published-newer-entry',
    'published-older-entry',
  ]);
});
