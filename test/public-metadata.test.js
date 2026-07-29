const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const articleLocator = 'document-borne-ai-worms-can-self-propagate-through-copilot-for-word--8ce46c6026d6';
const assetTypes = ['translation', 'rewrite', 'onepage', 'comments', 'annotations', 'chat'];

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(dataDir) {
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
      FRESHNESS_STARTUP_DELAY_MS: '-1',
      TRANSLATION_WORKER_DISABLED: '1',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/sources`);
      if (response.ok) return { baseUrl, child };
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

function seedArticle(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
    probe: {
      fetchedAt: Date.now(),
      feedTitle: 'Metadata Probe',
      status: 'ok',
      error: null,
      entries: [{
        id: '8ce46c6026d60dd0a0156762f7b29d0d',
        sourceId: 'probe',
        title: 'Document-borne AI worms can self-propagate through Copilot for Word',
        titleZh: '文档传播的AI蠕虫可通过Word的Copilot自我复制',
        link: 'https://example.com/document-borne-ai-worms',
        published: '2026-07-29T00:00:00.000Z',
        publishedTs: Date.parse('2026-07-29T00:00:00.000Z'),
        summary: 'Metadata probe entry.',
        content: '<p>Metadata probe entry.</p>',
      }],
    },
  }));
}

function metadataUrls(html) {
  return {
    canonical: [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/>/g)].map(match => match[1]),
    ogUrl: [...html.matchAll(/<meta\s+property="og:url"\s+content="([^"]+)"\s*\/>/g)].map(match => match[1]),
  };
}

test('the static index keeps one homepage metadata fallback', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.deepEqual(metadataUrls(html), {
    canonical: ['https://rss.namooca.com/'],
    ogUrl: ['https://rss.namooca.com/'],
  });
});

test('every renderIndex page emits one canonical and og:url for its public semantics', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('public-metadata-');
  seedArticle(dataDir);
  let server = null;
  try {
    server = await startServer(dataDir);
    const routes = [
      ['/', '/'],
      [`/articles/${articleLocator}`, `/articles/${articleLocator}`],
      ...assetTypes.map(type => [
        `/articles/${articleLocator}/${type}`,
        `/articles/${articleLocator}/${type}`,
      ]),
      ...assetTypes.map(type => [
        `/articles/${articleLocator}/${type}/item-${type}`,
        `/articles/${articleLocator}/${type}/item-${type}`,
      ]),
      ['/?view=assets&asset=translation&sort=helpful', '/assets/translation?sort=helpful'],
      ['/assets', '/assets'],
      ...assetTypes.map(type => [`/assets/${type}?sort=helpful`, `/assets/${type}?sort=helpful`]),
      ['/assets/onepage?sort=helpful&q=agents', '/assets/onepage?sort=helpful'],
      ['/contributors', '/contributors'],
      ['/contributors?sort=helpful', '/contributors?sort=helpful'],
      ['/contributors?sort=assets', '/contributors?sort=assets'],
      ['/contributors/probe-author?type=comments&sort=helpful', '/contributors/probe-author'],
      ['/me', '/'],
      ['/dashboard', '/'],
      ['/admin', '/'],
    ];

    for (const [route, canonicalPath] of routes) {
      const response = await fetch(`${server.baseUrl}${route}`, { redirect: 'manual' });
      const html = await response.text();
      const expected = `${server.baseUrl}${canonicalPath}`;

      assert.equal(response.status, 200, route);
      assert.deepEqual(metadataUrls(html), {
        canonical: [expected],
        ogUrl: [expected],
      }, route);
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
