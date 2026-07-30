const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { createPeriodicalsModule } = require('../lib/periodicals');
const { computePeriodicalContentHash } = require('../lib/periodical-summary');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const DAY_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
const projectDir = path.resolve(__dirname, '..');
const WEEKLY_BUILD_AT = Date.parse('2026-08-09T16:05:00.000Z');
const DAILY_KEYS = [
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-08',
  '2026-08-09',
];

function shanghaiDayStart(periodKey) {
  return Date.parse(`${periodKey}T00:00:00.000+08:00`);
}

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
  return db;
}

function seedFrozenDaily(db, {
  periodKey,
  volumeNo,
  events = [],
  frozen = true,
  storedPeriodKey = periodKey,
  contentHashOverride,
}) {
  const issueId = `periodical:daily:${periodKey}`;
  const periodStartAt = shanghaiDayStart(periodKey);
  const periodEndAt = periodStartAt + DAY_MS;
  const frozenAt = periodEndAt + 1;
  const themes = [];
  const themeByKey = new Map();
  const dailyEvents = [];
  const evidence = [];

  events.forEach((fixture, displayOrder) => {
    const themeKey = fixture.themeKey || 'products_tools';
    if (!themeByKey.has(themeKey)) {
      const theme = {
        id: `${issueId}:theme:${themeKey}`,
        themeKey,
        title: fixture.themeTitle || '产品与工具',
        trendNote: '本日主题趋势来自冻结快照。',
        displayOrder: themes.length,
      };
      themes.push(theme);
      themeByKey.set(themeKey, theme);
    }
    const eventId = `${issueId}:event:${fixture.key}`;
    const fixtures = fixture.evidence || [{
      entryId: `${periodKey}:${fixture.key}:entry`,
      sourceId: fixture.sourceId || `source-${volumeNo}`,
      sourceName: fixture.sourceName || `Source ${volumeNo}`,
      title: fixture.title,
      titleZh: null,
      link: fixture.link || `https://source-${volumeNo}.example/${fixture.key}`,
      summary: fixture.summary || '冻结日报摘要。',
      contentHash: `${periodKey}-${fixture.key}-content`,
      publishedAt: fixture.publishedAt || periodStartAt + (12 * 60 * 60 * 1000),
    }];
    const dailyEvidence = fixtures.map((item, evidenceOrder) => {
      db.prepare(`
        INSERT OR IGNORE INTO entries (
          id, source_id, title, link, published_ts, summary, content,
          content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.entryId,
        item.sourceId,
        item.title,
        item.link,
        item.publishedAt,
        item.summary,
        item.summary,
        `current-${item.contentHash}`,
        item.publishedAt,
        item.publishedAt,
      );
      return {
        eventId,
        entryId: item.entryId,
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        sourceLabels: ['产品'],
        editorialPriority: 'high',
        entryTitle: item.title,
        entryTitleZh: item.titleZh,
        entryLink: item.link,
        canonicalUrl: item.link,
        summaryExcerpt: item.summary,
        contentHash: item.contentHash,
        effectivePublishedAt: item.publishedAt,
        timestampFallback: false,
        isPrimary: evidenceOrder === 0,
        displayOrder: evidenceOrder,
      };
    });
    evidence.push(...dailyEvidence);
    dailyEvents.push({
      id: eventId,
      themeId: themeByKey.get(themeKey).id,
      eventKey: `${periodKey}:${fixture.key}`,
      topicKey: fixture.topicKey || `topic:${fixture.key}`,
      title: fixture.title,
      summary: fixture.summary || '冻结日报摘要。',
      summaryEvidenceIds: [dailyEvidence[0].entryId],
      whySelected: `日报重要性 ${fixture.score} 分。`,
      effectiveAt: Math.max(...dailyEvidence.map(item => item.effectivePublishedAt)),
      firstSeenAt: Math.min(...dailyEvidence.map(item => item.effectivePublishedAt)),
      lastSeenAt: Math.max(...dailyEvidence.map(item => item.effectivePublishedAt)),
      importanceScore: fixture.score,
      score: {
        version: 'importance-v1',
        confirmation: { independentSourceCount: dailyEvidence.length },
      },
      cluster: {
        version: 'event-cluster-v1',
        entryIds: dailyEvidence.map(item => item.entryId),
      },
      displayOrder,
    });
  });

  const issue = {
    id: issueId,
    cadence: 'daily',
    periodKey,
    volumeNo,
    timezone: 'Asia/Shanghai',
    periodStartAt,
    periodEndAt,
    coverageStartedAt: periodStartAt,
    status: 'frozen',
    revision: 1,
    overview: events.length ? '本日冻结日报包含可复核事件。第二句。' : '本日为空日报。第二句。',
    selectionVersion: 'importance-v1',
    summaryVersion: 'constrained-summary-v1',
    sourceInputHash: `source-input:${periodKey}`,
    selectionContext: { fixture: true },
    inputHash: `input:${periodKey}`,
    contentHash: '',
    summaryStatus: 'fallback',
    provider: null,
    model: null,
    lastBuiltAt: periodEndAt,
    frozenAt,
  };
  issue.contentHash = computePeriodicalContentHash({
    issue,
    themes,
    events: dailyEvents,
    evidence,
  });
  const storedContentHash = contentHashOverride === undefined
    ? issue.contentHash
    : contentHashOverride;

  db.prepare(`
    INSERT INTO periodical_issues (
      id, cadence, period_key, volume_no, timezone,
      period_start_at, period_end_at, coverage_started_at,
      status, revision, overview, selection_version, summary_version,
      source_input_hash, selection_context_json, input_hash, content_hash,
      summary_status, provider, model, last_built_at, frozen_at,
      created_at, updated_at
    ) VALUES (
      ?, 'daily', ?, ?, 'Asia/Shanghai',
      ?, ?, ?,
      'finalizing', 1, ?, 'importance-v1', 'constrained-summary-v1',
      ?, ?, ?, ?,
      'fallback', NULL, NULL, ?, ?,
      ?, ?
    )
  `).run(
    issueId,
    storedPeriodKey,
    volumeNo,
    periodStartAt,
    periodEndAt,
    periodStartAt,
    issue.overview,
    issue.sourceInputHash,
    JSON.stringify(issue.selectionContext),
    issue.inputHash,
    storedContentHash,
    issue.lastBuiltAt,
    issue.frozenAt,
    periodStartAt,
    frozenAt,
  );
  const insertTheme = db.prepare(`
    INSERT INTO periodical_themes (
      id, issue_id, theme_key, title, trend_note, display_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  themes.forEach(theme => insertTheme.run(
    theme.id,
    issueId,
    theme.themeKey,
    theme.title,
    theme.trendNote,
    theme.displayOrder,
  ));
  const insertEvent = db.prepare(`
    INSERT INTO periodical_events (
      id, issue_id, theme_id, event_key, topic_key, title, summary,
      summary_evidence_json, why_selected, effective_at,
      first_seen_at, last_seen_at, importance_score,
      score_json, cluster_json, display_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  dailyEvents.forEach(event => insertEvent.run(
    event.id,
    issueId,
    event.themeId,
    event.eventKey,
    event.topicKey,
    event.title,
    event.summary,
    JSON.stringify(event.summaryEvidenceIds),
    event.whySelected,
    event.effectiveAt,
    event.firstSeenAt,
    event.lastSeenAt,
    event.importanceScore,
    JSON.stringify(event.score),
    JSON.stringify(event.cluster),
    event.displayOrder,
  ));
  const insertEvidence = db.prepare(`
    INSERT INTO periodical_event_evidence (
      event_id, entry_id, source_id, source_name, source_labels_json,
      editorial_priority, entry_title, entry_title_zh, entry_link,
      canonical_url, summary_excerpt, content_hash,
      effective_published_at, timestamp_fallback, is_primary, display_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  evidence.forEach(item => insertEvidence.run(
    item.eventId,
    item.entryId,
    item.sourceId,
    item.sourceName,
    JSON.stringify(item.sourceLabels),
    item.editorialPriority,
    item.entryTitle,
    item.entryTitleZh,
    item.entryLink,
    item.canonicalUrl,
    item.summaryExcerpt,
    item.contentHash,
    item.effectivePublishedAt,
    0,
    item.isPrimary ? 1 : 0,
    item.displayOrder,
  ));
  if (frozen) {
    db.prepare(`
      UPDATE periodical_issues
      SET status = 'frozen'
      WHERE id = ? AND status = 'finalizing'
    `).run(issueId);
  }
  return { issue, themes, events: dailyEvents, evidence };
}

test('previous full ISO week rolls seven Frozen Daily snapshots into one frozen Weekly', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const scores = [45.2, 45, 45, 44];
    DAILY_KEYS.forEach((periodKey, index) => {
      const events = [];
      if (index < scores.length) {
        events.push({
          key: 'atlas-release',
          title: 'Atlas 发布稳定更新',
          summary: `Atlas 冻结日报摘要 ${index + 1}。`,
          score: scores[index],
          sourceId: `source-${index + 1}`,
          sourceName: `Frozen Source ${index + 1}`,
          link: `https://source-${index + 1}.example/atlas-release`,
        });
      }
      if (index === 4) {
        events.push({
          key: 'below-threshold',
          title: 'Boreal 发布独立工具',
          summary: '只在一个日报出现的低分事件。',
          score: 50,
          sourceId: 'source-boreal',
          sourceName: 'Frozen Boreal Source',
          link: 'https://boreal.example/tool',
        });
      }
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1, events });
    });

    const scheduled = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT,
      trigger: 'weekly-test',
    });
    assert.equal(scheduled.action, 'queued');
    assert.equal(scheduled.issueId, 'periodical:weekly:2026-W32');

    const completed = await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 });
    assert.equal(completed.status, 'succeeded');

    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });
    assert.equal(weekly.issue.status, 'frozen');
    assert.equal(weekly.issue.volumeNo, 1);
    assert.equal(weekly.issue.revision, 1);
    assert.equal(weekly.issue.summaryStatus, 'fallback');
    assert.match(weekly.issue.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(weekly.events.length, 1);
    assert.equal(weekly.events[0].title, 'Atlas 发布稳定更新');
    assert.equal(weekly.events[0].importanceScore, 47.1);
    assert.deepEqual(weekly.events[0].score, {
      version: 'weekly-rollup-v1',
      maxDailyScore: { value: 45.2, weight: 0.65, points: 29.4 },
      meanTop3DailyScores: { value: 45.1, weight: 0.2, points: 9 },
      occurrenceDays: { daysPresent: 4, periodDays: 7, points: 5 },
      sourceBreadth: { distinctSources: 4, points: 3.8 },
    });
    assert.match(weekly.events[0].whySelected, /最高日报重要性 45\.2 分/);
    assert.match(weekly.events[0].whySelected, /top-3 日报均值 45\.1 分/);
    assert.match(weekly.events[0].whySelected, /本周出现 4 天/);
    assert.match(weekly.events[0].whySelected, /覆盖 4 个来源/);
    assert.deepEqual(
      weekly.events[0].cluster.inputDailyEvents.map(item => item.dailyIssueId),
      DAILY_KEYS.slice(0, 4).map(key => `periodical:daily:${key}`),
    );
    assert.equal(weekly.events[0].cluster.inputDailyEvents.length, 4);
    assert.deepEqual(
      weekly.evidence.map(item => item.sourceName),
      ['Frozen Source 1', 'Frozen Source 2', 'Frozen Source 3', 'Frozen Source 4'],
    );

    const inputs = db.prepare(`
      SELECT daily_issue_id, daily_content_hash, display_order
      FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:weekly:2026-W32'
      ORDER BY display_order
    `).all();
    assert.deepEqual(inputs.map(input => input.daily_issue_id), DAILY_KEYS.map(
      key => `periodical:daily:${key}`,
    ));
    assert.deepEqual(inputs.map(input => input.display_order), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(inputs.every(input => /^[a-f0-9]{64}$/.test(input.daily_content_hash)), true);
    assert.deepEqual(
      periodicals.listIssues({ cadence: 'weekly' }).issues.map(issue => issue.periodKey),
      ['2026-W32'],
    );
  } finally {
    db.close();
  }
});

test('invalid Daily chains remain durable retry_wait work and never publish a Weekly', async t => {
  for (const scenario of [
    { name: 'missing Daily', invalidIndex: 2, arrange: () => null },
    {
      name: 'non-frozen Daily',
      invalidIndex: 2,
      arrange: options => ({ ...options, frozen: false }),
    },
    {
      name: 'date-mismatched Daily',
      invalidIndex: 2,
      arrange: options => ({ ...options, storedPeriodKey: '2026-08-30' }),
    },
    {
      name: 'empty Daily content hash',
      invalidIndex: 2,
      arrange: options => ({ ...options, contentHashOverride: '' }),
    },
    {
      name: 'mismatched Daily content hash',
      invalidIndex: 2,
      arrange: options => ({ ...options, contentHashOverride: 'a'.repeat(64) }),
    },
    {
      name: 'hash-valid Daily with an invalid theme',
      invalidIndex: 2,
      arrange: options => ({
        ...options,
        events: [{
          key: 'invalid-theme',
          title: 'Atlas 发布稳定更新',
          summary: '该冻结日报结构包含未知主题。',
          score: 80,
          themeKey: 'unknown_theme',
        }],
      }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const db = fixtureDatabase();
      try {
        const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
        seedFrozenDaily(db, { periodKey: '2026-07-27', volumeNo: 1 });
        DAILY_KEYS.forEach((periodKey, index) => {
          const options = { periodKey, volumeNo: index + 2 };
          if (index === scenario.invalidIndex) {
            const arranged = scenario.arrange(options);
            if (arranged) seedFrozenDaily(db, arranged);
          } else {
            seedFrozenDaily(db, options);
          }
        });

        const scheduled = periodicals.syncWeeklyRollup({
          now: WEEKLY_BUILD_AT,
          trigger: 'invalid-input-test',
        });
        assert.equal(scheduled.action, 'retry_wait');
        assert.equal(scheduled.job.status, 'retry_wait');
        assert.equal(scheduled.job.errorCode, 'ERR_PERIODICAL_WEEKLY_INPUTS_PENDING');
        assert.equal(scheduled.inputErrors.length, 1);
        assert.deepEqual(periodicals.listIssues({ cadence: 'weekly' }).issues, []);
        assert.throws(
          () => periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' }),
          error => error && error.statusCode === 404,
        );
        assert.equal(await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 }), null);

        const retried = await periodicals.runNextBuild({ now: scheduled.job.nextRetryAt });
        assert.equal(retried.status, 'retry_wait');
        assert.equal(retried.errorCode, 'ERR_PERIODICAL_WEEKLY_INPUTS_PENDING');
        assert.equal(retried.attemptCount, 1);
        assert.equal(retried.completedAt, null);

        if (scenario.name === 'missing Daily') {
          seedFrozenDaily(db, {
            periodKey: DAILY_KEYS[scenario.invalidIndex],
            volumeNo: scenario.invalidIndex + 2,
          });
          const recovered = periodicals.syncWeeklyRollup({
            now: scheduled.job.nextRetryAt + 1,
            trigger: 'daily-recovered',
          });
          assert.equal(recovered.action, 'queued');
          assert.equal(periodicals.getBuildJob(scheduled.job.id).status, 'superseded');
          assert.equal(
            (await periodicals.runNextBuild({ now: scheduled.job.nextRetryAt + 2 })).status,
            'succeeded',
          );
        }
      } finally {
        db.close();
      }
    });
  }
});

test('a repaired old Weekly input chain creates a replacement job after ISO-week rollover', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    seedFrozenDaily(db, { periodKey: '2026-07-27', volumeNo: 1 });
    DAILY_KEYS.forEach((periodKey, index) => {
      if (index !== 2) seedFrozenDaily(db, { periodKey, volumeNo: index + 2 });
    });

    const pending = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT,
      trigger: 'old-week-missing',
    });
    assert.equal(pending.action, 'retry_wait');

    seedFrozenDaily(db, { periodKey: DAILY_KEYS[2], volumeNo: 4 });
    const laterSweepAt = Date.parse('2026-08-23T16:05:00.000Z');
    assert.equal(periodicals.syncWeeklyRollup({
      now: laterSweepAt,
      trigger: 'week-rollover',
    }).issueId, 'periodical:weekly:2026-W34');

    const replacement = await periodicals.runNextBuild({ now: laterSweepAt + 1 });
    assert.equal(periodicals.getBuildJob(pending.job.id).status, 'superseded');
    assert.equal(replacement.issueId, 'periodical:weekly:2026-W32');
    assert.equal(replacement.status, 'queued');
    assert.notEqual(replacement.id, pending.job.id);
    assert.equal((await periodicals.runNextBuild({ now: laterSweepAt + 2 })).status, 'succeeded');
    assert.equal(
      periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' }).issue.status,
      'frozen',
    );
  } finally {
    db.close();
  }
});

test('a failed old-week replacement transaction leaves the claimed job retryable', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    seedFrozenDaily(db, { periodKey: '2026-07-27', volumeNo: 1 });
    DAILY_KEYS.forEach((periodKey, index) => {
      if (index !== 2) seedFrozenDaily(db, { periodKey, volumeNo: index + 2 });
    });
    const pending = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT,
      trigger: 'atomic-replacement-missing',
    });
    seedFrozenDaily(db, { periodKey: DAILY_KEYS[2], volumeNo: 4 });
    db.exec(`
      CREATE TRIGGER reject_weekly_replacement_job
      BEFORE INSERT ON periodical_build_jobs
      WHEN NEW.issue_id = 'periodical:weekly:2026-W32'
      BEGIN
        SELECT RAISE(ABORT, 'replacement insert failed');
      END;
    `);

    const retried = await periodicals.runNextBuild({
      now: Date.parse('2026-08-23T16:05:00.000Z'),
    });
    assert.equal(retried.id, pending.job.id);
    assert.equal(retried.status, 'retry_wait');
    assert.equal(retried.completedAt, null);
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM periodical_issues
      WHERE id = 'periodical:weekly:2026-W32'
    `).get() }, { status: 'finalizing', revision: 0 });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_build_jobs
      WHERE issue_id = 'periodical:weekly:2026-W32'
        AND status IN ('queued', 'running', 'retry_wait')
    `).get().count, 1);
  } finally {
    db.close();
  }
});

test('midweek enablement skips the partial first ISO week and begins after a complete week', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const partialKeys = ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'];
    partialKeys.forEach((periodKey, index) => {
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1 });
    });

    const skipped = periodicals.syncWeeklyRollup({
      now: Date.parse('2026-08-02T16:05:00.000Z'),
      trigger: 'first-monday',
    });
    assert.equal(skipped.action, 'skipped-partial-week');
    assert.equal(skipped.periodKey, '2026-W31');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'weekly'").get().count, 0);

    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, { periodKey, volumeNo: partialKeys.length + index + 1 });
    });
    const firstComplete = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT,
      trigger: 'second-monday',
    });
    assert.equal(firstComplete.action, 'queued');
    assert.equal(firstComplete.issueId, 'periodical:weekly:2026-W32');
  } finally {
    db.close();
  }
});

test('ISO week-year and Shanghai Monday boundary select the previous complete week', () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const yearBoundaryKeys = [
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ];
    yearBoundaryKeys.forEach((periodKey, index) => {
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1 });
    });

    const beforeShanghaiMonday = periodicals.syncWeeklyRollup({
      now: Date.parse('2026-01-04T15:59:59.999Z'),
      trigger: 'before-shanghai-monday',
    });
    assert.equal(beforeShanghaiMonday.action, 'skipped-partial-week');
    assert.equal(beforeShanghaiMonday.periodKey, '2025-W52');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'weekly'
    `).get().count, 0);

    const atShanghaiMonday = periodicals.syncWeeklyRollup({
      now: Date.parse('2026-01-04T16:00:00.000Z'),
      trigger: 'at-shanghai-monday',
    });
    assert.equal(atShanghaiMonday.action, 'queued');
    assert.equal(atShanghaiMonday.issueId, 'periodical:weekly:2026-W01');
  } finally {
    db.close();
  }
});

test('cross-day matching remains complete-link and records every Daily Event identity', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: index + 1,
        events: [0, 2, 4].includes(index) ? [{
          key: 'atlas-chain',
          title: 'Atlas 发布稳定更新',
          summary: 'Atlas 冻结证据摘要。',
          score: 80,
          sourceId: `chain-source-${index}`,
          sourceName: `Chain Source ${index}`,
          link: `https://chain-${index}.example/atlas`,
        }] : [],
      });
    });

    periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'complete-link-test' });
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');
    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });

    assert.equal(weekly.events.length, 2);
    assert.deepEqual(
      weekly.events.map(event => event.cluster.inputDailyEvents.length).sort((a, b) => a - b),
      [1, 2],
    );
    const recordedInputs = weekly.events.flatMap(event => event.cluster.inputDailyEvents)
      .sort((left, right) => left.dailyPeriodKey.localeCompare(right.dailyPeriodKey));
    assert.deepEqual(
      recordedInputs.map(item => item.dailyIssueId),
      [DAILY_KEYS[0], DAILY_KEYS[2], DAILY_KEYS[4]].map(
        periodKey => `periodical:daily:${periodKey}`,
      ),
    );
    assert.deepEqual(
      recordedInputs.map(item => item.dailyEventId),
      [DAILY_KEYS[0], DAILY_KEYS[2], DAILY_KEYS[4]].map(
        periodKey => `periodical:daily:${periodKey}:event:atlas-chain`,
      ),
    );
  } finally {
    db.close();
  }
});

test('AI-written Daily summaries cannot change deterministic cross-day Event matching', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      const events = [];
      if (index < 2) {
        const evidenceAction = index === 0
          ? 'Atlas releases a stable milestone.'
          : 'Atlas raises funding for a stable milestone.';
        events.push({
          key: `atlas-${index}`,
          title: 'Atlas stable milestone',
          summary: 'Atlas raises funding, according to an AI-written Daily summary.',
          score: 80,
          evidence: [{
            entryId: `${periodKey}:atlas-deterministic:entry`,
            sourceId: `deterministic-source-${index}`,
            sourceName: `Deterministic Source ${index}`,
            title: 'Atlas stable milestone',
            titleZh: null,
            link: `https://deterministic-${index}.example/atlas`,
            summary: evidenceAction,
            contentHash: `${periodKey}-atlas-deterministic-content`,
            publishedAt: shanghaiDayStart(periodKey) + (12 * 60 * 60 * 1000),
          }],
        });
      }
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1, events });
    });

    periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'no-ai-matching' });
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');
    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });
    assert.equal(weekly.events.length, 2);
    assert.deepEqual(
      weekly.events.map(event => event.cluster.inputDailyEvents.length),
      [1, 1],
    );
  } finally {
    db.close();
  }
});

test('Weekly compilation reads only Frozen Daily snapshots, not current Entry or Source state', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: index + 1,
        events: index === 0 ? [{
          key: 'snapshot-only',
          title: 'Frozen Atlas 标题',
          summary: 'Frozen Atlas 摘要。',
          score: 80,
          sourceId: 'frozen-source',
          sourceName: 'Frozen Source Name',
          link: 'https://frozen.example/atlas',
        }] : [],
      });
    });

    db.prepare(`
      UPDATE entries
      SET title = 'CURRENT ENTRY MUST NOT LEAK',
          link = 'https://current.example/leak',
          summary = 'CURRENT SUMMARY MUST NOT LEAK',
          content_hash = 'current-mutated-hash'
      WHERE id = ?
    `).run(`${DAILY_KEYS[0]}:snapshot-only:entry`);
    db.exec(`
      ALTER TABLE entries RENAME TO forbidden_current_entries;
      ALTER TABLE entry_translations RENAME TO forbidden_current_entry_translations;
      ALTER TABLE source_preferences RENAME TO forbidden_current_source_preferences;
      ALTER TABLE custom_sources RENAME TO forbidden_current_custom_sources;
    `);

    assert.equal(
      periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'snapshot-only-test' }).action,
      'queued',
    );
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');

    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });
    assert.equal(weekly.events[0].title, 'Frozen Atlas 标题');
    assert.equal(weekly.events[0].summary.includes('CURRENT'), false);
    assert.deepEqual(weekly.evidence.map(item => ({
      sourceName: item.sourceName,
      entryTitle: item.entryTitle,
      entryLink: item.entryLink,
      contentHash: item.contentHash,
    })), [{
      sourceName: 'Frozen Source Name',
      entryTitle: 'Frozen Atlas 标题',
      entryLink: 'https://frozen.example/atlas',
      contentHash: `${DAILY_KEYS[0]}-snapshot-only-content`,
    }]);
  } finally {
    db.close();
  }
});

test('seven empty Frozen Dailies publish an empty Weekly without a coverage gap', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1 });
    });

    assert.equal(
      periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'empty-week-test' }).action,
      'queued',
    );
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');

    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });
    assert.equal(weekly.issue.status, 'frozen');
    assert.equal(weekly.events.length, 0);
    assert.equal(weekly.evidence.length, 0);
    assert.match(weekly.issue.overview, /七份冻结日报均已完整覆盖/);
    const inputs = db.prepare(`
      SELECT daily_issue_id
      FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:weekly:2026-W32'
      ORDER BY display_order
    `).all();
    assert.equal(inputs.length, 7);
    assert.deepEqual(
      inputs.map(input => input.daily_issue_id),
      DAILY_KEYS.map(periodKey => `periodical:daily:${periodKey}`),
    );
  } finally {
    db.close();
  }
});

test('Weekly applies the 45-point threshold', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, dayIndex) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: dayIndex + 1,
        events: dayIndex === 0 ? [{
          key: 'threshold-included',
          title: 'ThresholdIn 发布 ExactIn',
          score: 53,
          sourceId: 'threshold-in-source',
          sourceName: 'Threshold In Source',
          link: 'https://threshold-in.example/release',
        }, {
          key: 'threshold-excluded',
          title: 'ThresholdOut 发布 ExactOut',
          score: 52,
          sourceId: 'threshold-out-source',
          sourceName: 'Threshold Out Source',
          link: 'https://threshold-out.example/release',
        }] : [],
      });
    });

    periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'threshold-test' });
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');
    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });

    assert.equal(weekly.events.length, 1);
    assert.equal(weekly.events[0].title, 'ThresholdIn 发布 ExactIn');
    assert.equal(weekly.events[0].importanceScore, 45.1);
  } finally {
    db.close();
  }
});

test('Weekly keeps at most 18 events', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, dayIndex) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: dayIndex + 1,
        events: Array.from({ length: 3 }, (_, eventIndex) => {
          const serial = (dayIndex * 3) + eventIndex;
          return {
            key: `bounded-${serial}`,
            title: `Project${serial} 发布 Tool${serial}`,
            summary: `Project${serial} 的冻结日报证据。`,
            score: 80,
            sourceId: `bounded-source-${serial}`,
            sourceName: `Bounded Source ${serial}`,
            link: `https://bounded-${serial}.example/release`,
          };
        }),
      });
    });

    periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'max-events-test' });
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');
    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });

    assert.equal(weekly.events.length, 18);
    assert.equal(weekly.events.every(event => event.importanceScore >= 45), true);
  } finally {
    db.close();
  }
});

test('Weekly publish rolls back when the persisted ordered input hash chain is corrupted', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: index + 1,
        events: index === 0 ? [{
          key: 'hash-chain',
          title: 'HashChain 发布 Guard',
          score: 80,
          sourceId: 'hash-chain-source',
          sourceName: 'Hash Chain Source',
          link: 'https://hash-chain.example/guard',
        }] : [],
      });
    });
    const scheduled = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT,
      trigger: 'hash-chain-test',
    });
    db.exec(`
      CREATE TRIGGER corrupt_weekly_input_chain
      AFTER INSERT ON periodical_issue_inputs
      WHEN NEW.issue_id = 'periodical:weekly:2026-W32' AND NEW.display_order = 0
      BEGIN
        UPDATE periodical_issue_inputs
        SET daily_content_hash = '${'b'.repeat(64)}'
        WHERE issue_id = NEW.issue_id AND daily_issue_id = NEW.daily_issue_id;
      END;
    `);

    const failed = await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'ERR_PERIODICAL_BUILD_INVALID');
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, content_hash
      FROM periodical_issues
      WHERE id = 'periodical:weekly:2026-W32'
    `).get() }, { status: 'finalizing', revision: 0, content_hash: '' });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:weekly:2026-W32'
    `).get().count, 0);
    assert.deepEqual(periodicals.listIssues({ cadence: 'weekly' }).issues, []);

    db.exec('DROP TRIGGER corrupt_weekly_input_chain');
    const retried = periodicals.syncWeeklyRollup({
      now: WEEKLY_BUILD_AT + 2,
      trigger: 'hash-chain-retry',
    });
    assert.equal(retried.action, 'queued');
    assert.equal(retried.job.id, scheduled.job.id);
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 3 })).status, 'succeeded');
    assert.equal(
      periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' }).issue.status,
      'frozen',
    );
  } finally {
    db.close();
  }
});

test('concurrent Weekly scheduling keeps one job and cadence-local volume numbers', {
  timeout: 10000,
}, async () => {
  const dataDir = createTempDataDir('namoo-reader-weekly-concurrency-');
  const databaseFile = path.join(dataDir, 'weekly.sqlite');
  const secondWeekKeys = [
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-15',
    '2026-08-16',
  ];
  try {
    const setup = fixtureDatabase(databaseFile);
    createPeriodicalsModule({ db: setup, mode: 'shadow', logger: () => {} });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(setup, { periodKey, volumeNo: index + 101 });
    });
    setup.close();

    const concurrentScript = `
      const { DatabaseSync } = require('node:sqlite');
      const { createPeriodicalsModule } = require('./lib/periodicals');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
      setTimeout(() => {
        const result = periodicals.syncWeeklyRollup({
          now: ${WEEKLY_BUILD_AT},
          trigger: 'concurrency-test',
        });
        process.stdout.write(JSON.stringify({ action: result.action, jobId: result.job.id }));
        db.close();
      }, 50);
    `;
    const children = await Promise.all([0, 1].map(() => execFileAsync(
      process.execPath,
      ['-e', concurrentScript, databaseFile],
      { cwd: projectDir },
    )));
    assert.deepEqual(
      children.map(child => JSON.parse(child.stdout).action).sort(),
      ['noop', 'queued'],
    );
    assert.equal(new Set(children.map(child => JSON.parse(child.stdout).jobId)).size, 1);

    const db = new DatabaseSync(databaseFile);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'weekly'
    `).get().count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_build_jobs
      WHERE issue_id = 'periodical:weekly:2026-W32'
    `).get().count, 1);
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');

    secondWeekKeys.forEach((periodKey, index) => {
      seedFrozenDaily(db, { periodKey, volumeNo: index + 201 });
    });
    const secondBuildAt = Date.parse('2026-08-16T16:05:00.000Z');
    assert.equal(periodicals.syncWeeklyRollup({
      now: secondBuildAt,
      trigger: 'second-week-test',
    }).action, 'queued');
    assert.equal((await periodicals.runNextBuild({ now: secondBuildAt + 1 })).status, 'succeeded');
    assert.deepEqual(db.prepare(`
      SELECT period_key, volume_no
      FROM periodical_issues
      WHERE cadence = 'weekly'
      ORDER BY period_key
    `).all().map(row => ({ ...row })), [
      { period_key: '2026-W32', volume_no: 1 },
      { period_key: '2026-W33', volume_no: 2 },
    ]);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Weekly accepts constrained AI prose without changing score explanations or evidence', async () => {
  const db = fixtureDatabase();
  try {
    let aiCalls = 0;
    let receivedCadence = null;
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      logger: () => {},
      aiAdapter: async request => {
        aiCalls += 1;
        receivedCadence = request.evidencePackage.issue.cadence;
        return {
          content: JSON.stringify({
            overview: '本周聚焦有明确证据的进展。所有表达均受冻结证据约束。',
            events: request.evidencePackage.events.map(event => ({
              id: event.id,
              themeKey: 'products_tools',
              title: 'Atlas 稳定更新获得确认',
              summary: '冻结证据说明 Atlas 更新已经发生。',
              evidenceIds: event.evidence.map(item => item.id),
            })),
            themes: [{
              themeKey: 'products_tools',
              trendNote: '本周产品主题延续稳定进展。',
            }],
          }),
          provider: 'weekly-provider',
          model: 'weekly-model',
        };
      },
    });
    DAILY_KEYS.forEach((periodKey, index) => {
      seedFrozenDaily(db, {
        periodKey,
        volumeNo: index + 1,
        events: index === 0 ? [{
          key: 'ai-summary',
          title: 'Atlas 发布稳定更新',
          summary: 'Atlas 冻结日报摘要。',
          score: 80,
          sourceId: 'ai-frozen-source',
          sourceName: 'AI Frozen Source',
          link: 'https://ai-frozen.example/atlas',
        }] : [],
      });
    });

    periodicals.syncWeeklyRollup({ now: WEEKLY_BUILD_AT, trigger: 'weekly-ai-test' });
    assert.equal((await periodicals.runNextBuild({ now: WEEKLY_BUILD_AT + 1 })).status, 'succeeded');
    const weekly = periodicals.getIssue({ cadence: 'weekly', periodKey: '2026-W32' });

    assert.equal(aiCalls, 1);
    assert.equal(receivedCadence, 'weekly');
    assert.equal(weekly.issue.summaryStatus, 'generated');
    assert.equal(weekly.issue.provider, 'weekly-provider');
    assert.equal(weekly.issue.model, 'weekly-model');
    assert.equal(weekly.issue.overview, '本周聚焦有明确证据的进展。所有表达均受冻结证据约束。');
    assert.equal(weekly.themes[0].trendNote, '本周产品主题延续稳定进展。');
    assert.equal(weekly.events[0].title, 'Atlas 稳定更新获得确认');
    assert.equal(weekly.events[0].summary, '冻结证据说明 Atlas 更新已经发生。');
    assert.equal(
      weekly.events[0].whySelected,
      '最高日报重要性 80 分；top-3 日报均值 80 分；本周出现 1 天；覆盖 1 个来源。',
    );
    assert.deepEqual(weekly.evidence.map(item => ({
      sourceName: item.sourceName,
      entryTitle: item.entryTitle,
      entryLink: item.entryLink,
    })), [{
      sourceName: 'AI Frozen Source',
      entryTitle: 'Atlas 发布稳定更新',
      entryLink: 'https://ai-frozen.example/atlas',
    }]);
  } finally {
    db.close();
  }
});
