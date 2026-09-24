const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
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
      ADMIN_NAME: '大月 Namoo',
      COOKIE_SECURE: '0',
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

function runRefreshWorker(dataDir, sourceId, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/refresh-worker.js',
      '--kind=refresh',
      `--source=${sourceId}`,
    ], {
      cwd: projectDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NAMOO_READER_DATA_DIR: dataDir,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function adminCookie(baseUrl) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

function readAiCalls(capturePath) {
  try { return JSON.parse(fs.readFileSync(capturePath, 'utf8')).calls || []; } catch { return []; }
}

function readIngestionDatabase(dataDir, sourceId) {
  const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  try {
    return {
      ingestion: database.prepare('SELECT * FROM source_ingestion_sources WHERE source_id = ?').get(sourceId),
      entries: database.prepare('SELECT id, title, link, published_ts, platform_identity, content_scope, auto_ai_excluded_at, deleted_at FROM entries WHERE source_id = ? ORDER BY title').all(sourceId),
    };
  } finally {
    database.close();
  }
}

async function waitForBackgroundIdle(baseUrl, cookie, timeoutMs = 15000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    const { response, body } = await jsonRequest(baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, JSON.stringify(body));
    latest = body;
    const background = body.backgroundJob || {};
    if (!background.fetch?.running && !background.ai?.running && !body.refreshing && !body.autoRewrite?.running) {
      return background;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`background workers did not become idle: ${JSON.stringify(latest && latest.backgroundJob)}`);
}

test('site AI metadata is available without exposing the site API key', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir, {
      DEEPSEEK_API_KEY: 'site-key-must-not-leak',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    });
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    const result = await jsonRequest(server.baseUrl, '/api/me');

    assert.equal(login.response.status, 200);
    assert.equal(login.body.siteAi.configured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(login.body.siteAi, 'apiKey'), false);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.siteAi.configured, true);
    assert.equal(result.body.siteAi.provider, 'deepseek');
    assert.equal(result.body.siteAi.model, 'deepseek-v4-flash');
    assert.equal(Object.prototype.hasOwnProperty.call(result.body.siteAi, 'apiKey'), false);
    assert.equal(JSON.stringify(result.body).includes('site-key-must-not-leak'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('source management API enforces visibility, validation, ordering, and persistence', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir);
    const anonymous = await jsonRequest(server.baseUrl, '/api/sources');
    assert.equal(anonymous.response.status, 200);
    assert.equal(anonymous.body.sources.some(source => source.id === 'qiaomu-blog'), false);
    assert.equal(anonymous.body.sources.some(source => source.id === 'meta-ai'), false);

    const anonymousCreate = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Not allowed', feedUrl: 'https://example.com/feed.xml' }),
    });
    assert.equal(anonymousCreate.response.status, 403);

    const cookie = await adminCookie(server.baseUrl);
    const admin = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    assert.equal(admin.body.sources.some(source => source.id === 'qiaomu-blog'), true);
    assert.equal(admin.body.sources.some(source => source.id === 'meta-ai'), true);

    const invalidCustom = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Broken custom source', feedUrl: 'file:///tmp/feed.xml' }),
    });
    assert.equal(invalidCustom.response.status, 400);

    const createdCustom = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Custom AI Brief',
        feedUrl: 'http://127.0.0.1:1/feed.xml',
        siteUrl: 'http://127.0.0.1:1',
        category: 'news',
        labels: ['研究', '自定义'],
        description: 'Test-only custom feed',
      }),
    });
    assert.equal(createdCustom.response.status, 201, JSON.stringify(createdCustom.body));
    assert.equal(createdCustom.body.source.isCustom, true);
    assert.equal(createdCustom.body.source.enabled, true);
    assert.equal(createdCustom.body.source.category, 'news');
    const customSourceId = createdCustom.body.source.id;
    assert.match(customSourceId, /^custom-/);

    const publicCustom = await jsonRequest(server.baseUrl, '/api/sources');
    const publicCustomSource = publicCustom.body.sources.find(source => source.id === customSourceId);
    assert.equal(publicCustomSource.name, 'Custom AI Brief');
    assert.equal(Object.prototype.hasOwnProperty.call(publicCustomSource, 'feedUrl'), false);

    const updatedCustom = await jsonRequest(server.baseUrl, `/api/sources/${customSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Custom AI Brief Updated',
        feedUrl: 'http://127.0.0.1:1/updated.xml',
        labels: ['研究', '已编辑'],
      }),
    });
    assert.equal(updatedCustom.response.status, 200, JSON.stringify(updatedCustom.body));
    assert.equal(updatedCustom.body.source.name, 'Custom AI Brief Updated');
    assert.equal(updatedCustom.body.sources.find(source => source.id === customSourceId).feedUrl, 'http://127.0.0.1:1/updated.xml');

    const invalidPriority = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ editorialPriority: 'urgent' }),
    });
    assert.equal(invalidPriority.response.status, 400);

    const updated = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false, editorialPriority: 'low' }),
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.source.enabled, false);
    assert.equal(updated.body.source.editorialPriority, 'low');

    const moved = await jsonRequest(server.baseUrl, '/api/sources/anthropic/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ direction: 'down' }),
    });
    assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.moved, true);
    assert.equal(moved.body.neighborId, 'anthropic-research');

    const boundaryIndex = moved.body.sources.findIndex((source, index, sources) => (
      index > 0 && source.category !== sources[index - 1].category
    ));
    assert.ok(boundaryIndex > 0);
    const boundarySource = moved.body.sources[boundaryIndex];
    const boundaryNeighbor = moved.body.sources[boundaryIndex - 1];
    const movedAcrossCategory = await jsonRequest(server.baseUrl, `/api/sources/${boundarySource.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ direction: 'up', scope: 'all' }),
    });
    assert.equal(movedAcrossCategory.response.status, 200, JSON.stringify(movedAcrossCategory.body));
    assert.equal(movedAcrossCategory.body.moved, true);
    assert.equal(movedAcrossCategory.body.neighborId, boundaryNeighbor.id);

    const noFeed = await jsonRequest(server.baseUrl, '/api/sources/meta-ai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(noFeed.response.status, 400);

    await stopServer(server);
    server = await startServer(dataDir);
    const secondCookie = await adminCookie(server.baseUrl);
    const persisted = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: secondCookie } });
    const openai = persisted.body.sources.find(source => source.id === 'openai');
    const anthropic = persisted.body.sources.find(source => source.id === 'anthropic');
    const anthropicResearch = persisted.body.sources.find(source => source.id === 'anthropic-research');
    const custom = persisted.body.sources.find(source => source.id === customSourceId);
    assert.equal(openai.enabled, false);
    assert.equal(openai.editorialPriority, 'low');
    assert.ok(anthropic.displayOrder > anthropicResearch.displayOrder);
    assert.equal(custom.name, 'Custom AI Brief Updated');
    assert.equal(custom.feedUrl, 'http://127.0.0.1:1/updated.xml');

    const publicAfterRestart = await jsonRequest(server.baseUrl, '/api/sources');
    assert.equal(publicAfterRestart.body.sources.some(source => source.id === 'openai'), false);

    const builtInArchive = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
    });
    assert.equal(builtInArchive.response.status, 400);

    const archived = await jsonRequest(server.baseUrl, `/api/sources/${customSourceId}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
    });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.archived.id, customSourceId);
    assert.equal(archived.body.sources.some(source => source.id === customSourceId), false);

    await stopServer(server);
    server = await startServer(dataDir);
    const finalCookie = await adminCookie(server.baseUrl);
    const afterArchiveRestart = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: finalCookie } });
    assert.equal(afterArchiveRestart.body.sources.some(source => source.id === customSourceId), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('PATCH cannot route an ordinary Custom Source through an unverified WeChat refresh', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const sourceCapturePath = path.join(dataDir, 'source-requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-requests.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const feedUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: sourceCapturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      VERSIONED_TRANSLATION_MODE: 'off',
      PERIODICALS_MODE: 'off',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-source-ai.example/v1',
      AI_MODEL: 'mock-model',
    });
    const cookie = await adminCookie(server.baseUrl);
    const catalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
    assert.ok(catalog.body.items.some(item => item.key === catalogKey));

    const created = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Ordinary custom source',
        feedUrl: 'http://127.0.0.1:1/ordinary.xml',
        siteUrl: 'http://127.0.0.1:1',
        category: 'news',
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const sourceId = created.body.source.id;
    await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.deepEqual(readAiCalls(aiCapturePath), [], 'ordinary source setup has no article or AI input');

    const patched = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ feedUrl }),
    });
    if (patched.response.status === 200) await waitForBackgroundIdle(server.baseUrl, cookie);

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    let sourceRow;
    let ingestion;
    let entries;
    try {
      sourceRow = database.prepare('SELECT id, feed_url FROM custom_sources WHERE id = ?').get(sourceId);
      ingestion = database.prepare('SELECT * FROM source_ingestion_sources WHERE source_id = ?').get(sourceId) || null;
      entries = database.prepare('SELECT id, platform_identity, auto_ai_excluded_at FROM entries WHERE source_id = ?').all(sourceId);
    } finally {
      database.close();
    }
    const requests = JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests || [];
    assert.equal(patched.response.status, 409, JSON.stringify({ status: patched.response.status, error: patched.body && patched.body.error }));
    assert.match(patched.body.error, /catalog key|catalog.*activation|目录.*激活/i,
      'the rejection directs administrators to the validated catalog-key activation flow');
    assert.equal(sourceRow.feed_url, 'http://127.0.0.1:1/ordinary.xml', 'the custom source feed URL remains unchanged');
    assert.equal(ingestion, null, 'the blocked patch neither enrolls the source nor creates a cutoff identity');
    assert.deepEqual(entries, [], 'the blocked patch does not import unverified feed entries');
    assert.equal(requests.some(request => request.url === feedUrl), false,
      'the blocked patch does not schedule a generic refresh against the WeChat supplier');
    assert.deepEqual(readAiCalls(aiCapturePath), [],
      'the blocked patch cannot reach automatic title/rewriting AI through refresh-parent scheduling');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy catalog WeChat Custom Sources fail closed when enabled before explicit activation', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const sourceCapturePath = path.join(dataDir, 'source-requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-requests.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const feedUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const sourceId = 'custom-legacy-unregistered-wechat';
  const legacyEntryId = 'legacy-unregistered-readable-entry';
  const legacyTitle = 'An English legacy WeChat title must await explicit activation';
  const legacyBodyMarker = 'LEGACY_CANONICAL_WECHAT_FEED_BODY_MUST_NOT_REACH_AUTOMATIC_AI';
  const legacyContent = `<p>Legacy readable content remains available. ${`${legacyBodyMarker} English feed-body details remain readable. `.repeat(12)}</p>`;
  const archivedSourceId = 'custom-archived-unregistered-wechat';
  const archivedTitle = 'An archived English WeChat title must not be bulk-scanned';
  const archivedBodyMarker = 'ARCHIVED_LEGACY_WECHAT_BODY_MUST_NOT_REACH_AUTOMATIC_AI';
  const archivedContent = `<p>${`${archivedBodyMarker} Eligible feed-body content remains readable. `.repeat(12)}</p>`;
  assert.ok(legacyContent.replace(/<[^>]+>/g, ' ').length > 600);
  assert.ok(archivedContent.replace(/<[^>]+>/g, ' ').length > 600);
  let server = null;
  try {
    fs.writeFileSync(modePath, 'mixed-same-account');
    server = await startServer(dataDir);
    await adminCookie(server.baseUrl);
    await stopServer(server);
    server = null;

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const now = Date.now();
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, '人人都是产品经理', ?, 'https://www.woshipm.com/', 'article', 'legacy catalog URL without enrollment', '[]', NULL, ?, ?)`).run(
        sourceId, feedUrl, now, now,
      );
      database.prepare(`INSERT INTO source_preferences (source_id, enabled, editorial_priority, display_order, updated_at)
        VALUES (?, 0, 'normal', 4, ?)`).run(sourceId, new Date(now).toISOString());
      database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash, platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
        VALUES (?, ?, ?, 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=9001&idx=1&sn=legacy', '', ?, 'English legacy teaser', ?, 'legacy-unregistered-hash', 'wechat:MzA1:9001:1', 'feed-body', NULL, ?, ?)`).run(
        legacyEntryId, sourceId, legacyTitle, now - 60 * 60 * 1000, legacyContent, now, now,
      );
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, 'Archived legacy WeChat', 'https://wechat2rss.bestblogs.dev/feed/archived12345678.xml', '', 'article', 'archived unregistered catalog source', '[]', ?, ?, ?)`).run(
        archivedSourceId, now, now, now,
      );
      database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash, platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
        VALUES ('archived-unregistered-readable-entry', ?, ?, 'https://mp.weixin.qq.com/s?__biz=MzB2&mid=9002&idx=1&sn=archived', '', ?, 'Archived English teaser', ?, 'archived-unregistered-hash', 'wechat:MzB2:9002:1', 'feed-body', NULL, ?, ?)`).run(
        archivedSourceId, archivedTitle, now - 2 * 60 * 60 * 1000, archivedContent, now, now,
      );
      assert.equal(database.prepare('SELECT source_id FROM source_ingestion_sources WHERE source_id = ?').get(sourceId), undefined,
        'the legacy source intentionally has no verified ingestion enrollment');
    } finally {
      database.close();
    }

    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: sourceCapturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      VERSIONED_TRANSLATION_MODE: 'off',
      PERIODICALS_MODE: 'off',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-source-ai.example/v1',
      AI_MODEL: 'mock-model',
    });
    const cookie = await adminCookie(server.baseUrl);
    const enabled = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.source.enabled, true);
    const enabledBackground = await waitForBackgroundIdle(server.baseUrl, cookie);
    const automaticAiCallCounts = [readAiCalls(aiCapturePath).length];
    const directRefresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(directRefresh.response.status, 200, JSON.stringify(directRefresh.body));
    const directBackground = await waitForBackgroundIdle(server.baseUrl, cookie);
    automaticAiCallCounts.push(readAiCalls(aiCapturePath).length);

    const disabledToggle = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/toggle`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(disabledToggle.response.status, 200, JSON.stringify(disabledToggle.body));
    assert.equal(disabledToggle.body.enabled, false);
    const enabledToggle = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/toggle`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(enabledToggle.response.status, 200, JSON.stringify(enabledToggle.body));
    assert.equal(enabledToggle.body.enabled, true);
    const toggleBackground = await waitForBackgroundIdle(server.baseUrl, cookie);
    automaticAiCallCounts.push(readAiCalls(aiCapturePath).length);

    const discovered = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: cookie } });
    assert.equal(discovered.response.status, 200, JSON.stringify(discovered.body));
    const legacyCatalogItem = discovered.body.items.find(item => item.key === catalogKey);
    assert.equal(legacyCatalogItem.online, true);
    assert.equal(legacyCatalogItem.sourceId, sourceId);
    assert.equal(legacyCatalogItem.activated, false,
      'an online legacy URL match remains distinguishable from an explicitly activated source');

    const entriesDatabase = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    let entryRows;
    try {
      entryRows = entriesDatabase.prepare('SELECT id, content, auto_ai_excluded_at FROM entries WHERE source_id = ? ORDER BY id').all(sourceId);
    } finally {
      entriesDatabase.close();
    }
    const sourceList = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    const sourceMeta = sourceList.body.sources.find(source => source.id === sourceId);
    const supplierFetchCount = (JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests || [])
      .filter(request => request.url === feedUrl).length;
    const state = {
      refreshStatuses: [
        enabledBackground.fetch.last.refresh.status,
        directBackground.fetch.last.refresh.status,
        toggleBackground.fetch.last.refresh.status,
      ],
      automaticAiJobsStarted: [
        Boolean(enabledBackground.ai.last),
        Boolean(directBackground.ai.last),
        Boolean(toggleBackground.ai.last),
      ],
      automaticAiCallCounts,
      sourceMetaStatus: sourceMeta.status,
      sourceError: String(sourceMeta.error || ''),
      activationRequired: /catalog.*activat|activat.*catalog/i.test(String(sourceMeta.error || '')),
      supplierFetchCount,
      entryIds: entryRows.map(entry => entry.id),
      oldEntryReadable: entryRows.some(entry => entry.id === legacyEntryId
        && /Legacy readable content remains available/.test(entry.content)
        && entry.auto_ai_excluded_at === null),
      automaticAiCalls: readAiCalls(aiCapturePath).length,
    };
    assert.deepEqual(state, {
      refreshStatuses: ['stale', 'stale', 'stale'],
      automaticAiJobsStarted: [false, false, false],
      automaticAiCallCounts: [0, 0, 0],
      sourceMetaStatus: 'stale',
      sourceError: `WeChat catalog feed requires explicit catalog-key activation before refresh (catalog key: ${catalogKey})`,
      activationRequired: true,
      supplierFetchCount: 0,
      entryIds: [legacyEntryId],
      oldEntryReadable: true,
      automaticAiCalls: 0,
    });
    const nonFetchOnlyWorker = await runRefreshWorker(dataDir, sourceId, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: sourceCapturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-source-ai.example/v1',
      AI_MODEL: 'mock-model',
    });
    assert.equal(nonFetchOnlyWorker.code, 0, nonFetchOnlyWorker.stderr);
    const nonFetchOnlyResult = JSON.parse(nonFetchOnlyWorker.stdout);
    assert.equal(nonFetchOnlyResult.refresh.status, 'stale');
    assert.equal(nonFetchOnlyResult.translated, 0);
    assert.equal(nonFetchOnlyResult.autoRewrite.changed, 0);
    assert.deepEqual(readAiCalls(aiCapturePath), [],
      'the actual non-fetch-only refresh worker also skips title translation and rewrite for the legacy source');
    assert.equal((JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests || [])
      .filter(request => request.url === feedUrl).length, 0);
    const oldEntry = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(legacyEntryId)}`);
    assert.equal(oldEntry.response.status, 200);
    assert.match(oldEntry.body.entry.content, /Legacy readable content remains available/);

    const bulkRewrite = await jsonRequest(server.baseUrl, '/api/auto-rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceIds: [sourceId, archivedSourceId] }),
    });
    assert.equal(bulkRewrite.response.status, 200, JSON.stringify(bulkRewrite.body));
    assert.equal(bulkRewrite.body.autoRewrite.started, true);
    const bulkRewriteBackground = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.equal(bulkRewriteBackground.ai.last.kind, 'auto-rewrite');
    const bulkRewriteCalls = readAiCalls(aiCapturePath);
    const bulkRewriteSummary = bulkRewriteCalls.map(call => {
      const messages = Array.isArray(call.messages) ? call.messages : [];
      const promptText = messages.map(message => String(message.content || '')).join('\\n');
      const containsLegacyBody = promptText.includes(legacyBodyMarker);
      const containsArchivedBody = promptText.includes(archivedBodyMarker);
      return {
        kind: containsLegacyBody || containsArchivedBody ? 'rewrite' : 'title-translation',
        containsLegacyTitle: promptText.includes(legacyTitle),
        containsLegacyBody,
        containsArchivedTitle: promptText.includes(archivedTitle),
        containsArchivedBody,
      };
    });

    const bulkTitleScan = await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ limit: 10 }),
    });
    assert.equal(bulkTitleScan.response.status, 200, JSON.stringify(bulkTitleScan.body));
    assert.equal(bulkTitleScan.body.translated, 0);
    const bulkTitleCalls = readAiCalls(aiCapturePath).slice(bulkRewriteCalls.length);
    const bulkTitleSummary = bulkTitleCalls.map(call => {
      const messages = Array.isArray(call.messages) ? call.messages : [];
      const promptText = messages.map(message => String(message.content || '')).join('\\n');
      return {
        containsLegacyTitle: promptText.includes(legacyTitle),
        containsLegacyBody: promptText.includes(legacyBodyMarker),
        containsArchivedTitle: promptText.includes(archivedTitle),
        containsArchivedBody: promptText.includes(archivedBodyMarker),
      };
    });
    assert.deepEqual({ bulkRewrite: bulkRewriteSummary, bulkTitleScan: bulkTitleSummary }, {
      bulkRewrite: [],
      bulkTitleScan: [],
    }, `unregistered catalog sources must be excluded from both bulk paths: ${JSON.stringify({ bulkRewrite: bulkRewriteSummary, bulkTitleScan: bulkTitleSummary })}`);

    const manualTranslation = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(legacyEntryId)}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(manualTranslation.response.status, 200, JSON.stringify(manualTranslation.body));
    const explicitCalls = readAiCalls(aiCapturePath);
    assert.equal(explicitCalls.length, bulkRewriteCalls.length + bulkTitleCalls.length + 1,
      'explicit per-entry translation is still available on an unregistered legacy source');
    assert.ok(explicitCalls.at(-1).messages.some(message => String(message.content || '').includes(legacyTitle)));

    const aiCallCountBeforeActivation = explicitCalls.length;
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.source.id, sourceId, 'explicit catalog activation reconciles the legacy source in place');
    assert.equal(activated.body.created, false);
    assert.ok(activated.body.activationCutoff > 0);
    const afterActivation = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const ingestion = afterActivation.prepare(`SELECT source_id, platform, catalog_key, feed_url, activation_cutoff, activation_completed_at
        FROM source_ingestion_sources WHERE source_id = ?`).get(sourceId);
      const rows = afterActivation.prepare(`SELECT id, platform_identity, content, auto_ai_excluded_at
        FROM entries WHERE source_id = ? ORDER BY id`).all(sourceId);
      assert.equal(ingestion.platform, 'wechat');
      assert.equal(ingestion.catalog_key, catalogKey);
      assert.equal(ingestion.feed_url, feedUrl);
      assert.equal(ingestion.activation_cutoff, activated.body.activationCutoff);
      assert.ok(ingestion.activation_completed_at > 0);
      const reconciledOldEntry = rows.find(entry => entry.id === legacyEntryId);
      assert.ok(reconciledOldEntry);
      assert.equal(reconciledOldEntry.platform_identity, 'wechat:MzA1:9001:1');
      assert.match(reconciledOldEntry.content, /Legacy readable content remains available/);
      assert.equal(reconciledOldEntry.auto_ai_excluded_at, activated.body.activationCutoff);
      assert.ok(rows.every(entry => entry.auto_ai_excluded_at === activated.body.activationCutoff));
      assert.equal(rows.length, 4, 'the preserved legacy row and three validated feed entries share the original source');
    } finally {
      afterActivation.close();
    }
    assert.equal((JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests || [])
      .filter(request => request.url === feedUrl).length, 1,
    'supplier fetch occurs only inside explicit catalog activation');
    assert.equal(readAiCalls(aiCapturePath).length, aiCallCountBeforeActivation,
      'activation itself does not launch automatic AI work');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('administrator activates a WeChat catalog key into one readable Custom Source', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'source-ingestion-requests.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });

    const anonymous = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedUrl: 'http://127.0.0.1:1/forged.xml' }),
    });
    assert.equal(anonymous.response.status, 403, JSON.stringify(anonymous.body));
    const readerRegistration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reader@example.com', password: 'reader-password-123', displayName: 'Reader' }),
    });
    assert.equal(readerRegistration.response.status, 200, JSON.stringify(readerRegistration.body));
    const readerCookie = String(readerRegistration.response.headers.get('set-cookie') || '').split(';')[0];
    const readerAttempt = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
      body: JSON.stringify({ feedUrl: 'http://127.0.0.1:1/forged.xml' }),
    });
    assert.equal(readerAttempt.response.status, 403, JSON.stringify(readerAttempt.body));

    const cookie = await adminCookie(server.baseUrl);
    const activatePath = `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`;
    const activationResponses = await Promise.all([1, 2].map(() => jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ feedUrl: 'http://127.0.0.1:1/forged.xml' }),
    })));
    const activated = activationResponses[0];
    assert.ok([200, 201].includes(activated.response.status), JSON.stringify(activated.body));
    assert.equal(activationResponses[1].body.source.id, activated.body.source.id, 'concurrent activation returns one source identity');
    assert.equal(activated.body.source.isCustom, true);
    assert.equal(activated.body.source.enabled, true);
    assert.equal(activated.body.entryCount, 2, 'parameter variants map to one canonical WeChat article');
    assert.equal(Object.prototype.hasOwnProperty.call(activated.body.source, 'feedUrl'), false);

    const sourceId = activated.body.source.id;
    const publicCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const publicItem = publicCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(publicItem.online, true, 'guests can discover an activated, readable WeChat source');
    assert.equal(publicItem.sourceId, sourceId, 'the safe source ID enables public reading');
    assert.equal(Object.hasOwn(publicItem, 'activated'), false);
    assert.equal(Object.hasOwn(publicItem, 'archived'), false);
    assert.equal(Object.hasOwn(publicItem, 'feedUrl'), false);
    const readerCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: readerCookie } });
    const readerItem = readerCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(readerItem.online, true, 'authenticated readers receive the same safe readable status');
    assert.equal(readerItem.sourceId, sourceId);
    assert.equal(Object.hasOwn(readerItem, 'activated'), false);
    assert.equal(Object.hasOwn(readerItem, 'archived'), false);
    assert.equal(Object.hasOwn(readerItem, 'feedUrl'), false);
    const adminCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: cookie } });
    const adminItem = adminCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(adminItem.online, true);
    assert.equal(adminItem.activated, true);
    assert.equal(adminItem.archived, false);
    assert.equal(adminItem.sourceId, sourceId);
    const listed = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.entries.length, 2, 'every item in the initial feed window is immediately readable');
    assert.ok(listed.body.entries.every(entry => entry.sourceId === sourceId));
    assert.equal(listed.body.entries[0].title, 'How product teams validate real user needs', 'unknown publication dates do not sort as newly published');
    assert.equal(listed.body.entries[0].contentScope, 'feed-body');
    assert.equal(listed.body.entries[1].contentScope, 'summary');

    const opened = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(listed.body.entries[0].id)}`);
    assert.equal(opened.response.status, 200, JSON.stringify(opened.body));
    assert.match(opened.body.entry.content, /Feed-provided article body excerpt/);
    assert.equal(Object.hasOwn(opened.body.entry, 'autoAiExcludedAt'), false,
      'guest article APIs must not reveal the internal automatic-AI exclusion marker');
    assert.ok(listed.body.entries.every(entry => !Object.hasOwn(entry, 'autoAiExcludedAt')),
      'guest list APIs must not reveal the internal automatic-AI exclusion marker');

    const persistedExclusions = readIngestionDatabase(dataDir, sourceId);
    assert.ok(persistedExclusions.entries.every(entry => (
      entry.auto_ai_excluded_at === persistedExclusions.ingestion.activation_cutoff
    )), 'the internal worker-enforcement marker remains durably stored');
    for (const [role, viewerCookie] of [['reader', readerCookie], ['admin', cookie]]) {
      const roleEntries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`, {
        headers: { Cookie: viewerCookie },
      });
      assert.ok(roleEntries.body.entries.every(entry => !Object.hasOwn(entry, 'autoAiExcludedAt')),
        `${role} list APIs must not reveal the internal automatic-AI exclusion marker`);
      const roleEntry = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(listed.body.entries[0].id)}`, {
        headers: { Cookie: viewerCookie },
      });
      assert.equal(Object.hasOwn(roleEntry.body.entry, 'autoAiExcludedAt'), false,
        `${role} article APIs must not reveal the internal automatic-AI exclusion marker`);
    }

    const requests = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests;
    assert.equal(requests.filter(request => request.url === catalogUrl).length, 1);
    assert.equal(requests.filter(request => request.url.startsWith('https://wechat2rss.bestblogs.dev/feed/')).length, 1);
    assert.equal(requests.some(request => request.url.includes('127.0.0.1:1')), false,
      'the server resolves the catalog feed URL instead of trusting client input');
    assert.equal(requests.some(request => request.url.includes('mp.weixin.qq.com')), false,
      'activation persists feed content without deep-fetching article pages');

    const manualAdd = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'manual alias', feedUrl: 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml' }),
    });
    assert.equal(manualAdd.response.status, 200, JSON.stringify(manualAdd.body));
    assert.equal(manualAdd.body.source.id, sourceId, 'identified manual feed additions share the catalog source identity');

    const deletedId = listed.body.entries[0].id;
    const deleted = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(deletedId)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
    const archived = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    await jsonRequest(server.baseUrl, '/api/source-catalog');
    const archivedList = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    assert.equal(archivedList.body.sources.some(source => source.id === sourceId), false,
      'a normal catalog read cannot implicitly re-enable an archived source');
    const guestArchivedCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const guestArchivedItem = guestArchivedCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(guestArchivedItem.online, false);
    assert.equal(Object.hasOwn(guestArchivedItem, 'sourceId'), false);
    assert.equal(Object.hasOwn(guestArchivedItem, 'archived'), false);
    assert.equal(Object.hasOwn(guestArchivedItem, 'activated'), false);
    const readerArchivedCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: readerCookie } });
    const readerArchivedItem = readerArchivedCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(readerArchivedItem.online, false);
    assert.equal(Object.hasOwn(readerArchivedItem, 'sourceId'), false);
    assert.equal(Object.hasOwn(readerArchivedItem, 'archived'), false);
    assert.equal(Object.hasOwn(readerArchivedItem, 'activated'), false);
    const archivedCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: cookie } });
    const archivedItem = archivedCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(archivedItem.archived, true);
    assert.equal(archivedItem.activated, true);
    assert.equal(archivedItem.online, false);
    assert.equal(Object.hasOwn(archivedItem, 'sourceId'), false);
    const archivedManualAdd = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'manual alias', feedUrl: 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml' }),
    });
    assert.equal(archivedManualAdd.response.status, 409, JSON.stringify(archivedManualAdd.body));
    const stillArchived = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/refresh-hint`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(stillArchived.response.status, 200);
    const deniedRestore = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(deniedRestore.response.status, 409, JSON.stringify(deniedRestore.body));

    const restored = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ restore: true }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.source.id, sourceId, 'explicit restore reuses the archived source ID');
    const restoredGuestCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const restoredGuestItem = restoredGuestCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(restoredGuestItem.online, true);
    assert.equal(restoredGuestItem.sourceId, sourceId);
    assert.equal(Object.hasOwn(restoredGuestItem, 'archived'), false);
    const restoredReaderCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: readerCookie } });
    const restoredReaderItem = restoredReaderCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(restoredReaderItem.online, true);
    assert.equal(restoredReaderItem.sourceId, sourceId);
    assert.equal(Object.hasOwn(restoredReaderItem, 'activated'), false);
    const restoredAdminCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: cookie } });
    const restoredAdminItem = restoredAdminCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(restoredAdminItem.online, true);
    assert.equal(restoredAdminItem.activated, true);
    assert.equal(restoredAdminItem.archived, false);
    const afterRestore = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    assert.equal(afterRestore.body.entries.length, 1, 'the soft-deleted entry remains hidden after feed restore');
    const deletedDeepLink = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(deletedId)}`);
    assert.equal(deletedDeepLink.response.status, 404);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('successful WeChat translation, rewrite, and onepage responses omit the internal AI exclusion marker', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const sourceCapturePath = path.join(dataDir, 'source-requests.json');
  const translationCapturePath = path.join(dataDir, 'translation-ai-request.json');
  const rewriteCapturePath = path.join(dataDir, 'rewrite-ai-request.json');
  const onepageCapturePath = path.join(dataDir, 'onepage-ai-request.json');
  const sourcePreloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const rewritePreloadPath = path.join(__dirname, 'helpers', 'mock-ai-preload.js');
  const onepagePreloadPath = path.join(__dirname, 'helpers', 'mock-onepage-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const feedUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml';
  let sourceId = '';
  const testEntries = [
    { id: 'privacy-translation-entry', mid: '7001', action: 'translation' },
    { id: 'privacy-rewrite-entry', mid: '7002', action: 'rewrite' },
    { id: 'privacy-onepage-entry', mid: '7003', action: 'onepage' },
  ];
  const versionedEntry = { id: 'privacy-versioned-translation-entry', mid: '7004' };
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${sourcePreloadPath} --require=${rewritePreloadPath} --require=${onepagePreloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: sourceCapturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: translationCapturePath,
      MOCK_SOURCE_WECHAT_ORIGINAL_MODE: 'success',
      MOCK_AI_CAPTURE_PATH: rewriteCapturePath,
      MOCK_ONEPAGE_CAPTURE_PATH: onepageCapturePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      VERSIONED_TRANSLATION_MODE: 'all',
      DEEPSEEK_API_KEY: 'site-mock-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      TRANSLATION_WORKER_STARTUP: '0',
      TRANSLATION_WORKER_DISABLED: '1',
      ONEPAGE_MODE: 'all',
    });
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    assert.equal(login.response.status, 200, `${JSON.stringify(login.body)}\n${server.logs.join('')}`);
    const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0];
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.ok([200, 201].includes(activated.response.status), JSON.stringify(activated.body));
    sourceId = activated.body.source.id;
    const beforeExplicitActions = JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests;
    assert.equal(beforeExplicitActions.some(request => request.url.includes('mp.weixin.qq.com')), false,
      'catalog activation must not fetch historical article pages automatically');

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    let activationCutoff;
    try {
      const ingestion = database.prepare('SELECT activation_cutoff, feed_url FROM source_ingestion_sources WHERE source_id = ?').get(sourceId);
      activationCutoff = ingestion.activation_cutoff;
      assert.equal(ingestion.feed_url, feedUrl);
      const now = Date.now();
      const insert = database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash, platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, 'Short feed-provided teaser.', '<p>Short feed-provided teaser without the full original article.</p>', ?, ?, 'summary', ?, ?, ?)`);
      for (const item of [...testEntries, versionedEntry]) {
        insert.run(
          item.id,
          sourceId,
          `Controlled privacy test ${item.mid}`,
          `https://mp.weixin.qq.com/s?__biz=MzA1&mid=${item.mid}&idx=1&sn=privacy-${item.mid}`,
          activationCutoff - 1000,
          `privacy-test-hash-${item.mid}`,
          `wechat:MzA1:${item.mid}:1`,
          activationCutoff,
          now,
          now,
        );
      }
    } finally {
      database.close();
    }

    const aiHeaders = (baseUrl, model) => ({
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-AI-Key': 'mock-key',
      'X-AI-Provider': 'openai-compatible',
      'X-AI-Provider-Name': 'Mock AI',
      'X-AI-Provider-Type': 'openai_compatible',
      'X-AI-Base-URL': baseUrl,
      'X-AI-Model': model,
    });
    const outcomes = [];
    for (const item of testEntries) {
      const result = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(item.id)}/${item.action}`, {
        method: 'POST',
        headers: aiHeaders(
          item.action === 'translation' ? 'https://mock-source-ai.example/v1'
            : item.action === 'rewrite' ? 'https://mock-ai.example/v1'
              : 'https://mock-onepage.example/v1',
          `mock-${item.action}-model`,
        ),
        body: JSON.stringify({ force: true }),
      });
      assert.equal(result.response.status, 200, `${item.action}: ${JSON.stringify(result.body)}`);
      const entry = result.body.entry;
      outcomes.push({
        action: item.action,
        hasEntry: Boolean(entry),
        markerPresent: Boolean(entry && Object.hasOwn(entry, 'autoAiExcludedAt')),
        originalFetched: Boolean(entry && String(entry.content || '').includes('deliberately distinct from the short feed summary')),
      });
      if (item.action === 'translation') assert.ok(Array.isArray(result.body.translation.content));
      if (item.action === 'rewrite') assert.match(result.body.rewrite.body, /## Namoo 风格草稿/);
      if (item.action === 'onepage') assert.match(result.body.onepage.html, /onepage-shell/);
    }

    assert.deepEqual(outcomes, testEntries.map(item => ({
      action: item.action,
      hasEntry: true,
      markerPresent: false,
      originalFetched: true,
    })));
    assert.ok(fs.existsSync(translationCapturePath), 'translation request reached the mocked AI supplier');
    assert.ok(fs.existsSync(rewriteCapturePath), 'rewrite request reached the mocked AI supplier');
    assert.ok(fs.existsSync(onepageCapturePath), 'onepage request reached the mocked AI supplier');
    const originalRequests = JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests
      .filter(request => request.url.includes('mp.weixin.qq.com'));
    assert.deepEqual(originalRequests.map(request => new URL(request.url).searchParams.get('mid')).sort(), ['7001', '7002', '7003']);

    const finalDatabase = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const persisted = testEntries.map(item => finalDatabase.prepare(`SELECT content_scope, auto_ai_excluded_at, original_fetched_at
        FROM entries WHERE id = ?`).get(item.id));
      assert.ok(persisted.every(entry => entry.content_scope === 'summary'));
      assert.ok(persisted.every(entry => entry.auto_ai_excluded_at === activationCutoff),
        'explicit AI actions may fetch original content but cannot clear the automatic exclusion');
      assert.ok(persisted.every(entry => entry.original_fetched_at > 0));
    } finally {
      finalDatabase.close();
    }

    const versioned = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(versionedEntry.id)}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(versioned.response.status, 202, `${JSON.stringify(versioned.body)}\n${server.logs.slice(-30).join('')}`);
    assert.equal(versioned.body.originalFetched, true);
    assert.ok(versioned.body.jobId);
    assert.equal(Object.hasOwn(versioned.body.entry, 'autoAiExcludedAt'), false,
      'the versioned translation enqueue response must use the same public entry projection');
    assert.match(versioned.body.entry.content, /deliberately distinct from the short feed summary/);
    const versionedDatabase = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const persistedVersioned = versionedDatabase.prepare('SELECT auto_ai_excluded_at, original_fetched_at FROM entries WHERE id = ?').get(versionedEntry.id);
      assert.equal(persistedVersioned.auto_ai_excluded_at, activationCutoff);
      assert.ok(persistedVersioned.original_fetched_at > 0);
      const allOriginalMidValues = JSON.parse(fs.readFileSync(sourceCapturePath, 'utf8')).requests
        .filter(request => request.url.includes('mp.weixin.qq.com'))
        .map(request => new URL(request.url).searchParams.get('mid'))
        .sort();
      assert.deepEqual(allOriginalMidValues, ['7001', '7002', '7003', '7004']);
    } finally {
      versionedDatabase.close();
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('activation reconciles a legacy manual feed source without changing its identity or reader associations', { timeout: 45000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'source-requests.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const feedUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const sourceId = 'custom-legacy-wechat-source';
  const entryId = 'legacy-wechat-entry-kept';
  const annotationId = 'legacy-wechat-annotation-kept';
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    await adminCookie(server.baseUrl);
    await stopServer(server);
    server = null;

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const admin = database.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get();
      assert.ok(admin, 'test server created the existing admin account');
      const now = Date.now();
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'article', ?, '[]', NULL, ?, ?)`).run(
        sourceId, '人人都是产品经理', feedUrl, 'https://www.woshipm.com/', 'legacy hand-added feed', now, now,
      );
      database.prepare(`INSERT INTO source_preferences (source_id, enabled, editorial_priority, display_order, updated_at)
        VALUES (?, 1, 'high', 4, ?)`).run(sourceId, new Date(now).toISOString());
      database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?)`).run(
        entryId,
        sourceId,
        'How product teams validate real user needs',
        'https://mp.weixin.qq.com/s?from=timeline&idx=1&mid=1001&__biz=MzA1&sn=old-tracking',
        'Legacy summary',
        'Legacy content that belongs to this stable article ID.',
        'legacy-content-hash',
        now,
        now,
      );
      database.prepare(`INSERT INTO user_entry_states (user_id, entry_id, starred_at, updated_at) VALUES (?, ?, ?, ?)`).run(
        admin.id, entryId, now, now,
      );
      database.prepare(`INSERT INTO text_annotations
        (id, entry_id, surface, user_id, author, quote, body, is_public, created_at, updated_at)
        VALUES (?, ?, 'original', ?, 'Admin', 'stable quote', 'stable annotation', 1, ?, ?)`).run(
        annotationId, entryId, admin.id, now, now,
      );
      database.prepare(`INSERT INTO entry_translations
        (entry_id, user_id, title_zh, summary_zh, content_json, model, provider, created_by, content_hash, title_hash, created_at, updated_at)
        VALUES (?, ?, '已有译名', '已有摘要', '[]', 'legacy-model', 'openai-compatible', 'Admin', 'legacy-content-hash', 'legacy-title-hash', ?, ?)`).run(
        entryId, admin.id, now, now,
      );
    } finally {
      database.close();
    }

    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.source.id, sourceId);
    assert.equal(activated.body.created, false);
    assert.equal(activated.body.entryCount, 2);

    const escapedFeedUrl = 'https://example.test/legacy-source-escape.xml';
    const blockedEdit = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Must not replace the catalog source',
        feedUrl: escapedFeedUrl,
        labels: ['untrusted-edit'],
      }),
    });
    if (blockedEdit.response.status === 200) await waitForBackgroundIdle(server.baseUrl, cookie);
    const blockedDatabase = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    let blockedSourceRow;
    let blockedIngestionRow;
    try {
      blockedSourceRow = blockedDatabase.prepare('SELECT name, feed_url FROM custom_sources WHERE id = ?').get(sourceId);
      blockedIngestionRow = blockedDatabase.prepare('SELECT platform, catalog_key, feed_url FROM source_ingestion_sources WHERE source_id = ?').get(sourceId);
    } finally {
      blockedDatabase.close();
    }
    assert.deepEqual({
      status: blockedEdit.response.status,
      sourceName: blockedSourceRow.name,
      customSourceFeedUrl: blockedSourceRow.feed_url,
      ingestionFeedUrl: blockedIngestionRow && blockedIngestionRow.feed_url,
    }, {
      status: 409,
      sourceName: '人人都是产品经理',
      customSourceFeedUrl: feedUrl,
      ingestionFeedUrl: feedUrl,
    }, JSON.stringify({ status: blockedEdit.response.status, error: blockedEdit.body && blockedEdit.body.error }));
    assert.match(blockedEdit.body.error, /pinned.*(catalog|ingestion)|catalog.*pinned/i);

    const allowedEdit = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Legacy WeChat metadata updated', labels: ['approved'], editorialPriority: 'low' }),
    });
    assert.equal(allowedEdit.response.status, 200, JSON.stringify(allowedEdit.body));
    assert.equal(allowedEdit.body.source.id, sourceId);
    assert.equal(allowedEdit.body.source.name, 'Legacy WeChat metadata updated');
    assert.equal(allowedEdit.body.sources.find(source => source.id === sourceId).feedUrl, feedUrl);
    assert.equal(allowedEdit.body.source.editorialPriority, 'low');
    assert.deepEqual(allowedEdit.body.source.labels, ['approved']);
    await waitForBackgroundIdle(server.baseUrl, cookie);

    const current = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const source = current.prepare('SELECT id, name, feed_url, labels_json FROM custom_sources WHERE id = ?').get(sourceId);
      const preference = current.prepare('SELECT editorial_priority FROM source_preferences WHERE source_id = ?').get(sourceId);
      const ingestion = current.prepare('SELECT platform, catalog_key, feed_url FROM source_ingestion_sources WHERE source_id = ?').get(sourceId);
      assert.deepEqual({
        id: source.id,
        name: source.name,
        feedUrl: source.feed_url,
        labels: JSON.parse(source.labels_json),
        priority: preference.editorial_priority,
        ingestionPlatform: ingestion.platform,
        ingestionCatalogKey: ingestion.catalog_key,
        ingestionFeedUrl: ingestion.feed_url,
      }, {
        id: sourceId,
        name: 'Legacy WeChat metadata updated',
        feedUrl,
        labels: ['approved'],
        priority: 'low',
        ingestionPlatform: 'wechat',
        ingestionCatalogKey: catalogKey,
        ingestionFeedUrl: feedUrl,
      });
      const requests = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests;
      assert.equal(requests.some(request => request.url === escapedFeedUrl), false,
        'metadata edits and refresh continue to use the pinned catalog feed URL');
      const entry = current.prepare('SELECT id, platform_identity, auto_ai_excluded_at FROM entries WHERE id = ?').get(entryId);
      assert.ok(entry);
      assert.equal(entry.platform_identity, 'wechat:MzA1:1001:1');
      assert.ok(entry.auto_ai_excluded_at > 0);
      assert.equal(current.prepare('SELECT starred_at FROM user_entry_states WHERE user_id = ? AND entry_id = ?').get(
        current.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get().id, entryId,
      ).starred_at > 0, true);
      assert.equal(current.prepare('SELECT body FROM text_annotations WHERE id = ?').get(annotationId).body, 'stable annotation');
      assert.equal(current.prepare('SELECT title_zh FROM entry_translations WHERE entry_id = ?').get(entryId).title_zh, '已有译名');
    } finally {
      current.close();
    }
    const visible = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    assert.equal(visible.response.status, 200);
    assert.ok(visible.body.entries.some(entry => entry.id === entryId));
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog projection exposes archived legacy URL variants only to admins and enables explicit restore', { timeout: 45000 }, async () => {
  const dataDir = createTempDataDir();
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const sourceId = 'custom-archived-legacy-wechat';
  const urlVariant = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml?utm_source=legacy&from=manual';
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    await adminCookie(server.baseUrl);
    const firstCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    assert.equal(firstCatalog.response.status, 200, JSON.stringify(firstCatalog.body));
    await stopServer(server);
    server = null;

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const now = Date.now();
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, '人人都是产品经理', ?, 'https://www.woshipm.com/', 'article', 'legacy URL variant', '[]', ?, ?, ?)`).run(
        sourceId, urlVariant, now, now, now,
      );
      database.prepare(`INSERT INTO source_preferences
        (source_id, enabled, editorial_priority, display_order, updated_at)
        VALUES (?, 0, 'normal', 5, ?)`).run(sourceId, new Date(now).toISOString());
    } finally {
      database.close();
    }

    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    const readerRegistration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy-reader@example.com', password: 'reader-password-123', displayName: 'Reader' }),
    });
    assert.equal(readerRegistration.response.status, 200, JSON.stringify(readerRegistration.body));
    const readerCookie = String(readerRegistration.response.headers.get('set-cookie') || '').split(';')[0];
    const admin = await adminCookie(server.baseUrl);

    const guest = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const guestItem = guest.body.items.find(item => item.key === catalogKey);
    assert.equal(guestItem.online, false);
    assert.equal(Object.hasOwn(guestItem, 'sourceId'), false);
    assert.equal(Object.hasOwn(guestItem, 'archived'), false);
    assert.equal(Object.hasOwn(guestItem, 'activated'), false);
    const reader = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: readerCookie } });
    const readerItem = reader.body.items.find(item => item.key === catalogKey);
    assert.equal(readerItem.online, false);
    assert.equal(Object.hasOwn(readerItem, 'archived'), false);
    assert.equal(Object.hasOwn(readerItem, 'activated'), false);
    const adminCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: admin } });
    const adminItem = adminCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(adminItem.online, false);
    assert.equal(adminItem.archived, true, 'canonical catalog-key matching reveals the legacy source needs explicit restore');
    assert.equal(adminItem.activated, false);
    assert.equal(Object.hasOwn(adminItem, 'sourceId'), false);
    assert.equal(Object.hasOwn(adminItem, 'feedUrl'), false);

    const activatePath = `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`;
    const denied = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(denied.response.status, 409, JSON.stringify(denied.body));
    const restored = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ restore: true }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.source.id, sourceId);
    const restoredCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const restoredItem = restoredCatalog.body.items.find(item => item.key === catalogKey);
    assert.equal(restoredItem.online, true);
    assert.equal(restoredItem.sourceId, sourceId);
    assert.equal(Object.hasOwn(restoredItem, 'archived'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('canonical legacy WeChat key collisions consistently select the active source and never duplicate it', { timeout: 45000 }, async () => {
  const dataDir = createTempDataDir();
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const archivedId = 'custom-legacy-wechat-older-archived';
  const activeId = 'custom-legacy-wechat-newer-active';
  const archivedUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22.xml?utm_source=archived';
  const activeUrl = 'https://wechat2rss.bestblogs.dev/feed/2d790e38f8af54c5af77fa5fed687a7c66d34c22?from=active';
  let server = null;
  try {
    const env = {
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    };
    server = await startServer(dataDir, env);
    await adminCookie(server.baseUrl);
    const firstCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    assert.equal(firstCatalog.response.status, 200, JSON.stringify(firstCatalog.body));
    await stopServer(server);
    server = null;

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const now = Date.now();
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, '人人都是产品经理', ?, 'https://www.woshipm.com/', 'article', 'legacy URL variant', '[]', ?, ?, ?)`).run(
        archivedId, archivedUrl, now - 1000, now - 2000, now - 2000,
      );
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, site_url, category, description, labels_json, archived_at, created_at, updated_at)
        VALUES (?, '人人都是产品经理', ?, 'https://www.woshipm.com/', 'article', 'active legacy URL variant', '[]', NULL, ?, ?)`).run(
        activeId, activeUrl, now - 1000, now - 1000,
      );
      database.prepare(`INSERT INTO source_preferences
        (source_id, enabled, editorial_priority, display_order, updated_at)
        VALUES (?, 0, 'normal', 5, ?), (?, 1, 'normal', 6, ?)`).run(
        archivedId, new Date(now).toISOString(), activeId, new Date(now).toISOString(),
      );
    } finally {
      database.close();
    }

    server = await startServer(dataDir, env);
    const readerRegistration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'collision-reader@example.com', password: 'reader-password-123', displayName: 'Reader' }),
    });
    const readerCookie = String(readerRegistration.response.headers.get('set-cookie') || '').split(';')[0];
    const admin = await adminCookie(server.baseUrl);
    const guestCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const readerCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: readerCookie } });
    const adminCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat', { headers: { Cookie: admin } });
    const itemFor = result => result.body.items.find(item => item.key === catalogKey);
    const guestItem = itemFor(guestCatalog);
    const readerItem = itemFor(readerCatalog);
    const adminItem = itemFor(adminCatalog);

    const activatePath = `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`;
    const normalActivation = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    const explicitActivation = await jsonRequest(server.baseUrl, activatePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ restore: true }),
    });
    const after = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    let sourceState;
    try {
      sourceState = after.prepare(`SELECT id, archived_at FROM custom_sources WHERE id IN (?, ?) ORDER BY id`).all(
        archivedId, activeId,
      ).map(row => [row.id, Boolean(row.archived_at)]);
    } finally {
      after.close();
    }

    assert.deepEqual({
      guest: { online: guestItem.online, hasManagementFields: Object.hasOwn(guestItem, 'archived') || Object.hasOwn(guestItem, 'activated') },
      reader: { online: readerItem.online, hasManagementFields: Object.hasOwn(readerItem, 'archived') || Object.hasOwn(readerItem, 'activated') },
      admin: { online: adminItem.online, archived: adminItem.archived, activated: adminItem.activated },
      normalActivation: {
        status: normalActivation.response.status,
        sourceId: normalActivation.body.source && normalActivation.body.source.id || null,
        restored: normalActivation.body.restored ?? null,
      },
      explicitActivation: {
        status: explicitActivation.response.status,
        sourceId: explicitActivation.body.source && explicitActivation.body.source.id || null,
        restored: explicitActivation.body.restored ?? null,
      },
      sourceState,
    }, {
      guest: { online: true, hasManagementFields: false },
      reader: { online: true, hasManagementFields: false },
      admin: { online: true, archived: false, activated: false },
      normalActivation: { status: 200, sourceId: activeId, restored: false },
      explicitActivation: { status: 200, sourceId: activeId, restored: false },
      sourceState: [[activeId, false], [archivedId, true]],
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid and redirected WeChat feeds fail without creating a Custom Source or article', { timeout: 60000 }, async () => {
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  for (const mode of ['html', 'empty', 'wrong-account', 'unavailable', 'redirect-private']) {
    const dataDir = createTempDataDir();
    const capturePath = path.join(dataDir, 'requests.json');
    let server = null;
    try {
      server = await startServer(dataDir, {
        NODE_OPTIONS: `--require=${preloadPath}`,
        MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
        MOCK_SOURCE_INGESTION_MODE: mode,
        SOURCE_CATALOG_FEED_URL: catalogUrl,
        SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      });
      const cookie = await adminCookie(server.baseUrl);
      const result = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ feedUrl: 'http://127.0.0.1:1/forged.xml' }),
      });
      assert.ok(result.response.status >= 400, `${mode} unexpectedly activated: ${JSON.stringify(result.body)}`);
      const sources = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      assert.equal(sources.body.sources.some(source => source.name === '人人都是产品经理'), false, `${mode} left a Custom Source behind`);
      const entries = await jsonRequest(server.baseUrl, '/api/entries');
      assert.equal(entries.body.entries.some(entry => entry.title === 'How product teams validate real user needs'), false,
        `${mode} must not fall back to creating an ordinary article`);
      const requests = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests;
      assert.equal(requests.some(request => request.url.includes('127.0.0.1:1')), false,
        `${mode} must not follow a private redirect or trust client-supplied URLs`);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test('a changed WeChat account identity cannot replace the last good source snapshot', { timeout: 45000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'requests.json');
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  fs.writeFileSync(modePath, 'ok');
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
      MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;
    const before = readIngestionDatabase(dataDir, sourceId);
    const beforeIds = before.entries.map(entry => entry.id).sort();

    fs.writeFileSync(modePath, 'account-changed');
    const refresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(refresh.response.status, 200, JSON.stringify(refresh.body));
    const idle = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.equal(idle.fetch.last.refresh.status, 'stale');
    const after = readIngestionDatabase(dataDir, sourceId);
    assert.deepEqual(after.entries.map(entry => entry.id).sort(), beforeIds);
    assert.equal(after.ingestion.platform_account_id, 'MzA1');
    const sourceList = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    const source = sourceList.body.sources.find(item => item.id === sourceId);
    assert.equal(source.entryCount, 2, 'identity mismatch preserves all prior readable content');
    const requests = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests;
    assert.equal(requests.some(request => request.url.includes('mp.weixin.qq.com')), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('WeChat refresh keeps legitimate mixed identities and rejects mismatched unbound articles before persistence', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'source-requests.json');
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  fs.writeFileSync(modePath, 'mixed-same-account');
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
      MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
      SOURCE_CATALOG_FEED_URL: catalogUrl,
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    });
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    assert.equal(activated.body.entryCount, 3, 'same-account feeds may contain both Biz-bound and SN-only article identities');
    const sourceId = activated.body.source.id;
    const before = readIngestionDatabase(dataDir, sourceId);
    const beforeIds = before.entries.map(entry => entry.id).sort();
    assert.ok(before.entries.some(entry => entry.platform_identity === 'wechat:sn:unbound-refresh-entry'));

    const refreshSameAccount = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(refreshSameAccount.response.status, 200, JSON.stringify(refreshSameAccount.body));
    const refreshed = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.equal(refreshed.fetch.last.refresh.status, 'ok');
    assert.deepEqual(readIngestionDatabase(dataDir, sourceId).entries.map(entry => entry.id).sort(), beforeIds);

    fs.writeFileSync(modePath, 'mixed-title-mismatch');
    const refreshMismatched = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(refreshMismatched.response.status, 200, JSON.stringify(refreshMismatched.body));
    const rejected = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.equal(rejected.fetch.last.refresh.status, 'stale');
    const after = readIngestionDatabase(dataDir, sourceId);
    assert.deepEqual(after.entries.map(entry => entry.id).sort(), beforeIds,
      'a mismatched feed title must not import the mixed feed\'s unbound SN-only article');
    assert.ok(after.entries.some(entry => entry.platform_identity === 'wechat:sn:unbound-refresh-entry'));
    assert.equal(after.ingestion.platform_account_id, 'MzA1');
    const sourceList = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    assert.equal(sourceList.body.sources.find(source => source.id === sourceId).entryCount, 3);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admin title translation skips excluded historical WeChat entries but still scans eligible entries', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'title-translation-request.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: capturePath,
      SOURCE_CATALOG_FEED_URL: 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml',
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'test-api-key',
      AI_BASE_URL: 'https://mock-source-ai.example/v1',
      AI_MODEL: 'test-title-model',
    });
    const cookie = await adminCookie(server.baseUrl);
    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const now = Date.now();
      database.prepare(`INSERT INTO custom_sources
        (id, name, feed_url, category, created_at, updated_at)
        VALUES ('custom-title-scan', 'WeChat title scan fixture', 'https://example.com/feed.xml', 'article', ?, ?)`).run(now, now);
      database.prepare(`INSERT INTO source_preferences (source_id, enabled, editorial_priority, display_order, updated_at)
        VALUES ('custom-title-scan', 1, 'normal', 0, ?)`).run(new Date(now).toISOString());
      const insertEntry = database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash,
         platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
        VALUES (?, 'custom-title-scan', ?, ?, '', ?, '', '', ?, ?, 'summary', ?, ?, ?)`);
      insertEntry.run(
        'excluded-title-entry',
        'Historical English title that must remain excluded',
        'https://mp.weixin.qq.com/s?__biz=MzA1&mid=1&idx=1&sn=old',
        now - 1000,
        'hash-excluded',
        'wechat:MzA1:1:1',
        now - 1000,
        now - 1000,
        now - 1000,
      );
      insertEntry.run(
        'eligible-title-entry',
        'Future English title that remains eligible',
        'https://mp.weixin.qq.com/s?__biz=MzA1&mid=2&idx=1&sn=future',
        now + 1000,
        'hash-eligible',
        'wechat:MzA1:2:1',
        null,
        now,
        now,
      );
    } finally {
      database.close();
    }

    const result = await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ limit: 10 }),
    });
    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    const prompt = (captured.calls || [])
      .flatMap(call => call.messages || [])
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .join('\n');
    assert.doesNotMatch(prompt, /Historical English title that must remain excluded/);
    assert.match(prompt, /Future English title that remains eligible/);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { translated: 0 });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the real refresh and AI worker skip future WeChat summary/unknown bodies but keep feed bodies eligible', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const sourceCapturePath = path.join(dataDir, 'source-requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-requests.json');
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  fs.writeFileSync(modePath, 'ok');
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: sourceCapturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
      SOURCE_CATALOG_FEED_URL: 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml',
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      VERSIONED_TRANSLATION_MODE: 'off',
      PERIODICALS_MODE: 'off',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-source-ai.example/v1',
      AI_MODEL: 'mock-model',
    });
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;

    const database = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    const untrusted = [
      ['future-summary-1', 'summary', 5],
      ['future-summary-2', 'summary', 4],
      ['future-unknown-1', 'unknown', 3],
      ['future-unknown-2', 'unknown', 2],
    ];
    try {
      const insertEntry = database.prepare(`INSERT INTO entries
        (id, source_id, title, link, published, published_ts, summary, content, content_hash,
         platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
      const insertTranslation = database.prepare(`INSERT INTO entry_translations
        (entry_id, title_zh, summary_zh, created_at, updated_at)
        VALUES (?, ?, '', ?, ?)`);
      const now = Date.now();
      for (const [id, scope, offsetMinutes] of untrusted) {
        const marker = `${id.toUpperCase()}_BODY_MUST_NOT_REACH_AUTOMATIC_AI`;
        const content = `<p>${marker}</p>${` ${marker} content is not a verified full article.`.repeat(8)}`;
        const publishedAt = now + offsetMinutes * 60 * 1000;
        insertEntry.run(
          id, sourceId, `未翻译标题 ${id}`,
          `https://mp.weixin.qq.com/s?__biz=MzA1&mid=${id}&idx=1&sn=${id}`,
          publishedAt, scope === 'summary' ? `${marker} feed summary.` : '', content,
          `${id}-hash`, `wechat:MzA1:${id}:1`, scope, now - 1000, now - 1000,
        );
        insertTranslation.run(id, `已翻译标题 ${id}`, now - 1000, now - 1000);
      }
    } finally {
      database.close();
    }

    fs.writeFileSync(modePath, 'new-future');
    const refresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(refresh.response.status, 200, JSON.stringify(refresh.body));
    const background = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.ok(background.fetch.last.refresh.changedEntryCount > 0,
      'the actual fetch worker imports the post-cutoff feed item');
    assert.equal(background.ai.last.kind, 'auto-rewrite',
      'the parent dispatches the actual automatic-AI worker after refresh');

    const entries = readIngestionDatabase(dataDir, sourceId).entries;
    const feedBodyEntry = entries.find(entry => entry.title === 'A new WeChat article after activation');
    assert.ok(feedBodyEntry);
    assert.equal(feedBodyEntry.content_scope, 'feed-body');
    assert.equal(feedBodyEntry.auto_ai_excluded_at, null,
      'future feed-body entries remain eligible after the activation cutoff');
    assert.ok(untrusted.every(([id]) => {
      const entry = entries.find(item => item.id === id);
      return entry && entry.auto_ai_excluded_at === null;
    }), 'the post-cutoff summary/unknown fixture rows remain available but are not selected as full-content input');

    const calls = readAiCalls(aiCapturePath);
    const capturedPrompt = calls.flatMap(call => call.messages || [])
      .map(message => String(message.content || ''))
      .join('\n');
    assert.match(capturedPrompt, /This feed-provided article body remains an excerpt/,
      'the future feed-body control reaches automatic rewriting');
    for (const [id] of untrusted) {
      assert.doesNotMatch(capturedPrompt, new RegExp(`${id.toUpperCase()}_BODY_MUST_NOT_REACH_AUTOMATIC_AI`));
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('historical exclusion survives refresh and restart through the real parent worker chain', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'source-requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-requests.json');
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  const serverEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
    MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
    MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
    SOURCE_CATALOG_FEED_URL: catalogUrl,
    SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
    VERSIONED_TRANSLATION_MODE: 'off',
    AI_PROVIDER: 'openai-compatible',
    AI_PROVIDER_TYPE: 'openai_compatible',
    AI_API_KEY: 'fixture-ai-key',
    AI_BASE_URL: 'https://mock-source-ai.example/v1',
    AI_MODEL: 'mock-model',
  };
  fs.writeFileSync(modePath, 'ok');
  let server = null;
  try {
    server = await startServer(dataDir, serverEnv);
    let cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;
    const initial = readIngestionDatabase(dataDir, sourceId);
    assert.ok(initial.ingestion.activation_completed_at > 0);
    assert.equal(initial.ingestion.platform_account_id, 'MzA1');
    assert.equal(initial.entries.length, 2);
    assert.ok(initial.entries.every(entry => entry.auto_ai_excluded_at === initial.ingestion.activation_cutoff),
      'all initial feed entries, including unknown dates, are durably auto-AI excluded before downstream scheduling');

    fs.writeFileSync(modePath, 'new-historical-1');
    const firstRefresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(firstRefresh.response.status, 200, JSON.stringify(firstRefresh.body));
    const firstIdle = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.ok(firstIdle.fetch.last.refresh.changedEntryCount > 0, 'actual refresh worker reported a changed historical entry');
    assert.equal(firstIdle.ai.last.kind, 'auto-rewrite', 'the parent dispatched its actual post-refresh AI worker');
    let current = readIngestionDatabase(dataDir, sourceId);
    const firstHistorical = current.entries.find(entry => entry.title === 'A historical WeChat article 1');
    assert.ok(firstHistorical);
    assert.equal(firstHistorical.auto_ai_excluded_at, initial.ingestion.activation_cutoff);
    assert.deepEqual(readAiCalls(aiCapturePath), [], 'title and rewrite scans made zero external AI calls after parent scheduling');

    await stopServer(server);
    server = await startServer(dataDir, serverEnv);
    cookie = await adminCookie(server.baseUrl);
    fs.writeFileSync(modePath, 'new-historical-2');
    const restartedRefresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(restartedRefresh.response.status, 200, JSON.stringify(restartedRefresh.body));
    const restartedIdle = await waitForBackgroundIdle(server.baseUrl, cookie);
    assert.ok(restartedIdle.fetch.last.refresh.changedEntryCount > 0);
    assert.equal(restartedIdle.ai.last.kind, 'auto-rewrite');
    current = readIngestionDatabase(dataDir, sourceId);
    const secondHistorical = current.entries.find(entry => entry.title === 'A historical WeChat article 2');
    assert.ok(secondHistorical);
    assert.equal(secondHistorical.auto_ai_excluded_at, initial.ingestion.activation_cutoff,
      'restart and a later refresh cannot reset the original activation cutoff');
    assert.deepEqual(readAiCalls(aiCapturePath), [], 'restarted title/rewrite scans still make no automatic AI calls');

    const initialArticle = current.entries.find(entry => entry.title === 'How product teams validate real user needs');
    const manualTranslation = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(initialArticle.id)}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(manualTranslation.response.status, 200, JSON.stringify(manualTranslation.body));
    assert.equal(readAiCalls(aiCapturePath).length, 1, 'explicit single-entry AI remains available for historical articles');

    fs.writeFileSync(modePath, 'new-future');
    const futureRefresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(futureRefresh.response.status, 200, JSON.stringify(futureRefresh.body));
    await waitForBackgroundIdle(server.baseUrl, cookie);
    current = readIngestionDatabase(dataDir, sourceId);
    const futureEntry = current.entries.find(entry => entry.title === 'A new WeChat article after activation');
    assert.ok(futureEntry);
    assert.ok(futureEntry.published_ts > initial.ingestion.activation_cutoff);
    assert.equal(futureEntry.auto_ai_excluded_at, null, 'a clearly post-cutoff publication keeps ordinary future eligibility');
    assert.ok(readAiCalls(aiCapturePath).length > 1, 'future entries remain eligible for the existing automatic AI path');
    const requests = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests;
    assert.equal(requests.some(request => request.url.includes('mp.weixin.qq.com')), false,
      'initial and refresh ingestion never deep-fetch article pages');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an administrator password changed in the UI survives a server restart', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const changedPassword = 'changed-password-456';
  let server = null;
  try {
    server = await startServer(dataDir);
    const cookie = await adminCookie(server.baseUrl);
    const changed = await jsonRequest(server.baseUrl, '/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        currentPassword: 'test-password-123',
        newPassword: changedPassword,
      }),
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));

    await stopServer(server);
    server = await startServer(dataDir);

    const bootstrapLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    assert.equal(bootstrapLogin.response.status, 401);

    const changedLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: changedPassword }),
    });
    assert.equal(changedLogin.response.status, 200, JSON.stringify(changedLogin.body));
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Namoo creation draft runs through the authenticated API and persists the mock model result', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'mock-ai-request.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-ai-preload.js');
  const entryId = 'namoo-draft-e2e-entry';
  const sourceText = '这是一段用于端到端测试的 AI 资料。'.repeat(80);
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
    openai: {
      fetchedAt: Date.now(),
      feedUrl: 'https://openai.com/news/rss.xml',
      feedTitle: 'OpenAI News',
      status: 'ok',
      error: null,
      entries: [{
        id: entryId,
        sourceId: 'openai',
        title: 'A testable AI creation workflow',
        link: 'https://example.com/ai-workflow',
        author: 'Example Author',
        published: new Date().toISOString(),
        publishedTs: Date.now(),
        summary: sourceText.slice(0, 300),
        content: `<p>${sourceText}</p>`,
      }],
    },
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_AI_CAPTURE_PATH: capturePath,
    });
    const cookie = await adminCookie(server.baseUrl);
    const generated = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/rewrite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-AI-Key': 'mock-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock AI',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-ai.example/v1',
        'X-AI-Model': 'mock-model',
      },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
    assert.match(generated.body.rewrite.body, /## Namoo 风格草稿/);
    assert.match(generated.body.rewrite.body, /\[需要 Namoo 补充：亲自使用后的判断和具体案例\]/);
    assert.match(generated.body.rewrite.body, /\[原文链接\]\(https:\/\/example\.com\/ai-workflow\)/);
    assert.equal(generated.body.rewrite.model, 'mock-model');
    assert.equal(generated.body.rewrite.createdBy, '大月 Namoo');

    const requestPayload = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.match(requestPayload.messages[0].content, /## 为什么值得写/);
    assert.match(requestPayload.messages[0].content, /不得替大月编造第一手观察/);
    assert.match(requestPayload.messages[1].content, /A testable AI creation workflow/);

    await stopServer(server);
    server = await startServer(dataDir, { NODE_OPTIONS: '', MOCK_AI_CAPTURE_PATH: '' });
    const persisted = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/rewrite`);
    assert.equal(persisted.response.status, 200);
    assert.match(persisted.body.rewrite.body, /## 发布前检查/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('off mode preserves legacy translation status, content, asset URLs, and BYOK routing', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'mock-translation-request.json');
  const preloadPath = path.join(dataDir, 'mock-translation-preload.js');
  const entryId = 'legacy-translation-e2e-entry';
  const sourceText = 'A complete English paragraph with enough detail for translation coverage. '.repeat(30);
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
    openai: {
      fetchedAt: Date.now(),
      feedUrl: 'https://openai.com/news/rss.xml',
      feedTitle: 'OpenAI News',
      status: 'ok',
      error: null,
      entries: [{
        id: entryId,
        sourceId: 'openai',
        title: 'Legacy BYOK translation contract',
        link: 'https://example.com/legacy-translation',
        author: 'Example Author',
        published: new Date().toISOString(),
        publishedTs: Date.now(),
        summary: sourceText.slice(0, 300),
        content: `<p>${sourceText}</p>`,
      }],
    },
  }));
  fs.writeFileSync(preloadPath, [
    "const fs = require('fs');",
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init) => {',
    "  const url = String(input && input.url ? input.url : input);",
    "  if (!url.startsWith('https://mock-translation.example/')) return realFetch(input, init);",
    "  const payload = JSON.parse(String(init && init.body || '{}'));",
    "  fs.writeFileSync(process.env.MOCK_TRANSLATION_CAPTURE_PATH, JSON.stringify({ url, payload }));",
    "  const userText = String(payload.messages && payload.messages.at(-1) && payload.messages.at(-1).content || '');",
    "  const indexes = Array.from(userText.matchAll(/^i=(\\d+)$/gm), match => Number(match[1]));",
    "  const content = JSON.stringify({ titleZh: '旧链路翻译契约', summaryZh: '旧摘要', blocks: indexes.map(i => ({ i, target: `译文段落 ${i}`, targetHtml: `<p>译文段落 ${i}</p>` })) });",
    "  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });",
    '};',
  ].join('\n'));

  let server = null;
  try {
    server = await startServer(dataDir, {
      VERSIONED_TRANSLATION_MODE: 'off',
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_TRANSLATION_CAPTURE_PATH: capturePath,
    });
    const cookie = await adminCookie(server.baseUrl);
    const generated = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/translation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-AI-Key': 'browser-owned-test-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock translation provider',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-translation.example/v1',
        'X-AI-Model': 'mock-translation-model',
      },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
    assert.ok(Array.isArray(generated.body.translation.content));
    assert.equal(generated.body.translation.content[0].target, '译文段落 0');
    assert.equal(generated.body.translation.model, 'mock-translation-model');
    assert.match(generated.body.translation.id, /^[0-9a-f-]{36}$/i);

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(captured.url, 'https://mock-translation.example/v1/chat/completions');
    assert.equal(captured.payload.model, 'mock-translation-model');

    const current = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/translation`);
    assert.equal(current.response.status, 200);
    assert.deepEqual(current.body.translation.content, generated.body.translation.content);

    const historical = await jsonRequest(
      server.baseUrl,
      `/api/entry/${entryId}/translation?assetId=${encodeURIComponent(generated.body.translation.id)}`
    );
    assert.equal(historical.response.status, 200);
    assert.equal(historical.body.translation.id, generated.body.translation.id);
    assert.deepEqual(historical.body.translation.content, generated.body.translation.content);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
