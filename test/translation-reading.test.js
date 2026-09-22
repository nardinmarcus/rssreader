const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-reading-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const { articleDocumentSegments } = require('../lib/article-documents');
const {
  buildTranslationInputV2,
  translationPipelineHash,
} = require('../lib/translation-contract');
const {
  legacyTranslationState,
  publicTranslationJob,
  translationResponse,
  versionedTranslationState,
} = require('../lib/translation-reading');

const PIPELINE_HASH = translationPipelineHash();

function seedDocument(entryId, documentId, sourceHash = `${documentId}-source`) {
  store.upsertEntries([{
    id: entryId,
    sourceId: 'translation-reading-test',
    title: `Title ${entryId}`,
    link: `https://example.com/${entryId}`,
    summary: 'Source summary',
    content: '<p>Source body.</p>',
  }]);
  store.insertArticleDocument({
    id: documentId,
    entryId,
    snapshotId: null,
    sourceComponents: [{ type: 'legacy', contentHash: `${documentId}-content` }],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: `${documentId}-hash`,
    sourceHash,
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: `Title ${entryId}`,
    summary: 'Source summary',
    normalizedHtml: '<p>Source body.</p>',
    plainText: 'Source body.',
    ast: [{ type: 'text', id: 's_body', role: 'paragraph', text: 'Source body.' }],
    resources: [],
    createdAt: 1000,
  });
  return store.getArticleDocument(documentId);
}

// The V2 wire input derives a title segment in front of the body segments;
// production version content covers every derived segment, so the fixture
// derives the same set through the same interface.
function documentInputSegments(document) {
  return buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: articleDocumentSegments(document.ast),
  }).segments;
}

function storedSegmentIds(document) {
  return document.ast
    .filter(node => node.type === 'text' && node.text)
    .map(node => node.id);
}

function seedVersion({
  entryId,
  document,
  id = `${entryId}-version`,
  schemaVersion = 2,
  pipelineHash = PIPELINE_HASH,
  content,
}) {
  const segmentPairs = documentInputSegments(document)
    .map(segment => ({ id: segment.id, text: segment.text }));
  const version = {
    id,
    entryId,
    documentId: document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: document.sourceHash,
    pipelineHash,
    generationHash: `${id}-generation`,
    schemaVersion,
    titleZh: '中文标题',
    summaryZh: '中文摘要',
    content: content === undefined
      ? {
        schemaVersion: 2,
        translations: segmentPairs.map(({ id: segmentId, text }) => ({
          id: segmentId,
          target: `译文：${text}`,
        })),
      }
      : content,
    provider: 'deepseek',
    model: 'deepseek-v4',
    createdAt: 2000,
  };
  store.insertTranslationVersion(version);
  store.setCurrentTranslationVersion(entryId, version.id);
  return { version, segmentPairs };
}

function clearCurrentDocument(entryId) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  try {
    db.prepare('UPDATE entries SET current_document_id = NULL WHERE id = ?').run(entryId);
  } finally {
    db.close();
  }
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('reading state falls back to legacy projections without a version', () => {
  const document = seedDocument('reading-legacy', 'reading-legacy-document');
  store.setCurrentArticleDocument('reading-legacy', document.id);
  const entry = store.getEntry('reading-legacy');

  const missing = versionedTranslationState(entry);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.translation, null);
  assert.equal(missing.schemaVersion, null);
  assert.equal(missing.documentId, document.id);
  assert.equal(missing.renderedHtml, null);

  assert.equal(legacyTranslationState(entry, null, null).documentId, document.id);
  assert.equal(translationResponse(entry), null);
});

test('a fresh schema-2 version renders from its pinned document', () => {
  const document = seedDocument('reading-fresh', 'reading-fresh-document');
  store.setCurrentArticleDocument('reading-fresh', document.id);
  const { segmentPairs } = seedVersion({ entryId: 'reading-fresh', document });
  const entry = store.getEntry('reading-fresh');

  const state = versionedTranslationState(entry);
  assert.equal(state.status, 'fresh');
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.versionId, 'reading-fresh-version');
  assert.deepEqual(state.staleReasons, []);
  assert.deepEqual(state.translation.content, segmentPairs.map(({ id, text }) => ({
    segmentId: id,
    source: text,
    target: `译文：${text}`,
  })));
  assert.match(state.renderedHtml, /译文：Source body\./);
  assert.equal(state.translation.stale, false);
});

test('a version pinned to a replaced source reports stale_source through the entry', () => {
  const original = seedDocument('reading-stale', 'reading-stale-document-a');
  store.setCurrentArticleDocument('reading-stale', original.id);
  seedVersion({ entryId: 'reading-stale', document: original });
  const replacement = seedDocument('reading-stale', 'reading-stale-document-b', 'reading-stale-source-b');
  store.setCurrentArticleDocument('reading-stale', replacement.id);
  const entry = store.getEntry('reading-stale');

  const state = versionedTranslationState(entry);
  assert.equal(state.status, 'stale_source');
  assert.deepEqual(state.staleReasons, ['source_document_changed', 'source_hash_changed']);
  assert.equal(state.documentId, original.id);
  assert.equal(state.translation.stale, true);
});

test('an older pipeline hash reports stale_pipeline while the source stays fresh', () => {
  const document = seedDocument('reading-pipeline', 'reading-pipeline-document');
  store.setCurrentArticleDocument('reading-pipeline', document.id);
  seedVersion({ entryId: 'reading-pipeline', document, pipelineHash: 'pipeline-v0' });
  const entry = store.getEntry('reading-pipeline');

  const state = versionedTranslationState(entry);
  assert.equal(state.status, 'stale_pipeline');
  assert.deepEqual(state.staleReasons, ['pipeline_hash_changed']);
});

test('a version whose pinned document disappeared fails closed', () => {
  const document = seedDocument('reading-orphan', 'reading-orphan-document');
  store.setCurrentArticleDocument('reading-orphan', document.id);
  seedVersion({ entryId: 'reading-orphan', document });
  const entry = store.getEntry('reading-orphan');
  clearCurrentDocument('reading-orphan');

  assert.throws(
    () => versionedTranslationState(entry),
    error => error.code === 'ERR_TRANSLATION_DOCUMENT_UNAVAILABLE' && error.statusCode === 409,
  );
});

test('unsupported schema versions fail closed', () => {
  const document = seedDocument('reading-unsupported', 'reading-unsupported-document');
  store.setCurrentArticleDocument('reading-unsupported', document.id);
  seedVersion({
    entryId: 'reading-unsupported',
    document,
    id: 'reading-unsupported-v3',
    schemaVersion: 3,
  });
  const entry = store.getEntry('reading-unsupported');

  assert.throws(
    () => versionedTranslationState(entry),
    error => error.code === 'ERR_TRANSLATION_VERSION_UNSUPPORTED' && error.statusCode === 409,
  );
});

test('schema-1 versions keep the legacy reader shape without entering the renderer', () => {
  const document = seedDocument('reading-schema1', 'reading-schema1-document');
  store.setCurrentArticleDocument('reading-schema1', document.id);
  const [segmentId] = storedSegmentIds(document);
  const legacyContent = [{ id: segmentId, target: '旧译文。' }];
  seedVersion({
    entryId: 'reading-schema1',
    document,
    id: 'reading-schema1-version',
    schemaVersion: 1,
    content: legacyContent,
  });
  const entry = store.getEntry('reading-schema1');

  const state = versionedTranslationState(entry);
  assert.equal(state.status, 'fresh');
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.renderedHtml, null);
  assert.deepEqual(state.translation.content, legacyContent);
});

test('job progress projection exposes only safe fields', () => {
  const running = publicTranslationJob({
    id: 'job-1',
    status: 'running',
    chunks: [{ status: 'succeeded' }, { status: 'queued' }],
    userId: 'secret-user',
    tuning: { temperature: 0.15 },
    createdAt: 10,
    updatedAt: 20,
    completedAt: null,
  });
  assert.deepEqual(running, {
    id: 'job-1',
    status: 'running',
    progress: { completed: 1, total: 2 },
    error: null,
    createdAt: 10,
    updatedAt: 20,
    completedAt: null,
  });

  const failed = publicTranslationJob({ id: 'job-2', status: 'failed', chunks: [] });
  assert.equal(failed.error.code, 'ERR_TRANSLATION_JOB_FAILED');
  assert.equal(publicTranslationJob(null), null);
});
