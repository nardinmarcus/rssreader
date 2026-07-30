const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPeriodicalsModule } = require('../lib/periodicals');

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

    db.prepare(`
      UPDATE source_preferences
      SET editorial_priority = 'low', updated_at = '2026-07-30T05:00:00.000Z'
      WHERE source_id = 'custom-daily'
    `).run();
    const preferenceChanged = periodicals.syncOpenDaily({
      now: NOW + (60 * 60 * 1000),
      trigger: 'test',
    });

    assert.equal(preferenceChanged.issue.revision, 2);
    assert.equal(preferenceChanged.events.length, 0);
    assert.notEqual(preferenceChanged.issue.contentHash, first.issue.contentHash);
  } finally {
    db.close();
  }
});
