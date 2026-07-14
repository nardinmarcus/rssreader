const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('versioned-pipeline-status-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const store = require('../lib/store');
const { translationPipelineHash } = require('../lib/translation-contract');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedDocument(entryId, suffix = 'current') {
  const document = store.insertArticleDocument({
    id: `${entryId}-${suffix}-document`,
    entryId,
    snapshotId: null,
    sourceComponents: [],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: `${entryId}-${suffix}-document-hash`,
    sourceHash: `${entryId}-${suffix}-source-hash`,
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: `Private title ${entryId}`,
    summary: '',
    normalizedHtml: '<p>Private source body</p>',
    plainText: 'Private source body',
    ast: [{
      type: 'element',
      tag: 'p',
      children: [{ type: 'text', id: 's_body', role: 'paragraph', text: 'Private source body' }],
    }],
    resources: [],
    createdAt: 100,
  });
  store.setCurrentArticleDocument(entryId, document.id);
  return document;
}

function seedEntry(entryId) {
  store.upsertEntries([{
    id: entryId,
    sourceId: 'status-test',
    title: `Private title ${entryId}`,
    link: `https://example.com/${entryId}`,
    summary: '',
    content: '<p>Private source body</p>',
  }]);
  return seedDocument(entryId);
}

function publish(entryId, document, pipelineHash) {
  return store.publishTranslationVersion({
    id: `${entryId}-translation-version`,
    entryId,
    documentId: document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: document.sourceHash,
    pipelineHash,
    generationHash: `${entryId}-generation-hash`,
    schemaVersion: 2,
    titleZh: 'Private translated title',
    summaryZh: '',
    content: { schemaVersion: 2, translations: [{ id: 's_body', target: 'Private output' }] },
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    createdAt: 200,
  }, { promotion: 'auto' });
}

function seedStatusMatrix(now) {
  const fresh = seedEntry('status-fresh');
  publish('status-fresh', fresh, translationPipelineHash());

  const staleSource = seedEntry('status-stale-source');
  publish('status-stale-source', staleSource, translationPipelineHash());
  seedDocument('status-stale-source', 'updated');

  const stalePipeline = seedEntry('status-stale-pipeline');
  publish('status-stale-pipeline', stalePipeline, 'old-pipeline-hash');

  const legacy = seedEntry('status-legacy');
  publish('status-legacy', legacy, 'legacy_unknown');

  const rawOnly = seedEntry('status-raw-only');
  publish('status-raw-only', rawOnly, translationPipelineHash());
  const rawOnlyCurrent = store.insertArticleDocument({
    ...rawOnly,
    id: 'status-raw-only-new-evidence-document',
    documentHash: 'status-raw-only-new-evidence-hash',
    createdAt: 150,
  });
  store.setCurrentArticleDocument('status-raw-only', rawOnlyCurrent.id);

  seedEntry('status-missing');

  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  const insert = db.prepare(`
    INSERT INTO translation_jobs (
      id, entry_id, document_id, owner_type, user_id, author, source_hash,
      pipeline_hash, generation_hash, provider, model, tuning_json, priority,
      status, attempt_count, error_code, error_message, created_at, updated_at
    ) VALUES (?, 'status-fresh', ?, 'system', NULL, 'Namoo Reader', ?, ?, ?,
      'deepseek', 'deepseek-v4-flash', '{}', 10, ?, 0, ?, ?, ?, ?)
  `);
  const rows = [
    ['queued', 'queued', null, null, now - 9_000],
    ['running', 'running', null, null, now - 2_000],
    ['retry', 'retry_wait', 'HTTP_429', 'Private provider body', now - 7_000],
    ['failed-auth', 'failed', 'ERR_AUTH', 'Private secret detail', now - 6_000],
    ['failed-auth-2', 'failed', 'ERR_AUTH', 'Another private detail', now - 5_000],
  ];
  for (const [id, status, errorCode, errorMessage, createdAt] of rows) {
    insert.run(
      `status-job-${id}`,
      fresh.id,
      fresh.sourceHash,
      translationPipelineHash(),
      `status-generation-${id}`,
      status,
      errorCode,
      errorMessage,
      createdAt,
      createdAt,
    );
  }
  db.close();

  const rawDir = path.join(dataDir, 'raw', 'sha256', 'aa', 'bb');
  fs.mkdirSync(rawDir, { recursive: true });
  const recent = path.join(rawDir, `${'a'.repeat(64)}.html.gz`);
  const old = path.join(rawDir, `${'b'.repeat(64)}.html.gz`);
  fs.writeFileSync(recent, Buffer.alloc(10));
  fs.writeFileSync(old, Buffer.alloc(20));
  fs.utimesSync(recent, new Date(now - 1_000), new Date(now - 1_000));
  fs.utimesSync(old, new Date(now - (48 * 60 * 60 * 1000)), new Date(now - (48 * 60 * 60 * 1000)));
}

test('status aggregates durable jobs, freshness, and raw storage without leaking content', () => {
  const now = 2_000_000_000_000;
  seedStatusMatrix(now);
  const { getVersionedPipelineStatus } = require('../lib/versioned-pipeline-status');

  const status = getVersionedPipelineStatus({ now });

  assert.deepEqual(status.jobs, {
    queued: 1,
    running: 1,
    retry: 1,
    failed: 2,
    oldestWaitingAgeMs: 9_000,
    failuresByCode: { ERR_AUTH: 2 },
  });
  assert.deepEqual(status.freshness, {
    fresh: 2,
    staleSource: 1,
    stalePipeline: 1,
    legacyUnknown: 1,
    missing: 1,
  });
  assert.deepEqual(status.rawStorage, {
    files: 2,
    compressedBytes: 30,
    recent24hBytes: 10,
  });
  assert.equal(status.generatedAt, now);
  assert.doesNotMatch(JSON.stringify(status), /Private|secret|provider body/i);
});
