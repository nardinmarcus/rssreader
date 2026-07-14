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

test('expanded desktop sidebar has enough room for the full brand title and controls', () => {
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(styles, /#app\s*{[^}]*--sidebar-width:\s*264px/s);
  assert.match(styles, /@media \(max-width: 1380px\) and \(min-width: 1101px\)[\s\S]*?#app\s*{[^}]*--sidebar-width:\s*264px/);
  assert.match(styles, /#app\.reading:not\(\.sidebar-collapsed\):not\(\.left-collapsed\):not\(\.reader-immersive\)\s*{[^}]*--sidebar-width:\s*264px/s);
  assert.match(styles, /#app\.sidebar-collapsed\s*{[^}]*--sidebar-width:\s*64px/s);
});

test('sidebar exposes category tabs, total counts, and drag ordering without arrow controls', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(app, /sidebar-category-tabs/);
  assert.match(app, /row\.draggable = true/);
  assert.match(app, /dragstart/);
  assert.match(app, /dragover/);
  assert.match(app, /drop/);
  assert.match(app, /entryCountForSource/);
  assert.doesNotMatch(app, /data-source-move=/);
  assert.match(styles, /\.feed-item \.fcount[^}]*flex:\s*none/s);
  assert.match(styles, /\.feed-row\.drag-before/);
  assert.match(styles, /\.feed-row\.drag-after/);
});

test('My Space is the sole account workspace and subscription management is not a modal', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(html, /<h1>我的空间<\/h1>/);
  assert.match(html, /data-dashboard-tab="security"/);
  assert.match(html, /data-dashboard-tab="sources"/);
  assert.doesNotMatch(html, /data-dashboard-tab="operations"|dashboard-operations-panel|workspace-refresh-btn/);
  assert.match(html, /id="custom-source-form"/);
  assert.doesNotMatch(html, /account-settings-open|account-menu|sidebar-footer|manage-modal|admin-page|change-password-modal/);
  assert.doesNotMatch(app, /account-settings-open|account-menu|sidebar-footer|manage-modal|dashboard-ai-panel/);
  assert.match(app, /data-managed-order/);
  assert.doesNotMatch(app, /DASHBOARD_TABS = \[[^\]]*'operations'/);
  assert.doesNotMatch(app, /lucideIcon\('chevron-/);
  assert.doesNotMatch(styles, /\.account-settings|\.account-menu|\.admin-page/);
  assert.match(styles, /\.dashboard-tabs\s*\{\s*display:\s*flex;/);
  assert.match(styles, /#app\.workspace-page-open #sidebar\s*\{\s*display:\s*none;/);
});

test('versioned translations expose a safe progress surface and render only server HTML', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const versionedRenderer = app.slice(
    app.indexOf('function renderVersionedTranslation'),
    app.indexOf('function scheduleTranslationJobPoll'),
  );

  assert.match(html, /id="translation-job-status"[^>]*role="status"/);
  assert.match(app, /function isVersionedTranslationEnvelope\(/);
  assert.match(app, /function sanitizeVersionedTranslationHtml\([\s\S]*?if \(!window\.DOMPurify\) return '';/);
  assert.match(app, /renderVersionedTranslation\([\s\S]*?data\.renderedHtml/);
  assert.match(app, /renderVersionedTranslation\([\s\S]*?sanitizeVersionedTranslationHtml\(data\.renderedHtml\)/);
  assert.match(app, /function renderTranslationEnvelopeState\(data, \{ rendered = true \} = \{\}\)[\s\S]{0,300}if \(rendered\) setTranslationJobStatus\(''\)/);
  assert.match(app, /const rendered = renderVersionedTranslation\(data\);\s*const job = renderTranslationEnvelopeState\(data, \{ rendered \}\);/);
  assert.doesNotMatch(app, /renderVersionedTranslation\([\s\S]{0,1600}enrichedTranslationBlocks\(/);
  assert.match(versionedRenderer, /renderAssetHelpfulButton\('translation', state\.translation\)/);
  assert.match(versionedRenderer, /copy\.classList\.toggle\('hidden', !hasContent\);\s*copy\.disabled = !hasContent/);
  assert.match(versionedRenderer, /mode\.classList\.add\('hidden'\);\s*mode\.disabled = true/);
  assert.match(app, /function renderTranslation\(translation[^)]*\) \{\s*if \(translation\?\.schemaVersion === 2 && translation\.renderedHtml\) return renderVersionedTranslation/);
  assert.match(styles, /\.translation-job-status\s*\{/);
});

test('superseded translation jobs are terminal and trigger a fresh translation read', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  assert.match(app, /function isTerminalTranslationJob\(job\)[\s\S]{0,160}\['failed', 'succeeded', 'superseded'\]/);
  assert.match(app, /if \(job\.status === 'superseded'\)[\s\S]{0,320}loadTranslation\(state\.activeEntry/);
});
