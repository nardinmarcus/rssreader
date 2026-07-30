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
  assert.match(envExample, /^PERIODICAL_SWEEP_INTERVAL_MS=3600000$/m);
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
      'idx_entries_periodical_candidates',
    ]) assert.equal(indexes.has(index), true, `missing index ${index}`);

    const candidateIndexSql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_entries_periodical_candidates'
    `).get().sql;
    assert.match(
      candidateIndexSql,
      /CASE\s+WHEN\s+published_ts\s*>\s*0\s+THEN\s+published_ts\s+ELSE\s+created_at\s+END/i,
    );
    const candidateIndexKeys = db.prepare('PRAGMA index_xinfo(idx_entries_periodical_candidates)').all()
      .filter(column => column.key === 1);
    assert.equal(candidateIndexKeys.some(column => column.name === 'source_id'), true);
    assert.equal(candidateIndexKeys.some(column => column.cid === -2), true, 'missing effective timestamp expression');

    const buildJobColumns = new Set(db.prepare('PRAGMA table_info(periodical_build_jobs)').all()
      .map(column => column.name));
    for (const column of [
      'source_input_hash',
      'input_hash',
      'as_of_at',
      'candidate_cutoff_at',
      'selection_version',
      'score_config_json',
      'summary_version',
      'status',
      'attempt_count',
      'lease_token',
      'lease_expires_at',
      'next_retry_at',
      'error_code',
      'candidate_count',
      'source_count',
    ]) assert.equal(buildJobColumns.has(column), true, `missing build job column ${column}`);
    const buildJobSql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'periodical_build_jobs'
    `).get().sql;
    for (const state of ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded']) {
      assert.match(buildJobSql, new RegExp(`'${state}'`));
    }

    const triggers = new Set(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'reject_frozen_periodical_%'
    `).all().map(row => row.name));
    for (const target of ['issue', 'theme', 'event', 'evidence', 'input']) {
      for (const operation of ['insert', 'update', 'delete']) {
        const trigger = `reject_frozen_periodical_${target}_${operation}`;
        assert.equal(triggers.has(trigger), true, `missing frozen guard ${trigger}`);
      }
    }

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
