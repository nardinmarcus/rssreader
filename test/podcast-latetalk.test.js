const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const appFunctions = require('./helpers/workspace-app');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-podcast-latetalk-preload.js');
const CATALOG_URL = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
const LATETALK_KEY = 'podcast:wandianliao';
const LATETALK_PID = '61933ace1b4320461e91fd55';
const OFFICIAL_RSS_URL = 'https://podcast.latepost.com/rss';
const FIRESIDE_RSS_URL = 'https://feeds.fireside.fm/latetalk/rss';

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
      SOURCE_CATALOG_FEED_URL: CATALOG_URL,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
      COOKIE_SECURE: '0',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      NODE_OPTIONS: `--require=${preloadPath}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const res = await fetch(`${baseUrl}/api/sources`);
      if (res.ok) return { child, baseUrl, logs };
    } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 40));
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

async function waitUntil(fn, timeoutMs = 20000, stepMs = 40) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function readCapturedRequests(capturePath) {
  try {
    return JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests || [];
  } catch {
    return [];
  }
}

function readAiCalls(aiCapturePath) {
  try {
    return JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')).calls || [];
  } catch {
    return [];
  }
}

test('LateTalk official redirect chain, SSRF/identity rejection, client URL pinning, and discovery isolation', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-latetalk-sec-');
  const statePath = path.join(dataDir, 'mock-state.json');
  const capturePath = path.join(dataDir, 'requests.json');
  fs.writeFileSync(statePath, JSON.stringify({
    redirectMode: 'official',
    feedMode: 'normal',
    xiaoyuzhouMode: 'unavailable',
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_LATETALK_STATE_PATH: statePath,
      MOCK_LATETALK_CAPTURE_PATH: capturePath,
    });
    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');

    // Public catalog keeps LateTalk offline by default, leaks no feed URLs or PIDs, and leaves T6/T8 unactivated.
    const pubCat = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=podcast');
    assert.equal(pubCat.response.status, 200);
    const latetalkPub = pubCat.body.recommended.find(s => s.key === LATETALK_KEY);
    assert.ok(latetalkPub);
    assert.equal(latetalkPub.online, false);
    assert.equal(JSON.stringify(pubCat.body).includes(OFFICIAL_RSS_URL), false);
    assert.equal(JSON.stringify(pubCat.body).includes(FIRESIDE_RSS_URL), false);
    assert.equal(JSON.stringify(pubCat.body).includes(LATETALK_PID), false);

    // Admin catalog exposes activatable on verified podcast shows (not unconfigured T6).
    const adminCat = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=podcast', {
      headers: { Cookie: admin },
    });
    const adminByKey = new Map(adminCat.body.recommended.map(s => [s.key, s]));
    assert.equal(adminByKey.get(LATETALK_KEY).activatable, true);
    const fortyTwoAdmin = adminByKey.get('xiaoyuzhou:648b0b641c48983391a63f98') || adminByKey.get('podcast:42zhangjing');
    assert.ok(fortyTwoAdmin);
    assert.equal(fortyTwoAdmin.online, false);
    assert.equal(fortyTwoAdmin.activatable, true);
    const bannatieAdmin = adminByKey.get('xiaoyuzhou:62382c1103bea1ebfffa1c00') || adminByKey.get('podcast:bannatie');
    assert.ok(bannatieAdmin);
    assert.equal(bannatieAdmin.online, false);

    // 1. Private loopback redirect hop is rejected by SSRF check before contacting 127.0.0.1.
    fs.writeFileSync(statePath, JSON.stringify({ redirectMode: 'private-hop', feedMode: 'normal' }));
    const privateFail = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(privateFail.response.status, 400);
    assert.equal(readCapturedRequests(capturePath).some(r => r.url.includes('127.0.0.1:1')), false);

    // 2. LAN redirect hop is rejected.
    fs.writeFileSync(statePath, JSON.stringify({ redirectMode: 'lan-hop', feedMode: 'normal' }));
    const lanFail = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(lanFail.response.status, 400);
    assert.equal(readCapturedRequests(capturePath).some(r => r.url.includes('10.0.0.5')), false);

    // 3. Unverified external host redirect is rejected as identity/redirect mismatch.
    fs.writeFileSync(statePath, JSON.stringify({ redirectMode: 'unverified-host', feedMode: 'normal' }));
    const hostFail = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(hostFail.response.status, 422);

    // 4. Wrong channel title is rejected even on valid redirect chain.
    fs.writeFileSync(statePath, JSON.stringify({ redirectMode: 'official', feedMode: 'wrong-title' }));
    const titleFail = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(titleFail.response.status, 422);

    // 4b. Unavailable sampled audio enclosure blocks activation without putting the show online.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'normal',
      baseCount: 15,
      audioMode: 'unavailable',
    }));
    const audioFail = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(audioFail.response.status, 422);
    const stillOfflineCat = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=podcast');
    assert.equal(stillOfflineCat.body.recommended.find(s => s.key === LATETALK_KEY).online, false);

    // 5. Valid redirect chain succeeds even if client tries to pass a forged feedUrl in body; server pins official entry URL.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'normal',
      baseCount: 15,
      xiaoyuzhouMode: 'unavailable',
    }));
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(LATETALK_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ feedUrl: 'https://evil.example/forged.xml', name: 'Forged Show' }),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;
    assert.equal(activated.body.source.name, '晚点聊');
    assert.equal(activated.body.source.category, 'podcast');
    assert.deepEqual(activated.body.source.feeds, [OFFICIAL_RSS_URL]);

    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const cs = db.prepare('SELECT feed_url FROM custom_sources WHERE id = ?').get(sourceId);
      assert.equal(cs.feed_url, OFFICIAL_RSS_URL);
      const ing = db.prepare('SELECT feed_url, resolved_feed_url, platform_account_id FROM source_ingestion_sources WHERE source_id = ?').get(sourceId);
      assert.equal(ing.feed_url, OFFICIAL_RSS_URL);
      assert.equal(ing.resolved_feed_url, FIRESIDE_RSS_URL);
      assert.equal(ing.platform_account_id, `xiaoyuzhou:${LATETALK_PID}`);
    } finally {
      db.close();
    }

    // Verify redirect hops were followed in outbound requests.
    const captured = readCapturedRequests(capturePath).map(r => r.url);
    assert.ok(captured.includes(OFFICIAL_RSS_URL));
    assert.ok(captured.includes(FIRESIDE_RSS_URL));

    // 6. Client cannot replace feedUrl via PATCH /api/sources/:id.
    const patchAttempt = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ feedUrl: 'https://evil.example/replaced.xml' }),
    });
    assert.equal(patchAttempt.response.status, 409);

    // 7. POST /api/sources with official or fireside URL routes through verified activation idempotently (never creating duplicate source).
    const postDup = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: 'Custom Override', feedUrl: FIRESIDE_RSS_URL, category: 'article' }),
    });
    assert.equal(postDup.response.status, 200);
    assert.equal(postDup.body.alreadyActivated, true);
    assert.equal(postDup.body.source.id, sourceId);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('LateTalk reader request -> admin approval, T5 backfill, T4 pagination, unknown/mismatch coverage, GUID dedup, feed +/-, AI exclusion, restart, and failure isolation', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-latetalk-e2e-');
  const statePath = path.join(dataDir, 'mock-state.json');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');

  // Start in Xiaoyuzhou unavailable mode (`unknown` scope) with 65 episodes (> 30 immediate window).
  fs.writeFileSync(statePath, JSON.stringify({
    redirectMode: 'official',
    feedMode: 'normal',
    baseCount: 65,
    xiaoyuzhouMode: 'unavailable',
    otherSeq: 1,
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_LATETALK_STATE_PATH: statePath,
      MOCK_LATETALK_CAPTURE_PATH: capturePath,
      MOCK_LATETALK_AI_CAPTURE_PATH: aiCapturePath,
      SOURCE_BACKFILL_BATCH_SIZE: '20',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '30',
      PERIODICALS_MODE: 'on',
      VERSIONED_TRANSLATION_MODE: 'off',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-latetalk-ai.example/v1',
      AI_MODEL: 'mock-model',
    });

    const admin = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const reader = await registerReader(server.baseUrl, 'reader-lt@example.com', 'Listener');

    // Create a second healthy source to verify failure isolation later.
    const healthyRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: 'Other Healthy News', feedUrl: 'https://other-healthy.example/rss.xml', category: 'news' }),
    });
    assert.equal(healthyRes.response.status, 201);
    const healthySourceId = healthyRes.body.source.id;
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });

    // 1. Reader requests LateTalk via xiaoyuzhou:pid alias or podcast:wandianliao key.
    const reqCreate = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(`xiaoyuzhou:${LATETALK_PID}`)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ note: '想在站内听晚点聊' }),
    });
    assert.equal(reqCreate.response.status, 202, JSON.stringify(reqCreate.body));
    assert.equal(reqCreate.body.request.catalogKey, LATETALK_KEY);
    assert.equal(reqCreate.body.request.platform, 'podcast');
    assert.equal(reqCreate.body.request.status, 'pending');

    // 2. Admin approves request -> creates podcast Custom Source & triggers T5 backfill for remaining 35 episodes.
    const approved = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${encodeURIComponent(reqCreate.body.request.id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.source.category, 'podcast');
    assert.equal(approved.body.activation.entryCount, 30);
    assert.equal(approved.body.activation.contentScope, 'show-notes/unknown');
    const sourceId = approved.body.source.id;

    // Wait for T5 backfill to finish all 65 episodes.
    const backfillDone = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: admin },
      });
      return body.status === 'succeeded' && body.coverage.entryCount === 65 ? body : null;
    });
    assert.equal(backfillDone.coverage.status, 'available_window');
    assert.equal(backfillDone.coverage.scopeStatus, 'unknown');
    assert.equal(backfillDone.coverage.platformPid, LATETALK_PID);
    assert.equal(backfillDone.coverage.platformDeclaredCount, null);
    assert.match(backfillDone.coverage.feedOrigin, /podcast\.latepost\.com\/rss.*feeds\.fireside\.fm\/latetalk\/rss/);
    assert.ok(Number(backfillDone.coverage.verifiedAt) > 0);
    assert.match(backfillDone.coverage.summaryText, /尚未对齐.*不宣称全集/);

    // 3. T4 history pagination walks all 65 episodes with audio enclosure and creator attribution.
    let cursor = '';
    const pagedEntries = [];
    while (true) {
      const qs = new URLSearchParams({ limit: '25' });
      if (cursor) qs.set('cursor', cursor);
      const page = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qs.toString()}`);
      assert.equal(page.response.status, 200);
      pagedEntries.push(...page.body.entries);
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(pagedEntries.length, 65);
    const newestEp = pagedEntries[0];
    const oldestEp = pagedEntries[pagedEntries.length - 1];
    assert.equal(newestEp.author, '晚点 LatePost');
    assert.deepEqual(newestEp.audio, { url: 'https://aphid.fireside.fm/d/1437767933/latetalk/ep-65.mp3', type: 'audio/mpeg' });
    assert.deepEqual(oldestEp.audio, { url: 'https://aphid.fireside.fm/d/1437767933/latetalk/ep-1.mp3', type: 'audio/mpeg' });
    const newestEntryId = newestEp.id;

    // Soft-delete episode #2 to verify deleted_at persists across refresh & restart.
    const epToDelete = pagedEntries.find(e => e.title.startsWith('2:'));
    assert.ok(epToDelete);
    const delRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(epToDelete.id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ reason: 'test-remove' }),
    });
    assert.equal(delRes.response.status, 200);

    // 4. Switch Xiaoyuzhou fixture to mismatch (e.g. declared 66 vs 64 active / or 181 vs 180 dynamically) AND update titles -> test mismatch & GUID dedup!
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'title-updated',
      baseCount: 65,
      xiaoyuzhouMode: 'mismatch',
      xiaoyuzhouEpisodeCount: 65, // 64 active in SQLite (1 deleted) vs 65 declared -> mismatch!
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });

    const afterTitleRefresh = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
    const ltAfterRefresh = afterTitleRefresh.body.sources.find(s => s.id === sourceId);
    assert.equal(ltAfterRefresh.coverage.entryCount, 64);
    assert.equal(ltAfterRefresh.coverage.scopeStatus, 'mismatch');
    assert.equal(ltAfterRefresh.coverage.platformDeclaredCount, 65);
    assert.match(ltAfterRefresh.coverage.summaryText, /范围未对齐（mismatch）.*差额原因未知.*不宣称全集/);
    assert.doesNotMatch(ltAfterRefresh.coverage.summaryText, /付费|已删除/);

    // GUID dedup kept the exact same entry ID even though title & link query changed; soft-deleted episode stayed deleted.
    const refreshedEntries = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=100`);
    const updatedNewest = refreshedEntries.body.entries.find(e => e.id === newestEntryId);
    assert.ok(updatedNewest, 'GUID identity preserved entry.id across title/link change');
    assert.match(updatedNewest.title, /修订标题 65/);
    assert.equal(refreshedEntries.body.entries.some(e => e.id === epToDelete.id), false, 'soft-deleted entry stayed deleted');

    // 5. Feed shrink + extra historical episode + parent-process AI exclusion check.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'extra-historical',
      baseCount: 65,
      xiaoyuzhouMode: 'mismatch',
      xiaoyuzhouEpisodeCount: 66,
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId }),
    });
    await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: admin },
      });
      return body.status === 'succeeded' && body.coverage.entryCount === 65 ? body : null;
    });

    // Feed shrinks (episode #65 removed from XML) -> existing persisted entries stay intact without stitching unverified URLs.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'shrunk',
      baseCount: 65,
      xiaoyuzhouMode: 'mismatch',
      xiaoyuzhouEpisodeCount: 66,
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const afterShrink = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=100`);
    assert.equal(afterShrink.body.entries.length, 65, 'shrunk feed preserves already ingested episodes');

    // Transient Xiaoyuzhou 503 preserves previously verified mismatch declared count instead of wiping it to unknown.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'shrunk',
      baseCount: 65,
      xiaoyuzhouMode: 'unavailable',
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const afterTransientXyz = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
    const ltTransient = afterTransientXyz.body.sources.find(s => s.id === sourceId);
    assert.equal(ltTransient.coverage.platformDeclaredCount, 66);
    assert.equal(ltTransient.coverage.scopeStatus, 'mismatch');

    // Trigger parent-process title translation & auto-rewrite -> zero AI calls for historical LateTalk episodes!
    await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ limit: 50 }),
    });
    await jsonRequest(server.baseUrl, '/api/auto-rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceIds: [sourceId] }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.ai?.running;
    });
    const aiTextBeforeRestart = readAiCalls(aiCapturePath).flatMap(c => c.messages || []).map(m => String(m.content || '')).join('\n');
    assert.doesNotMatch(aiTextBeforeRestart, /LateTalk|晚点聊|修订标题/);

    // 6. Restart server -> old IDs, deleted state, auto_ai_excluded_at, and coverage/verification metadata survive!
    await stopServer(server);
    server = await startServer(dataDir, {
      MOCK_LATETALK_STATE_PATH: statePath,
      MOCK_LATETALK_CAPTURE_PATH: capturePath,
      MOCK_LATETALK_AI_CAPTURE_PATH: aiCapturePath,
      PERIODICALS_MODE: 'on',
      VERSIONED_TRANSLATION_MODE: 'off',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-latetalk-ai.example/v1',
      AI_MODEL: 'mock-model',
    });
    const admin2 = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const sourcesAfterRestart = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin2 } });
    const ltRestarted = sourcesAfterRestart.body.sources.find(s => s.id === sourceId);
    assert.equal(ltRestarted.coverage.entryCount, 65);
    assert.equal(ltRestarted.coverage.scopeStatus, 'mismatch');
    assert.equal(ltRestarted.coverage.platformDeclaredCount, 66);
    assert.ok(Number(ltRestarted.coverage.verifiedAt) > 0);

    // Re-check AI exclusion after restart.
    await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin2 },
      body: JSON.stringify({ limit: 50 }),
    });
    await jsonRequest(server.baseUrl, '/api/auto-rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin2 },
      body: JSON.stringify({ sourceIds: [sourceId] }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin2 } });
      return !res.body.backgroundJob?.ai?.running;
    });
    const aiTextAfterRestart = readAiCalls(aiCapturePath).flatMap(c => c.messages || []).map(m => String(m.content || '')).join('\n');
    assert.doesNotMatch(aiTextAfterRestart, /LateTalk|晚点聊|修订标题/);

    // Verify SQLite invariants directly.
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const excludedNullCount = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE source_id = ? AND auto_ai_excluded_at IS NULL').get(sourceId).c;
      assert.equal(excludedNullCount, 0);
      const deletedRow = db.prepare('SELECT deleted_at FROM entries WHERE id = ?').get(epToDelete.id);
      assert.ok(Number(deletedRow.deleted_at) > 0);
      const periodicalCount = db.prepare(`
        SELECT COUNT(*) AS c FROM periodical_event_evidence pe
        JOIN entries e ON e.id = pe.entry_id
        WHERE e.source_id = ?
      `).get(sourceId).c;
      assert.equal(periodicalCount, 0);
      const backfillRuns = db.prepare('SELECT feed_url FROM source_backfill_runs WHERE source_id = ?').all(sourceId);
      assert.ok(backfillRuns.length > 0 && backfillRuns.every(r => r.feed_url === OFFICIAL_RSS_URL), 'backfill runs stay pinned to official entry URL');
    } finally {
      db.close();
    }

    // 7. Single-source failure isolation: Latetalk fails with identity mismatch while healthy source updates normally.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'wrong-title',
      otherSeq: 2,
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin2 },
      body: JSON.stringify({}),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin2 } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });

    const isolatedSources = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin2 } });
    const ltFailed = isolatedSources.body.sources.find(s => s.id === sourceId);
    assert.equal(ltFailed.status, 'stale', 'failed refresh retains readable stale snapshot');
    assert.equal(ltFailed.coverage.entryCount, 65, 'prior episodes stay intact');
    const healthyEntries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(healthySourceId)}&limit=10`);
    assert.ok(healthyEntries.body.entries.some(e => e.title === 'Healthy News #2'), 'other sources continue refreshing normally');

    // 8. Canonical episode URL identity fallback (when <guid> is omitted) + post-cutoff new episode eligibility.
    fs.writeFileSync(statePath, JSON.stringify({
      redirectMode: 'official',
      feedMode: 'no-guid-url-only',
      baseCount: 3,
      xiaoyuzhouMode: 'mismatch',
      xiaoyuzhouEpisodeCount: 181,
    }));
    const noGuidCheck = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin2 },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(noGuidCheck.response.status, 200);
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin2 } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });
    const db2 = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const urlIdentities = db2.prepare("SELECT platform_identity FROM entries WHERE source_id = ? AND platform_identity LIKE 'podcast:wandianliao:url:%'").all(sourceId);
      assert.equal(urlIdentities.length, 3, 'episodes without <guid> map identity by canonical episode URL, never title');
    } finally {
      db2.close();
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('LateTalk UI helpers render discovery actions, coverage notice with origin/verifiedAt/mismatch, and show notes audio card', () => {
  const escapeHtml = value => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  const discoveryCtx = {
    escapeHtml,
    isAdmin: () => false,
    discoveryState: { activatingKey: '', requestingKey: '', myRequests: [] },
  };
  vm.createContext(discoveryCtx);
  appFunctions(discoveryCtx, ['discoveryEntryHtml']);
  const readerHtml = discoveryCtx.discoveryEntryHtml({
    key: LATETALK_KEY,
    platform: 'podcast',
    name: '晚点聊',
    online: false,
  }, 'recommended');
  assert.match(readerHtml, /data-discovery-request="podcast:wandianliao"/);
  assert.match(readerHtml, /申请接入/);

  const adminCtx = {
    escapeHtml,
    isAdmin: () => true,
    discoveryState: { activatingKey: '', requestingKey: '', myRequests: [] },
  };
  vm.createContext(adminCtx);
  appFunctions(adminCtx, ['discoveryEntryHtml']);
  const adminHtml = adminCtx.discoveryEntryHtml({
    key: LATETALK_KEY,
    platform: 'podcast',
    name: '晚点聊',
    online: false,
    activatable: true,
  }, 'recommended');
  assert.match(adminHtml, /data-discovery-activate="podcast:wandianliao"/);
  assert.match(adminHtml, /加入自定义来源/);

  const coverageCtx = { Intl };
  vm.createContext(coverageCtx);
  appFunctions(coverageCtx, ['formatBackfillDate', 'formatSourceCoverageRange', 'sourceCoverageNoticeLabel']);
  const notice = coverageCtx.sourceCoverageNoticeLabel({
    category: 'podcast',
    coverage: {
      status: 'available_window',
      scopeStatus: 'mismatch',
      entryCount: 65,
      earliestPublishedAt: Date.UTC(2021, 10, 11),
      latestPublishedAt: Date.UTC(2026, 10, 19),
      feedOrigin: '官网 RSS（podcast.latepost.com/rss → feeds.fireside.fm/latetalk/rss）',
      verifiedAt: Date.UTC(2026, 10, 22, 5, 0),
      platformPid: LATETALK_PID,
      summaryText: '与小宇宙声明 66 期范围未对齐（mismatch），差额原因未知，不宣称全集',
    },
  });
  assert.match(notice, /已收录 65 期/);
  assert.match(notice, /2021-11-11 ~ 2026-11-19/);
  assert.match(notice, /官网 RSS（podcast\.latepost\.com\/rss → feeds\.fireside\.fm\/latetalk\/rss）/);
  assert.match(notice, /核验于 2026-11-22/);
  assert.match(notice, /范围未对齐（mismatch）/);

  assert.match(appSource, /show notes · 非逐字稿/);
  assert.match(appSource, /reader-audio-card/);
  assert.match(appSource, /reader-audio-shownotes-note/);
});
