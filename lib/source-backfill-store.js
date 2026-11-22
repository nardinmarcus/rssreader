const crypto = require('crypto');

const BACKFILL_PARSER_VERSION = 'rss-backfill-v1';
const BACKFILL_MAX_BATCH_SIZE = 50;
const BACKFILL_MAX_AUTO_RETRIES = 3;
const BACKFILL_MAX_ARCHIVE_PAGES = 50;
const BACKFILL_DEFAULT_LEASE_MS = 60_000;

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'retry_wait']);
const COVERAGE_STATUSES = new Set(['unknown', 'available_window', 'provider_archive_exhausted', 'mismatch']);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function computeInputIdentity({ sourceId, snapshotHash = '', parserVersion = BACKFILL_PARSER_VERSION, feedUrlHash = '' } = {}) {
  return sha256Hex(`${String(sourceId || '').trim()}\n${String(snapshotHash || '').trim()}\n${String(parserVersion || '').trim()}\n${String(feedUrlHash || '').trim()}`);
}

function normalizeStateRow(row) {
  if (!row) return null;
  return {
    sourceId: String(row.source_id || ''),
    activeRunId: row.active_run_id ? String(row.active_run_id) : null,
    generation: Number(row.generation) || 1,
    coverageStatus: COVERAGE_STATUSES.has(row.coverage_status) ? row.coverage_status : 'unknown',
    coverageNote: String(row.coverage_note || ''),
    earliestPublishedAt: Number(row.earliest_published_at) || null,
    latestPublishedAt: Number(row.latest_published_at) || null,
    knownEntryCount: Number(row.known_entry_count) || 0,
    backfilledEntryCount: Number(row.backfilled_entry_count) || 0,
    reusedEntryCount: Number(row.reused_entry_count) || 0,
    lastErrorCode: String(row.last_error_code || ''),
    lastErrorMessage: String(row.last_error_message || ''),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function normalizeRunRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    sourceId: String(row.source_id || ''),
    generation: Number(row.generation) || 1,
    triggerReason: String(row.trigger_reason || ''),
    feedUrl: String(row.feed_url || ''),
    feedUrlHash: String(row.feed_url_hash || ''),
    snapshotHash: String(row.snapshot_hash || ''),
    snapshotBytes: Number(row.snapshot_bytes) || 0,
    parserVersion: String(row.parser_version || BACKFILL_PARSER_VERSION),
    inputIdentity: String(row.input_identity || ''),
    status: String(row.status || 'queued'),
    runToken: row.run_token ? String(row.run_token) : null,
    workerPid: Number(row.worker_pid) || null,
    leaseExpiresAt: Number(row.lease_expires_at) || null,
    attemptCount: Number(row.attempt_count) || 0,
    retryCount: Number(row.retry_count) || 0,
    nextRetryAt: Number(row.next_retry_at) || null,
    totalCount: Number(row.total_count) || 0,
    processedCount: Number(row.processed_count) || 0,
    insertedCount: Number(row.inserted_count) || 0,
    reusedCount: Number(row.reused_count) || 0,
    failedItemCount: Number(row.failed_item_count) || 0,
    cursor: safeJsonParse(row.cursor_json, {}),
    nextArchiveUrl: String(row.next_archive_url || ''),
    archiveComplete: Boolean(row.archive_complete),
    visitedUrls: safeJsonParse(row.visited_urls_json, []),
    archiveDepth: Number(row.archive_depth) || 0,
    cutoffAt: Number(row.cutoff_at) || 0,
    errorCode: String(row.error_code || ''),
    errorMessage: String(row.error_message || ''),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    completedAt: Number(row.completed_at) || null,
  };
}

function backfillError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Creates the SQLite transactional store for durable source backfill runs, checkpoints, and run-token fencing.
 */
function createSourceBackfillStore({
  db,
  now = Date.now,
  upsertEntryRows,
  getSourceIngestionBySourceId,
  wechatIdentityFromLink,
  insertArticleDocument,
} = {}) {
  if (!db) throw new Error('db is required');

  function ensureStateRow(sourceId, at = now()) {
    const cleanId = String(sourceId || '').trim();
    if (!cleanId) throw backfillError('invalid-source-id', 'sourceId is required', 400);
    db.prepare(`
      INSERT INTO source_backfill_states (source_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(source_id) DO NOTHING
    `).run(cleanId, at);
    return normalizeStateRow(db.prepare('SELECT * FROM source_backfill_states WHERE source_id = ?').get(cleanId));
  }

  function getState(sourceId) {
    const cleanId = String(sourceId || '').trim();
    if (!cleanId) return null;
    return normalizeStateRow(db.prepare('SELECT * FROM source_backfill_states WHERE source_id = ?').get(cleanId));
  }

  function getRun(runId) {
    const cleanId = String(runId || '').trim();
    if (!cleanId) return null;
    return normalizeRunRow(db.prepare('SELECT * FROM source_backfill_runs WHERE id = ?').get(cleanId));
  }

  function getLatestRunForSource(sourceId) {
    const cleanId = String(sourceId || '').trim();
    if (!cleanId) return null;
    const state = getState(cleanId);
    if (state && state.activeRunId) {
      const active = getRun(state.activeRunId);
      if (active) return active;
    }
    return normalizeRunRow(db.prepare(`
      SELECT * FROM source_backfill_runs
      WHERE source_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(cleanId));
  }

  function getSourceEntryStats(sourceId) {
    const row = db.prepare(`
      SELECT COUNT(*) AS entry_count,
             MIN(CASE WHEN COALESCE(published_ts, 0) > 0 THEN published_ts ELSE NULL END) AS earliest_published_at,
             MAX(CASE WHEN COALESCE(published_ts, 0) > 0 THEN published_ts ELSE NULL END) AS latest_published_at
      FROM entries
      WHERE source_id = ? AND COALESCE(deleted_at, 0) = 0
    `).get(sourceId);
    return {
      entryCount: Number(row && row.entry_count) || 0,
      earliestPublishedAt: Number(row && row.earliest_published_at) || null,
      latestPublishedAt: Number(row && row.latest_published_at) || null,
    };
  }

  function getAllSourceEntryStats() {
    const rows = db.prepare(`
      SELECT source_id,
             COUNT(*) AS entry_count,
             MIN(CASE WHEN COALESCE(published_ts, 0) > 0 THEN published_ts ELSE NULL END) AS earliest_published_at,
             MAX(CASE WHEN COALESCE(published_ts, 0) > 0 THEN published_ts ELSE NULL END) AS latest_published_at
      FROM entries
      WHERE COALESCE(deleted_at, 0) = 0
      GROUP BY source_id
    `).all();
    return Object.fromEntries(rows.map(row => [row.source_id, {
      entryCount: Number(row.entry_count) || 0,
      earliestPublishedAt: Number(row.earliest_published_at) || null,
      latestPublishedAt: Number(row.latest_published_at) || null,
    }]));
  }

  function listAllStates() {
    return db.prepare('SELECT * FROM source_backfill_states').all().map(normalizeStateRow);
  }

  function listActiveOrLatestRunsBySource() {
    const rows = db.prepare(`
      SELECT r.*
      FROM source_backfill_runs r
      JOIN (
        SELECT source_id, MAX(rowid) AS max_rowid
        FROM source_backfill_runs
        GROUP BY source_id
      ) latest ON latest.source_id = r.source_id AND latest.max_rowid = r.rowid
    `).all();
    return Object.fromEntries(rows.map(row => {
      const normalized = normalizeRunRow(row);
      return [normalized.sourceId, normalized];
    }));
  }

  function isSourceActiveInDb(sourceId) {
    const custom = db.prepare('SELECT archived_at FROM custom_sources WHERE id = ?').get(sourceId);
    if (custom && Number(custom.archived_at)) return false;
    const pref = db.prepare('SELECT enabled FROM source_preferences WHERE source_id = ?').get(sourceId);
    if (pref && Number(pref.enabled) === 0) return false;
    return true;
  }

  function hasAnyUnimportedCandidate(sourceId, candidates = []) {
    if (!Array.isArray(candidates) || !candidates.length) return false;
    const findByIdStmt = db.prepare('SELECT 1 FROM entries WHERE id = ?');
    const findByIdentityStmt = db.prepare('SELECT 1 FROM entries WHERE source_id = ? AND platform_identity = ?');
    const existingRows = db.prepare('SELECT id, link, platform_identity FROM entries WHERE source_id = ?').all(sourceId);
    const existingIds = new Set(existingRows.map(row => row.id));
    const existingIdentities = new Set();
    for (const row of existingRows) {
      if (row.platform_identity) existingIdentities.add(row.platform_identity);
      else if (wechatIdentityFromLink) {
        const legacyIdentity = wechatIdentityFromLink(row.link);
        if (legacyIdentity) existingIdentities.add(legacyIdentity);
      }
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      const identity = String(candidate.platformIdentity || '').trim();
      if (identity) {
        if (!existingIdentities.has(identity) && !findByIdentityStmt.get(sourceId, identity)) return true;
        continue;
      }
      if (candidate.id && !existingIds.has(candidate.id) && !findByIdStmt.get(candidate.id)) return true;
    }
    return false;
  }

  function hasCompletedOrActiveRunForFeedUrl(sourceId, feedUrl) {
    const cleanUrl = String(feedUrl || '').trim();
    if (!cleanUrl) return false;
    const urlHash = sha256Hex(cleanUrl);
    return Boolean(db.prepare(`
      SELECT 1 FROM source_backfill_runs
      WHERE source_id = ?
        AND feed_url_hash = ?
        AND status IN ('queued', 'running', 'retry_wait', 'paused', 'succeeded', 'failed')
      LIMIT 1
    `).get(sourceId, urlHash));
  }

  function hasRunForInputIdentity(sourceId, inputIdentity) {
    return Boolean(db.prepare(`
      SELECT 1 FROM source_backfill_runs
      WHERE source_id = ?
        AND input_identity = ?
        AND status IN ('queued', 'running', 'retry_wait', 'paused', 'succeeded')
      LIMIT 1
    `).get(sourceId, inputIdentity));
  }

  function invalidateActiveRunsInTx(sourceId, { supersede = false, at = now() } = {}) {
    const state = ensureStateRow(sourceId, at);
    const nextGeneration = state.generation + 1;
    db.prepare(`
      UPDATE source_backfill_states
      SET generation = ?, updated_at = ?
      WHERE source_id = ?
    `).run(nextGeneration, at, sourceId);

    const nextStatus = supersede ? 'superseded' : 'paused';
    db.prepare(`
      UPDATE source_backfill_runs
      SET status = ?,
          run_token = NULL,
          worker_pid = NULL,
          lease_expires_at = NULL,
          next_retry_at = NULL,
          updated_at = ?
      WHERE source_id = ?
        AND status IN ('queued', 'running', 'retry_wait')
    `).run(nextStatus, at, sourceId);
    if (supersede) {
      db.prepare(`
        UPDATE source_backfill_runs
        SET status = 'superseded',
            run_token = NULL,
            worker_pid = NULL,
            lease_expires_at = NULL,
            next_retry_at = NULL,
            updated_at = ?
        WHERE source_id = ?
          AND status = 'paused'
      `).run(at, sourceId);
    }
    return nextGeneration;
  }

  function invalidateActiveRuns(sourceId, { supersede = false, inTransaction = false, at = now() } = {}) {
    const cleanId = String(sourceId || '').trim();
    if (!cleanId) return null;
    if (inTransaction) return invalidateActiveRunsInTx(cleanId, { supersede, at });
    db.exec('BEGIN IMMEDIATE');
    try {
      const generation = invalidateActiveRunsInTx(cleanId, { supersede, at });
      db.exec('COMMIT');
      return generation;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function enqueueRun({
    sourceId,
    triggerReason = 'refresh',
    feedUrl = '',
    snapshotHash = '',
    snapshotBytes = 0,
    parserVersion = BACKFILL_PARSER_VERSION,
    totalCount = 0,
    nextArchiveUrl = '',
    archiveComplete = false,
    visitedUrls = [],
    archiveDepth = 0,
    cutoffAt = now(),
    forceNew = false,
    respectPaused = true,
    inTransaction = false,
    at = now(),
  } = {}) {
    const cleanSourceId = String(sourceId || '').trim();
    if (!cleanSourceId) throw backfillError('invalid-source-id', 'sourceId is required', 400);
    const cleanFeedUrl = String(feedUrl || '').trim();
    const cleanSnapshotHash = String(snapshotHash || '').trim().toLowerCase();
    const feedUrlHash = cleanFeedUrl ? sha256Hex(cleanFeedUrl) : '';
    const inputIdentity = computeInputIdentity({
      sourceId: cleanSourceId,
      snapshotHash: cleanSnapshotHash,
      parserVersion,
      feedUrlHash,
    });

    const runTx = () => {
      if (!isSourceActiveInDb(cleanSourceId)) {
        return { enqueued: false, reason: 'source-inactive', run: null };
      }
      const state = ensureStateRow(cleanSourceId, at);
      const latest = state.activeRunId ? getRun(state.activeRunId) : null;
      if (!forceNew && respectPaused && latest && latest.status === 'paused') {
        return { enqueued: false, reason: 'source-paused', run: latest };
      }
      if (!forceNew && latest && ['queued', 'running', 'retry_wait'].includes(latest.status)
          && latest.inputIdentity === inputIdentity) {
        return { enqueued: false, reason: 'already-active', run: latest };
      }
      if (!forceNew && hasRunForInputIdentity(cleanSourceId, inputIdentity)) {
        return { enqueued: false, reason: 'duplicate-input', run: latest };
      }

      const nextGeneration = state.generation + 1;
      db.prepare(`
        UPDATE source_backfill_runs
        SET status = 'superseded',
            run_token = NULL,
            worker_pid = NULL,
            lease_expires_at = NULL,
            next_retry_at = NULL,
            updated_at = ?
        WHERE source_id = ?
          AND status IN ('queued', 'running', 'retry_wait', 'paused')
      `).run(at, cleanSourceId);

      const runId = `backfill-run-${crypto.randomUUID()}`;
      const cursor = {
        v: 1,
        inputIdentity,
        snapshotHash: cleanSnapshotHash,
        parserVersion,
        offset: 0,
      };
      const visitedList = [...new Set([
        ...(Array.isArray(visitedUrls) ? visitedUrls : []),
        ...(cleanFeedUrl ? [cleanFeedUrl] : []),
      ].filter(Boolean))];

      db.prepare(`
        INSERT INTO source_backfill_runs (
          id, source_id, generation, trigger_reason, feed_url, feed_url_hash,
          snapshot_hash, snapshot_bytes, parser_version, input_identity,
          status, total_count, processed_count, inserted_count, reused_count, failed_item_count,
          cursor_json, next_archive_url, archive_complete, visited_urls_json, archive_depth,
          cutoff_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        cleanSourceId,
        nextGeneration,
        String(triggerReason || 'refresh'),
        cleanFeedUrl,
        feedUrlHash,
        cleanSnapshotHash,
        Math.max(0, Number(snapshotBytes) || 0),
        String(parserVersion || BACKFILL_PARSER_VERSION),
        inputIdentity,
        Math.max(0, Number(totalCount) || 0),
        JSON.stringify(cursor),
        String(nextArchiveUrl || '').trim(),
        archiveComplete ? 1 : 0,
        JSON.stringify(visitedList),
        Math.max(0, Number(archiveDepth) || 0),
        Number(cutoffAt) || at,
        at,
        at,
      );

      const stats = getSourceEntryStats(cleanSourceId);
      const nextCoverageStatus = state.coverageStatus === 'mismatch' ? 'unknown' : state.coverageStatus;
      db.prepare(`
        UPDATE source_backfill_states
        SET active_run_id = ?,
            generation = ?,
            coverage_status = ?,
            earliest_published_at = COALESCE(?, earliest_published_at),
            latest_published_at = COALESCE(?, latest_published_at),
            known_entry_count = ?,
            last_error_code = '',
            last_error_message = '',
            updated_at = ?
        WHERE source_id = ?
      `).run(
        runId,
        nextGeneration,
        nextCoverageStatus,
        stats.earliestPublishedAt,
        stats.latestPublishedAt,
        stats.entryCount,
        at,
        cleanSourceId,
      );

      return { enqueued: true, reason: 'queued', run: getRun(runId) };
    };

    if (inTransaction) return runTx();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = runTx();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function hasActiveRuns() {
    const row = db.prepare(`
      SELECT 1 FROM source_backfill_runs
      WHERE status IN ('queued', 'running', 'retry_wait')
      LIMIT 1
    `).get();
    return Boolean(row);
  }

  function getNextWakeAt(at = now(), workerPid = process.pid) {
    const runnable = db.prepare(`
      SELECT id FROM source_backfill_runs
      WHERE status = 'queued'
         OR (status = 'running' AND (COALESCE(lease_expires_at, 0) <= ? OR worker_pid = ?))
      LIMIT 1
    `).get(at, workerPid);
    if (runnable) return 0;
    const retry = db.prepare(`
      SELECT MIN(next_retry_at) AS next_at
      FROM source_backfill_runs
      WHERE status = 'retry_wait'
    `).get();
    const foreignLease = db.prepare(`
      SELECT MIN(lease_expires_at) AS next_at
      FROM source_backfill_runs
      WHERE status = 'running' AND COALESCE(lease_expires_at, 0) > ?
    `).get(at);
    const candidates = [retry && retry.next_at, foreignLease && foreignLease.next_at]
      .filter(value => value != null)
      .map(Number);
    return candidates.length ? Math.min(...candidates) : null;
  }

  function claimNextRun({ at = now(), leaseMs = BACKFILL_DEFAULT_LEASE_MS, workerPid = process.pid } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = db.prepare(`
        SELECT r.*, s.generation AS state_generation
        FROM source_backfill_runs r
        JOIN source_backfill_states s ON s.source_id = r.source_id
        WHERE r.status = 'queued'
           OR (r.status = 'retry_wait' AND COALESCE(r.next_retry_at, 0) <= ?)
           OR r.status = 'running'
        ORDER BY
          CASE WHEN r.status = 'running' AND r.worker_pid = ? THEN 0
               WHEN r.status = 'running' THEN 1
               WHEN r.status = 'queued' THEN 2
               ELSE 3 END,
          r.created_at ASC, r.rowid ASC
      `).all(at, workerPid);

      for (const candidate of candidates) {
        if (!isSourceActiveInDb(candidate.source_id)) {
          invalidateActiveRunsInTx(candidate.source_id, { supersede: false, at });
          continue;
        }
        if (Number(candidate.generation) !== Number(candidate.state_generation)) {
          db.prepare(`
            UPDATE source_backfill_runs
            SET status = 'superseded', run_token = NULL, worker_pid = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ?
          `).run(at, candidate.id);
          continue;
        }
        if (candidate.status === 'running') {
          const sameWorker = Number(candidate.worker_pid) === Number(workerPid) && candidate.run_token;
          const expired = Number(candidate.lease_expires_at || 0) <= at;
          const deadWorker = !sameWorker && candidate.worker_pid && !isPidAlive(candidate.worker_pid);
          if (sameWorker) {
            db.prepare(`
              UPDATE source_backfill_runs
              SET lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND run_token = ?
            `).run(at + leaseMs, at, candidate.id, candidate.run_token);
            db.exec('COMMIT');
            return getRun(candidate.id);
          }
          if (!expired && !deadWorker) continue;
        }

        const runToken = crypto.randomUUID();
        db.prepare(`
          UPDATE source_backfill_runs
          SET status = 'running',
              run_token = ?,
              worker_pid = ?,
              lease_expires_at = ?,
              next_retry_at = NULL,
              attempt_count = attempt_count + 1,
              updated_at = ?
          WHERE id = ?
        `).run(runToken, workerPid, at + leaseMs, at, candidate.id);
        db.exec('COMMIT');
        return getRun(candidate.id);
      }
      db.exec('COMMIT');
      return null;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function assertFenceInTx(runId, runToken, generation) {
    if (!runId || !runToken) return { ok: false, reason: 'missing_token' };
    const row = db.prepare(`
      SELECT r.*, s.generation AS state_generation
      FROM source_backfill_runs r
      JOIN source_backfill_states s ON s.source_id = r.source_id
      WHERE r.id = ?
    `).get(runId);
    if (!row) return { ok: false, reason: 'run_not_found' };
    if (row.status !== 'running') return { ok: false, reason: `status_${row.status}` };
    if (row.run_token !== runToken) return { ok: false, reason: 'stale_run_token' };
    if (Number(row.state_generation) !== Number(generation) || Number(row.generation) !== Number(generation)) {
      return { ok: false, reason: 'stale_generation' };
    }
    if (!isSourceActiveInDb(row.source_id)) {
      return { ok: false, reason: 'source_inactive' };
    }
    return { ok: true, run: normalizeRunRow(row) };
  }

  function updateStateMetricsInTx({
    sourceId,
    stats,
    inserted = 0,
    reused = 0,
    coverageStatus = null,
    clearErrors = false,
    at,
  }) {
    db.prepare(`
      UPDATE source_backfill_states
      SET coverage_status = COALESCE(?, coverage_status),
          earliest_published_at = ?,
          latest_published_at = ?,
          known_entry_count = ?,
          backfilled_entry_count = backfilled_entry_count + ?,
          reused_entry_count = reused_entry_count + ?,
          last_error_code = CASE WHEN ? THEN '' ELSE last_error_code END,
          last_error_message = CASE WHEN ? THEN '' ELSE last_error_message END,
          updated_at = ?
      WHERE source_id = ?
    `).run(
      coverageStatus,
      stats.earliestPublishedAt,
      stats.latestPublishedAt,
      stats.entryCount,
      inserted,
      reused,
      clearErrors ? 1 : 0,
      clearErrors ? 1 : 0,
      at,
      sourceId,
    );
  }

  function pinFetchedSnapshot({
    runId,
    runToken,
    generation,
    snapshotHash,
    snapshotBytes,
    parserVersion = BACKFILL_PARSER_VERSION,
    totalCount = 0,
    nextArchiveUrl = '',
    archiveComplete = false,
    at = now(),
    leaseMs = BACKFILL_DEFAULT_LEASE_MS,
  }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const fenced = assertFenceInTx(runId, runToken, generation);
      if (!fenced.ok) {
        db.exec('ROLLBACK');
        return { ok: false, reason: fenced.reason };
      }
      const run = fenced.run;
      const cleanSnapshotHash = String(snapshotHash || '').trim().toLowerCase();
      const inputIdentity = computeInputIdentity({
        sourceId: run.sourceId,
        snapshotHash: cleanSnapshotHash,
        parserVersion,
        feedUrlHash: run.feedUrlHash,
      });
      const cursor = {
        v: 1,
        inputIdentity,
        snapshotHash: cleanSnapshotHash,
        parserVersion,
        offset: 0,
      };
      db.prepare(`
        UPDATE source_backfill_runs
        SET snapshot_hash = ?,
            snapshot_bytes = ?,
            parser_version = ?,
            input_identity = ?,
            total_count = ?,
            processed_count = 0,
            cursor_json = ?,
            next_archive_url = ?,
            archive_complete = ?,
            retry_count = 0,
            error_code = '',
            error_message = '',
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND run_token = ?
      `).run(
        cleanSnapshotHash,
        Math.max(0, Number(snapshotBytes) || 0),
        String(parserVersion || BACKFILL_PARSER_VERSION),
        inputIdentity,
        Math.max(0, Number(totalCount) || 0),
        JSON.stringify(cursor),
        String(nextArchiveUrl || '').trim(),
        archiveComplete ? 1 : 0,
        at + leaseMs,
        at,
        runId,
        runToken,
      );
      db.exec('COMMIT');
      return { ok: true, run: getRun(runId) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function commitBatch({
    runId,
    runToken,
    generation,
    entries = [],
    documents = [],
    nextOffset,
    batchProcessedCount,
    at = now(),
    leaseMs = BACKFILL_DEFAULT_LEASE_MS,
  }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const fenced = assertFenceInTx(runId, runToken, generation);
      if (!fenced.ok) {
        db.exec('ROLLBACK');
        return { ok: false, reason: fenced.reason };
      }
      const run = fenced.run;
      const sourceId = run.sourceId;
      const ingestion = getSourceIngestionBySourceId ? getSourceIngestionBySourceId(sourceId) : null;
      const cutoff = run.cutoffAt || (ingestion && ingestion.activationCutoff) || at;

      const findByIdentityStmt = db.prepare('SELECT id, link, deleted_at, auto_ai_excluded_at, platform_identity FROM entries WHERE source_id = ? AND platform_identity = ?');
      const findByIdStmt = db.prepare('SELECT id, link, deleted_at, auto_ai_excluded_at, platform_identity FROM entries WHERE id = ?');
      const rowsBySource = db.prepare('SELECT id, link, deleted_at, auto_ai_excluded_at, platform_identity FROM entries WHERE source_id = ?').all(sourceId);
      const legacyByIdentity = new Map();
      if (wechatIdentityFromLink) {
        for (const row of rowsBySource) {
          if (!row.platform_identity) {
            const legacyId = wechatIdentityFromLink(row.link);
            if (legacyId && !legacyByIdentity.has(legacyId)) legacyByIdentity.set(legacyId, row);
          }
        }
      }

      const seenBatchKeys = new Set();
      const toUpsert = [];
      let inserted = 0;
      let reused = 0;
      const docByEntryId = new Map((Array.isArray(documents) ? documents : []).map(doc => [doc.entryId, doc]));

      for (const rawEntry of Array.isArray(entries) ? entries : []) {
        if (!rawEntry || rawEntry.sourceId !== sourceId) continue;
        const entry = { ...rawEntry };
        const identity = String(
          entry.platformIdentity
          || (wechatIdentityFromLink ? wechatIdentityFromLink(entry.link) : '')
          || '',
        ).trim();
        const dedupKey = identity ? `pi:${identity}` : `id:${entry.id}`;
        if (seenBatchKeys.has(dedupKey)) {
          reused += 1;
          continue;
        }
        seenBatchKeys.add(dedupKey);

        const mapped = identity
          ? (findByIdentityStmt.get(sourceId, identity) || legacyByIdentity.get(identity) || findByIdStmt.get(entry.id) || null)
          : findByIdStmt.get(entry.id) || null;

        if (mapped) {
          reused += 1;
          if (Number(mapped.deleted_at)) {
            if (identity && !mapped.platform_identity) {
              db.prepare('UPDATE entries SET platform_identity = ?, auto_ai_excluded_at = COALESCE(auto_ai_excluded_at, ?) WHERE id = ?')
                .run(identity, cutoff, mapped.id);
            }
            continue;
          }
          entry.id = mapped.id;
          entry.platformIdentity = identity || mapped.platform_identity || '';
          entry.autoAiExcludedAt = mapped.auto_ai_excluded_at != null
            ? Number(mapped.auto_ai_excluded_at)
            : null;
          if (identity && !mapped.platform_identity) {
            db.prepare('UPDATE entries SET platform_identity = ? WHERE id = ?').run(identity, mapped.id);
          }
          if (!docByEntryId.has(entry.id) && docByEntryId.has(rawEntry.id)) {
            const doc = docByEntryId.get(rawEntry.id);
            docByEntryId.set(entry.id, { ...doc, entryId: entry.id });
          }
          continue;
        }

        inserted += 1;
        entry.platformIdentity = identity;
        entry.autoAiExcludedAt = cutoff;
        if (!['feed-body', 'summary', 'unknown'].includes(entry.contentScope)) {
          entry.contentScope = 'unknown';
        }
        toUpsert.push(entry);
      }

      if (toUpsert.length) {
        upsertEntryRows(toUpsert);
        if (insertArticleDocument) {
          for (const entry of toUpsert) {
            const compiled = docByEntryId.get(entry.id);
            if (!compiled) continue;
            const docId = `document-${sha256Hex(`${entry.id}\n${compiled.documentHash}`)}`;
            const savedDoc = insertArticleDocument({
              id: docId,
              entryId: entry.id,
              snapshotId: null,
              sourceComponents: compiled.sourceComponents || [],
              provenance: compiled.provenance,
              rawStatus: compiled.rawStatus,
              documentHash: compiled.documentHash,
              sourceHash: compiled.sourceHash,
              extractorVersion: compiled.extractorVersion,
              sanitizerVersion: compiled.sanitizerVersion,
              segmenterVersion: compiled.segmenterVersion,
              title: compiled.title,
              summary: compiled.summary,
              normalizedHtml: compiled.normalizedHtml,
              plainText: compiled.plainText,
              ast: compiled.ast,
              resources: compiled.resources,
              createdAt: at,
            });
            db.prepare('UPDATE entries SET current_document_id = ? WHERE id = ?').run(savedDoc.id, entry.id);
          }
        }
      }

      const processedTotal = Math.min(run.totalCount, Math.max(run.processedCount, Number(nextOffset) || (run.processedCount + (Number(batchProcessedCount) || 0))));
      const nextCursor = {
        v: 1,
        inputIdentity: run.inputIdentity,
        snapshotHash: run.snapshotHash,
        parserVersion: run.parserVersion,
        offset: processedTotal,
      };
      const doneCurrentSnapshot = processedTotal >= run.totalCount;
      const stats = getSourceEntryStats(sourceId);

      let nextQueuedRun = null;
      if (!doneCurrentSnapshot) {
        db.prepare(`
          UPDATE source_backfill_runs
          SET processed_count = ?,
              inserted_count = inserted_count + ?,
              reused_count = reused_count + ?,
              cursor_json = ?,
              lease_expires_at = ?,
              updated_at = ?
          WHERE id = ? AND run_token = ?
        `).run(
          processedTotal,
          inserted,
          reused,
          JSON.stringify(nextCursor),
          at + leaseMs,
          at,
          runId,
          runToken,
        );
        updateStateMetricsInTx({ sourceId, stats, inserted, reused, at });
      } else {
        db.prepare(`
          UPDATE source_backfill_runs
          SET status = 'succeeded',
              run_token = NULL,
              worker_pid = NULL,
              lease_expires_at = NULL,
              processed_count = ?,
              inserted_count = inserted_count + ?,
              reused_count = reused_count + ?,
              cursor_json = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND run_token = ?
        `).run(
          processedTotal,
          inserted,
          reused,
          JSON.stringify(nextCursor),
          at,
          at,
          runId,
          runToken,
        );

        const nextUrl = String(run.nextArchiveUrl || '').trim();
        const alreadyVisited = nextUrl && run.visitedUrls.includes(nextUrl);
        const canFollowNext = Boolean(nextUrl && !alreadyVisited && run.archiveDepth < BACKFILL_MAX_ARCHIVE_PAGES);

        if (canFollowNext) {
          updateStateMetricsInTx({ sourceId, stats, inserted, reused, at });
          const enqueued = enqueueRun({
            sourceId,
            triggerReason: 'archive-next',
            feedUrl: nextUrl,
            snapshotHash: '',
            parserVersion: run.parserVersion,
            visitedUrls: [...run.visitedUrls, nextUrl],
            archiveDepth: run.archiveDepth + 1,
            cutoffAt: run.cutoffAt,
            forceNew: true,
            respectPaused: false,
            inTransaction: true,
            at,
          });
          nextQueuedRun = enqueued.run;
        } else {
          const finalCoverage = run.archiveComplete ? 'provider_archive_exhausted' : 'available_window';
          updateStateMetricsInTx({
            sourceId,
            stats,
            inserted,
            reused,
            coverageStatus: finalCoverage,
            clearErrors: true,
            at,
          });
        }
      }

      db.exec('COMMIT');
      return {
        ok: true,
        inserted,
        reused,
        completed: doneCurrentSnapshot,
        run: getRun(runId),
        nextRun: nextQueuedRun,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function scheduleRetry({
    runId,
    runToken,
    generation,
    errorCode = 'ERR_BACKFILL_TRANSIENT',
    errorMessage = '',
    nextRetryAt,
    at = now(),
  }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const fenced = assertFenceInTx(runId, runToken, generation);
      if (!fenced.ok) {
        db.exec('ROLLBACK');
        return { ok: false, reason: fenced.reason };
      }
      const run = fenced.run;
      if (run.retryCount >= BACKFILL_MAX_AUTO_RETRIES) {
        db.exec('ROLLBACK');
        return failRun({
          runId,
          runToken,
          generation,
          errorCode,
          errorMessage,
          at,
        });
      }
      const nextRetryCount = run.retryCount + 1;
      db.prepare(`
        UPDATE source_backfill_runs
        SET status = 'retry_wait',
            run_token = NULL,
            worker_pid = NULL,
            lease_expires_at = NULL,
            retry_count = ?,
            next_retry_at = ?,
            error_code = ?,
            error_message = ?,
            updated_at = ?
        WHERE id = ? AND run_token = ?
      `).run(
        nextRetryCount,
        Number(nextRetryAt) || at,
        String(errorCode || 'ERR_BACKFILL_TRANSIENT').slice(0, 80),
        String(errorMessage || '').slice(0, 300),
        at,
        runId,
        runToken,
      );
      db.prepare(`
        UPDATE source_backfill_states
        SET last_error_code = ?,
            last_error_message = ?,
            updated_at = ?
        WHERE source_id = ?
      `).run(
        String(errorCode || 'ERR_BACKFILL_TRANSIENT').slice(0, 80),
        String(errorMessage || '').slice(0, 300),
        at,
        run.sourceId,
      );
      db.exec('COMMIT');
      return { ok: true, status: 'retry_wait', run: getRun(runId) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function failRun({
    runId,
    runToken,
    generation,
    errorCode = 'ERR_BACKFILL_FAILED',
    errorMessage = '',
    coverageStatus = null,
    failedItemsDelta = 0,
    at = now(),
  }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const fenced = assertFenceInTx(runId, runToken, generation);
      if (!fenced.ok) {
        db.exec('ROLLBACK');
        return { ok: false, reason: fenced.reason };
      }
      const run = fenced.run;
      db.prepare(`
        UPDATE source_backfill_runs
        SET status = 'failed',
            run_token = NULL,
            worker_pid = NULL,
            lease_expires_at = NULL,
            next_retry_at = NULL,
            failed_item_count = failed_item_count + ?,
            error_code = ?,
            error_message = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND run_token = ?
      `).run(
        Math.max(0, Number(failedItemsDelta) || 0),
        String(errorCode || 'ERR_BACKFILL_FAILED').slice(0, 80),
        String(errorMessage || '').slice(0, 300),
        at,
        at,
        runId,
        runToken,
      );
      const nextCoverage = coverageStatus && COVERAGE_STATUSES.has(coverageStatus) ? coverageStatus : null;
      db.prepare(`
        UPDATE source_backfill_states
        SET coverage_status = COALESCE(?, coverage_status),
            last_error_code = ?,
            last_error_message = ?,
            updated_at = ?
        WHERE source_id = ?
      `).run(
        nextCoverage,
        String(errorCode || 'ERR_BACKFILL_FAILED').slice(0, 80),
        String(errorMessage || '').slice(0, 300),
        at,
        run.sourceId,
      );
      db.exec('COMMIT');
      return { ok: true, status: 'failed', run: getRun(runId) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function applyAdminAction(sourceId, action, { at = now() } = {}) {
    const cleanId = String(sourceId || '').trim();
    const cleanAction = String(action || '').trim();
    if (!['pause', 'resume', 'retry'].includes(cleanAction)) {
      throw backfillError('invalid-backfill-action', 'action must be pause, resume, or retry', 400);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const state = ensureStateRow(cleanId, at);
      const run = state.activeRunId ? getRun(state.activeRunId) : getLatestRunForSource(cleanId);
      if (!run) {
        throw backfillError('backfill-state-conflict', 'no backfill run exists for this source', 409);
      }

      if (cleanAction === 'pause') {
        if (!ACTIVE_RUN_STATUSES.has(run.status)) {
          throw backfillError('backfill-state-conflict', `cannot pause backfill in status ${run.status}`, 409);
        }
        const nextGeneration = state.generation + 1;
        db.prepare(`
          UPDATE source_backfill_states
          SET generation = ?, updated_at = ?
          WHERE source_id = ?
        `).run(nextGeneration, at, cleanId);
        db.prepare(`
          UPDATE source_backfill_runs
          SET status = 'paused',
              run_token = NULL,
              worker_pid = NULL,
              lease_expires_at = NULL,
              next_retry_at = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(at, run.id);
      } else if (cleanAction === 'resume') {
        if (!isSourceActiveInDb(cleanId)) {
          throw backfillError('source-inactive', 'source must be enabled and not archived before resuming backfill', 409);
        }
        if (run.status !== 'paused') {
          throw backfillError('backfill-state-conflict', `cannot resume backfill in status ${run.status}`, 409);
        }
        const nextGeneration = state.generation + 1;
        db.prepare(`
          UPDATE source_backfill_states
          SET generation = ?,
              last_error_code = '',
              last_error_message = '',
              updated_at = ?
          WHERE source_id = ?
        `).run(nextGeneration, at, cleanId);
        db.prepare(`
          UPDATE source_backfill_runs
          SET status = 'queued',
              generation = ?,
              run_token = NULL,
              worker_pid = NULL,
              lease_expires_at = NULL,
              next_retry_at = NULL,
              error_code = '',
              error_message = '',
              updated_at = ?
          WHERE id = ?
        `).run(nextGeneration, at, run.id);
      } else if (cleanAction === 'retry') {
        if (!isSourceActiveInDb(cleanId)) {
          throw backfillError('source-inactive', 'source must be enabled and not archived before retrying backfill', 409);
        }
        if (run.status !== 'failed') {
          throw backfillError('backfill-state-conflict', `cannot retry backfill in status ${run.status}`, 409);
        }
        const nextGeneration = state.generation + 1;
        const resetSnapshot = ['ERR_BACKFILL_SNAPSHOT_MISSING', 'ERR_BACKFILL_SNAPSHOT_CORRUPT'].includes(run.errorCode)
          && Boolean(run.feedUrl);
        const resetCursor = resetSnapshot
          ? JSON.stringify({ v: 1, inputIdentity: '', snapshotHash: '', parserVersion: run.parserVersion, offset: 0 })
          : JSON.stringify(run.cursor);

        db.prepare(`
          UPDATE source_backfill_states
          SET generation = ?,
              coverage_status = CASE WHEN coverage_status = 'mismatch' THEN 'unknown' ELSE coverage_status END,
              last_error_code = '',
              last_error_message = '',
              updated_at = ?
          WHERE source_id = ?
        `).run(nextGeneration, at, cleanId);
        db.prepare(`
          UPDATE source_backfill_runs
          SET status = 'queued',
              generation = ?,
              run_token = NULL,
              worker_pid = NULL,
              lease_expires_at = NULL,
              retry_count = 0,
              next_retry_at = NULL,
              snapshot_hash = CASE WHEN ? THEN '' ELSE snapshot_hash END,
              snapshot_bytes = CASE WHEN ? THEN 0 ELSE snapshot_bytes END,
              input_identity = CASE WHEN ? THEN '' ELSE input_identity END,
              total_count = CASE WHEN ? THEN 0 ELSE total_count END,
              processed_count = CASE WHEN ? THEN 0 ELSE processed_count END,
              inserted_count = CASE WHEN ? THEN 0 ELSE inserted_count END,
              reused_count = CASE WHEN ? THEN 0 ELSE reused_count END,
              cursor_json = ?,
              error_code = '',
              error_message = '',
              completed_at = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(
          nextGeneration,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetSnapshot ? 1 : 0,
          resetCursor,
          at,
          run.id,
        );
      }

      db.exec('COMMIT');
      return {
        state: getState(cleanId),
        run: getRun(run.id),
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function markWindowCoveredIfUnknown(sourceId, { coverageStatus = 'available_window', at = now() } = {}) {
    const cleanId = String(sourceId || '').trim();
    if (!cleanId) return null;
    const validStatus = coverageStatus === 'provider_archive_exhausted' ? 'provider_archive_exhausted' : 'available_window';
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = ensureStateRow(cleanId, at);
      const stats = getSourceEntryStats(cleanId);
      const nextStatus = state.coverageStatus === 'unknown' ? validStatus : state.coverageStatus;
      db.prepare(`
        UPDATE source_backfill_states
        SET coverage_status = ?,
            earliest_published_at = COALESCE(?, earliest_published_at),
            latest_published_at = COALESCE(?, latest_published_at),
            known_entry_count = ?,
            updated_at = ?
        WHERE source_id = ?
      `).run(
        nextStatus,
        stats.earliestPublishedAt,
        stats.latestPublishedAt,
        stats.entryCount,
        at,
        cleanId,
      );
      db.exec('COMMIT');
      return getState(cleanId);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    getState,
    getRun,
    getLatestRunForSource,
    getSourceEntryStats,
    getAllSourceEntryStats,
    listAllStates,
    listActiveOrLatestRunsBySource,
    hasAnyUnimportedCandidate,
    hasCompletedOrActiveRunForFeedUrl,
    hasRunForInputIdentity,
    invalidateActiveRuns,
    enqueueRun,
    hasActiveRuns,
    getNextWakeAt,
    claimNextRun,
    pinFetchedSnapshot,
    commitBatch,
    scheduleRetry,
    failRun,
    applyAdminAction,
    markWindowCoveredIfUnknown,
  };
}

module.exports = {
  BACKFILL_PARSER_VERSION,
  BACKFILL_MAX_BATCH_SIZE,
  BACKFILL_MAX_AUTO_RETRIES,
  BACKFILL_MAX_ARCHIVE_PAGES,
  BACKFILL_DEFAULT_LEASE_MS,
  ACTIVE_RUN_STATUSES,
  COVERAGE_STATUSES,
  sha256Hex,
  computeInputIdentity,
  createSourceBackfillStore,
};
