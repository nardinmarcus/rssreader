const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.resolve(__dirname, '..');
const storePath = path.join(projectDir, 'lib', 'store.js');
const NOW = Date.parse('2026-07-30T04:00:00.000Z');

function runStore(dataDir, mode, script = '') {
  return execFileSync(process.execPath, ['-e', `
    Date.now = () => ${NOW};
    const store = require(${JSON.stringify(storePath)});
    ${script}
  `], {
    cwd: projectDir,
    env: {
      ...process.env,
      NAMOO_READER_DATA_DIR: dataDir,
      PERIODICALS_MODE: mode,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function seedSqlite(dataDir) {
  runStore(dataDir, 'off');
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  try {
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES ('sqlite-source', 'SQLite Source', 'https://sqlite.example/feed.xml',
        'article', '["产品"]', ?, ?)
    `).run(NOW - 1000, NOW - 1000);
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES ('sqlite-source', 1, 'high', 0, '2026-07-30T04:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('sqlite-entry', 'sqlite-source', 'SQLite truth',
        'https://sqlite.example/posts/truth', ?, 'SQLite summary.', '<p>SQLite body.</p>',
        'sqlite-content-hash', ?, ?)
    `).run(NOW, NOW, NOW);
  } finally {
    db.close();
  }
}

function compileWithCacheState(cacheState) {
  const dataDir = createTempDataDir(`namoo-reader-periodicals-cache-${cacheState}-`);
  try {
    seedSqlite(dataDir);
    const cachePath = path.join(dataDir, 'cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({
      'cache-only-source': {
        fetchedAt: NOW,
        entries: [{
          id: 'cache-only-entry',
          sourceId: 'cache-only-source',
          title: 'Cache must not compile',
          publishedTs: NOW,
        }],
      },
    }));
    if (cacheState === 'deleted') fs.rmSync(cachePath);

    const output = runStore(dataDir, 'shadow', `
      const issue = store.periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
      process.stdout.write(JSON.stringify(issue));
    `);
    return JSON.parse(output);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('shadow startup compiles identical SQLite truth with polluted or deleted runtime cache', () => {
  const polluted = compileWithCacheState('polluted');
  const deleted = compileWithCacheState('deleted');

  assert.deepEqual(polluted.events.map(event => event.eventKey), deleted.events.map(event => event.eventKey));
  assert.deepEqual(polluted.events.map(event => event.importanceScore), deleted.events.map(event => event.importanceScore));
  assert.equal(polluted.issue.contentHash, deleted.issue.contentHash);
  assert.deepEqual(polluted.evidence.map(item => item.entryId), ['sqlite-entry']);
  assert.deepEqual(deleted.evidence.map(item => item.sourceId), ['sqlite-source']);
  assert.equal(JSON.stringify(polluted).includes('cache-only'), false);
  assert.equal(JSON.stringify(deleted).includes('cache-only'), false);
});
