const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { computeCanonicalHash } = require('../lib/content-hashes');
const { computePeriodicalContentHash } = require('../lib/periodical-summary');
const {
  candidateIdentitySnapshot,
  candidateInputSnapshot,
  candidateInputSnapshotHash,
  readStoredPeriodicalIssue,
  sourceIdentitySnapshot,
  sourceInputIdentity,
} = require('../lib/periodicals');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.resolve(__dirname, '..');
const storePath = path.join(projectDir, 'lib', 'store.js');

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
        timezone: 'Asia/Shanghai',
        periodStartAt: periodStartAt + (displayOrder * 86_400_000),
        periodEndAt: periodStartAt + ((displayOrder + 1) * 86_400_000),
        status: 'frozen',
        revision: 1,
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
  const rollup = {
    issue: {
      id: issueId,
      cadence,
      periodKey,
      timezone: 'Asia/Shanghai',
      periodStartAt,
      periodEndAt: periodStartAt + (dayCount * 86_400_000),
      status: 'frozen',
      revision: 1,
      contentHash: 'f'.repeat(64),
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
  return {
    dailies,
    documents: new Map(dailies.map(daily => [daily.issue.id, daily])),
    rollup,
  };
}

function seedProtectedFacts(databaseFile, { externalSource = false } = {}) {
  const db = new DatabaseSync(databaseFile);
  const sourceId = externalSource ? 'external-source' : 'verified-source';
  const now = Date.parse('2026-08-01T12:00:00.000Z');
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
  const selectionContext = {
    scoreConfig: { behavior: { enabled: false } },
    candidateCount: 1,
    eligibleSourceCount: 1,
    candidateSnapshot,
    sourceSnapshot,
  };
  db.prepare(`
    INSERT INTO periodical_issues (
      id, cadence, period_key, volume_no, period_start_at, period_end_at,
      status, revision, selection_version, summary_version, source_input_hash,
      selection_context_json, input_hash, content_hash, summary_status,
      last_built_at, created_at, updated_at
    ) VALUES ('verified-issue', 'daily', '2026-08-01', 1, ?, ?, 'open', 1,
      'importance-v1', 'summary-v1', ?, ?, 'input-hash', '', 'fallback', ?, ?, ?)
  `).run(
    now - 3600_000,
    now + 3600_000,
    sourceInputHash,
    JSON.stringify(selectionContext),
    now,
    now - 1000,
    now,
  );
  db.prepare(`
    INSERT INTO periodical_themes (id, issue_id, theme_key, title, display_order)
    VALUES ('verified-theme', 'verified-issue', 'theme', 'Theme', 0)
  `).run();
  db.prepare(`
    INSERT INTO periodical_events (
      id, issue_id, theme_id, event_key, title, effective_at, first_seen_at,
      last_seen_at, importance_score, score_json, cluster_json, display_order
    ) VALUES ('verified-event', 'verified-issue', 'verified-theme', 'event',
      'Event', ?, ?, ?, 90, '{}', '{}', 0)
  `).run(now, now, now);
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
      id, issue_id, source_input_hash, input_hash, as_of_at, selection_version,
      score_config_json, summary_version, trigger_reason, status, candidate_count,
      source_count, created_at, updated_at, completed_at
    ) VALUES ('verified-job', 'verified-issue', ?, 'input-hash', ?,
      'importance-v1', '{}', 'summary-v1', 'test', 'succeeded', 1, 1, ?, ?, ?)
  `).run(sourceInputHash, now, now - 1000, now, now);
  const issueRow = db.prepare(`
    SELECT * FROM periodical_issues WHERE id = 'verified-issue'
  `).get();
  db.prepare(`
    UPDATE periodical_issues SET content_hash = ? WHERE id = 'verified-issue'
  `).run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, issueRow)));
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

    assert.equal(receipt.version, 'periodicals-shadow-verification-v2');
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
      issueContentHashMismatchCount: 0,
      sourceInputHashMismatchCount: 0,
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
      WHERE id = 'verified-issue'
    `).run();
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
    ['wrong daily content hash', ({ rollup }) => { rollup.inputs[3].dailyContentHash = 'e'.repeat(64); }],
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
      WHERE id = 'verified-issue'
    `).run(sourceInputHash, JSON.stringify(selectionContext));
    const issue = db.prepare(`SELECT * FROM periodical_issues WHERE id = 'verified-issue'`).get();
    db.prepare(`UPDATE periodical_issues SET content_hash = ? WHERE id = 'verified-issue'`)
      .run(computePeriodicalContentHash(readStoredPeriodicalIssue(db, issue)));
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
  let verified = false;
  try {
    fs.writeFileSync(stateFile, 'start', { flag: 'wx' });
    fs.writeFileSync(moduleFile, `
      require('fs').writeFileSync(${JSON.stringify(stateFile)}, 'changed');
      module.exports = { verifyDatabaseCopy: async () => ({ passed: true }) };
    `, { flag: 'wx' });

    await assert.rejects(
      runCandidateVerification({
        databaseFile: '/private/tmp/unused.sqlite',
        getCandidateIdentity: () => ({
          head: 'head',
          tree: fs.readFileSync(stateFile, 'utf8'),
          clean: true,
        }),
        loadCandidateModules: () => ({
          ...require(moduleFile),
          resolveDataPaths: () => ({ databaseFile: '/private/tmp/live.sqlite' }),
        }),
        verifyDatabaseCopy: async () => { verified = true; },
      }),
      error => error.code === 'ERR_PERIODICAL_CANDIDATE_CHANGED',
    );
    assert.equal(verified, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
