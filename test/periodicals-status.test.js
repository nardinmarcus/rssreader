const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPeriodicalsModule } = require('../lib/periodicals');

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

function fixtureDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      published_ts INTEGER DEFAULT 0,
      summary TEXT,
      content TEXT,
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE entry_translations (
      entry_id TEXT PRIMARY KEY,
      title_zh TEXT,
      summary_zh TEXT
    );
    CREATE TABLE source_preferences (
      source_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      editorial_priority TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE custom_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      site_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      labels_json TEXT NOT NULL DEFAULT '[]',
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertIssue(db, {
  id,
  cadence,
  periodKey,
  volumeNo,
  status = 'open',
  summaryStatus = 'fallback',
  revision = 0,
  contentHash = '',
  lastBuiltAt = null,
}) {
  db.prepare(`
    INSERT INTO periodical_issues (
      id, cadence, period_key, volume_no, period_start_at, period_end_at,
      status, revision, selection_version, summary_version, content_hash,
      summary_status, last_built_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 'importance-v1', 'summary-v1', ?, ?, ?, ?, ?)
  `).run(
    id,
    cadence,
    periodKey,
    volumeNo,
    NOW - 60_000,
    NOW + 60_000,
    revision,
    contentHash,
    summaryStatus,
    lastBuiltAt,
    NOW - 30_000,
    NOW - 10_000,
  );
  if (status !== 'open') {
    db.prepare('UPDATE periodical_issues SET status = ? WHERE id = ?').run(status, id);
  }
}

function insertJob(db, {
  id,
  issueId,
  status,
  createdAt,
  completedAt = null,
  candidateCount = 0,
  errorCode = null,
}) {
  db.prepare(`
    INSERT INTO periodical_build_jobs (
      id, issue_id, source_input_hash, input_hash, as_of_at,
      selection_version, score_config_json, summary_version, trigger_reason,
      status, error_code, candidate_count, source_count,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'importance-v1', '{}', 'summary-v1', 'test', ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    issueId,
    `source-${id}`,
    `input-${id}`,
    NOW,
    status,
    errorCode,
    candidateCount,
    createdAt,
    completedAt || createdAt,
    completedAt,
  );
}

test('admin status projects safe persisted issue and build health from SQLite', () => {
  const db = fixtureDatabase();
  const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });

  insertIssue(db, {
    id: 'daily-current', cadence: 'daily', periodKey: '2026-08-01', volumeNo: 2,
    revision: 2, contentHash: 'daily-hash', lastBuiltAt: NOW - 5_000,
  });
  insertIssue(db, {
    id: 'daily-older', cadence: 'daily', periodKey: '2026-07-31', volumeNo: 1,
    status: 'frozen', revision: 1, contentHash: 'older-hash', lastBuiltAt: NOW - 90_000,
  });
  insertIssue(db, {
    id: 'weekly-current', cadence: 'weekly', periodKey: '2026-W31', volumeNo: 1,
    status: 'finalizing', summaryStatus: 'generated', revision: 1,
    contentHash: 'weekly-hash', lastBuiltAt: NOW - 20_000,
  });
  insertIssue(db, {
    id: 'monthly-current', cadence: 'monthly', periodKey: '2026-07', volumeNo: 1,
    status: 'frozen', revision: 1, contentHash: 'monthly-hash', lastBuiltAt: NOW - 30_000,
  });

  db.prepare(`
    INSERT INTO periodical_themes (id, issue_id, theme_key, title, display_order)
    VALUES ('theme-1', 'daily-current', 'theme', 'Theme', 0)
  `).run();
  db.prepare(`
    INSERT INTO periodical_events (
      id, issue_id, theme_id, event_key, title, effective_at, first_seen_at,
      last_seen_at, importance_score, score_json, cluster_json, display_order
    ) VALUES ('event-1', 'daily-current', 'theme-1', 'event', 'Event', ?, ?, ?, 80, '{}', '{}', 0)
  `).run(NOW, NOW, NOW);

  insertJob(db, {
    id: 'success-old', issueId: 'daily-current', status: 'succeeded',
    createdAt: NOW - 50_000, completedAt: NOW - 40_000, candidateCount: 9,
  });
  insertJob(db, {
    id: 'success-latest', issueId: 'daily-current', status: 'succeeded',
    createdAt: NOW - 30_000, completedAt: NOW - 5_000, candidateCount: 4,
  });
  insertJob(db, {
    id: 'oldest-queued', issueId: 'weekly-current', status: 'queued',
    createdAt: NOW - 25_000, candidateCount: 3,
  });
  insertJob(db, {
    id: 'retrying', issueId: 'weekly-current', status: 'retry_wait',
    createdAt: NOW - 10_000, candidateCount: 3, errorCode: 'ERR_PERIODICAL_AI_DEFERRED',
  });
  insertJob(db, {
    id: 'unsafe-failure', issueId: 'monthly-current', status: 'failed',
    createdAt: NOW - 8_000, errorCode: 'provider raw response: secret body',
  });

  const status = periodicals.getAdminStatus({ now: NOW });

  assert.equal(status.mode, 'shadow');
  assert.equal(status.generatedAt, NOW);
  assert.deepEqual(status.issues.counts, { open: 1, finalizing: 1, frozen: 2 });
  assert.deepEqual(status.issues.latestByCadence.daily, {
    issueId: 'daily-current',
    cadence: 'daily',
    periodKey: '2026-08-01',
    status: 'open',
    revision: 2,
    contentHash: 'daily-hash',
    summaryStatus: 'fallback',
    lastBuiltAt: NOW - 5_000,
    frozenAt: null,
    candidateCount: 4,
    eventCount: 1,
  });
  assert.equal(status.issues.latestByCadence.weekly.issueId, 'weekly-current');
  assert.equal(status.issues.latestByCadence.weekly.candidateCount, 3);
  assert.equal(status.issues.latestByCadence.monthly.issueId, 'monthly-current');
  assert.deepEqual(status.issues.totals, {
    fallback: 3,
    candidates: 7,
    events: 1,
  });
  assert.deepEqual(status.jobs.counts, {
    queued: 1,
    running: 0,
    retryWait: 1,
    succeeded: 2,
    failed: 1,
    superseded: 0,
  });
  assert.deepEqual(status.jobs.oldestTask, {
    jobId: 'oldest-queued',
    issueId: 'weekly-current',
    status: 'queued',
    ageMs: 25_000,
    attemptCount: 0,
    nextRetryAt: null,
    leaseExpiresAt: null,
    errorCode: null,
    candidateCount: 3,
  });
  assert.equal(status.jobs.latestSuccess.jobId, 'success-latest');
  assert.equal(status.jobs.latestSuccess.completedAt, NOW - 5_000);
  assert.deepEqual(status.jobs.errorsByCode, {
    ERR_PERIODICAL_AI_DEFERRED: 1,
    ERR_PERIODICAL_BUILD: 1,
  });
  assert.doesNotMatch(JSON.stringify(status), /provider raw response|secret body/i);

  db.close();
});
