const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('node:path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-jobs-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const store = require('../lib/store');
const jobs = require('../lib/translation-jobs');
const { translationPipelineHash } = require('../lib/translation-contract');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedDocument(label, overrides = {}) {
  const entryId = `${label}-entry`;
  store.upsertEntries([{
    id: entryId,
    sourceId: 'translation-job-test',
    title: `Title ${label}`,
    link: `https://example.com/${label}`,
    summary: '',
    content: '<p>First source segment.</p><p>Second source segment.</p>',
  }]);
  const document = store.insertArticleDocument({
    id: `${label}-document`,
    entryId,
    snapshotId: null,
    sourceComponents: [],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: `${label}-document-hash`,
    sourceHash: `${label}-source-hash`,
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: '',
    summary: '',
    normalizedHtml: '<p>First source segment.</p><p>Second source segment.</p>',
    plainText: 'First source segment.\nSecond source segment.',
    ast: [
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_first', role: 'paragraph', text: 'First source segment.' }] },
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_second', role: 'paragraph', text: 'Second source segment.' }] },
    ],
    resources: [],
    createdAt: 1000,
  });
  store.setCurrentArticleDocument(entryId, document.id);
  return { entryId, document, ...overrides };
}

function enqueueInput(label, overrides = {}) {
  const seeded = seedDocument(label);
  return {
    entryId: seeded.entryId,
    documentId: seeded.document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: seeded.document.sourceHash,
    pipelineHash: translationPipelineHash(),
    generationHash: `${label}-generation-hash`,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tuning: { temperature: 0.15, maxTokens: 6000 },
    priority: 20,
    chunks: [
      { segmentIds: ['s_first'], chunkHash: `${label}-chunk-0` },
      { segmentIds: ['s_second'], chunkHash: `${label}-chunk-1` },
    ],
    ...overrides,
  };
}

test('enqueue persists deterministic chunks, reuses generationHash, rejects BYOK secrets, and promotes only waiting jobs', () => {
  assert.deepEqual(Object.keys(jobs).sort(), ['enqueue', 'getStatus', 'promote', 'runNext']);
  const input = enqueueInput('enqueue');

  const first = jobs.enqueue(input);
  const reused = jobs.enqueue(input);
  const conflictingInput = enqueueInput('enqueue-other-entry', { generationHash: input.generationHash });
  const promoted = jobs.promote(first.id, { priority: 90 });

  assert.equal(first.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.id, first.id);
  assert.throws(
    () => jobs.enqueue(conflictingInput),
    /generationHash conflicts with a different translation job/i,
  );
  assert.equal(promoted.priority, 90);
  assert.equal(promoted.status, 'queued');
  assert.deepEqual(promoted.chunks.map(chunk => ({
    index: chunk.chunkIndex,
    segmentIds: chunk.segmentIds,
    chunkHash: chunk.chunkHash,
    status: chunk.status,
  })), [
    { index: 0, segmentIds: ['s_first'], chunkHash: 'enqueue-chunk-0', status: 'pending' },
    { index: 1, segmentIds: ['s_second'], chunkHash: 'enqueue-chunk-1', status: 'pending' },
  ]);
  assert.doesNotMatch(JSON.stringify(jobs.getStatus(first.id)), /api.?key|secret-value/i);
  assert.throws(
    () => jobs.enqueue({ ...enqueueInput('secret-top'), apiKey: 'secret-value' }),
    /secret.*not accepted/i
  );
  assert.throws(
    () => jobs.enqueue({ ...enqueueInput('secret-tuning'), tuning: { apiKey: 'secret-value' } }),
    /secret.*not accepted/i
  );
  assert.throws(
    () => jobs.enqueue({ ...enqueueInput('unknown-tuning'), tuning: { baseUrl: 'https://example.com' } }),
    /unsupported tuning field baseUrl/i
  );
  assert.throws(
    () => jobs.enqueue({ ...enqueueInput('nested-tuning'), tuning: { headers: { 'X-Test': 'value' } } }),
    /unsupported tuning field headers/i
  );
  assert.throws(
    () => jobs.enqueue({ ...enqueueInput('invalid-temperature'), tuning: { temperature: '0.15', maxTokens: 6000 } }),
    /temperature must be a finite number/i
  );
});

test('enqueue atomically reopens a failed current generation and resets only unfinished chunks', async () => {
  const input = enqueueInput('reopen-failed-current', { priority: 240 });
  const job = jobs.enqueue(input);
  const failed = await jobs.runNext({
    now: 8_000,
    leaseMs: 1_000,
    translateChunk: async (chunk, context) => {
      if (context.chunkIndex === 1) {
        const error = new Error('permanent provider failure');
        error.statusCode = 401;
        throw error;
      }
      return translatedResponse(chunk);
    },
    publishTranslationVersion: () => assert.fail('failed work must not publish'),
  });

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.chunks.map(chunk => chunk.status), ['succeeded', 'failed']);

  const reopened = jobs.enqueue(input);

  assert.equal(reopened.id, job.id);
  assert.equal(reopened.created, false);
  assert.equal(reopened.status, 'queued');
  assert.equal(reopened.attemptCount, 0);
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.errorCode, '');
  assert.deepEqual(reopened.chunks.map(chunk => ({
    status: chunk.status,
    attemptCount: chunk.attemptCount,
    hasResult: Boolean(chunk.result),
    errorCode: chunk.errorCode,
  })), [
    { status: 'succeeded', attemptCount: 1, hasResult: true, errorCode: '' },
    { status: 'pending', attemptCount: 0, hasResult: false, errorCode: '' },
  ]);

  const completed = await jobs.runNext({
    now: 8_500,
    leaseMs: 1_000,
    translateChunk: async chunk => translatedResponse(chunk),
  });
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, 'succeeded');
});

test('enqueue reopens a superseded generation only after its exact document becomes current again', async () => {
  const input = enqueueInput('reopen-superseded-current', { priority: 245 });
  const job = jobs.enqueue(input);
  const original = store.getArticleDocument(input.documentId);
  const replacement = store.insertArticleDocument({
    ...original,
    id: 'reopen-superseded-replacement-document',
    snapshotId: null,
    documentHash: 'reopen-superseded-replacement-document-hash',
    sourceHash: 'reopen-superseded-replacement-source-hash',
    createdAt: 2_000,
  });

  store.setCurrentArticleDocument(input.entryId, replacement.id, { supersedeActiveJobs: true });
  assert.equal(jobs.getStatus(job.id).status, 'superseded');
  assert.equal(jobs.enqueue(input).status, 'superseded');

  store.setCurrentArticleDocument(input.entryId, original.id);
  const reopened = jobs.enqueue(input);

  assert.equal(reopened.id, job.id);
  assert.equal(reopened.status, 'queued');
  assert.deepEqual(reopened.chunks.map(chunk => chunk.status), ['pending', 'pending']);

  const completed = await jobs.runNext({
    now: 8_750,
    leaseMs: 1_000,
    translateChunk: async chunk => translatedResponse(chunk),
  });
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, 'succeeded');
});

test('enqueue never reopens a failed generation that already has an immutable version', async () => {
  const input = enqueueInput('reopen-published-blocked', {
    priority: 247,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'reopen-published-blocked-chunk' }],
  });
  const job = jobs.enqueue(input);
  const failed = await jobs.runNext({
    now: 9_000,
    leaseMs: 1_000,
    translateChunk: async () => {
      const error = new Error('permanent provider failure');
      error.statusCode = 401;
      throw error;
    },
    publishTranslationVersion: () => assert.fail('failed work must not publish'),
  });
  assert.equal(failed.status, 'failed');

  store.publishTranslationVersion({
    id: `translation-version-${input.generationHash}`,
    entryId: input.entryId,
    documentId: input.documentId,
    ownerType: input.ownerType,
    userId: input.userId,
    author: input.author,
    sourceHash: input.sourceHash,
    pipelineHash: input.pipelineHash,
    generationHash: input.generationHash,
    schemaVersion: 2,
    titleZh: '已发布标题',
    summaryZh: '已发布摘要',
    content: {
      schemaVersion: 2,
      translations: [
        { id: 's_first', target: '第一段' },
        { id: 's_second', target: '第二段' },
      ],
    },
    provider: input.provider,
    model: input.model,
    createdAt: 9_500,
  }, { promotion: 'never' });

  const reused = jobs.enqueue(input);
  assert.equal(reused.id, job.id);
  assert.equal(reused.status, 'failed');
  assert.equal(reused.created, false);
});

function translatedResponse(input) {
  return {
    schemaVersion: 2,
    translations: input.segments.map(segment => ({ id: segment.id, target: `译文:${segment.text}` })),
  };
}

test('runNext claims highest priority with a lease and publishes only after every chunk succeeds', async () => {
  const low = jobs.enqueue(enqueueInput('priority-low', { priority: 10 }));
  const high = jobs.enqueue(enqueueInput('priority-high', { priority: 180 }));
  const calls = [];
  const published = [];

  const result = await jobs.runNext({
    now: 10_000,
    leaseMs: 500,
    translateChunk: async (input, context) => {
      calls.push({ ids: input.segments.map(segment => segment.id), context });
      assert.deepEqual(context.aiConfig, {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        temperature: 0.15,
        maxTokens: 6000,
      });
      assert.doesNotMatch(JSON.stringify(context.aiConfig), /api.?key|authorization|secret/i);
      assert.equal(jobs.getStatus(high.id).status, 'running');
      assert.equal(Object.prototype.hasOwnProperty.call(jobs.getStatus(high.id), 'leaseToken'), false);
      assert.equal(published.length, 0);
      return translatedResponse(input);
    },
    publishTranslationVersion: (version, options) => {
      published.push({ version, options });
      return { ...version, promoted: true };
    },
  });

  assert.equal(result.id, high.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(jobs.getStatus(low.id).status, 'queued');
  assert.deepEqual(calls.map(call => call.ids), [['s_first'], ['s_second']]);
  assert.equal(published.length, 1);
  assert.equal(published[0].options.promotion, 'auto');
  assert.equal(published[0].options.jobFence.jobId, high.id);
  assert.equal(typeof published[0].options.jobFence.leaseToken, 'string');
  assert.equal(published[0].options.jobFence.completedAt, 10_000);
  assert.equal(published[0].version.documentId, `${'priority-high'}-document`);
  assert.equal(published[0].version.content.translations.length, 2);
});

test('runNext supersedes an obsolete pipeline before invoking the provider', async () => {
  const input = enqueueInput('obsolete-pipeline-job', {
    pipelineHash: 'obsolete-translation-pipeline-hash',
    priority: 220,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'obsolete-pipeline-job-chunk' }],
  });
  const job = jobs.enqueue(input);
  let providerCalls = 0;

  const result = await jobs.runNext({
    now: 12_000,
    translateChunk: async chunk => {
      providerCalls += 1;
      return translatedResponse(chunk);
    },
    publishTranslationVersion: () => assert.fail('obsolete pipeline work must not publish'),
  });

  assert.equal(result.id, job.id);
  assert.equal(result.status, 'superseded');
  assert.equal(result.errorCode, 'ERR_TRANSLATION_PIPELINE_SUPERSEDED');
  assert.equal(result.leaseExpiresAt, null);
  assert.equal(result.completedAt, 12_000);
  assert.equal(providerCalls, 0);
  assert.deepEqual(result.chunks.map(chunk => chunk.status), ['pending']);
  assert.equal(store.getTranslationVersion(`translation-version-${input.generationHash}`), null);
});

test('a long multi-chunk job renews its fenced lease between provider calls', async () => {
  const job = jobs.enqueue(enqueueInput('lease-renewal', { priority: 250 }));
  let clock = 15_000;

  const result = await jobs.runNext({
    now: () => clock,
    leaseMs: 100,
    translateChunk: async input => {
      clock += 80;
      return translatedResponse(input);
    },
  });

  assert.equal(result.id, job.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.completedAt, 15_160);
  assert.equal(store.getCurrentTranslationVersion(job.entryId).generationHash, job.generationHash);
});

test('the default lease covers two 90-second provider attempts plus a safety margin', async () => {
  const input = enqueueInput('default-lease-provider-window', {
    priority: 275,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'default-lease-provider-window-chunk' }],
  });
  const job = jobs.enqueue(input);
  let markStarted;
  let releaseProvider;
  const started = new Promise(resolve => { markStarted = resolve; });
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const startedAt = 18_000;

  const originalWorker = jobs.runNext({
    now: startedAt,
    translateChunk: async chunk => {
      markStarted();
      await providerGate;
      return translatedResponse(chunk);
    },
  });
  await started;

  const contender = await jobs.runNext({
    now: startedAt + 200_000,
    translateChunk: async chunk => translatedResponse(chunk),
  });
  const protectedJob = jobs.getStatus(job.id);
  releaseProvider();
  const completed = await originalWorker;

  assert.notEqual(contender && contender.id, job.id);
  assert.equal(protectedJob.status, 'running');
  assert.equal(protectedJob.attemptCount, 1);
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, 'succeeded');
});

test('an expired lease can be reclaimed and the old worker cannot save or publish', async () => {
  const job = jobs.enqueue(enqueueInput('lease-race', {
    priority: 300,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'lease-race-chunk' }],
  }));
  let releaseOld;
  let markOldStarted;
  const oldStarted = new Promise(resolve => { markOldStarted = resolve; });
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const published = [];

  const oldWorker = jobs.runNext({
    now: 20_000,
    leaseMs: 100,
    translateChunk: async input => {
      markOldStarted();
      await oldGate;
      return translatedResponse(input);
    },
    publishTranslationVersion: version => {
      published.push({ worker: 'old', version });
      return version;
    },
  });
  await oldStarted;
  assert.equal(jobs.promote(job.id, { priority: 999 }).priority, 300);

  const newWorker = await jobs.runNext({
    now: 20_101,
    leaseMs: 100,
    translateChunk: async input => translatedResponse(input),
    publishTranslationVersion: version => {
      published.push({ worker: 'new', version });
      return version;
    },
  });
  releaseOld();
  const staleResult = await oldWorker;

  assert.equal(newWorker.status, 'succeeded');
  assert.equal(staleResult.status, 'lease_lost');
  assert.deepEqual(published.map(item => item.worker), ['new']);
  assert.equal(jobs.getStatus(job.id).attemptCount, 2);
});

test('lease fencing remains atomic when ownership changes at the publish boundary', async () => {
  const input = enqueueInput('publish-fence-race', {
    priority: 350,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'publish-fence-race-chunk' }],
  });
  const job = jobs.enqueue(input);
  let markOldAtPublish;
  let releaseOldPublish;
  const oldAtPublish = new Promise(resolve => { markOldAtPublish = resolve; });
  const oldPublishGate = new Promise(resolve => { releaseOldPublish = resolve; });

  const oldWorker = jobs.runNext({
    now: 25_000,
    leaseMs: 100,
    translateChunk: async chunk => translatedResponse(chunk),
    publishTranslationVersion: async (version, options) => {
      markOldAtPublish();
      await oldPublishGate;
      return store.publishTranslationVersion(version, options);
    },
  });
  await oldAtPublish;

  const newWorker = await jobs.runNext({
    now: 25_101,
    leaseMs: 100,
    translateChunk: async () => assert.fail('the reclaimed worker must reuse the persisted chunk'),
  });
  releaseOldPublish();
  const oldResult = await oldWorker;

  assert.equal(newWorker.status, 'succeeded');
  assert.equal(oldResult.status, 'lease_lost');
  assert.equal(store.getTranslationVersion(`translation-version-${input.generationHash}`).documentId, input.documentId);
  assert.equal(store.getCurrentTranslationVersion(input.entryId).generationHash, input.generationHash);
  assert.equal(jobs.getStatus(job.id).attemptCount, 2);
});

test('transient failure backs off and restart skips chunks already persisted as succeeded', async () => {
  const job = jobs.enqueue(enqueueInput('restart-retry', { priority: 400 }));
  const firstCalls = [];
  const first = await jobs.runNext({
    now: 30_000,
    leaseMs: 1_000,
    translateChunk: async (input, context) => {
      firstCalls.push(context.chunkIndex);
      if (context.chunkIndex === 1) {
        const error = new Error('provider rate limited');
        error.statusCode = 429;
        throw error;
      }
      return translatedResponse(input);
    },
    publishTranslationVersion: () => assert.fail('partial chunks must never publish'),
  });

  assert.equal(first.status, 'retry_wait');
  assert.equal(first.nextRetryAt, 31_000);
  assert.deepEqual(first.chunks.map(chunk => chunk.status), ['succeeded', 'retry_wait']);
  assert.deepEqual(firstCalls, [0, 1]);

  const retryCalls = [];
  let publications = 0;
  const retried = await jobs.runNext({
    now: 31_000,
    leaseMs: 1_000,
    translateChunk: async (input, context) => {
      retryCalls.push(context.chunkIndex);
      return translatedResponse(input);
    },
    publishTranslationVersion: version => {
      publications += 1;
      return version;
    },
  });

  assert.equal(retried.status, 'succeeded');
  assert.deepEqual(retryCalls, [1]);
  assert.equal(publications, 1);
});

test('schema-invalid chunk is retried immediately once while permanent provider errors fail closed', async () => {
  const recovered = jobs.enqueue(enqueueInput('schema-recover', {
    priority: 500,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'schema-recover-chunk' }],
  }));
  let schemaCalls = 0;
  const recoveredResult = await jobs.runNext({
    now: 40_000,
    translateChunk: async input => {
      schemaCalls += 1;
      if (schemaCalls === 1) {
        return { schemaVersion: 2, translations: [{ id: 's_first', target: '只有一段。' }] };
      }
      return translatedResponse(input);
    },
    publishTranslationVersion: version => version,
  });

  assert.equal(recoveredResult.id, recovered.id);
  assert.equal(recoveredResult.status, 'succeeded');
  assert.equal(schemaCalls, 2);
  assert.equal(recoveredResult.chunks[0].attemptCount, 2);

  const invalid = jobs.enqueue(enqueueInput('schema-fail', {
    priority: 510,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'schema-fail-chunk' }],
  }));
  let invalidCalls = 0;
  const invalidResult = await jobs.runNext({
    now: 41_000,
    translateChunk: async () => {
      invalidCalls += 1;
      return { schemaVersion: 2, translations: [] };
    },
    publishTranslationVersion: () => assert.fail('invalid schema must not publish'),
  });

  assert.equal(invalidResult.id, invalid.id);
  assert.equal(invalidResult.status, 'failed');
  assert.equal(invalidCalls, 2);
  assert.equal(invalidResult.chunks[0].status, 'failed');

  for (const [index, error] of [
    Object.assign(new Error('invalid credentials'), { statusCode: 401, code: 'ERR_AUTH' }),
    Object.assign(new Error('provider refusal'), { code: 'ERR_TRANSLATION_PROVIDER_REFUSAL' }),
    Object.assign(new Error('truncated output'), { code: 'ERR_TRANSLATION_RESPONSE_TRUNCATED' }),
  ].entries()) {
    const permanent = jobs.enqueue(enqueueInput(`permanent-${index}`, {
      priority: 520 + index,
      chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: `permanent-${index}-chunk` }],
    }));
    const status = await jobs.runNext({
      now: 42_000 + index,
      translateChunk: async () => { throw error; },
      publishTranslationVersion: () => assert.fail('permanent errors must not publish'),
    });
    assert.equal(status.id, permanent.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.nextRetryAt, null);
  }
});

test('provider error matrix retries transport failures but fails configuration and incomplete output closed', async () => {
  for (const [index, error] of [
    Object.assign(new Error('provider unavailable'), { statusCode: 503 }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }),
  ].entries()) {
    const transient = jobs.enqueue(enqueueInput(`matrix-transient-${index}`, {
      priority: 600 + index,
      chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: `matrix-transient-${index}-chunk` }],
    }));
    const status = await jobs.runNext({
      now: 45_000 + index,
      translateChunk: async () => { throw error; },
      publishTranslationVersion: () => assert.fail('transient failure must not publish'),
    });
    assert.equal(status.id, transient.id);
    assert.equal(status.status, 'retry_wait');
  }

  for (const [index, error] of [
    Object.assign(new Error('invalid provider URL'), { code: 'ERR_INVALID_URL' }),
    Object.assign(new Error('content filtered'), { code: 'ERR_TRANSLATION_CONTENT_FILTERED', statusCode: 422 }),
    Object.assign(new Error('invalid configuration'), { statusCode: 400 }),
  ].entries()) {
    const permanent = jobs.enqueue(enqueueInput(`matrix-permanent-${index}`, {
      priority: 610 + index,
      chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: `matrix-permanent-${index}-chunk` }],
    }));
    const status = await jobs.runNext({
      now: 46_000 + index,
      translateChunk: async () => { throw error; },
      publishTranslationVersion: () => assert.fail('permanent failure must not publish'),
    });
    assert.equal(status.id, permanent.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.nextRetryAt, null);
  }
});

test('a completed job for a stale document is stored as history without changing the current pointer', async () => {
  const input = enqueueInput('stale-document', {
    priority: 700,
    chunks: [{ segmentIds: ['s_first', 's_second'], chunkHash: 'stale-document-chunk' }],
  });
  const job = jobs.enqueue(input);
  const nextDocument = store.insertArticleDocument({
    ...store.getArticleDocument(input.documentId),
    id: 'stale-document-current-document',
    snapshotId: null,
    documentHash: 'stale-document-current-hash',
    sourceHash: 'stale-document-current-source-hash',
    createdAt: 2000,
  });
  store.setCurrentArticleDocument(input.entryId, nextDocument.id);

  const status = await jobs.runNext({
    now: 50_000,
    translateChunk: async chunk => translatedResponse(chunk),
  });
  const historical = store.getTranslationVersion(`translation-version-${input.generationHash}`);

  assert.equal(status.id, job.id);
  assert.equal(status.status, 'succeeded');
  assert.equal(historical.documentId, input.documentId);
  assert.equal(store.getCurrentTranslationVersion(input.entryId), null);
  assert.equal(store.getCurrentArticleDocument(input.entryId).id, nextDocument.id);
});

test('worker exits cleanly on an empty queue and supports the single-round stop trigger', () => {
  const workerDataDir = createTempDataDir('translation-worker-empty-');
  try {
    const output = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'translation-worker.js'),
      '--once',
    ], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NAMOO_READER_DATA_DIR: workerDataDir },
      encoding: 'utf8',
    });
    assert.match(output, /translation worker: queue empty/i);
  } finally {
    fs.rmSync(workerDataDir, { recursive: true, force: true });
  }
});
