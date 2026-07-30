const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { computePeriodicalContentHash } = require('../lib/periodical-summary');
const { createPeriodicalsModule } = require('../lib/periodicals');
const { seedEmptyFrozenDailyMonths } = require('./helpers/periodical-monthly-fixture');

const projectDir = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(dataDir, mode) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      NAMOO_READER_DATA_DIR: dataDir,
      PERIODICALS_MODE: mode,
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      TRANSLATION_WORKER_DISABLED: '1',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/sources`);
      if (response.ok) return { child, baseUrl };
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

test('periodical index is public only when PERIODICALS_MODE is on', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-api-');
  try {
    for (const [mode, expectedStatus] of [['off', 404], ['shadow', 404], ['on', 200]]) {
      let server = null;
      try {
        server = await startServer(dataDir, mode);
        const response = await fetch(`${server.baseUrl}/api/periodicals?cadence=daily`);
        const text = await response.text();
        assert.equal(response.status, expectedStatus, mode);
        if (mode === 'on') {
          const body = JSON.parse(text);
          assert.deepEqual(body.issues, []);
          assert.equal(body.nextCursor, null);
        } else assert.equal(text.includes(mode), false);
      } finally {
        await stopServer(server);
      }
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('periodical index validates parameters and reads a paged allowlist projection from SQLite', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-index-');
  let server = null;
  try {
    server = await startServer(dataDir, 'on');
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    seedEmptyFrozenDailyMonths(db, ['2026-06'], { startVolume: 100 });
    const periodicals = createPeriodicalsModule({ db, mode: 'on', logger: () => {} });
    const monthlyBuildAt = Date.parse('2026-07-01T00:05:00.000+08:00');
    periodicals.syncMonthlyRollup({ now: monthlyBuildAt, trigger: 'api-index-fixture' });
    assert.equal((await periodicals.runNextBuild({ now: monthlyBuildAt + 1 })).status, 'succeeded');
    const insertOpenIssue = db.prepare(`
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, period_start_at, period_end_at,
        status, overview, selection_version, summary_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `);
    const july28StartAt = Date.parse('2026-07-28T00:00:00.000+08:00');
    const july29StartAt = Date.parse('2026-07-29T00:00:00.000+08:00');
    const july30StartAt = Date.parse('2026-07-30T00:00:00.000+08:00');
    insertOpenIssue.run('periodical:daily:2026-07-28', 'daily', '2026-07-28', 1, july28StartAt, july29StartAt, 'Old overview', 'importance-v1', 'fallback-v1', 1, 1);
    insertOpenIssue.run('periodical:daily:2026-07-29', 'daily', '2026-07-29', 2, july29StartAt, july30StartAt, 'Middle overview', 'importance-v1', 'fallback-v1', 2, 2);
    insertOpenIssue.run('periodical:daily:2026-07-30', 'daily', '2026-07-30', 3, july30StartAt, Date.parse('2026-07-31T00:00:00.000+08:00'), 'Current overview', 'importance-v1', 'fallback-v1', 3, 3);
    insertOpenIssue.run('periodical:weekly:2026-W31', 'weekly', '2026-W31', 1, 100, 800, 'Weekly overview', 'importance-v1', 'fallback-v1', 4, 4);
    insertOpenIssue.run('periodical:weekly:2026-W32', 'weekly', '2026-W32', 2, 800, 1500, 'Hidden pending Weekly', 'importance-v1', 'fallback-v1', 5, 5);
    insertOpenIssue.run('periodical:monthly:2026-07', 'monthly', '2026-07', 2, 800, 1500, 'Hidden pending Monthly', 'monthly-rollup-v1', 'fallback-v1', 7, 7);
    db.exec(`
      UPDATE periodical_issues
      SET status = 'frozen', frozen_at = period_end_at
      WHERE period_key IN ('2026-07-28', '2026-07-29', '2026-W31')
    `);
    db.close();

    const firstResponse = await fetch(`${server.baseUrl}/api/periodicals?cadence=daily&limit=2`);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(first.issues.map(issue => issue.periodKey), ['2026-07-30', '2026-07-29']);
    assert.equal(first.nextCursor, '2026-07-29');
    assert.deepEqual(Object.keys(first.issues[0]).sort(), [
      'cadence',
      'contentHash',
      'coverageStartedAt',
      'eventCount',
      'lastBuiltAt',
      'lastSuccessfulAt',
      'periodEndAt',
      'periodKey',
      'periodStartAt',
      'revision',
      'status',
      'updateDelayed',
      'updateState',
      'volumeNo',
    ]);

    const nextResponse = await fetch(`${server.baseUrl}/api/periodicals?cadence=daily&limit=2&cursor=2026-07-29`);
    const next = await nextResponse.json();
    assert.equal(nextResponse.status, 200);
    assert.deepEqual(next.issues.map(issue => issue.periodKey), ['2026-07-28', '2026-06-30']);
    assert.equal(next.nextCursor, '2026-06-30');

    const weeklyResponse = await fetch(`${server.baseUrl}/api/periodicals?cadence=weekly`);
    const weekly = await weeklyResponse.json();
    assert.equal(weeklyResponse.status, 200);
    assert.deepEqual(weekly.issues.map(issue => issue.periodKey), ['2026-W31']);

    const monthlyResponse = await fetch(`${server.baseUrl}/api/periodicals?cadence=monthly`);
    const monthly = await monthlyResponse.json();
    assert.equal(monthlyResponse.status, 200);
    assert.deepEqual(monthly.issues.map(issue => issue.periodKey), ['2026-06']);

    for (const query of [
      '',
      '?cadence=yearly',
      '?cadence=daily&cursor=2026-7-30',
      '?cadence=weekly&cursor=2021-W53',
      '?cadence=monthly&cursor=2026-13',
      '?cadence=daily&limit=0',
      '?cadence=daily&limit=101',
      '?cadence=daily&limit=1.5',
      '?cadence=daily&limit=abc',
    ]) {
      const response = await fetch(`${server.baseUrl}/api/periodicals${query}`);
      assert.equal(response.status, 400, query || 'missing cadence');
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Monthly detail exposes a Frozen empty issue but hides an incomplete placeholder', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-monthly-detail-');
  let server = null;
  try {
    server = await startServer(dataDir, 'on');
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    seedEmptyFrozenDailyMonths(db, ['2026-06']);
    const periodicals = createPeriodicalsModule({ db, mode: 'on', logger: () => {} });
    const monthlyBuildAt = Date.parse('2026-07-01T00:05:00.000+08:00');
    assert.equal(periodicals.syncMonthlyRollup({
      now: monthlyBuildAt,
      trigger: 'api-detail-fixture',
    }).action, 'queued');
    assert.equal((await periodicals.runNextBuild({ now: monthlyBuildAt + 1 })).status, 'succeeded');
    const issue = periodicals.getIssue({ cadence: 'monthly', periodKey: '2026-06' }).issue;
    db.prepare(`
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, coverage_started_at,
        status, revision, overview, selection_version, summary_version,
        created_at, updated_at
      ) VALUES (
        'periodical:monthly:2026-07', 'monthly', '2026-07', 2, 'Asia/Shanghai',
        ?, ?, ?, 'finalizing', 0, '', 'monthly-rollup-v1',
        'constrained-summary-v1', ?, ?
      )
    `).run(
      Date.parse('2026-07-01T00:00:00.000+08:00'),
      Date.parse('2026-08-01T00:00:00.000+08:00'),
      Date.parse('2026-07-01T00:00:00.000+08:00'),
      monthlyBuildAt,
      monthlyBuildAt,
    );
    db.close();

    const response = await fetch(`${server.baseUrl}/api/periodicals/monthly/2026-06`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), `"${issue.contentHash}"`);
    assert.match(String(response.headers.get('cache-control')), /no-cache/);
    const body = await response.json();
    assert.equal(body.issue.cadence, 'monthly');
    assert.equal(body.issue.periodKey, '2026-06');
    assert.equal(body.issue.status, 'frozen');
    assert.equal(body.issue.contentHash, issue.contentHash);
    assert.deepEqual(body.themes, []);
    assert.deepEqual(body.events, []);
    assert.deepEqual(body.evidence, []);
    assert.equal(JSON.stringify(body).includes('private-monthly'), false);

    const hidden = await fetch(`${server.baseUrl}/api/periodicals/monthly/2026-07`);
    assert.equal(hidden.status, 404);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('periodical detail returns frozen SQLite evidence through an allowlist projection', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-detail-');
  let server = null;
  try {
    server = await startServer(dataDir, 'on');
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db.exec(`
      INSERT INTO entries (id, source_id, title, link, created_at, updated_at)
      VALUES ('entry-evidence', 'source-one', 'Original title', 'https://example.com/original', 10, 10);
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, period_start_at, period_end_at,
        coverage_started_at, status, revision, overview, selection_version, summary_version,
        source_input_hash, selection_context_json, input_hash, content_hash,
        summary_status, last_built_at, frozen_at, created_at, updated_at
      ) VALUES (
        'periodical:daily:2026-07-30', 'daily', '2026-07-30', 3, 300, 400,
        320, 'open', 2, '本期概览。第二句。', 'importance-v1', 'fallback-v1',
        'private-source-input', '{"threshold":40}', 'private-input', '',
        'fallback', 390, NULL, 300, 400
      );
      INSERT INTO periodical_themes (id, issue_id, theme_key, title, trend_note, display_order)
      VALUES ('theme-one', 'periodical:daily:2026-07-30', 'products_tools', '产品与工具', '本期收录 1 个事件。', 0);
      INSERT INTO periodical_events (
        id, issue_id, theme_id, event_key, topic_key, title, summary,
        summary_evidence_json, why_selected, effective_at, first_seen_at, last_seen_at,
        importance_score, score_json, cluster_json, display_order
      ) VALUES (
        'event-one', 'periodical:daily:2026-07-30', 'theme-one', 'event-key-one', 'topic-key-one',
        'Event title', 'Evidence summary.', '["entry-evidence"]', '来自高优先级来源。',
        350, 350, 350, 50.5,
        '{"version":"importance-v1","sourceQuality":{"points":30},"freshness":{"points":20.5}}',
        '{"version":"cluster-v1","entryIds":["entry-evidence"]}', 0
      );
      INSERT INTO periodical_event_evidence (
        event_id, entry_id, source_id, source_name, source_labels_json, editorial_priority,
        entry_title, entry_title_zh, entry_link, canonical_url, summary_excerpt, content_hash,
        effective_published_at, is_primary, display_order
      ) VALUES (
        'event-one', 'entry-evidence', 'source-one', 'Source One', '["AI","产品"]', 'high',
        'Original title', '中文标题', 'https://example.com/original', 'https://example.com/original',
        'Evidence excerpt.', 'entry-content-hash', 350, 1, 0
      );
    `);
    const contentHash = computePeriodicalContentHash({
      issue: {
        id: 'periodical:daily:2026-07-30',
        cadence: 'daily',
        periodKey: '2026-07-30',
        volumeNo: 3,
        timezone: 'Asia/Shanghai',
        periodStartAt: 300,
        periodEndAt: 400,
        coverageStartedAt: 320,
        status: 'frozen',
        revision: 2,
        overview: '本期概览。第二句。',
        selectionVersion: 'importance-v1',
        summaryVersion: 'fallback-v1',
        sourceInputHash: 'private-source-input',
        selectionContext: { threshold: 40 },
        inputHash: 'private-input',
        contentHash: '',
        summaryStatus: 'fallback',
        provider: null,
        model: null,
        lastBuiltAt: 390,
        frozenAt: 400,
      },
      themes: [{
        id: 'theme-one',
        themeKey: 'products_tools',
        title: '产品与工具',
        trendNote: '本期收录 1 个事件。',
        displayOrder: 0,
      }],
      events: [{
        id: 'event-one',
        themeId: 'theme-one',
        eventKey: 'event-key-one',
        topicKey: 'topic-key-one',
        title: 'Event title',
        summary: 'Evidence summary.',
        summaryEvidenceIds: ['entry-evidence'],
        whySelected: '来自高优先级来源。',
        effectiveAt: 350,
        firstSeenAt: 350,
        lastSeenAt: 350,
        importanceScore: 50.5,
        score: {
          version: 'importance-v1',
          sourceQuality: { points: 30 },
          freshness: { points: 20.5 },
        },
        cluster: { version: 'cluster-v1', entryIds: ['entry-evidence'] },
        displayOrder: 0,
      }],
      evidence: [{
        eventId: 'event-one',
        entryId: 'entry-evidence',
        sourceId: 'source-one',
        sourceName: 'Source One',
        sourceLabels: ['AI', '产品'],
        editorialPriority: 'high',
        entryTitle: 'Original title',
        entryTitleZh: '中文标题',
        entryLink: 'https://example.com/original',
        canonicalUrl: 'https://example.com/original',
        summaryExcerpt: 'Evidence excerpt.',
        contentHash: 'entry-content-hash',
        effectivePublishedAt: 350,
        timestampFallback: false,
        isPrimary: true,
        displayOrder: 0,
      }],
    });
    db.prepare(`
      UPDATE periodical_issues
      SET status = 'frozen', content_hash = ?, frozen_at = 400
      WHERE id = 'periodical:daily:2026-07-30'
    `).run(contentHash);
    db.close();

    const response = await fetch(`${server.baseUrl}/api/periodicals/daily/2026-07-30`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), `"${contentHash}"`);
    assert.match(String(response.headers.get('cache-control')), /no-cache/);
    const body = await response.json();
    assert.deepEqual(body.issue, {
      id: 'periodical:daily:2026-07-30',
      cadence: 'daily',
      periodKey: '2026-07-30',
      volumeNo: 3,
      timezone: 'Asia/Shanghai',
      periodStartAt: 300,
      periodEndAt: 400,
      coverageStartedAt: 320,
      status: 'frozen',
      revision: 2,
      overview: '本期概览。第二句。',
      selectionVersion: 'importance-v1',
      summaryVersion: 'fallback-v1',
      contentHash,
      summaryStatus: 'fallback',
      provider: null,
      model: null,
      lastSuccessfulAt: 390,
      updateDelayed: false,
      updateState: 'succeeded',
    });
    assert.deepEqual(body.themes, [{
      id: 'theme-one',
      themeKey: 'products_tools',
      title: '产品与工具',
      trendNote: '本期收录 1 个事件。',
      displayOrder: 0,
    }]);
    assert.equal(body.events[0].score.sourceQuality.points, 30);
    assert.deepEqual(body.events[0].summaryEvidenceIds, ['entry-evidence']);
    assert.deepEqual(body.evidence[0].sourceLabels, ['AI', '产品']);
    assert.equal(body.generatedAt, 390);
    assert.equal(body.frozenAt, 400);
    assert.equal(JSON.stringify(body).includes('private-source-input'), false);
    assert.equal(JSON.stringify(body).includes('private-input'), false);
    assert.equal(JSON.stringify(body).includes('threshold'), false);

    const notModified = await fetch(`${server.baseUrl}/api/periodicals/daily/2026-07-30`, {
      headers: { 'If-None-Match': `"${contentHash}"` },
    });
    assert.equal(notModified.status, 304);

    const corrupted = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    corrupted.exec(`
      DROP TRIGGER reject_frozen_periodical_event_update;
      UPDATE periodical_events
      SET summary = 'corrupted after the ETag was issued'
      WHERE id = 'event-one';
    `);
    corrupted.close();
    const rejected = await fetch(`${server.baseUrl}/api/periodicals/daily/2026-07-30`, {
      headers: { 'If-None-Match': `"${contentHash}"` },
    });
    assert.equal(rejected.status, 503);
    assert.notEqual(rejected.headers.get('etag'), `"${contentHash}"`);
    assert.match(String(rejected.headers.get('cache-control')), /no-store/);

    for (const [pathname, expectedStatus] of [
      ['/api/periodicals/daily/2026-07-31', 404],
      ['/api/periodicals/yearly/2026', 400],
      ['/api/periodicals/daily/2026-02-31', 400],
      ['/api/periodicals/weekly/2021-W53', 400],
    ]) {
      const invalid = await fetch(`${server.baseUrl}${pathname}`);
      assert.equal(invalid.status, expectedStatus, pathname);
    }
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('periodical reads return 503 when SQLite is no longer readable', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-unavailable-');
  let server = null;
  try {
    server = await startServer(dataDir, 'on');
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    db.exec(`
      INSERT INTO periodical_issues (
        id, cadence, period_key, volume_no, period_start_at, period_end_at,
        status, overview, selection_version, summary_version, created_at, updated_at
      ) VALUES (
        'periodical:daily:2026-07-30', 'daily', '2026-07-30', 1, 100, 200,
        'open', 'SQLite truth', 'importance-v1', 'fallback-v1', 100, 100
      );
    `);

    const primedIndex = await fetch(`${server.baseUrl}/api/periodicals?cadence=daily`);
    const primedDetail = await fetch(`${server.baseUrl}/api/periodicals/daily/2026-07-30`);
    assert.equal(primedIndex.status, 200);
    assert.equal(primedDetail.status, 200);

    db.exec('DROP TABLE periodical_issues');
    db.close();

    const unavailableIndex = await fetch(`${server.baseUrl}/api/periodicals?cadence=daily`);
    assert.equal(unavailableIndex.status, 503);
    assert.deepEqual(await unavailableIndex.json(), { error: 'periodical index unavailable' });

    const unavailableDetail = await fetch(`${server.baseUrl}/api/periodicals/daily/2026-07-30`);
    assert.equal(unavailableDetail.status, 503);
    assert.deepEqual(await unavailableDetail.json(), { error: 'periodical detail unavailable' });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('periodical shell routes are public only when PERIODICALS_MODE is on', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodicals-shell-');
  const paths = [
    '/periodicals',
    '/periodicals/daily/2026-07-30',
    '/periodicals/weekly/2026-W31',
    '/periodicals/monthly/2026-07',
  ];
  try {
    for (const [mode, expectedStatus] of [
      ['off', 404],
      ['shadow', 404],
      ['invalid', 404],
      ['on', 200],
    ]) {
      let server = null;
      try {
        server = await startServer(dataDir, mode);
        for (const pathname of paths) {
          const response = await fetch(`${server.baseUrl}${pathname}`);
          const body = await response.text();
          assert.equal(response.status, expectedStatus, `${mode} ${pathname}`);
          if (mode === 'on') {
            assert.match(response.headers.get('content-type') || '', /^text\/html/);
            assert.match(body, /<body data-periodicals-mode="on">/);
            assert.match(body, /id="app"/);
          } else {
            assert.equal(body.includes('data-periodicals-mode="on"'), false);
          }
        }
      } finally {
        await stopServer(server);
      }
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
