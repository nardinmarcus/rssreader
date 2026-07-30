const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPeriodicalsModule } = require('../lib/periodicals');

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

test('shadow sync persists a Custom Source event and timestamp fallback through the read module', () => {
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

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });
    const synced = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    const stored = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

    assert.equal(synced.issue.revision, 1);
    assert.equal(stored.issue.status, 'open');
    assert.equal(stored.issue.revision, 1);
    assert.equal(stored.events.length, 1);
    assert.equal(stored.events[0].importanceScore, 49.9);
    assert.equal(stored.evidence[0].sourceId, 'custom-daily');
    assert.equal(stored.evidence[0].editorialPriority, 'high');
    assert.equal(stored.evidence[0].effectivePublishedAt, NOW - (10 * 60 * 1000));
    assert.equal(stored.evidence[0].timestampFallback, true);
  } finally {
    db.close();
  }
});

test('wall-clock movement is a no-op while a SQLite preference change replaces the open revision', () => {
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

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });
    const first = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    const wallClockOnly = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'test',
    });

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
    const algorithmChanged = periodicals.syncOpenDaily({
      now: NOW + (2 * 60 * 60 * 1000),
      trigger: 'test',
    });

    assert.equal(algorithmChanged.issue.revision, 2);

    db.prepare(`
      UPDATE source_preferences
      SET editorial_priority = 'low', updated_at = '2026-07-30T05:00:00.000Z'
      WHERE source_id = 'custom-daily'
    `).run();
    const preferenceChanged = periodicals.syncOpenDaily({
      now: NOW + (3 * 60 * 60 * 1000),
      trigger: 'test',
    });

    assert.equal(preferenceChanged.issue.revision, 3);
    assert.equal(preferenceChanged.events.length, 0);
    assert.notEqual(preferenceChanged.issue.contentHash, first.issue.contentHash);
  } finally {
    db.close();
  }
});

test('rendered SQLite semantics change the source input identity and replace the open revision', () => {
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

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });
    const first = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });

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

    const replaced = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'test',
    });

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

test('reassigning an entry between equivalent SQLite sources replaces its evidence source identity', () => {
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

    const periodicals = createPeriodicalsModule({ db, mode: 'shadow' });
    const first = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });

    db.prepare(`
      UPDATE entries SET source_id = 'source-b'
      WHERE id = 'reassigned-entry'
    `).run();
    const replaced = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });

    assert.equal(first.issue.revision, 1);
    assert.equal(first.evidence[0].sourceId, 'source-a');
    assert.equal(replaced.issue.revision, 2);
    assert.equal(replaced.evidence[0].sourceId, 'source-b');
  } finally {
    db.close();
  }
});

test('shadow sync scores the current topic from the latest frozen daily SQLite evidence', () => {
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
    const previous = periodicals.syncOpenDaily({ now: yesterday, trigger: 'test' });
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

    const current = periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });
    const stored = periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });

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
    assert.equal(stored.events[0].eventKey, current.events[0].eventKey);
    assert.equal(stored.events[0].topicKey, current.events[0].topicKey);
    assert.equal(stored.events[0].cluster.version, 'event-cluster-v1');
    assert.equal(stored.events[0].cluster.reason, 'complete-link');
    assert.equal(stored.evidence.length, 2);
    assert.equal(stored.evidence.filter(item => item.isPrimary).length, 1);
    assert.match(stored.events[0].whySelected, /2 个独立来源确认/);
    assert.match(stored.events[0].whySelected, /过去 7 个冻结日报出现 1 天/);
    assert.match(stored.events[0].whySelected, /单日峰值增加 1 个/);
  } finally {
    db.close();
  }
});

test('shadow sync reads its source, candidate, and issue snapshot under BEGIN IMMEDIATE', () => {
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
    const periodicals = createPeriodicalsModule({ db: observedDb, mode: 'shadow' });

    periodicals.syncOpenDaily({ now: NOW, trigger: 'test' });

    assert.equal(snapshotReadStates.length >= 4, true);
    assert.equal(snapshotReadStates.every(Boolean), true);
  } finally {
    db.close();
  }
});
