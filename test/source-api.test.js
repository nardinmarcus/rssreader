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
  for (let attempt = 0; attempt < 80; attempt++) {
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
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('site AI metadata is available without exposing the site API key', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir, {
      DEEPSEEK_API_KEY: 'site-key-must-not-leak',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    });
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    const result = await jsonRequest(server.baseUrl, '/api/me');

    assert.equal(login.response.status, 200);
    assert.equal(login.body.siteAi.configured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(login.body.siteAi, 'apiKey'), false);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.siteAi.configured, true);
    assert.equal(result.body.siteAi.provider, 'deepseek');
    assert.equal(result.body.siteAi.model, 'deepseek-v4-flash');
    assert.equal(Object.prototype.hasOwnProperty.call(result.body.siteAi, 'apiKey'), false);
    assert.equal(JSON.stringify(result.body).includes('site-key-must-not-leak'), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('source management API enforces visibility, validation, ordering, and persistence', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir);
    const anonymous = await jsonRequest(server.baseUrl, '/api/sources');
    assert.equal(anonymous.response.status, 200);
    assert.equal(anonymous.body.sources.some(source => source.id === 'qiaomu-blog'), false);
    assert.equal(anonymous.body.sources.some(source => source.id === 'meta-ai'), false);

    const anonymousCreate = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Not allowed', feedUrl: 'https://example.com/feed.xml' }),
    });
    assert.equal(anonymousCreate.response.status, 403);

    const cookie = await adminCookie(server.baseUrl);
    const admin = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
    assert.equal(admin.body.sources.some(source => source.id === 'qiaomu-blog'), true);
    assert.equal(admin.body.sources.some(source => source.id === 'meta-ai'), true);

    const invalidCustom = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Broken custom source', feedUrl: 'file:///tmp/feed.xml' }),
    });
    assert.equal(invalidCustom.response.status, 400);

    const createdCustom = await jsonRequest(server.baseUrl, '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Custom AI Brief',
        feedUrl: 'http://127.0.0.1:1/feed.xml',
        siteUrl: 'http://127.0.0.1:1',
        category: 'news',
        labels: ['研究', '自定义'],
        description: 'Test-only custom feed',
      }),
    });
    assert.equal(createdCustom.response.status, 201, JSON.stringify(createdCustom.body));
    assert.equal(createdCustom.body.source.isCustom, true);
    assert.equal(createdCustom.body.source.enabled, true);
    assert.equal(createdCustom.body.source.category, 'news');
    const customSourceId = createdCustom.body.source.id;
    assert.match(customSourceId, /^custom-/);

    const publicCustom = await jsonRequest(server.baseUrl, '/api/sources');
    const publicCustomSource = publicCustom.body.sources.find(source => source.id === customSourceId);
    assert.equal(publicCustomSource.name, 'Custom AI Brief');
    assert.equal(Object.prototype.hasOwnProperty.call(publicCustomSource, 'feedUrl'), false);

    const updatedCustom = await jsonRequest(server.baseUrl, `/api/sources/${customSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Custom AI Brief Updated',
        feedUrl: 'http://127.0.0.1:1/updated.xml',
        labels: ['研究', '已编辑'],
      }),
    });
    assert.equal(updatedCustom.response.status, 200, JSON.stringify(updatedCustom.body));
    assert.equal(updatedCustom.body.source.name, 'Custom AI Brief Updated');
    assert.equal(updatedCustom.body.sources.find(source => source.id === customSourceId).feedUrl, 'http://127.0.0.1:1/updated.xml');

    const invalidPriority = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ editorialPriority: 'urgent' }),
    });
    assert.equal(invalidPriority.response.status, 400);

    const updated = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false, editorialPriority: 'low' }),
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.source.enabled, false);
    assert.equal(updated.body.source.editorialPriority, 'low');

    const moved = await jsonRequest(server.baseUrl, '/api/sources/anthropic/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ direction: 'down' }),
    });
    assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.moved, true);
    assert.equal(moved.body.neighborId, 'anthropic-research');

    const noFeed = await jsonRequest(server.baseUrl, '/api/sources/meta-ai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(noFeed.response.status, 400);

    await stopServer(server);
    server = await startServer(dataDir);
    const secondCookie = await adminCookie(server.baseUrl);
    const persisted = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: secondCookie } });
    const openai = persisted.body.sources.find(source => source.id === 'openai');
    const anthropic = persisted.body.sources.find(source => source.id === 'anthropic');
    const anthropicResearch = persisted.body.sources.find(source => source.id === 'anthropic-research');
    const custom = persisted.body.sources.find(source => source.id === customSourceId);
    assert.equal(openai.enabled, false);
    assert.equal(openai.editorialPriority, 'low');
    assert.ok(anthropic.displayOrder > anthropicResearch.displayOrder);
    assert.equal(custom.name, 'Custom AI Brief Updated');
    assert.equal(custom.feedUrl, 'http://127.0.0.1:1/updated.xml');

    const publicAfterRestart = await jsonRequest(server.baseUrl, '/api/sources');
    assert.equal(publicAfterRestart.body.sources.some(source => source.id === 'openai'), false);

    const builtInArchive = await jsonRequest(server.baseUrl, '/api/sources/openai', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
    });
    assert.equal(builtInArchive.response.status, 400);

    const archived = await jsonRequest(server.baseUrl, `/api/sources/${customSourceId}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
    });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.archived.id, customSourceId);
    assert.equal(archived.body.sources.some(source => source.id === customSourceId), false);

    await stopServer(server);
    server = await startServer(dataDir);
    const finalCookie = await adminCookie(server.baseUrl);
    const afterArchiveRestart = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: finalCookie } });
    assert.equal(afterArchiveRestart.body.sources.some(source => source.id === customSourceId), false);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an administrator password changed in the UI survives a server restart', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const changedPassword = 'changed-password-456';
  let server = null;
  try {
    server = await startServer(dataDir);
    const cookie = await adminCookie(server.baseUrl);
    const changed = await jsonRequest(server.baseUrl, '/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        currentPassword: 'test-password-123',
        newPassword: changedPassword,
      }),
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));

    await stopServer(server);
    server = await startServer(dataDir);

    const bootstrapLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    assert.equal(bootstrapLogin.response.status, 401);

    const changedLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: changedPassword }),
    });
    assert.equal(changedLogin.response.status, 200, JSON.stringify(changedLogin.body));
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Namoo creation draft runs through the authenticated API and persists the mock model result', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir();
  const capturePath = path.join(dataDir, 'mock-ai-request.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-ai-preload.js');
  const entryId = 'namoo-draft-e2e-entry';
  const sourceText = '这是一段用于端到端测试的 AI 资料。'.repeat(80);
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
    openai: {
      fetchedAt: Date.now(),
      feedUrl: 'https://openai.com/news/rss.xml',
      feedTitle: 'OpenAI News',
      status: 'ok',
      error: null,
      entries: [{
        id: entryId,
        sourceId: 'openai',
        title: 'A testable AI creation workflow',
        link: 'https://example.com/ai-workflow',
        author: 'Example Author',
        published: new Date().toISOString(),
        publishedTs: Date.now(),
        summary: sourceText.slice(0, 300),
        content: `<p>${sourceText}</p>`,
      }],
    },
  }));

  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_AI_CAPTURE_PATH: capturePath,
    });
    const cookie = await adminCookie(server.baseUrl);
    const generated = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/rewrite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-AI-Key': 'mock-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock AI',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-ai.example/v1',
        'X-AI-Model': 'mock-model',
      },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
    assert.match(generated.body.rewrite.body, /## Namoo 风格草稿/);
    assert.match(generated.body.rewrite.body, /\[需要 Namoo 补充：亲自使用后的判断和具体案例\]/);
    assert.match(generated.body.rewrite.body, /\[原文链接\]\(https:\/\/example\.com\/ai-workflow\)/);
    assert.equal(generated.body.rewrite.model, 'mock-model');
    assert.equal(generated.body.rewrite.createdBy, '大月 Namoo');

    const requestPayload = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.match(requestPayload.messages[0].content, /## 为什么值得写/);
    assert.match(requestPayload.messages[0].content, /不得替大月编造第一手观察/);
    assert.match(requestPayload.messages[1].content, /A testable AI creation workflow/);

    await stopServer(server);
    server = await startServer(dataDir, { NODE_OPTIONS: '', MOCK_AI_CAPTURE_PATH: '' });
    const persisted = await jsonRequest(server.baseUrl, `/api/entry/${entryId}/rewrite`);
    assert.equal(persisted.response.status, 200);
    assert.match(persisted.body.rewrite.body, /## 发布前检查/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
