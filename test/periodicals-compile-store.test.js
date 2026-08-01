const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { compileOpenDaily, createPeriodicalsModule } = require('../lib/periodicals');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

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

test('shadow worker persists a Custom Source event and timestamp fallback through the read module', async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'custom-daily',
      'Custom Daily',
      'https://custom.example/feed.xml',
      'article',
      '["产品"]',
      NOW - 1000,
      NOW - 1000,
    );
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', 0, '2026-07-30T04:00:00.000Z')
    `).run('custom-daily');
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'custom-entry',
      'custom-daily',
      'Future timestamp entry',
      'https://custom.example/posts/one?utm_medium=rss',
      NOW + (7 * 60 * 60 * 1000),
      'SQLite summary.',
      '<p>SQLite body.</p>',
      'custom-entry-content-hash',
      NOW - (10 * 60 * 1000),
      NOW - (10 * 60 * 1000),
    );

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    const queued = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    const built = await periodicals.runNextBuild({ now: NOW });
    const stored = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(queued.action, 'queued');
    assert.equal(built.status, 'succeeded');
    assert.equal(stored.issue.status, 'open');
    assert.equal(stored.issue.summaryStatus, 'fallback');
    assert.equal(stored.issue.summaryVersion, 'constrained-summary-v1');
    assert.equal(stored.issue.revision, 1);
    assert.equal(stored.events.length, 1);
    assert.equal(stored.events[0].importanceScore, 49.9);
    assert.equal(stored.evidence[0].sourceId, 'custom-daily');
    assert.equal(stored.evidence[0].editorialPriority, 'high');
    assert.equal(stored.evidence[0].effectivePublishedAt, NOW - (10 * 60 * 1000));
    assert.equal(stored.evidence[0].timestampFallback, true);

    const selectionContext = JSON.parse(db.prepare(`
      SELECT selection_context_json
      FROM periodical_issues
      WHERE cadence = 'daily' AND period_key = '2026-07-30'
    `).get().selection_context_json);
    assert.deepEqual(selectionContext.sourceSnapshot.find(source => (
      source.sourceId === 'custom-daily'
    )), {
      sourceId: 'custom-daily',
      name: 'Custom Daily',
      category: 'article',
      enabled: true,
      editorialPriority: 'high',
      labels: ['产品'],
    });
    assert.equal(selectionContext.sourceSnapshot.length > 1, true);
    assert.equal(selectionContext.candidateSnapshot.length, 1);
    assert.equal(selectionContext.candidateSnapshot[0].entryId, 'custom-entry');
    assert.equal(
      selectionContext.candidateSnapshot[0].effectivePublishedAt,
      NOW - (10 * 60 * 1000),
    );
    assert.match(selectionContext.candidateSnapshot[0].contentHash, /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test('wall-clock movement is a no-op while a SQLite preference change replaces the open revision', async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES ('custom-daily', 'Custom Daily', 'https://custom.example/feed.xml',
        'article', '["产品"]', ?, ?)
    `).run(NOW - 1000, NOW - 1000);
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES ('custom-daily', 1, 'high', 0, '2026-07-30T04:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('custom-entry', 'custom-daily', 'Stable input',
        'https://custom.example/posts/stable', ?, 'Stable summary.', '<p>Stable body.</p>',
        'stable-content-hash', ?, ?)
    `).run(NOW, NOW, NOW);

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });
    const first = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
    const wallClockOnlyRequest = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'test',
    });
    const wallClockOnly = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(wallClockOnlyRequest.action, 'noop');
    assert.equal(first.issue.revision, 1);
    assert.equal(wallClockOnly.issue.revision, 1);
    assert.equal(wallClockOnly.issue.contentHash, first.issue.contentHash);
    assert.equal(wallClockOnly.events[0].importanceScore, 50);

    const staleContext = JSON.parse(db.prepare(`
      SELECT selection_context_json
      FROM periodical_issues
      WHERE cadence = 'daily' AND period_key = '2026-07-30'
    `).get().selection_context_json);
    staleContext.eventIdentityVersion = 'single-entry-event-v1';
    db.prepare(`
      UPDATE periodical_issues
      SET selection_context_json = ?
      WHERE cadence = 'daily' AND period_key = '2026-07-30'
    `).run(JSON.stringify(staleContext));
    const algorithmChangedRequest = periodicals.syncOpenDaily({
      now: NOW + (2 * 60 * 60 * 1000),
      trigger: 'test',
    });
    await periodicals.runNextBuild({ now: NOW + (2 * 60 * 60 * 1000) });
    const algorithmChanged = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(algorithmChangedRequest.action, 'queued');
    assert.equal(algorithmChanged.issue.revision, 2);

    db.prepare(`
      UPDATE source_preferences
      SET editorial_priority = 'low', updated_at = '2026-07-30T05:00:00.000Z'
      WHERE source_id = 'custom-daily'
    `).run();
    const preferenceChangedRequest = periodicals.syncOpenDaily({
      now: NOW + (3 * 60 * 60 * 1000),
      trigger: 'test',
    });
    await periodicals.runNextBuild({ now: NOW + (3 * 60 * 60 * 1000) });
    const preferenceChanged = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(preferenceChangedRequest.action, 'queued');
    assert.equal(preferenceChanged.issue.revision, 3);
    assert.equal(preferenceChanged.events.length, 0);
    assert.notEqual(preferenceChanged.issue.contentHash, first.issue.contentHash);
  } finally {
    db.close();
  }
});

test('rendered SQLite semantics change the source input identity and replace the open revision', async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES ('custom-daily', 'Original Source', 'https://custom.example/feed.xml',
        'article', '["产品"]', ?, ?)
    `).run(NOW - 1000, NOW - 1000);
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES ('custom-daily', 1, 'high', 0, '2026-07-30T04:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('custom-entry', 'custom-daily', 'Original title',
        'https://custom.example/posts/original', ?, 'Original summary.', '<p>Original body.</p>',
        'stable-content-hash', ?, ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO entry_translations (entry_id, title_zh, summary_zh)
      VALUES ('custom-entry', '原译名', '原译摘。')
    `).run();

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });
    const first = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    db.prepare(`
      UPDATE entry_translations
      SET title_zh = '新译名', summary_zh = '新译摘。'
      WHERE entry_id = 'custom-entry'
    `).run();
    db.prepare(`
      UPDATE custom_sources SET name = 'Renamed Source'
      WHERE id = 'custom-daily'
    `).run();
    db.prepare(`
      UPDATE entries SET link = 'https://custom.example/posts/renamed'
      WHERE id = 'custom-entry'
    `).run();

    periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'test',
    });
    await periodicals.runNextBuild({ now: NOW + (60 * 60 * 1000) });
    const replaced = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(first.issue.revision, 1);
    assert.equal(replaced.issue.revision, 2);
    assert.equal(replaced.events[0].title, '新译名');
    assert.equal(replaced.events[0].summary, '新译摘。');
    assert.equal(replaced.evidence[0].sourceName, 'Renamed Source');
    assert.equal(replaced.evidence[0].entryLink, 'https://custom.example/posts/renamed');
  } finally {
    db.close();
  }
});

test('reassigning an entry between equivalent SQLite sources replaces its evidence source identity', async () => {
  const db = fixtureDatabase();
  try {
    const insertSource = db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES (?, 'Equivalent Source', ?, 'article', '["产品"]', ?, ?)
    `);
    insertSource.run(
      'source-a',
      'https://source-a.example/feed.xml',
      NOW - 1000,
      NOW - 1000,
    );
    insertSource.run(
      'source-b',
      'https://source-b.example/feed.xml',
      NOW - 1000,
      NOW - 1000,
    );
    const insertPreference = db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', ?, '2026-07-30T04:00:00.000Z')
    `);
    insertPreference.run('source-a', 0);
    insertPreference.run('source-b', 1);
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('reassigned-entry', 'source-a', 'Stable entry',
        'https://entry.example/stable', ?, 'Stable summary.', '<p>Stable body.</p>',
        'stable-content-hash', ?, ?)
    `).run(NOW, NOW, NOW);

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', logger: () => {} });
    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });
    const first = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    db.prepare(`
      UPDATE entries SET source_id = 'source-b'
      WHERE id = 'reassigned-entry'
    `).run();
    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });
    const replaced = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(first.issue.revision, 1);
    assert.equal(first.evidence[0].sourceId, 'source-a');
    assert.equal(replaced.issue.revision, 2);
    assert.equal(replaced.evidence[0].sourceId, 'source-b');
  } finally {
    db.close();
  }
});

test('durable build scores the current topic from the latest frozen daily SQLite evidence', async () => {
  const db = fixtureDatabase();
  try {
    const insertSource = db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'article', '["产品"]', ?, ?)
    `);
    const insertPreference = db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', ?, '2026-07-29T04:00:00.000Z')
    `);
    for (const [index, sourceId] of ['source-a', 'source-b'].entries()) {
      insertSource.run(
        sourceId,
        `Source ${sourceId}`,
        `https://${sourceId}.example/feed.xml`,
        NOW - DAY_MS,
        NOW - DAY_MS,
      );
      insertPreference.run(sourceId, index);
    }

    const insertEntry = db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const title = 'Atlas releases Alpha platform for enterprise teams';
    const yesterday = NOW - DAY_MS;
    insertEntry.run(
      'yesterday-a',
      'source-a',
      title,
      'https://source-a.example/yesterday',
      yesterday,
      'Yesterday evidence.',
      '<p>Yesterday evidence.</p>',
      'hash-yesterday-a',
      yesterday,
      yesterday,
    );

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });
    periodicals.syncOpenDaily({ now: yesterday, trigger: 'test' });
    await periodicals.runNextBuild({ now: yesterday });
    const previous = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-29' });
    assert.match(previous.events[0].topicKey, /^[a-f0-9]{64}$/);
    db.prepare(`
      UPDATE periodical_issues
      SET status = 'frozen', frozen_at = period_end_at, updated_at = period_end_at
      WHERE id = ?
    `).run(previous.issue.id);

    for (const sourceId of ['source-a', 'source-b']) {
      insertEntry.run(
        `today-${sourceId}`,
        sourceId,
        title,
        `https://${sourceId}.example/today`,
        NOW,
        `Today evidence from ${sourceId}.`,
        `<p>Today evidence from ${sourceId}.</p>`,
        `hash-today-${sourceId}`,
        NOW,
        NOW,
      );
    }

    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });
    const current = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
    const selectionContext = JSON.parse(db.prepare(`
      SELECT selection_context_json
      FROM periodical_issues
      WHERE id = ?
    `).get(current.issue.id).selection_context_json);

    assert.equal(current.events.length, 1);
    assert.deepEqual(current.events[0].score.confirmation, {
      independentSourceCount: 2,
      points: 8,
    });
    assert.deepEqual(current.events[0].score.persistence, { daysPresent: 1, points: 3.5 });
    assert.deepEqual(current.events[0].score.trend, {
      baselineSourceCount: 1,
      sourceIncrease: 1,
      points: 2,
    });
    assert.match(current.events[0].eventKey, /^[a-f0-9]{64}$/);
    assert.match(current.events[0].topicKey, /^[a-f0-9]{64}$/);
    assert.equal(current.events[0].cluster.version, 'event-cluster-v1');
    assert.equal(current.events[0].cluster.reason, 'complete-link');
    assert.equal(current.evidence.length, 2);
    assert.equal(current.evidence.filter(item => item.isPrimary).length, 1);
    assert.match(current.events[0].whySelected, /2 个独立来源确认/);
    assert.match(current.events[0].whySelected, /过去 7 个冻结日报出现 1 天/);
    assert.match(current.events[0].whySelected, /单日峰值增加 1 个/);
    assert.deepEqual(selectionContext.scoreConfig, {
      behavior: {
        enabled: false,
        maxPoints: 5,
        starWeight: 2,
        viewWeight: 0.5,
      },
      confirmation: { maxPoints: 25, pointsPerAdditionalSource: 8 },
      freshness: { halfLifeHours: 36, maxPoints: 20 },
      maxEvents: 12,
      persistence: {
        lookbackFrozenDailyIssues: 7,
        maxPoints: 14,
        pointsPerDay: 3.5,
      },
      sourceQuality: { high: 30, low: 8, normal: 20 },
      threshold: 40,
      trend: {
        baseline: 'max-daily-independent-source-count',
        lookbackFrozenDailyIssues: 7,
        maxPoints: 6,
        pointsPerAdditionalSource: 2,
      },
    });
  } finally {
    db.close();
  }
});

test('shadow publish rereads its source and candidate snapshot under BEGIN IMMEDIATE', async () => {
  const db = fixtureDatabase();
  try {
    const snapshotReadStates = [];
    const observedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return sql => {
            if (/FROM (?:custom_sources|source_preferences|entries AS entry)/.test(sql)
              || /source_input_hash[\s\S]+FROM periodical_issues/.test(sql)
              || /status = 'frozen'[\s\S]+ORDER BY period_key DESC/.test(sql)) {
              snapshotReadStates.push(target.isTransaction);
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const periodicals = createPeriodicalsModule({ db: observedDb, mode: 'shadow', logger: () => {} });

    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    await periodicals.runNextBuild({ now: NOW });

    assert.equal(snapshotReadStates.length >= 6, true);
    assert.equal(snapshotReadStates.includes(false), true, 'compiler input should be built outside publish transaction');
    assert.equal(snapshotReadStates.slice(-3).every(Boolean), true, 'publish must reread SQLite under BEGIN IMMEDIATE');
  } finally {
    db.close();
  }
});

test('durable build publishes validated AI expression without changing selection facts or evidence', async () => {
  const db = fixtureDatabase();
  try {
    const insertSource = db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertSource.run(
      'summary-source',
      'Summary Source',
      'https://summary.example/feed.xml',
      'article',
      '["产品"]',
      NOW - 1000,
      NOW - 1000,
    );
    insertSource.run(
      'summary-source-2',
      'Second Summary Source',
      'https://second-summary.example/feed.xml',
      'article',
      '["产品"]',
      NOW - 1000,
      NOW - 1000,
    );
    const insertPreference = db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', ?, '2026-07-30T04:00:00.000Z')
    `);
    insertPreference.run('summary-source', 0);
    insertPreference.run('summary-source-2', 1);
    const insertEntry = db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEntry.run(
      'summary-entry',
      'summary-source',
      'Atlas releases alpha bravo charlie',
      'https://summary.example/posts/atlas-release',
      NOW,
      'Atlas releases alpha bravo charlie.',
      '<p>SQLite private body.</p>',
      'summary-content-hash',
      NOW,
      NOW,
    );
    insertEntry.run(
      'summary-entry-2',
      'summary-source-2',
      'Atlas releases alpha bravo charlie delta',
      'https://second-summary.example/posts/atlas-release',
      NOW,
      'Atlas releases alpha bravo charlie delta.',
      '<p>Second SQLite private body.</p>',
      'summary-content-hash-2',
      NOW,
      NOW,
    );

    let aiCalls = 0;
    const aiAdapter = async request => {
      aiCalls += 1;
      return {
        content: JSON.stringify({
          overview: '本期聚焦 1 项有明确证据的进展。所有表达均受证据约束。',
          events: request.evidencePackage.events.map(event => ({
            id: event.id,
            themeKey: 'products_tools',
            title: '稳定事件获得证据确认',
            summary: '现有证据说明该事件已经发生。',
            evidenceIds: event.evidence.map(item => item.id),
          })),
          themes: [{ themeKey: 'products_tools', trendNote: '本期产品主题关注稳定进展。' }],
        }),
        provider: 'site-provider',
        model: 'site-model',
      };
    };
    const periodicals = createPeriodicalsModule({ db, mode: 'shadow', aiAdapter });
    const queued = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    let fallback;
    const built = await periodicals.runNextBuild({
      now: NOW + 10,
      compileIssue(input) {
        fallback = compileOpenDaily(input);
        return fallback;
      },
    });
    const generated = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
    const duplicate = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'hourly-sweep',
    });

    assert.equal(queued.action, 'queued');
    assert.equal(built.status, 'succeeded');
    assert.equal(fallback.issue.summaryStatus, 'fallback');
    assert.equal(generated.issue.summaryStatus, 'generated');
    assert.equal(generated.issue.provider, 'site-provider');
    assert.equal(generated.issue.model, 'site-model');
    assert.equal(generated.issue.revision, fallback.issue.revision);
    assert.notEqual(generated.issue.contentHash, fallback.issue.contentHash);
    assert.equal(periodicals.getBuildJob(queued.job.id).provider, 'site-provider');
    assert.equal(periodicals.getBuildJob(queued.job.id).model, 'site-model');
    assert.equal(aiCalls, 1);
    assert.equal(duplicate.action, 'noop');
    assert.equal(await periodicals.runNextBuild({ now: NOW + (60 * 60 * 1000) }), null);
    assert.equal(aiCalls, 1);
    assert.equal(fallback.events.length, 1);
    assert.equal(fallback.evidence.length, 2);
    assert.equal(fallback.events[0].score.confirmation.independentSourceCount, 2);
    assert.equal(fallback.events[0].score.confirmation.points, 8);
    assert.deepEqual(
      fallback.events[0].cluster.entryIds,
      ['summary-entry', 'summary-entry-2'],
    );
    assert.deepEqual(
      generated.events.map(event => ({
        id: event.id,
        eventKey: event.eventKey,
        topicKey: event.topicKey,
        importanceScore: event.importanceScore,
        score: event.score,
        cluster: event.cluster,
        whySelected: event.whySelected,
        displayOrder: event.displayOrder,
      })),
      fallback.events.map(event => ({
        id: event.id,
        eventKey: event.eventKey,
        topicKey: event.topicKey,
        importanceScore: event.importanceScore,
        score: event.score,
        cluster: event.cluster,
        whySelected: event.whySelected,
        displayOrder: event.displayOrder,
      })),
    );
    assert.deepEqual(generated.evidence, fallback.evidence);
    assert.deepEqual(
      generated.evidence.map(item => item.entryLink).sort(),
      [
        'https://second-summary.example/posts/atlas-release',
        'https://summary.example/posts/atlas-release',
      ],
    );
  } finally {
    db.close();
  }
});
