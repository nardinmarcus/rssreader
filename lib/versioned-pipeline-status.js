const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { resolveDataPaths } = require('./data-paths');
const { translationPipelineHash } = require('./translation-contract');

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function finiteNow(value) {
  return Number.isFinite(value) ? Number(value) : Date.now();
}

function jobStatus(db, now) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      MIN(CASE WHEN status IN ('queued', 'retry_wait') THEN created_at END) AS oldest_waiting_created_at
    FROM translation_jobs
  `).get();
  const oldest = row.oldest_waiting_created_at === null
    ? null
    : Math.max(0, now - Number(row.oldest_waiting_created_at));
  const failuresByCode = {};
  for (const failure of db.prepare(`
    SELECT COALESCE(NULLIF(error_code, ''), 'ERR_TRANSLATION_JOB_FAILED') AS code, COUNT(*) AS count
    FROM translation_jobs
    WHERE status = 'failed'
    GROUP BY code
    ORDER BY code ASC
  `).all()) {
    failuresByCode[failure.code] = Number(failure.count);
  }
  return {
    queued: Number(row.queued || 0),
    running: Number(row.running || 0),
    retry: Number(row.retry || 0),
    failed: Number(row.failed || 0),
    oldestWaitingAgeMs: oldest,
    failuresByCode,
  };
}

function freshnessStatus(db) {
  const counts = {
    fresh: 0,
    staleSource: 0,
    stalePipeline: 0,
    legacyUnknown: 0,
    missing: 0,
  };
  const rows = db.prepare(`
    SELECT state, COUNT(*) AS count
    FROM (
      SELECT CASE
        WHEN v.id IS NULL THEN 'missing'
        WHEN d.id IS NULL OR v.source_hash <> d.source_hash THEN 'staleSource'
        WHEN v.pipeline_hash = 'legacy_unknown' THEN 'legacyUnknown'
        WHEN v.pipeline_hash <> ? THEN 'stalePipeline'
        ELSE 'fresh'
      END AS state
      FROM entries e
      LEFT JOIN article_documents d ON d.id = e.current_document_id
      LEFT JOIN translation_versions v ON v.id = e.current_translation_id
      WHERE e.deleted_at IS NULL
    )
    GROUP BY state
  `).all(translationPipelineHash());
  for (const row of rows) counts[row.state] = Number(row.count);
  return counts;
}

function rawStorageStatus(dataDir, now) {
  const root = path.join(dataDir, 'raw', 'sha256');
  const status = { files: 0, compressedBytes: 0, recent24hBytes: 0 };
  if (!fs.existsSync(root)) return status;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html.gz')) continue;
      try {
        const stat = fs.statSync(absolute);
        status.files += 1;
        status.compressedBytes += stat.size;
        if (stat.mtimeMs >= now - RECENT_WINDOW_MS) status.recent24hBytes += stat.size;
      } catch { /* a concurrent verifier or cleanup may remove a blob */ }
    }
  }
  return status;
}

function getVersionedPipelineStatus({ now: nowValue } = {}) {
  const now = finiteNow(nowValue);
  const { dataDir, databaseFile } = resolveDataPaths();
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      generatedAt: now,
      jobs: jobStatus(db, now),
      freshness: freshnessStatus(db),
      rawStorage: rawStorageStatus(dataDir, now),
    };
  } finally {
    db.close();
  }
}

module.exports = { getVersionedPipelineStatus };
