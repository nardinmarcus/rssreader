const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOURCE_HISTORY_SORT,
  SOURCE_HISTORY_DEFAULT_LIMIT,
  SOURCE_HISTORY_MAX_LIMIT,
  parseSourceHistoryLimit,
  parseSourceHistorySort,
  sourceHistorySortKey,
  encodeSourceHistoryCursor,
  decodeSourceHistoryCursor,
} = require('../lib/source-history');

test('parseSourceHistoryLimit defaults to 50 and caps at 100', () => {
  assert.equal(SOURCE_HISTORY_DEFAULT_LIMIT, 50);
  assert.equal(SOURCE_HISTORY_MAX_LIMIT, 100);
  assert.equal(parseSourceHistoryLimit(undefined), 50);
  assert.equal(parseSourceHistoryLimit(''), 50);
  assert.equal(parseSourceHistoryLimit('not-a-number'), 50);
  assert.equal(parseSourceHistoryLimit('0'), 50);
  assert.equal(parseSourceHistoryLimit('-10'), 50);
  assert.equal(parseSourceHistoryLimit(['25']), 50);
  assert.equal(parseSourceHistoryLimit('1'), 1);
  assert.equal(parseSourceHistoryLimit('25'), 25);
  assert.equal(parseSourceHistoryLimit('100'), 100);
  assert.equal(parseSourceHistoryLimit('101'), 100);
  assert.equal(parseSourceHistoryLimit('5000'), 100);
});

test('parseSourceHistorySort binds to published_desc and rejects unknown sorts', () => {
  assert.equal(parseSourceHistorySort(undefined), SOURCE_HISTORY_SORT);
  assert.equal(parseSourceHistorySort(''), SOURCE_HISTORY_SORT);
  assert.equal(parseSourceHistorySort('published_desc'), SOURCE_HISTORY_SORT);
  assert.throws(
    () => parseSourceHistorySort('hot'),
    err => err && err.statusCode === 400,
  );
  assert.throws(
    () => parseSourceHistorySort(['published_desc']),
    err => err && err.statusCode === 400,
  );
});

test('encode/decode source history cursor round-trips dated and unknown-date entries', () => {
  const datedCursor = encodeSourceHistoryCursor({
    sourceId: 'source-a',
    entry: { id: 'entry-1', publishedTs: 1750000000000, createdAt: 1760000000000 },
  });
  assert.deepEqual(
    decodeSourceHistoryCursor(datedCursor, { expectedSourceId: 'source-a' }),
    {
      sourceId: 'source-a',
      sort: 'published_desc',
      hasPublished: 1,
      ts: 1750000000000,
      id: 'entry-1',
    },
  );

  const unknownCursor = encodeSourceHistoryCursor({
    sourceId: 'source-a',
    entry: { id: 'entry-unknown', publishedTs: 0, createdAt: 1770000000000 },
  });
  assert.deepEqual(
    decodeSourceHistoryCursor(unknownCursor, { expectedSourceId: 'source-a' }),
    {
      sourceId: 'source-a',
      sort: 'published_desc',
      hasPublished: 0,
      ts: 1770000000000,
      id: 'entry-unknown',
    },
  );

  assert.deepEqual(
    sourceHistorySortKey({ id: 'entry-tie', publishedTs: 1000, createdAt: 9999 }),
    { hasPublished: 1, ts: 1000, id: 'entry-tie' },
  );
  assert.deepEqual(
    sourceHistorySortKey({ id: 'entry-no-date', publishedTs: 0, createdAt: 9999 }),
    { hasPublished: 0, ts: 9999, id: 'entry-no-date' },
  );
});

test('decodeSourceHistoryCursor rejects malformed, tampered, sort-mismatched, and cross-source cursors', () => {
  assert.equal(decodeSourceHistoryCursor('', { expectedSourceId: 'source-a' }), null);
  assert.equal(decodeSourceHistoryCursor(undefined, { expectedSourceId: 'source-a' }), null);

  const validForA = encodeSourceHistoryCursor({
    sourceId: 'source-a',
    entry: { id: 'entry-1', publishedTs: 1750000000000, createdAt: 1750000000000 },
  });
  assert.throws(
    () => decodeSourceHistoryCursor(validForA, { expectedSourceId: 'source-b' }),
    err => err && err.statusCode === 400 && err.code === 'cross-source-cursor',
  );
  assert.throws(
    () => decodeSourceHistoryCursor(validForA, { expectedSourceId: 'source-a', expectedSort: 'other' }),
    err => err && err.statusCode === 400,
  );

  const malformedTokens = [
    ['array'],
    { raw: true },
    ` ${validForA} `,
    'not-base64!!!',
    Buffer.from('not-json', 'utf8').toString('base64url'),
    Buffer.from('[]', 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 2, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: 100, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'hot', hasPublished: 1, ts: 100, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 2, ts: 100, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: 0, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: -5, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: 1.5, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: 100, id: '' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: '', sort: 'published_desc', hasPublished: 1, ts: 100, id: 'e1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, sourceId: 'source-a', sort: 'published_desc', hasPublished: 1, ts: 100, id: 'e1', extra: 1 })).toString('base64url'),
  ];
  for (const token of malformedTokens) {
    assert.throws(
      () => decodeSourceHistoryCursor(token, { expectedSourceId: 'source-a' }),
      err => err && err.statusCode === 400,
      `expected 400 for cursor ${JSON.stringify(token)}`,
    );
  }
});
