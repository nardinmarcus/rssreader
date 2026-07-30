const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  compileOpenDaily,
  createPeriodicalsModule,
} = require('../lib/periodicals');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');

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

function seedCandidate(db, overrides = {}) {
  const sourceId = overrides.sourceId || 'durable-source';
  db.prepare(`
    INSERT INTO custom_sources (
      id, name, feed_url, category, labels_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'article', '["产品"]', ?, ?)
  `).run(
    sourceId,
    overrides.sourceName || 'Durable Source',
    `https://${sourceId}.example/feed.xml`,
    NOW - 1000,
    NOW - 1000,
  );
  db.prepare(`
    INSERT INTO source_preferences (
      source_id, enabled, editorial_priority, display_order, updated_at
    ) VALUES (?, 1, 'high', 0, '2026-07-30T04:00:00.000Z')
  `).run(sourceId);
  db.prepare(`
    INSERT INTO entries (
      id, source_id, title, link, published_ts, summary, content,
      content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.entryId || 'durable-entry',
    sourceId,
    overrides.title || 'Durable orchestration',
    overrides.link || 'https://durable-source.example/posts/one',
    overrides.publishedTs || NOW - 1000,
    overrides.summary || 'A durable candidate summary.',
    overrides.content || '<p>Durable candidate body.</p>',
    overrides.contentHash || 'durable-content-v1',
    overrides.createdAt || NOW - 1000,
    overrides.updatedAt || NOW - 1000,
  );
}

test('source input identity coalesces identical checks and enqueues only changed SQLite input', () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });

    const first = periodicals.syncOpenDaily({ now: NOW, trigger: 'rss-refresh' });
    const duplicate = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'hourly-sweep',
    });
    const unchangedRows = db.prepare(`
      SELECT
        issue.revision,
        (SELECT COUNT(*) FROM periodical_build_jobs) AS job_count,
        (SELECT COUNT(*) FROM periodical_build_jobs
          WHERE status IN ('queued', 'running', 'retry_wait')) AS active_count
      FROM periodical_issues AS issue
      WHERE issue.id = 'periodical:daily:2026-07-30'
    `).get();

    assert.deepEqual({ ...unchangedRows }, { revision: 0, job_count: 1, active_count: 1 });
    assert.equal(first.action, 'queued');
    assert.equal(duplicate.action, 'noop');
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(duplicate.sourceInputHash, first.sourceInputHash);

    db.prepare(`
      UPDATE entries
      SET summary = 'Changed summary.', content_hash = 'durable-content-v2', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 20);
    const changed = periodicals.syncOpenDaily({ now: NOW + 20, trigger: 'rss-refresh' });
    const changedRows = db.prepare(`
      SELECT
        issue.revision,
        COUNT(*) AS job_count,
        SUM(job.status = 'queued') AS queued_count,
        SUM(job.status = 'superseded') AS superseded_count
      FROM periodical_issues AS issue
      JOIN periodical_build_jobs AS job ON job.issue_id = issue.id
      WHERE issue.id = 'periodical:daily:2026-07-30'
    `).get();

    assert.deepEqual({ ...changedRows }, {
      revision: 0,
      job_count: 2,
      queued_count: 1,
      superseded_count: 1,
    });
    assert.equal(changed.action, 'queued');
    assert.notEqual(changed.job.id, first.job.id);
    assert.notEqual(changed.sourceInputHash, first.sourceInputHash);
    assert.notEqual(changed.inputHash, first.inputHash);
  } finally {
    db.close();
  }
});

test('the explicit behavior switch participates in source identity without adding wall clock', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const disabled = createPeriodicalsModule({
      db,
      mode: 'shadow',
      behaviorSignalEnabled: false,
      logger: () => {},
    }).syncOpenDaily({ now: NOW, trigger: 'test' });
    const enabled = createPeriodicalsModule({
      db,
      mode: 'shadow',
      behaviorSignalEnabled: true,
      logger: () => {},
    }).syncOpenDaily({ now: NOW + 1, trigger: 'test' });

    assert.notEqual(enabled.sourceInputHash, disabled.sourceInputHash);
    assert.notEqual(enabled.inputHash, disabled.inputHash);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_build_jobs
    `).get().count, 2);
    assert.equal((await createPeriodicalsModule({
      db,
      mode: 'shadow',
      behaviorSignalEnabled: true,
      logger: () => {},
    }).runNextBuild({ now: NOW + 2 })).status, 'succeeded');
  } finally {
    db.close();
  }
});

test('identical source input avoids compiler work and changed input alone advances revision', async () => {
  const db = fixtureDatabase();
  const logs = [];
  try {
    seedCandidate(db);
    let compilerCalls = 0;
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      logger: line => logs.push(line),
    });

    const queued = periodicals.syncOpenDaily({ now: NOW, trigger: 'rss-refresh' });
    const duplicate = periodicals.syncOpenDaily({ now: NOW + (60 * 60 * 1000), trigger: 'hourly-sweep' });

    assert.equal(queued.action, 'queued');
    assert.equal(queued.job.status, 'queued');
    assert.equal(duplicate.action, 'noop');
    assert.equal(duplicate.job.id, queued.job.id);
    assert.equal(duplicate.sourceInputHash, queued.sourceInputHash);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM periodical_build_jobs').get().count, 1);

    const first = await periodicals.runNextBuild({
      now: NOW + 10,
      compileIssue(input) {
        compilerCalls += 1;
        return compileOpenDaily(input);
      },
    });
    const firstIssue = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(first.status, 'succeeded');
    assert.equal(compilerCalls, 1);
    assert.equal(firstIssue.issue.revision, 1);
    assert.equal(firstIssue.issue.lastSuccessfulAt, NOW + 10);
    assert.equal(firstIssue.issue.updateDelayed, false);

    const afterSuccess = periodicals.syncOpenDaily({
      now: NOW + (2 * 60 * 60 * 1000),
      trigger: 'hourly-sweep',
    });
    assert.equal(afterSuccess.action, 'noop');
    assert.equal(await periodicals.runNextBuild({ now: NOW + 20 }), null);
    assert.equal(compilerCalls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM periodical_build_jobs').get().count, 1);

    db.prepare(`
      UPDATE entries
      SET summary = 'Changed summary.', content_hash = 'durable-content-v2', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 30);
    const changed = periodicals.syncOpenDaily({ now: NOW + 30, trigger: 'rss-refresh' });
    assert.equal(changed.action, 'queued');
    assert.notEqual(changed.sourceInputHash, queued.sourceInputHash);
    assert.notEqual(changed.inputHash, queued.inputHash);

    const second = await periodicals.runNextBuild({
      now: NOW + 40,
      compileIssue(input) {
        compilerCalls += 1;
        return compileOpenDaily(input);
      },
    });
    const secondIssue = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
    assert.equal(second.status, 'succeeded');
    assert.equal(compilerCalls, 2);
    assert.equal(secondIssue.issue.revision, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM periodical_build_jobs').get().count, 2);

    const safeLog = logs.join('\n');
    assert.match(safeLog, /issue=periodical:daily:2026-07-30/);
    assert.match(safeLog, /input=[a-f0-9]{12}/);
    assert.match(safeLog, /state=succeeded/);
    assert.doesNotMatch(safeLog, /Durable orchestration|candidate body|Changed summary|durable-content-v[12]/);
  } finally {
    db.close();
  }
});

test('a recurring source snapshot after an intervening revision creates a fresh build identity', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });

    const firstA = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW + 1 });

    db.prepare(`
      UPDATE entries
      SET summary = 'Snapshot B.', content_hash = 'durable-content-b', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 10);
    const buildB = periodicals.syncOpenDaily({ now: NOW + 10, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW + 11 });

    db.prepare(`
      UPDATE entries
      SET summary = 'A durable candidate summary.', content_hash = 'durable-content-v1', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 20);
    const secondA = periodicals.syncOpenDaily({ now: NOW + 20, trigger: 'test' });

    assert.equal(secondA.action, 'queued');
    assert.equal(secondA.sourceInputHash, firstA.sourceInputHash);
    assert.notEqual(secondA.inputHash, firstA.inputHash);
    assert.notEqual(secondA.job.id, firstA.job.id);
    assert.notEqual(secondA.job.id, buildB.job.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM periodical_build_jobs').get().count, 3);

    await periodicals.runNextBuild({ now: NOW + 21 });
    assert.equal(periodicals.getIssue({
      cadence: 'daily',
      periodKey: '2026-07-30',
    }).issue.revision, 3);
  } finally {
    db.close();
  }
});

test('an identical successful Issue from the compiler baseline remains a no-op without job history', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'baseline' });
    await periodicals.runNextBuild({ now: NOW });
    db.prepare('DELETE FROM periodical_build_jobs').run();

    const duplicate = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'startup',
    });

    assert.equal(duplicate.action, 'noop');
    assert.equal(duplicate.job, null);
    assert.equal(duplicate.revision, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM periodical_build_jobs').get().count, 0);
    assert.equal(db.prepare(`
      SELECT revision FROM periodical_issues WHERE id = 'periodical:daily:2026-07-30'
    `).get().revision, 1);
  } finally {
    db.close();
  }
});

test('SQLite claim, renew, stale lease recovery, and durable retry timing are fenced', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const queued = periodicals.syncOpenDaily({ now: NOW, trigger: 'startup' });

    const firstClaim = periodicals.claimNextBuild(NOW, 100);
    assert.equal(firstClaim.jobId, queued.job.id);
    assert.equal(firstClaim.status, 'running');
    assert.equal(firstClaim.attemptCount, 1);
    assert.equal(firstClaim.leaseExpiresAt, NOW + 100);
    assert.equal(periodicals.claimNextBuild(NOW + 99, 100), null);
    assert.equal(periodicals.renewBuildLease(firstClaim.jobId, 'wrong-token', NOW + 50, 100), false);
    assert.equal(periodicals.renewBuildLease(
      firstClaim.jobId,
      firstClaim.leaseToken,
      NOW + 50,
      100,
    ), true);
    assert.equal(periodicals.claimNextBuild(NOW + 149, 100), null);

    const recovered = periodicals.claimNextBuild(NOW + 151, 100);
    assert.equal(recovered.jobId, queued.job.id);
    assert.notEqual(recovered.leaseToken, firstClaim.leaseToken);
    assert.equal(recovered.attemptCount, 2);

    db.prepare(`
      UPDATE periodical_build_jobs
      SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, attempt_count = 0
      WHERE id = ?
    `).run(queued.job.id);
    const retry = await periodicals.runNextBuild({
      now: NOW + 200,
      compileIssue() {
        const error = new Error('provider unavailable');
        error.statusCode = 503;
        throw error;
      },
    });

    assert.equal(retry.status, 'retry_wait');
    assert.equal(retry.nextRetryAt, NOW + 1200);
    assert.equal(periodicals.getNextBuildWakeAt(), NOW + 1200);
    assert.equal(periodicals.hasActiveBuildJobs(), true);
    assert.equal(await periodicals.runNextBuild({ now: NOW + 1199 }), null);

    const succeeded = await periodicals.runNextBuild({ now: NOW + 1200 });
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(periodicals.hasActiveBuildJobs(), false);
  } finally {
    db.close();
  }
});

test('retry timing reaches the durable failed state after the bounded attempt budget', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    const unavailable = () => {
      const error = new Error('private provider response');
      error.statusCode = 503;
      throw error;
    };

    const first = await periodicals.runNextBuild({ now: NOW, compileIssue: unavailable });
    const second = await periodicals.runNextBuild({
      now: NOW + 1000,
      compileIssue: unavailable,
    });
    const terminal = await periodicals.runNextBuild({
      now: NOW + 6000,
      compileIssue: unavailable,
    });

    assert.deepEqual(
      [first.status, first.nextRetryAt, second.status, second.nextRetryAt],
      ['retry_wait', NOW + 1000, 'retry_wait', NOW + 6000],
    );
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.attemptCount, 3);
    assert.equal(terminal.nextRetryAt, null);
    assert.equal(terminal.errorCode, 'HTTP_503');
    assert.equal(terminal.completedAt, NOW + 6000);
    assert.equal(periodicals.hasActiveBuildJobs(), false);
  } finally {
    db.close();
  }
});

test('obsolete persisted algorithm material supersedes before compile and is repaired on reopen', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const queued = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    db.prepare(`
      UPDATE periodical_build_jobs SET score_config_json = '{"obsolete":true}' WHERE id = ?
    `).run(queued.job.id);
    let compilerCalls = 0;

    const obsolete = await periodicals.runNextBuild({
      now: NOW + 1,
      compileIssue() {
        compilerCalls += 1;
        return null;
      },
    });
    assert.equal(obsolete.status, 'superseded');
    assert.equal(compilerCalls, 0);

    const repaired = periodicals.syncOpenDaily({ now: NOW, trigger: 'startup' });
    assert.equal(repaired.action, 'queued');
    assert.equal(repaired.job.id, queued.job.id);
    assert.notEqual(repaired.job.scoreConfigJson, '{"obsolete":true}');
    assert.equal((await periodicals.runNextBuild({ now: NOW + 2 })).status, 'succeeded');
  } finally {
    db.close();
  }
});

test('new input supersedes a running stale build before it can publish', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const original = periodicals.syncOpenDaily({ now: NOW, trigger: 'rss-refresh' });
    let releaseCompile;
    let reportStarted;
    const compileStarted = new Promise(resolve => { reportStarted = resolve; });
    const compileReleased = new Promise(resolve => { releaseCompile = resolve; });

    const staleRun = periodicals.runNextBuild({
      now: () => NOW + 100,
      async compileIssue(input) {
        reportStarted();
        await compileReleased;
        return compileOpenDaily(input);
      },
    });
    await compileStarted;

    db.prepare(`
      UPDATE entries
      SET title = 'New durable input', content_hash = 'durable-content-v2', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 50);
    const replacement = periodicals.syncOpenDaily({ now: NOW + 50, trigger: 'rss-refresh' });
    assert.equal(replacement.action, 'queued');
    assert.notEqual(replacement.job.id, original.job.id);
    assert.equal(periodicals.getBuildJob(original.job.id).status, 'superseded');

    releaseCompile();
    const stale = await staleRun;
    assert.equal(stale.status, 'superseded');
    assert.equal(db.prepare(`
      SELECT revision FROM periodical_issues WHERE id = 'periodical:daily:2026-07-30'
    `).get().revision, 0);

    const fresh = await periodicals.runNextBuild({ now: NOW + 100 });
    assert.equal(fresh.status, 'succeeded');
    const issue = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
    assert.equal(issue.issue.revision, 1);
    assert.equal(issue.events[0].title, 'New durable input');
  } finally {
    db.close();
  }
});

test('failed atomic child replacement retains the last successful revision and exposes delay state', async () => {
  const db = fixtureDatabase();
  try {
    seedCandidate(db);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'startup' });
    await periodicals.runNextBuild({ now: NOW + 10 });
    const before = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    db.prepare(`
      UPDATE entries
      SET summary = 'A changed input that must not partially publish.',
          content_hash = 'durable-content-v2', updated_at = ?
      WHERE id = 'durable-entry'
    `).run(NOW + 20);
    periodicals.syncOpenDaily({ now: NOW + 20, trigger: 'rss-refresh' });
    db.exec(`
      CREATE TRIGGER reject_periodical_event_insert
      BEFORE INSERT ON periodical_events
      BEGIN
        SELECT RAISE(ABORT, 'injected child write failure');
      END;
    `);

    const failed = await periodicals.runNextBuild({ now: NOW + 30 });
    const after = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(failed.status, 'retry_wait');
    assert.equal(after.issue.revision, 1);
    assert.equal(after.issue.contentHash, before.issue.contentHash);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.issue.lastSuccessfulAt, NOW + 10);
    assert.equal(after.issue.updateDelayed, true);
    assert.equal(after.issue.updateState, 'retry_wait');
  } finally {
    db.close();
  }
});
