const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { seedEmptyFrozenDailyMonths } = require('./helpers/periodical-monthly-fixture');

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(__dirname, '..');
const workerPath = path.join(projectDir, 'scripts', 'periodical-worker.js');

test('periodical worker recovers an expired SQLite lease after process restart', async () => {
  const dataDir = createTempDataDir('namoo-reader-periodical-worker-');
  const now = Date.now();
  const databaseFile = path.join(dataDir, 'qmreader.sqlite');
  try {
    await execFileAsync(process.execPath, ['-e', `
      const store = require('./lib/store');
      store.createCustomSource({
        id: 'worker-source',
        name: 'Worker Source',
        feedUrl: 'https://worker.example/feed.xml',
        category: 'article',
        labels: ['产品'],
      });
    `], {
      cwd: projectDir,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        PERIODICALS_MODE: 'shadow',
      },
    });

    const db = new DatabaseSync(databaseFile);
    const source = db.prepare(`
      SELECT id FROM custom_sources WHERE feed_url = 'https://worker.example/feed.xml'
    `).get();
    db.prepare(`
      INSERT OR REPLACE INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES (?, 1, 'high', 0, ?)
    `).run(source.id, new Date(now).toISOString());
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'worker-entry',
      source.id,
      'Restart recovery',
      'https://worker.example/posts/recovery',
      now - 1000,
      'Recovered from durable SQLite work.',
      '<p>Recovered from durable SQLite work.</p>',
      'worker-content-v1',
      now - 1000,
      now - 1000,
    );
    db.close();

    await execFileAsync(process.execPath, ['-e', `
      const store = require('./lib/store');
      const requested = store.periodicals.syncOpenDaily({ now: ${now}, trigger: 'startup-test' });
      const claimed = store.periodicals.claimNextBuild(${now}, 10);
      if (!requested.job || !claimed) process.exit(2);
    `], {
      cwd: projectDir,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        PERIODICALS_MODE: 'shadow',
      },
    });

    const expired = new DatabaseSync(databaseFile);
    expired.prepare(`
      UPDATE periodical_build_jobs SET lease_expires_at = 0 WHERE status = 'running'
    `).run();
    expired.close();

    const worker = await execFileAsync(process.execPath, [workerPath, '--once'], {
      cwd: projectDir,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        PERIODICALS_MODE: 'shadow',
      },
    });
    assert.match(worker.stdout, /^\[periodical-build\].* state=succeeded durationMs=\d+$/m);

    const verified = new DatabaseSync(databaseFile);
    const job = verified.prepare(`
      SELECT status, attempt_count, lease_token, lease_expires_at
      FROM periodical_build_jobs
    `).get();
    const issue = verified.prepare(`
      SELECT revision, last_built_at FROM periodical_issues
      WHERE cadence = 'daily' ORDER BY period_key DESC LIMIT 1
    `).get();
    assert.deepEqual({ ...job }, {
      status: 'succeeded',
      attempt_count: 2,
      lease_token: null,
      lease_expires_at: null,
    });
    assert.equal(issue.revision, 1);
    assert.equal(Number.isFinite(issue.last_built_at), true);
    verified.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('periodical worker derives retry sleep from SQLite next wake time', () => {
  const source = fs.readFileSync(workerPath, 'utf8');
  assert.match(source, /getNextBuildWakeAt\(\)/);
  assert.match(source, /Math\.min\(1000,/);
});

test('server forwards only allowlisted periodical worker log lines', () => {
  const serverSource = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  const workerSource = serverSource.slice(
    serverSource.indexOf('function wakePeriodicalWorker()'),
    serverSource.indexOf('function wakePeriodicalWorkerIfNeeded()'),
  );
  assert.match(serverSource, /PERIODICAL_WORKER_SAFE_LOG/);
  assert.doesNotMatch(workerSource, /worker\.stderr\.on\('data'/);
  assert.match(workerSource, /PERIODICAL_WORKER_SAFE_LOG\.test\(line\)/);
});

test('server finalizes the previous Daily, schedules Weekly and Monthly, then syncs today', () => {
  const serverSource = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
  const checkSource = serverSource.slice(
    serverSource.indexOf('function checkPeriodicalBuilds('),
    serverSource.indexOf('function scheduleNextPeriodicalFinalization('),
  );
  const finalizedAt = checkSource.indexOf('finalizeDueIssues');
  const weeklyAt = checkSource.indexOf('syncWeeklyRollup');
  const monthlyAt = checkSource.indexOf('syncMonthlyRollup');
  const dailyAt = checkSource.indexOf('syncOpenDaily');
  assert.ok(
    finalizedAt >= 0 && weeklyAt >= 0 && monthlyAt >= 0 && dailyAt >= 0
      && finalizedAt < weeklyAt && weeklyAt < monthlyAt && monthlyAt < dailyAt,
    'the previous Daily must finalize before rollup scheduling and today synchronization',
  );
  assert.match(checkSource, /scheduleNextPeriodicalFinalization\(\)/);
  assert.match(serverSource, /getNextFinalizationWakeAt\(\)/);
  assert.match(serverSource, /checkPeriodicalBuilds\('daily-boundary'\)/);
});

async function waitForRevision(databaseFile, expected, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const db = new DatabaseSync(databaseFile);
      const row = db.prepare(`
        SELECT revision FROM periodical_issues
        WHERE cadence = 'daily' ORDER BY period_key DESC LIMIT 1
      `).get();
      db.close();
      if (row && Number(row.revision) >= expected) return Number(row.revision);
    } catch { /* schema or row may not exist yet */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return 0;
}

test('server startup check and hourly sweep wake durable periodical work', {
  timeout: 8000,
}, async () => {
  const dataDir = createTempDataDir('namoo-reader-periodical-lifecycle-');
  const databaseFile = path.join(dataDir, 'qmreader.sqlite');
  const now = Date.now();
  let child;
  try {
    await execFileAsync(process.execPath, ['-e', "require('./lib/store')"], {
      cwd: projectDir,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        PERIODICALS_MODE: 'off',
      },
    });
    const db = new DatabaseSync(databaseFile);
    db.prepare(`
      INSERT INTO custom_sources (
        id, name, feed_url, category, labels_json, created_at, updated_at
      ) VALUES ('lifecycle-source', 'Lifecycle Source', 'https://lifecycle.example/feed.xml',
        'article', '["产品"]', ?, ?)
    `).run(now - 1000, now - 1000);
    db.prepare(`
      INSERT INTO source_preferences (
        source_id, enabled, editorial_priority, display_order, updated_at
      ) VALUES ('lifecycle-source', 1, 'high', 0, ?)
    `).run(new Date(now).toISOString());
    db.prepare(`
      INSERT INTO entries (
        id, source_id, title, link, published_ts, summary, content,
        content_hash, created_at, updated_at
      ) VALUES ('lifecycle-entry', 'lifecycle-source', 'Lifecycle input',
        'https://lifecycle.example/posts/one', ?, 'Initial input.', '<p>Initial input.</p>',
        'lifecycle-content-v1', ?, ?)
    `).run(now - 1000, now - 1000, now - 1000);
    db.close();

    child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
      cwd: projectDir,
      detached: true,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '0',
        PERIODICALS_MODE: 'shadow',
        PERIODICAL_WORKER_STARTUP: '1',
        PERIODICAL_SWEEP_INTERVAL_MS: '100',
        STARTUP_REFRESH_DELAY_MS: '-1',
        FRESHNESS_SWEEP_INTERVAL_MS: '-1',
        TRANSLATION_WORKER_STARTUP: '0',
      },
      stdio: 'ignore',
    });

    assert.equal(await waitForRevision(databaseFile, 1), 1, 'startup check did not publish revision 1');
    const changedAt = Date.now();
    const changed = new DatabaseSync(databaseFile);
    changed.exec('PRAGMA busy_timeout = 5000;');
    changed.prepare(`
      UPDATE entries
      SET summary = 'Hourly input.', content_hash = 'lifecycle-content-v2', updated_at = ?
      WHERE id = 'lifecycle-entry'
    `).run(changedAt);
    changed.close();

    assert.equal(await waitForRevision(databaseFile, 2), 2, 'hourly sweep did not publish revision 2');
    const verified = new DatabaseSync(databaseFile);
    assert.equal(verified.prepare(`
      SELECT COUNT(*) AS count FROM periodical_build_jobs WHERE status = 'succeeded'
    `).get().count, 2);
    verified.close();
  } finally {
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process already exited */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function waitForMonthlyStartupDrain(databaseFile, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    try {
      const db = new DatabaseSync(databaseFile);
      state = {
        issues: db.prepare(`
          SELECT period_key, volume_no, status
          FROM periodical_issues
          WHERE cadence = 'monthly'
          ORDER BY period_key
        `).all().map(row => ({ ...row })),
        jobs: db.prepare(`
          SELECT issue.period_key, job.status, job.trigger_reason
          FROM periodical_build_jobs AS job
          INNER JOIN periodical_issues AS issue ON issue.id = job.issue_id
          WHERE issue.cadence = 'monthly'
          ORDER BY issue.period_key
        `).all().map(row => ({ ...row })),
        active: db.prepare(`
          SELECT COUNT(*) AS count
          FROM periodical_build_jobs
          WHERE status IN ('queued', 'running', 'retry_wait')
        `).get().count,
      };
      db.close();
      if (state.issues.length === 3
        && state.issues.every(issue => issue.status === 'frozen')
        && state.active === 0) return state;
    } catch { /* schema or startup transaction may not be ready */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return state;
}

test('one real server startup sync plus worker drain catches up every due Monthly', {
  timeout: 10000,
}, async () => {
  const dataDir = createTempDataDir('namoo-reader-monthly-startup-catch-up-');
  const databaseFile = path.join(dataDir, 'qmreader.sqlite');
  const startupAt = Date.parse('2026-06-01T00:05:00.000+08:00');
  let child;
  try {
    await execFileAsync(process.execPath, ['-e', "require('./lib/store')"], {
      cwd: projectDir,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        PERIODICALS_MODE: 'off',
      },
    });
    const db = new DatabaseSync(databaseFile);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    seedEmptyFrozenDailyMonths(db, ['2026-03', '2026-04', '2026-05']);
    db.close();

    child = spawn(process.execPath, ['-e', `
      Date.now = () => ${startupAt};
      require('./server');
    `], {
      cwd: projectDir,
      detached: true,
      env: {
        ...process.env,
        NAMOO_READER_DATA_DIR: dataDir,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '0',
        PERIODICALS_MODE: 'shadow',
        PERIODICAL_WORKER_STARTUP: '1',
        PERIODICAL_SWEEP_INTERVAL_MS: '-1',
        STARTUP_REFRESH_DELAY_MS: '-1',
        FRESHNESS_SWEEP_INTERVAL_MS: '-1',
        TRANSLATION_WORKER_STARTUP: '0',
      },
      stdio: 'ignore',
    });

    const state = await waitForMonthlyStartupDrain(databaseFile);
    assert.deepEqual(state, {
      issues: [
        { period_key: '2026-03', volume_no: 1, status: 'frozen' },
        { period_key: '2026-04', volume_no: 2, status: 'frozen' },
        { period_key: '2026-05', volume_no: 3, status: 'frozen' },
      ],
      jobs: [
        { period_key: '2026-03', status: 'succeeded', trigger_reason: 'startup' },
        { period_key: '2026-04', status: 'succeeded', trigger_reason: 'startup' },
        { period_key: '2026-05', status: 'succeeded', trigger_reason: 'startup' },
      ],
      active: 0,
    });
  } finally {
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process already exited */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
