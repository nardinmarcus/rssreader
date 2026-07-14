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
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
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
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

test('HTTP responses include the baseline browser security headers', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const response = await fetch(`${server.baseUrl}/api/sources`);

    assert.deepEqual({
      contentType: response.headers.get('x-content-type-options'),
      frame: response.headers.get('x-frame-options'),
      referrer: response.headers.get('referrer-policy'),
      permissions: response.headers.get('permissions-policy'),
    }, {
      contentType: 'nosniff',
      frame: 'DENY',
      referrer: 'strict-origin-when-cross-origin',
      permissions: 'camera=(), microphone=(), geolocation=()',
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cross-site state-changing requests are rejected before route handling', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const response = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
    });

    assert.equal(response.status, 403);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reader submissions require an authenticated account before validation or fetching', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const response = await fetch(`${server.baseUrl}/api/submit-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });

    assert.equal(response.status, 401);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the homepage serves the pinned DOMPurify build through a versioned route', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const homepage = await fetch(`${server.baseUrl}/`);
    const html = await homepage.text();
    const asset = await fetch(`${server.baseUrl}/purify.min.js?v=3.4.11`);
    const source = await asset.text();

    assert.deepEqual({
      homepageStatus: homepage.status,
      scriptTag: html.includes('/purify.min.js?v=3.4.11'),
      assetStatus: asset.status,
      license: source.includes('DOMPurify 3.4.11'),
      cacheControl: asset.headers.get('cache-control'),
    }, {
      homepageStatus: 200,
      scriptTag: true,
      assetStatus: 200,
      license: true,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('server-funded AI ignores caller routing and tuning headers', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  const capturePath = path.join(dataDir, 'site-ai-request.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-ai-preload.js');
  let server = null;
  try {
    server = await startServer(dataDir, {
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_NAME: 'Site AI',
      AI_PROVIDER_TYPE: 'openai_compatible',
      AI_API_KEY: 'server-owned-key',
      AI_BASE_URL: 'https://mock-ai.example/v1',
      AI_MODEL: 'site-model',
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_AI_CAPTURE_PATH: capturePath,
    });
    const login = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${server.baseUrl}/api/ai/test`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Base-URL': 'https://attacker.example/v1',
        'X-AI-Model': 'attacker-model',
        'X-AI-Temperature': '2',
        'X-AI-Max-Tokens': '32768',
      },
    });
    const body = await response.json();
    const outbound = fs.existsSync(capturePath)
      ? JSON.parse(fs.readFileSync(capturePath, 'utf8'))
      : {};

    assert.deepEqual({
      status: response.status,
      provider: body.provider,
      model: body.model,
      outboundModel: outbound.model,
      outboundTemperature: outbound.temperature,
      outboundMaxTokens: outbound.max_tokens,
    }, {
      status: 200,
      provider: 'openai-compatible',
      model: 'site-model',
      outboundModel: 'site-model',
      outboundTemperature: 0,
      outboundMaxTokens: 32,
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('registration attempts are rate limited per client network', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const statuses = [];
    for (let index = 0; index < 6; index++) {
      const response = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `rate-limit-${index}@example.com`,
          password: 'test-password-123',
          displayName: `Rate Limit ${index}`,
        }),
      });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('login attempts are rate limited per client network', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-security-');
  let server = null;
  try {
    server = await startServer(dataDir, {
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
    });
    const statuses = [];
    for (let index = 0; index < 31; index++) {
      const response = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
      });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [...Array(30).fill(401), 429]);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
