const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-version-store-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedEntry(entryId) {
  store.upsertEntries([{
    id: entryId,
    sourceId: 'translation-version-test',
    title: `Title ${entryId}`,
    link: `https://example.com/${entryId}`,
    summary: 'Source summary',
    content: '<p>Source body.</p>',
  }]);
}

function seedCurrentDocument(entryId, documentId = `${entryId}-document`) {
  seedEntry(entryId);
  const document = store.insertArticleDocument({
    id: documentId,
    entryId,
    snapshotId: null,
    sourceComponents: [{ type: 'legacy', contentHash: `${entryId}-content` }],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: `${documentId}-hash`,
    sourceHash: `${documentId}-source-hash`,
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
  store.setCurrentArticleDocument(entryId, document.id);
  return document;
}

function versionInput(entryId, document, overrides = {}) {
  return {
    id: `${entryId}-version`,
    entryId,
    documentId: document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: document.sourceHash,
    pipelineHash: 'pipeline-v2',
    generationHash: `${entryId}-generation`,
    schemaVersion: 2,
    titleZh: `中文 ${entryId}`,
    summaryZh: '中文摘要',
    content: {
      schemaVersion: 2,
      translations: [{ id: 's_body', target: '系统译文。' }],
    },
    provider: 'deepseek',
    model: 'deepseek-v4',
    createdAt: 2000,
    ...overrides,
  };
}

function createTestUser(label) {
  return store.createUser({
    email: `${label}@example.com`,
    password: 'correct-horse-battery-staple',
    displayName: label,
  });
}

function seedRunningJob(job, leaseToken = 'active-lease-token') {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO translation_jobs (
      id, entry_id, document_id, owner_type, user_id, author, source_hash, pipeline_hash,
      generation_hash, provider, model, tuning_json, status, attempt_count, lease_token,
      lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'running', 1, ?, ?, ?, ?)
  `).run(
    job.id,
    job.entryId,
    job.documentId,
    job.ownerType,
    job.userId,
    job.author,
    job.sourceHash,
    job.pipelineHash,
    job.generationHash,
    job.provider,
    job.model,
    leaseToken,
    4000,
    1000,
    1000,
  );
  db.close();
}

function readJob(jobId) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  const row = db.prepare(`
    SELECT status, lease_token, lease_expires_at, completed_at, updated_at
    FROM translation_jobs
    WHERE id = ?
  `).get(jobId);
  db.close();
  return row ? { ...row } : null;
}

test('system publication exports fixed policies and atomically becomes the current compatible translation', () => {
  const entryId = 'publish-system-auto';
  const document = seedCurrentDocument(entryId);

  assert.deepEqual(store.TRANSLATION_VERSION_PROMOTIONS, {
    AUTO: 'auto',
    NEVER: 'never',
    ADMIN: 'admin',
    LEGACY: 'legacy',
  });
  assert.equal(typeof store.publishTranslationVersion, 'function');

  const published = store.publishTranslationVersion(versionInput(entryId, document), {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const current = store.getCurrentTranslationVersion(entryId);
  const compatible = store.getTranslation(entryId);

  assert.equal(published.created, true);
  assert.equal(published.promoted, true);
  assert.equal(published.pointerChanged, true);
  assert.equal(current.id, `${entryId}-version`);
  assert.equal(compatible.contributorId, '');
  assert.equal(compatible.createdBy, 'Namoo Reader');
  assert.equal(compatible.model, 'deepseek-v4');
  assert.equal(compatible.provider, 'deepseek');
  assert.equal(compatible.contentHash, 'b311abafd08ce1ae07c827b5eaffe09730c798c1d64c647ec547e276456af1e1');
  assert.deepEqual(compatible.content, [
    { segmentId: 's_body', source: '', target: '系统译文。' },
  ]);
});

test('never promotion keeps a user version as a stable contribution without changing current translation', () => {
  const entryId = 'publish-user-never';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('publish-user-never');
  const input = versionInput(entryId, document, {
    id: 'user-never-asset-id',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'user-never-generation',
    titleZh: '用户译文',
    content: {
      schemaVersion: 2,
      translations: [{ id: 's_body', target: '用户独立译文。' }],
    },
  });

  const published = store.publishTranslationVersion(input, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER,
  });
  const contribution = store.getAiAssetContribution(published.assetId, 'translation');

  assert.equal(published.created, true);
  assert.equal(published.promoted, false);
  assert.equal(published.pointerChanged, false);
  assert.equal(store.getCurrentTranslationVersion(entryId), null);
  assert.equal(store.getTranslation(entryId), null);
  assert.equal(contribution.id, published.assetId);
  assert.notEqual(contribution.id, input.id);
  assert.equal(contribution.contributorId, user.id);
  assert.equal(contribution.author, user.displayName);
  assert.equal(contribution.createdAt, input.createdAt);
  assert.equal(contribution.contentHash, 'c70d322a8678ae6237587916c1527b9ca8c8d2dbb20d1e3846f8ec99ffc43463');
  assert.deepEqual(contribution.content, [
    { segmentId: 's_body', source: '', target: '用户独立译文。' },
  ]);
});

test('a stable user asset head resolves the latest immutable version without hiding older version ids', () => {
  const entryId = 'publish-user-stable-asset-head';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('publish-user-stable-asset-head');
  const first = versionInput(entryId, document, {
    id: 'stable-asset-version-one',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'stable-asset-generation-one',
    createdAt: 2000,
    content: {
      schemaVersion: 2,
      translations: [{ id: 's_body', target: '第一版。' }],
    },
  });
  const second = versionInput(entryId, document, {
    ...first,
    id: 'stable-asset-version-two',
    generationHash: 'stable-asset-generation-two',
    createdAt: 3000,
    content: {
      schemaVersion: 2,
      translations: [{ id: 's_body', target: '第二版。' }],
    },
  });

  store.publishTranslationVersion(first, { promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER });
  const stableAssetId = store.getUserTranslations(user.id)[0].id;
  store.publishTranslationVersion(second, { promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER });
  store.publishTranslationVersion(first, { promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER });

  assert.notEqual(stableAssetId, first.id);
  assert.notEqual(stableAssetId, second.id);
  assert.equal(store.getUserTranslations(user.id)[0].id, stableAssetId);
  assert.equal(store.resolveTranslationVersionAsset(entryId, stableAssetId).version.id, second.id);
  assert.equal(store.resolveTranslationVersionAsset(entryId, first.id).version.id, first.id);
  assert.equal(store.getAiAssetContribution(stableAssetId, 'translation').content[0].target, '第二版。');
});

test('publication fails closed when an existing asset head points to a version with different ownership', () => {
  const entryId = 'publish-user-corrupt-asset-head';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('publish-user-corrupt-asset-head');
  const first = versionInput(entryId, document, {
    id: 'corrupt-asset-user-version-one',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'corrupt-asset-user-generation-one',
  });
  const system = versionInput(entryId, document, {
    id: 'corrupt-asset-system-version',
    generationHash: 'corrupt-asset-system-generation',
  });
  const next = versionInput(entryId, document, {
    ...first,
    id: 'corrupt-asset-user-version-two',
    generationHash: 'corrupt-asset-user-generation-two',
    createdAt: 3000,
  });
  const firstPublished = store.publishTranslationVersion(first, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER,
  });
  store.publishTranslationVersion(system, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE entry_ai_asset_contributions SET translation_version_id = ? WHERE id = ?')
    .run(system.id, firstPublished.assetId);
  db.close();

  assert.throws(() => store.publishTranslationVersion(next, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.NEVER,
  }), /ownership/i);
  assert.equal(store.getTranslationVersion(next.id), null);
  assert.equal(store.resolveTranslationVersionAsset(entryId, firstPublished.assetId), null);
});

test('versioned legacy saves fail atomically without a document or matching source input hash', () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  try {
    const missingDocumentEntry = 'legacy-save-missing-document';
    seedEntry(missingDocumentEntry);
    assert.throws(() => store.saveTranslation(missingDocumentEntry, {
      titleZh: '不应保存',
      content: [{ source: 'Source body.', target: '不应保存。' }],
      contentHash: store.hashText(`Title ${missingDocumentEntry}\n<p>Source body.</p>`),
    }), /document/i);
    assert.equal(store.getTranslation(missingDocumentEntry), null);

    const staleInputEntry = 'legacy-save-stale-input';
    seedCurrentDocument(staleInputEntry);
    assert.throws(() => store.saveTranslation(staleInputEntry, {
      titleZh: '不应保存',
      content: [{ source: 'Source body.', target: '不应保存。' }],
      contentHash: 'stale-provider-input-hash',
    }), /source|content|changed/i);
    assert.equal(store.getTranslation(staleInputEntry), null);
    assert.equal(store.getCurrentTranslationVersion(staleInputEntry), null);
  } finally {
    if (previousMode === undefined) delete process.env.VERSIONED_TRANSLATION_MODE;
    else process.env.VERSIONED_TRANSLATION_MODE = previousMode;
  }
});

test('versioned legacy replay keeps the current translation and stable user asset on the same version', () => {
  const entryId = 'legacy-save-replay-head';
  seedCurrentDocument(entryId);
  const user = createTestUser('legacy-save-replay-head');
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  const save = target => store.saveTranslation(entryId, {
    userId: user.id,
    createdBy: user.displayName,
    titleZh: `标题 ${target}`,
    summaryZh: '',
    content: [{ source: 'Source body.', target }],
    model: 'legacy-model',
    provider: 'byok',
    contentHash: store.hashText(`Title ${entryId}\n<p>Source body.</p>`),
  });
  try {
    save('译文 A');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    save('译文 B');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const replayed = save('译文 A');
    const current = store.getCurrentTranslationVersion(entryId);
    const stable = store.resolveTranslationVersionAsset(entryId, replayed.id);

    assert.equal(store.getTranslation(entryId).content[0].target, '译文 A');
    assert.equal(current.content[0].target, '译文 A');
    assert.equal(stable.version.id, current.id);
    assert.equal(stable.version.content[0].target, '译文 A');
  } finally {
    if (previousMode === undefined) delete process.env.VERSIONED_TRANSLATION_MODE;
    else process.env.VERSIONED_TRANSLATION_MODE = previousMode;
  }
});

test('auto promotes a user version when the current document has no fresh system version', () => {
  const entryId = 'publish-user-auto-empty';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('publish-user-auto-empty');
  const input = versionInput(entryId, document, {
    id: 'user-auto-empty-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'user-auto-empty-generation',
    titleZh: '用户自动当前译文',
  });

  const published = store.publishTranslationVersion(input, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.promoted, true);
  assert.equal(published.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, input.id);
  assert.equal(store.getTranslation(entryId).contributorId, user.id);
  assert.equal(store.getAiAssetContribution(published.assetId, 'translation').id, published.assetId);
});

test('auto keeps a user contribution independent when a fresh system version already exists', () => {
  const entryId = 'publish-user-auto-system';
  const document = seedCurrentDocument(entryId);
  const system = versionInput(entryId, document, {
    id: 'fresh-system-version',
    generationHash: 'fresh-system-generation',
  });
  store.publishTranslationVersion(system, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const user = createTestUser('publish-user-auto-system');
  const contribution = versionInput(entryId, document, {
    id: 'blocked-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'blocked-user-generation',
    titleZh: '不覆盖系统的用户译文',
  });

  const published = store.publishTranslationVersion(contribution, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.created, true);
  assert.equal(published.promoted, false);
  assert.equal(published.pointerChanged, false);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, system.id);
  assert.equal(store.getTranslation(entryId).contributorId, '');
  assert.equal(store.getAiAssetContribution(published.assetId, 'translation').contributorId, user.id);
});

test('auto promotes a user version when the only system version uses a stale pipeline', () => {
  const entryId = 'publish-user-auto-stale-system-pipeline';
  const document = seedCurrentDocument(entryId);
  const system = versionInput(entryId, document, {
    id: 'stale-pipeline-system-version',
    pipelineHash: 'pipeline-v1',
    generationHash: 'stale-pipeline-system-generation',
  });
  store.publishTranslationVersion(system, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const user = createTestUser('publish-user-auto-stale-system-pipeline');
  const contribution = versionInput(entryId, document, {
    id: 'current-pipeline-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    pipelineHash: 'pipeline-v2',
    generationHash: 'current-pipeline-user-generation',
  });

  const published = store.publishTranslationVersion(contribution, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.promoted, true);
  assert.equal(published.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, contribution.id);
  assert.equal(store.getTranslation(entryId).contributorId, user.id);
});

test('auto ignores a matching historical system version when the current system pointer uses a stale pipeline', () => {
  const entryId = 'publish-user-auto-historical-system-pipeline';
  const olderDocument = seedCurrentDocument(entryId, 'historical-system-pipeline-v1');
  const currentDocument = store.insertArticleDocument({
    ...olderDocument,
    id: 'historical-system-pipeline-v2',
    documentHash: 'historical-system-pipeline-v2-hash',
    createdAt: 1500,
  });
  store.setCurrentArticleDocument(entryId, currentDocument.id);
  const currentSystem = versionInput(entryId, currentDocument, {
    id: 'historical-system-current-stale-pipeline-version',
    pipelineHash: 'pipeline-v1',
    generationHash: 'historical-system-current-stale-pipeline-generation',
  });
  store.publishTranslationVersion(currentSystem, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const historicalSystem = versionInput(entryId, olderDocument, {
    id: 'historical-system-matching-pipeline-version',
    pipelineHash: 'pipeline-v2',
    generationHash: 'historical-system-matching-pipeline-generation',
  });
  const historicalPublished = store.publishTranslationVersion(historicalSystem, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const user = createTestUser('publish-user-auto-historical-system-pipeline');
  const contribution = versionInput(entryId, currentDocument, {
    id: 'historical-system-current-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    pipelineHash: 'pipeline-v2',
    generationHash: 'historical-system-current-user-generation',
  });

  const published = store.publishTranslationVersion(contribution, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(historicalPublished.promoted, false);
  assert.equal(published.promoted, true);
  assert.equal(published.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, contribution.id);
  assert.equal(store.getTranslation(entryId).contributorId, user.id);
});

test('auto saves a stale-document system version as history without promoting it', () => {
  const entryId = 'publish-system-stale-document';
  const staleDocument = seedCurrentDocument(entryId, 'publish-stale-document-v1');
  seedCurrentDocument(entryId, 'publish-stale-document-v2');
  const input = versionInput(entryId, staleDocument, {
    id: 'stale-system-version',
    generationHash: 'stale-system-generation',
  });

  const published = store.publishTranslationVersion(input, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.created, true);
  assert.equal(published.promoted, false);
  assert.equal(published.pointerChanged, false);
  assert.equal(store.getTranslationVersion(input.id).id, input.id);
  assert.equal(store.getCurrentTranslationVersion(entryId), null);
  assert.equal(store.getTranslation(entryId), null);
});

test('admin promotion can make an existing current-document user version current', () => {
  const entryId = 'publish-user-admin';
  const document = seedCurrentDocument(entryId);
  const system = versionInput(entryId, document, {
    id: 'admin-matrix-system-version',
    generationHash: 'admin-matrix-system-generation',
  });
  store.publishTranslationVersion(system, { promotion: 'auto' });
  const user = createTestUser('publish-user-admin');
  const input = versionInput(entryId, document, {
    id: 'admin-promoted-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'admin-promoted-user-generation',
  });
  store.publishTranslationVersion(input, { promotion: 'never' });

  const promoted = store.publishTranslationVersion(input, { promotion: 'admin' });

  assert.equal(promoted.created, false);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, input.id);
  assert.equal(store.getTranslation(entryId).contributorId, user.id);
});

test('admin promotion of a stale-document user version rolls back version and contribution', () => {
  const entryId = 'publish-user-admin-stale';
  const staleDocument = seedCurrentDocument(entryId, 'admin-stale-document-v1');
  seedCurrentDocument(entryId, 'admin-stale-document-v2');
  const user = createTestUser('publish-user-admin-stale');
  const input = versionInput(entryId, staleDocument, {
    id: 'admin-stale-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'admin-stale-user-generation',
  });

  assert.throws(
    () => store.publishTranslationVersion(input, { promotion: 'admin' }),
    /admin promotion requires the current document/i,
  );
  assert.equal(store.getTranslationVersion(input.id), null);
  assert.equal(store.getAiAssetContribution(input.id, 'translation'), null);
  assert.equal(store.getCurrentTranslationVersion(entryId), null);
});

test('auto promotes a version from an older document when the current source hash is identical', () => {
  const entryId = 'publish-system-same-source-document';
  const observedDocument = seedCurrentDocument(entryId, 'publish-same-source-v1');
  const currentDocument = store.insertArticleDocument({
    ...observedDocument,
    id: 'publish-same-source-v2',
    documentHash: 'publish-same-source-v2-hash',
    createdAt: 1500,
  });
  store.setCurrentArticleDocument(entryId, currentDocument.id);
  const input = versionInput(entryId, observedDocument, {
    id: 'same-source-system-version',
    generationHash: 'same-source-system-generation',
  });

  const published = store.publishTranslationVersion(input, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.promoted, true);
  assert.equal(store.getCurrentArticleDocument(entryId).id, currentDocument.id);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, input.id);
  assert.equal(store.getCurrentTranslationVersion(entryId).sourceHash, currentDocument.sourceHash);
});

test('auto keeps a fresh current-document version when an older same-source document finishes later', () => {
  const entryId = 'publish-system-same-source-late';
  const olderDocument = seedCurrentDocument(entryId, 'publish-same-source-late-v1');
  const currentDocument = store.insertArticleDocument({
    ...olderDocument,
    id: 'publish-same-source-late-v2',
    documentHash: 'publish-same-source-late-v2-hash',
    createdAt: 1500,
  });
  store.setCurrentArticleDocument(entryId, currentDocument.id);
  const currentVersion = versionInput(entryId, currentDocument, {
    id: 'same-source-current-document-version',
    generationHash: 'same-source-current-document-generation',
  });
  store.publishTranslationVersion(currentVersion, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const lateVersion = versionInput(entryId, olderDocument, {
    id: 'same-source-older-document-late-version',
    generationHash: 'same-source-older-document-late-generation',
  });

  const published = store.publishTranslationVersion(lateVersion, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.created, true);
  assert.equal(published.promoted, false);
  assert.equal(published.pointerChanged, false);
  assert.equal(store.getTranslationVersion(lateVersion.id).id, lateVersion.id);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, currentVersion.id);
  assert.equal(store.getTranslation(entryId).titleZh, currentVersion.titleZh);
});

test('auto keeps a same-source current pointer after raw evidence advances again', () => {
  const entryId = 'publish-system-same-source-pointer-advance';
  const oldestDocument = seedCurrentDocument(entryId, 'same-source-pointer-v1');
  const translatedDocument = store.insertArticleDocument({
    ...oldestDocument,
    id: 'same-source-pointer-v2',
    documentHash: 'same-source-pointer-v2-hash',
    createdAt: 1500,
  });
  store.setCurrentArticleDocument(entryId, translatedDocument.id);
  const currentVersion = versionInput(entryId, translatedDocument, {
    id: 'same-source-pointer-current-version',
    pipelineHash: 'pipeline-v2',
    generationHash: 'same-source-pointer-current-generation',
  });
  store.publishTranslationVersion(currentVersion, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });
  const currentDocument = store.insertArticleDocument({
    ...oldestDocument,
    id: 'same-source-pointer-v3',
    documentHash: 'same-source-pointer-v3-hash',
    createdAt: 1800,
  });
  store.setCurrentArticleDocument(entryId, currentDocument.id);
  const lateVersion = versionInput(entryId, oldestDocument, {
    id: 'same-source-pointer-oldest-late-version',
    pipelineHash: 'pipeline-v1',
    generationHash: 'same-source-pointer-oldest-late-generation',
  });

  const published = store.publishTranslationVersion(lateVersion, {
    promotion: store.TRANSLATION_VERSION_PROMOTIONS.AUTO,
  });

  assert.equal(published.created, true);
  assert.equal(published.promoted, false);
  assert.equal(published.pointerChanged, false);
  assert.equal(store.getCurrentArticleDocument(entryId).id, currentDocument.id);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, currentVersion.id);
  assert.equal(store.getTranslation(entryId).titleZh, currentVersion.titleZh);
});

test('legacy promotion preserves the previously displayed user translation as current', () => {
  const entryId = 'publish-user-legacy-current';
  const document = seedCurrentDocument(entryId);
  store.publishTranslationVersion(versionInput(entryId, document, {
    id: 'legacy-matrix-system-version',
    generationHash: 'legacy-matrix-system-generation',
  }), { promotion: 'auto' });
  const user = createTestUser('publish-user-legacy-current');
  const legacy = versionInput(entryId, document, {
    id: 'legacy-current-user-asset',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    pipelineHash: 'legacy_unknown',
    generationHash: 'legacy-current-user-generation',
    createdAt: 1500,
  });

  const published = store.publishTranslationVersion(legacy, { promotion: 'legacy' });

  assert.equal(published.promoted, true);
  assert.equal(published.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(entryId).id, legacy.id);
  assert.equal(store.getTranslation(entryId).contributorId, user.id);
});

test('repeated publication reuses the immutable version and rejects changed content', () => {
  const entryId = 'publish-immutable-repeat';
  const document = seedCurrentDocument(entryId);
  const input = versionInput(entryId, document, {
    id: 'immutable-repeat-version',
    generationHash: 'immutable-repeat-generation',
  });
  const first = store.publishTranslationVersion(input, { promotion: 'auto' });

  const repeated = store.publishTranslationVersion({ ...input, id: 'ignored-repeat-id' }, { promotion: 'auto' });

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.id, input.id);
  assert.equal(repeated.pointerChanged, false);
  assert.throws(
    () => store.publishTranslationVersion({
      ...input,
      content: { schemaVersion: 2, translations: [{ id: 's_body', target: '被篡改的译文。' }] },
    }, { promotion: 'auto' }),
    /immutable translation version conflict/i,
  );
  assert.equal(store.getTranslationVersion(input.id).content.translations[0].target, '系统译文。');
  assert.equal(store.getTranslation(entryId).content[0].target, '系统译文。');
});

test('system publication cannot carry a user identity or overwrite that user contribution', () => {
  const entryId = 'publish-system-user-boundary';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('publish-system-user-boundary');
  const contribution = versionInput(entryId, document, {
    id: 'ownership-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'ownership-user-generation',
  });
  const published = store.publishTranslationVersion(contribution, { promotion: 'never' });

  assert.throws(
    () => store.publishTranslationVersion(versionInput(entryId, document, {
      id: 'masquerading-system-version',
      ownerType: 'system',
      userId: user.id,
      generationHash: 'masquerading-system-generation',
    }), { promotion: 'auto' }),
    /immutable translation version conflict/i,
  );
  assert.equal(store.getTranslationVersion('masquerading-system-version'), null);
  assert.equal(store.getAiAssetContribution(published.assetId, 'translation').author, user.displayName);
});

test('an off-mode legacy save atomically invalidates stale version pointers without deleting history', () => {
  const entryId = 'off-mode-invalidates-version-heads';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('off-mode-invalidates-version-heads');
  const version = versionInput(entryId, document, {
    id: 'off-mode-previous-user-version',
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
    generationHash: 'off-mode-previous-user-generation',
  });
  const published = store.publishTranslationVersion(version, { promotion: 'legacy' });
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  process.env.VERSIONED_TRANSLATION_MODE = 'off';
  try {
    const saved = store.saveTranslation(entryId, {
      userId: user.id,
      createdBy: user.displayName,
      titleZh: '关闭模式新标题',
      summaryZh: '关闭模式新摘要',
      content: [{ source: 'Source body.', target: '关闭模式新译文。' }],
      model: 'legacy-model',
      provider: 'byok',
      contentHash: 'legacy-input-hash',
    });

    assert.equal(saved.id, published.assetId);
    assert.equal(saved.content[0].target, '关闭模式新译文。');
    assert.equal(store.getCurrentTranslationVersion(entryId), null);
    assert.equal(store.resolveTranslationVersionAsset(entryId, published.assetId), null);
    assert.equal(store.getTranslationVersion(version.id).id, version.id);
  } finally {
    if (previousMode === undefined) delete process.env.VERSIONED_TRANSLATION_MODE;
    else process.env.VERSIONED_TRANSLATION_MODE = previousMode;
  }
});

test('legacy migration scan exposes current translations and stable user contribution assets', () => {
  const entryId = 'scan-legacy-translation-assets';
  const document = seedCurrentDocument(entryId);
  const user = createTestUser('scan-legacy-translation-assets');
  const userAsset = store.saveTranslation(entryId, {
    userId: user.id,
    createdBy: user.displayName,
    titleZh: '用户旧标题',
    summaryZh: '用户旧摘要',
    content: [{ source: 'Source body.', target: '用户旧译文。' }],
    model: 'user-legacy-model',
    provider: 'deepseek',
    contentHash: 'unproven-user-content-hash',
  });
  store.saveTranslation(entryId, {
    createdBy: 'Legacy System',
    titleZh: '系统旧标题',
    summaryZh: '系统旧摘要',
    content: [{ source: 'Source body.', target: '系统旧译文。' }],
    model: 'system-legacy-model',
    provider: 'deepseek',
    contentHash: document.sourceHash,
  });

  assert.equal(typeof store.scanLegacyTranslationsForVersionedMigration, 'function');
  const records = store.scanLegacyTranslationsForVersionedMigration({ limit: 1000 })
    .filter(record => record.entryId === entryId);

  assert.deepEqual(records.map(record => record.sourceType).sort(), ['contribution', 'current']);
  const contribution = records.find(record => record.sourceType === 'contribution');
  const current = records.find(record => record.sourceType === 'current');
  assert.equal(contribution.assetId, userAsset.id);
  assert.equal(contribution.userId, user.id);
  assert.equal(contribution.author, user.displayName);
  assert.equal(contribution.model, 'user-legacy-model');
  assert.equal(current.userId, null);
  assert.equal(current.author, 'Legacy System');
  assert.equal(current.model, 'system-legacy-model');
  assert.equal(current.currentDocumentId, document.id);
  assert.equal(current.documentSourceHash, document.sourceHash);
});

test('job fence rejects an old lease without side effects and completes a valid lease atomically', () => {
  const invalidEntryId = 'publish-job-fence-invalid';
  const invalidDocument = seedCurrentDocument(invalidEntryId);
  const invalidVersion = versionInput(invalidEntryId, invalidDocument, {
    id: 'job-fence-invalid-version',
    generationHash: 'job-fence-invalid-generation',
  });
  seedRunningJob({ ...invalidVersion, id: 'job-fence-invalid' });

  assert.throws(
    () => store.publishTranslationVersion(invalidVersion, {
      promotion: 'auto',
      jobFence: {
        jobId: 'job-fence-invalid',
        leaseToken: 'old-lease-token',
        completedAt: 3000,
      },
    }),
    error => error && error.code === 'ERR_TRANSLATION_JOB_LEASE_LOST',
  );
  assert.equal(store.getTranslationVersion(invalidVersion.id), null);
  assert.equal(store.getCurrentTranslationVersion(invalidEntryId), null);
  assert.equal(store.getTranslation(invalidEntryId), null);
  assert.deepEqual(readJob('job-fence-invalid'), {
    status: 'running',
    lease_token: 'active-lease-token',
    lease_expires_at: 4000,
    completed_at: null,
    updated_at: 1000,
  });

  const validEntryId = 'publish-job-fence-valid';
  const validDocument = seedCurrentDocument(validEntryId);
  const validVersion = versionInput(validEntryId, validDocument, {
    id: 'job-fence-valid-version',
    generationHash: 'job-fence-valid-generation',
  });
  seedRunningJob({ ...validVersion, id: 'job-fence-valid' });

  const published = store.publishTranslationVersion(validVersion, {
    promotion: 'auto',
    jobFence: {
      jobId: 'job-fence-valid',
      leaseToken: 'active-lease-token',
      completedAt: 3000,
    },
  });

  assert.equal(published.pointerChanged, true);
  assert.equal(store.getCurrentTranslationVersion(validEntryId).id, validVersion.id);
  assert.deepEqual(readJob('job-fence-valid'), {
    status: 'succeeded',
    lease_token: null,
    lease_expires_at: null,
    completed_at: 3000,
    updated_at: 3000,
  });
});
