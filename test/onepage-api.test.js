const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
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
      TRANSLATION_WORKER_DISABLED: '1',
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
  const result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return String(result.response.headers.get('set-cookie') || '').split(';')[0];
}

function seedCache(dataDir, entryId) {
  const paragraph = 'Reliable agents are evaluated on real tasks, recovery paths, and complete task outcomes. '.repeat(12);
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
    'claude-blog': {
      fetchedAt: Date.now(),
      feedUrl: 'sitemap:https://claude.com/sitemap.xml',
      feedTitle: 'Claude Blog',
      status: 'ok',
      error: null,
      entries: [{
        id: entryId,
        sourceId: 'claude-blog',
        title: 'Reliable agents',
        link: 'https://example.com/reliable-agents',
        author: 'Example Lab',
        published: new Date().toISOString(),
        publishedTs: Date.now(),
        summary: 'A study of reliable agents.',
        content: `<h2>Reliable agents</h2><p>${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p>`,
      }],
    },
  }));
}

test('Onepage mode defaults off and is exposed without secrets', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('onepage-api-off-');
  let server;
  try {
    server = await startServer(dataDir);
    const cookie = await adminCookie(server.baseUrl);
    const me = await jsonRequest(server.baseUrl, '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.body.siteAi.onepageMode, 'off');
    assert.equal(me.body.siteAi.onepageEnabled, false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Onepage generation is limited to 20 requests per user per day', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('onepage-api-limit-');
  const entryId = 'onepage-api-limit-entry';
  const preloadPath = path.join(__dirname, 'helpers', 'mock-onepage-preload.js');
  seedCache(dataDir, entryId);
  let server;
  try {
    server = await startServer(dataDir, {
      ONEPAGE_MODE: 'all',
      NODE_OPTIONS: `--require=${preloadPath}`,
    });
    const cookie = await adminCookie(server.baseUrl);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-AI-Key': 'mock-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock Onepage',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-onepage.example/v1',
        'X-AI-Model': 'mock-onepage-model',
      },
      body: '{}',
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage`, options);
      assert.equal(result.response.status, 200, `attempt ${attempt + 1}: ${JSON.stringify(result.body)}`);
    }
    const limited = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage`, options);
    assert.equal(limited.response.status, 429);
    assert.match(limited.body.error, /今日 Onepage 生成次数已达上限/);
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Onepage API keeps previews private until explicit publication and survives restart', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('onepage-api-');
  const entryId = 'onepage-api-entry';
  const capturePath = path.join(dataDir, 'onepage-request.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-onepage-preload.js');
  seedCache(dataDir, entryId);
  let server;
  try {
    server = await startServer(dataDir, {
      ONEPAGE_MODE: 'all',
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_ONEPAGE_CAPTURE_PATH: capturePath,
    });
    const cookie = await adminCookie(server.baseUrl);
    const me = await jsonRequest(server.baseUrl, '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.body.siteAi.onepageMode, 'all');
    assert.equal(me.body.siteAi.onepageEnabled, true);
    const contributorId = me.body.user.id;

    const anonymousGenerate = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage`, { method: 'POST' });
    assert.equal(anonymousGenerate.response.status, 401);

    const generated = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-AI-Key': 'mock-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock Onepage',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-onepage.example/v1',
        'X-AI-Model': 'mock-onepage-model',
      },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(generated.response.status, 200, `${JSON.stringify(generated.body)}\n${server.logs.join('')}`);
    assert.equal(generated.body.onepage.visibility, 'private');
    assert.match(generated.body.onepage.html, /onepage-shell/);
    const onepageId = generated.body.onepage.id;

    const privateRead = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage?onepageId=${onepageId}`);
    assert.equal(privateRead.response.status, 404);
    const ownerRead = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage?onepageId=${onepageId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(ownerRead.response.status, 200);

    const published = await jsonRequest(server.baseUrl, `/api/onepages/${onepageId}/publish`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.onepage.visibility, 'public');

    const publicRead = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage?onepageId=${onepageId}`);
    assert.equal(publicRead.response.status, 200);
    assert.equal(publicRead.body.onepage.id, onepageId);

    const entries = await jsonRequest(server.baseUrl, '/api/entries?source=claude-blog');
    const projected = entries.body.entries.find(entry => entry.id === entryId);
    assert.equal(projected.assets.onepageCount, 1);
    assert.equal(projected.assets.items.onepage[0].id, onepageId);

    const helpful = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/assets/onepage/helpful`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ helpful: true, assetId: onepageId }),
    });
    assert.equal(helpful.response.status, 200, JSON.stringify(helpful.body));
    assert.equal(helpful.body.reaction.helpfulCount, 1);

    const contributor = await jsonRequest(server.baseUrl, `/api/contributors/${contributorId}`);
    assert.equal(contributor.body.onepages[0].id, onepageId);
    const contributors = await jsonRequest(server.baseUrl, '/api/contributors');
    const listedContributor = contributors.body.contributors.find(item => item.id === contributorId);
    assert.equal(listedContributor.onepageCount, 1);
    assert.equal(listedContributor.assetCount >= 1, true);
    const contributorFeed = await fetch(`${server.baseUrl}/contributors/${contributorId}.xml`);
    assert.equal(contributorFeed.status, 200);
    const contributorFeedText = await contributorFeed.text();
    assert.match(contributorFeedText, /当前订阅包含[^<]*Onepage/);
    assert.match(contributorFeedText, new RegExp(onepageId));
    const feed = await fetch(`${server.baseUrl}/assets/onepage.xml`);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), new RegExp(onepageId));

    const publicPage = await fetch(`${server.baseUrl}/articles/reliable-agents--onepage-api-/onepage/${onepageId}`);
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /Onepage/);

    const providerRequest = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(JSON.stringify(providerRequest).includes('https://example.com/reliable-agents'), false);

    await stopServer(server);
    server = await startServer(dataDir, { ONEPAGE_MODE: 'all' });
    const afterRestart = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/onepage?onepageId=${onepageId}`);
    assert.equal(afterRestart.response.status, 200);
    assert.equal(afterRestart.body.onepage.visibility, 'public');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
