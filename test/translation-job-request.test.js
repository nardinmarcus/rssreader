const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-job-request-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
process.env.DEEPSEEK_API_KEY = 'site-request-key-must-not-persist';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
process.env.AI_TEMPERATURE = '1.2';
process.env.AI_MAX_TOKENS = '6100';

const store = require('../lib/store');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedDocument() {
  const entryId = 'translation-job-request-entry';
  store.upsertEntries([{
    id: entryId,
    sourceId: 'translation-job-request-test',
    title: 'Reusable translation request',
    link: 'https://example.com/reusable-request',
    summary: '',
    content: '<p>Source body.</p>',
  }]);
  const document = store.insertArticleDocument({
    id: 'translation-job-request-document',
    entryId,
    snapshotId: null,
    sourceComponents: [],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'translation-job-request-document-hash',
    sourceHash: 'translation-job-request-source-hash',
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: 'Reusable translation request',
    summary: '',
    normalizedHtml: '<p>Source body.</p>',
    plainText: 'Source body.',
    ast: [{ type: 'element', tag: 'p', children: [
      { type: 'text', id: 's_body', role: 'paragraph', text: 'Source body.' },
    ] }],
    resources: [],
    createdAt: 1000,
  });
  store.setCurrentArticleDocument(entryId, document.id);
  return { entryId, document };
}

test('reusable requests isolate ownership while force creates a new generation and immutable version', async () => {
  const { enqueueDocumentTranslation } = require('../lib/translation-job-request');
  const translationJobs = require('../lib/translation-jobs');
  const { entryId, document } = seedDocument();
  const firstUser = store.createUser({
    email: 'first-request@example.com',
    password: 'first-request-password',
    displayName: 'First Requester',
  });
  const secondUser = store.createUser({
    email: 'second-request@example.com',
    password: 'second-request-password',
    displayName: 'Second Requester',
  });
  const userInput = {
    entryId,
    document,
    ownerType: 'user',
    userId: firstUser.id,
    author: firstUser.displayName,
    priority: 100,
  };

  const userJob = enqueueDocumentTranslation(userInput);
  const duplicate = enqueueDocumentTranslation(userInput);
  const completeNext = () => translationJobs.runNext({
    translateChunk: async input => ({
      schemaVersion: 2,
      translations: input.segments.map(segment => ({
        id: segment.id,
        target: `译文:${segment.text}`,
      })),
    }),
  });
  const firstCompleted = await completeNext();
  const completedDuplicate = enqueueDocumentTranslation(userInput);
  const forced = enqueueDocumentTranslation({ ...userInput, force: true });
  const forcedCompleted = await completeNext();
  const otherUserJob = enqueueDocumentTranslation({
    ...userInput,
    userId: secondUser.id,
    author: secondUser.displayName,
  });
  const systemJob = enqueueDocumentTranslation({
    entryId,
    document,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    priority: 20,
  });

  assert.equal(duplicate.id, userJob.id);
  assert.equal(completedDuplicate.id, userJob.id);
  assert.equal(completedDuplicate.created, false);
  assert.notEqual(forced.id, userJob.id);
  assert.notEqual(forced.generationHash, userJob.generationHash);
  assert.equal(forced.created, true);
  assert.equal(firstCompleted.status, 'succeeded');
  assert.equal(forcedCompleted.id, forced.id);
  assert.equal(forcedCompleted.status, 'succeeded');
  assert.equal(
    store.getTranslationVersion(`translation-version-${userJob.generationHash}`).generationHash,
    userJob.generationHash,
  );
  assert.equal(
    store.getTranslationVersion(`translation-version-${forced.generationHash}`).generationHash,
    forced.generationHash,
  );
  assert.notEqual(otherUserJob.id, userJob.id);
  assert.notEqual(systemJob.id, userJob.id);
  assert.equal(userJob.ownerType, 'user');
  assert.equal(userJob.userId, firstUser.id);
  assert.deepEqual(userJob.tuning, { maxTokens: 6100, temperature: 0.15 });
  assert.equal(systemJob.ownerType, 'system');
  assert.equal(systemJob.userId, null);
  assert.equal(systemJob.priority, 20);
  assert.doesNotMatch(JSON.stringify([userJob, otherUserJob, systemJob]), /site-request-key-must-not-persist|api.?key|authorization/i);
});

test('durable chunk identities are derived from the configured provider output budget', () => {
  const { enqueueDocumentTranslation } = require('../lib/translation-job-request');
  const entryId = 'translation-job-budget-entry';
  const paragraphs = ['a', 'b', 'c'].map(value => value.repeat(3000));
  store.upsertEntries([{
    id: entryId,
    sourceId: 'translation-job-request-test',
    title: 'Budget-aware translation request',
    link: 'https://example.com/budget-request',
    summary: '',
    content: paragraphs.map(value => `<p>${value}</p>`).join(''),
  }]);
  const document = store.insertArticleDocument({
    id: 'translation-job-budget-document',
    entryId,
    snapshotId: null,
    sourceComponents: [],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'translation-job-budget-document-hash',
    sourceHash: 'translation-job-budget-source-hash',
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: 'Budget-aware translation request',
    summary: '',
    normalizedHtml: paragraphs.map(value => `<p>${value}</p>`).join(''),
    plainText: paragraphs.join('\n'),
    ast: paragraphs.map((text, index) => ({
      type: 'element',
      tag: 'p',
      children: [{ type: 'text', id: `s_budget_${index}`, role: 'paragraph', text }],
    })),
    resources: [],
    createdAt: 2000,
  });
  store.setCurrentArticleDocument(entryId, document.id);

  const job = enqueueDocumentTranslation({
    entryId,
    document,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
  });

  assert.equal(job.tuning.maxTokens, 6100);
  assert.deepEqual(job.chunks.map(chunk => chunk.segmentIds.filter(id => id.startsWith('s_budget_'))), [
    ['s_budget_0', 's_budget_1'],
    ['s_budget_2'],
  ]);
});
