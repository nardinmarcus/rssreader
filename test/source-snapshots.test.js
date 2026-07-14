const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('namoo-reader-snapshots-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const snapshots = require('../lib/source-snapshots');
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function putFromChild(body) {
  const modulePath = path.join(__dirname, '..', 'lib', 'source-snapshots.js');
  const script = `
    const snapshots = require(${JSON.stringify(modulePath)});
    snapshots.put(Buffer.from(process.env.SNAPSHOT_BODY_BASE64, 'base64'))
      .then(hash => process.stdout.write(hash))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        SNAPSHOT_BODY_BASE64: body.toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `snapshot child exited ${code}`));
    });
  });
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('put addresses the original bytes and read returns the gzip round trip', async () => {
  const body = Buffer.from('abc');

  assert.deepEqual(Object.keys(snapshots).sort(), ['put', 'read', 'relativePath']);
  const rawHash = await snapshots.put(body);

  assert.equal(rawHash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    snapshots.relativePath(rawHash),
    'raw/sha256/ba/78/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.html.gz',
  );
  assert.deepEqual(await snapshots.read(rawHash), body);
});

test('put reuses an existing content-addressed file without rewriting it', async () => {
  const body = Buffer.from('deduplicated snapshot');
  const rawHash = await snapshots.put(body);
  const storedPath = path.join(dataDir, snapshots.relativePath(rawHash));
  const preservedTime = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(storedPath, preservedTime, preservedTime);

  assert.equal(await snapshots.put(body), rawHash);
  assert.equal(fs.statSync(storedPath).mtimeMs, preservedTime.getTime());
});

test('put repairs a corrupted blob at an existing content address', async () => {
  const body = Buffer.from('self-healing content-addressed snapshot');
  const rawHash = await snapshots.put(body);
  const storedPath = path.join(dataDir, snapshots.relativePath(rawHash));
  fs.writeFileSync(storedPath, 'corrupted gzip bytes');

  assert.equal(await snapshots.put(body), rawHash);
  assert.deepEqual(await snapshots.read(rawHash), body);
});

test('put never exposes a partial gzip at the final content address', async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const expectedHash = crypto.createHash('sha256').update(body).digest('hex');
  const storedPath = path.join(dataDir, snapshots.relativePath(expectedHash));
  let settled = false;
  let observedPartialFile = false;

  const writing = snapshots.put(body).finally(() => { settled = true; });
  while (!settled) {
    if (fs.existsSync(storedPath)) {
      try {
        if (!zlib.gunzipSync(fs.readFileSync(storedPath)).equals(body)) observedPartialFile = true;
      } catch {
        observedPartialFile = true;
      }
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  await writing;

  assert.equal(observedPartialFile, false);
  assert.deepEqual(await snapshots.read(expectedHash), body);
});

test('concurrent puts of the same bytes share one physical write', async () => {
  const body = crypto.randomBytes(256 * 1024);
  const originalOpen = fs.promises.open;
  let temporaryFileOpens = 0;
  let releaseOpen;
  const openGate = new Promise(resolve => { releaseOpen = resolve; });
  fs.promises.open = async (...args) => {
    if (String(args[0]).endsWith('.tmp')) {
      temporaryFileOpens += 1;
      await openGate;
    }
    return originalOpen.apply(fs.promises, args);
  };

  try {
    const writes = Array.from({ length: 8 }, () => snapshots.put(body));
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseOpen();
    const hashes = await Promise.all(writes);

    assert.equal(new Set(hashes).size, 1);
    assert.equal(temporaryFileOpens, 1);
    assert.deepEqual(await snapshots.read(hashes[0]), body);
  } finally {
    releaseOpen();
    fs.promises.open = originalOpen;
  }
});

test('competing processes publish one complete snapshot without temporary files', async () => {
  const body = crypto.randomBytes(64 * 1024);
  const hashes = await Promise.all(Array.from({ length: 6 }, () => putFromChild(body)));
  const rawHash = hashes[0];
  const storedPath = path.join(dataDir, snapshots.relativePath(rawHash));

  assert.equal(new Set(hashes).size, 1);
  assert.deepEqual(await snapshots.read(rawHash), body);
  assert.deepEqual(fs.readdirSync(path.dirname(storedPath)), [path.basename(storedPath)]);
});

test('relativePath and read reject values that could escape the raw snapshot tree', async () => {
  assert.throws(() => snapshots.relativePath('../../outside'), /invalid raw hash/);
  await assert.rejects(snapshots.read('../'.repeat(32)), /invalid raw hash/);
});

test('read rejects a corrupted gzip instead of returning partial bytes', async () => {
  const rawHash = await snapshots.put(Buffer.from('snapshot that will be corrupted'));
  fs.writeFileSync(path.join(dataDir, snapshots.relativePath(rawHash)), 'not a gzip');

  await assert.rejects(snapshots.read(rawHash));
});

test('put rejects an uncompressed snapshot above the storage limit', async () => {
  const oversized = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);

  await assert.rejects(snapshots.put(oversized), { code: 'ERR_SNAPSHOT_TOO_LARGE' });
});

test('read rejects a gzip that expands above the snapshot limit', async () => {
  const oversized = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x61);
  const rawHash = crypto.createHash('sha256').update(oversized).digest('hex');
  const storedPath = path.join(dataDir, snapshots.relativePath(rawHash));
  fs.mkdirSync(path.dirname(storedPath), { recursive: true });
  fs.writeFileSync(storedPath, zlib.gzipSync(oversized));

  await assert.rejects(snapshots.read(rawHash), { code: 'ERR_SNAPSHOT_TOO_LARGE' });
});

test('read rejects valid gzip bytes stored under the wrong content hash', async () => {
  const rawHash = await snapshots.put(Buffer.from('expected snapshot bytes'));
  fs.writeFileSync(
    path.join(dataDir, snapshots.relativePath(rawHash)),
    zlib.gzipSync(Buffer.from('different but valid snapshot bytes')),
  );

  await assert.rejects(snapshots.read(rawHash), { code: 'ERR_SNAPSHOT_HASH_MISMATCH' });
});
