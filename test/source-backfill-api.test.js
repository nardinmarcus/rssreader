const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-backfill-preload.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => (err ? reject(err) : resolve(port)));
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
      SOURCE_CATALOG_FEED_URL: 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml',
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
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const res = await fetch(`${baseUrl}/api/sources`);
      if (res.ok) return { child, baseUrl, logs };
    } catch { /* wait */ }
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

async function waitUntil(fn, timeoutMs = 20000, stepMs = 40) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test('real server + refreshWorker + source-backfill-worker: concurrent refresh, cache isolation, zero auto-AI/periodicals, T4 pagination, and no fake progress', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-backfill-e2e-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-requests.json');
  const statePath = path.join(dataDir, 'mock-state.json');
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';

  fs.writeFileSync(statePath, JSON.stringify({
    wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
    wechatArchiveMode: 'slow',
    wechatArchiveComplete: false,
    otherRefreshSeq: 1,
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_BACKFILL_CAPTURE_PATH: capturePath,
      MOCK_BACKFILL_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_BACKFILL_STATE_PATH: statePath,
      SOURCE_BACKFILL_BATCH_SIZE: '25',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '80',
      VERSIONED_TRANSLATION_MODE: 'off',
      PERIODICALS_MODE: 'on',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-backfill-ai.example/v1',
      AI_MODEL: 'mock-model',
    });

    const cookie = await adminCookie(server.baseUrl);
    // Create a second ordinary source to verify refresh progresses while backfill runs
    const otherRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Other Fast Source',
        feedUrl: 'https://other-rss.example/rss.xml',
        category: 'news',
      }),
    });
    assert.equal(otherRes.response.status, 201, JSON.stringify(otherRes.body));
    const otherSourceId = otherRes.body.source.id;
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });

    // Activate WeChat catalog source (85 items + archive page 2 with 25 items)
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;
    assert.equal(activated.body.entryCount, 30, 'latest 30 entries are immediately readable upon activation');

    // Immediately verify latest window is readable while backfill is still running!
    const immediateList = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=50`);
    assert.equal(immediateList.response.status, 200);
    assert.equal(immediateList.body.entries.length, 30);

    // Trigger real refresh on otherSourceId WHILE backfill is running
    fs.writeFileSync(statePath, JSON.stringify({
      wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
      wechatArchiveMode: 'slow',
      otherRefreshSeq: 2,
    }));
    const concurrentRefresh = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId: otherSourceId }),
    });
    assert.equal(concurrentRefresh.response.status, 200);

    // Wait for concurrent refresh to complete while backfill may still be running
    await waitUntil(async () => {
      const entries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(otherSourceId)}&limit=20`);
      return entries.body.entries.some(e => e.title === 'Concurrent Fresh News #2');
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });

    // Wait for backfill worker to finish both snapshot + archive page 2
    const finalStatus = await waitUntil(async () => {
      const { response, body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      if (body.status === 'succeeded' && body.coverage.status === 'available_window') return body;
      if (body.status === 'failed') throw new Error(`backfill failed unexpectedly: ${JSON.stringify(body)}`);
      return null;
    }, 20000);

    assert.equal(finalStatus.coverage.status, 'available_window');
    assert.equal(finalStatus.coverage.hasGap, true);
    assert.equal(finalStatus.coverage.entryCount, 110); // 85 + 25
    assert.equal(finalStatus.counts.cumulativeInsertedCount, 80); // 110 - 30 immediate
    assert.equal(finalStatus.counts.cumulativeReusedCount, 30);

    // Verify T4 pagination reads all 110 entries
    let cursor = '';
    let pagedCount = 0;
    let foundOldest = false;
    while (true) {
      const qs = new URLSearchParams({ limit: '40' });
      if (cursor) qs.set('cursor', cursor);
      const page = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qs.toString()}`);
      assert.equal(page.response.status, 200);
      pagedCount += page.body.entries.length;
      if (page.body.entries.some(e => e.title === 'WeChat Archive Page2 #124')) foundOldest = true;
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(pagedCount, 110);
    assert.equal(foundOldest, true);

    // Verify cache.json was NOT bloated/mutated by backfill
    const cacheJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'cache.json'), 'utf8'));
    assert.equal(cacheJson[sourceId].entries.length, 30, 'cache.json keeps latest 30 window');

    // Verify zero auto-AI for backfilled WeChat entries before and after subsequent scans
    const readAiPromptText = () => {
      try {
        const calls = JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')).calls || [];
        return calls.flatMap(c => c.messages || []).map(m => String(m.content || '')).join('\n');
      } catch {
        return '';
      }
    };
    assert.doesNotMatch(readAiPromptText(), /WeChat Historical|WeChat Archive Page2/, 'backfill itself triggers zero automatic AI for historical entries');

    await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ limit: 50 }),
    });
    await jsonRequest(server.baseUrl, '/api/auto-rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceIds: [sourceId] }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      return !res.body.backgroundJob?.ai?.running;
    });
    assert.doesNotMatch(readAiPromptText(), /WeChat Historical|WeChat Archive Page2/);

    // Verify DB periodical_event_evidence has zero entries from backfilled WeChat historical items
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const excludedNullCount = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE source_id = ? AND auto_ai_excluded_at IS NULL').get(sourceId).c;
      assert.equal(excludedNullCount, 0);
      const periodicalCount = db.prepare(`
        SELECT COUNT(*) AS c FROM periodical_event_evidence pe
        JOIN entries e ON e.id = pe.entry_id
        WHERE e.source_id = ?
      `).get(sourceId).c;
      assert.equal(periodicalCount, 0);
    } finally {
      db.close();
    }

    // Normal refresh with NO new items must NOT create a fake backfill run
    const runIdBeforeRefresh = finalStatus.run.id;
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const statusAfterNoopRefresh = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      headers: { Cookie: cookie },
    });
    assert.equal(statusAfterNoopRefresh.body.run.id, runIdBeforeRefresh, 'no new input creates no fake backfill run');

    // Normal refresh discovering 10 newly surfaced older items DOES create a new backfill run
    fs.writeFileSync(statePath, JSON.stringify({
      wechatNextUrl: '',
      wechatExtraOlderCount: 10,
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    const afterNewDiscovery = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      if (body.run && body.run.id !== runIdBeforeRefresh && body.status === 'succeeded') return body;
      return null;
    }, 15000);
    assert.equal(afterNewDiscovery.coverage.entryCount, 120);
    assert.equal(afterNewDiscovery.counts.insertedCount, 10);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('security/privacy seam, pause/resume/retry lifecycle, 429/5xx/permanent failure, size/SSRF bounds, and crash recovery', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-backfill-sec-');
  const statePath = path.join(dataDir, 'mock-state.json');
  const faultPath = path.join(dataDir, 'fault.json');

  // Inject one pre-tx worker crash and ensure real server recovery resumes cleanly
  fs.writeFileSync(statePath, JSON.stringify({
    podcastArchiveResponses: ['429', '503', '503', '503'], // 1 initial + 3 retries -> fails, then manual retry succeeds!
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_BACKFILL_STATE_PATH: statePath,
      SOURCE_BACKFILL_RETRY_BASE_MS: '40',
      SOURCE_BACKFILL_BATCH_SIZE: '5',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '20',
    });

    const cookie = await adminCookie(server.baseUrl);
    const readerReg = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reader-bf@example.com', password: 'reader-password-123', displayName: 'Reader' }),
    });
    const readerCookie = String(readerReg.response.headers.get('set-cookie') || '').split(';')[0];

    const created = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Podcast Fixture',
        feedUrl: 'https://podcast-rss.example/rss.xml',
        category: 'podcast',
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const sourceId = created.body.source.id;

    // Wait for archive-2.xml to exhaust 3 retries after 429 + 503s -> failed
    const failedStatus = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      return body.status === 'failed' ? body : null;
    }, 15000);
    assert.equal(failedStatus.run.retryCount, 3);
    assert.ok(failedStatus.error && failedStatus.error.message);
    assert.equal(failedStatus.coverage.entryCount, 10, 'already-fetched 10 items from page 1 remain preserved');
    assert.deepEqual(failedStatus.availableActions, ['retry']);

    // Security/privacy checks: guest & reader blocked from admin endpoints; /api/sources hides internals
    for (const authHeaders of [{}, { Cookie: readerCookie }]) {
      const g = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, { headers: authHeaders });
      assert.equal(g.response.status, 403);
      const p = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'retry' }),
      });
      assert.equal(p.response.status, 403);
      const pub = await jsonRequest(server.baseUrl, '/api/sources', { headers: authHeaders });
      const pubSrc = pub.body.sources.find(s => s.id === sourceId);
      assert.ok(pubSrc && pubSrc.coverage);
      assert.equal(Object.hasOwn(pubSrc, 'backfill'), false);
      assert.equal(Object.hasOwn(pubSrc.coverage, 'runToken'), false);
      assert.equal(Object.hasOwn(pubSrc.coverage, 'leaseExpiresAt'), false);
      assert.equal(Object.hasOwn(pubSrc.coverage, 'error'), false);
      assert.equal(Object.hasOwn(pubSrc, 'feedUrl'), false);
    }

    // Disallowed fields & invalid state transitions rejected
    const badFields = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'retry', url: 'https://evil.example', cursor: '1', kind: 'x' }),
    });
    assert.equal(badFields.response.status, 400);
    const badPause = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(badPause.response.status, 409);

    // Oversize (>5 MiB) and SSRF redirect fail permanently without retries
    fs.writeFileSync(statePath, JSON.stringify({ podcastArchiveResponses: ['oversize'] }));
    await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'retry' }),
    });
    const oversizeFail = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      return body.status === 'failed' ? body : null;
    });
    assert.equal(oversizeFail.error.code, 'ERR_BACKFILL_TOO_LARGE');
    assert.equal(oversizeFail.run.retryCount, 0);

    fs.writeFileSync(statePath, JSON.stringify({ podcastArchiveResponses: ['ssrf'] }));
    await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'retry' }),
    });
    const ssrfFail = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      return body.status === 'failed' ? body : null;
    });
    assert.equal(ssrfFail.error.code, 'ERR_BACKFILL_SSRF_BLOCKED');

    // Restart server with child-process pre-tx crash injection + manual retry -> recovers & finishes with provider_archive_exhausted + audio enclosure!
    await stopServer(server);
    fs.writeFileSync(statePath, JSON.stringify({ podcastArchiveResponses: [] }));
    fs.writeFileSync(faultPath, JSON.stringify({ phase: 'pre-tx', mode: 'exit', exitCode: 1 }));
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_BACKFILL_STATE_PATH: statePath,
      SOURCE_BACKFILL_FAULT_FILE: faultPath,
      SOURCE_BACKFILL_RETRY_BASE_MS: '40',
      SOURCE_BACKFILL_BATCH_SIZE: '5',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '20',
    });
    const cookie2 = await adminCookie(server.baseUrl);
    const manualRetry = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ action: 'retry' }),
    });
    assert.equal(manualRetry.response.status, 200);

    // Wait until the pre-tx fault fired, then arm a post-commit-pre-ack exit fault across parent restart
    await waitUntil(async () => {
      try { return JSON.parse(fs.readFileSync(faultPath, 'utf8')).triggered === true; } catch { return false; }
    });
    const recoveredMid = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie2 },
      });
      return body.counts.processedCount >= 5 ? body : null;
    });
    assert.ok(recoveredMid.counts.processedCount >= 5);

    if (recoveredMid.status !== 'succeeded') {
      fs.writeFileSync(faultPath, JSON.stringify({ phase: 'post-commit-pre-ack', mode: 'exit', exitCode: 1 }));
    }
    const recovered = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie2 },
      });
      return body.status === 'succeeded' ? body : null;
    }, 15000);
    assert.equal(recovered.coverage.status, 'provider_archive_exhausted');
    assert.equal(recovered.coverage.hasGap, false);
    assert.equal(recovered.coverage.entryCount, 25);

    const historyPage = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=30`);
    assert.equal(historyPage.body.entries.length, 25);
    assert.deepEqual(historyPage.body.entries[24].audio, { url: 'https://cdn.podcast-rss.example/ep-34.mp3', type: 'audio/mpeg' });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('real HTTP pause and resume actions control active source-backfill-worker cleanly', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-backfill-pause-resume-');
  const statePath = path.join(dataDir, 'mock-state.json');
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  fs.writeFileSync(statePath, JSON.stringify({
    wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
    wechatArchiveMode: 'slow',
  }));
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_BACKFILL_STATE_PATH: statePath,
      SOURCE_BACKFILL_BATCH_SIZE: '10',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '120',
    });
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;

    // Wait until backfill is running or queued, then pause via real HTTP endpoint
    await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      return ['queued', 'running'].includes(body.status) ? body : null;
    });
    const paused = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(paused.response.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.status, 'paused');
    assert.deepEqual(paused.body.availableActions, ['resume']);

    const processedAtPause = paused.body.counts.processedCount;
    await new Promise(resolve => setTimeout(resolve, 250));
    const stayedPaused = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      headers: { Cookie: cookie },
    });
    assert.equal(stayedPaused.body.status, 'paused');
    assert.equal(stayedPaused.body.counts.processedCount, processedAtPause, 'paused run stops advancing');

    // Resume via real HTTP endpoint -> worker finishes
    const resumed = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(resumed.response.status, 200);
    assert.ok(['queued', 'running', 'succeeded'].includes(resumed.body.status));

    const done = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: cookie },
      });
      return body.status === 'succeeded' && body.coverage.entryCount === 110 ? body : null;
    }, 15000);
    assert.equal(done.coverage.entryCount, 110);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
