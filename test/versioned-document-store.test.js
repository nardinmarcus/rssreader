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

function seedEntry(id, title = 'Versioned article') {
  store.upsertEntries([{
    id,
    sourceId: 'test',
    title,
    link: `https://example.com/${id}`,
    summary: 'Legacy summary',
    content: '<p>Legacy body with enough source text.</p>',
  }]);
}

function snapshotInput(overrides = {}) {
  return {
    id: 'snapshot-1',
    entryId: 'entry-1',
    rawHash: 'raw-hash-1',
    requestUrl: 'https://example.com/start',
    finalUrl: 'https://example.com/final',
    statusCode: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    responseMeta: { etag: 'public-etag' },
    bodyPath: 'raw/sha256/aa/bb/raw-hash-1.html.gz',
    sizeBytes: 128,
    fetchedAt: 1000,
    ...overrides,
  };
}

test('source snapshots are immutable and idempotent through the store seam', () => {
  seedEntry('entry-1');
  const input = snapshotInput();

  const created = store.insertSourceSnapshot(input);
  const reused = store.insertSourceSnapshot({ ...input, responseMeta: { etag: 'public-etag' } });

  assert.equal(created.created, true);
  assert.equal(created.id, 'snapshot-1');
  assert.deepEqual(created.responseMeta, { etag: 'public-etag' });
  assert.equal(reused.created, false);
  assert.equal(reused.id, created.id);
  assert.throws(
    () => store.insertSourceSnapshot({ ...input, finalUrl: 'https://example.net/changed' }),
    /immutable source snapshot conflict/i
  );
});

test('source snapshot response metadata rejects unknown, sensitive, and non-string values', () => {
  seedEntry('snapshot-metadata-entry');
  const before = store.getVersionedDocumentStats();
  const input = snapshotInput({
    id: 'snapshot-metadata-boundary',
    entryId: 'snapshot-metadata-entry',
  });

  assert.throws(
    () => store.insertSourceSnapshot({ ...input, responseMeta: { 'set-cookie': 'session=secret' } }),
    /unsupported response metadata key/i
  );
  assert.throws(
    () => store.insertSourceSnapshot({ ...input, responseMeta: { authorization: 'Bearer secret' } }),
    /unsupported response metadata key/i
  );
  assert.throws(
    () => store.insertSourceSnapshot({ ...input, responseMeta: { etag: { value: 'not-a-string' } } }),
    /response metadata value must be a string/i
  );
  assert.throws(
    () => store.insertSourceSnapshot({ ...input, responseMeta: { etag: 'x'.repeat(4097) } }),
    /response metadata value is too long/i
  );
  assert.equal(store.getVersionedDocumentStats().sourceSnapshots, before.sourceSnapshots);
});

function documentInput(overrides = {}) {
  return {
    id: 'document-1',
    entryId: 'document-entry',
    snapshotId: 'document-snapshot',
    sourceComponents: [{ type: 'discussion', contentHash: 'discussion-hash', snapshotId: null }],
    provenance: 'fetched',
    rawStatus: 'available',
    documentHash: 'document-hash-1',
    sourceHash: 'source-hash-1',
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: 'Versioned document',
    summary: 'Document summary',
    normalizedHtml: '<p>Safe document.</p>',
    plainText: 'Safe document.',
    ast: [{ type: 'paragraph', segmentId: 's_1', text: 'Safe document.' }],
    resources: [],
    createdAt: 2000,
    ...overrides,
  };
}

test('article documents insert idempotently and become the current immutable document', () => {
  seedEntry('document-entry');
  store.insertSourceSnapshot(snapshotInput({ id: 'document-snapshot', entryId: 'document-entry' }));
  store.insertSourceSnapshot(snapshotInput({
    id: 'document-snapshot-later',
    entryId: 'document-entry',
    fetchedAt: 2001,
  }));
  const input = documentInput();

  const created = store.insertArticleDocument(input);
  const reused = store.insertArticleDocument({ ...input, id: 'ignored-id-for-same-document-hash' });
  const observedAgain = store.insertArticleDocument({
    ...input,
    id: 'ignored-id-for-later-observation',
    snapshotId: 'document-snapshot-later',
    createdAt: 2002,
  });

  assert.equal(created.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.id, created.id);
  assert.equal(observedAgain.created, false);
  assert.equal(observedAgain.id, created.id);
  assert.equal(observedAgain.snapshotId, 'document-snapshot');
  assert.equal(observedAgain.createdAt, 2000);
  assert.equal(store.getCurrentArticleDocument('document-entry'), null);
  assert.equal(store.setCurrentArticleDocument('document-entry', created.id).id, created.id);
  assert.equal(store.getCurrentArticleDocument('document-entry').sourceHash, 'source-hash-1');
  assert.throws(
    () => store.insertArticleDocument({ ...input, sourceHash: 'changed-source-hash' }),
    /immutable article document conflict/i
  );
});

function translationVersionInput(overrides = {}) {
  return {
    id: 'translation-version-1',
    entryId: 'translation-entry',
    documentId: 'translation-document',
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: 'translation-document-source-hash',
    pipelineHash: 'translation-pipeline-hash',
    generationHash: 'translation-generation-hash',
    schemaVersion: 2,
    titleZh: '中文标题',
    summaryZh: '中文摘要',
    content: { schemaVersion: 2, translations: [{ id: 's_1', target: '完整译文。' }] },
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    createdAt: 3000,
    ...overrides,
  };
}

function seedCurrentDocument(entryId = 'translation-entry', documentId = 'translation-document') {
  seedEntry(entryId);
  const document = store.insertArticleDocument(documentInput({
    id: documentId,
    entryId,
    snapshotId: null,
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: `${documentId}-hash`,
    sourceHash: `${documentId}-source-hash`,
  }));
  store.setCurrentArticleDocument(entryId, document.id);
  return document;
}

test('translation versions insert idempotently and switch the current translation pointer', () => {
  seedCurrentDocument();
  const input = translationVersionInput();

  const created = store.insertTranslationVersion(input);
  const reused = store.insertTranslationVersion({ ...input, id: 'ignored-id-for-same-generation' });

  assert.equal(created.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.id, created.id);
  assert.deepEqual(store.getTranslationVersion(created.id).content, input.content);
  assert.equal(store.setCurrentTranslationVersion('translation-entry', created.id).id, created.id);
  assert.equal(store.getCurrentTranslationVersion('translation-entry').id, created.id);
  assert.throws(
    () => store.insertTranslationVersion({ ...input, titleZh: '被篡改的标题' }),
    /immutable translation version conflict/i
  );
});

test('versioned insert seams reject empty identifiers and non-finite timestamps', () => {
  seedEntry('invalid-boundary-entry');
  const snapshot = snapshotInput({ id: 'invalid-boundary-snapshot', entryId: 'invalid-boundary-entry' });

  assert.throws(() => store.insertSourceSnapshot({ ...snapshot, id: '' }), /snapshot id is required/i);
  assert.throws(() => store.insertSourceSnapshot({ ...snapshot, fetchedAt: Number.NaN }), /fetchedAt must be finite/i);
  store.insertSourceSnapshot(snapshot);

  const document = documentInput({
    id: 'invalid-boundary-document',
    entryId: 'invalid-boundary-entry',
    snapshotId: snapshot.id,
    documentHash: 'invalid-boundary-document-hash',
  });
  assert.throws(() => store.insertArticleDocument({ ...document, id: '' }), /document id is required/i);
  assert.throws(() => store.insertArticleDocument({ ...document, createdAt: Number.NaN }), /createdAt must be finite/i);
  store.insertArticleDocument(document);

  const version = translationVersionInput({
    id: 'invalid-boundary-version',
    entryId: 'invalid-boundary-entry',
    documentId: document.id,
    generationHash: 'invalid-boundary-generation',
  });
  assert.throws(() => store.insertTranslationVersion({ ...version, id: '' }), /translation version id is required/i);
  assert.throws(() => store.insertTranslationVersion({ ...version, createdAt: Number.NaN }), /createdAt must be finite/i);
});

test('current pointer transactions reject missing and mismatched entries, documents, and translations', () => {
  const documentA = seedCurrentDocument('pointer-entry-a', 'pointer-document-a');
  const documentB = seedCurrentDocument('pointer-entry-b', 'pointer-document-b');

  assert.throws(
    () => store.setCurrentArticleDocument('missing-pointer-entry', documentA.id),
    /entry not found/i
  );
  assert.throws(
    () => store.setCurrentArticleDocument('pointer-entry-a', 'missing-pointer-document'),
    /article document not found/i
  );
  assert.throws(
    () => store.setCurrentArticleDocument('pointer-entry-a', documentB.id),
    /does not belong to entry/i
  );
  assert.equal(store.getCurrentArticleDocument('pointer-entry-a').id, documentA.id);

  const versionB = store.insertTranslationVersion(translationVersionInput({
    id: 'pointer-version-b',
    entryId: 'pointer-entry-b',
    documentId: documentB.id,
    sourceHash: documentB.sourceHash,
    generationHash: 'pointer-generation-b',
  }));
  assert.throws(
    () => store.setCurrentTranslationVersion('missing-pointer-entry', versionB.id),
    /entry not found/i
  );
  assert.throws(
    () => store.setCurrentTranslationVersion('pointer-entry-a', 'missing-pointer-version'),
    /translation version not found/i
  );
  assert.throws(
    () => store.setCurrentTranslationVersion('pointer-entry-a', versionB.id),
    /does not belong to entry/i
  );

  const staleDocument = store.insertArticleDocument(documentInput({
    id: 'pointer-document-a-stale',
    entryId: 'pointer-entry-a',
    snapshotId: null,
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'pointer-document-a-stale-hash',
    sourceHash: 'pointer-document-a-stale-source-hash',
  }));
  const staleVersion = store.insertTranslationVersion(translationVersionInput({
    id: 'pointer-version-a-stale',
    entryId: 'pointer-entry-a',
    documentId: staleDocument.id,
    sourceHash: staleDocument.sourceHash,
    generationHash: 'pointer-generation-a-stale',
  }));
  assert.throws(
    () => store.setCurrentTranslationVersion('pointer-entry-a', staleVersion.id),
    /does not target current document/i
  );
  assert.equal(store.getCurrentTranslationVersion('pointer-entry-a'), null);
});

test('versioned inserts reject cross-entry provenance and mismatched translation source hashes', () => {
  seedEntry('integrity-entry-a');
  seedEntry('integrity-entry-b');
  const snapshotB = store.insertSourceSnapshot(snapshotInput({
    id: 'integrity-snapshot-b',
    entryId: 'integrity-entry-b',
  }));

  assert.throws(
    () => store.insertArticleDocument(documentInput({
      id: 'integrity-document-cross-snapshot',
      entryId: 'integrity-entry-a',
      snapshotId: snapshotB.id,
      documentHash: 'integrity-document-cross-snapshot-hash',
    })),
    /snapshot does not belong to entry/i
  );

  const documentA = store.insertArticleDocument(documentInput({
    id: 'integrity-document-a',
    entryId: 'integrity-entry-a',
    snapshotId: null,
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'integrity-document-a-hash',
    sourceHash: 'integrity-document-a-source-hash',
  }));
  const documentB = store.insertArticleDocument(documentInput({
    id: 'integrity-document-b',
    entryId: 'integrity-entry-b',
    snapshotId: snapshotB.id,
    documentHash: 'integrity-document-b-hash',
    sourceHash: 'integrity-document-b-source-hash',
  }));

  assert.throws(
    () => store.insertTranslationVersion(translationVersionInput({
      id: 'integrity-version-cross-document',
      entryId: 'integrity-entry-a',
      documentId: documentB.id,
      sourceHash: documentB.sourceHash,
      generationHash: 'integrity-generation-cross-document',
    })),
    /document does not belong to entry/i
  );
  assert.throws(
    () => store.insertTranslationVersion(translationVersionInput({
      id: 'integrity-version-wrong-source',
      entryId: 'integrity-entry-a',
      documentId: documentA.id,
      sourceHash: 'wrong-source-hash',
      generationHash: 'integrity-generation-wrong-source',
    })),
    /source hash does not match document/i
  );
});

test('versioned migration scan paginates by entry id and stats expose migration progress', () => {
  const before = store.getVersionedDocumentStats();
  seedEntry('zz-migration-001');
  seedEntry('zz-migration-002');
  seedEntry('zz-migration-003');
  const document = store.insertArticleDocument(documentInput({
    id: 'zz-migration-document-002',
    entryId: 'zz-migration-002',
    snapshotId: null,
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'zz-migration-document-hash-002',
    sourceHash: 'zz-migration-source-hash-002',
  }));
  store.setCurrentArticleDocument('zz-migration-002', document.id);

  const firstPage = store.scanEntriesForVersionedMigration({ afterId: 'zz-migration-', limit: 2 });
  const secondPage = store.scanEntriesForVersionedMigration({ afterId: firstPage.at(-1).id, limit: 2 });
  const after = store.getVersionedDocumentStats();

  assert.deepEqual(firstPage.map(entry => entry.id), ['zz-migration-001', 'zz-migration-002']);
  assert.equal(firstPage[0].link, 'https://example.com/zz-migration-001');
  assert.equal(firstPage[0].currentDocumentId, null);
  assert.equal(firstPage[1].currentDocumentId, document.id);
  assert.deepEqual(secondPage.map(entry => entry.id), ['zz-migration-003']);
  assert.equal(after.entries, before.entries + 3);
  assert.equal(after.entriesWithCurrentDocument, before.entriesWithCurrentDocument + 1);
  assert.equal(after.entriesWithoutCurrentDocument, before.entriesWithoutCurrentDocument + 2);
  assert.equal(after.articleDocuments, before.articleDocuments + 1);
});
