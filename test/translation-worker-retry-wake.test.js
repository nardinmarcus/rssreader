const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('translation-worker-retry-wake-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const store = require('../lib/store');
const jobs = require('../lib/translation-jobs');
const { translationPipelineHash } = require('../lib/translation-contract');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedJob() {
  const entryId = 'retry-wake-entry';
  store.upsertEntries([{
    id: entryId,
    sourceId: 'retry-wake',
    title: 'Retry wake',
    link: 'https://example.com/retry-wake',
    summary: '',
    content: '<p>Retry body.</p>',
  }]);
  const document = store.insertArticleDocument({
    id: 'retry-wake-document',
    entryId,
    snapshotId: null,
    sourceComponents: [],
    provenance: 'legacy',
    rawStatus: 'unavailable',
    documentHash: 'retry-wake-document-hash',
    sourceHash: 'retry-wake-source-hash',
    extractorVersion: 'e1',
    sanitizerVersion: 's1',
    segmenterVersion: 'g1',
    title: '',
    summary: '',
    normalizedHtml: '<p>Retry body.</p>',
    plainText: 'Retry body.',
    ast: [{ type: 'element', tag: 'p', children: [{ type: 'text', id: 's_retry', role: 'paragraph', text: 'Retry body.' }] }],
    resources: [],
    createdAt: 1,
  });
  store.setCurrentArticleDocument(entryId, document.id);
  return jobs.enqueue({
    entryId,
    documentId: document.id,
    ownerType: 'system',
    userId: null,
    author: 'Namoo Reader',
    sourceHash: document.sourceHash,
    pipelineHash: translationPipelineHash(),
    generationHash: 'retry-wake-generation',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tuning: { temperature: 0.15, maxTokens: 2000 },
    priority: 50,
    chunks: [{ segmentIds: ['s_retry'], chunkHash: 'retry-wake-chunk' }],
  });
}

test('retry and abandoned-lease jobs expose a durable next wake time to the worker', async () => {
  const now = 2_000_000_000_000;
  const job = seedJob();
  const retry = await jobs.runNext({
    now,
    leaseMs: 500,
    translateChunk: async () => {
      const error = new Error('temporary provider outage');
      error.statusCode = 503;
      throw error;
    },
  });

  assert.equal(retry.id, job.id);
  assert.equal(retry.status, 'retry_wait');
  assert.equal(store.getNextTranslationJobWakeAt(), now + 1_000);
  assert.equal(store.hasActiveTranslationJobs(), true);

  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'translation-worker.js'), 'utf8');
  assert.match(workerSource, /getNextTranslationJobWakeAt\(\)/);
  assert.match(workerSource, /Math\.min\(1000,/);
});

async function waitForWorkerStarts(stateFile, expected, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const count = Number(fs.readFileSync(stateFile, 'utf8'));
      if (count >= expected) return count;
    } catch { /* worker has not started yet */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return 0;
}

test('server boundedly restarts an abnormal translation worker while durable jobs remain active', {
  timeout: 5_000,
}, async () => {
  seedJob();
  const workerFile = path.join(dataDir, 'crash-once-translation-worker.js');
  const stateFile = path.join(dataDir, 'crash-once-worker-state');
  fs.writeFileSync(workerFile, `
    const fs = require('fs');
    const stateFile = process.env.TRANSLATION_WORKER_TEST_STATE;
    let count = 0;
    try { count = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
    count += 1;
    fs.writeFileSync(stateFile, String(count));
    if (count === 1) process.exit(23);
    setInterval(() => {}, 1000);
  `);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    env: {
      ...process.env,
      NAMOO_READER_DATA_DIR: dataDir,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      TRANSLATION_WORKER_STARTUP: '1',
      TRANSLATION_WORKER_PATH: workerFile,
      TRANSLATION_WORKER_TEST_STATE: stateFile,
    },
    stdio: 'ignore',
  });

  try {
    assert.equal(await waitForWorkerStarts(stateFile, 2), 2);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
});
