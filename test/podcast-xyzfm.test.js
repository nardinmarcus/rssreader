const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-xyzfm-preload.js');
const CATALOG_URL = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
const XIAOJUN_KEY = 'xiaoyuzhou:626b46ea9cbbf0451cf5a962';
const XIAOJUN_FEED_URL = 'https://feed.xyzfm.space/dk4yh3pkpjp3';
const FORTYTWO_KEY = 'xiaoyuzhou:648b0b641c48983391a63f98';
const FORTYTWO_FEED_URL = 'https://feed.xyzfm.space/evgg6xle9rdc';

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
    const val = await fn();
    if (val) return val;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test('T6 verified xyzfm podcasts: defaults, independent failure isolation, channel/episode verification, and URL pinning', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-xyzfm-verify-');
  const capturePath = path.join(dataDir, 'requests.json');
  const statePath = path.join(dataDir, 'xyzfm-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    xiaojunMode: '403',
    fortyTwoMode: 'ok',
    fortyTwoCount: 38,
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_XYZFM_CAPTURE_PATH: capturePath,
      MOCK_XYZFM_STATE_PATH: statePath,
      SOURCE_BACKFILL_BATCH_SIZE: '20',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '30',
    });

    const admin = await adminCookie(server.baseUrl);
    const reader = await registerReader(server.baseUrl, 'podcast-reader@example.com', 'Podcast Reader');

    // Default: no new podcast is enabled; feed URLs are never leaked publicly.
    const initialCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=podcast');
    assert.equal(initialCatalog.response.status, 200);
    assert.equal(JSON.stringify(initialCatalog.body).includes('feed.xyzfm.space'), false);
    const initial42 = initialCatalog.body.recommended.find(s => s.name === '42章经');
    assert.equal(initial42.key, FORTYTWO_KEY);
    assert.equal(initial42.online, false);

    // All 4 verified podcasts keep verified shows disabled until explicitly activated,
    // and unconfigured podcast keys return 422.
    const lateTalk = initialCatalog.body.recommended.find(s => s.key === 'podcast:wandianliao');
    const bannatie = initialCatalog.body.recommended.find(s => s.key === 'xiaoyuzhou:62382c1103bea1ebfffa1c00');
    assert.equal(Boolean(lateTalk && lateTalk.online), false);
    assert.equal(Boolean(bannatie && bannatie.online), false);
    const unimplemented = await jsonRequest(server.baseUrl, '/api/source-catalog/podcast:unverified-show/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(unimplemented.response.status, 400);

    // Independent failure isolation: 张小珺 fails with 403/html/empty/mismatch,
    // while 42章经 activates and backfills cleanly!
    for (const mode of ['403', 'html-403', 'empty-xml', 'wrong-channel-title', 'wrong-channel-pid', 'no-channel-pid', 'wrong-episode-link', 'hijacked-link-with-valid-guid', 'wrong-audio-pid']) {
      fs.writeFileSync(statePath, JSON.stringify({
        xiaojunMode: mode,
        fortyTwoMode: 'ok',
        fortyTwoCount: 38,
      }));
      const failRes = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(XIAOJUN_KEY)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({ feedUrl: 'http://127.0.0.1:1/forged.xml' }),
      });
      assert.ok(failRes.response.status >= 400, `${mode} must fail activation, got ${failRes.response.status}`);
      if (mode === '403') assert.equal(failRes.response.status, 403);
      else assert.equal(failRes.response.status, 422);
    }

    // Verify 张小珺 was NOT activated or left partial after all failures.
    const sourcesAfterFail = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
    assert.equal(sourcesAfterFail.body.sources.some(s => s.name.includes('小宇宙')), false);
    const reqs = JSON.parse(fs.readFileSync(capturePath, 'utf8')).requests || [];
    assert.equal(reqs.some(r => r.url.includes('127.0.0.1:1')), false, 'client feedUrl must never be fetched');

    // Reader requests 42章经, admin approves via moderation queue -> activates & backfills 42章经!
    const req42 = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ note: '想听42章经' }),
    });
    assert.equal(req42.response.status, 202, JSON.stringify(req42.body));
    assert.equal(req42.body.request.platform, 'podcast');

    const approved42 = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${req42.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({}),
    });
    assert.equal(approved42.response.status, 200, JSON.stringify(approved42.body));
    assert.equal(approved42.body.source.category, 'podcast');
    assert.equal(approved42.body.activation.entryCount, 30, 'initial window 30 episodes immediately readable');
    const source42Id = approved42.body.source.id;

    // Wait for 42章经 backfill to finish -> provider_archive_exhausted with all 38 episodes!
    const bf42 = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(source42Id)}/backfill`, {
        headers: { Cookie: admin },
      });
      return body.status === 'succeeded' ? body : null;
    });
    assert.equal(bf42.coverage.status, 'provider_archive_exhausted');
    assert.equal(bf42.coverage.hasGap, false);
    assert.equal(bf42.coverage.entryCount, 38);
    assert.ok(bf42.coverage.verifiedAt > 0);
    assert.ok(bf42.coverage.earliestPublishedAt < bf42.coverage.latestPublishedAt);
    assert.match(bf42.coverage.summaryText, /仅证明该供给范围/);

    // Client cannot replace pinned feedUrl via PATCH /api/sources/:id.
    const hijackPatch = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(source42Id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ feedUrl: 'https://evil.example/hijack.xml' }),
    });
    assert.equal(hijackPatch.response.status, 409);

    // Adding via POST /api/sources with 42章经 feed URL converges to the SAME source ID idempotently!
    const viaCustomCreate = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: '42章经手工', feedUrl: FORTYTWO_FEED_URL, category: 'podcast' }),
    });
    assert.equal(viaCustomCreate.response.status, 200);
    assert.equal(viaCustomCreate.body.alreadyActivated, true);
    assert.equal(viaCustomCreate.body.source.id, source42Id);

    // Recover 张小珺 and activate via POST /api/sources using its verified xyzfm URL -> converges on verified service!
    fs.writeFileSync(statePath, JSON.stringify({
      xiaojunMode: 'ok',
      xiaojunCount: 45,
      xiaojunOmitAudioIndex: 5,
      fortyTwoMode: 'ok',
      fortyTwoCount: 38,
    }));
    const activatedXiaojun = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: '张小珺小宇宙', feedUrl: XIAOJUN_FEED_URL, category: 'podcast' }),
    });
    assert.equal(activatedXiaojun.response.status, 201, JSON.stringify(activatedXiaojun.body));
    const sourceXjId = activatedXiaojun.body.source.id;
    assert.notEqual(sourceXjId, source42Id);

    const bfXj = await waitUntil(async () => {
      const { body } = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceXjId)}/backfill`, {
        headers: { Cookie: admin },
      });
      return body.status === 'succeeded' ? body : null;
    });
    assert.equal(bfXj.coverage.status, 'provider_archive_exhausted');
    assert.equal(bfXj.coverage.entryCount, 45);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('T6 episode dedup across query variants, show-notes scope, T4 pagination, zero auto-AI/periodicals, soft-delete, restart, and 16MiB bound', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-xyzfm-lifecycle-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');
  const statePath = path.join(dataDir, 'xyzfm-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    xiaojunMode: 'ok',
    xiaojunCount: 44,
    xiaojunOmitAudioIndex: 2, // 1 episode with unavailable/missing audio
    fortyTwoMode: 'ok',
    fortyTwoCount: 36,
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_XYZFM_CAPTURE_PATH: capturePath,
      MOCK_XYZFM_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_XYZFM_STATE_PATH: statePath,
      SOURCE_BACKFILL_BATCH_SIZE: '20',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '25',
      VERSIONED_TRANSLATION_MODE: 'off',
      PERIODICALS_MODE: 'on',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'fixture-ai-key',
      AI_BASE_URL: 'https://mock-xyzfm-ai.example/v1',
      AI_MODEL: 'mock-model',
    });

    let admin = await adminCookie(server.baseUrl);
    const reader = await registerReader(server.baseUrl, 'fan@example.com', 'Podcast Fan');

    // Activate 张小珺 (44 episodes) & 42章经 (36 episodes)
    const [actXj, act42] = await Promise.all([
      jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(XIAOJUN_KEY)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
      jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(FORTYTWO_KEY)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin },
        body: JSON.stringify({}),
      }),
    ]);
    assert.equal(actXj.response.status, 201);
    assert.equal(act42.response.status, 201);
    const xjId = actXj.body.source.id;
    const ftId = act42.body.source.id;

    // Wait for both backfills to complete independently
    await waitUntil(async () => {
      const [s1, s2] = await Promise.all([
        jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(xjId)}/backfill`, { headers: { Cookie: admin } }),
        jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(ftId)}/backfill`, { headers: { Cookie: admin } }),
      ]);
      return s1.body.status === 'succeeded' && s2.body.status === 'succeeded';
    });

    // Walk all 44 episodes via T4 keyset pagination, verifying newest & oldest, show-notes scope, creator, audio URL
    let cursor = '';
    const allXj = [];
    while (true) {
      const qs = new URLSearchParams({ limit: '15' });
      if (cursor) qs.set('cursor', cursor);
      const page = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(xjId)}/history?${qs.toString()}`);
      assert.equal(page.response.status, 200);
      allXj.push(...page.body.entries);
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(allXj.length, 44);
    const newestXj = allXj[0];
    const oldestXj = allXj[43];
    assert.equal(newestXj.contentScope, 'show-notes');
    assert.equal(newestXj.author, '张小珺');
    assert.match(newestXj.audio.url, /^https:\/\/media\.xyzcdn\.net\/626b46ea9cbbf0451cf5a962\//);
    assert.match(newestXj.link, /^https:\/\/www\.xiaoyuzhoufm\.com\/episode\//);
    assert.match(oldestXj.title, /访谈实录 #43$/);
    // Episode at index 2 has omitted enclosure -> audio is null without crashing
    assert.equal(allXj[2].audio, null);

    // Favorite & annotate newest episode, soft-delete episode #1
    const starRes = await jsonRequest(server.baseUrl, '/api/me/entry-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ entryId: newestXj.id, starred: true }),
    });
    assert.equal(starRes.response.status, 200);
    const softDeletedId = allXj[1].id;
    const delRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(softDeletedId)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(delRes.response.status, 200);

    // Refresh with URL query variants + one post-cutoff episode:
    // - existing episode IDs stay unchanged
    // - user star survives
    // - soft-deleted episode stays deleted
    fs.writeFileSync(statePath, JSON.stringify({
      xiaojunMode: 'with-future',
      xiaojunCount: 44,
      xiaojunOmitAudioIndex: 2,
      fortyTwoMode: 'wrong-channel-title', // mismatch on 42章经 must NOT break 张小珺!
    }));
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId: xjId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running && !res.body.backgroundJob?.ai?.running;
    });

    const afterVariant = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(xjId)}/history?limit=50`);
    assert.equal(afterVariant.body.entries.length, 44); // 44 - 1 soft-deleted + 1 post-cutoff = 44
    const keptStar = afterVariant.body.entries.find(e => e.id === newestXj.id);
    assert.ok(keptStar, 'query-variant episode must reuse the exact existing entry ID');
    assert.equal(afterVariant.body.entries.some(e => e.id === softDeletedId), false, 'soft-deleted episode must not resurrect');

    // Verify 42章经 refresh mismatch preserves prior 36 episodes!
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId: ftId }),
    });
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const ftHistory = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(ftId)}/history?limit=50`);
    assert.equal(ftHistory.body.entries.length, 36, 'failed/mismatched refresh preserves existing 42章经 episodes');

    // Zero auto-AI & zero periodical evidence for all historical/backfilled episodes
    await jsonRequest(server.baseUrl, '/api/translate-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ limit: 100 }),
    });
    const aiCalls = fs.existsSync(aiCapturePath) ? JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')).calls : [];
    const aiText = aiCalls.flatMap(c => c.messages || []).map(m => String(m.content || '')).join('\n');
    assert.doesNotMatch(aiText, /访谈实录 #/);

    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const historicalUnexcluded = db.prepare(`
        SELECT COUNT(*) AS c FROM entries
        WHERE source_id IN (?, ?) AND title LIKE '%访谈实录 #%' AND auto_ai_excluded_at IS NULL
      `).get(xjId, ftId).c;
      assert.equal(historicalUnexcluded, 0);
      const periodicalHits = db.prepare(`
        SELECT COUNT(*) AS c FROM periodical_event_evidence pe
        JOIN entries e ON e.id = pe.entry_id
        WHERE e.source_id IN (?, ?) AND e.title LIKE '%访谈实录 #%'
      `).get(xjId, ftId).c;
      assert.equal(periodicalHits, 0);
    } finally {
      db.close();
    }

    // Restart persistence check
    await stopServer(server);
    server = await startServer(dataDir, {
      MOCK_XYZFM_CAPTURE_PATH: capturePath,
      MOCK_XYZFM_STATE_PATH: statePath,
    });
    admin = await adminCookie(server.baseUrl);
    const afterRestart = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(xjId)}/history?limit=50`);
    assert.equal(afterRestart.body.entries.length, 44);
    assert.equal(afterRestart.body.entries.some(e => e.id === softDeletedId), false);
    const readerStates = await jsonRequest(server.baseUrl, '/api/me/entry-states', { headers: { Cookie: reader.cookie } });
    assert.equal(readerStates.response.status, 200);
    assert.ok(Array.isArray(readerStates.body.states?.starred) && readerStates.body.states.starred.includes(newestXj.id));

    // 16 MiB privileged limit: > 5 MiB (5.4 MiB) succeeds for verified xyzfm podcast,
    // while ordinary custom RSS > 5 MiB fails with ERR_BACKFILL_TOO_LARGE.
    fs.writeFileSync(statePath, JSON.stringify({
      xiaojunMode: 'over-5mib',
      fortyTwoMode: 'ok',
    }));
    const refreshBig = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId: xjId }),
    });
    assert.equal(refreshBig.response.status, 200);
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const bigSrc = (await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } }))
      .body.sources.find(s => s.id === xjId);
    assert.equal(bigSrc.status, 'ok', 'verified xyzfm podcast > 5 MiB must succeed within 16 MiB limit');

    const ordRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ name: 'Ordinary Over 5MiB', feedUrl: 'https://other-podcast.example/big.xml', category: 'podcast' }),
    });
    assert.equal(ordRes.response.status, 201);
    const ordId = ordRes.body.source.id;
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      const s = res.body.sources.find(item => item.id === ordId);
      return s && s.status === 'error';
    });

    // Verified podcast > 16 MiB fails cleanly without overwriting existing entries
    fs.writeFileSync(statePath, JSON.stringify({
      xiaojunMode: 'over-16mib',
      fortyTwoMode: 'ok',
    }));
    const refresh16 = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ sourceId: xjId }),
    });
    assert.equal(refresh16.response.status, 200);
    await waitUntil(async () => {
      const res = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } });
      return !res.body.backgroundJob?.fetch?.running;
    });
    const src16 = (await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: admin } }))
      .body.sources.find(s => s.id === xjId);
    assert.equal(src16.status, 'stale');
    assert.match(String(src16.error || ''), /too large|上限|bytes/i);
    const preservedHistory = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(xjId)}/history?limit=50`);
    assert.equal(preservedHistory.body.entries.length, 44, 'existing 44 episodes remain intact after >16 MiB rejection');
    const sourceBackfill = require('../lib/source-backfill');
    assert.match(sourceBackfill.sanitizeSafeErrorMessage('ERR_BACKFILL_TOO_LARGE', 'exceeds 16 MiB limit'), /16 MiB/);
    assert.match(sourceBackfill.sanitizeSafeErrorMessage('ERR_BACKFILL_TOO_LARGE', 'exceeds 5 MiB limit'), /5 MiB/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('T6 UI helpers: show-notes labels, coverage verifiedAt honesty, discovery secondary audio buttons, and audio protocol guard', () => {
  const vm = require('vm');
  const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const extractFn = name => {
    const start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    let i = appSource.indexOf('{', start);
    let depth = 0;
    for (; i < appSource.length; i += 1) {
      if (appSource[i] === '{') depth += 1;
      else if (appSource[i] === '}') {
        depth -= 1;
        if (depth === 0) return appSource.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated ${name}`);
  };

  const ctx = {
    escapeHtml,
    isAdmin: () => false,
    isWechatCatalogKey: v => /^wechat:[A-Za-z0-9_-]{6,80}$/.test(String(v || '').trim()),
    isXiaoyuzhouCatalogKey: v => /^xiaoyuzhou:[a-f0-9]{24}$/i.test(String(v || '').trim()),
    isCatalogActivationKey: v => ctx.isWechatCatalogKey(v) || ctx.isXiaoyuzhouCatalogKey(v),
    discoveryState: { activatingKey: '', requestingKey: '', myRequests: [] },
    Intl,
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFn('discoveryEntryHtml'),
    extractFn('wechatContentScopeLabel'),
    extractFn('formatBackfillDate'),
    extractFn('formatSourceCoverageRange'),
    extractFn('sourceCoverageNoticeLabel'),
  ].join('\n'), ctx);

  // Reader sees both YouTube online reading and xiaoyuzhou secondary audio request/listen buttons
  const readerReqHtml = ctx.discoveryEntryHtml({
    key: 'podcast:xiaojun-shangye-fangtanlu',
    platform: 'podcast',
    name: '张小珺商业访谈录',
    online: true,
    sourceId: 'xiaojunpodcast',
    requestKey: XIAOJUN_KEY,
  }, 'recommended');
  assert.match(readerReqHtml, /已上线/);
  assert.match(readerReqHtml, /进入阅读/);
  assert.match(readerReqHtml, /申请小宇宙音频/);
  assert.match(readerReqHtml, /data-discovery-request="xiaoyuzhou:626b46ea9cbbf0451cf5a962"/);

  const readerListenHtml = ctx.discoveryEntryHtml({
    key: 'podcast:xiaojun-shangye-fangtanlu',
    platform: 'podcast',
    name: '张小珺商业访谈录',
    online: true,
    sourceId: 'xiaojunpodcast',
    audioSourceId: 'custom-xyz-1',
  }, 'recommended');
  assert.match(readerListenHtml, /收听小宇宙版/);
  assert.match(readerListenHtml, /data-discovery-source="custom-xyz-1"/);

  // Admin archiving secondary xyzfm source keeps main online badge instead of overriding it
  ctx.isAdmin = () => true;
  const adminArchivedAudioHtml = ctx.discoveryEntryHtml({
    key: 'podcast:xiaojun-shangye-fangtanlu',
    platform: 'podcast',
    name: '张小珺商业访谈录',
    online: true,
    archived: true,
    activated: false,
    sourceId: 'xiaojunpodcast',
    activateKey: XIAOJUN_KEY,
  }, 'recommended');
  assert.match(adminArchivedAudioHtml, /已上线/);
  assert.match(adminArchivedAudioHtml, /恢复小宇宙音频/);

  assert.equal(
    ctx.wechatContentScopeLabel({ platformIdentity: `${XIAOJUN_KEY}:episode:ep1`, contentScope: 'show-notes' }),
    '节目说明（Show Notes · 非逐字稿）',
  );
  const coverageText = ctx.sourceCoverageNoticeLabel({
    coverage: {
      status: 'provider_archive_exhausted',
      entryCount: 44,
      earliestPublishedAt: Date.UTC(2025, 0, 10),
      latestPublishedAt: Date.UTC(2026, 8, 1),
      verifiedAt: Date.UTC(2026, 10, 22),
      summaryText: '已完成当前 RSS 公开供给全部归档（仅证明该供给范围）',
    },
  });
  assert.match(coverageText, /已存 44 篇/);
  assert.match(coverageText, /核验于 2026-11-22/);
  assert.match(coverageText, /仅证明该供给范围/);

  // Client-side renderReaderAudioHtml protocol defense & unavailable audio state
  vm.runInContext([
    'function safeHttpHref(v) { try { const u = new URL(String(v || "")); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : ""; } catch { return ""; } }',
    extractFn('renderReaderAudioHtml'),
  ].join('\n'), ctx);
  assert.equal(
    ctx.renderReaderAudioHtml({ audio: { url: 'javascript:alert(1)' }, link: 'https://www.xiaoyuzhoufm.com/episode/ep1' }, { category: 'podcast' }),
    '<div class="reader-audio-unavailable" role="status">该单集未提供可用音频地址，无法在站内播放。<a href="https://www.xiaoyuzhoufm.com/episode/ep1" target="_blank" rel="noopener noreferrer nofollow">前往原页面查看</a></div>',
  );
  const okAudioCard = ctx.renderReaderAudioHtml({
    author: '张小珺',
    link: 'https://www.xiaoyuzhoufm.com/episode/ep1',
    audio: { url: 'https://media.xyzcdn.net/626b46ea9cbbf0451cf5a962/ep1.m4a' },
  }, { name: '张小珺商业访谈录（小宇宙）', siteUrl: 'https://www.xiaoyuzhoufm.com/podcast/626b46ea9cbbf0451cf5a962' });
  assert.match(okAudioCard, /reader-audio-shownotes-note/);
  assert.match(okAudioCard, /reader-audio-error hidden/);
  assert.match(okAudioCard, /创作者：张小珺/);
});
