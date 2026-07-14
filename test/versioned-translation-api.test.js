const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function seedEntry(dataDir) {
  const script = `
    const store = require('./lib/store');
    const entry = {
      id: 'versioned-api-entry',
      sourceId: 'versioned-api-test',
      title: 'Versioned API article',
      link: 'https://example.com/versioned-api',
      summary: 'Source summary.',
      content: '<p>Source body.</p>',
    };
    store.upsertEntries([entry]);
    const document = store.insertArticleDocument({
      id: 'versioned-api-document',
      entryId: entry.id,
      snapshotId: null,
      sourceComponents: [],
      provenance: 'legacy',
      rawStatus: 'unavailable',
      documentHash: 'versioned-api-document-hash',
      sourceHash: 'versioned-api-source-hash',
      extractorVersion: 'extractor-v1',
      sanitizerVersion: 'sanitizer-v1',
      segmenterVersion: 'segmenter-v1',
      title: entry.title,
      summary: entry.summary,
      normalizedHtml: entry.content,
      plainText: 'Source body.',
      ast: [{
        type: 'element',
        tag: 'p',
        children: [{ type: 'text', id: 's_body', role: 'paragraph', text: 'Source body.' }],
      }],
      resources: [],
      createdAt: 1000,
    });
    store.setCurrentArticleDocument(entry.id, document.id);
    store.saveTranslation(entry.id, {
      titleZh: '旧版标题',
      summaryZh: '旧版摘要',
      content: [{
        i: 0,
        tag: 'p',
        kind: 'text',
        source: 'Source body.',
        sourceHtml: '<p>Source body.</p>',
        target: '旧版正文。',
        targetHtml: '<p>旧版正文。</p>',
      }],
      model: 'legacy-model',
      provider: 'deepseek',
      createdBy: 'system',
      contentHash: store.hashText(entry.title + '\\n' + entry.content),
      titleHash: store.hashText(entry.title),
    });
    process.stdout.write(JSON.stringify({ entryId: entry.id, documentId: document.id }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function seedPublishedVersions(dataDir) {
  const script = `
    const store = require('./lib/store');
    const { buildTranslationInputV2 } = require('./lib/translation-contract');
    const entryId = 'versioned-api-entry';
    const current = store.getCurrentArticleDocument(entryId);
    const currentInput = buildTranslationInputV2({
      documentId: current.id,
      sourceHash: current.sourceHash,
      title: current.title,
      summary: current.summary,
      segments: current.ast[0].children,
    });
    const currentVersionId = 'translation-version-' + 'a'.repeat(64);
    const currentVersion = store.publishTranslationVersion({
      id: currentVersionId,
      entryId,
      documentId: current.id,
      ownerType: 'system',
      userId: null,
      author: 'Namoo Reader',
      sourceHash: current.sourceHash,
      pipelineHash: require('./lib/translation-contract').translationPipelineHash(),
      generationHash: 'versioned-api-current-generation',
      schemaVersion: 2,
      titleZh: '当前版本标题',
      summaryZh: '',
      content: {
        schemaVersion: 2,
        translations: currentInput.segments.map(segment => ({
          id: segment.id,
          target: segment.role === 'title' ? '当前版本标题' : '当前版本正文。',
        })),
      },
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      createdAt: 2000,
    });
    const historical = store.insertArticleDocument({
      id: 'versioned-api-historical-document',
      entryId,
      snapshotId: null,
      sourceComponents: [],
      provenance: 'legacy',
      rawStatus: 'unavailable',
      documentHash: 'versioned-api-historical-document-hash',
      sourceHash: 'versioned-api-historical-source-hash',
      extractorVersion: 'extractor-v1',
      sanitizerVersion: 'sanitizer-v1',
      segmenterVersion: 'segmenter-v1',
      title: 'Historical article',
      summary: '',
      normalizedHtml: '<p>Historical body.</p>',
      plainText: 'Historical body. Historical link. Historical image.',
      ast: [
        { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_old_body', role: 'paragraph', text: 'Historical body.' }] },
        { type: 'element', tag: 'p', children: [{
          type: 'element', tag: 'a', resourceId: 'r_old_link',
          children: [{ type: 'text', id: 's_old_link', role: 'paragraph', text: 'Historical link.' }],
        }] },
        { type: 'element', tag: 'img', resourceId: 'r_old_image', alt: { type: 'text', id: 's_old_alt', role: 'image_alt', text: 'Historical image.' } },
      ],
      resources: [
        { id: 'r_old_link', type: 'link', url: 'https://old.example/docs' },
        { id: 'r_old_image', type: 'image', url: 'https://old.example/image.png' },
      ],
      createdAt: 900,
    });
    const historicalInput = buildTranslationInputV2({
      documentId: historical.id,
      sourceHash: historical.sourceHash,
      title: historical.title,
      summary: historical.summary,
      segments: [
        ...historical.ast[0].children,
        ...historical.ast[1].children[0].children,
        historical.ast[2].alt,
      ],
    });
    const historicalVersion = store.insertTranslationVersion({
      id: 'translation-version-' + 'b'.repeat(64),
      entryId,
      documentId: historical.id,
      ownerType: 'system',
      userId: null,
      author: 'Namoo Reader',
      sourceHash: historical.sourceHash,
      pipelineHash: require('./lib/translation-contract').translationPipelineHash(),
      generationHash: 'versioned-api-historical-generation',
      schemaVersion: 2,
      titleZh: '历史版本标题',
      summaryZh: '',
      content: {
        schemaVersion: 2,
        translations: historicalInput.segments.map(segment => ({
          id: segment.id,
          target: segment.role === 'title'
            ? '历史版本标题'
            : segment.role === 'image_alt' ? '历史图片' : '历史译文。',
        })),
      },
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      createdAt: 1500,
    });
    process.stdout.write(JSON.stringify({
      currentVersionId: currentVersion.id,
      historicalVersionId: historicalVersion.id,
      historicalDocumentId: historical.id,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function seedUserVersionHistory(dataDir) {
  const script = `
    const store = require('./lib/store');
    const { buildTranslationInputV2, translationPipelineHash } = require('./lib/translation-contract');
    const entryId = 'versioned-api-entry';
    const document = store.getCurrentArticleDocument(entryId);
    const user = store.createUser({
      email: 'version-history@example.com',
      password: 'version-history-password',
      displayName: 'Version History User',
    });
    const input = buildTranslationInputV2({
      documentId: document.id,
      sourceHash: document.sourceHash,
      title: document.title,
      summary: document.summary,
      segments: document.ast[0].children,
    });
    function publish(id, generationHash, createdAt, title, body) {
      return store.publishTranslationVersion({
        id,
        entryId,
        documentId: document.id,
        ownerType: 'user',
        userId: user.id,
        author: user.displayName,
        sourceHash: document.sourceHash,
        pipelineHash: translationPipelineHash(),
        generationHash,
        schemaVersion: 2,
        titleZh: title,
        summaryZh: '',
        content: {
          schemaVersion: 2,
          translations: input.segments.map(segment => ({
            id: segment.id,
            target: segment.role === 'title' ? title : body,
          })),
        },
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        createdAt,
      }, { promotion: 'never' });
    }
    const first = publish('versioned-user-history-one', 'versioned-user-history-generation-one', 2100, '用户首版标题', '用户首版正文。');
    const second = publish('versioned-user-history-two', 'versioned-user-history-generation-two', 2200, '用户二版标题', '用户二版正文。');
    process.stdout.write(JSON.stringify({
      entryId,
      stableAssetId: first.assetId,
      firstVersionId: first.id,
      secondVersionId: second.id,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function seedLegacyVersion(dataDir) {
  const script = `
    const store = require('./lib/store');
    const entryId = 'versioned-api-entry';
    const document = store.getCurrentArticleDocument(entryId);
    const version = store.publishTranslationVersion({
      id: 'versioned-api-legacy-version',
      entryId,
      documentId: document.id,
      ownerType: 'system',
      userId: null,
      author: 'Legacy Translator',
      sourceHash: document.sourceHash,
      pipelineHash: 'legacy_unknown',
      generationHash: 'versioned-api-legacy-generation',
      schemaVersion: 1,
      titleZh: '迁移后的旧标题',
      summaryZh: '迁移后的旧摘要',
      content: [{
        i: 0,
        tag: 'p',
        source: 'Source body.',
        target: '迁移后的旧正文。',
        targetHtml: '<p>迁移后的旧正文。</p>',
      }],
      provider: 'deepseek',
      model: 'legacy-model',
      createdAt: 1800,
    }, { promotion: 'legacy' });
    process.stdout.write(JSON.stringify({ versionId: version.id }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function advanceDocumentWithoutSourceChange(dataDir) {
  const script = `
    const store = require('./lib/store');
    const entryId = 'versioned-api-entry';
    const current = store.getCurrentArticleDocument(entryId);
    const next = store.insertArticleDocument({
      ...current,
      id: 'versioned-api-raw-only-document',
      snapshotId: null,
      documentHash: 'versioned-api-raw-only-document-hash',
      createdAt: 3000,
    });
    store.setCurrentArticleDocument(entryId, next.id);
    process.stdout.write(JSON.stringify({ documentId: next.id, sourceHash: next.sourceHash }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function seedEntryWithoutDocument(dataDir) {
  const script = `
    const store = require('./lib/store');
    const content = '<p>' + 'Source body. '.repeat(80) + '</p>';
    const entry = {
      id: 'versioned-api-no-document',
      sourceId: 'versioned-api-test',
      title: 'Entry without a versioned document',
      link: 'https://example.com/no-document',
      summary: 'Source summary.',
      content,
    };
    store.upsertEntries([entry]);
    store.saveTranslation(entry.id, {
      titleZh: '无文档旧译文',
      summaryZh: '',
      content: [{ source: 'Source body.', target: '可继续显示的旧译文。' }],
      model: 'legacy-model',
      provider: 'deepseek',
      createdBy: 'system',
      contentHash: store.hashText(entry.title + '\\n' + content),
      titleHash: store.hashText(entry.title),
    });
    process.stdout.write(JSON.stringify({ entryId: entry.id }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function insertSystemJob(dataDir, { entryId, documentId, sourceHash, createdAt = Date.now() }) {
  const id = `translation-job-system-${createdAt}`;
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare(`
    INSERT INTO translation_jobs (
      id, entry_id, document_id, owner_type, user_id, author, source_hash,
      pipeline_hash, generation_hash, provider, model, tuning_json, priority,
      status, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'system', NULL, 'Namoo Reader', ?,
      'system-pipeline-hash', ?, 'deepseek', 'deepseek-v4-flash', '{}', 20,
      'queued', 0, ?, ?)
  `).run(
    id,
    entryId,
    documentId,
    sourceHash,
    `system-generation-${createdAt}`,
    createdAt,
    createdAt,
  );
  db.close();
  return id;
}

async function startServer(dataDir, env = {}) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      NAMOO_READER_DATA_DIR: dataDir,
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: 'API Admin',
      COOKIE_SECURE: '0',
      DEEPSEEK_API_KEY: 'site-key-must-not-leak',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      VERSIONED_TRANSLATION_MODE: 'canary',
      TRANSLATION_WORKER_STARTUP: '0',
      TRANSLATION_WORKER_DISABLED: '1',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/sources`);
      if (response.ok) return { child, baseUrl, logs };
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function waitForLog(server, pattern) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const output = server.logs.join('');
    if (pattern.test(output)) return output;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return server.logs.join('');
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function login(baseUrl, email = 'admin@example.com', password = 'test-password-123') {
  const result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return String(result.response.headers.get('set-cookie') || '').split(';')[0];
}

async function register(baseUrl, email, displayName) {
  const result = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reader-password-123', displayName }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return String(result.response.headers.get('set-cookie') || '').split(';')[0];
}

test('canary site-AI translation POST deduplicates normal requests while force enqueues a new generation', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-api-');
  const seeded = seedEntry(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, {
      VERSIONED_TRANSLATION_CANARY_ENTRY_IDS: seeded.entryId,
    });
    const cookie = await login(server.baseUrl);
    const request = () => jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });

    const first = await request();
    const duplicate = await request();

    assert.equal(first.response.status, 202, JSON.stringify(first.body));
    assert.match(first.body.jobId, /^translation-job-/);
    assert.equal(first.response.headers.get('location'), `/api/translation-jobs/${first.body.jobId}`);
    assert.equal(first.body.translation.titleZh, '旧版标题');
    assert.equal(first.body.translation.content[0].target, '旧版正文。');
    assert.equal(first.body.schemaVersion, null);
    assert.equal(first.body.documentId, seeded.documentId);
    assert.equal(first.body.versionId, null);
    assert.equal(first.body.status, 'legacy_unknown');
    assert.deepEqual(first.body.staleReasons, ['legacy_hash_unknown']);
    assert.equal(first.body.job.id, first.body.jobId);
    assert.equal(first.body.job.status, 'queued');
    assert.deepEqual(first.body.job.progress, { completed: 0, total: 1 });
    assert.equal(duplicate.response.status, 202, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.jobId, first.body.jobId);

    const current = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: cookie },
    });
    assert.equal(current.response.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.job.id, first.body.jobId);
    assert.equal(current.body.job.status, 'queued');

    const forced = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(forced.response.status, 202, JSON.stringify(forced.body));
    assert.notEqual(forced.body.jobId, first.body.jobId);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('translation job progress is owner-only and omits persisted or provider-internal data', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-job-api-');
  const seeded = seedEntry(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, {
      VERSIONED_TRANSLATION_CANARY_ENTRY_IDS: seeded.entryId,
    });
    const ownerCookie = await login(server.baseUrl);
    const otherCookie = await register(server.baseUrl, 'other@example.com', 'Other Reader');
    const queued = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: '{}',
    });
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    const jobPath = `/api/translation-jobs/${queued.body.jobId}`;

    const anonymous = await jsonRequest(server.baseUrl, jobPath);
    const other = await jsonRequest(server.baseUrl, jobPath, { headers: { Cookie: otherCookie } });
    const owner = await jsonRequest(server.baseUrl, jobPath, { headers: { Cookie: ownerCookie } });

    assert.equal(anonymous.response.status, 401);
    assert.equal(other.response.status, 403);
    assert.equal(owner.response.status, 200, JSON.stringify(owner.body));
    assert.deepEqual(owner.body.job, queued.body.job);
    assert.deepEqual(Object.keys(owner.body.job).sort(), [
      'completedAt', 'createdAt', 'error', 'id', 'progress', 'status', 'updatedAt',
    ]);
    assert.doesNotMatch(JSON.stringify(owner.body), /site-key-must-not-leak|api.?key|authorization|prompt|tuning|chunkHash|result/i);

    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db.prepare(`
      UPDATE translation_jobs
      SET status = 'failed', error_code = 'ERR_PROVIDER_BODY',
          error_message = 'provider-internal-body-must-not-leak'
      WHERE id = ?
    `).run(queued.body.jobId);
    db.close();
    const failed = await jsonRequest(server.baseUrl, jobPath, { headers: { Cookie: ownerCookie } });
    assert.equal(failed.response.status, 200, JSON.stringify(failed.body));
    assert.deepEqual(failed.body.job.error, {
      code: 'ERR_PROVIDER_BODY',
      message: '翻译任务失败，请稍后重试',
    });
    assert.doesNotMatch(JSON.stringify(failed.body), /provider-internal-body-must-not-leak/);

    const otherTranslation = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: otherCookie },
    });
    assert.equal(otherTranslation.response.status, 200, JSON.stringify(otherTranslation.body));
    assert.equal(otherTranslation.body.job, null);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('system jobs are public article status while an owner active user job takes precedence', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-system-job-api-');
  const seeded = seedEntry(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    const ownerCookie = await login(server.baseUrl);
    const readerCookie = await register(server.baseUrl, 'system-job-reader@example.com', 'System Job Reader');
    const queued = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: '{}',
    });
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    const systemJobId = insertSystemJob(dataDir, {
      entryId: seeded.entryId,
      documentId: seeded.documentId,
      sourceHash: 'versioned-api-source-hash',
      createdAt: Date.now() + 10_000,
    });

    const owner = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: ownerCookie },
    });
    const reader = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: readerCookie },
    });
    const anonymous = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`);
    const publicSystemJob = await jsonRequest(server.baseUrl, `/api/translation-jobs/${systemJobId}`);
    const privateUserJob = await jsonRequest(server.baseUrl, `/api/translation-jobs/${queued.body.jobId}`);

    assert.equal(owner.body.job.id, queued.body.jobId);
    assert.equal(reader.body.job.id, systemJobId);
    assert.equal(anonymous.body.job.id, systemJobId);
    assert.equal(publicSystemJob.response.status, 200, JSON.stringify(publicSystemJob.body));
    assert.equal(publicSystemJob.body.job.id, systemJobId);
    assert.equal(privateUserJob.response.status, 401);
    assert.doesNotMatch(JSON.stringify(publicSystemJob.body), /tuning|provider|model|generation|sourceHash|prompt|api.?key/i);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a stale compatible legacy translation reports stale_source while retaining the unknown legacy hash reason', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-stale-legacy-api-');
  const seeded = seedEntry(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE entry_translations SET content_hash = ? WHERE entry_id = ?')
    .run('obsolete-legacy-content-hash', seeded.entryId);
  db.close();
  let server = null;
  try {
    server = await startServer(dataDir);
    const cookie = await login(server.baseUrl);
    const result = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });

    assert.equal(result.response.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.translation.stale, true);
    assert.equal(result.body.status, 'stale_source');
    assert.deepEqual(result.body.staleReasons, ['source_hash_changed', 'legacy_hash_unknown']);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('versioned GET keeps the compatible translation shape and renders an asset from its immutable document', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-read-api-');
  const seeded = seedEntry(dataDir);
  const versions = seedPublishedVersions(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir);
    const cookie = await login(server.baseUrl);
    const current = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: cookie },
    });
    const historical = await jsonRequest(
      server.baseUrl,
      `/api/entry/${seeded.entryId}/translation?assetId=${encodeURIComponent(versions.historicalVersionId)}`,
      { headers: { Cookie: cookie } },
    );

    assert.equal(current.response.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.schemaVersion, 2);
    assert.equal(current.body.documentId, seeded.documentId);
    assert.equal(current.body.versionId, versions.currentVersionId);
    assert.equal(current.body.status, 'fresh');
    assert.deepEqual(current.body.staleReasons, []);
    assert.equal(current.body.job, null);
    assert.equal(current.body.translation.id, versions.currentVersionId);
    assert.equal(current.body.translation.titleZh, '当前版本标题');
    assert.equal(current.body.translation.content.some(item => item.target === '当前版本正文。'), true);
    assert.equal(current.body.renderedHtml, '<p>当前版本正文。</p>');

    const queued = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.schemaVersion, 2);
    assert.equal(queued.body.documentId, seeded.documentId);
    assert.equal(queued.body.versionId, versions.currentVersionId);
    assert.equal(queued.body.translation.id, versions.currentVersionId);
    assert.equal(queued.body.renderedHtml, '<p>当前版本正文。</p>');

    assert.equal(historical.response.status, 200, JSON.stringify(historical.body));
    assert.equal(historical.body.schemaVersion, 2);
    assert.equal(historical.body.documentId, versions.historicalDocumentId);
    assert.equal(historical.body.versionId, versions.historicalVersionId);
    assert.equal(historical.body.status, 'stale_source');
    assert.deepEqual(historical.body.staleReasons, ['source_document_changed', 'source_hash_changed']);
    assert.equal(historical.body.translation.id, versions.historicalVersionId);
    assert.match(historical.body.renderedHtml, /href="https:\/\/old\.example\/docs" target="_blank" rel="noopener noreferrer nofollow"/);
    assert.match(historical.body.renderedHtml, /src="https:\/\/old\.example\/image\.png" alt="历史图片" loading="lazy"/);
    assert.doesNotMatch(JSON.stringify(historical.body), /raw_status|normalizedHtml|resources|ast|prompt|api.?key/i);

    const helpful = await jsonRequest(
      server.baseUrl,
      `/api/entry/${seeded.entryId}/assets/translation/helpful`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ helpful: true, assetId: versions.currentVersionId }),
      },
    );
    assert.equal(helpful.response.status, 200, JSON.stringify(helpful.body));
    assert.deepEqual(helpful.body.reaction, { helpfulCount: 1, helpfulByMe: true });

    const annotation = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        surface: 'translation',
        assetId: versions.currentVersionId,
        quote: '当前版本正文',
        body: '保留完整版本身份。',
        contentHash: current.body.translation.contentHash,
      }),
    });
    assert.equal(annotation.response.status, 200, JSON.stringify(annotation.body));
    assert.equal(annotation.body.annotation.assetId, versions.currentVersionId);
    assert.equal(annotation.body.annotation.assetId.length, 84);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a stable user asset opens its latest V2 head while immutable version ids keep their history', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-user-history-api-');
  const seeded = seedEntry(dataDir);
  const history = seedUserVersionHistory(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    const latest = await jsonRequest(
      server.baseUrl,
      `/api/entry/${seeded.entryId}/translation?assetId=${encodeURIComponent(history.stableAssetId)}`,
    );
    const first = await jsonRequest(
      server.baseUrl,
      `/api/entry/${seeded.entryId}/translation?assetId=${encodeURIComponent(history.firstVersionId)}`,
    );

    assert.equal(latest.response.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.versionId, history.secondVersionId);
    assert.equal(latest.body.translation.id, history.stableAssetId);
    assert.equal(latest.body.translation.titleZh, '用户二版标题');
    assert.equal(latest.body.renderedHtml, '<p>用户二版正文。</p>');
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.versionId, history.firstVersionId);
    assert.equal(first.body.translation.id, history.firstVersionId);
    assert.equal(first.body.translation.titleZh, '用户首版标题');
    assert.equal(first.body.renderedHtml, '<p>用户首版正文。</p>');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a current translation from an older pipeline remains readable with stale_pipeline status', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-stale-pipeline-api-');
  const seeded = seedEntry(dataDir);
  const versions = seedPublishedVersions(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE translation_versions SET pipeline_hash = ? WHERE id = ?')
    .run('obsolete-translation-pipeline', versions.currentVersionId);
  db.close();
  let server = null;
  try {
    server = await startServer(dataDir);
    const cookie = await login(server.baseUrl);
    const result = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: cookie },
    });

    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'stale_pipeline');
    assert.deepEqual(result.body.staleReasons, ['pipeline_hash_changed']);
    assert.equal(result.body.translation.titleZh, '当前版本标题');
    assert.equal(result.body.renderedHtml, '<p>当前版本正文。</p>');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a raw-only document change with the same source hash keeps the current translation fresh', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-raw-only-api-');
  const seeded = seedEntry(dataDir);
  const versions = seedPublishedVersions(dataDir);
  const next = advanceDocumentWithoutSourceChange(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    const result = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`);

    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.versionId, versions.currentVersionId);
    assert.equal(result.body.documentId, seeded.documentId);
    assert.notEqual(result.body.documentId, next.documentId);
    assert.equal(result.body.status, 'fresh');
    assert.deepEqual(result.body.staleReasons, []);
    assert.equal(result.body.renderedHtml, '<p>当前版本正文。</p>');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a migrated schema-1 version stays readable in all mode without entering the V2 renderer', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-legacy-version-api-');
  const seeded = seedEntry(dataDir);
  const legacy = seedLegacyVersion(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    const cookie = await login(server.baseUrl);
    const current = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`);
    const queued = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });

    assert.equal(current.response.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.schemaVersion, 1);
    assert.equal(current.body.documentId, seeded.documentId);
    assert.equal(current.body.versionId, legacy.versionId);
    assert.equal(current.body.status, 'legacy_unknown');
    assert.deepEqual(current.body.staleReasons, ['legacy_hash_unknown']);
    assert.equal(current.body.translation.id, legacy.versionId);
    assert.equal(current.body.translation.titleZh, '迁移后的旧标题');
    assert.equal(current.body.translation.content[0].target, '迁移后的旧正文。');
    assert.equal(current.body.renderedHtml, null);

    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.schemaVersion, 1);
    assert.equal(queued.body.versionId, legacy.versionId);
    assert.equal(queued.body.job.id, queued.body.jobId);
    assert.equal(queued.body.renderedHtml, null);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('BYOK remains on the synchronous legacy response and never persists a job or browser secret', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-byok-api-');
  const seeded = seedEntry(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    const cookie = await login(server.baseUrl);
    const result = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'x-ai-key': 'byok-secret-must-not-persist',
        'x-ai-provider': 'deepseek',
        'x-ai-model': 'deepseek-v4-flash',
      },
      body: '{}',
    });

    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.cached, true);
    assert.equal(result.body.translation.titleZh, '旧版标题');
    assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'jobId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'job'), false);
    assert.equal(result.response.headers.get('location'), null);
    assert.doesNotMatch(JSON.stringify(result.body), /byok-secret-must-not-persist/);

    await stopServer(server);
    server = null;
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    const count = db.prepare('SELECT COUNT(*) AS count FROM translation_jobs').get().count;
    db.close();
    assert.equal(count, 0);
    assert.equal(fs.readFileSync(path.join(dataDir, 'qmreader.sqlite')).includes('byok-secret-must-not-persist'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('missing current document falls back with a structured canary warning and fails closed in all mode', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-missing-document-api-');
  const seeded = seedEntryWithoutDocument(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'canary' });
    let cookie = await login(server.baseUrl);
    const canary = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    const canaryLogs = await waitForLog(server, /versioned_translation_post_fallback/);

    assert.equal(canary.response.status, 200, JSON.stringify(canary.body));
    assert.equal(canary.body.translation.titleZh, '无文档旧译文');
    assert.match(canaryLogs, /"event":"versioned_translation_post_fallback"/);
    assert.match(canaryLogs, /"code":"ERR_TRANSLATION_DOCUMENT_UNAVAILABLE"/);
    assert.doesNotMatch(canaryLogs, /site-key-must-not-leak/);

    await stopServer(server);
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    cookie = await login(server.baseUrl);
    const all = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });

    assert.equal(all.response.status, 409, JSON.stringify(all.body));
    assert.match(all.body.error, /versioned translation document is unavailable/i);
    assert.equal(Object.prototype.hasOwnProperty.call(all.body, 'translation'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a malformed V2 read falls back only in canary and emits a structured warning', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-translation-read-fallback-api-');
  const seeded = seedEntry(dataDir);
  const versions = seedPublishedVersions(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE translation_versions SET content_json = ? WHERE id = ?')
    .run('{"schemaVersion":2,"translations":[]}', versions.currentVersionId);
  db.close();
  let server = null;
  try {
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'canary' });
    let cookie = await login(server.baseUrl);
    const canary = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: cookie },
    });
    const logs = await waitForLog(server, /versioned_translation_read_failed/);

    assert.equal(canary.response.status, 200, JSON.stringify(canary.body));
    assert.equal(canary.body.translation.titleZh, '当前版本标题');
    assert.equal(canary.body.warning.code, 'ERR_TRANSLATION_RENDER_INCOMPLETE');
    assert.match(logs, /"event":"versioned_translation_read_failed"/);
    assert.match(logs, /"mode":"canary"/);
    assert.doesNotMatch(logs, /site-key-must-not-leak/);

    const queued = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    const postLogs = await waitForLog(server, /versioned_translation_post_state_fallback/);
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.translation.titleZh, '当前版本标题');
    assert.equal(queued.body.warning.code, 'ERR_TRANSLATION_RENDER_INCOMPLETE');
    assert.match(postLogs, /"event":"versioned_translation_post_state_fallback"/);

    await stopServer(server);
    server = await startServer(dataDir, { VERSIONED_TRANSLATION_MODE: 'all' });
    cookie = await login(server.baseUrl);
    const all = await jsonRequest(server.baseUrl, `/api/entry/${seeded.entryId}/translation`, {
      headers: { Cookie: cookie },
    });

    assert.equal(all.response.status, 500, JSON.stringify(all.body));
    assert.equal(Object.prototype.hasOwnProperty.call(all.body, 'translation'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('versioned pipeline status is admin-only and exposes aggregate safe fields', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('versioned-pipeline-status-api-');
  seedEntry(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir);
    const adminCookie = await login(server.baseUrl);
    const readerCookie = await register(server.baseUrl, 'status-reader@example.com', 'Status Reader');

    const anonymous = await jsonRequest(server.baseUrl, '/api/admin/versioned-pipeline-status');
    const reader = await jsonRequest(server.baseUrl, '/api/admin/versioned-pipeline-status', {
      headers: { Cookie: readerCookie },
    });
    const admin = await jsonRequest(server.baseUrl, '/api/admin/versioned-pipeline-status', {
      headers: { Cookie: adminCookie },
    });

    assert.equal(anonymous.response.status, 403);
    assert.equal(reader.response.status, 403);
    assert.equal(admin.response.status, 200, JSON.stringify(admin.body));
    assert.deepEqual(Object.keys(admin.body).sort(), ['freshness', 'generatedAt', 'jobs', 'rawStorage']);
    assert.deepEqual(Object.keys(admin.body.jobs).sort(), [
      'failed', 'failuresByCode', 'oldestWaitingAgeMs', 'queued', 'retry', 'running',
    ]);
    assert.doesNotMatch(JSON.stringify(admin.body), /Versioned API article|Source body|site-key-must-not-leak|api.?key|provider body/i);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
