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
      const response = await fetch(baseUrl);
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

test('homepage renders Namoo brand and does not load analytics by default', async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir);
    const html = await fetch(server.baseUrl).then(response => response.text());
    assert.match(html, /<title>Namoo Reader · RSS 阅读器<\/title>/);
    assert.match(html, /<img class="brand-logo" src="\/favicon\.svg"/);
    assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
    assert.doesNotMatch(html, />Q<|Q 登录/);
    assert.doesNotMatch(html, /data-website-id=/);
    assert.doesNotMatch(html, /umami\.qiaomu\.ai/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('homepage injects configured HTTPS Umami script for the Namoo domain', async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir, {
      SITE_URL: 'https://reader.example.com',
      UMAMI_SRC: 'https://stats.example.com/script.js',
      UMAMI_WEBSITE_ID: '12345678-1234-1234-1234-123456789abc',
    });
    const html = await fetch(server.baseUrl).then(response => response.text());
    assert.match(html, /src="https:\/\/stats\.example\.com\/script\.js"/);
    assert.match(html, /data-website-id="12345678-1234-1234-1234-123456789abc"/);
    assert.match(html, /data-domains="reader\.example\.com"/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('brand icons contain the expected formats and dimensions', () => {
  const svg = fs.readFileSync(path.join(projectDir, 'public', 'favicon.svg'), 'utf8');
  assert.match(svg, /<mask[^>]+maskUnits="userSpaceOnUse"[^>]+maskContentUnits="userSpaceOnUse"/);

  for (const [filename, expectedSize] of [['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
    const png = fs.readFileSync(path.join(projectDir, 'public', filename));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), expectedSize);
    assert.equal(png.readUInt32BE(20), expectedSize);
  }
});
