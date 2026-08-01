const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'retry_wait']);
const JOB_STATUSES = ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded'];
const CADENCES = ['daily', 'weekly', 'monthly'];

function finiteNow(value) {
  return Number.isFinite(value) ? Number(value) : Date.now();
}

function safeErrorCode(value) {
  const code = String(value || '').trim();
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'ERR_PERIODICAL_BUILD';
}

function issueCounts(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM periodical_issues
    GROUP BY status
  `).all();
  const counts = { open: 0, finalizing: 0, frozen: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

function latestIssue(db, cadence) {
  const row = db.prepare(`
    SELECT
      issue.id,
      issue.cadence,
      issue.period_key,
      issue.status,
      issue.revision,
      issue.content_hash,
      issue.summary_status,
      issue.last_built_at,
      issue.frozen_at,
      COUNT(event.id) AS event_count,
      COALESCE((
        SELECT job.candidate_count
        FROM periodical_build_jobs AS job
        WHERE job.issue_id = issue.id AND job.status <> 'superseded'
        ORDER BY job.created_at DESC, job.rowid DESC
        LIMIT 1
      ), 0) AS candidate_count
    FROM periodical_issues AS issue
    LEFT JOIN periodical_events AS event ON event.issue_id = issue.id
    WHERE issue.cadence = ?
    GROUP BY issue.id
    ORDER BY issue.period_key DESC
    LIMIT 1
  `).get(cadence);
  if (!row) return null;
  return {
    issueId: row.id,
    cadence: row.cadence,
    periodKey: row.period_key,
    status: row.status,
    revision: Number(row.revision),
    contentHash: row.content_hash,
    summaryStatus: row.summary_status,
    lastBuiltAt: row.last_built_at === null ? null : Number(row.last_built_at),
    frozenAt: row.frozen_at === null ? null : Number(row.frozen_at),
    candidateCount: Number(row.candidate_count),
    eventCount: Number(row.event_count),
  };
}

function issueTotals(db) {
  const fallback = db.prepare(`
    SELECT COUNT(*) AS count
    FROM periodical_issues
    WHERE revision > 0 AND summary_status = 'fallback'
  `).get();
  const candidates = db.prepare(`
    SELECT COALESCE(SUM(job.candidate_count), 0) AS count
    FROM periodical_build_jobs AS job
    WHERE job.status <> 'superseded'
      AND job.rowid = (
        SELECT latest.rowid
        FROM periodical_build_jobs AS latest
        WHERE latest.issue_id = job.issue_id AND latest.status <> 'superseded'
        ORDER BY latest.created_at DESC, latest.rowid DESC
        LIMIT 1
      )
  `).get();
  const events = db.prepare('SELECT COUNT(*) AS count FROM periodical_events').get();
  return {
    fallback: Number(fallback.count),
    candidates: Number(candidates.count),
    events: Number(events.count),
  };
}

function jobCounts(db) {
  const counts = {
    queued: 0,
    running: 0,
    retryWait: 0,
    succeeded: 0,
    failed: 0,
    superseded: 0,
  };
  for (const row of db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM periodical_build_jobs
    GROUP BY status
  `).all()) {
    const key = row.status === 'retry_wait' ? 'retryWait' : row.status;
    if (JOB_STATUSES.includes(row.status)) counts[key] = Number(row.count);
  }
  return counts;
}

function oldestTask(db, now) {
  const row = db.prepare(`
    SELECT
      id, issue_id, status, attempt_count, next_retry_at, lease_expires_at,
      error_code, candidate_count, created_at
    FROM periodical_build_jobs
    WHERE status IN ('queued', 'running', 'retry_wait')
    ORDER BY created_at ASC, rowid ASC
    LIMIT 1
  `).get();
  if (!row || !ACTIVE_JOB_STATUSES.has(row.status)) return null;
  return {
    jobId: row.id,
    issueId: row.issue_id,
    status: row.status,
    ageMs: Math.max(0, now - Number(row.created_at)),
    attemptCount: Number(row.attempt_count),
    nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    errorCode: row.error_code === null ? null : safeErrorCode(row.error_code),
    candidateCount: Number(row.candidate_count),
  };
}

function latestSuccess(db) {
  const row = db.prepare(`
    SELECT id, issue_id, candidate_count, source_count, completed_at
    FROM periodical_build_jobs
    WHERE status = 'succeeded'
    ORDER BY COALESCE(completed_at, updated_at) DESC, created_at DESC, rowid DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    jobId: row.id,
    issueId: row.issue_id,
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    candidateCount: Number(row.candidate_count),
    sourceCount: Number(row.source_count),
  };
}

function errorsByCode(db) {
  const counts = {};
  for (const row of db.prepare(`
    SELECT error_code, COUNT(*) AS count
    FROM periodical_build_jobs
    WHERE status IN ('failed', 'retry_wait')
    GROUP BY error_code
  `).all()) {
    const code = safeErrorCode(row.error_code);
    counts[code] = (counts[code] || 0) + Number(row.count);
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function getPeriodicalsStatus(db, { now: nowValue, mode = 'off' } = {}) {
  const now = finiteNow(nowValue);
  return {
    generatedAt: now,
    mode,
    issues: {
      counts: issueCounts(db),
      latestByCadence: Object.fromEntries(CADENCES.map(cadence => [cadence, latestIssue(db, cadence)])),
      totals: issueTotals(db),
    },
    jobs: {
      counts: jobCounts(db),
      oldestTask: oldestTask(db, now),
      latestSuccess: latestSuccess(db),
      errorsByCode: errorsByCode(db),
    },
  };
}

module.exports = { getPeriodicalsStatus };
