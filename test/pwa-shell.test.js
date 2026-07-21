const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');
const publicDir = path.join(projectDir, 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(publicDir, name), 'utf8');
}

function contentHash(filename) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(publicDir, filename)))
    .digest('hex')
    .slice(0, 12);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
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
      PORT: String(port),
      HOST: '127.0.0.1',
      NAMOO_READER_DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'test-admin-password',
      SITE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));

  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`);
      if (res.ok || res.status === 401) {
        return {
          baseUrl: `http://127.0.0.1:${port}`,
          async stop() {
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
          },
          logs,
        };
      }
    } catch {
      // wait for boot
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`server failed to start\n${logs.join('')}`);
}

test('web app manifest describes an installable standalone shell', () => {
  const raw = readPublic('manifest.webmanifest');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.name, 'Namoo Reader');
  assert.equal(manifest.short_name, 'Namoo');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.theme_color);
  assert.ok(manifest.background_color);

  const icons = manifest.icons || [];
  const sizes = new Set(icons.map(icon => icon.sizes));
  assert.ok(sizes.has('192x192'), 'manifest needs a 192 icon');
  assert.ok(sizes.has('512x512'), 'manifest needs a 512 icon');
  assert.ok(icons.every(icon => icon.purpose === 'any' || !icon.purpose || String(icon.purpose).includes('any')));
});

test('PWA icon files exist at the required dimensions', () => {
  for (const [filename, expectedSize] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const png = fs.readFileSync(path.join(publicDir, filename));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), expectedSize);
    assert.equal(png.readUInt32BE(20), expectedSize);
  }
});

test('index.html links the manifest and theme-color fallback', () => {
  const html = readPublic('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="theme-color" content="/);
  assert.match(html, /id="pwa-install-btn"/);
  assert.match(html, /id="shell-update-banner"/);
  assert.match(html, /id="network-banner"/);
});

test('service worker precaches the minimal reading shell and never claims /api', () => {
  const sw = readPublic('sw.js');
  const html = readPublic('index.html');
  const appVersion = html.match(/<script src="\/app\.js\?v=([^"]+)"/)?.[1];
  const stylesVersion = html.match(/<link rel="stylesheet" href="\/styles\.css\?v=([^"]+)"/)?.[1];
  const lucideVersion = html.match(/<script src="\/lucide-icons\.js\?v=([^"]+)"/)?.[1];

  assert.ok(appVersion && stylesVersion && lucideVersion);
  assert.equal(appVersion, contentHash('app.js'));
  assert.equal(stylesVersion, contentHash('styles.css'));
  assert.equal(lucideVersion, contentHash('lucide-icons.js'));

  assert.match(sw, new RegExp(`/app\\.js\\?v=${appVersion}`));
  assert.match(sw, new RegExp(`/styles\\.css\\?v=${stylesVersion}`));
  assert.match(sw, new RegExp(`/lucide-icons\\.js\\?v=${lucideVersion}`));
  assert.match(sw, /\/manifest\.webmanifest/);
  assert.match(sw, /\/favicon\.svg/);
  assert.match(sw, /\/icon-192\.png/);
  assert.match(sw, /\/icon-512\.png/);
  assert.match(sw, /\/apple-touch-icon\.png/);
  assert.doesNotMatch(sw, /vendor\/persona/);
  assert.match(sw, /pathname\.startsWith\(['"]\/api\/['"]\)/);
  assert.match(sw, /mode === ['"]navigate['"]/);
  assert.match(sw, /SKIP_WAITING/);
  assert.doesNotMatch(sw, /caches\.open\([^)]*\)[\s\S]{0,200}\/api\//);
});

test('client registers the service worker only outside local development hosts', () => {
  const app = readPublic('app.js');
  assert.match(app, /function shouldRegisterServiceWorker\(/);
  assert.match(app, /isSecureContext/);
  assert.match(app, /localhost/);
  assert.match(app, /127\.0\.0\.1/);
  assert.match(app, /\.local/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /shell-update-banner|showShellUpdatePrompt|Shell Update/);
  assert.match(app, /SKIP_WAITING/);
  assert.match(app, /需要网络|当前离线/);
  assert.match(app, /theme-color|syncThemeColor/);
});

test('service worker and web manifest are served with no-cache', async () => {
  const dataDir = createTempDataDir('namoo-reader-pwa-');
  let server;
  try {
    server = await startServer(dataDir);
    for (const route of ['/sw.js', '/manifest.webmanifest']) {
      const res = await fetch(`${server.baseUrl}${route}`);
      assert.equal(res.status, 200, route);
      const cacheControl = String(res.headers.get('cache-control') || '').toLowerCase();
      assert.match(cacheControl, /no-cache|max-age=0|must-revalidate/, `${route} must not be long-cached: ${cacheControl}`);
    }
  } finally {
    if (server) await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
