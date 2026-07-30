const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createPeriodicalsModule } = require('../lib/periodicals');

const PERIOD_END = Date.parse('2026-07-29T16:00:00.000Z');
const OPEN_BUILD_AT = PERIOD_END - (60 * 60 * 1000);
const FINALIZATION_DEADLINE = PERIOD_END + (15 * 60 * 1000);
const FINALIZATION_CHILD_TIMEOUT_MS = 10_000;

function fixtureDatabase(databasePath = ':memory:') {
  const db = new DatabaseSync(databasePath);
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
  db.prepare(`
    INSERT INTO custom_sources (
      id, name, feed_url, category, labels_json, created_at, updated_at
    ) VALUES ('final-source', 'Final Source', 'https://final.example/feed.xml',
      'article', '["产品"]', ?, ?)
  `).run(OPEN_BUILD_AT, OPEN_BUILD_AT);
  db.prepare(`
    INSERT INTO source_preferences (
      source_id, enabled, editorial_priority, display_order, updated_at
    ) VALUES ('final-source', 1, 'high', 0, '2026-07-29T15:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO entries (
      id, source_id, title, link, published_ts, summary, content,
      content_hash, created_at, updated_at
    ) VALUES ('final-entry', 'final-source', 'Final daily entry',
      'https://final.example/posts/one', ?, 'Final summary.', '<p>Final body.</p>',
      'final-content-v1', ?, ?)
  `).run(OPEN_BUILD_AT, OPEN_BUILD_AT, OPEN_BUILD_AT);
  return db;
}

function generatedSummary({ evidencePackage }) {
  return {
    provider: 'test-provider',
    model: 'test-model',
    content: JSON.stringify({
      overview: '本期完成最终定稿。所有内容均来自已保存证据。',
      events: evidencePackage.events.map(event => ({
        id: event.id,
        themeKey: 'products_tools',
        title: event.evidence[0].title,
        summary: '本事件保留最终证据快照。',
        evidenceIds: event.evidence.map(item => item.id),
      })),
      themes: [{
        themeKey: 'products_tools',
        trendNote: '本期产品与工具主题完成定稿。',
      }],
    }),
  };
}

function assertFrozenMutationRejected(db, sql, parameters = []) {
  db.exec('SAVEPOINT frozen_mutation_probe');
  try {
    assert.throws(
      () => db.prepare(sql).run(...parameters),
      /frozen periodical is immutable/,
    );
  } finally {
    db.exec('ROLLBACK TO frozen_mutation_probe');
    db.exec('RELEASE frozen_mutation_probe');
  }
}

function assertChildProcessPassed(child) {
  if (!child.error && child.status === 0) return;
  const detail = [
    child.error && `${child.error.code}: ${child.error.message}`,
    child.stderr,
    child.stdout,
  ].filter(Boolean).join('\n');
  throw new Error(`child finalization failed: ${detail}`);
}

function freezeQueuedFinalizationInChild(databasePath) {
  const child = spawnSync(process.execPath, [
    '-e',
    `
      const { DatabaseSync } = require('node:sqlite');
      const { createPeriodicalsModule } = require(process.argv[2]);
      (async () => {
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        const periodicals = createPeriodicalsModule({
          db,
          mode: 'shadow',
          logger: () => {},
        });
        const job = await periodicals.runNextBuild({ now: Number(process.argv[3]) });
        if (!job || job.status !== 'succeeded') {
          throw new Error(\`unexpected finalization status: \${job && job.status}\`);
        }
        db.close();
      })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
    databasePath,
    require.resolve('../lib/periodicals'),
    String(FINALIZATION_DEADLINE),
  ], {
    encoding: 'utf8',
    timeout: FINALIZATION_CHILD_TIMEOUT_MS,
  });
  assertChildProcessPassed(child);
}

function interleavingReadDatabase(db, onIssueRead) {
  let armed = false;
  return {
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!armed || !/FROM periodical_issues\s+WHERE cadence = \? AND period_key = \?/.test(sql)) {
        return statement;
      }
      return {
        get(...parameters) {
          const issue = statement.get(...parameters);
          if (armed) {
            armed = false;
            onIssueRead();
          }
          return issue;
        },
      };
    },
    get isTransaction() {
      return db.isTransaction;
    },
    arm() {
      armed = true;
    },
  };
}

function faultingExecDatabase(db) {
  let nextFailure = null;
  return {
    exec(sql) {
      if (sql === nextFailure) {
        nextFailure = null;
        const error = new Error(`injected cleanup failure: ${sql}`);
        error.code = 'SQLITE_IOERR';
        throw error;
      }
      return db.exec(sql);
    },
    prepare(sql) {
      return db.prepare(sql);
    },
    get isTransaction() {
      return db.isTransaction;
    },
    failNext(sql) {
      nextFailure = sql;
    },
  };
}

test('Shanghai midnight moves the previous successful Daily into finalizing without hiding its revision', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    const before = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    const finalized = periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    const during = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(finalized.issues[0].action, 'queued');
    assert.equal(during.issue.status, 'finalizing');
    assert.equal(during.issue.revision, before.issue.revision);
    assert.equal(during.issue.contentHash, before.issue.contentHash);
    assert.deepEqual(during.events, before.events);
    assert.deepEqual(during.evidence, before.evidence);
  } finally {
    db.close();
  }
});

test('detail read uses one SQLite snapshot across a concurrent finalizing-to-frozen commit', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'namoo-periodical-read-snapshot-'));
  const databasePath = path.join(dataDir, 'qmreader.sqlite');
  const db = fixtureDatabase(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    const completeFinalizingRevision = periodicals.getIssue({
      cadence: 'daily',
      periodKey: '2026-07-29',
    });

    let childFinalizations = 0;
    const interleavingDb = interleavingReadDatabase(db, () => {
      childFinalizations += 1;
      freezeQueuedFinalizationInChild(databasePath);
    });
    const concurrentReader = createPeriodicalsModule({
      db: interleavingDb,
      mode: 'shadow',
      logger: () => {},
    });
    interleavingDb.arm();

    const observed = concurrentReader.getIssue({
      cadence: 'daily',
      periodKey: '2026-07-29',
    });
    const committedFrozenRevision = periodicals.getIssue({
      cadence: 'daily',
      periodKey: '2026-07-29',
    });

    assert.equal(childFinalizations, 1);
    assert.deepEqual(observed, completeFinalizingRevision);
    assert.equal(committedFrozenRevision.issue.status, 'frozen');
    assert.equal(
      committedFrozenRevision.issue.revision,
      completeFinalizingRevision.issue.revision + 1,
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('detail read owns only its savepoint for success and missing Issue paths', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });

    periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });
    assert.equal(db.isTransaction, false);
    assert.throws(
      () => periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-28' }),
      error => error.statusCode === 404,
    );
    assert.equal(db.isTransaction, false);

    db.exec('BEGIN');
    db.prepare(`
      UPDATE custom_sources SET name = 'uncommitted outer write'
      WHERE id = 'final-source'
    `).run();
    periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });
    assert.equal(db.isTransaction, true);
    assert.throws(
      () => periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-28' }),
      error => error.statusCode === 404,
    );
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("SELECT name FROM custom_sources WHERE id = 'final-source'").get().name,
      'Final Source',
    );
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
});

test('frozen hash mismatch releases a top-level snapshot and preserves a caller transaction', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    db.exec(`
      DROP TRIGGER reject_frozen_periodical_event_update;
      UPDATE periodical_events SET summary = 'corrupted frozen summary';
    `);

    assert.throws(
      () => periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' }),
      error => error.code === 'ERR_PERIODICAL_CONTENT_HASH_MISMATCH',
    );
    assert.equal(db.isTransaction, false);

    db.exec('BEGIN');
    assert.throws(
      () => periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' }),
      error => error.code === 'ERR_PERIODICAL_CONTENT_HASH_MISMATCH',
    );
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(db.isTransaction, false);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
});

test('snapshot cleanup failure is a causal 503 and never ends the caller transaction', async t => {
  for (const cleanupStatement of [
    'ROLLBACK TO periodical_issue_read',
    'RELEASE periodical_issue_read',
  ]) {
    await t.test(cleanupStatement, async () => {
      const db = fixtureDatabase();
      try {
        const faultingDb = faultingExecDatabase(db);
        const periodicals = createPeriodicalsModule({
          db: faultingDb,
          mode: 'shadow',
          logger: () => {},
        });
        periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
        await periodicals.runNextBuild({ now: OPEN_BUILD_AT });

        db.exec('BEGIN');
        db.prepare(`
          UPDATE custom_sources SET name = 'uncommitted outer write'
          WHERE id = 'final-source'
        `).run();
        faultingDb.failNext(cleanupStatement);
        let observedError;
        assert.throws(
          () => periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-28' }),
          error => {
            observedError = error;
            return error.statusCode === 503
              && error.code === 'ERR_PERIODICAL_READ_SNAPSHOT_CLEANUP';
          },
        );
        assert.equal(observedError.cause.statusCode, 404);
        assert.match(observedError.cleanupErrors[0].message, /injected cleanup failure/);
        assert.equal(db.isTransaction, true);

        db.exec('ROLLBACK');
        assert.equal(db.isTransaction, false);
        assert.equal(
          db.prepare("SELECT name FROM custom_sources WHERE id = 'final-source'").get().name,
          'Final Source',
        );
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
      }
    });
  }
});

test('a timed-out finalization child is a NON_PASS', () => {
  const child = spawnSync(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ], {
    encoding: 'utf8',
    timeout: 50,
  });

  assert.equal(child.error && child.error.code, 'ETIMEDOUT');
  assert.throws(
    () => assertChildProcessPassed(child),
    /child finalization failed: ETIMEDOUT/,
  );
});

test('a successful final build freezes the previous Daily with period-end scoring', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    const before = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    const finalization = periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    const finalJob = await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(finalization.issues[0].job.asOfAt, PERIOD_END);
    assert.equal(finalJob.status, 'succeeded');
    assert.equal(frozen.issue.status, 'frozen');
    assert.equal(frozen.issue.revision, before.issue.revision + 1);
    assert.equal(frozen.issue.summaryStatus, 'generated');
    assert.equal(frozen.events[0].score.freshness.ageHours, 1);
    assert.equal(frozen.frozenAt, PERIOD_END + 2);
  } finally {
    db.close();
  }
});

test('finalization retries AI only inside the window and freezes deterministic fallback at the deadline', async () => {
  const db = fixtureDatabase();
  let aiCalls = 0;
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: async () => {
        aiCalls += 1;
        const error = new Error('AI is unavailable');
        error.code = 'ERR_AI_UNCONFIGURED';
        throw error;
      },
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    aiCalls = 0;

    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    const first = await periodicals.runNextBuild({ now: PERIOD_END + 1 });
    const second = await periodicals.runNextBuild({ now: PERIOD_END + 1001 });
    const third = await periodicals.runNextBuild({ now: PERIOD_END + 6001 });
    const waiting = await periodicals.runNextBuild({ now: FINALIZATION_DEADLINE - 1 });
    const deadline = await periodicals.runNextBuild({ now: FINALIZATION_DEADLINE });
    const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(first.status, 'retry_wait');
    assert.equal(second.status, 'retry_wait');
    assert.equal(third.status, 'retry_wait');
    assert.equal(third.nextRetryAt, FINALIZATION_DEADLINE);
    assert.equal(waiting, null);
    assert.equal(deadline.status, 'succeeded');
    assert.equal(aiCalls, 3);
    assert.equal(frozen.issue.status, 'frozen');
    assert.equal(frozen.issue.summaryStatus, 'fallback');
    assert.equal(frozen.frozenAt, FINALIZATION_DEADLINE);
  } finally {
    db.close();
  }
});

test('the finalization deadline rejects late AI output and prevents a repair attempt', async t => {
  for (const scenario of [
    {
      name: 'valid output that completes at the deadline',
      response: generatedSummary,
    },
    {
      name: 'invalid output that would otherwise start a repair attempt',
      response: () => ({
        provider: 'test-provider',
        model: 'test-model',
        content: '{',
      }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const db = fixtureDatabase();
      let clock = FINALIZATION_DEADLINE - 1;
      let aiCalls = 0;
      try {
        const seed = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
        seed.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
        await seed.runNextBuild({ now: OPEN_BUILD_AT });
        const periodicals = createPeriodicalsModule({
          db,
          mode: 'shadow',
          aiAdapter: async input => {
            aiCalls += 1;
            clock = FINALIZATION_DEADLINE;
            return scenario.response(input);
          },
          logger: () => {},
        });

        periodicals.finalizeDueIssues({ now: clock });
        const completed = await periodicals.runNextBuild({ now: () => clock });
        const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

        assert.equal(completed.status, 'succeeded');
        assert.equal(aiCalls, 1);
        assert.equal(frozen.issue.status, 'frozen');
        assert.equal(frozen.issue.summaryStatus, 'fallback');
        assert.equal(frozen.frozenAt, FINALIZATION_DEADLINE);
      } finally {
        db.close();
      }
    });
  }
});

test('SQLite rejects every Frozen Issue and child insert, update, and delete', async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('extra-entry', 'final-source', 'Out-of-period evidence',
        'https://final.example/posts/extra', ?, 'Extra summary.', '<p>Extra body.</p>',
        'extra-content-v1', ?, ?)
    `).run(PERIOD_END + 1, OPEN_BUILD_AT, OPEN_BUILD_AT);
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });
    const issueId = frozen.issue.id;
    const themeId = frozen.themes[0].id;
    const eventId = frozen.events[0].id;
    const evidenceEntryId = frozen.evidence[0].entryId;

    db.exec(`
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, status, revision,
        selection_version, summary_version, created_at, updated_at
      ) VALUES (
        'periodical:daily:2026-07-28', 'daily', '2026-07-28', 2, 'Asia/Shanghai',
        1, 2, 'open', 0, 'importance-v1', 'constrained-summary-v1', 1, 1
      );
      UPDATE periodical_issues
      SET status = 'frozen', frozen_at = 2
      WHERE id = 'periodical:daily:2026-07-28';
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, status, revision,
        selection_version, summary_version, created_at, updated_at
      ) VALUES (
        'periodical:weekly:2026-W31', 'weekly', '2026-W31', 1, 'Asia/Shanghai',
        1, 2, 'open', 0, 'importance-v1', 'constrained-summary-v1', 1, 1
      );
    `);
    db.prepare(`
      INSERT INTO periodical_issue_inputs (
        issue_id, daily_issue_id, daily_content_hash, display_order
      ) VALUES ('periodical:weekly:2026-W31', ?, ?, 0)
    `).run(issueId, frozen.issue.contentHash);
    db.exec(`
      UPDATE periodical_issues
      SET status = 'frozen', frozen_at = 2
      WHERE id = 'periodical:weekly:2026-W31'
    `);

    assertFrozenMutationRejected(db, `
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, status, revision,
        selection_version, summary_version, created_at, updated_at
      ) VALUES (
        'periodical:monthly:2026-07', 'monthly', '2026-07', 1, 'Asia/Shanghai',
        1, 2, 'frozen', 0, 'importance-v1', 'constrained-summary-v1', 1, 1
      )
    `);
    assertFrozenMutationRejected(
      db,
      'UPDATE periodical_issues SET overview = ? WHERE id = ?',
      ['mutated', issueId],
    );
    assertFrozenMutationRejected(db, 'DELETE FROM periodical_issues WHERE id = ?', [issueId]);

    assertFrozenMutationRejected(db, `
      INSERT INTO periodical_themes (
        id, issue_id, theme_key, title, trend_note, display_order
      ) VALUES (?, ?, 'research_models', 'Research', 'Mutation', 99)
    `, [`${issueId}:theme:mutation`, issueId]);
    assertFrozenMutationRejected(
      db,
      'UPDATE periodical_themes SET title = ? WHERE id = ?',
      ['mutated', themeId],
    );
    assertFrozenMutationRejected(db, 'DELETE FROM periodical_themes WHERE id = ?', [themeId]);

    assertFrozenMutationRejected(db, `
      INSERT INTO periodical_events (
        id, issue_id, theme_id, event_key, title, effective_at,
        first_seen_at, last_seen_at, importance_score,
        score_json, cluster_json, display_order
      ) VALUES (?, ?, ?, 'mutation', 'Mutation', 1, 1, 1, 40, '{}', '{}', 99)
    `, [`${issueId}:event:mutation`, issueId, themeId]);
    assertFrozenMutationRejected(
      db,
      'UPDATE periodical_events SET title = ? WHERE id = ?',
      ['mutated', eventId],
    );
    assertFrozenMutationRejected(db, 'DELETE FROM periodical_events WHERE id = ?', [eventId]);

    assertFrozenMutationRejected(db, `
      INSERT INTO periodical_event_evidence (
        event_id, entry_id, source_id, source_name, editorial_priority,
        entry_title, content_hash, effective_published_at, display_order
      ) VALUES (?, 'extra-entry', 'final-source', 'Final Source', 'high',
        'Mutation', 'mutation', 1, 99)
    `, [eventId]);
    assertFrozenMutationRejected(db, `
      UPDATE periodical_event_evidence
      SET summary_excerpt = ?
      WHERE event_id = ? AND entry_id = ?
    `, ['mutated', eventId, evidenceEntryId]);
    assertFrozenMutationRejected(db, `
      DELETE FROM periodical_event_evidence
      WHERE event_id = ? AND entry_id = ?
    `, [eventId, evidenceEntryId]);

    assertFrozenMutationRejected(db, `
      INSERT INTO periodical_issue_inputs (
        issue_id, daily_issue_id, daily_content_hash, display_order
      ) VALUES (
        'periodical:weekly:2026-W31',
        'periodical:daily:2026-07-28',
        'mutation',
        1
      )
    `);
    assertFrozenMutationRejected(db, `
      UPDATE periodical_issue_inputs
      SET daily_content_hash = 'mutation'
      WHERE issue_id = 'periodical:weekly:2026-W31'
    `);
    assertFrozenMutationRejected(db, `
      DELETE FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:weekly:2026-W31'
    `);
  } finally {
    db.close();
  }
});

test('persisted semantic hash mismatch rolls back final content and the frozen transition', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    const before = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    db.exec(`
      CREATE TRIGGER corrupt_final_periodical_event
      AFTER INSERT ON periodical_events
      WHEN EXISTS (
        SELECT 1 FROM periodical_issues
        WHERE id = NEW.issue_id AND status = 'finalizing'
      )
      BEGIN
        UPDATE periodical_events
        SET summary = 'corrupted after insert'
        WHERE id = NEW.id;
      END;
    `);

    const failed = await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    const after = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(failed.status, 'failed');
    assert.equal(after.issue.status, 'finalizing');
    assert.equal(after.issue.revision, before.issue.revision);
    assert.equal(after.issue.contentHash, before.issue.contentHash);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.evidence, before.evidence);

    db.exec('DROP TRIGGER corrupt_final_periodical_event');
    const recovered = periodicals.finalizeDueIssues({ now: PERIOD_END + 3 });
    const completed = await periodicals.runNextBuild({ now: PERIOD_END + 4 });
    const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(recovered.issues[0].action, 'queued');
    assert.equal(completed.status, 'succeeded');
    assert.equal(frozen.issue.status, 'frozen');
    assert.equal(frozen.issue.revision, before.issue.revision + 1);
  } finally {
    db.close();
  }
});

test('no candidates and no event reaching 40 both freeze as structurally valid empty Dailies', async t => {
  for (const scenario of [
    {
      name: 'no candidates',
      arrange(db) {
        db.exec("DELETE FROM entries WHERE id = 'final-entry'");
      },
    },
    {
      name: 'no event reaches 40',
      arrange(db) {
        db.exec(`
          UPDATE source_preferences
          SET editorial_priority = 'low'
          WHERE source_id = 'final-source'
        `);
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const db = fixtureDatabase();
      try {
        scenario.arrange(db);
        const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
        periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
        await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
        periodicals.finalizeDueIssues({ now: FINALIZATION_DEADLINE });
        const completed = await periodicals.runNextBuild({ now: FINALIZATION_DEADLINE });
        const frozen = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

        assert.equal(completed.status, 'succeeded');
        assert.equal(frozen.issue.status, 'frozen');
        assert.equal(frozen.issue.summaryStatus, 'fallback');
        assert.match(frozen.issue.overview, /没有事件达到 40 分入选门槛/);
        assert.deepEqual(frozen.themes, []);
        assert.deepEqual(frozen.events, []);
        assert.deepEqual(frozen.evidence, []);
        assert.match(frozen.issue.contentHash, /^[a-f0-9]{64}$/);
      } finally {
        db.close();
      }
    });
  }
});

test('frozen snapshots survive Source, Entry, behavior, model, job, and module restart changes', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    const before = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    db.exec(`
      UPDATE source_preferences
      SET enabled = 0, editorial_priority = 'low'
      WHERE source_id = 'final-source';
      UPDATE entries
      SET title = 'Mutated current Entry', content = '<p>Mutated</p>',
          content_hash = 'current-entry-v2', deleted_at = 1
      WHERE id = 'final-entry';
      UPDATE periodical_build_jobs
      SET provider = 'replacement-provider',
          model = 'replacement-model',
          selection_version = 'importance-v2',
          summary_version = 'constrained-summary-v2',
          score_config_json = '{"version":"v2"}'
      WHERE issue_id = 'periodical:daily:2026-07-29';
    `);
    const restarted = createPeriodicalsModule({
      db,
      mode: 'shadow',
      behaviorSignalEnabled: true,
      aiAdapter: async () => {
        throw new Error('recovered model must not run');
      },
      logger: () => {},
    });
    const after = restarted.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });

    assert.equal(after.issue.contentHash, before.issue.contentHash);
    assert.equal(after.issue.revision, before.issue.revision);
    assert.equal(after.issue.selectionVersion, before.issue.selectionVersion);
    assert.equal(after.issue.summaryVersion, before.issue.summaryVersion);
    assert.equal(after.issue.provider, before.issue.provider);
    assert.equal(after.issue.model, before.issue.model);
    assert.deepEqual(after.themes, before.themes);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.evidence[0].entryTitle, 'Final daily entry');
    assert.equal(after.evidence[0].contentHash, 'final-content-v1');
  } finally {
    db.close();
  }
});

test('corrupted frozen semantics fail closed without consulting Entry or a recovered model', async () => {
  const db = fixtureDatabase();
  let aiCalls = 0;
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: generatedSummary,
      logger: () => {},
    });
    periodicals.syncOpenDaily({ now: OPEN_BUILD_AT, trigger: 'test' });
    await periodicals.runNextBuild({ now: OPEN_BUILD_AT });
    periodicals.finalizeDueIssues({ now: PERIOD_END + 1 });
    await periodicals.runNextBuild({ now: PERIOD_END + 2 });
    db.exec(`
      DROP TRIGGER reject_frozen_periodical_event_update;
      UPDATE periodical_events
      SET summary = 'corrupted frozen summary';
      UPDATE entries
      SET summary = 'current Entry must not repair history'
      WHERE id = 'final-entry';
    `);
    const restarted = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: async input => {
        aiCalls += 1;
        return generatedSummary(input);
      },
      logger: () => {},
    });

    assert.throws(
      () => restarted.getIssue({ cadence: 'daily', periodKey: '2026-07-29' }),
      error => error.code === 'ERR_PERIODICAL_CONTENT_HASH_MISMATCH'
        && error.statusCode === 503,
    );
    assert.equal(aiCalls, 0);
  } finally {
    db.close();
  }
});
