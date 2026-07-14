const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('namoo-reader-document-pipeline-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
process.env.VERSIONED_TRANSLATION_MODE = 'shadow';

const store = require('../lib/store');
const pipeline = require('../lib/document-pipeline');
const snapshots = require('../lib/source-snapshots');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedEntry(overrides = {}) {
  const entry = {
    id: 'pipeline-feed-entry',
    sourceId: 'pipeline-test',
    title: 'Pipeline feed article',
    link: 'https://example.com/articles/pipeline',
    summary: 'Legacy summary',
    content: '<p>Legacy body with <a href="/source">a source link</a>.</p>',
    ...overrides,
  };
  store.upsertEntries([entry]);
  return store.getEntry(entry.id);
}

test('off mode performs no document or raw snapshot writes', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  process.env.VERSIONED_TRANSLATION_MODE = 'off';
  const entry = seedEntry({ id: 'pipeline-off-entry' });
  const before = store.getVersionedDocumentStats();
  try {
    const feed = await pipeline.captureFeed({ entry });
    const fetched = await pipeline.captureFetched({
      entry,
      response: {
        requestUrl: entry.link,
        finalUrl: entry.link,
        statusCode: 200,
        contentType: 'text/html',
        charset: 'utf-8',
        responseMeta: {},
        buffer: Buffer.from('off mode must not persist these bytes'),
      },
    });
    const after = store.getVersionedDocumentStats();

    assert.deepEqual(Object.keys(pipeline).sort(), ['captureFeed', 'captureFetched']);
    assert.equal(feed.captured, false);
    assert.equal(fetched.captured, false);
    assert.deepEqual(after, before);
    assert.equal(store.getCurrentArticleDocument(entry.id), null);
    await assert.rejects(
      snapshots.read('88a8b91782569e0476c9e1874498f6491801e36f472e28e4f83e247db1f4e9ac'),
      /ENOENT/
    );
  } finally {
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
  }
});

test('captureFeed writes a feed document without fabricating a source snapshot', async () => {
  const entry = seedEntry();

  const result = await pipeline.captureFeed({ entry });
  const current = store.getCurrentArticleDocument(entry.id);

  assert.equal(result.captured, true);
  assert.equal(current.id, result.document.id);
  assert.equal(current.provenance, 'feed');
  assert.equal(current.rawStatus, 'unavailable');
  assert.equal(current.snapshotId, null);
  assert.equal(result.comparison.legacyPlainText, 'Legacy body with a source link.');
  assert.equal(result.comparison.versionedPlainText, 'Legacy body with\na source link\n.');
  assert.deepEqual(result.comparison.legacyResourceUrls, ['https://example.com/source']);
  assert.deepEqual(result.comparison.versionedResourceUrls, ['https://example.com/source']);
  assert.deepEqual(result.comparison.bodyCoverage, {
    legacyCharacters: 31,
    versionedCharacters: 32,
    ratio: 1.0323,
    deltaCharacters: 1,
  });
});

test('captureFetched stores raw bytes before durable provenance and leaves only an orphan blob on DB failure', async () => {
  const entry = seedEntry({
    id: 'pipeline-fetched-entry',
    title: 'Fetched pipeline article',
    content: '<article><p>Extracted article body.</p></article>',
  });
  const buffer = Buffer.from('<!doctype html><main><p>Raw upstream page.</p></main>');
  const response = {
    requestUrl: 'https://example.com/start',
    finalUrl: entry.link,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    charset: 'utf-8',
    responseMeta: { etag: 'test-etag' },
    buffer,
  };

  const result = await pipeline.captureFetched({ entry, response });
  const current = store.getCurrentArticleDocument(entry.id);

  assert.equal(result.captured, true);
  assert.equal(current.provenance, 'fetched');
  assert.equal(current.rawStatus, 'available');
  assert.equal(current.snapshotId, result.snapshot.id);
  assert.deepEqual(await snapshots.read(result.snapshot.rawHash), buffer);
  assert.equal(result.snapshot.bodyPath, snapshots.relativePath(result.snapshot.rawHash));

  const before = store.getVersionedDocumentStats();
  const orphan = Buffer.from('<html><p>Orphan after rejected DB row.</p></html>');
  await assert.rejects(
    pipeline.captureFetched({
      entry: { ...entry, id: 'missing-pipeline-entry' },
      response: { ...response, buffer: orphan },
    }),
    /foreign key constraint/i
  );
  const after = store.getVersionedDocumentStats();
  assert.equal(after.sourceSnapshots, before.sourceSnapshots);
  assert.deepEqual(
    await snapshots.read('2520646a3ce0bb468e1ab9b282d9c899c336c0c5669c6150991f064736556285'),
    orphan
  );
});

test('captureFetched reuses the immutable document when a later snapshot has identical content', async () => {
  const entry = seedEntry({
    id: 'pipeline-repeat-entry',
    title: 'Repeated fetched article',
    content: '<article><p>Stable extracted article body.</p></article>',
  });
  const response = {
    requestUrl: entry.link,
    finalUrl: entry.link,
    statusCode: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    responseMeta: {},
    buffer: Buffer.from('<!doctype html><article><p>Stable upstream body.</p></article>'),
  };
  const before = store.getVersionedDocumentStats();

  const first = await pipeline.captureFetched({ entry, response });
  const second = await pipeline.captureFetched({ entry, response });
  const after = store.getVersionedDocumentStats();

  assert.notEqual(first.snapshot.id, second.snapshot.id);
  assert.equal(second.document.id, first.document.id);
  assert.equal(second.document.created, false);
  assert.equal(store.getCurrentArticleDocument(entry.id).id, first.document.id);
  assert.equal(after.sourceSnapshots, before.sourceSnapshots + 2);
  assert.equal(after.articleDocuments, before.articleDocuments + 1);
});

test('captureFetched creates a new immutable document when the normalized title changes', async () => {
  const entry = seedEntry({
    id: 'pipeline-title-change-entry',
    title: 'Original fetched title',
    summary: 'Stable fetched summary',
    content: '<article><p>Stable extracted article body.</p></article>',
  });
  const response = {
    requestUrl: entry.link,
    finalUrl: entry.link,
    statusCode: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    responseMeta: {},
    buffer: Buffer.from('<!doctype html><article><p>Stable upstream body.</p></article>'),
  };

  const first = await pipeline.captureFetched({ entry, response });
  store.upsertEntries([{ ...entry, title: 'Updated fetched title' }]);
  const second = await pipeline.captureFetched({ entry: store.getEntry(entry.id), response });

  assert.notEqual(second.document.id, first.document.id);
  assert.notEqual(second.document.documentHash, first.document.documentHash);
  assert.notEqual(second.document.sourceHash, first.document.sourceHash);
  assert.equal(store.getCurrentArticleDocument(entry.id).title, 'Updated fetched title');
});

test('captureFetched creates a new immutable document when translation context changes', async () => {
  const entry = seedEntry({
    id: 'pipeline-summary-change-entry',
    title: 'Stable fetched title',
    summary: 'Original translation context',
    content: '<article><p>Stable extracted article body.</p></article>',
  });
  const response = {
    requestUrl: entry.link,
    finalUrl: entry.link,
    statusCode: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    responseMeta: {},
    buffer: Buffer.from('<!doctype html><article><p>Stable upstream body.</p></article>'),
  };

  const first = await pipeline.captureFetched({ entry, response });
  store.upsertEntries([{ ...entry, summary: 'Updated translation context' }]);
  const second = await pipeline.captureFetched({ entry: store.getEntry(entry.id), response });

  assert.notEqual(second.document.id, first.document.id);
  assert.notEqual(second.document.documentHash, first.document.documentHash);
  assert.notEqual(second.document.sourceHash, first.document.sourceHash);
  assert.equal(store.getCurrentArticleDocument(entry.id).summary, 'Updated translation context');
});
