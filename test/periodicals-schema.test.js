const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.resolve(__dirname, '..');
const storePath = path.join(projectDir, 'lib', 'store.js');

test('periodicals mode is documented as off by default', () => {
  const envExample = fs.readFileSync(path.join(projectDir, '.env.example'), 'utf8');
  assert.match(envExample, /^PERIODICALS_MODE=off$/m);
});

function initializeStore(dataDir) {
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(storePath)})`], {
    cwd: projectDir,
    env: {
      ...process.env,
      NAMOO_READER_DATA_DIR: dataDir,
      PERIODICALS_MODE: 'off',
    },
    stdio: 'pipe',
  });
}

test('periodical schema initializes twice without rewriting existing entry data', () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-schema-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    const first = new DatabaseSync(databaseFile);
    first.prepare(`
      INSERT INTO entries (id, source_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('existing-entry', 'existing-source', 'Existing title', 10, 10);
    first.close();

    initializeStore(dataDir);

    const db = new DatabaseSync(databaseFile);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of [
      'periodical_issues',
      'periodical_themes',
      'periodical_events',
      'periodical_event_evidence',
      'periodical_issue_inputs',
      'periodical_build_jobs',
    ]) assert.equal(tables.has(table), true, `missing table ${table}`);

    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name));
    for (const index of [
      'idx_periodical_issues_cadence_period',
      'idx_periodical_issues_status_end',
      'idx_periodical_themes_issue_order',
      'idx_periodical_events_issue_order',
      'idx_periodical_evidence_event_order',
      'idx_periodical_issue_inputs_issue_order',
      'idx_periodical_build_jobs_status_wake',
    ]) assert.equal(indexes.has(index), true, `missing index ${index}`);

    assert.deepEqual(
      { ...db.prepare('SELECT id, source_id, title, created_at, updated_at FROM entries WHERE id = ?').get('existing-entry') },
      { id: 'existing-entry', source_id: 'existing-source', title: 'Existing title', created_at: 10, updated_at: 10 },
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
