const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
const CATALOG_URL = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
const WECHAT_KEY = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
const SECOND_WECHAT_KEY = 'wechat:1e0ac39f8952b2e7f0807313cf2633d25078a171';
const THIRD_WECHAT_KEY = 'wechat:6535a444e9651fecae3383363be7589acdebe2b6';
const FOURTH_WECHAT_KEY = 'wechat:39fc51b0b1316137e608c45da5dbbca4f9eb9538';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
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
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
      COOKIE_SECURE: '0',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: CATALOG_URL,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/sources`);
      if (response.ok) {
        return {
          child,
          baseUrl,
          logs,
          async stop() {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await Promise.race([
              new Promise(resolve => child.once('exit', resolve)),
              new Promise(resolve => setTimeout(resolve, 2000)),
            ]);
            if (child.exitCode === null) child.kill('SIGKILL');
          },
        };
      }
    } catch {
      // retry until ready
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function loginCookie(baseUrl, email, password) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function registerReader(baseUrl, email, displayName) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reader-password-123', displayName }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    user: body.user,
    cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
  };
}

function readCapture(capturePath) {
  try {
    return JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests || [];
  } catch {
    return [];
  }
}

test('source request lifecycle: auth, server catalog resolution, privacy isolation, approval into shared reading, and zero auto-AI', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-req-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');
  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
      MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH: aiCapturePath,
      DEEPSEEK_API_KEY: 'site-mock-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    });

    // 1. Anonymous user gets 401 on request creation and private list.
    const anonRequest = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'guest attempt' }),
    });
    assert.equal(anonRequest.response.status, 401);
    const anonList = await jsonRequest(server.baseUrl, '/api/me/source-requests');
    assert.equal(anonList.response.status, 401);

    // 2. Register two readers and verify catalog snapshot is fetched once without per-account fetches.
    const readerA = await registerReader(server.baseUrl, 'reader-a@example.com', 'Reader A');
    const readerB = await registerReader(server.baseUrl, 'reader-b@example.com', 'Reader B');

    // Invalid / unsupported catalog keys are rejected cleanly.
    const badKey = await jsonRequest(server.baseUrl, '/api/source-catalog/not-a-valid-key/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(badKey.response.status, 400);

    const missingKey = await jsonRequest(server.baseUrl, '/api/source-catalog/wechat:missing123456/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(missingKey.response.status, 404);

    const unsupportedPodcast = await jsonRequest(server.baseUrl, '/api/source-catalog/podcast:42zhangjing/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(unsupportedPodcast.response.status, 422);

    const onlinePodcast = await jsonRequest(server.baseUrl, '/api/source-catalog/podcast:xiaojun-shangye-fangtanlu/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(onlinePodcast.response.status, 409);

    // 3. Reader A submits a source request; forged fields are ignored, no feed fetch occurs.
    const createdA = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({
        note: '想订阅人人都是产品经理',
        feedUrl: 'http://127.0.0.1:1/forged.xml',
        status: 'approved',
        requestKind: 'link',
        sourceId: 'forged-source',
      }),
    });
    assert.equal(createdA.response.status, 202, JSON.stringify(createdA.body));
    assert.equal(createdA.body.pending, true);
    assert.equal(createdA.body.request.requestKind, 'source');
    assert.equal(createdA.body.request.catalogKey, WECHAT_KEY);
    assert.equal(createdA.body.request.platform, 'wechat');
    assert.equal(createdA.body.request.name, '人人都是产品经理');
    assert.equal(createdA.body.request.status, 'pending');
    assert.equal(createdA.body.request.note, '想订阅人人都是产品经理');
    assert.equal(createdA.body.request.sourceId, '');
    assert.equal(JSON.stringify(createdA.body).includes('wechat2rss.bestblogs.dev/feed/'), false);
    assert.equal(JSON.stringify(createdA.body).includes('forged.xml'), false);

    // Zero supplier feed fetches on request creation.
    const requestsAfterCreate = readCapture(capturePath);
    assert.equal(requestsAfterCreate.filter(r => r.url.includes('wechat2rss.bestblogs.dev')).length, 0);

    // 4. Duplicate request by Reader A returns the existing request without duplicating.
    const dupA = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ note: '重复点击' }),
    });
    assert.equal(dupA.response.status, 200, JSON.stringify(dupA.body));
    assert.equal(dupA.body.existing, true);
    assert.equal(dupA.body.request.id, createdA.body.request.id);

    // 5. Reader B submits a separate request for the same catalog key.
    const createdB = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerB.cookie },
      body: JSON.stringify({ note: 'Reader B note' }),
    });
    assert.equal(createdB.response.status, 202, JSON.stringify(createdB.body));
    assert.notEqual(createdB.body.request.id, createdA.body.request.id);

    // 6. Privacy isolation: Reader A and Reader B only see their own requests; public catalog leaks nothing.
    const listA = await jsonRequest(server.baseUrl, '/api/me/source-requests', { headers: { Cookie: readerA.cookie } });
    const listB = await jsonRequest(server.baseUrl, '/api/me/source-requests', { headers: { Cookie: readerB.cookie } });
    assert.equal(listA.response.status, 200);
    assert.equal(listA.response.headers.get('cache-control'), 'no-store');
    assert.equal(listA.body.requests.length, 1);
    assert.equal(listA.body.requests[0].note, '想订阅人人都是产品经理');
    assert.equal(listB.body.requests.length, 1);
    assert.equal(listB.body.requests[0].note, 'Reader B note');
    assert.equal(JSON.stringify(listB.body).includes('想订阅人人都是产品经理'), false);

    const publicCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const serializedCatalog = JSON.stringify(publicCatalog.body);
    assert.equal(serializedCatalog.includes('想订阅人人都是产品经理'), false);
    assert.equal(serializedCatalog.includes('Reader B note'), false);
    assert.equal(serializedCatalog.includes('reader-a@example.com'), false);
    const catalogEntry = publicCatalog.body.items.find(item => item.key === WECHAT_KEY);
    assert.equal(catalogEntry.online, false);

    // 7. Ordinary reader cannot approve, reject, list moderation queue, or activate sources.
    const readerApprove = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${createdA.body.request.id}/approve`, {
      method: 'POST',
      headers: { Cookie: readerA.cookie },
    });
    assert.equal(readerApprove.response.status, 403);
    const readerQueue = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=pending', {
      headers: { Cookie: readerA.cookie },
    });
    assert.equal(readerQueue.response.status, 403);

    // 8. Admin approves Reader A and Reader B requests concurrently -> single Custom Source, both requests approved.
    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const adminQueue = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=pending', {
      headers: { Cookie: admin },
    });
    assert.equal(adminQueue.response.status, 200);
    assert.equal(adminQueue.body.requests.length, 2);
    assert.ok(adminQueue.body.requests.every(r => r.requestKind === 'source' && r.catalogKey === WECHAT_KEY));
    assert.equal(JSON.stringify(adminQueue.body).includes('wechat2rss.bestblogs.dev/feed/'), false);

    const [approvedA, approvedB] = await Promise.all([
      jsonRequest(server.baseUrl, `/api/admin/submission-requests/${createdA.body.request.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
      jsonRequest(server.baseUrl, `/api/admin/submission-requests/${createdB.body.request.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
    ]);
    assert.equal(approvedA.response.status, 200, JSON.stringify(approvedA.body));
    assert.equal(approvedB.response.status, 200, JSON.stringify(approvedB.body));
    assert.equal(approvedA.body.resultType, 'source');
    assert.equal(approvedA.body.entry, null);
    assert.equal(approvedA.body.request.status, 'approved');
    assert.equal(approvedB.body.request.status, 'approved');
    assert.equal(approvedA.body.source.id, approvedB.body.source.id);
    const sourceId = approvedA.body.source.id;
    assert.match(sourceId, /^custom-/);
    assert.equal(approvedA.body.request.sourceId, sourceId);
    assert.equal(approvedB.body.request.sourceId, sourceId);

    // Response-lost retry on approved request is idempotent and performs no extra fetch.
    const fetchesBeforeRetry = readCapture(capturePath).filter(r => r.url.includes('wechat2rss.bestblogs.dev')).length;
    assert.equal(fetchesBeforeRetry, 1, 'concurrent approvals share one supplier fetch');
    const retriedApprove = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${createdA.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(retriedApprove.response.status, 200);
    assert.equal(retriedApprove.body.source.id, sourceId);
    assert.equal(readCapture(capturePath).filter(r => r.url.includes('wechat2rss.bestblogs.dev')).length, 1);

    // 9. Shared reading works immediately and zero automatic AI was triggered.
    const onlineCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const onlineItem = onlineCatalog.body.items.find(item => item.key === WECHAT_KEY);
    assert.equal(onlineItem.online, true);
    assert.equal(onlineItem.sourceId, sourceId);

    const listedEntries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    assert.equal(listedEntries.response.status, 200);
    assert.equal(listedEntries.body.entries.length, 2);
    assert.ok(listedEntries.body.entries.every(entry => !Object.hasOwn(entry, 'autoAiExcludedAt')));

    const firstEntry = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(listedEntries.body.entries[0].id)}`);
    assert.equal(firstEntry.response.status, 200);
    assert.match(firstEntry.body.entry.content, /Feed-provided article body excerpt/);
    assert.equal(fs.existsSync(aiCapturePath), false, 'approval must not trigger automatic AI calls');

    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const ingestion = db.prepare('SELECT activation_cutoff, platform_account_id FROM source_ingestion_sources WHERE source_id = ?').get(sourceId);
      assert.ok(ingestion && ingestion.activation_cutoff > 0);
      assert.equal(ingestion.platform_account_id, 'MzA1');
      const rows = db.prepare('SELECT auto_ai_excluded_at FROM entries WHERE source_id = ?').all(sourceId);
      assert.ok(rows.length === 2 && rows.every(r => r.auto_ai_excluded_at === ingestion.activation_cutoff));
      const sourcesCount = db.prepare('SELECT COUNT(*) AS count FROM custom_sources').get().count;
      assert.equal(sourcesCount, 1);
    } finally {
      db.close();
    }

    // User-submitted source must not leak into user-submitted article feed.
    const userSubmitted = await jsonRequest(server.baseUrl, '/api/entries?source=user-submitted&limit=20');
    assert.equal(userSubmitted.body.entries.length, 0);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('concurrent approve and direct admin activation converge to one Custom Source and record request outcome', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-req-race-');
  const capturePath = path.join(dataDir, 'requests.json');
  let server = null;
  try {
    server = await startServer(dataDir, { MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath });
    const reader = await registerReader(server.baseUrl, 'race-reader@example.com', 'Race Reader');
    const requested = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(requested.response.status, 202);
    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');

    const [directActivation, requestApproval] = await Promise.all([
      jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(WECHAT_KEY)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
      jsonRequest(server.baseUrl, `/api/admin/submission-requests/${requested.body.request.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
    ]);
    assert.ok([200, 201].includes(directActivation.response.status), JSON.stringify(directActivation.body));
    assert.equal(requestApproval.response.status, 200, JSON.stringify(requestApproval.body));
    assert.equal(requestApproval.body.source.id, directActivation.body.source.id);
    assert.equal(requestApproval.body.request.status, 'approved');
    assert.equal(requestApproval.body.request.sourceId, directActivation.body.source.id);
    assert.equal(readCapture(capturePath).filter(r => r.url.includes('wechat2rss.bestblogs.dev')).length, 1);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('supplier failures do not degrade source requests to single-article entries and stay retryable until recovery', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-req-fail-');
  const modePath = path.join(dataDir, 'mode.txt');
  fs.writeFileSync(modePath, 'html');
  let server = null;
  try {
    server = await startServer(dataDir, { MOCK_SOURCE_INGESTION_MODE_PATH: modePath });
    const reader = await registerReader(server.baseUrl, 'fail-reader@example.com', 'Fail Reader');
    const created = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ note: '请审核' }),
    });
    assert.equal(created.response.status, 202);
    const requestId = created.body.request.id;
    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');

    for (const [mode, expectedStatus] of [
      ['html', 422],
      ['empty', 422],
      ['wrong-account', 422],
      ['supplier-403', 403],
      ['supplier-timeout', 504],
    ]) {
      fs.writeFileSync(modePath, mode);
      const failed = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(failed.response.status, expectedStatus, `${mode}: ${JSON.stringify(failed.body)}`);
      if (expectedStatus >= 500) {
        assert.match(failed.body.error, /超时|暂时失败/);
      }

      // Request remains pending and catalog remains offline; no single-article fallback.
      const myRequests = await jsonRequest(server.baseUrl, '/api/me/source-requests', { headers: { Cookie: reader.cookie } });
      assert.equal(myRequests.body.requests[0].status, 'pending');
      assert.equal(myRequests.body.requests[0].sourceId, '');
      const catalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
      assert.equal(catalog.body.items.find(i => i.key === WECHAT_KEY).online, false);
      const pendingQueue = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=pending', {
        headers: { Cookie: admin },
      });
      const pendingItem = pendingQueue.body.requests.find(r => r.id === requestId);
      assert.ok(pendingItem, `${mode} must keep request in pending queue`);
      assert.ok(pendingItem.lastError, `${mode} should record safe retryable error for admin`);
      const userSubmitted = await jsonRequest(server.baseUrl, '/api/entries?source=user-submitted&limit=20');
      assert.equal(userSubmitted.body.entries.length, 0);
    }

    // Recover supplier -> retry approval succeeds and clears lastError.
    fs.writeFileSync(modePath, 'ok');
    const recovered = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.request.status, 'approved');
    assert.equal(recovered.body.request.lastError, '');
    assert.match(recovered.body.source.id, /^custom-/);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('archive restore, identity guard, soft-delete protection, rate limits, reject flow, and generic link submissions remain intact', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-req-protect-');
  const modePath = path.join(dataDir, 'mode.txt');
  fs.writeFileSync(modePath, 'ok');
  let server = null;
  try {
    server = await startServer(dataDir, { MOCK_SOURCE_INGESTION_MODE_PATH: modePath });
    const reader1 = await registerReader(server.baseUrl, 'prot1@example.com', 'Prot 1');
    const reader2 = await registerReader(server.baseUrl, 'prot2@example.com', 'Prot 2');
    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');

    // Approve first request and archive the source + soft-delete one entry.
    const req1 = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader1.cookie },
      body: JSON.stringify({}),
    });
    const app1 = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${req1.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    const sourceId = app1.body.source.id;
    const entriesBefore = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    const deletedEntryId = entriesBefore.body.entries[0].id;
    const delEntry = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(deletedEntryId)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(delEntry.response.status, 200);
    const archived = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(archived.response.status, 200);

    // Reader 2 requests the archived source; explicit restore is required on approval, and identity mismatch is blocked.
    const req2 = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader2.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(req2.response.status, 202);
    const deniedWithoutRestore = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${req2.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(deniedWithoutRestore.response.status, 409);

    fs.writeFileSync(modePath, 'account-changed');
    const identityMismatch = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${req2.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ restore: true }),
    });
    assert.equal(identityMismatch.response.status, 409);

    fs.writeFileSync(modePath, 'ok');
    const restoredApproval = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${req2.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ restore: true }),
    });
    assert.equal(restoredApproval.response.status, 200, JSON.stringify(restoredApproval.body));
    assert.equal(restoredApproval.body.source.id, sourceId);
    assert.equal(restoredApproval.body.request.status, 'approved');
    assert.equal(restoredApproval.body.request.sourceId, sourceId);

    // Soft-deleted entry stays deleted.
    const entriesAfterRestore = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=20`);
    assert.equal(entriesAfterRestore.body.entries.length, 1);
    const deletedCheck = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(deletedEntryId)}`);
    assert.equal(deletedCheck.response.status, 404);

    // Reject flow works without fetching feed.
    const reqReject = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(SECOND_WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader2.cookie },
      body: JSON.stringify({ note: 'reject me' }),
    });
    assert.equal(reqReject.response.status, 202);
    const rejected = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${reqReject.body.request.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ reason: '暂不接入该公众号' }),
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.request.status, 'rejected');
    assert.equal(rejected.body.request.reviewReason, '暂不接入该公众号');

    // Rate limit and pending cap (3 pending requests per user + hourly 6 limit).
    const rateReader = await registerReader(server.baseUrl, 'rate@example.com', 'Rate Reader');
    const keys = [SECOND_WECHAT_KEY, THIRD_WECHAT_KEY, FOURTH_WECHAT_KEY];
    for (const key of keys) {
      const res = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(key)}/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rateReader.cookie },
        body: JSON.stringify({}),
      });
      assert.equal(res.response.status, 202, JSON.stringify(res.body));
    }
    // 4th distinct pending item hits the 3-pending cap (429).
    const catalogPage = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=wechat');
    const extraKey = catalogPage.body.items.find(item => !keys.includes(item.key) && !item.online).key;
    const fourthPending = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(extraKey)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rateReader.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(fourthPending.response.status, 429);

    // Repeating an existing request hits the shared hourly rate limiter after 6 total calls.
    const fifth = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(SECOND_WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rateReader.cookie },
      body: JSON.stringify({}),
    });
    const sixth = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(SECOND_WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rateReader.cookie },
      body: JSON.stringify({}),
    });
    const seventh = await jsonRequest(server.baseUrl, '/api/submit-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rateReader.cookie },
      body: JSON.stringify({ url: 'https://pending.invalid/articles/rate-check' }),
    });
    assert.deepEqual([fifth.response.status, sixth.response.status, seventh.response.status], [200, 200, 429]);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('discovery and moderation UI helpers render request states, error recovery, and keep offline items truthful', () => {
  const vm = require('node:vm');
  const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const extractFn = (name) => {
    const start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `expected ${name}()`);
    const bodyStart = appSource.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < appSource.length; i += 1) {
      if (appSource[i] === '{') depth += 1;
      if (appSource[i] === '}') depth -= 1;
      if (depth === 0) return appSource.slice(start, i + 1);
    }
    throw new Error(`unclosed ${name}()`);
  };
  const escapeHtml = value => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const context = {
    discoveryState: {
      activatingKey: '',
      requestingKey: '',
      myRequests: [
        { catalogKey: 'wechat:pending123', status: 'pending' },
        { catalogKey: 'wechat:rejected123', status: 'rejected', reviewReason: '暂不支持' },
        { catalogKey: 'wechat:archived123', status: 'approved' },
      ],
    },
    isAdmin: () => false,
    escapeHtml,
    moderationTime: () => '刚刚',
  };
  vm.createContext(context);
  vm.runInContext(`${extractFn('discoveryEntryHtml')}\n${extractFn('moderationRequestItemHtml')}`, context);

  const pendingHtml = context.discoveryEntryHtml({ key: 'wechat:pending123', platform: 'wechat', name: '待审号', online: false });
  assert.match(pendingHtml, /已申请/);
  assert.match(pendingHtml, /disabled/);
  assert.doesNotMatch(pendingHtml, /已上线|已接入/);

  const rejectedHtml = context.discoveryEntryHtml({ key: 'wechat:rejected123', platform: 'wechat', name: '拒绝号', online: false });
  assert.match(rejectedHtml, /未通过/);
  assert.match(rejectedHtml, /暂不支持/);
  assert.doesNotMatch(rejectedHtml, /已上线|已接入/);

  const archivedApprovedHtml = context.discoveryEntryHtml({ key: 'wechat:archived123', platform: 'wechat', name: '归档号', online: false });
  assert.match(archivedApprovedHtml, /未接入/);
  assert.doesNotMatch(archivedApprovedHtml, /已上线|已接入/);

  const modHtml = context.moderationRequestItemHtml({
    id: 'req-1',
    requestKind: 'source',
    catalogKey: 'wechat:pending123',
    catalogPlatform: 'wechat',
    catalogName: '待审号',
    userId: 'u-1',
    displayName: 'Reader',
    email: 'reader@example.com',
    note: '请接入',
    createdAt: Date.now(),
  }, '供给方拒绝读取该公众号订阅源，请核对目录条目后重试。');
  assert.match(modHtml, /来源接入申请/);
  assert.match(modHtml, /待审号/);
  assert.match(modHtml, /接入失败（可重试）/);
  assert.match(modHtml, /重试批准/);
  assert.doesNotMatch(modHtml, /<a href="catalog:/);
});
