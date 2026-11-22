const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-bannatie-preload.js');

const BANNATIE_KEY = 'xiaoyuzhou:62382c1103bea1ebfffa1c00';
const BANNATIE_FEED_URL = 'https://proxy.wavpub.com/caffebreve.xml';
const WAVPUB_LICENSE_URL = 'https://wav.pub/copyright/podcast-license-v2';

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
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      SOURCE_BACKFILL_BATCH_DELAY_MS: '5',
      SOURCE_BACKFILL_RETRY_BASE_MS: '10',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
      COOKIE_SECURE: '0',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      NODE_OPTIONS: `--require=${preloadPath}`,
      SOURCE_CATALOG_FEED_URL: 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml',
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
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
          },
        };
      }
    } catch { /* wait for boot */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON */ }
  return { response, body };
}

function cookieHeaderFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()[0]
    : response.headers.get('set-cookie');
  return String(raw || '').split(';')[0];
}

async function loginAdmin(baseUrl) {
  const res = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
  });
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  return cookieHeaderFrom(res.response);
}

async function registerReader(baseUrl, email, displayName) {
  const res = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reader-password-123', displayName }),
  });
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  return { cookie: cookieHeaderFrom(res.response), user: res.body.user };
}

function readCaptures(capturePath) {
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

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('snapshot boundary strictly enforces 5 MiB default and unlocks 16 MiB only for verified podcast feeds', async () => {
  const dataDir = createTempDataDir('namoo-bannatie-snap-');
  const script = `
    const assert = require('node:assert/strict');
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const zlib = require('zlib');
    const snapshots = require('./lib/source-snapshots');
    const discovery = require('./lib/source-discovery');

    (async () => {
      assert.equal(discovery.DEFAULT_RSS_MAX_BYTES, 5 * 1024 * 1024);
      assert.equal(discovery.VERIFIED_PODCAST_LARGE_RSS_MAX_BYTES, 16 * 1024 * 1024);
      assert.equal(
        discovery.maxRssBytesForVerifiedFeed({
          catalogKey: '${BANNATIE_KEY}',
          feedUrl: '${BANNATIE_FEED_URL}',
        }),
        16 * 1024 * 1024,
      );
      assert.equal(
        discovery.maxRssBytesForVerifiedFeed({
          catalogKey: '${BANNATIE_KEY}',
          feedUrl: 'https://evil.example/fake.xml',
        }),
        5 * 1024 * 1024,
      );
      assert.equal(
        discovery.maxRssBytesForVerifiedFeed({
          catalogKey: 'wechat:abc12345',
          feedUrl: '${BANNATIE_FEED_URL}',
        }),
        5 * 1024 * 1024,
      );

      const sixMiB = Buffer.alloc(6 * 1024 * 1024, 0x41);
      await assert.rejects(snapshots.put(sixMiB), { code: 'ERR_SNAPSHOT_TOO_LARGE' });
      await assert.rejects(snapshots.put(sixMiB, { maxBytes: 16 * 1024 * 1024 }), { code: 'ERR_SNAPSHOT_TOO_LARGE' });
      await assert.rejects(
        snapshots.put(sixMiB, { verifiedShowKey: '${BANNATIE_KEY}', feedUrl: 'https://evil.example/caffebreve.xml' }),
        { code: 'ERR_SNAPSHOT_TOO_LARGE' },
      );

      const opts = { verifiedShowKey: '${BANNATIE_KEY}', feedUrl: '${BANNATIE_FEED_URL}' };
      const hash = await snapshots.put(sixMiB, opts);
      assert.equal(hash, crypto.createHash('sha256').update(sixMiB).digest('hex'));
      const restored = await snapshots.read(hash, opts);
      assert.equal(restored.length, sixMiB.length);
      assert.ok(restored.equals(sixMiB));

      // Default read without verified podcast options still rejects >5 MiB!
      await assert.rejects(snapshots.read(hash), { code: 'ERR_SNAPSHOT_TOO_LARGE' });

      // >16 MiB explicitly fails!
      const over16MiB = Buffer.alloc(16 * 1024 * 1024 + 1, 0x42);
      await assert.rejects(snapshots.put(over16MiB, opts), { code: 'ERR_SNAPSHOT_TOO_LARGE' });

      // Hash mismatch rejects on read!
      const storedPath = path.join(process.env.NAMOO_READER_DATA_DIR, snapshots.relativePath(hash));
      fs.writeFileSync(storedPath, zlib.gzipSync(Buffer.from('corrupted payload')));
      await assert.rejects(snapshots.read(hash, opts), { code: 'ERR_SNAPSHOT_HASH_MISMATCH' });
    })();
  `;
  try {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: projectDir,
      env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verified show registration, >5 MiB snapshot -> restart -> full backfill/history, enclosure preservation, zero auto-AI, and zero periodical leak', { timeout: 90000 }, async () => {
  const dataDir = createTempDataDir('namoo-bannatie-e2e-');
  const capturePath = path.join(dataDir, 'requests.json');
  const aiCapturePath = path.join(dataDir, 'ai-calls.json');
  const statePath = path.join(dataDir, 'mock-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ mode: 'ok', cacheControl: 'no-cache' }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_BANNATIE_CAPTURE_PATH: capturePath,
      MOCK_BANNATIE_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_BANNATIE_STATE_PATH: statePath,
      BACKFILL_WORKER_DISABLED: '1',
      DEEPSEEK_API_KEY: 'site-mock-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    });

    // 1. Default not enabled: public catalog shows 半拿铁 offline, zero feedUrl leaked
    const initialCatalog = await jsonRequest(server.baseUrl, '/api/source-catalog?platform=podcast');
    assert.equal(initialCatalog.response.status, 200);
    const show = initialCatalog.body.recommended.find(item => item.key === BANNATIE_KEY);
    assert.ok(show, '半拿铁 must be registered under xiaoyuzhou:62382c1103bea1ebfffa1c00');
    assert.equal(show.name, '半拿铁');
    assert.equal(show.online, false, 'must not be enabled by default');
    assert.equal(Object.hasOwn(show, 'sourceId'), false);
    assert.equal(JSON.stringify(initialCatalog.body).includes(BANNATIE_FEED_URL), false);

    // 2. Reader requests 半拿铁 (spoofed feedUrl ignored; zero external feed fetches on request)
    const reader = await registerReader(server.baseUrl, 'listener@example.com', 'Podcast Listener');
    const reqRes = await jsonRequest(server.baseUrl, `/api/source-catalog/${encodeURIComponent(BANNATIE_KEY)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: reader.cookie },
      body: JSON.stringify({ note: '想听半拿铁', feedUrl: 'http://127.0.0.1:1/spoof.xml' }),
    });
    assert.equal(reqRes.response.status, 202, JSON.stringify(reqRes.body));
    assert.equal(reqRes.body.request.catalogKey, BANNATIE_KEY);
    assert.equal(reqRes.body.request.platform, 'podcast');
    assert.equal(
      readCaptures(capturePath).filter(r => r.url.includes('proxy.wavpub.com')).length,
      0,
      'request creation must not fetch feed',
    );

    // 3. Admin approves -> fetches >5 MiB structured RSS with identifiable UA, pins snapshot, imports newest 30
    const adminCookie = await loginAdmin(server.baseUrl);
    const approveRes = await jsonRequest(
      server.baseUrl,
      `/api/admin/submission-requests/${encodeURIComponent(reqRes.body.request.id)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({}),
      },
    );
    assert.equal(approveRes.response.status, 200, JSON.stringify(approveRes.body));
    const sourceId = approveRes.body.source.id;
    assert.equal(approveRes.body.source.category, 'podcast');
    assert.equal(approveRes.body.source.siteUrl, 'https://www.ximalaya.com/album/60629838');
    assert.equal(approveRes.body.activation.entryCount, 30);

    const wavpubReqs = readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL);
    assert.equal(wavpubReqs.length, 1);
    assert.match(wavpubReqs[0].headers['user-agent'], /^NamooReader\/1\.0 \(\+https:\/\/rss\.namooca\.com\)$/);

    // Verify client cannot replace feedUrl via PATCH /api/sources/:id
    const replaceFeedRes = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ feedUrl: 'https://other-rss.example/hijack.xml' }),
    });
    assert.equal(replaceFeedRes.response.status, 409);

    // Verify >5 MiB snapshot is persisted on disk and queued run points to it
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    const runBeforeRestart = db.prepare('SELECT * FROM source_backfill_runs WHERE source_id = ?').get(sourceId);
    assert.ok(runBeforeRestart);
    assert.ok(runBeforeRestart.snapshot_bytes > 5 * 1024 * 1024, `expected >5 MiB snapshot, got ${runBeforeRestart.snapshot_bytes}`);
    assert.equal(runBeforeRestart.total_count, 240);
    assert.equal(runBeforeRestart.status, 'queued');
    db.close();

    // 4. Restart server WITH backfill worker enabled (no new fetch needed: reads persisted >5 MiB snapshot!)
    const fetchCountBeforeRestart = readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length;
    await server.stop();
    server = await startServer(dataDir, {
      MOCK_BANNATIE_CAPTURE_PATH: capturePath,
      MOCK_BANNATIE_AI_CAPTURE_PATH: aiCapturePath,
      MOCK_BANNATIE_STATE_PATH: statePath,
      BACKFILL_WORKER_DISABLED: '0',
      DEEPSEEK_API_KEY: 'site-mock-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    });

    const completed = await waitFor(async () => {
      const st = await jsonRequest(server.baseUrl, `/api/admin/sources/${encodeURIComponent(sourceId)}/backfill`, {
        headers: { Cookie: adminCookie },
      });
      return st.body && st.body.status === 'succeeded' ? st.body : null;
    }, { label: 'large snapshot backfill completion' });

    assert.equal(completed.counts.totalCount, 240);
    assert.equal(completed.coverage.entryCount, 240);
    assert.equal(completed.coverage.feedItemCount, 240);
    assert.equal(completed.coverage.status, 'available_window');
    assert.equal(completed.coverage.hasGap, true);
    assert.match(completed.coverage.platformDeclaration, /平台总集数未声明/);
    assert.equal(
      readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length,
      fetchCountBeforeRestart,
      'backfill after restart must read persisted >5 MiB snapshot without re-fetching',
    );

    // 5. Walk full T4 history pagination -> all 240 episodes readable, tk.wavpub.com enclosure & author preserved
    const allHistory = [];
    let cursor = '';
    while (true) {
      const page = await jsonRequest(
        server.baseUrl,
        `/api/sources/${encodeURIComponent(sourceId)}/history?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      assert.equal(page.response.status, 200);
      allHistory.push(...page.body.entries);
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(allHistory.length, 240);
    const oldest = allHistory[allHistory.length - 1];
    const newest = allHistory[0];
    assert.match(newest.title, /No\.239/);
    assert.match(oldest.title, /No\.0/);
    assert.equal(oldest.author, '潇磊&刘飞');
    assert.ok(oldest.audio.url.startsWith('https://tk.wavpub.com/'), `must keep tk.wavpub.com URL, got ${oldest.audio.url}`);
    assert.equal(oldest.audio.type, 'audio/x-m4a');

    // Public /api/sources exposes license & separated coverage counts (no secrets)
    const pubSources = await jsonRequest(server.baseUrl, '/api/sources');
    const pubBannatie = pubSources.body.sources.find(s => s.id === sourceId);
    assert.ok(pubBannatie);
    assert.deepEqual(pubBannatie.license, { name: 'WavPub License v2', url: WAVPUB_LICENSE_URL });
    assert.equal(pubBannatie.coverage.entryCount, 240);
    assert.equal(pubBannatie.coverage.feedItemCount, 240);

    // 6. Soft-delete an episode, then run refresh -> deleted status and old IDs preserved, zero auto-AI & zero periodical leak
    const targetDeleteId = oldest.id;
    const delRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(targetDeleteId)}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    assert.equal(delRes.response.status, 200);

    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: 'refresh idle' });

    const verifyDb = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'), { readOnly: true });
    const deletedRow = verifyDb.prepare('SELECT id, deleted_at FROM entries WHERE id = ?').get(targetDeleteId);
    assert.ok(deletedRow && Number(deletedRow.deleted_at) > 0, 'deleted status must be preserved across refresh');
    const newestRow = verifyDb.prepare('SELECT id, auto_ai_excluded_at FROM entries WHERE id = ?').get(newest.id);
    assert.ok(newestRow && Number(newestRow.auto_ai_excluded_at) > 0, 'historical entries remain excluded from auto-AI');
    const unexcludedCount = verifyDb.prepare('SELECT COUNT(*) AS cnt FROM entries WHERE source_id = ? AND auto_ai_excluded_at IS NULL').get(sourceId).cnt;
    assert.equal(unexcludedCount, 0, 'zero initial/backfilled entries may enter auto-AI or periodicals');
    verifyDb.close();

    // Verify periodicals candidate extraction produces zero entries from 半拿铁 (zero periodical leak)
    const leakCheckScript = `
      const assert = require('node:assert/strict');
      const { DatabaseSync } = require('node:sqlite');
      const path = require('path');
      const { createPeriodicalsModule } = require('./lib/periodicals');
      const db = new DatabaseSync(path.join(process.env.NAMOO_READER_DATA_DIR, 'qmreader.sqlite'));
      const mod = createPeriodicalsModule({ db, mode: 'shadow' });
      const sync = mod.syncOpenDaily({ now: Date.now() });
      const jobs = db.prepare('SELECT candidate_count FROM periodical_build_jobs').all();
      assert.ok(jobs.every(j => Number(j.candidate_count) === 0), 'zero historical podcast entries may enter periodical build candidates');
      assert.ok(sync);
    `;
    const leakProc = spawn(process.execPath, ['-e', leakCheckScript], {
      cwd: projectDir,
      env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let leakStderr = '';
    leakProc.stderr.on('data', chunk => { leakStderr += String(chunk); });
    assert.equal(await new Promise(resolve => leakProc.on('close', resolve)), 0, leakStderr);

    assert.deepEqual(readAiCalls(aiCapturePath), [], 'zero automatic AI calls allowed');
  } catch (err) {
    if (server && server.logs.length) {
      err.message += `\n--- SERVER LOGS ---\n${server.logs.join('')}`;
    }
    throw err;
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('conditional requests (max-age + 304), >16 MiB rejection, ordinary 5 MiB bound, SSRF redirect guard, and mismatch coverage', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-bannatie-guards-');
  const capturePath = path.join(dataDir, 'requests.json');
  const statePath = path.join(dataDir, 'mock-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    mode: 'ok',
    etag: '"bannatie-etag-v1"',
    lastModified: 'Thu, 19 Nov 2026 05:46:14 GMT',
    cacheControl: 'public, max-age=1800',
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      MOCK_BANNATIE_CAPTURE_PATH: capturePath,
      MOCK_BANNATIE_STATE_PATH: statePath,
      BACKFILL_WORKER_DISABLED: '1',
    });
    const adminCookie = await loginAdmin(server.baseUrl);

    // Activate via POST /api/sources using verified feedUrl (pins to verified channel)
    const createRes = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: 'Ignored Name', feedUrl: BANNATIE_FEED_URL, category: 'article' }),
    });
    assert.equal(createRes.response.status, 201, JSON.stringify(createRes.body));
    const sourceId = createRes.body.source.id;
    assert.equal(createRes.body.source.name, '半拿铁');
    assert.equal(createRes.body.source.category, 'podcast');

    const hitsAfterActivate = readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length;
    assert.equal(hitsAfterActivate, 1);

    // 1. Fresh Cache-Control max-age=1800 -> refresh respects cache without hitting origin
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: 'cached refresh idle' });
    assert.equal(
      readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length,
      hitsAfterActivate,
      'must respect Cache-Control max-age before expiry',
    );

    // 2. Expire cache in SQLite & enable 304 -> sends If-None-Match + If-Modified-Since and handles 304 cleanly
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db.prepare('UPDATE source_http_cache SET expires_at = 0 WHERE feed_url = ?').run(BANNATIE_FEED_URL);
    db.close();
    fs.writeFileSync(statePath, JSON.stringify({
      mode: 'conditional-304',
      etag: '"bannatie-etag-v1"',
      lastModified: 'Thu, 19 Nov 2026 05:46:14 GMT',
      cacheControl: 'public, max-age=0',
      allow304: true,
    }));

    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: '304 refresh idle' });

    const condReqs = readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL);
    assert.equal(condReqs.length, hitsAfterActivate + 1);
    const condHeaders = condReqs[condReqs.length - 1].headers;
    assert.equal(condHeaders['if-none-match'], '"bannatie-etag-v1"');
    assert.equal(condHeaders['if-modified-since'], 'Thu, 19 Nov 2026 05:46:14 GMT');
    assert.match(condHeaders['user-agent'], /^NamooReader\/1\.0 \(\+https:\/\/rss\.namooca\.com\)$/);

    const sourcesAfter304 = await jsonRequest(server.baseUrl, '/api/sources');
    const srcAfter304 = sourcesAfter304.body.sources.find(s => s.id === sourceId);
    assert.equal(srcAfter304.status, 'ok');
    assert.equal(srcAfter304.entryCount, 30);

    // 3. Mismatch feed -> marks coverage mismatch, preserves prior 30 entries
    const db2 = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db2.prepare('UPDATE source_http_cache SET expires_at = 0 WHERE feed_url = ?').run(BANNATIE_FEED_URL);
    db2.close();
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'mismatch-podcast' }));

    const mismatchReq = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(mismatchReq.body.started, true);
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      const found = s.body && s.body.sources.find(x => x.id === sourceId);
      return s.body && !s.body.refreshing && found && found.coverage && found.coverage.status === 'mismatch' ? found : null;
    }, { label: 'mismatch coverage status' });

    const sourcesAfterMismatch = await jsonRequest(server.baseUrl, '/api/sources');
    const srcMismatch = sourcesAfterMismatch.body.sources.find(s => s.id === sourceId);
    assert.equal(srcMismatch.entryCount, 30, 'mismatch must preserve existing readable entries');
    assert.equal(srcMismatch.coverage.status, 'mismatch');
    assert.match(srcMismatch.coverage.summaryText, /供给身份不匹配/);

    // Failed/mismatched fetch must never poison source_http_cache with mismatch ETag/max-age
    const dbMismatchCheck = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    const cacheRowAfterMismatch = dbMismatchCheck.prepare('SELECT etag, expires_at FROM source_http_cache WHERE feed_url = ?').get(BANNATIE_FEED_URL);
    dbMismatchCheck.close();
    assert.notEqual(cacheRowAfterMismatch && cacheRowAfterMismatch.etag, '"mismatch-etag"');
    assert.equal(Number(cacheRowAfterMismatch && cacheRowAfterMismatch.expires_at), 0);

    // Subsequent refresh still hits origin and recovers immediately without waiting for bogus max-age
    const hitsBeforeRecover = readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length;
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'ok', etag: '"bannatie-etag-v2"', cacheControl: 'public, max-age=1800' }));
    const recoverReq = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(recoverReq.body.started, true);
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: 'recover after mismatch idle' });
    assert.equal(
      readCaptures(capturePath).filter(r => r.url === BANNATIE_FEED_URL).length,
      hitsBeforeRecover + 1,
      'recovery refresh must hit origin when prior response failed verification',
    );
    const recoveredSources = await jsonRequest(server.baseUrl, '/api/sources');
    const srcRecovered = recoveredSources.body.sources.find(s => s.id === sourceId);
    assert.equal(srcRecovered.status, 'ok');

    // 4. Ordinary Custom Source stays strictly capped at 5 MiB, and verified podcast rejects >16 MiB and SSRF redirects
    fs.writeFileSync(statePath, JSON.stringify({ otherOversize: true }));
    const ordCreate = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: 'Ordinary', feedUrl: 'https://other-rss.example/feed.xml', category: 'article' }),
    });
    assert.equal(ordCreate.response.status, 201);
    const ordId = ordCreate.body.source.id;
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      const found = s.body && s.body.sources.find(x => x.id === ordId);
      return found && found.status === 'error' ? found : null;
    }, { label: 'ordinary >5 MiB error' });

    // Verified show >16 MiB and SSRF redirect fail cleanly in backfill / fetch
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'oversize-16m' }));
    const db3 = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db3.prepare('UPDATE source_http_cache SET expires_at = 0 WHERE feed_url = ?').run(BANNATIE_FEED_URL);
    db3.close();
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: 'oversize-16m refresh idle' });
    const afterOversize = await jsonRequest(server.baseUrl, '/api/sources');
    const srcOversize = afterOversize.body.sources.find(s => s.id === sourceId);
    assert.match(String(srcOversize.error || ''), /413|too large/i);

    fs.writeFileSync(statePath, JSON.stringify({ mode: 'ssrf-redirect' }));
    const db4 = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db4.prepare('UPDATE source_http_cache SET expires_at = 0 WHERE feed_url = ?').run(BANNATIE_FEED_URL);
    db4.close();
    await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sourceId }),
    });
    await waitFor(async () => {
      const s = await jsonRequest(server.baseUrl, '/api/sources');
      return s.body && !s.body.refreshing;
    }, { label: 'ssrf-redirect refresh idle' });
    const afterSsrf = await jsonRequest(server.baseUrl, '/api/sources');
    const srcSsrf = afterSsrf.body.sources.find(s => s.id === sourceId);
    assert.match(String(srcSsrf.error || ''), /本机|内网|private|loopback/i);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('UI helpers render xiaoyuzhou discovery actions, separated coverage/mismatch banner, tk.wavpub.com player, attribution, and show notes label', () => {
  const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const extractFn = name => {
    const marker = `function ${name}(`;
    const start = appSource.indexOf(marker);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = appSource.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < appSource.length; i += 1) {
      if (appSource[i] === '{') depth += 1;
      else if (appSource[i] === '}') depth -= 1;
      if (depth === 0) return appSource.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };

  const escapeHtml = value => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ctx = {
    escapeHtml,
    isAdmin: () => false,
    discoveryState: { activatingKey: '', requestingKey: '', myRequests: [] },
    Intl,
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFn('discoveryEntryHtml'),
    extractFn('safeHttpHref'),
    extractFn('renderReaderAudioHtml'),
    extractFn('formatBackfillDate'),
    extractFn('formatSourceCoverageRange'),
    extractFn('sourceCoverageNoticeLabel'),
  ].join('\n'), ctx);

  // 1. Reader & admin discovery cards for 半拿铁 vs unverified 42章经
  const readerHtml = ctx.discoveryEntryHtml({
    key: BANNATIE_KEY,
    platform: 'podcast',
    name: '半拿铁',
    online: false,
  }, 'recommended');
  assert.match(readerHtml, new RegExp(`data-discovery-request="${BANNATIE_KEY}"`));

  ctx.isAdmin = () => true;
  const adminHtml = ctx.discoveryEntryHtml({
    key: BANNATIE_KEY,
    platform: 'podcast',
    name: '半拿铁',
    online: false,
  }, 'recommended');
  assert.match(adminHtml, new RegExp(`data-discovery-activate="${BANNATIE_KEY}"`));

  const unverifiedHtml = ctx.discoveryEntryHtml({
    key: 'podcast:unverified-show',
    platform: 'podcast',
    name: '未配置播客',
    online: false,
  }, 'recommended');
  assert.doesNotMatch(unverifiedHtml, /<button/);

  // 2. Audio player retains tk.wavpub.com enclosure + attribution + WavPub License v2 + Show Notes label
  const playerHtml = ctx.renderReaderAudioHtml({
    author: '潇磊&刘飞',
    link: 'https://www.ximalaya.com/sound/1033712034',
    audio: { url: 'https://tk.wavpub.com/WPTK_TEST.m4a', type: 'audio/x-m4a' },
    content: '<p>Show notes</p>',
  }, {
    name: '半拿铁',
    siteUrl: 'https://www.ximalaya.com/album/60629838',
    license: { name: 'WavPub License v2', url: WAVPUB_LICENSE_URL },
  });
  assert.match(playerHtml, /<audio controls preload="none" src="https:\/\/tk\.wavpub\.com\/WPTK_TEST\.m4a"><\/audio>/);
  assert.match(playerHtml, /节目：<a href="https:\/\/www\.ximalaya\.com\/album\/60629838"/);
  assert.match(playerHtml, /创作者：潇磊&amp;刘飞/);
  assert.match(playerHtml, /来源：<a href="https:\/\/www\.ximalaya\.com\/sound\/1033712034"/);
  assert.match(playerHtml, /授权：<a href="https:\/\/wav\.pub\/copyright\/podcast-license-v2"[^>]*>WavPub License v2<\/a>/);
  assert.match(playerHtml, /节目说明（Show Notes），未包含逐字稿/);

  // 3. Coverage notice separates stored count, feed item count, and platform declaration
  const notice = ctx.sourceCoverageNoticeLabel({
    coverage: {
      status: 'available_window',
      entryCount: 243,
      feedItemCount: 243,
      platformDeclaration: '平台总集数未声明（RSS 耗尽不代表平台全集完整）',
      summaryText: '已覆盖当前可用供给窗口，更早历史覆盖未知',
    },
  });
  assert.match(notice, /已存 243 篇/);
  assert.match(notice, /当前供给 243 条/);
  assert.match(notice, /平台总集数未声明/);
});

test('backfill fails explicitly on >16 MiB, hash mismatch, and enforces 3 MiB HTML bound', async () => {
  const dataDir = createTempDataDir('namoo-bannatie-bf-fail-');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('fs');
    const path = require('path');
    const zlib = require('zlib');
    const store = require('./lib/store');
    const fetcher = require('./lib/fetcher');
    const backfill = require('./lib/source-backfill');
    const snapshots = require('./lib/source-snapshots');

    (async () => {
      // 1. HTML fetch remains capped at 3 MiB
      const htmlBuf = Buffer.alloc(3 * 1024 * 1024 + 100, 0x61);
      await assert.rejects(
        fetcher.__test.fetchPublicBuffer('https://other-rss.example/page.html', { maxBytes: 3 * 1024 * 1024 }, {
          resolvePublicTarget: async u => ({ url: u, address: '93.184.216.34', family: 4 }),
          createDispatcher: () => ({ close: async () => {}, destroy: () => {} }),
          fetch: async () => new Response(htmlBuf, { status: 200, headers: { 'Content-Length': String(htmlBuf.length) } }),
        }),
        err => err && err.statusCode === 413,
      );

      // 2. Commit verified podcast activation and test >16 MiB backfill failure + hash mismatch failure
      const committed = store.commitCatalogActivation({
        platform: 'podcast',
        category: 'podcast',
        catalogKey: '${BANNATIE_KEY}',
        feedUrl: '${BANNATIE_FEED_URL}',
        name: '半拿铁',
        sourceId: 'custom-bannatie-test',
        entries: [],
      });
      const source = { ...committed.source, enabled: true, isCustom: true, feeds: [committed.source.feedUrl] };

      const oversizeRun = store.sourceBackfill.enqueueRun({
        sourceId: source.id,
        triggerReason: 'archive-next',
        feedUrl: '${BANNATIE_FEED_URL}',
        cutoffAt: Date.now(),
      });
      const failLarge = await backfill.runNext({
        getSourceById: () => source,
        fetchBuffer: async (_url, opts) => {
          assert.equal(opts.maxBytes, 16 * 1024 * 1024);
          return {
            url: '${BANNATIE_FEED_URL}',
            status: 200,
            headers: new Headers(),
            buffer: Buffer.alloc(16 * 1024 * 1024 + 64, 0x78),
          };
        },
      });
      assert.equal(failLarge.status, 'failed');
      assert.equal(failLarge.errorCode, 'ERR_BACKFILL_TOO_LARGE');
      assert.equal(failLarge.processedCount, 0);

      // 3. Corrupted snapshot hash mismatch never marks run as succeeded
      const validXml = Buffer.from('<?xml version="1.0"?><rss version="2.0"><channel><title>半拿铁</title><item><title>Ep 1</title><guid>g1</guid><enclosure url="https://tk.wavpub.com/a.m4a" type="audio/x-m4a"/></item></channel></rss>');
      const snapOpts = { verifiedShowKey: '${BANNATIE_KEY}', feedUrl: '${BANNATIE_FEED_URL}' };
      const snapHash = await snapshots.put(validXml, snapOpts);
      const corruptRun = store.sourceBackfill.enqueueRun({
        sourceId: source.id,
        triggerReason: 'feed-snapshot',
        feedUrl: '${BANNATIE_FEED_URL}',
        snapshotHash: snapHash,
        snapshotBytes: validXml.length,
        totalCount: 1,
        forceNew: true,
        cutoffAt: Date.now(),
      });
      fs.writeFileSync(path.join(process.env.NAMOO_READER_DATA_DIR, snapshots.relativePath(snapHash)), zlib.gzipSync(Buffer.from('tampered')));
      const failCorrupt = await backfill.runNext({ getSourceById: () => source });
      assert.equal(failCorrupt.id, corruptRun.run.id);
      assert.equal(failCorrupt.status, 'failed');
      assert.equal(failCorrupt.errorCode, 'ERR_BACKFILL_SNAPSHOT_CORRUPT');

      // 4. Overlong (>200 chars) podcast GUIDs hash deterministically without prefix collision
      const longPrefix = 'g'.repeat(210);
      const idA = fetcher.normalizeItem({ guid: longPrefix + '-a', title: 'A', link: 'https://www.ximalaya.com/sound/1', enclosure: { url: 'https://tk.wavpub.com/a.m4a', type: 'audio/x-m4a' } }, source);
      const idB = fetcher.normalizeItem({ guid: longPrefix + '-b', title: 'B', link: 'https://www.ximalaya.com/sound/2', enclosure: { url: 'https://tk.wavpub.com/b.m4a', type: 'audio/x-m4a' } }, source);
      assert.match(idA.platformIdentity, /^podcast:guid:sha256:[0-9a-f]{64}$/);
      assert.notEqual(idA.platformIdentity, idB.platformIdentity);

      // 5. 304 Not Modified without in-memory cache loaded must preserve disk cache.json entries
      const cacheFile = path.join(process.env.NAMOO_READER_DATA_DIR, 'cache.json');
      const seededEntry = { ...idA, fetchedAt: Date.now() };
      fs.writeFileSync(cacheFile, JSON.stringify({
        [source.id]: {
          fetchedAt: Date.now() - 60000,
          feedUrl: '${BANNATIE_FEED_URL}',
          feedTitle: '半拿铁',
          status: 'ok',
          error: null,
          entries: [seededEntry],
        },
      }));
      store.upsertEntries([seededEntry]);
      store.saveSourceHttpCache({
        feedUrl: '${BANNATIE_FEED_URL}',
        etag: '"etag-fresh-304"',
        lastModified: 'Thu, 19 Nov 2026 05:46:14 GMT',
        cacheControl: 'public, max-age=0',
        expiresAt: 0,
        updatedAt: Date.now() - 60000,
      });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(null, {
        status: 304,
        headers: { ETag: '"etag-fresh-304"', 'Cache-Control': 'public, max-age=600' },
      });
      try {
        const res304 = await fetcher.fetchSource({ ...source, feeds: ['${BANNATIE_FEED_URL}'] }, { bypassCache: true });
        await fetcher.flushDisk();
        assert.equal(res304.notModified, true);
        assert.equal(res304.entries.length, 1);
        assert.equal(res304.entries[0].id, seededEntry.id);
        const savedDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.equal(savedDisk[source.id].entries.length, 1);
        assert.equal(savedDisk[source.id].entries[0].id, seededEntry.id);
      } finally {
        globalThis.fetch = prevFetch;
      }
    })();
  `;
  try {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: projectDir,
      env: { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '--require ./test/helpers/mock-bannatie-preload.js', NAMOO_READER_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
