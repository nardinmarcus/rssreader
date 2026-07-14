const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');
const { resolveDataDir } = require('./data-paths');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const DATA_DIR = resolveDataDir();
const pendingPuts = new Map();
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function snapshotTooLargeError() {
  const error = new RangeError(`snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  error.code = 'ERR_SNAPSHOT_TOO_LARGE';
  return error;
}

function snapshotHashMismatchError() {
  const error = new Error('snapshot content hash does not match its address');
  error.code = 'ERR_SNAPSHOT_HASH_MISMATCH';
  return error;
}

function normalizedHash(rawHash) {
  const value = String(rawHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid raw hash');
  return value;
}

function relativePath(rawHash) {
  const hash = normalizedHash(rawHash);
  return path.posix.join('raw', 'sha256', hash.slice(0, 2), hash.slice(2, 4), `${hash}.html.gz`);
}

function absolutePath(rawHash) {
  return path.join(DATA_DIR, ...relativePath(rawHash).split('/'));
}

async function writeSnapshot(rawHash, buffer) {
  const destination = absolutePath(rawHash);
  try {
    await read(rawHash);
    return rawHash;
  } catch (error) {
    const integrityFailure = error.code === 'ENOENT'
      || error.code === 'ERR_SNAPSHOT_HASH_MISMATCH'
      || error.code === 'ERR_SNAPSHOT_TOO_LARGE'
      || String(error.code || '').startsWith('Z_');
    if (!integrityFailure) throw error;
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.promises.open(temporary, 'wx');
    await handle.writeFile(await gzip(buffer));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return rawHash;
}

async function put(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('snapshot body must be a Buffer');
  if (buffer.length > MAX_SNAPSHOT_BYTES) throw snapshotTooLargeError();
  const rawHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const pending = pendingPuts.get(rawHash);
  if (pending) return pending;
  const writing = writeSnapshot(rawHash, buffer);
  pendingPuts.set(rawHash, writing);
  try {
    return await writing;
  } finally {
    if (pendingPuts.get(rawHash) === writing) pendingPuts.delete(rawHash);
  }
}

async function read(rawHash) {
  const expectedHash = normalizedHash(rawHash);
  try {
    const buffer = await gunzip(
      await fs.promises.readFile(absolutePath(expectedHash)),
      { maxOutputLength: MAX_SNAPSHOT_BYTES },
    );
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== expectedHash) throw snapshotHashMismatchError();
    return buffer;
  } catch (error) {
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') throw snapshotTooLargeError();
    throw error;
  }
}

module.exports = {
  put,
  read,
  relativePath,
};
