const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-auto-refresh-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
process.env.VERSIONED_TRANSLATION_MODE = 'all';
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'test-site-key';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const store = require('../lib/store');
const pipeline = require('../lib/document-pipeline');
const jobs = require('../lib/translation-jobs');
const { enqueueDocumentTranslation } = require('../lib/translation-job-request');
const { translationPipelineHash } = require('../lib/translation-contract');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedEntry(id, content = '<p>Original source body.</p>') {
  store.upsertEntries([{
    id,
    sourceId: 'translation-auto-refresh',
    title: `Article ${id}`,
    link: `https://example.com/${id}`,
    summary: 'Translation context',
    content,
  }]);
  return store.getEntry(id);
}

async function seedDocument(id) {
  const entry = seedEntry(id);
  const captured = await pipeline.captureFeed({ entry });
  return { entry, document: captured.document };
}

function publishCurrent(entryId, document, overrides = {}) {
  return store.publishTranslationVersion({
    id: `${entryId}-translation-version`,
    entryId,
    documentId: document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: document.sourceHash,
    pipelineHash: translationPipelineHash(),
    generationHash: `${entryId}-published-generation`,
    schemaVersion: 2,
    titleZh: '中文标题',
    summaryZh: '中文摘要',
    content: { schemaVersion: 2, translations: [] },
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    createdAt: 1_000,
    ...overrides,
  }, { promotion: 'auto' });
}

async function updateDocument(id, content = '<p>Updated source body.</p>') {
  seedEntry(id, content);
  return pipeline.captureFeed({ entry: store.getEntry(id) });
}

test('a changed document supersedes old work and queues one lower-priority system refresh', async () => {
  process.env.VERSIONED_TRANSLATION_MODE = 'all';
  process.env.DEEPSEEK_API_KEY = 'test-site-key';
  const { entry, document } = await seedDocument('auto-system-stale');
  publishCurrent(entry.id, document);
  const oldJob = enqueueDocumentTranslation({
    entryId: entry.id,
    document,
    ownerType: 'system',
    author: 'Namoo Reader',
    priority: 50,
  });

  const updated = await updateDocument(entry.id);
  const latestId = store.getLatestTranslationJobForEntry(entry.id, { includeSystem: true });
  const latest = jobs.getStatus(latestId);

  assert.equal(jobs.getStatus(oldJob.id).status, 'superseded');
  assert.equal(updated.translationJob.id, latest.id);
  assert.equal(latest.documentId, updated.document.id);
  assert.equal(latest.ownerType, 'system');
  assert.equal(latest.userId, null);
  assert.equal(latest.priority, 50);
  assert.equal(latest.status, 'queued');
  assert.equal(latest.author, 'Namoo Reader');

  const repeated = await pipeline.captureFeed({ entry: store.getEntry(entry.id) });
  assert.equal(repeated.document.id, updated.document.id);
  assert.equal(repeated.translationJob, null);
  assert.equal(store.getVersionedDocumentStats().translationJobs, 2);
});

test('raw evidence changes with an identical source hash stay fresh and keep old work valid', async () => {
  process.env.VERSIONED_TRANSLATION_MODE = 'all';
  process.env.DEEPSEEK_API_KEY = 'test-site-key';
  const entry = seedEntry('auto-raw-only', '<article><p>Stable normalized body.</p></article>');
  const response = {
    requestUrl: entry.link,
    finalUrl: entry.link,
    statusCode: 200,
    contentType: 'text/html',
    charset: 'utf-8',
    responseMeta: {},
    buffer: Buffer.from('<html data-observation="one"><p>Raw evidence one.</p></html>'),
  };
  const first = await pipeline.captureFetched({ entry, response });
  publishCurrent(entry.id, first.document);
  const oldJob = enqueueDocumentTranslation({
    entryId: entry.id,
    document: first.document,
    ownerType: 'system',
    author: 'Namoo Reader',
    priority: 50,
  });

  const second = await pipeline.captureFetched({
    entry: store.getEntry(entry.id),
    response: {
      ...response,
      buffer: Buffer.from('<html data-observation="two"><p>Raw evidence two.</p></html>'),
    },
  });

  assert.notEqual(second.document.id, first.document.id);
  assert.notEqual(second.document.documentHash, first.document.documentHash);
  assert.equal(second.document.sourceHash, first.document.sourceHash);
  assert.equal(store.getCurrentArticleDocument(entry.id).id, second.document.id);
  assert.equal(second.translationJob, null);
  assert.equal(jobs.getStatus(oldJob.id).status, 'queued');
});

test('user-owned and legacy-unknown current translations are never auto-impersonated', async () => {
  process.env.VERSIONED_TRANSLATION_MODE = 'all';
  process.env.DEEPSEEK_API_KEY = 'test-site-key';

  const userSeed = await seedDocument('auto-user-owned');
  const user = store.createUser({
    email: 'auto-user-owned@example.com',
    password: 'correct-horse-battery-staple',
    displayName: 'Reader',
  });
  publishCurrent(userSeed.entry.id, userSeed.document, {
    ownerType: 'user',
    userId: user.id,
    author: user.displayName,
  });
  const userUpdate = await updateDocument(userSeed.entry.id);

  const legacySeed = await seedDocument('auto-legacy-unknown');
  publishCurrent(legacySeed.entry.id, legacySeed.document, {
    pipelineHash: 'legacy_unknown',
  });
  const legacyUpdate = await updateDocument(legacySeed.entry.id);

  assert.equal(userUpdate.translationJob, null);
  assert.equal(legacyUpdate.translationJob, null);
  assert.equal(store.getLatestTranslationJobForEntry(userSeed.entry.id, { includeSystem: true }), '');
  assert.equal(store.getLatestTranslationJobForEntry(legacySeed.entry.id, { includeSystem: true }), '');
});

test('background auto-refresh obeys shadow and canary entry boundaries', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-site-key';

  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  const shadow = await seedDocument('auto-shadow');
  publishCurrent(shadow.entry.id, shadow.document);
  const shadowUpdate = await updateDocument(shadow.entry.id);
  assert.equal(shadowUpdate.translationJob, null);

  process.env.VERSIONED_TRANSLATION_MODE = 'canary';
  process.env.VERSIONED_TRANSLATION_CANARY_ENTRY_IDS = 'auto-canary-enabled';
  const enabled = await seedDocument('auto-canary-enabled');
  publishCurrent(enabled.entry.id, enabled.document);
  const enabledUpdate = await updateDocument(enabled.entry.id);

  const disabled = await seedDocument('auto-canary-disabled');
  publishCurrent(disabled.entry.id, disabled.document);
  const disabledUpdate = await updateDocument(disabled.entry.id);

  assert.equal(enabledUpdate.translationJob.ownerType, 'system');
  assert.equal(disabledUpdate.translationJob, null);
});

test('missing site credentials never block a document pointer update or persist a secret', async () => {
  process.env.VERSIONED_TRANSLATION_MODE = 'all';
  process.env.DEEPSEEK_API_KEY = 'test-site-key';
  const seeded = await seedDocument('auto-unconfigured');
  publishCurrent(seeded.entry.id, seeded.document);
  delete process.env.DEEPSEEK_API_KEY;

  const updated = await updateDocument(seeded.entry.id);

  assert.notEqual(updated.document.id, seeded.document.id);
  assert.equal(store.getCurrentArticleDocument(seeded.entry.id).id, updated.document.id);
  assert.equal(updated.translationJob, null);
  assert.equal(store.getLatestTranslationJobForEntry(seeded.entry.id, { includeSystem: true }), '');
  assert.doesNotMatch(JSON.stringify(store.getVersionedDocumentStats()), /test-site-key|api.?key/i);
});
