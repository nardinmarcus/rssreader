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

test('activation reconciles a legacy manual feed source without changing its identity or reader associations', { timeout: 45000 }, async () => {
  const dataDir = createTempDataDir();
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
    const current = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
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
