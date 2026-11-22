const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-cross-source-preload.js');
const PRE_FEATURE_ROLLBACK_SHA = 'cd19628ba8ddc7e46ec1f7ec1afbeaa94eb04ba7';

const CATALOG_URL = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
const WECHAT_KEY = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
const XIAOJUN_KEY = 'xiaoyuzhou:626b46ea9cbbf0451cf5a962';
const FORTYTWO_KEY = 'xiaoyuzhou:648b0b641c48983391a63f98';
const LATETALK_KEY = 'podcast:wandianliao';
const BANNATIE_KEY = 'xiaoyuzhou:62382c1103bea1ebfffa1c00';

const HISTORICAL_AI_BLOCK_TOKENS = [
  'WeChat Historical',
  'WeChat Archive Page2',
  'LateTalk Episode',
  '商业故事与案例研究',
  '42章经 Ep',
  '张小珺',
  'Big Entry',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startServer(cwd, dataDir, env = {}) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
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
      PERIODICALS_MODE: 'on',
      VERSIONED_TRANSLATION_MODE: 'all',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-cross-ai.example/v1',
      AI_MODEL: 'mock-model',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`server in ${cwd} exited early:\n${logs.join('')}`);
    try {
      const res = await fetch(`${baseUrl}/api/sources`);
      if (res.ok) return { child, baseUrl, logs };
    } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server in ${cwd} failed to start:\n${logs.join('')}`);
}

function startMockedServer(cwd, dataDir, { capturePath, aiCapturePath, statePath, extraEnv = {} }) {
  return startServer(cwd, dataDir, {
    NODE_OPTIONS: `--require=${preloadPath}`,
    MOCK_CROSS_CAPTURE_PATH: capturePath,
    MOCK_CROSS_AI_CAPTURE_PATH: aiCapturePath,
    MOCK_CROSS_STATE_PATH: statePath,
    ...extraEnv,
  });
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise(resolve => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
    await exited;
  }
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function cookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()[0]
    : response.headers.get('set-cookie');
  return String(raw || '').split(';')[0];
}

async function loginCookie(baseUrl, email, password) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return cookieFrom(response);
}

function adminCookie(baseUrl) {
  return loginCookie(baseUrl, 'admin@example.com', 'test-password-123');
}

async function registerReader(baseUrl, email, displayName) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reader-password-123', displayName }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return { user: body.user, cookie: cookieFrom(response) };
}

async function waitUntil(fn, timeoutMs = 25000, stepMs = 50, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function waitForJobsIdle(baseUrl, cookie, timeoutMs = 30000) {
  return waitUntil(async () => {
    const res = await jsonRequest(baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    return !res.body.refreshing && !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
  }, timeoutMs, 60, 'background jobs idle');
}

function waitForFreshTranslation(baseUrl, entryId, cookie) {
  return waitUntil(async () => {
    const res = await jsonRequest(baseUrl, `/api/entry/${encodeURIComponent(entryId)}/translation`, {
      headers: { Cookie: cookie },
    });
    if (res.body && res.body.job && res.body.job.status === 'failed') {
      throw new Error(`manual translation job failed: ${JSON.stringify(res.body.job)}`);
    }
    return res.body && res.body.status === 'fresh' && res.body.versionId ? res.body : null;
  }, 20000, 60, `fresh translation for ${entryId}`);
}

async function collectAllHistory(baseUrl, sourceId, { limit = 50, maxPages = 70 } = {}) {
  let cursor = '';
  const entries = [];
  for (let page = 0; page < maxPages; page += 1) {
    const q = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
    const pageRes = await jsonRequest(baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history${q}`);
    assert.equal(pageRes.response.status, 200);
    assert.match(String(pageRes.response.headers.get('cache-control') || ''), /no-store/i);
    entries.push(...pageRes.body.entries);
    if (!pageRes.body.hasMore) break;
    cursor = pageRes.body.nextCursor;
  }
  return entries;
}

function readJsonArray(filePath, key) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))[key] || [];
  } catch {
    return [];
  }
}

function assertNoHistoricalAiCalls(aiCapturePath, contextLabel) {
  const aiCalls = readJsonArray(aiCapturePath, 'calls');
  for (const call of aiCalls) {
    const serialized = JSON.stringify(call.messages || []);
    for (const token of HISTORICAL_AI_BLOCK_TOKENS) {
      assert.equal(
        serialized.includes(token),
        false,
        `${contextLabel}: auto AI unexpectedly called for historical token ${token}: ${serialized}`,
      );
    }
  }
}

function extractRollbackWorktree(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'namoo-pre-feature-rollback-'));
  const tar = execFileSync('git', ['archive', sha], { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

test('T9 cross-source integration: WeChat + 4 verified podcasts, role isolation, concurrent refresh, >5000 pagination, and zero auto-AI/periodicals', { timeout: 120000 }, async () => {
  const dataDir = createTempDataDir('namoo-t9-cross-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');
  const statePath = path.join(dataDir, 'mock-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
    wechatArchiveComplete: true,
    xiaojunMode: '403',
    fortyTwoMode: 'ok',
    otherRefreshSeq: 1,
  }));

  let server = null;
  try {
    server = await startMockedServer(projectDir, dataDir, {
      capturePath,
      aiCapturePath,
      statePath,
      extraEnv: {
        SOURCE_BACKFILL_BATCH_SIZE: '30',
        SOURCE_BACKFILL_BATCH_DELAY_MS: '30',
      },
    });

    // 1. Guest discovery: 0 default enabled WeChat, private cache headers, all 4 podcasts offline, no feed URL leaks.
    const guestCat = await jsonRequest(server.baseUrl, '/api/source-catalog');
    assert.equal(guestCat.response.status, 200);
    assert.match(String(guestCat.response.headers.get('cache-control') || ''), /no-store/i);
    assert.match(String(guestCat.response.headers.get('vary') || ''), /cookie/i);
    assert.equal(guestCat.body.items.length, 50);
    assert.ok(guestCat.body.items.every(item => item.online === false), 'WeChat directory must keep 0 default enabled');
    const serializedCat = JSON.stringify(guestCat.body);
    for (const secretHost of ['wechat2rss.bestblogs.dev', 'feed.xyzfm.space', 'proxy.wavpub.com', 'feeds.fireside.fm']) {
      assert.equal(serializedCat.includes(secretHost), false);
    }

    const searchCat = await jsonRequest(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('腾讯'));
    assert.equal(searchCat.response.status, 200);
    assert.equal(searchCat.body.total, 2);
    const catalogFetches = readJsonArray(capturePath, 'requests').filter(r => r.url === CATALOG_URL);
    assert.equal(catalogFetches.length, 1);

    // 2. Role flows & private request isolation.
    const admin = await adminCookie(server.baseUrl);
    const readerA = await registerReader(server.baseUrl, 'reader-a@example.com', 'Reader A');
    const readerB = await registerReader(server.baseUrl, 'reader-b@example.com', 'Reader B');

    const reqWechat = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ note: 'Private note for Reader A only' }),
    });
    assert.equal(reqWechat.response.status, 202, JSON.stringify(reqWechat.body));

    const dupWechat = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(WECHAT_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ note: 'Ignored duplicate note' }),
    });
    assert.equal(dupWechat.response.status, 200);
    assert.equal(dupWechat.body.existing, true);
    assert.equal(dupWechat.body.request.id, reqWechat.body.request.id);

    const reqLatetalk = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(LATETALK_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ note: 'Requesting LateTalk' }),
    });
    assert.equal(reqLatetalk.response.status, 202, JSON.stringify(reqLatetalk.body));

    const myRequestsA = await jsonRequest(server.baseUrl, '/api/me/source-requests', { headers: { Cookie: readerA.cookie } });
    assert.equal(myRequestsA.response.status, 200);
    assert.match(String(myRequestsA.response.headers.get('cache-control') || ''), /no-store/i);
    assert.equal(myRequestsA.body.requests.length, 2);

    const myRequestsB = await jsonRequest(server.baseUrl, '/api/me/source-requests', { headers: { Cookie: readerB.cookie } });
    assert.equal(myRequestsB.response.status, 200);
    assert.equal(myRequestsB.body.requests.length, 0, 'Reader B must not see Reader A requests');

    const publicAfterReq = await jsonRequest(server.baseUrl, '/api/source-catalog');
    assert.equal(JSON.stringify(publicAfterReq.body).includes('Private note for Reader A only'), false);

    const forbiddenActivate = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: '{}',
    });
    assert.equal(forbiddenActivate.response.status, 403);

    // 3. Failure isolation + concurrent duplicate protection + 4 shows + WeChat + ordinary source.
    const failedXiaojun = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(XIAOJUN_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(failedXiaojun.response.status, 403);

    const approveLatetalk = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${encodeURIComponent(reqLatetalk.body.request.id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(approveLatetalk.response.status, 200, JSON.stringify(approveLatetalk.body));
    const latetalkId = approveLatetalk.body.source.id;

    const [concApprove, concActivate] = await Promise.all([
      jsonRequest(server.baseUrl, `/api/admin/submission-requests/${encodeURIComponent(reqWechat.body.request.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: '{}',
      }),
      jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(WECHAT_KEY)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: '{}',
      }),
    ]);
    assert.ok([200, 201].includes(concApprove.response.status));
    assert.ok([200, 201].includes(concActivate.response.status));
    const wechatId = concApprove.body.source.id;
    assert.equal(concActivate.body.source.id, wechatId, 'concurrent approve/activate must converge to one source');

    const act42 = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(act42.response.status, 201, JSON.stringify(act42.body));
    const fortyTwoId = act42.body.source.id;

    const actBannatie = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(BANNATIE_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(actBannatie.response.status, 201, JSON.stringify(actBannatie.body));
    const bannatieId = actBannatie.body.source.id;
    const sourcesAfterBannatie = await jsonRequest(server.baseUrl, '/api/sources');
    const pubBannatie = (sourcesAfterBannatie.body.sources || []).find(s => s.id === bannatieId);
    assert.equal(pubBannatie && pubBannatie.license && pubBannatie.license.name, 'WavPub License v2');

    // Recover 张小珺 and activate cleanly alongside built-in xiaojunpodcast.
    fs.writeFileSync(statePath, JSON.stringify({
      wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
      wechatArchiveComplete: true,
      xiaojunMode: 'ok',
      fortyTwoMode: 'ok',
      bannatieDelayMs: 120,
      otherRefreshSeq: 1,
    }));
    const actXiaojun = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(XIAOJUN_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(actXiaojun.response.status, 201, JSON.stringify(actXiaojun.body));
    const xiaojunId = actXiaojun.body.source.id;

    // Archive + explicit restore check on 42章经 reuses the exact source ID.
    const archived42 = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(fortyTwoId)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(archived42.response.status, 200);
    const unRestored = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(unRestored.response.status, 409);
    const restored42 = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ restore: true }),
    });
    assert.equal(restored42.response.status, 200);
    assert.equal(restored42.body.restored, true);
    assert.equal(restored42.body.source.id, fortyTwoId);

    // 4. Ordinary source + concurrent refresh DURING active backfill + restart recovery.
    const ordinaryRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: 'Other Fast Source', feedUrl: 'https://other-rss.example/rss.xml', category: 'news' }),
    });
    assert.equal(ordinaryRes.response.status, 201, JSON.stringify(ordinaryRes.body));
    const ordinaryId = ordinaryRes.body.source.id;
    await waitForJobsIdle(server.baseUrl, admin);

    const bannatieMidState = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
      headers: { Cookie: admin },
    });
    if (bannatieMidState.body.status !== 'succeeded') {
      fs.writeFileSync(statePath, JSON.stringify({
        wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
        wechatArchiveComplete: true,
        xiaojunMode: 'ok',
        fortyTwoMode: 'ok',
        otherRefreshSeq: 2,
      }));
      await jsonRequest(server.baseUrl, '/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({ sourceIds: [ordinaryId] }),
      });
      await waitForJobsIdle(server.baseUrl, admin);
      const ordEntries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(ordinaryId)}&limit=10`);
      assert.ok(ordEntries.body.entries.some(e => e.title.includes('#2')), 'ordinary refresh must advance concurrently while backfill is active');
    }

    // Restart server mid/post backfill to verify durable worker recovery and zero duplicates.
    await stopServer(server);
    server = await startMockedServer(projectDir, dataDir, {
      capturePath,
      aiCapturePath,
      statePath,
      extraEnv: {
        SOURCE_BACKFILL_BATCH_SIZE: '30',
        SOURCE_BACKFILL_BATCH_DELAY_MS: '20',
      },
    });
    const adminAfterRestart = await adminCookie(server.baseUrl);

    for (const [sid, expectedCount] of [
      [wechatId, 110],
      [bannatieId, 240],
      [latetalkId, 65],
      [fortyTwoId, 38],
      [xiaojunId, 40],
    ]) {
      const bf = await waitUntil(async () => {
        const res = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sid)}/backfill`, {
          headers: { Cookie: adminAfterRestart },
        });
        return res.body && res.body.status === 'succeeded' && res.body.coverage.entryCount === expectedCount ? res.body : null;
      }, 30000, 80, `backfill completion for ${sid}`);
      assert.equal(bf.coverage.entryCount, expectedCount);
    }

    // Verify LateTalk mismatch is preserved (65 vs 189, never washed into complete).
    const latetalkBf = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(latetalkId)}/backfill`, {
      headers: { Cookie: adminAfterRestart },
    });
    assert.equal(latetalkBf.body.coverage.scopeStatus, 'mismatch');
    assert.equal(latetalkBf.body.coverage.platformDeclaredCount, 189);
    assert.equal(latetalkBf.body.coverage.hasGap, true);

    // Reader reading + audio/source/shownotes verification across all 4 podcasts and WeChat.
    const bannatieEntries = await collectAllHistory(server.baseUrl, bannatieId, { limit: 50, maxPages: 10 });
    assert.equal(bannatieEntries.length, 240);
    assert.match(bannatieEntries.at(-1).title, /No\.0/);
    assert.match(bannatieEntries[0].audio.url, /^https:\/\/tk\.wavpub\.com\//);
    assert.match(bannatieEntries[0].content || bannatieEntries[0].summary, /节目说明/);

    for (const [sid, audioPattern] of [
      [latetalkId, /^https:\/\/aphid\.fireside\.fm\//],
      [fortyTwoId, /^https:\/\/media\.xyzcdn\.net\/648b0b641c48983391a63f98\//],
      [xiaojunId, /^https:\/\/media\.xyzcdn\.net\/626b46ea9cbbf0451cf5a962\//],
    ]) {
      const listRes = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sid)}&limit=5`);
      assert.equal(listRes.response.status, 200);
      assert.ok(listRes.body.entries.length > 0);
      const firstId = listRes.body.entries[0].id;
      const detail = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(firstId)}`);
      assert.equal(detail.response.status, 200);
      assert.match(detail.body.entry.audio.url, audioPattern);
      assert.ok(String(detail.body.entry.content || detail.body.entry.summary || '').trim().length > 0);
    }

    // 5. Seed >5000 historical entries on a synthetic source to verify oldest entry pagination beyond 5000.
    const bigSourceId = 'custom-t9-over5000';
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const baseTs = 1740000000000;
      db.exec('BEGIN');
      db.prepare(`INSERT INTO custom_sources (id, name, feed_url, category, created_at, updated_at) VALUES (?, 'Big Archive', 'https://example.com/big.xml', 'article', ?, ?)`)
        .run(bigSourceId, baseTs, baseTs);
      db.prepare(`INSERT INTO source_preferences (source_id, enabled, editorial_priority, display_order, updated_at) VALUES (?, 1, 'normal', 99, ?)`)
        .run(bigSourceId, new Date(baseTs).toISOString());
      const stmt = db.prepare(`INSERT INTO entries (id, source_id, title, link, published, published_ts, summary, content, content_hash, content_scope, auto_ai_excluded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', '<p>body</p>', ?, 'feed-body', ?, ?, ?)`);
      for (let i = 0; i < 5040; i += 1) {
        const ts = baseTs + i * 60000;
        const id = `big-${String(i).padStart(4, '0')}`;
        stmt.run(id, bigSourceId, `Big Entry #${i}`, `https://example.com/big/${i}`, new Date(ts).toISOString(), ts, `hash-${i}`, baseTs, ts, ts);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const bigEntries = await collectAllHistory(server.baseUrl, bigSourceId, { limit: 100, maxPages: 60 });
    assert.equal(bigEntries.length, 5040);
    assert.equal(bigEntries.at(-1).id, 'big-0000');

    // 6. Full real refresh + AI scan + periodicals on candidate; verify ZERO auto-AI & ZERO periodical leak.
    fs.writeFileSync(statePath, JSON.stringify({
      wechatNextUrl: 'https://wechat2rss.bestblogs.dev/feed/archive-page-2.xml',
      wechatArchiveComplete: true,
      xiaojunMode: 'ok',
      fortyTwoMode: 'ok',
      otherRefreshSeq: 3,
    }));
    const refreshRes = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminAfterRestart },
      body: JSON.stringify({}),
    });
    assert.ok([200, 202].includes(refreshRes.response.status), JSON.stringify(refreshRes.body));
    await waitForJobsIdle(server.baseUrl, adminAfterRestart);

    assertNoHistoricalAiCalls(aiCapturePath, 'candidate refresh + AI scan');

    const checkDb = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    try {
      const blockedIds = [wechatId, bannatieId, latetalkId, fortyTwoId, xiaojunId, bigSourceId];
      const placeholders = blockedIds.map(() => '?').join(',');
      const candidateLeaks = checkDb.prepare(`SELECT COUNT(*) AS count FROM periodical_event_evidence WHERE source_id IN (${placeholders})`).get(...blockedIds);
      assert.equal(Number(candidateLeaks.count), 0, 'historical sources must not leak into periodical_event_evidence');
      const issueContexts = checkDb.prepare('SELECT selection_context_json FROM periodical_issues').all();
      const blockedSet = new Set(blockedIds);
      for (const row of issueContexts) {
        const ctx = JSON.parse(String(row.selection_context_json || '{}'));
        const candidates = Array.isArray(ctx.candidateSnapshot) ? ctx.candidateSnapshot : [];
        for (const cand of candidates) {
          assert.equal(blockedSet.has(cand.sourceId), false, `historical source ${cand.sourceId} leaked into periodical candidateSnapshot`);
        }
      }
    } finally {
      checkDb.close();
    }

    // Explicit manual single-entry translation on a historical WeChat entry still works!
    const wechatHistory = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(wechatId)}/history?limit=5`);
    const sampleWechatEntry = wechatHistory.body.entries[0];
    const wechatRead = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(sampleWechatEntry.id)}`, {
      headers: { Cookie: readerA.cookie },
    });
    assert.equal(wechatRead.response.status, 200);
    const manualTrans = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(sampleWechatEntry.id)}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({}),
    });
    assert.ok([200, 202].includes(manualTrans.response.status), JSON.stringify(manualTrans.body));
    await waitForFreshTranslation(server.baseUrl, sampleWechatEntry.id, readerA.cookie);
  } finally {
    if (server) await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('AC-12 real pre-T1 rollback drill: stop sequence, boot cd19628 against same DB, zero AI on disabled history, preserve all user data, and resume on candidate', { timeout: 120000 }, async () => {
  const dataDir = createTempDataDir('namoo-t9-rollback-data-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');
  const preFeatureAiCapturePath = path.join(dataDir, 'pre-feature-ai-calls.json');
  const statePath = path.join(dataDir, 'mock-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    wechatNextUrl: '',
    bannatieDelayMs: 60,
    otherRefreshSeq: 1,
  }));

  const rollbackCodeDir = extractRollbackWorktree(PRE_FEATURE_ROLLBACK_SHA);
  let server = null;
  let rollbackServer = null;
  try {
    // 1. Seed candidate state (WeChat + 半拿铁 paused mid-backfill + ordinary source).
    server = await startMockedServer(projectDir, dataDir, {
      capturePath,
      aiCapturePath,
      statePath,
      extraEnv: {
        SOURCE_BACKFILL_BATCH_SIZE: '25',
        SOURCE_BACKFILL_BATCH_DELAY_MS: '120',
      },
    });
    const admin = await adminCookie(server.baseUrl);
    const reader = await registerReader(server.baseUrl, 'rollback-reader@example.com', 'Rollback Reader');

    const ordRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: 'Other Fast Source', feedUrl: 'https://other-rss.example/rss.xml', category: 'news' }),
    });
    assert.equal(ordRes.response.status, 201);
    const ordinaryId = ordRes.body.source.id;

    const actWechat = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(WECHAT_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(actWechat.response.status, 201);
    const wechatId = actWechat.body.source.id;

    const actBannatie = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(BANNATIE_KEY)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: '{}',
    });
    assert.equal(actBannatie.response.status, 201);
    const bannatieId = actBannatie.body.source.id;

    await waitUntil(async () => {
      const bf = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
        headers: { Cookie: admin },
      });
      return bf.body && bf.body.counts && bf.body.counts.processedCount >= 25 && bf.body.counts.processedCount < 240;
    }, 20000, 40, 'bannatie first batch commit');

    const pauseBannatie = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(pauseBannatie.response.status, 200);
    assert.equal(pauseBannatie.body.status, 'paused');

    const wechatBfNow = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(wechatId)}/backfill`, {
      headers: { Cookie: admin },
    });
    if (['queued', 'running', 'retry_wait'].includes(wechatBfNow.body.status)) {
      await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(wechatId)}/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({ action: 'pause' }),
      });
    }

    // Seed reader & admin artifacts: entry IDs, favorites, Highlight Annotations, versioned translation, deep links, soft delete.
    const wechatHist = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(wechatId)}/history?limit=10`);
    const bannatieHist = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(bannatieId)}/history?limit=5`);
    const ordHist = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(ordinaryId)}&limit=5`);
    const wechatTargetEntry = wechatHist.body.entries[0];
    const wechatDeletedEntry = wechatHist.body.entries[1];
    const bannatieTargetEntry = bannatieHist.body.entries[0];
    const ordTargetEntry = ordHist.body.entries[0];

    assert.equal((await jsonRequest(server.baseUrl, '/api/me/entry-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ entryId: wechatTargetEntry.id, starred: true }),
    })).response.status, 200);
    assert.equal((await jsonRequest(server.baseUrl, '/api/me/entry-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ entryId: bannatieTargetEntry.id, starred: true }),
    })).response.status, 200);

    const annWechat = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatTargetEntry.id)}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({
        surface: 'original',
        quote: 'WeChat historical research analysis',
        body: 'Important annotation preserved across rollback',
      }),
    });
    assert.equal(annWechat.response.status, 200, JSON.stringify(annWechat.body));
    const annId = annWechat.body.annotation.id;

    const transWechat = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatTargetEntry.id)}/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({}),
    });
    assert.ok([200, 202].includes(transWechat.response.status), `status=${transWechat.response.status}`);
    const readyTrans = await waitForFreshTranslation(server.baseUrl, wechatTargetEntry.id, reader.cookie);

    const queryDeepLinkPath = `/?entry=${encodeURIComponent(wechatTargetEntry.id)}`;
    const articleDeepLinkPath = `/articles/${encodeURIComponent(wechatTargetEntry.locator || wechatTargetEntry.id)}`;
    assert.equal((await fetch(`${server.baseUrl}${queryDeepLinkPath}`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}${articleDeepLinkPath}`)).status, 200);

    const softDel = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatDeletedEntry.id)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(softDel.response.status, 200);

    // 2. Documented stop sequence: pause backfill -> disable feature sources -> stop server & workers cleanly.
    for (const sid of [wechatId, bannatieId]) {
      const disabled = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(disabled.response.status, 200);
    }

    await stopServer(server);
    server = null;

    let preSnapshotHash = '';
    let preProcessedCount = 0;
    let preCursorJson = '';
    let snapshotFilePath = '';
    let preSnapshotFileSha = '';
    const preDb = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    try {
      const runRow = preDb.prepare(`SELECT status, processed_count, cursor_json, snapshot_hash FROM source_backfill_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`).get(bannatieId);
      assert.equal(runRow.status, 'paused');
      preSnapshotHash = runRow.snapshot_hash;
      preProcessedCount = Number(runRow.processed_count);
      preCursorJson = runRow.cursor_json;
      snapshotFilePath = path.join(
        dataDir,
        'raw',
        'sha256',
        preSnapshotHash.slice(0, 2),
        preSnapshotHash.slice(2, 4),
        `${preSnapshotHash}.html.gz`,
      );
      assert.ok(fs.existsSync(snapshotFilePath), `snapshot file must exist at ${snapshotFilePath}`);
      preSnapshotFileSha = crypto.createHash('sha256').update(fs.readFileSync(snapshotFilePath)).digest('hex');
    } finally {
      preDb.close();
    }

    // 3. Boot actual pre-feature version (cd19628...) against the SAME isolated dataDir.
    fs.writeFileSync(statePath, JSON.stringify({ otherRefreshSeq: 2 }));
    rollbackServer = await startMockedServer(rollbackCodeDir, dataDir, {
      capturePath,
      aiCapturePath: preFeatureAiCapturePath,
      statePath,
    });

    const rollbackSources = await jsonRequest(rollbackServer.baseUrl, '/api/sources');
    assert.equal(rollbackSources.response.status, 200);
    assert.equal(rollbackSources.body.sources.some(s => s.id === wechatId || s.id === bannatieId), false, 'disabled feature sources must stay hidden on rollback');

    const rollbackAdmin = await adminCookie(rollbackServer.baseUrl);
    const rollbackRefresh = await jsonRequest(rollbackServer.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rollbackAdmin },
      body: JSON.stringify({}),
    });
    assert.ok([200, 202].includes(rollbackRefresh.response.status));
    await waitForJobsIdle(rollbackServer.baseUrl, rollbackAdmin);

    const rollbackTitleScan = await jsonRequest(rollbackServer.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rollbackAdmin },
      body: JSON.stringify({}),
    });
    assert.ok([200, 202].includes(rollbackTitleScan.response.status));
    await waitForJobsIdle(rollbackServer.baseUrl, rollbackAdmin);

    const rollbackOrd = await jsonRequest(rollbackServer.baseUrl, `/api/entry/${encodeURIComponent(ordTargetEntry.id)}`);
    assert.equal(rollbackOrd.response.status, 200);
    assertNoHistoricalAiCalls(preFeatureAiCapturePath, 'pre-feature rollback version');

    const rollbackPeriodicalsDb = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    try {
      const leakedEvidence = rollbackPeriodicalsDb.prepare('SELECT COUNT(*) AS count FROM periodical_event_evidence WHERE source_id IN (?, ?)').get(wechatId, bannatieId);
      assert.equal(Number(leakedEvidence.count), 0, 'pre-feature periodicals must not include disabled feature sources');
    } finally {
      rollbackPeriodicalsDb.close();
    }

    await stopServer(rollbackServer);
    rollbackServer = null;

    // 4. Switch back to candidate version (HEAD) against the SAME dataDir and verify 100% data preservation.
    fs.writeFileSync(aiCapturePath, JSON.stringify({ calls: [] }));
    fs.writeFileSync(statePath, JSON.stringify({
      wechatNextUrl: '',
      bannatieDelayMs: 5,
      otherRefreshSeq: 3,
    }));
    server = await startMockedServer(projectDir, dataDir, {
      capturePath,
      aiCapturePath,
      statePath,
      extraEnv: {
        SOURCE_BACKFILL_BATCH_SIZE: '50',
        SOURCE_BACKFILL_BATCH_DELAY_MS: '10',
      },
    });
    const postAdmin = await adminCookie(server.baseUrl);
    const postReaderCookie = await loginCookie(server.baseUrl, 'rollback-reader@example.com', 'reader-password-123');

    const postSnapshotFileSha = crypto.createHash('sha256').update(fs.readFileSync(snapshotFilePath)).digest('hex');
    assert.equal(postSnapshotFileSha, preSnapshotFileSha, 'backfill input snapshot must remain byte-identical');
    const postBfBeforeResume = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
      headers: { Cookie: postAdmin },
    });
    assert.equal(postBfBeforeResume.body.status, 'paused');
    assert.equal(postBfBeforeResume.body.counts.processedCount, preProcessedCount);
    assert.equal(postBfBeforeResume.body.run.snapshotHash, preSnapshotHash);

    for (const sid of [bannatieId, wechatId]) {
      assert.equal((await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: postAdmin },
        body: JSON.stringify({ enabled: true }),
      })).response.status, 200);
    }

    const resumed = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: postAdmin },
      body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(resumed.response.status, 200);

    const finishedBannatie = await waitUntil(async () => {
      const bf = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(bannatieId)}/backfill`, {
        headers: { Cookie: postAdmin },
      });
      return bf.body && bf.body.status === 'succeeded' ? bf.body : null;
    }, 30000, 60, 'resumed bannatie backfill completion');
    assert.equal(finishedBannatie.coverage.entryCount, 240);

    const statesAfter = await jsonRequest(server.baseUrl, '/api/me/entry-states', {
      headers: { Cookie: postReaderCookie },
    });
    assert.equal(statesAfter.response.status, 200);
    const starredIds = statesAfter.body.states && Array.isArray(statesAfter.body.states.starred)
      ? statesAfter.body.states.starred
      : [];
    assert.equal(starredIds.includes(wechatTargetEntry.id), true);
    assert.equal(starredIds.includes(bannatieTargetEntry.id), true);

    const wechatEntryAfter = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatTargetEntry.id)}`, {
      headers: { Cookie: postReaderCookie },
    });
    assert.equal(wechatEntryAfter.response.status, 200);
    assert.equal(wechatEntryAfter.body.entry.id, wechatTargetEntry.id);
    assert.equal(Number(wechatEntryAfter.body.entry.stats && wechatEntryAfter.body.entry.stats.favoriteCount), 1);

    const bannatieEntryAfter = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(bannatieTargetEntry.id)}`, {
      headers: { Cookie: postReaderCookie },
    });
    assert.equal(bannatieEntryAfter.response.status, 200);
    assert.equal(Number(bannatieEntryAfter.body.entry.stats && bannatieEntryAfter.body.entry.stats.favoriteCount), 1);

    const annsAfter = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatTargetEntry.id)}/annotations`, {
      headers: { Cookie: postReaderCookie },
    });
    assert.ok(annsAfter.body.annotations.some(a => a.id === annId && a.body === 'Important annotation preserved across rollback'));

    const transAfter = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatTargetEntry.id)}/translation`, {
      headers: { Cookie: postReaderCookie },
    });
    assert.equal(transAfter.body.status, 'fresh');
    assert.equal(transAfter.body.versionId, readyTrans.versionId);

    const deletedAfter = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(wechatDeletedEntry.id)}`, {
      headers: { Cookie: postAdmin },
    });
    assert.equal(deletedAfter.response.status, 404, 'soft-deleted entry must not resurrect on re-enable/refresh');

    assert.equal((await fetch(`${server.baseUrl}${queryDeepLinkPath}`)).status, 200, 'query deep link must remain reachable');
    assert.equal((await fetch(`${server.baseUrl}${articleDeepLinkPath}`)).status, 200, 'article deep link must remain reachable');

    const postDb = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    try {
      const runRowAfter = postDb.prepare(`SELECT cursor_json FROM source_backfill_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`).get(bannatieId);
      assert.notEqual(runRowAfter.cursor_json, preCursorJson, 'resumed backfill advances checkpoint cleanly');
      const totalActive = postDb.prepare(`SELECT COUNT(*) AS count FROM entries WHERE source_id = ? AND COALESCE(deleted_at, 0) = 0`).get(bannatieId);
      assert.equal(Number(totalActive.count), 240);
    } finally {
      postDb.close();
    }

    assertNoHistoricalAiCalls(aiCapturePath, 'post-rollback recovery');
  } finally {
    if (server) await stopServer(server);
    if (rollbackServer) await stopServer(rollbackServer);
    fs.rmSync(rollbackCodeDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
