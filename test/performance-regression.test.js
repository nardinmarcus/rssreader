const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('namoo-reader-performance-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const projectDir = path.join(__dirname, '..');

test('versioned application script URL matches the shipped content hash', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'));
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const version = html.match(/<script src="\/app\.js\?v=([^"]+)"/);

  assert.ok(version, 'index.html must load a versioned app.js');
  assert.equal(version[1], crypto.createHash('sha256').update(app).digest('hex').slice(0, 12));
});

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

async function startServer() {
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
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
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
      if (response.ok) return { child, baseUrl };
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

test('entry lists use a slim database projection while detail keeps bounded content', { timeout: 30000 }, async () => {
  const content = `<p>${'x'.repeat(600000)}</p>`;
  store.upsertEntries([{
    id: 'performance-entry',
    sourceId: 'openai',
    title: 'Performance entry',
    link: 'https://example.com/performance-entry',
    published: '2026-07-13T00:00:00.000Z',
    publishedTs: Date.parse('2026-07-13T00:00:00.000Z'),
    summary: 'Small list summary',
    content,
  }]);

  const slim = store.getEntriesBySourceIds(['openai'], { limit: 10, includeContent: false });
  const full = store.getEntriesBySourceIds(['openai'], { limit: 10 });
  assert.equal(slim[0].content, '');
  assert.equal(full[0].content, content);

  let server = null;
  try {
    server = await startServer();
    const listResponse = await fetch(`${server.baseUrl}/api/entries?source=openai`);
    const list = await listResponse.json();
    const listed = list.entries.find(entry => entry.id === 'performance-entry');
    assert.equal(listResponse.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(listed, 'content'), false);

    const detailResponse = await fetch(`${server.baseUrl}/api/entry/performance-entry`);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.entry.content.length, 500000);
    assert.equal(detail.entry.contentTruncated, true);
    assert.equal(detail.entry.contentOriginalLength, content.length);

    const versionedAsset = await fetch(`${server.baseUrl}/app.js?v=performance-test`);
    assert.equal(versionedAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  } finally {
    await stopServer(server);
  }
});

test('browser startup and entry opening keep critical requests off the old slow path', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const fetcher = fs.readFileSync(path.join(projectDir, 'lib', 'fetcher.js'), 'utf8');
  const server = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(projectDir, 'lib', 'store.js'), 'utf8');

  assert.match(app, /const detailPromise = content \? null : api\(`\/api\/entry\/\$\{encodeURIComponent\(e\.id\)\}`\)/);
  assert.match(app, /const \[, data\] = await Promise\.all\(\[\s*loadMe\(\),\s*loadSources\(\),\s*loadEntries\(\),\s*loadContributors\(\)/s);
  assert.match(app, /if \(!state\.contributors\.length \|\| state\.view === 'contributors'\) requests\.push\(loadContributors\(\)\)/);
  assert.match(app, /await openEntryFromUrl\(\{ entriesLoaded: true \}\)/);
  assert.doesNotMatch(fetcher, /for \(const c of Object\.values\(cache\)\)[\s\S]{0,300}function getEntryByIdPrefix/);
  assert.match(app, /async function selectSource\(id\)[\s\S]{0,700}await reload\(\);\s+if \(nextSource\) hintSourceRefresh/);
  assert.match(app, /const ENTRY_PAGE_SIZE = 100;/);
  assert.match(app, /p\.set\('limit', String\(state\.entryLimit\)\)/);
  assert.match(app, /more\.className = 'entry-load-more'/);
  assert.match(app, /class="favicon"[\s\S]{0,160}loading="lazy" fetchpriority="low"/);
  assert.match(app, /class="entry-thumb"[\s\S]{0,160}loading="lazy" fetchpriority="low"/);
  const assetFeedPreviews = server.match(/function assetFeedPreviews[\s\S]+?\n}\n\nfunction entryShareDescription/)[0];
  assert.doesNotMatch(assetFeedPreviews, /store\./);
  assert.match(server, /fetcher\.getEntries\(\{ limit: 1000, includeContent: false, assetItemLimit \}\)/);
  assert.match(server, /publicAssetEntries\(\{ assetItemLimit: 500 \}\)/);
  assert.match(server, /PUBLIC_PROJECTION_TTL_MS = 5 \* MINUTE_MS/);
  assert.match(server, /function publicAssetEntries\(\{ assetItemLimit = 3 \} = \{\}\)/);
  assert.match(storeSource, /safeItemLimit = Math\.max\(1, Math\.min\(500,/);
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
