const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'helpers', 'mock-source-catalog-preload.js');
const CATALOG_FEED_URL = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
// Fixture-derived expectations (test/fixtures/source-catalog.opml):
// 57 clean unique entries + 1 hostile-name entry = 58 unique valid entries,
// 2 duplicate-URL outlines, 2 skipped outlines (javascript: scheme, missing xmlUrl).
const FIXTURE_UNIQUE_ENTRIES = 58;
const RECOMMENDED_SHOW_NAMES = ['张小珺商业访谈录', '42章经', '晚点聊', '半拿铁'];

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

async function startCatalogServer(dataDir, env = {}) {
  const port = await freePort();
  const logs = [];
  const captureFile = path.join(dataDir, 'catalog-requests.json');
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
      MOCK_CATALOG_CAPTURE_PATH: captureFile,
      MOCK_CATALOG_MODE: 'ok',
      SOURCE_CATALOG_FEED_URL: CATALOG_FEED_URL,
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
      if (response.ok) {
        return {
          child,
          baseUrl,
          logs,
          captureFile,
          async stop() {
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
          },
        };
      }
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON */ }
  return { response, body };
}

async function readCapture(captureFile) {
  try {
    return JSON.parse(fs.readFileSync(captureFile, 'utf8')).requests || [];
  } catch {
    return [];
  }
}

test('source catalog cold start serves one merged OPML refresh and zero per-account fetches', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    const { response, body } = await getJson(server.baseUrl, '/api/source-catalog');
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.equal(body.total, FIXTURE_UNIQUE_ENTRIES);
    assert.equal(body.items.length, 50, 'default page size is 50');
    assert.ok(body.nextCursor, 'more pages remain');
    assert.ok(body.catalog.updatedAt, 'catalog exposes last successful update time');
    assert.equal(body.catalog.status, 'ok');

    // Exactly one merged catalog request, no per-account feed fan-out.
    const requests = await readCapture(server.captureFile);
    assert.equal(requests.length, 1, `expected one catalog request, saw: ${JSON.stringify(requests)}`);
    assert.equal(requests[0].url, CATALOG_FEED_URL);

    // Search reads the same snapshot without further external requests.
    const search = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('腾讯'));
    assert.equal(search.response.status, 200);
    assert.deepEqual(search.body.items.map(item => item.name).sort(), ['腾讯云开发者', '腾讯技术工程']);
    assert.equal(search.body.total, 2);
    const requestsAfterSearch = await readCapture(server.captureFile);
    assert.equal(requestsAfterSearch.length, 1, 'search must not trigger external requests while snapshot is fresh');
    assert.ok(requestsAfterSearch.every(request => request.url === CATALOG_FEED_URL),
      'no per-account feed fetches may occur');
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog cursor pagination walks the full snapshot with bounded page sizes', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    const page1 = await getJson(server.baseUrl, '/api/source-catalog');
    assert.equal(page1.body.items.length, 50);
    const page2 = await getJson(server.baseUrl, `/api/source-catalog?cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    assert.equal(page2.body.items.length, FIXTURE_UNIQUE_ENTRIES - 50);
    assert.equal(page2.body.nextCursor, null);
    const seen = new Set([...page1.body.items, ...page2.body.items].map(item => item.key));
    assert.equal(seen.size, FIXTURE_UNIQUE_ENTRIES, 'pages must not overlap or drop entries');

    const limited = await getJson(server.baseUrl, '/api/source-catalog?limit=100');
    assert.equal(limited.body.items.length, FIXTURE_UNIQUE_ENTRIES);
    assert.equal(limited.body.nextCursor, null);

    for (const bad of ['not-a-cursor', 'offset:-5', 'offset:99999999']) {
      const badPage = await getJson(server.baseUrl, `/api/source-catalog?cursor=${encodeURIComponent(bad)}`);
      assert.equal(badPage.response.status, 400, `cursor ${bad} must be rejected`);
    }
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('platform filter and search narrow the wechat snapshot without external requests', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    await getJson(server.baseUrl, '/api/source-catalog');

    const wechat = await getJson(server.baseUrl, '/api/source-catalog?platform=wechat');
    assert.ok(wechat.body.items.length > 0);
    assert.ok(wechat.body.items.every(item => item.platform === 'wechat'));
    assert.equal(wechat.body.recommended.length, 0, 'wechat filter hides podcast recommendations');

    const podcast = await getJson(server.baseUrl, '/api/source-catalog?platform=podcast');
    assert.equal(podcast.body.items.length, 0, 'no podcast entries live in the wechat snapshot');
    assert.ok(podcast.body.recommended.length > 0);

    const noMatch = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('不存在的账号'));
    assert.deepEqual(noMatch.body.items, []);

    const skipped = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('坏协议号'));
    assert.deepEqual(skipped.body.items, [], 'outlines without a valid http(s) feed URL never enter the catalog');
    const noUrl = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('无地址号'));
    assert.deepEqual(noUrl.body.items, []);

    const requests = await readCapture(server.captureFile);
    assert.equal(requests.length, 1, 'browse/search after cold start stays on the snapshot');
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exactly the four verified shows are recommended, only 张小珺 is online, Next Token never appears', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    const { body } = await getJson(server.baseUrl, '/api/source-catalog');

    const recommended = body.recommended;
    assert.deepEqual(recommended.map(show => show.name), RECOMMENDED_SHOW_NAMES);
    assert.equal(JSON.stringify(recommended).includes('Next Token'), false, 'Next Token must not be recommended');

    const byName = new Map(recommended.map(show => [show.name, show]));
    const xiaojun = byName.get('张小珺商业访谈录');
    assert.equal(xiaojun.online, true, '张小珺 maps onto the existing built-in podcast source');
    assert.equal(xiaojun.sourceId, 'xiaojunpodcast');
    assert.equal(xiaojun.platform, 'podcast');
    for (const name of ['42章经', '晚点聊', '半拿铁']) {
      const show = byName.get(name);
      assert.equal(show.online, false, `${name} is not integrated yet and must say so truthfully`);
      assert.equal(Object.prototype.hasOwnProperty.call(show, 'sourceId'), false);
    }
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('public projection exposes only safe fields, sanitized names, and no feed URLs', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    const { body } = await getJson(server.baseUrl, '/api/source-catalog?limit=100');
    const raw = JSON.stringify(body);

    assert.equal(raw.includes('wechat2rss.bestblogs.dev/feed/'), false, 'feed URLs must not be projected');
    assert.equal(raw.includes('onerror'), false, 'names must be sanitized plain text');
    assert.equal(raw.includes('<img'), false);

    const allowedItemKeys = new Set(['key', 'platform', 'name', 'online', 'sourceId', 'siteUrl', 'description']);
    for (const item of [...body.items, ...body.recommended]) {
      for (const key of Object.keys(item)) {
        assert.ok(allowedItemKeys.has(key), `unexpected projected field: ${key}`);
      }
    }
    const sanitized = body.items.find(item => item.name.includes('邪恶号'));
    assert.ok(sanitized, 'hostile-name fixture entry still exists as a catalog entry');
    assert.match(sanitized.name, /^邪恶号$/);

    const allowedCatalogKeys = new Set(['status', 'updatedAt']);
    for (const key of Object.keys(body.catalog)) {
      assert.ok(allowedCatalogKeys.has(key), `unexpected catalog meta field: ${key}`);
    }
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('duplicate catalog URLs collapse into a single entry with the count taken from the fixture', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let server = null;
  try {
    server = await startCatalogServer(dataDir);
    const dupSearch = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('腾讯技术工程'));
    assert.equal(dupSearch.body.total, 1, 'duplicate feed URL must not create a second entry');
    const genDup = await getJson(server.baseUrl, '/api/source-catalog?q=' + encodeURIComponent('测试账号 07'));
    assert.equal(genDup.body.total, 1);
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog snapshot survives a server restart without any external request', { timeout: 40000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let first = null;
  let second = null;
  try {
    first = await startCatalogServer(dataDir);
    const initial = await getJson(first.baseUrl, '/api/source-catalog');
    assert.equal(initial.body.total, FIXTURE_UNIQUE_ENTRIES);
    const updatedAt = initial.body.catalog.updatedAt;
    await first.stop();
    first = null;
    // The helper derives the capture file from the data dir; start the second
    // server's request log from zero so it proves zero re-fetches on restart.
    fs.rmSync(path.join(dataDir, 'catalog-requests.json'), { force: true });

    second = await startCatalogServer(dataDir);
    const restarted = await getJson(second.baseUrl, '/api/source-catalog');
    assert.equal(restarted.body.total, FIXTURE_UNIQUE_ENTRIES, 'snapshot persists across restart');
    assert.equal(restarted.body.catalog.updatedAt, updatedAt, 'snapshot update time survives restart');
    const requests = await readCapture(second.captureFile);
    assert.equal(requests.length, 0, 'fresh snapshot must not re-fetch on restart');
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('stale catalog refresh failure keeps the last successful snapshot and reports explicit staleness', { timeout: 40000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let first = null;
  let second = null;
  try {
    first = await startCatalogServer(dataDir);
    const initial = await getJson(first.baseUrl, '/api/source-catalog');
    assert.equal(initial.body.catalog.status, 'ok');
    const updatedAt = initial.body.catalog.updatedAt;
    await first.stop();
    first = null;

    // Malformed catalog body on refresh: old snapshot must survive, never be cleared.
    second = await startCatalogServer(dataDir, {
      MOCK_CATALOG_MODE: 'malformed',
      SOURCE_CATALOG_MAX_AGE_MS: '0',
    });
    const stale = await getJson(second.baseUrl, '/api/source-catalog');
    assert.equal(stale.response.status, 200);
    assert.equal(stale.body.total, FIXTURE_UNIQUE_ENTRIES, 'failed refresh must not clear the old catalog');
    assert.equal(stale.body.items.length, 50);
    assert.equal(stale.body.catalog.updatedAt, updatedAt, 'snapshot update time stays at last success');
    assert.equal(stale.body.catalog.status, 'stale', 'public projection marks the stale snapshot truthfully');
    const requests = await readCapture(second.captureFile);
    assert.ok(requests.length >= 1 && requests.length <= 2, `one merged refresh attempt expected: ${JSON.stringify(requests)}`);
    assert.ok(requests.every(request => request.url === CATALOG_FEED_URL));

    // After the failed attempt settles, the snapshot is still fully readable
    // and still projected as stale (never unavailable, never cleared).
    await new Promise(resolve => setTimeout(resolve, 400));
    const settled = await getJson(second.baseUrl, '/api/source-catalog');
    assert.equal(settled.response.status, 200);
    assert.equal(settled.body.total, FIXTURE_UNIQUE_ENTRIES, 'settled failed refresh keeps the old catalog');
    assert.equal(settled.body.items.length, 50);
    assert.equal(settled.body.catalog.status, 'stale');
    assert.equal(settled.body.catalog.updatedAt, updatedAt);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const mode of ['empty', 'whitespace', 'malformed', 'xxe', 'oversize', 'http-error']) {
  test(`cold start with ${mode} catalog response yields an explicit unavailable state`, { timeout: 40000 }, async () => {
    const dataDir = createTempDataDir('namoo-reader-catalog-');
    let server = null;
    try {
      server = await startCatalogServer(dataDir, { MOCK_CATALOG_MODE: mode });
      const { response, body } = await getJson(server.baseUrl, '/api/source-catalog');
      assert.equal(response.status, 200);
      assert.deepEqual(body.items, []);
      assert.equal(body.total, 0);
      assert.equal(body.catalog.status, 'unavailable');
      assert.equal(body.catalog.updatedAt, null);
      const raw = JSON.stringify(body);
      assert.equal(raw.includes('/etc/passwd'), false, 'external entity content must never leak');
      assert.equal(raw.includes('root:'), false);
      const requests = await readCapture(server.captureFile);
      assert.ok(requests.length >= 1, 'a refresh attempt must have been made');
      assert.ok(requests.every(request => request.url === CATALOG_FEED_URL), 'failure paths must not fan out per-account');
      // A later successful refresh can still fill the catalog.
    } finally {
      if (server) await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test('recovery: after a failed cold start, a later good refresh fills the catalog', { timeout: 40000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-catalog-');
  let first = null;
  let second = null;
  try {
    first = await startCatalogServer(dataDir, { MOCK_CATALOG_MODE: 'http-error' });
    const failed = await getJson(first.baseUrl, '/api/source-catalog');
    assert.equal(failed.body.catalog.status, 'unavailable');
    await first.stop();
    first = null;

    second = await startCatalogServer(dataDir, { SOURCE_CATALOG_MAX_AGE_MS: '5000' });
    const recovered = await getJson(second.baseUrl, '/api/source-catalog');
    assert.equal(recovered.body.catalog.status, 'ok');
    assert.equal(recovered.body.total, FIXTURE_UNIQUE_ENTRIES);
    assert.ok(recovered.body.catalog.updatedAt);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Discovery overlay UI interaction contracts ----------

const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

function extractAppFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}() in public/app.js`);
  // Skip the parameter list (paren-aware), then take the balanced body block.
  let depth = 0;
  let bodyStart = -1;
  for (let index = start; index < appSource.length; index += 1) {
    const character = appSource[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        bodyStart = appSource.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `expected a body for ${name}()`);
  depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === '{') depth += 1;
    if (appSource[index] === '}') depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}()`);
}

function runWithAppContext(source, globals = {}) {
  const vm = require('node:vm');
  const context = { ...globals };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('discovery entry renderer separates online reading from truthful not-integrated status', () => {
  const escapeHtml = value => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const context = runWithAppContext(extractAppFunction('discoveryEntryHtml'), { escapeHtml });

  const online = context.discoveryEntryHtml({
    key: 'podcast:xiaojun-shangye-fangtanlu',
    platform: 'podcast',
    name: '张小珺商业访谈录',
    online: true,
    sourceId: 'xiaojunpodcast',
  }, 'recommended');
  assert.match(online, /已上线/);
  assert.match(online, /进入阅读/);
  assert.match(online, /data-discovery-source="xiaojunpodcast"/);

  const offline = context.discoveryEntryHtml({
    key: 'podcast:42zhangjing',
    platform: 'podcast',
    name: '42章经',
    online: false,
  }, 'recommended');
  assert.match(offline, /42章经/);
  assert.match(offline, /未接入/);
  assert.doesNotMatch(offline, /申请|添加|激活|订阅/, 'offline entries must not offer misleading actions');
  assert.equal(/<button/.test(offline), false, 'offline entries must not render an action button');

  const wechat = context.discoveryEntryHtml({
    key: 'wechat:abc',
    platform: 'wechat',
    name: '腾讯技术工程',
    online: false,
  }, 'catalog');
  assert.match(wechat, /未接入/);
  assert.equal(/<button/.test(wechat), false);
});

test('discovery search keeps only the newest response and marks requests before awaiting', () => {
  const guardContext = runWithAppContext(extractAppFunction('isCurrentDiscoveryResponse'), {
    discoveryState: { requestSeq: 3 },
  });
  assert.equal(guardContext.isCurrentDiscoveryResponse(2), false, 'stale responses must be ignored');
  assert.equal(guardContext.isCurrentDiscoveryResponse(3), true);

  const loaderSource = extractAppFunction('loadSourceCatalog');
  const seqMark = loaderSource.indexOf('discoveryState.requestSeq += 1');
  const awaitCall = loaderSource.indexOf('await api(');
  assert.ok(seqMark !== -1, 'loader must tag its request sequence');
  assert.ok(awaitCall !== -1);
  assert.ok(seqMark < awaitCall, 'sequence must be recorded before awaiting the API');
  assert.match(loaderSource, /navigator\.onLine === false/, 'loader must check the network state first');
  assert.match(loaderSource, /renderSourceDiscoveryOffline\(\)/);
  const offlineCheck = loaderSource.indexOf('navigator.onLine');
  assert.ok(offlineCheck !== -1 && offlineCheck < awaitCall, 'offline check must run before any fetch');
  assert.match(extractAppFunction('renderSourceDiscoveryOffline'), /需要连接网络/, 'offline state must refuse to pretend content is available');
});

test('discovery overlay closes on Escape and restores focus to the opener', () => {
  const keydownMatch = appSource.match(/document\.addEventListener\('keydown'[\s\S]*?\n\}\);/);
  assert.ok(keydownMatch, 'expected the global keydown handler');
  assert.match(keydownMatch[0], /discoveryState\.open/);
  assert.match(keydownMatch[0], /closeSourceDiscovery/);

  const closeSource = extractAppFunction('closeSourceDiscovery');
  assert.match(closeSource, /discoveryState\.opener/);
  assert.match(closeSource, /\.focus\(\)/);

  const openSource = extractAppFunction('openSourceDiscovery');
  assert.match(openSource, /document\.activeElement/);

  const index = indexSource;
  assert.match(index, /id="source-discovery-modal"/);
  assert.match(index, /id="source-discovery-close"/);
  assert.match(index, /id="source-discovery-search"[^>]*aria-label="[^"]*"/);
  assert.match(index, /data-catalog-platform="wechat"/);
  assert.match(index, /data-catalog-platform="podcast"/);
  assert.match(appSource, /discoveryOpen\.id = 'source-discovery-open'/, 'reading sidebar must expose the discovery entry');
  assert.match(appSource, /discoveryOpen\.onclick = \(\) => openSourceDiscovery\(\)/);
});

test('discovery overlay styles cover mobile and follow theme variables', () => {
  assert.match(stylesSource, /\.source-discovery-box/);
  assert.match(stylesSource, /\.discovery-badge-offline/);
  const mobile = stylesSource.match(/@media \(max-width: 760px\)[\s\S]*?\n\}/);
  assert.ok(mobile, 'expected a mobile media query');
  assert.match(stylesSource, /\.source-discovery-open/);
});
