const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { canonicalSerialize, computeCanonicalHash } = require('../lib/content-hashes');
const { computePeriodicalContentHash } = require('../lib/periodical-summary');
const {
  candidateIdentitySnapshot,
  candidateInputSnapshot,
  candidateInputSnapshotHash,
  createPeriodicalsModule,
  dailySelectionContext,
  fullInputIdentity,
  periodicalBuildJobId,
  readStoredPeriodicalIssue,
  rollupInputIdentity,
  scoreConfigFor,
  scoringHistoryIdentity,
  sourceIdentitySnapshot,
  sourceInputIdentity,
} = require('../lib/periodicals');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.resolve(__dirname, '..');
const storePath = path.join(projectDir, 'lib', 'store.js');
const VERIFIED_ISSUE_ID = 'periodical:daily:2026-08-01';

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

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function shanghaiPeriodKey(timestamp) {
  return new Date(timestamp + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function fixtureRollupIdentity(cadence, periodKey, dailies) {
  const inputStates = dailies.map((daily, displayOrder) => ({
    displayOrder,
    expectedDailyIssueId: daily.issue.id,
    expectedPeriodKey: daily.issue.periodKey,
    actualIssueId: daily.issue.id,
    actualCadence: daily.issue.cadence,
    actualPeriodKey: daily.issue.periodKey,
    actualPeriodStartAt: daily.issue.periodStartAt,
    actualPeriodEndAt: daily.issue.periodEndAt,
    actualStatus: daily.issue.status,
    actualRevision: daily.issue.revision,
    dailyContentHash: daily.issue.contentHash,
    validationCode: null,
  }));
  const identity = rollupInputIdentity({
    cadence,
    periodKey,
    inputStates,
  });
  return {
    ...identity,
    selectionContext: {
      ...identity.selectionContext,
      scoreConfig: { ...identity.selectionContext.scoreConfig },
    },
  };
}

function rollupChainFixture(cadence) {
  const weekly = cadence === 'weekly';
  const periodKey = weekly ? '2026-W31' : '2026-07';
  const periodStartAt = Date.parse(weekly
    ? '2026-07-26T16:00:00.000Z'
    : '2026-06-30T16:00:00.000Z');
  const dayCount = weekly ? 7 : 31;
  const issueId = `periodical:${cadence}:${periodKey}`;
  const dailies = Array.from({ length: dayCount }, (_, displayOrder) => {
    const dailyPeriodKey = shanghaiPeriodKey(periodStartAt + (displayOrder * 86_400_000));
    return {
      issue: {
        id: `periodical:daily:${dailyPeriodKey}`,
        cadence: 'daily',
        periodKey: dailyPeriodKey,
        volumeNo: displayOrder + 1,
        timezone: 'Asia/Shanghai',
        periodStartAt: periodStartAt + (displayOrder * 86_400_000),
        periodEndAt: periodStartAt + ((displayOrder + 1) * 86_400_000),
        coverageStartedAt: periodStartAt + (displayOrder * 86_400_000),
        status: 'frozen',
        revision: 1,
        lastBuiltAt: periodStartAt + ((displayOrder + 1) * 86_400_000),
        frozenAt: periodStartAt + ((displayOrder + 1) * 86_400_000),
        contentHash: String(displayOrder + 1).padStart(64, '0'),
      },
      themes: [],
      events: [],
      evidence: [],
      inputs: [],
    };
  });
  for (const daily of dailies) {
    daily.issue.contentHash = computePeriodicalContentHash(daily);
  }
  const identity = fixtureRollupIdentity(cadence, periodKey, dailies);
  const rollup = {
    issue: {
      id: issueId,
      cadence,
      periodKey,
      volumeNo: 1,
      timezone: 'Asia/Shanghai',
      periodStartAt,
      periodEndAt: periodStartAt + (dayCount * 86_400_000),
      coverageStartedAt: periodStartAt,
      status: 'frozen',
      revision: 1,
      selectionVersion: identity.selectionVersion,
      summaryVersion: identity.summaryVersion,
      sourceInputHash: identity.sourceInputHash,
      selectionContext: identity.selectionContext,
      inputHash: identity.inputHash,
      contentHash: 'f'.repeat(64),
      lastBuiltAt: periodStartAt + (dayCount * 86_400_000),
      frozenAt: periodStartAt + (dayCount * 86_400_000),
    },
    themes: [],
    events: [],
    evidence: [],
    inputs: dailies.map((daily, displayOrder) => ({
      issueId,
      dailyIssueId: daily.issue.id,
      dailyContentHash: daily.issue.contentHash,
      displayOrder,
    })),
  };
  rollup.issue.contentHash = computePeriodicalContentHash(rollup);
  return {
    dailies,
    documents: new Map(dailies.map(daily => [daily.issue.id, daily])),
    rollup,
  };
}

async function seedFrozenProductPeriod(databaseFile, cadence) {
  const db = new DatabaseSync(databaseFile);
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: null,
      logger() {},
    });
    const startAt = Date.parse(cadence === 'weekly'
      ? '2026-07-26T16:00:00.000Z'
      : '2026-06-30T16:00:00.000Z');
    const dayCount = cadence === 'weekly' ? 7 : 31;
    for (let day = 0; day < dayCount; day += 1) {
      const periodStartAt = startAt + (day * 86_400_000);
      periodicals.syncOpenDaily({ now: periodStartAt, trigger: 'identity-red' });
      await periodicals.runNextBuild({ now: periodStartAt + 1_000 });
      periodicals.finalizeDueIssues({ now: periodStartAt + 86_400_000 });
      await periodicals.runNextBuild({ now: periodStartAt + 86_401_000 });
    }
    const rollupAt = startAt + (dayCount * 86_400_000);
    const scheduled = cadence === 'weekly'
      ? periodicals.syncWeeklyRollup({ now: rollupAt + 1_000, trigger: 'identity-red' })
      : periodicals.syncMonthlyRollup({ now: rollupAt + 1_000, trigger: 'identity-red' });
    await periodicals.runNextBuild({ now: rollupAt + 2_000 });
    const issue = db.prepare(`
      SELECT id FROM periodical_issues
      WHERE cadence = ? AND revision > 0
      ORDER BY period_key DESC
      LIMIT 1
    `).get(cadence);
    return issue && issue.id || scheduled.issueId;
  } finally {
    db.close();
  }
}

async function seedFrozenProductDaily(databaseFile) {
  const db = new DatabaseSync(databaseFile);
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: null,
      logger() {},
    });
    const periodStartAt = Date.parse('2026-07-26T16:00:00.000Z');
    const scheduled = periodicals.syncOpenDaily({
      now: periodStartAt,
      trigger: 'identity-red',
    });
    await periodicals.runNextBuild({ now: periodStartAt + 1_000 });
    periodicals.finalizeDueIssues({ now: periodStartAt + 86_400_000 });
    await periodicals.runNextBuild({ now: periodStartAt + 86_401_000 });
    return scheduled.issueId;
  } finally {
    db.close();
  }
}

async function seedLateFrozenHistory(databaseFile) {
  const db = new DatabaseSync(databaseFile);
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: null,
      logger() {},
    });
    const firstPeriodStartAt = Date.parse('2026-07-26T16:00:00.000Z');
    const secondPeriodStartAt = firstPeriodStartAt + 86_400_000;

    periodicals.syncOpenDaily({ now: firstPeriodStartAt + 1_000, trigger: 'late-history-red' });
    await periodicals.runNextBuild({ now: firstPeriodStartAt + 2_000 });

    periodicals.syncOpenDaily({ now: secondPeriodStartAt + 1_000, trigger: 'late-history-red' });
    await periodicals.runNextBuild({ now: secondPeriodStartAt + 2_000 });

    periodicals.finalizeDueIssues({ now: secondPeriodStartAt + 3_000 });
    await periodicals.runNextBuild({ now: secondPeriodStartAt + 4_000 });
  } finally {
    db.close();
  }
}

async function seedSameMillisecondHistory(databaseFile, { freezeBeforeBuild }) {
  const db = new DatabaseSync(databaseFile);
  try {
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      aiAdapter: null,
      logger() {},
    });
    const firstPeriodStartAt = Date.parse('2026-07-26T16:00:00.000Z');
    const secondPeriodStartAt = firstPeriodStartAt + 86_400_000;
    const sharedTimestamp = secondPeriodStartAt + 1_000;

    periodicals.syncOpenDaily({ now: firstPeriodStartAt + 1_000, trigger: 'same-ms-red' });
    await periodicals.runNextBuild({ now: firstPeriodStartAt + 2_000 });

    const freezeFirst = async () => {
      periodicals.finalizeDueIssues({ now: sharedTimestamp });
      await periodicals.runNextBuild({ now: sharedTimestamp });
    };
    const buildSecond = async () => {
      periodicals.syncOpenDaily({ now: sharedTimestamp, trigger: 'same-ms-red' });
      await periodicals.runNextBuild({ now: sharedTimestamp });
    };
    if (freezeBeforeBuild) {
      await freezeFirst();
      await buildSecond();
    } else {
      await buildSecond();
      await freezeFirst();
    }

    const second = db.prepare(`
      SELECT selection_context_json
      FROM periodical_issues
      WHERE cadence = 'daily' AND period_key = '2026-07-28'
    `).get();
    return JSON.parse(second.selection_context_json).frozenDailyHistory;
  } finally {
    db.close();
  }
}

function seedProtectedFacts(databaseFile, { externalSource = false } = {}) {
  const db = new DatabaseSync(databaseFile);
  const sourceId = externalSource ? 'external-source' : 'verified-source';
  const now = Date.parse('2026-08-01T04:00:00.000Z');
  const periodStartAt = Date.parse('2026-07-31T16:00:00.000Z');
  const periodEndAt = periodStartAt + 86_400_000;
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO users (
      id, email, display_name, password_hash, password_salt, created_at, updated_at
    ) VALUES ('verified-user', 'verified@example.com', 'Verified User',
      'password-digest-must-not-leak', 'password-salt-must-not-leak', ?, ?)
  `).run(now, now);
  if (!externalSource) {
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES (?, 'Verified Source', 'https://verified.example/feed.xml',
        'article', '["产品"]', ?, ?)
    `).run(sourceId, now, now);
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', 0, '2026-08-01T12:00:00.000Z')
    `).run(sourceId);
  }
  db.prepare(`
    INSERT INTO entries (
      id, source_id, title, link, published_ts, summary, content, content_hash,
      created_at, updated_at
    ) VALUES ('verified-entry', ?, 'Sensitive title', 'https://verified.example/entry', ?,
      'Sensitive summary', '<p>Sensitive body</p>', 'entry-content-hash', ?, ?)
  `).run(sourceId, now - 1000, now - 1000, now - 1000);
  db.prepare(`
    INSERT INTO user_entry_states (
      user_id, entry_id, read_at, starred_at, viewed_at, updated_at
    ) VALUES ('verified-user', 'verified-entry', ?, ?, ?, ?)
  `).run(now - 800, now - 700, now - 600, now - 500);
  db.prepare(`
    INSERT INTO entry_stats (entry_id, view_count, last_viewed_at, updated_at)
    VALUES ('verified-entry', 7, ?, ?)
  `).run(now - 600, now - 500);
  const evidence = {
    eventId: 'verified-event',
    entryId: 'verified-entry',
    sourceId,
    sourceName: 'Verified Source',
    sourceLabels: ['产品'],
    editorialPriority: 'high',
    entryTitle: 'Sensitive title',
    entryTitleZh: null,
    entryLink: 'https://verified.example/entry',
    canonicalUrl: 'https://verified.example/entry',
    summaryExcerpt: 'Sensitive excerpt',
    contentHash: 'evidence-content-hash',
    effectivePublishedAt: now - 1000,
    timestampFallback: false,
    isPrimary: true,
    displayOrder: 0,
  };
  const sourceSnapshot = [{
    sourceId,
    name: 'Verified Source',
    category: 'article',
    enabled: true,
    editorialPriority: 'high',
    labels: ['产品'],
  }];
  const candidateInput = candidateInputSnapshot({ source: { category: 'article' }, evidence });
  const candidateSnapshot = [{
    entryId: evidence.entryId,
    sourceId,
    contentHash: candidateInputSnapshotHash(candidateInput),
    effectivePublishedAt: evidence.effectivePublishedAt,
    input: candidateInput,
  }];
  const sourceInputHash = sourceInputIdentity({
    periodKey: '2026-08-01',
    candidates: candidateSnapshot.map(candidateIdentitySnapshot),
    sources: sourceSnapshot.map(sourceIdentitySnapshot),
    behaviorSignalEnabled: false,
  });
  const scoreConfig = scoreConfigFor(false);
  const frozenDailyHistory = [];
  const selectionContext = dailySelectionContext({
    scoreConfig,
    candidateSnapshot,
    sourceSnapshot,
    frozenDailyHistory,
  });
  const inputHash = fullInputIdentity({
    sourceInputHash,
    asOfAt: now,
    scoringHistoryHash: scoringHistoryIdentity(frozenDailyHistory),
    scoreConfig,
  });
  const summaryVersion = 'constrained-summary-v1';
  db.prepare(`
    INSERT INTO periodical_issues (
      id, cadence, period_key, volume_no, timezone,
      period_start_at, period_end_at, coverage_started_at,
      status, revision, selection_version, summary_version, source_input_hash,
      selection_context_json, input_hash, content_hash, summary_status,
      last_built_at, created_at, updated_at
    ) VALUES (?, 'daily', '2026-08-01', 1, 'Asia/Shanghai', ?, ?, ?, 'open', 1,
      'importance-v1', ?, ?, ?, ?, '', 'fallback', ?, ?, ?)
  `).run(
    VERIFIED_ISSUE_ID,
    periodStartAt,
    periodEndAt,
    now - 1000,
    summaryVersion,
    sourceInputHash,
    JSON.stringify(selectionContext),
    inputHash,
    now,
    now - 1000,
    now,
  );
  db.prepare(`
    INSERT INTO periodical_themes (id, issue_id, theme_key, title, display_order)
    VALUES ('verified-theme', ?, 'theme', 'Theme', 0)
  `).run(VERIFIED_ISSUE_ID);
  db.prepare(`
    INSERT INTO periodical_events (
      id, issue_id, theme_id, event_key, title, effective_at, first_seen_at,
      last_seen_at, importance_score, score_json, cluster_json, display_order
    ) VALUES ('verified-event', ?, 'verified-theme', 'event',
      'Event', ?, ?, ?, 90, '{}', '{}', 0)
  `).run(VERIFIED_ISSUE_ID, now, now, now);
  db.prepare(`
    INSERT INTO periodical_event_evidence (
      event_id, entry_id, source_id, source_name, source_labels_json,
      editorial_priority, entry_title, entry_link, canonical_url,
      summary_excerpt, content_hash, effective_published_at, is_primary, display_order
    ) VALUES ('verified-event', 'verified-entry', ?, 'Verified Source', '["产品"]',
      'high', 'Sensitive title', 'https://verified.example/entry',
      'https://verified.example/entry', 'Sensitive excerpt', 'evidence-content-hash',
      ?, 1, 0)
  `).run(sourceId, now - 1000);
  db.prepare(`
    INSERT INTO periodical_build_jobs (
      id, issue_id, source_input_hash, input_hash, as_of_at, candidate_cutoff_at,
      selection_version, score_config_json, summary_version, trigger_reason,
      status, attempt_count, candidate_count, source_count,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?,
      'importance-v1', ?, ?, 'test',
      'succeeded', 1, 1, 1, ?, ?, ?)
  `).run(
    periodicalBuildJobId({
      issueId: VERIFIED_ISSUE_ID,
      inputHash,
      summaryVersion,
    }),
    VERIFIED_ISSUE_ID,
    sourceInputHash,
    inputHash,
    now,
    now,
    canonicalSerialize(scoreConfig),
    summaryVersion,
    now - 1000,
    now,
    now,
  );
  const issueRow = db.prepare(`
    SELECT * FROM periodical_issues WHERE id = ?
  `).get(VERIFIED_ISSUE_ID);
  db.prepare(`
    UPDATE periodical_issues SET content_hash = ? WHERE id = ?
  `).run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, issueRow)), VERIFIED_ISSUE_ID);
  db.close();
}

test('shadow verifier repeats additive migration on a work copy without changing protected facts', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-verification-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile);

    const receipt = await verifyDatabaseCopy(databaseFile);

    assert.equal(receipt.version, 'periodicals-shadow-verification-v4');
    assert.equal(receipt.passed, true);
    assert.equal(receipt.sourceReadOnly, true);
    assert.equal(receipt.sourceUnchanged, true);
    assert.deepEqual(receipt.integrity.before, { quickCheck: 'ok', foreignKeyViolations: 0 });
    assert.deepEqual(receipt.integrity.afterFirstInit, { quickCheck: 'ok', foreignKeyViolations: 0 });
    assert.deepEqual(receipt.integrity.afterSecondInit, { quickCheck: 'ok', foreignKeyViolations: 0 });
    assert.deepEqual(receipt.protectedFacts.before, receipt.protectedFacts.afterFirstInit);
    assert.deepEqual(receipt.protectedFacts.before, receipt.protectedFacts.afterSecondInit);
    assert.deepEqual(receipt.provenance, {
      evidenceCount: 1,
      missingEntryCount: 0,
      sourceMismatchCount: 0,
      unknownSourceCount: 0,
      invalidSourceSnapshotCount: 0,
      issueIdentityMismatchCount: 0,
      issueContentHashMismatchCount: 0,
      sourceInputHashMismatchCount: 0,
      inputHashMismatchCount: 0,
      selectionContextMismatchCount: 0,
      buildIdentityMismatchCount: 0,
      candidateSnapshotMismatchCount: 0,
      rollupSnapshotMismatchCount: 0,
      revisionZeroStateMismatchCount: 0,
    });
    assert.equal(receipt.durableState.issues.rowCount, 1);
    assert.equal(receipt.durableState.jobs.rowCount, 1);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /verified@example|password-digest|password-salt|Sensitive title|Sensitive summary|Sensitive body|Sensitive excerpt/i,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier fails closed when evidence introduces an external Source ID', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-provenance-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile, { externalSource: true });

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE'
        && !/external-source|Sensitive/i.test(error.message),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('protected fact fingerprints preserve exact SQLite text bytes', () => {
  const { snapshotProtectedFacts } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-exact-facts-');
  let db;
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    db = new DatabaseSync(databaseFile);
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    db.prepare(`
      INSERT INTO users (
        id, email, display_name, password_hash, password_salt, created_at, updated_at
      ) VALUES ('exact-user', 'exact@example.com', ?, 'digest', 'salt', ?, ?)
    `).run('Line one\r\nCafe\u0301', now, now);
    const before = snapshotProtectedFacts(db);

    db.prepare(`
      UPDATE users SET display_name = ? WHERE id = 'exact-user'
    `).run('Line one\nCaf\u00e9');
    const after = snapshotProtectedFacts(db);

    assert.notEqual(before.users.sha256, after.users.sha256);
  } finally {
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('protected fact fingerprints distinguish adjacent SQLite REAL values', () => {
  const { snapshotProtectedFacts } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-exact-real-');
  let db;
  try {
    initializeStore(dataDir);
    db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, created_at, updated_at
      ) VALUES ('real-entry', 'real-source', 'REAL', '', ?, 1, 1)
    `).run(0.1);
    const before = snapshotProtectedFacts(db);

    db.prepare(`UPDATE entries SET published_ts = ? WHERE id = 'real-entry'`)
      .run(0.10000000000000002);
    const after = snapshotProtectedFacts(db);

    assert.notEqual(before.entries.sha256, after.entries.sha256);
  } finally {
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier rejects revision-zero issues that already own durable children', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-revision-zero-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile);
    const db = new DatabaseSync(databaseFile);
    db.prepare(`
      UPDATE periodical_issues
      SET revision = 0, content_hash = '', selection_context_json = '{}'
      WHERE id = ?
    `).run(VERIFIED_ISSUE_ID);
    db.close();

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier reconstructs Daily history at the succeeded job cutoff', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-late-history-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    await seedLateFrozenHistory(databaseFile);

    const receipt = await verifyDatabaseCopy(databaseFile);
    assert.equal(receipt.provenance.issueIdentityMismatchCount, 0);
    assert.equal(receipt.provenance.selectionContextMismatchCount, 0);
    assert.equal(receipt.provenance.inputHashMismatchCount, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier accepts both causal history orders at an equal millisecond cutoff', async t => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  for (const freezeBeforeBuild of [false, true]) {
    await t.test(freezeBeforeBuild ? 'freeze then build' : 'build then freeze', async () => {
      const dataDir = createTempDataDir('namoo-reader-periodicals-same-ms-history-');
      try {
        initializeStore(dataDir);
        const databaseFile = path.join(dataDir, 'qmreader.sqlite');
        const history = await seedSameMillisecondHistory(databaseFile, { freezeBeforeBuild });
        assert.equal(history.length, freezeBeforeBuild ? 1 : 0);

        const receipt = await verifyDatabaseCopy(databaseFile);
        assert.equal(receipt.provenance.selectionContextMismatchCount, 0);
        assert.equal(receipt.provenance.inputHashMismatchCount, 0);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test('shadow verifier rejects a succeeded job attached to a revision-zero Issue', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-revision-zero-job-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    const db = new DatabaseSync(databaseFile);
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger() {} });
    const now = Date.parse('2026-08-01T04:00:00.000Z');
    const scheduled = periodicals.syncOpenDaily({ now, trigger: 'revision-zero-red' });
    db.prepare(`
      UPDATE periodical_build_jobs
      SET status = 'succeeded', attempt_count = 1, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now + 1_000, now + 1_000, scheduled.job.id);
    db.close();

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rollup provenance derives and closes the complete Shanghai natural-period input set', async t => {
  const { validateRollupInputChain } = require('../lib/periodicals-verification');
  const scenarios = [
    ['empty input set', ({ rollup }) => { rollup.inputs = []; }],
    ['missing day', ({ rollup }) => { rollup.inputs.splice(3, 1); }],
    ['duplicate day', ({ rollup }) => { rollup.inputs[3] = { ...rollup.inputs[2], displayOrder: 3 }; }],
    ['non-frozen day', ({ dailies }) => { dailies[3].issue.status = 'open'; }],
    ['revision-zero day', ({ dailies }) => { dailies[3].issue.revision = 0; }],
    ['wrong nonzero daily revision', ({ dailies }) => { dailies[3].issue.revision = 2; }],
    ['wrong daily content hash', ({ rollup }) => { rollup.inputs[3].dailyContentHash = 'e'.repeat(64); }],
    ['wrong rollup source input hash', ({ rollup }) => {
      rollup.issue.sourceInputHash = 'c'.repeat(64);
    }],
    ['wrong rollup input hash', ({ rollup }) => {
      rollup.issue.inputHash = 'd'.repeat(64);
    }],
    ['wrong rollup input version', ({ rollup }) => {
      rollup.issue.selectionContext.inputVersion = 'tampered-input-v9';
    }],
    ['wrong rollup event version', ({ rollup }) => {
      rollup.issue.selectionContext.eventVersion = 'tampered-event-v9';
    }],
    ['wrong rollup score config', ({ rollup }) => {
      rollup.issue.selectionContext.scoreConfig.maxEvents += 1;
    }],
    ['wrong rollup daily count', ({ rollup }) => {
      rollup.issue.selectionContext.dailyInputCount -= 1;
    }],
    ['unexpected rollup selection context field', ({ rollup }) => {
      rollup.issue.selectionContext.unbound = true;
    }],
    ['out-of-range day', fixture => {
      const lastIndex = fixture.dailies.length - 1;
      const outsidePeriodKey = shanghaiPeriodKey(fixture.rollup.issue.periodEndAt);
      const outside = {
        ...fixture.dailies[lastIndex],
        issue: {
          ...fixture.dailies[lastIndex].issue,
          id: `periodical:daily:${outsidePeriodKey}`,
          periodKey: outsidePeriodKey,
          periodStartAt: fixture.rollup.issue.periodEndAt,
          periodEndAt: fixture.rollup.issue.periodEndAt + 86_400_000,
        },
      };
      outside.issue.contentHash = computePeriodicalContentHash(outside);
      fixture.documents.set(outside.issue.id, outside);
      fixture.rollup.inputs[lastIndex] = {
        ...fixture.rollup.inputs[lastIndex],
        dailyIssueId: outside.issue.id,
        dailyContentHash: outside.issue.contentHash,
      };
    }],
  ];

  for (const cadence of ['weekly', 'monthly']) {
    const valid = rollupChainFixture(cadence);
    assert.equal(validateRollupInputChain(valid.rollup, valid.documents).valid, true);

    for (const [name, mutate] of scenarios) {
      await t.test(`${cadence}: ${name}`, () => {
        const fixture = rollupChainFixture(cadence);
        mutate(fixture);
        assert.equal(validateRollupInputChain(fixture.rollup, fixture.documents).valid, false);
      });
    }
  }
});

test('canonical Issue identity closes Daily fields and cross-period volume topology', async t => {
  const {
    canonicalIssueIdentityMismatches,
    canonicalIssueIdentityValid,
  } = require('../lib/periodicals-verification');
  const base = rollupChainFixture('weekly').dailies[0];
  assert.equal(canonicalIssueIdentityValid(base), true);
  const scenarios = [
    ['deterministic id', issue => { issue.id = 'periodical:daily:forged'; }],
    ['cadence', issue => { issue.cadence = 'weekly'; }],
    ['natural period key', issue => { issue.periodKey = '2026-02-31'; }],
    ['timezone', issue => { issue.timezone = 'UTC'; }],
    ['period start', issue => { issue.periodStartAt += 1; }],
    ['period end', issue => { issue.periodEndAt += 1; }],
    ['coverage', issue => { issue.coverageStartedAt = issue.periodEndAt; }],
    ['volume', issue => { issue.volumeNo = 0; }],
    ['revision integer', issue => { issue.revision = 1.5; }],
    ['frozen timestamp', issue => { issue.frozenAt = null; }],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, () => {
      const document = structuredClone(base);
      mutate(document.issue);
      assert.equal(canonicalIssueIdentityValid(document), false);
    });
  }

  const first = structuredClone(rollupChainFixture('weekly').dailies[0]);
  const second = structuredClone(rollupChainFixture('weekly').dailies[1]);
  [first.issue.volumeNo, second.issue.volumeNo] = [2, 1];
  const documents = new Map([
    [first.issue.id, first],
    [second.issue.id, second],
  ]);
  assert.equal(canonicalIssueIdentityMismatches(documents).size, 2);
});

test('shadow verifier binds Daily inputHash to the canonical succeeded job identity', async t => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-daily-job-identity-');
  try {
    initializeStore(dataDir);
    const baseFile = path.join(dataDir, 'base.sqlite');
    fs.copyFileSync(path.join(dataDir, 'qmreader.sqlite'), baseFile);
    const issueId = await seedFrozenProductDaily(baseFile);
    const resignIssue = (db, id) => {
      const changed = db.prepare('SELECT * FROM periodical_issues WHERE id = ?').get(id);
      db.prepare('UPDATE periodical_issues SET content_hash = ? WHERE id = ?')
        .run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, changed)), id);
    };
    const scenarios = [
      ['missing succeeded job', ({ db, job }) => {
        db.prepare('DELETE FROM periodical_build_jobs WHERE id = ?').run(job.id);
      }],
      ['nondeterministic job id', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET id = ? WHERE id = ?')
          .run('periodical-job:tampered', job.id);
      }],
      ['non-succeeded job', ({ db, job }) => {
        db.prepare("UPDATE periodical_build_jobs SET status = 'failed' WHERE id = ?").run(job.id);
      }],
      ['wrong job source hash', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET source_input_hash = ? WHERE id = ?')
          .run('a'.repeat(64), job.id);
      }],
      ['wrong job as-of boundary', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET as_of_at = as_of_at + 1 WHERE id = ?')
          .run(job.id);
      }],
      ['wrong job candidate cutoff boundary', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET candidate_cutoff_at = candidate_cutoff_at + ? WHERE id = ?')
          .run(16 * 60 * 1_000, job.id);
      }],
      ['wrong job selection version', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET selection_version = ? WHERE id = ?')
          .run('tampered-selection-v9', job.id);
      }],
      ['wrong job score config', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET score_config_json = ? WHERE id = ?')
          .run('{}', job.id);
      }],
      ['wrong job summary version', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET summary_version = ? WHERE id = ?')
          .run('tampered-summary-v9', job.id);
      }],
      ['self-consistent but noncanonical selection version', ({ db, issue, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET selection_version = ? WHERE id = ?')
          .run('tampered-selection-v9', job.id);
        db.prepare('UPDATE periodical_issues SET selection_version = ? WHERE id = ?')
          .run('tampered-selection-v9', issue.id);
        const changed = db.prepare('SELECT * FROM periodical_issues WHERE id = ?').get(issue.id);
        db.prepare('UPDATE periodical_issues SET content_hash = ? WHERE id = ?')
          .run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, changed)), issue.id);
      }],
      ['self-consistent but noncanonical summary version', ({ db, issue, job }) => {
        const summaryVersion = 'tampered-summary-v9';
        const jobId = periodicalBuildJobId({
          issueId: issue.id,
          inputHash: issue.input_hash,
          summaryVersion,
        });
        db.prepare('UPDATE periodical_build_jobs SET id = ?, summary_version = ? WHERE id = ?')
          .run(jobId, summaryVersion, job.id);
        db.prepare('UPDATE periodical_issues SET summary_version = ? WHERE id = ?')
          .run(summaryVersion, issue.id);
        const changed = db.prepare('SELECT * FROM periodical_issues WHERE id = ?').get(issue.id);
        db.prepare('UPDATE periodical_issues SET content_hash = ? WHERE id = ?')
          .run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, changed)), issue.id);
      }],
      ['wrong job candidate count', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET candidate_count = candidate_count + 1 WHERE id = ?')
          .run(job.id);
      }],
      ['wrong job completion identity', ({ db, job }) => {
        db.prepare('UPDATE periodical_build_jobs SET completed_at = completed_at + 1 WHERE id = ?')
          .run(job.id);
      }],
      ['self-consistent but noncanonical issue and job input hash', ({ db, issue, job }) => {
        const inputHash = 'b'.repeat(64);
        const jobId = `periodical-job:${computeCanonicalHash({
          issueId: issue.id,
          inputHash,
          summaryVersion: issue.summary_version,
        })}`;
        db.prepare('UPDATE periodical_build_jobs SET id = ?, input_hash = ? WHERE id = ?')
          .run(jobId, inputHash, job.id);
        db.prepare('UPDATE periodical_issues SET input_hash = ? WHERE id = ?')
          .run(inputHash, issue.id);
      }],
      ['unbound Daily selection algorithm version', ({ db, issue }) => {
        const context = JSON.parse(issue.selection_context_json);
        context.candidateSnapshotVersion = 'tampered-candidate-v9';
        db.prepare('UPDATE periodical_issues SET selection_context_json = ? WHERE id = ?')
          .run(JSON.stringify(context), issue.id);
      }],
      ['self-consistent noncanonical timezone', ({ db, issue }) => {
        db.prepare("UPDATE periodical_issues SET timezone = 'UTC' WHERE id = ?").run(issue.id);
        resignIssue(db, issue.id);
      }],
      ['self-consistent coverage outside the natural period', ({ db, issue }) => {
        db.prepare(`
          UPDATE periodical_issues SET coverage_started_at = period_end_at + 1 WHERE id = ?
        `).run(issue.id);
        resignIssue(db, issue.id);
      }],
      ['self-consistent noncanonical first volume', ({ db, issue }) => {
        db.prepare('UPDATE periodical_issues SET volume_no = 2 WHERE id = ?').run(issue.id);
        resignIssue(db, issue.id);
      }],
      ['self-consistent fractional revision', ({ db, issue }) => {
        db.prepare('UPDATE periodical_issues SET revision = 1.5 WHERE id = ?').run(issue.id);
        resignIssue(db, issue.id);
      }],
      ['self-consistent frozen Issue without frozenAt', ({ db, issue }) => {
        db.prepare('UPDATE periodical_issues SET frozen_at = NULL WHERE id = ?').run(issue.id);
        resignIssue(db, issue.id);
      }],
    ];

    for (const [name, mutate] of scenarios) {
      await t.test(name, async () => {
        const databaseFile = path.join(dataDir, `${name.replaceAll(/[^a-z]+/gi, '-')}.sqlite`);
        fs.copyFileSync(baseFile, databaseFile);
        const db = new DatabaseSync(databaseFile);
        db.exec('DROP TRIGGER IF EXISTS reject_frozen_periodical_issue_update');
        const issue = db.prepare('SELECT * FROM periodical_issues WHERE id = ?').get(issueId);
        const job = db.prepare(`
          SELECT * FROM periodical_build_jobs
          WHERE issue_id = ? AND input_hash = ? AND status = 'succeeded'
        `).get(issue.id, issue.input_hash);
        mutate({ db, issue, job });
        db.close();

        await assert.rejects(
          verifyDatabaseCopy(databaseFile),
          error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
        );
      });
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier requires a canonical succeeded job for Frozen Weekly and Monthly', async t => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  for (const cadence of ['weekly', 'monthly']) {
    await t.test(cadence, async () => {
      const dataDir = createTempDataDir(`namoo-reader-periodicals-${cadence}-job-`);
      try {
        initializeStore(dataDir);
        const databaseFile = path.join(dataDir, 'qmreader.sqlite');
        const issueId = await seedFrozenProductPeriod(databaseFile, cadence);
        const baseline = await verifyDatabaseCopy(databaseFile);
        assert.equal(baseline.passed, true);
        assert.equal(baseline.provenance.issueIdentityMismatchCount, 0);
        const db = new DatabaseSync(databaseFile);
        const issue = db.prepare('SELECT input_hash FROM periodical_issues WHERE id = ?')
          .get(issueId);
        db.prepare(`
          DELETE FROM periodical_build_jobs
          WHERE issue_id = ? AND input_hash = ? AND status = 'succeeded'
        `).run(issueId, issue.input_hash);
        db.close();

        await assert.rejects(
          verifyDatabaseCopy(databaseFile),
          error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
        );
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test('durable fingerprints bind every canonical Issue and build identity field', async t => {
  const { snapshotDurablePeriodicalState } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-durable-job-identity-');
  try {
    initializeStore(dataDir);
    const baseFile = path.join(dataDir, 'base.sqlite');
    fs.copyFileSync(path.join(dataDir, 'qmreader.sqlite'), baseFile);
    const issueId = await seedFrozenProductDaily(baseFile);
    const scenarios = [
      ['source_input_hash', "'a' || substr(source_input_hash, 2)"],
      ['as_of_at', 'as_of_at + 1'],
      ['candidate_cutoff_at', 'candidate_cutoff_at + 1'],
      ['selection_version', "selection_version || '-tampered'"],
      ['score_config_json', "'{}'"],
      ['summary_version', "summary_version || '-tampered'"],
    ];
    for (const [column, expression] of scenarios) {
      await t.test(column, () => {
        const databaseFile = path.join(dataDir, `${column}.sqlite`);
        fs.copyFileSync(baseFile, databaseFile);
        const db = new DatabaseSync(databaseFile);
        const before = snapshotDurablePeriodicalState(db);
        db.prepare(`
          UPDATE periodical_build_jobs SET ${column} = ${expression}
          WHERE issue_id = ? AND status = 'succeeded'
        `).run(issueId);
        const after = snapshotDurablePeriodicalState(db);
        db.close();
        assert.notEqual(before.jobs.sha256, after.jobs.sha256);
      });
    }
    const issueScenarios = [
      ['timezone', "'UTC'"],
      ['volume_no', 'volume_no + 1'],
      ['period_start_at', 'period_start_at + 1'],
      ['period_end_at', 'period_end_at + 1'],
      ['coverage_started_at', 'coverage_started_at + 1'],
      ['overview', "overview || '-tampered'"],
      ['summary_status', "CASE summary_status WHEN 'fallback' THEN 'generated' ELSE 'fallback' END"],
      ['provider', "'tampered-provider'"],
      ['model', "'tampered-model'"],
    ];
    for (const [column, expression] of issueScenarios) {
      await t.test(`issue ${column}`, () => {
        const databaseFile = path.join(dataDir, `issue-${column}.sqlite`);
        fs.copyFileSync(baseFile, databaseFile);
        const db = new DatabaseSync(databaseFile);
        const before = snapshotDurablePeriodicalState(db);
        db.exec('DROP TRIGGER IF EXISTS reject_frozen_periodical_issue_update');
        db.prepare(`
          UPDATE periodical_issues SET ${column} = ${expression} WHERE id = ?
        `).run(issueId);
        const after = snapshotDurablePeriodicalState(db);
        db.close();
        assert.notEqual(before.issues.sha256, after.issues.sha256);
      });
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier rejects a hash-valid frozen rollup with no declared daily inputs', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-empty-rollup-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile);
    const db = new DatabaseSync(databaseFile);
    const periodStartAt = Date.parse('2026-07-26T16:00:00.000Z');
    db.prepare(`
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, status, revision, overview,
        selection_version, summary_version, source_input_hash,
        selection_context_json, input_hash, content_hash, summary_status,
        frozen_at, created_at, updated_at
      ) VALUES (
        'periodical:weekly:2026-W31', 'weekly', '2026-W31', 1, 'Asia/Shanghai',
        ?, ?, 'finalizing', 1, 'empty but self-consistent',
        'weekly-v1', 'summary-v1', ?, '{}', ?, '', 'fallback', ?, ?, ?
      )
    `).run(
      periodStartAt,
      periodStartAt + (7 * 86_400_000),
      'a'.repeat(64),
      'b'.repeat(64),
      periodStartAt + (7 * 86_400_000),
      periodStartAt,
      periodStartAt + (7 * 86_400_000),
    );
    const issue = db.prepare(`
      SELECT * FROM periodical_issues WHERE id = 'periodical:weekly:2026-W31'
    `).get();
    const document = readStoredPeriodicalIssue(db, issue);
    document.issue.status = 'frozen';
    db.prepare(`
      UPDATE periodical_issues SET content_hash = ?, status = 'frozen'
      WHERE id = 'periodical:weekly:2026-W31'
    `).run(computePeriodicalContentHash(document));
    db.close();

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verifier rejects a self-consistent candidate that has no SQLite Entry', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-candidate-entry-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile);
    const db = new DatabaseSync(databaseFile);
    db.exec(`
      DELETE FROM periodical_event_evidence;
      DELETE FROM periodical_events;
      DELETE FROM periodical_themes;
    `);
    const sourceSnapshot = [{
      sourceId: 'verified-source',
      name: 'Verified Source',
      category: 'article',
      enabled: true,
      editorialPriority: 'high',
      labels: ['产品'],
    }];
    const candidateSnapshot = [{
      entryId: 'missing-entry',
      contentHash: 'a'.repeat(64),
      effectivePublishedAt: Date.parse('2026-08-01T12:00:00.000Z'),
    }];
    const selectionContext = {
      scoreConfig: { behavior: { enabled: false } },
      candidateCount: 1,
      eligibleSourceCount: 1,
      candidateSnapshot,
      sourceSnapshot,
    };
    const sourceInputHash = sourceInputIdentity({
      periodKey: '2026-08-01',
      candidates: candidateSnapshot,
      sources: sourceSnapshot.map(sourceIdentitySnapshot),
      behaviorSignalEnabled: false,
    });
    db.prepare(`
      UPDATE periodical_issues
      SET source_input_hash = ?, selection_context_json = ?, content_hash = ''
      WHERE id = ?
    `).run(sourceInputHash, JSON.stringify(selectionContext), VERIFIED_ISSUE_ID);
    const issue = db.prepare('SELECT * FROM periodical_issues WHERE id = ?')
      .get(VERIFIED_ISSUE_ID);
    db.prepare('UPDATE periodical_issues SET content_hash = ? WHERE id = ?')
      .run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, issue)), VERIFIED_ISSUE_ID);
    db.close();

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('candidate preimage validation binds source, Entry association, and snapshot hash', () => {
  const { validateCandidateSnapshot } = require('../lib/periodicals-verification');
  const input = {
    source: { id: 'verified-source', name: 'Verified Source', category: 'article' },
    entry: {
      title: 'Title',
      titleZh: null,
      link: 'https://verified.example/entry',
      canonicalUrl: 'https://verified.example/entry',
      summaryExcerpt: 'Excerpt',
      contentHash: 'entry-hash',
      timestampFallback: false,
    },
  };
  const candidate = {
    entryId: 'verified-entry',
    sourceId: 'verified-source',
    contentHash: computeCanonicalHash(input),
    effectivePublishedAt: 1,
    input,
  };
  const source = {
    sourceId: 'verified-source',
    name: 'Verified Source',
    category: 'article',
    enabled: true,
    editorialPriority: 'high',
    labels: ['产品'],
  };

  assert.equal(validateCandidateSnapshot(candidate, source, {
    id: 'verified-entry',
    source_id: 'verified-source',
  }), true);
  assert.equal(validateCandidateSnapshot(candidate, source, null), false);
  assert.equal(validateCandidateSnapshot(candidate, source, {
    id: 'verified-entry',
    source_id: 'another-source',
  }), false);
  assert.equal(validateCandidateSnapshot({ ...candidate, contentHash: 'b'.repeat(64) }, source, {
    id: 'verified-entry',
    source_id: 'verified-source',
  }), false);
});

test('shadow verifier rejects evidence that is not bound to its build-time Source snapshot', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-source-snapshot-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    seedProtectedFacts(databaseFile);
    const db = new DatabaseSync(databaseFile);
    db.prepare(`
      UPDATE periodical_event_evidence
      SET source_name = 'Plausible but unbound snapshot'
      WHERE event_id = 'verified-event' AND entry_id = 'verified-entry'
    `).run();
    db.close();

    await assert.rejects(
      verifyDatabaseCopy(databaseFile),
      error => error.code === 'ERR_PERIODICAL_EVIDENCE_PROVENANCE'
        && !/Plausible|Sensitive/i.test(error.message),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verification command emits a candidate- and copy-bound safe receipt', () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-receipt-');
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    const output = execFileSync(process.execPath, [
      'scripts/verify-periodicals-shadow.js',
      '--database-copy', databaseFile,
      '--confirm-read-only-copy',
    ], {
      cwd: projectDir,
      env: { ...process.env, NAMOO_READER_DATA_DIR: '' },
      encoding: 'utf8',
    });
    const receipt = JSON.parse(output);
    const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
    const expectedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();

    assert.equal(receipt.passed, true);
    assert.equal(receipt.candidate.head, expectedHead);
    assert.equal(receipt.candidate.tree, expectedTree);
    assert.match(receipt.databaseSnapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.databaseSnapshot.bytes > 0, true);
    assert.equal(receipt.databaseSnapshot.readOnly, true);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt.databaseSnapshot, 'path'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'databaseCopy'), false);
    assert.doesNotMatch(output, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow receipt binds an atomic SQLite snapshot when committed facts live only in WAL', async () => {
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const dataDir = createTempDataDir('namoo-reader-periodicals-wal-snapshot-');
  let writer;
  try {
    initializeStore(dataDir);
    const databaseFile = path.join(dataDir, 'qmreader.sqlite');
    writer = new DatabaseSync(databaseFile);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const mainFileHash = sha256File(databaseFile);
    writer.prepare(`
      INSERT INTO users (
        id, email, display_name, password_hash, password_salt, created_at, updated_at
      ) VALUES ('wal-only-user', 'wal@example.com', 'WAL', 'digest', 'salt', 1, 1)
    `).run();

    assert.equal(sha256File(databaseFile), mainFileHash);
    assert.equal(fs.statSync(`${databaseFile}-wal`).size > 0, true);

    const receipt = await verifyDatabaseCopy(databaseFile);

    assert.equal(receipt.protectedFacts.before.users.rowCount, 1);
    assert.match(receipt.databaseSnapshot.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(receipt.databaseSnapshot.sha256, mainFileHash);
    assert.equal(receipt.databaseSnapshot.readOnly, true);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'databaseCopy'), false);
  } finally {
    if (writer) writer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verification command requires a clean and stable candidate identity by default', () => {
  const {
    parseArgs,
    sameCandidateIdentity,
  } = require('../scripts/verify-periodicals-shadow');
  const options = parseArgs([
    '--database-copy', '/tmp/read-only-copy.sqlite',
    '--confirm-read-only-copy',
  ]);

  assert.equal(options.requireClean, true);
  assert.equal(sameCandidateIdentity(
    { head: 'a', tree: 'b', clean: true },
    { head: 'a', tree: 'b', clean: true },
  ), true);
  assert.equal(sameCandidateIdentity(
    { head: 'a', tree: 'b', clean: true },
    { head: 'a', tree: 'changed', clean: true },
  ), false);
  assert.equal(sameCandidateIdentity(
    { head: 'a', tree: 'b', clean: true },
    { head: 'a', tree: 'b', clean: false },
  ), false);
});

test('candidate bootstrap rejects a module-load side effect before verification runs', async () => {
  const { runCandidateVerification } = require('../scripts/verify-periodicals-shadow');
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'periodicals-bootstrap-side-effect-'));
  const stateFile = path.join(tempDir, 'identity');
  const moduleFile = path.join(tempDir, 'candidate-module.js');
  try {
    fs.writeFileSync(stateFile, 'start', { flag: 'wx' });
    fs.writeFileSync(moduleFile, `
      require('fs').writeFileSync(${JSON.stringify(stateFile)}, 'changed');
      module.exports = { verifyDatabaseCopy: async () => ({ passed: true }) };
    `, { flag: 'wx' });

    for (const sideEffectStage of ['data-paths', 'verifier']) {
      fs.writeFileSync(stateFile, 'start');
      delete require.cache[require.resolve(moduleFile)];
      let verified = false;
      await assert.rejects(
        runCandidateVerification({
          databaseFile: '/private/tmp/unused.sqlite',
          getCandidateIdentity: () => ({
            head: 'head',
            tree: fs.readFileSync(stateFile, 'utf8'),
            clean: true,
          }),
          loadCandidateDataPaths: () => {
            if (sideEffectStage === 'data-paths') require(moduleFile);
            return { resolveDataPaths: () => ({ databaseFile: '/private/tmp/live.sqlite' }) };
          },
          loadCandidateVerifier: () => (sideEffectStage === 'verifier'
            ? require(moduleFile)
            : { verifyDatabaseCopy: async () => ({ passed: true }) }),
          verifyDatabaseCopy: async () => { verified = true; },
        }),
        error => error.code === 'ERR_PERIODICAL_CANDIDATE_CHANGED',
      );
      assert.equal(verified, false);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('live database refusal occurs before the SQLite verifier module loads', async () => {
  const { runCandidateVerification } = require('../scripts/verify-periodicals-shadow');
  let verifierLoaded = false;

  await assert.rejects(
    runCandidateVerification({
      databaseFile: '/private/tmp/live.sqlite',
      getCandidateIdentity: () => ({ head: 'head', tree: 'tree', clean: true }),
      loadCandidateDataPaths: () => ({
        resolveDataPaths: () => ({ databaseFile: '/private/tmp/live.sqlite' }),
      }),
      loadCandidateVerifier: () => {
        verifierLoaded = true;
        return { verifyDatabaseCopy: async () => ({ passed: true }) };
      },
    }),
    error => error.code === 'ERR_PERIODICAL_LIVE_DATABASE_REFUSED',
  );
  assert.equal(verifierLoaded, false);
});

test('receipt path remains absent when the final identity barrier terminates the process', () => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'periodicals-receipt-barrier-'));
  const receiptFile = path.join(tempDir, 'receipt.json');
  try {
    const script = `
      const { publishReceiptAfterBarrier } = require(${JSON.stringify(path.join(
        projectDir,
        'scripts',
        'verify-periodicals-shadow.js',
      ))});
      publishReceiptAfterBarrier({
        receiptFile: ${JSON.stringify(receiptFile)},
        output: '{"passed":true}\\n',
        finalBarrier: () => process.exit(86),
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectDir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 86);
    assert.equal(fs.existsSync(receiptFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('receipt publication is barrier-ordered, private, and no-clobber', () => {
  const { publishReceiptAfterBarrier } = require('../scripts/verify-periodicals-shadow');
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'periodicals-receipt-publish-'));
  const receiptFile = path.join(tempDir, 'receipt.json');
  let barrierObservedAbsent = false;
  try {
    publishReceiptAfterBarrier({
      receiptFile,
      output: '{"passed":true}\n',
      finalBarrier: () => { barrierObservedAbsent = !fs.existsSync(receiptFile); },
    });

    assert.equal(barrierObservedAbsent, true);
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), '{"passed":true}\n');
    assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
    assert.throws(
      () => publishReceiptAfterBarrier({
        receiptFile,
        output: '{"passed":false}\n',
        finalBarrier: () => {},
      }),
      error => error.code === 'EEXIST',
    );
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), '{"passed":true}\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('shadow verification command requires an explicit read-only-copy confirmation', () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-confirmation-');
  try {
    initializeStore(dataDir);
    const result = spawnSync(process.execPath, [
      'scripts/verify-periodicals-shadow.js',
      '--database-copy', path.join(dataDir, 'qmreader.sqlite'),
    ], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      passed: false,
      errorCode: 'ERR_PERIODICAL_COPY_CONFIRMATION_REQUIRED',
    });
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verification command rejects a missing receipt path before opening SQLite', () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-receipt-path-');
  try {
    initializeStore(dataDir);
    const result = spawnSync(process.execPath, [
      'scripts/verify-periodicals-shadow.js',
      '--database-copy', path.join(dataDir, 'qmreader.sqlite'),
      '--confirm-read-only-copy',
      '--receipt',
    ], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      passed: false,
      errorCode: 'ERR_PERIODICAL_RECEIPT_PATH_REQUIRED',
    });
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shadow verification command refuses the configured live database path', () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-live-refusal-');
  try {
    initializeStore(dataDir);
    const result = spawnSync(process.execPath, [
      'scripts/verify-periodicals-shadow.js',
      '--database-copy', path.join(dataDir, 'qmreader.sqlite'),
      '--confirm-read-only-copy',
    ], {
      cwd: projectDir,
      env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      passed: false,
      errorCode: 'ERR_PERIODICAL_LIVE_DATABASE_REFUSED',
    });
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
