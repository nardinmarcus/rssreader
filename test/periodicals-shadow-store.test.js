const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { computePeriodicalContentHash } = require('../lib/periodical-summary');

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
      store.periodicals.syncOpenDaily({ now: Date.now(), trigger: 'test' });
      store.periodicals.runNextBuild({ now: Date.now() }).then(() => {
        const issue = store.periodicals.getIssue({ cadence: 'daily', periodKey: '2026-07-30' });
        process.stdout.write('RESULT:' + JSON.stringify(issue));
      });
    `);
    return JSON.parse(output.slice(output.lastIndexOf('RESULT:') + 'RESULT:'.length));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('shadow worker compiles identical SQLite truth with polluted or deleted runtime cache', () => {
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

function seedFrozenJune(dataDir) {
  runStore(dataDir, 'off');
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  try {
    for (let day = 1; day <= 30; day += 1) {
      const periodKey = `2026-06-${String(day).padStart(2, '0')}`;
      const periodStartAt = Date.parse(`${periodKey}T00:00:00.000+08:00`);
      const issue = {
        id: `periodical:daily:${periodKey}`,
        cadence: 'daily',
        periodKey,
        volumeNo: day,
        timezone: 'Asia/Shanghai',
        periodStartAt,
        periodEndAt: periodStartAt + (24 * 60 * 60 * 1000),
        coverageStartedAt: periodStartAt,
        status: 'frozen',
        revision: 1,
        overview: '本日为空日报。第二句。',
        selectionVersion: 'importance-v1',
        summaryVersion: 'constrained-summary-v1',
        sourceInputHash: `source:${periodKey}`,
        selectionContext: { fixture: true },
        inputHash: `input:${periodKey}`,
        contentHash: '',
        summaryStatus: 'fallback',
        provider: null,
        model: null,
        lastBuiltAt: periodStartAt + (24 * 60 * 60 * 1000),
        frozenAt: periodStartAt + (24 * 60 * 60 * 1000) + 1,
      };
      issue.contentHash = computePeriodicalContentHash({
        issue,
        themes: [],
        events: [],
        evidence: [],
      });
      db.prepare(`
        INSERT INTO periodical_issues (
          id, cadence, period_key, volume_no, timezone,
          period_start_at, period_end_at, coverage_started_at,
          status, revision, overview, selection_version, summary_version,
          source_input_hash, selection_context_json, input_hash, content_hash,
          summary_status, provider, model, last_built_at, frozen_at,
          created_at, updated_at
        ) VALUES (
          ?, 'daily', ?, ?, 'Asia/Shanghai', ?, ?, ?,
          'finalizing', 1, ?, ?, ?, ?, ?, ?, ?,
          'fallback', NULL, NULL, ?, ?, ?, ?
        )
      `).run(
        issue.id,
        issue.periodKey,
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
        issue.contentHash,
        issue.lastBuiltAt,
        issue.frozenAt,
        issue.periodStartAt,
        issue.frozenAt,
      );
      db.prepare(`
        UPDATE periodical_issues SET status = 'frozen' WHERE id = ?
      `).run(issue.id);
    }
  } finally {
    db.close();
  }
}

function compileMonthlyWithCacheState(cacheState) {
  const dataDir = createTempDataDir(`namoo-reader-monthly-cache-${cacheState}-`);
  try {
    seedFrozenJune(dataDir);
    const cachePath = path.join(dataDir, 'cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({
      'cache-only-source': {
        entries: [{
          id: 'cache-only-entry',
          title: 'Cache-only Monthly event must not exist',
          importanceScore: 100,
        }],
      },
    }));
    if (cacheState === 'deleted') fs.rmSync(cachePath);
    const output = runStore(dataDir, 'shadow', `
      store.periodicals.syncMonthlyRollup({ now: Date.now(), trigger: 'cache-test' });
      store.periodicals.runNextBuild({ now: Date.now() + 1 }).then(() => {
        const issue = store.periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-06' });
        process.stdout.write('RESULT:' + JSON.stringify(issue));
      });
    `);
    const issue = JSON.parse(output.slice(output.lastIndexOf('RESULT:') + 'RESULT:'.length));
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    try {
      const inputCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM periodical_issue_inputs
        WHERE issue_id = 'periodical:monthly:2026-06'
      `).get().count;
      return { issue, inputCount };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('Monthly rollup is identical with polluted or deleted runtime cache', () => {
  const polluted = compileMonthlyWithCacheState('polluted');
  const deleted = compileMonthlyWithCacheState('deleted');

  assert.equal(polluted.inputCount, 30);
  assert.equal(deleted.inputCount, 30);
  assert.deepEqual(polluted.issue, deleted.issue);
  assert.equal(polluted.issue.issue.status, 'frozen');
  assert.equal(polluted.issue.events.length, 0);
  assert.equal(JSON.stringify(polluted).includes('cache-only'), false);
});
