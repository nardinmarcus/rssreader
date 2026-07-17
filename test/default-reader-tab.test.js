const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { resolveDataPaths } = require('../lib/data-paths');

const storePath = path.join(__dirname, '..', 'lib', 'store.js');
const dataDirs = [];

test.after(() => {
  for (const dataDir of dataDirs) fs.rmSync(dataDir, { recursive: true, force: true });
});

function testDataDir(prefix) {
  const dataDir = createTempDataDir(prefix);
  dataDirs.push(dataDir);
  return dataDir;
}

function runStore(dataDir, source = '') {
  return execFileSync(process.execPath, ['-e', `
    const store = require(process.argv[1]);
    ${source}
  `, storePath], {
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

function openDatabase(dataDir) {
  return new DatabaseSync(resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir }).databaseFile);
}

function readerTabColumn(database) {
  return database.prepare("PRAGMA table_info('users')").all()
    .find(column => column.name === 'default_reader_tab');
}

function createLegacyUsersTable(database, { includeReaderTab = true } = {}) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      avatar_url TEXT,
      links_json TEXT,
      ${includeReaderTab ? "default_reader_tab TEXT NOT NULL DEFAULT 'rewrite'," : ''}
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
  `);
}

test('fresh and added default_reader_tab columns default to original', () => {
  const freshDataDir = testDataDir('default-reader-fresh-');
  runStore(freshDataDir);
  const freshDatabase = openDatabase(freshDataDir);
  try {
    assert.equal(readerTabColumn(freshDatabase)?.dflt_value, "'original'");
  } finally {
    freshDatabase.close();
  }

  const legacyDataDir = testDataDir('default-reader-add-column-');
  const legacyDatabase = openDatabase(legacyDataDir);
  createLegacyUsersTable(legacyDatabase, { includeReaderTab: false });
  legacyDatabase.close();

  runStore(legacyDataDir);
  const migratedDatabase = openDatabase(legacyDataDir);
  try {
    assert.equal(readerTabColumn(migratedDatabase)?.dflt_value, "'original'");
  } finally {
    migratedDatabase.close();
  }
});

test('new users override a legacy rewrite default while existing preferences are preserved', () => {
  const dataDir = testDataDir('default-reader-legacy-default-');
  const database = openDatabase(dataDir);
  createLegacyUsersTable(database);
  database.exec(`
    INSERT INTO users (
      id, email, display_name, default_reader_tab, role,
      password_hash, password_salt, created_at, updated_at
    ) VALUES
      ('existing-rewrite', 'existing-rewrite@example.com', 'Existing Rewrite', 'rewrite', 'user', 'hash', 'salt', 1, 1),
      ('existing-original', 'existing-original@example.com', 'Existing Original', 'original', 'user', 'hash', 'salt', 1, 1),
      ('existing-invalid', 'existing-invalid@example.com', 'Existing Invalid', 'translation', 'user', 'hash', 'salt', 1, 1);
  `);
  database.close();

  const result = JSON.parse(runStore(dataDir, `
    const user = store.createUser({
      email: 'new-reader@example.com',
      password: 'password-123',
      displayName: 'New Reader',
    });
    const admin = store.ensureAdminUser({
      email: 'new-admin@example.com',
      password: 'password-123',
      displayName: 'New Admin',
    });
    const rewrite = store.updateUserProfile('existing-rewrite', { displayName: 'Rewrite Preserved' });
    const original = store.updateUserProfile('existing-original', { displayName: 'Original Preserved' });
    const invalid = store.updateUserProfile('existing-invalid', { displayName: 'Invalid Normalized' });
    process.stdout.write(JSON.stringify({ user, admin, rewrite, original, invalid }));
  `));

  assert.equal(result.user.defaultReaderTab, 'original');
  assert.equal(result.admin.defaultReaderTab, 'original');
  assert.equal(result.rewrite.defaultReaderTab, 'rewrite');
  assert.equal(result.original.defaultReaderTab, 'original');
  assert.equal(result.invalid.defaultReaderTab, 'original');

  const verifiedDatabase = openDatabase(dataDir);
  try {
    assert.equal(readerTabColumn(verifiedDatabase)?.dflt_value, "'rewrite'", 'the legacy schema default remains unchanged');
    const preferences = Object.fromEntries(verifiedDatabase.prepare(`
      SELECT email, default_reader_tab
      FROM users
      ORDER BY email
    `).all().map(row => [row.email, row.default_reader_tab]));
    assert.equal(preferences['new-reader@example.com'], 'original');
    assert.equal(preferences['new-admin@example.com'], 'original');
    assert.equal(preferences['existing-rewrite@example.com'], 'rewrite');
    assert.equal(preferences['existing-original@example.com'], 'original');
    assert.equal(preferences['existing-invalid@example.com'], 'original');
  } finally {
    verifiedDatabase.close();
  }
});
