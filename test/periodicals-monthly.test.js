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

function shanghaiDayStart(periodKey) {
  return Date.parse(`${periodKey}T00:00:00.000+08:00`);
}

function naturalMonthKeys(periodKey) {
  const [year, month] = periodKey.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => (
    `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
  ));
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
    CREATE TABLE entry_stats (
      entry_id TEXT PRIMARY KEY,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
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
  coverageStartedAt,
}) {
  const issueId = `periodical:daily:${periodKey}`;
  const periodStartAt = shanghaiDayStart(periodKey);
  const periodEndAt = periodStartAt + DAY_MS;
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
    const fixtureEvidence = fixture.evidence || [{
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
    const dailyEvidence = fixtureEvidence.map((item, evidenceOrder) => {
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
    coverageStartedAt: coverageStartedAt === undefined ? periodStartAt : coverageStartedAt,
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
    frozenAt: periodEndAt + 1,
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
      'finalizing', 1, ?, ?, ?,
      ?, ?, ?, ?,
      'fallback', NULL, NULL, ?, ?,
      ?, ?
    )
  `).run(
    issue.id,
    storedPeriodKey,
    issue.volumeNo,
    issue.periodStartAt,
    issue.periodEndAt,
    issue.coverageStartedAt,
    issue.overview,
    issue.selectionVersion,
    issue.summaryVersion,
    issue.sourceInputHash,
    JSON.stringify(issue.selectionContext),
    issue.inputHash,
    storedContentHash,
    issue.lastBuiltAt,
    issue.frozenAt,
    issue.periodStartAt,
    issue.frozenAt,
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
    item.timestampFallback ? 1 : 0,
    item.isPrimary ? 1 : 0,
    item.displayOrder,
  ));
  if (frozen) {
    db.prepare(`
      UPDATE periodical_issues
      SET status = 'frozen'
      WHERE id = ? AND status = 'finalizing'
    `).run(issue.id);
  }
  return { issue, themes, events: dailyEvents, evidence };
}

test('Shanghai January boundary rolls the complete prior December into one Frozen Monthly', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const dailyKeys = naturalMonthKeys('2025-12');
    dailyKeys.forEach((periodKey, index) => seedFrozenDaily(db, {
      periodKey,
      volumeNo: index + 1,
    }));

    const scheduled = periodicals.syncMonthlyRollup({
      now: Date.parse('2025-12-31T16:00:00.000Z'),
      trigger: 'year-boundary-test',
    });
    assert.equal(scheduled.action, 'queued');
    assert.equal(scheduled.issueId, 'periodical:monthly:2025-12');
    assert.equal((await periodicals.runNextBuild({
      now: Date.parse('2025-12-31T16:00:00.001Z'),
    })).status, 'succeeded');

    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2025-12' });
    assert.equal(monthly.issue.status, 'frozen');
    assert.equal(monthly.issue.periodStartAt, Date.parse('2025-12-01T00:00:00.000+08:00'));
    assert.equal(monthly.issue.periodEndAt, Date.parse('2026-01-01T00:00:00.000+08:00'));
    assert.equal(monthly.events.length, 0);
    const inputs = db.prepare(`
      SELECT daily_issue_id, display_order
      FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:monthly:2025-12'
      ORDER BY display_order
    `).all().map(row => ({ ...row }));
    assert.deepEqual(
      inputs,
      dailyKeys.map((periodKey, displayOrder) => ({
        daily_issue_id: `periodical:daily:${periodKey}`,
        display_order: displayOrder,
      })),
    );
  } finally {
    db.close();
  }
});

test('Monthly uses every day in 28, 29, 30, and 31-day natural months', async t => {
  const cases = [
    ['2025-02', '2025-02-28T16:00:00.000Z', 28],
    ['2024-02', '2024-02-29T16:00:00.000Z', 29],
    ['2026-04', '2026-04-30T16:00:00.000Z', 30],
    ['2026-07', '2026-07-31T16:00:00.000Z', 31],
  ];
  for (const [monthKey, buildAt, expectedDays] of cases) {
    await t.test(monthKey, async () => {
      const db = fixtureDatabase();
      try {
        const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
        const dailyKeys = naturalMonthKeys(monthKey);
        dailyKeys.forEach((periodKey, index) => seedFrozenDaily(db, {
          periodKey,
          volumeNo: index + 1,
        }));
        assert.equal(dailyKeys.length, expectedDays);
        assert.equal(periodicals.syncMonthlyRollup({ now: Date.parse(buildAt) }).action, 'queued');
        assert.equal((await periodicals.runNextBuild({
          now: Date.parse(buildAt) + 1,
        })).status, 'succeeded');
        const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: monthKey });
        assert.equal(monthly.issue.selectionVersion, 'monthly-rollup-v1');
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count
          FROM periodical_issue_inputs
          WHERE issue_id = ?
        `).get(`periodical:monthly:${monthKey}`).count, expectedDays);
      } finally {
        db.close();
      }
    });
  }
});

test('mid-month enablement skips the partial first month and begins with the next full month', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    seedFrozenDaily(db, { periodKey: '2026-02-15', volumeNo: 1 });

    const partial = periodicals.syncMonthlyRollup({
      now: Date.parse('2026-02-28T16:00:00.000Z'),
      trigger: 'partial-first-month',
    });
    assert.equal(partial.action, 'skipped-partial-month');
    assert.equal(partial.periodKey, '2026-02');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'monthly'
    `).get().count, 0);

    naturalMonthKeys('2026-03').forEach((periodKey, index) => seedFrozenDaily(db, {
      periodKey,
      volumeNo: index + 2,
    }));
    const complete = periodicals.syncMonthlyRollup({
      now: Date.parse('2026-03-31T16:00:00.000Z'),
      trigger: 'first-full-month',
    });
    assert.equal(complete.action, 'queued');
    assert.equal(complete.issueId, 'periodical:monthly:2026-03');
  } finally {
    db.close();
  }
});

test('enablement after midnight on the first day still skips that partial month', () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(db, {
      periodKey,
      volumeNo: index + 1,
      coverageStartedAt: index === 0
        ? Date.parse('2026-04-01T12:00:00.000+08:00')
        : undefined,
    }));

    const result = periodicals.syncMonthlyRollup({
      now: Date.parse('2026-04-30T16:00:00.000Z'),
      trigger: 'partial-first-day',
    });
    assert.equal(result.action, 'skipped-partial-month');
    assert.equal(result.periodKey, '2026-04');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'monthly'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('a sweep after multiple missed boundaries recovers complete months oldest first', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    let dailyVolume = 1;
    seedFrozenDaily(db, { periodKey: '2026-02-15', volumeNo: dailyVolume });
    dailyVolume += 1;
    for (const monthKey of ['2026-03', '2026-04', '2026-05']) {
      naturalMonthKeys(monthKey).forEach(periodKey => {
        seedFrozenDaily(db, { periodKey, volumeNo: dailyVolume });
        dailyVolume += 1;
      });
    }

    const sweepAt = Date.parse('2026-06-01T00:00:00.000+08:00');
    for (const [index, monthKey] of ['2026-03', '2026-04', '2026-05'].entries()) {
      const scheduled = periodicals.syncMonthlyRollup({
        now: sweepAt + (index * 2),
        trigger: 'missed-month-boundaries',
      });
      assert.equal(scheduled.action, 'queued');
      assert.equal(scheduled.issueId, `periodical:monthly:${monthKey}`);
      assert.equal((await periodicals.runNextBuild({
        now: sweepAt + (index * 2) + 1,
      })).status, 'succeeded');
    }

    assert.deepEqual(db.prepare(`
      SELECT period_key, volume_no
      FROM periodical_issues
      WHERE cadence = 'monthly'
      ORDER BY period_start_at
    `).all().map(row => ({ ...row })), [
      { period_key: '2026-03', volume_no: 1 },
      { period_key: '2026-04', volume_no: 2 },
      { period_key: '2026-05', volume_no: 3 },
    ]);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_issues
      WHERE id = 'periodical:monthly:2026-02'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('invalid Daily chains stay retry_wait and never expose a Monthly placeholder', async t => {
  const cases = [
    {
      name: 'missing Daily',
      arrange(db, periodKey, volumeNo) {
        if (periodKey !== '2026-04-15') seedFrozenDaily(db, { periodKey, volumeNo });
      },
      code: 'missing',
    },
    {
      name: 'non-frozen Daily',
      arrange(db, periodKey, volumeNo) {
        seedFrozenDaily(db, { periodKey, volumeNo, frozen: periodKey !== '2026-04-15' });
      },
      code: 'not_frozen',
    },
    {
      name: 'invalid Daily content hash',
      arrange(db, periodKey, volumeNo) {
        seedFrozenDaily(db, {
          periodKey,
          volumeNo,
          contentHashOverride: periodKey === '2026-04-15' ? 'invalid' : undefined,
        });
      },
      code: 'invalid_content_hash',
    },
    {
      name: 'mismatched Daily content hash',
      arrange(db, periodKey, volumeNo) {
        seedFrozenDaily(db, {
          periodKey,
          volumeNo,
          contentHashOverride: periodKey === '2026-04-15' ? 'a'.repeat(64) : undefined,
        });
      },
      code: 'content_hash_mismatch',
    },
    {
      name: 'hash-valid structurally invalid Daily',
      arrange(db, periodKey, volumeNo) {
        seedFrozenDaily(db, {
          periodKey,
          volumeNo,
          events: periodKey === '2026-04-15' ? [{
            key: 'malformed',
            themeKey: 'unknown_theme',
            title: 'Malformed 发布 Input',
            score: 80,
          }] : [],
        });
      },
      code: 'invalid_theme',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const db = fixtureDatabase();
      try {
        const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
        naturalMonthKeys('2026-04').forEach((periodKey, index) => {
          fixture.arrange(db, periodKey, index + 1);
        });
        const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
        const scheduled = periodicals.syncMonthlyRollup({
          now: buildAt,
          trigger: 'invalid-input-test',
        });
        assert.equal(scheduled.action, 'retry_wait');
        assert.equal(scheduled.job.status, 'retry_wait');
        assert.equal(scheduled.job.errorCode, 'ERR_PERIODICAL_MONTHLY_INPUTS_PENDING');
        assert.equal(scheduled.inputErrors.some(error => error.code === fixture.code), true);
        assert.deepEqual(periodicals.listIssues({ cadence: 'monthly' }).issues, []);
        assert.throws(
          () => periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' }),
          error => error.statusCode === 404,
        );
        const retried = await periodicals.runNextBuild({ now: buildAt + (5 * 60 * 1000) });
        assert.equal(retried.status, 'retry_wait');
        assert.equal(retried.errorCode, 'ERR_PERIODICAL_MONTHLY_INPUTS_PENDING');
        assert.deepEqual({ ...db.prepare(`
          SELECT status, revision, content_hash
          FROM periodical_issues
          WHERE id = 'periodical:monthly:2026-04'
        `).get() }, { status: 'finalizing', revision: 0, content_hash: '' });
      } finally {
        db.close();
      }
    });
  }
});

test('Monthly reuses complete-link matching and the exact rollup score formula', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => {
      const events = [0, 2, 4].includes(index) ? [{
        key: `atlas-${index}`,
        title: 'Atlas 发布稳定更新',
        summary: 'Atlas 冻结证据摘要。',
        score: index === 0 ? 80 : 70,
        sourceId: `atlas-source-${index}`,
        sourceName: `Atlas Source ${index}`,
        link: `https://atlas-${index}.example/release`,
      }] : [];
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1, events });
    });

    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    assert.equal(periodicals.syncMonthlyRollup({ now: buildAt }).action, 'queued');
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });

    assert.equal(monthly.events.length, 2);
    assert.deepEqual(
      monthly.events.map(event => event.cluster.inputDailyEvents.length).sort((a, b) => a - b),
      [1, 2],
    );
    const recurring = monthly.events.find(event => event.cluster.inputDailyEvents.length === 2);
    assert.equal(recurring.importanceScore, 69.9);
    assert.deepEqual(recurring.score, {
      version: 'monthly-rollup-v1',
      maxDailyScore: { value: 80, weight: 0.65, points: 52 },
      meanTop3DailyScores: { value: 75, weight: 0.2, points: 15 },
      occurrenceDays: { daysPresent: 2, periodDays: 30, points: 1.7 },
      sourceBreadth: { distinctSources: 2, points: 1.3 },
    });
    assert.match(recurring.whySelected, /本月出现 2 天/);
    assert.deepEqual(
      monthly.events.flatMap(event => event.cluster.inputDailyEvents)
        .map(item => item.dailyIssueId)
        .sort(),
      [0, 2, 4].map(index => `periodical:daily:2026-04-${String(index + 1).padStart(2, '0')}`),
    );
  } finally {
    db.close();
  }
});

test('AI-written Daily prose cannot change Monthly cross-day Event matching', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => {
      const events = index < 2 ? [{
        key: `atlas-${index}`,
        title: 'Atlas stable milestone',
        summary: 'AI-written Daily prose claims the same funding event.',
        score: 80,
        evidence: [{
          entryId: `${periodKey}:atlas:entry`,
          sourceId: `source-${index}`,
          sourceName: `Source ${index}`,
          title: 'Atlas stable milestone',
          titleZh: null,
          link: `https://source-${index}.example/atlas`,
          summary: index === 0
            ? 'Atlas releases a stable milestone.'
            : 'Atlas raises funding for a stable milestone.',
          contentHash: `${periodKey}-atlas-content`,
          publishedAt: shanghaiDayStart(periodKey) + (12 * 60 * 60 * 1000),
        }],
      }] : [];
      seedFrozenDaily(db, { periodKey, volumeNo: index + 1, events });
    });

    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    periodicals.syncMonthlyRollup({ now: buildAt });
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });
    assert.equal(monthly.events.length, 2);
    assert.deepEqual(monthly.events.map(event => event.cluster.inputDailyEvents.length), [1, 1]);
  } finally {
    db.close();
  }
});

test('Monthly applies the 45-point threshold and keeps at most 24 events', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, dayIndex) => {
      const events = dayIndex === 0 ? [
        ...Array.from({ length: 24 }, (_, index) => ({
          key: `bounded-${index}`,
          title: `Project${index} 发布 Tool${index}`,
          score: 80,
          sourceId: `source-${index}`,
          sourceName: `Source ${index}`,
          link: `https://bounded-${index}.example/release`,
        })),
        {
          key: 'threshold-included',
          title: 'ThresholdIn 发布 ExactIn',
          score: 53,
          sourceId: 'threshold-in',
          sourceName: 'Threshold In',
          link: 'https://threshold-in.example/release',
        },
        {
          key: 'threshold-excluded',
          title: 'ThresholdOut 发布 ExactOut',
          score: 52,
          sourceId: 'threshold-out',
          sourceName: 'Threshold Out',
          link: 'https://threshold-out.example/release',
        },
      ] : [];
      seedFrozenDaily(db, { periodKey, volumeNo: dayIndex + 1, events });
    });

    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    periodicals.syncMonthlyRollup({ now: buildAt });
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });
    assert.equal(monthly.events.length, 24);
    assert.equal(monthly.events.every(event => event.importanceScore >= 45), true);
    assert.equal(monthly.events.some(event => event.title === 'ThresholdOut 发布 ExactOut'), false);
  } finally {
    db.close();
  }
});

test('a repaired old Monthly input chain creates a replacement job after month rollover', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const dailyKeys = naturalMonthKeys('2026-04');
    dailyKeys.forEach((periodKey, index) => {
      if (periodKey !== '2026-04-15') seedFrozenDaily(db, { periodKey, volumeNo: index + 1 });
    });
    const aprilBuildAt = Date.parse('2026-04-30T16:00:00.000Z');
    const pending = periodicals.syncMonthlyRollup({
      now: aprilBuildAt,
      trigger: 'old-month-missing',
    });
    assert.equal(pending.action, 'retry_wait');

    seedFrozenDaily(db, { periodKey: '2026-04-15', volumeNo: 15 });
    const laterSweepAt = Date.parse('2026-06-30T16:05:00.000Z');
    const replacement = periodicals.syncMonthlyRollup({
      now: laterSweepAt,
      trigger: 'month-rollover',
    });
    assert.equal(replacement.action, 'queued');
    assert.equal(replacement.issueId, 'periodical:monthly:2026-04');
    assert.equal(periodicals.getBuildJob(pending.job.id).status, 'superseded');
    assert.notEqual(replacement.job.id, pending.job.id);
    assert.equal((await periodicals.runNextBuild({ now: laterSweepAt + 1 })).status, 'succeeded');
    assert.equal(
      periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' }).issue.status,
      'frozen',
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_issues
      WHERE cadence = 'monthly' AND period_key > '2026-04'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('a failed old-month replacement transaction leaves the claimed job retryable', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => {
      if (periodKey !== '2026-04-15') seedFrozenDaily(db, { periodKey, volumeNo: index + 1 });
    });
    const pending = periodicals.syncMonthlyRollup({
      now: Date.parse('2026-04-30T16:00:00.000Z'),
      trigger: 'atomic-replacement-missing',
    });
    seedFrozenDaily(db, { periodKey: '2026-04-15', volumeNo: 15 });
    db.exec(`
      CREATE TRIGGER reject_monthly_replacement_job
      BEFORE INSERT ON periodical_build_jobs
      WHEN NEW.issue_id = 'periodical:monthly:2026-04'
      BEGIN
        SELECT RAISE(ABORT, 'replacement insert failed');
      END;
    `);

    const retried = await periodicals.runNextBuild({
      now: Date.parse('2026-06-30T16:05:00.000Z'),
    });
    assert.equal(retried.id, pending.job.id);
    assert.equal(retried.status, 'retry_wait');
    assert.equal(retried.completedAt, null);
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM periodical_issues
      WHERE id = 'periodical:monthly:2026-04'
    `).get() }, { status: 'finalizing', revision: 0 });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_build_jobs
      WHERE issue_id = 'periodical:monthly:2026-04'
        AND status IN ('queued', 'running', 'retry_wait')
    `).get().count, 1);
  } finally {
    db.close();
  }
});

test('Monthly publish rolls back when the persisted ordered input hash chain is corrupted', async () => {
  const db = fixtureDatabase();
  try {
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(db, {
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
    }));
    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    const scheduled = periodicals.syncMonthlyRollup({ now: buildAt });
    db.exec(`
      CREATE TRIGGER corrupt_monthly_input_chain
      AFTER INSERT ON periodical_issue_inputs
      WHEN NEW.issue_id = 'periodical:monthly:2026-04' AND NEW.display_order = 0
      BEGIN
        UPDATE periodical_issue_inputs
        SET daily_content_hash = '${'b'.repeat(64)}'
        WHERE issue_id = NEW.issue_id AND daily_issue_id = NEW.daily_issue_id;
      END;
    `);

    const failed = await periodicals.runNextBuild({ now: buildAt + 1 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'ERR_PERIODICAL_BUILD_INVALID');
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, content_hash
      FROM periodical_issues
      WHERE id = 'periodical:monthly:2026-04'
    `).get() }, { status: 'finalizing', revision: 0, content_hash: '' });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM periodical_issue_inputs
      WHERE issue_id = 'periodical:monthly:2026-04'
    `).get().count, 0);
    assert.deepEqual(periodicals.listIssues({ cadence: 'monthly' }).issues, []);

    db.exec('DROP TRIGGER corrupt_monthly_input_chain');
    const retried = periodicals.syncMonthlyRollup({
      now: buildAt + 2,
      trigger: 'hash-chain-retry',
    });
    assert.equal(retried.action, 'queued');
    assert.equal(retried.job.id, scheduled.job.id);
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 3 })).status, 'succeeded');
  } finally {
    db.close();
  }
});

test('Frozen Monthly reads only Daily snapshots and survives current mutations, soft deletion, model change, and restart', async () => {
  const dataDir = createTempDataDir('namoo-reader-monthly-snapshot-');
  const databaseFile = path.join(dataDir, 'monthly.sqlite');
  const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
  try {
    const db = fixtureDatabase(databaseFile);
    let original;
    try {
      const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
      naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(db, {
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
      }));
      db.prepare(`
        UPDATE entries
        SET title = 'CURRENT ENTRY MUST NOT LEAK',
            link = 'https://current.example/leak',
            summary = 'CURRENT SUMMARY MUST NOT LEAK',
            content_hash = 'current-mutated-hash',
            deleted_at = ?
        WHERE id = '2026-04-01:snapshot-only:entry'
      `).run(buildAt);
      db.prepare(`
        INSERT INTO source_preferences (
          source_id, enabled, editorial_priority, display_order, updated_at
        ) VALUES ('frozen-source', 0, 'low', 999, '2026-05-01T00:00:00+08:00')
      `).run();
      db.prepare(`
        INSERT INTO entry_stats (entry_id, view_count, last_viewed_at, updated_at)
        VALUES ('2026-04-01:snapshot-only:entry', 100, ?, ?)
      `).run(buildAt, buildAt);

      periodicals.syncMonthlyRollup({ now: buildAt, trigger: 'snapshot-only-test' });
      assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
      original = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });
      assert.equal(original.events[0].title, 'Frozen Atlas 标题');
      assert.equal(JSON.stringify(original).includes('CURRENT'), false);
      assert.deepEqual(original.evidence.map(item => ({
        sourceName: item.sourceName,
        entryTitle: item.entryTitle,
        entryLink: item.entryLink,
        contentHash: item.contentHash,
      })), [{
        sourceName: 'Frozen Source Name',
        entryTitle: 'Frozen Atlas 标题',
        entryLink: 'https://frozen.example/atlas',
        contentHash: '2026-04-01-snapshot-only-content',
      }]);
    } finally {
      db.close();
    }

    fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
      poisoned: { title: 'RUNTIME CACHE MUST NOT LEAK' },
    }));
    const restartedDb = new DatabaseSync(databaseFile);
    try {
      restartedDb.exec('PRAGMA foreign_keys = ON;');
      restartedDb.prepare(`
        UPDATE entries
        SET title = 'RESTARTED CURRENT ENTRY MUST NOT LEAK',
            summary = 'RESTARTED CURRENT SUMMARY MUST NOT LEAK',
            deleted_at = ?
        WHERE id = '2026-04-01:snapshot-only:entry'
      `).run(buildAt + 2);
      restartedDb.prepare(`
        UPDATE source_preferences
        SET enabled = 1, editorial_priority = 'normal', updated_at = '2026-06-01T00:00:00+08:00'
        WHERE source_id = 'frozen-source'
      `).run();
      restartedDb.prepare(`
        UPDATE entry_stats
        SET view_count = 999999, last_viewed_at = ?, updated_at = ?
        WHERE entry_id = '2026-04-01:snapshot-only:entry'
      `).run(buildAt + 2, buildAt + 2);
      let replacementModelCalls = 0;
      const restarted = createPeriodicalsModule({
        db: restartedDb,
        mode: 'shadow',
        logger: () => {},
        aiAdapter: async () => {
          replacementModelCalls += 1;
          throw new Error('replacement model must not run');
        },
      });
      assert.equal(restarted.syncMonthlyRollup({ now: buildAt + 3 }).action, 'noop');
      assert.equal(replacementModelCalls, 0);
      assert.deepEqual(
        restarted.getIssue({ cadence: 'monthly', periodKey: '2026-04' }),
        original,
      );
      assert.equal(JSON.stringify(original).includes('RUNTIME CACHE'), false);
    } finally {
      restartedDb.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Monthly accepts constrained AI prose without changing evidence or deterministic whySelected', async () => {
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
            overview: '本月聚焦有明确证据的进展。所有表达均受冻结证据约束。',
            events: request.evidencePackage.events.map(event => ({
              id: event.id,
              themeKey: 'products_tools',
              title: 'Atlas 稳定更新获得确认',
              summary: '冻结证据说明 Atlas 更新已经发生。',
              evidenceIds: event.evidence.map(item => item.id),
            })),
            themes: [{
              themeKey: 'products_tools',
              trendNote: '本月产品主题延续稳定进展。',
            }],
          }),
          provider: 'monthly-provider',
          model: 'monthly-model',
        };
      },
    });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(db, {
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
    }));

    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    periodicals.syncMonthlyRollup({ now: buildAt, trigger: 'monthly-ai-test' });
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });
    assert.equal(aiCalls, 1);
    assert.equal(receivedCadence, 'monthly');
    assert.equal(monthly.issue.summaryStatus, 'generated');
    assert.equal(monthly.issue.provider, 'monthly-provider');
    assert.equal(monthly.issue.model, 'monthly-model');
    assert.equal(monthly.issue.overview, '本月聚焦有明确证据的进展。所有表达均受冻结证据约束。');
    assert.equal(monthly.themes[0].trendNote, '本月产品主题延续稳定进展。');
    assert.equal(monthly.events[0].whySelected, '最高日报重要性 80 分；top-3 日报均值 80 分；本月出现 1 天；覆盖 1 个来源。');
    assert.deepEqual(monthly.evidence.map(item => item.entryLink), [
      'https://ai-frozen.example/atlas',
    ]);
  } finally {
    db.close();
  }
});

test('invalid Monthly AI output falls back deterministically and freezes the complete issue', async () => {
  const db = fixtureDatabase();
  try {
    let aiCalls = 0;
    const periodicals = createPeriodicalsModule({
      db,
      mode: 'shadow',
      logger: () => {},
      aiAdapter: async () => {
        aiCalls += 1;
        return { content: '{"overview":"unsupported 999 claim"}' };
      },
    });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(db, {
      periodKey,
      volumeNo: index + 1,
      events: index === 0 ? [{
        key: 'fallback-summary',
        title: 'Fallback 发布 Guard',
        score: 80,
      }] : [],
    }));
    const buildAt = Date.parse('2026-04-30T16:00:00.000Z');
    periodicals.syncMonthlyRollup({ now: buildAt });
    assert.equal((await periodicals.runNextBuild({ now: buildAt + 1 })).status, 'succeeded');
    const monthly = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-04' });
    assert.equal(aiCalls, 2);
    assert.equal(monthly.issue.status, 'frozen');
    assert.equal(monthly.issue.summaryStatus, 'fallback');
    assert.equal(monthly.issue.provider, null);
    assert.match(monthly.issue.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(monthly.events.length, 1);
  } finally {
    db.close();
  }
});

test('concurrent Monthly scheduling keeps one job and cadence-local stable volume numbers', {
  timeout: 10000,
}, async () => {
  const dataDir = createTempDataDir('namoo-reader-monthly-concurrency-');
  const databaseFile = path.join(dataDir, 'monthly.sqlite');
  const aprilBuildAt = Date.parse('2026-04-30T16:00:00.000Z');
  try {
    const setup = fixtureDatabase(databaseFile);
    createPeriodicalsModule({ db: setup, mode: 'shadow', logger: () => {} });
    naturalMonthKeys('2026-04').forEach((periodKey, index) => seedFrozenDaily(setup, {
      periodKey,
      volumeNo: index + 101,
    }));
    setup.close();

    const concurrentScript = `
      const { DatabaseSync } = require('node:sqlite');
      const { createPeriodicalsModule } = require('./lib/periodicals');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
      setTimeout(() => {
        const result = periodicals.syncMonthlyRollup({
          now: ${aprilBuildAt},
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
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM periodical_issues WHERE cadence = 'monthly'
      `).get().count, 1);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM periodical_build_jobs
        WHERE issue_id = 'periodical:monthly:2026-04'
      `).get().count, 1);
      assert.equal((await periodicals.runNextBuild({ now: aprilBuildAt + 1 })).status, 'succeeded');

      naturalMonthKeys('2026-05').forEach((periodKey, index) => seedFrozenDaily(db, {
        periodKey,
        volumeNo: index + 201,
      }));
      const mayBuildAt = Date.parse('2026-05-31T16:00:00.000Z');
      assert.equal(periodicals.syncMonthlyRollup({
        now: mayBuildAt,
        trigger: 'second-month-test',
      }).action, 'queued');
      assert.equal((await periodicals.runNextBuild({ now: mayBuildAt + 1 })).status, 'succeeded');
      assert.deepEqual(db.prepare(`
        SELECT period_key, volume_no
        FROM periodical_issues
        WHERE cadence = 'monthly'
        ORDER BY period_key
      `).all().map(row => ({ ...row })), [
        { period_key: '2026-04', volume_no: 1 },
        { period_key: '2026-05', volume_no: 2 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
