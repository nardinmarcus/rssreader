/**
 * Creates the SQLite tables and indexes required for durable source historical backfill.
 */
function ensureSourceBackfillSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_backfill_states (
      source_id TEXT PRIMARY KEY,
      active_run_id TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      coverage_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(coverage_status IN ('unknown', 'available_window', 'provider_archive_exhausted', 'mismatch')),
      coverage_note TEXT NOT NULL DEFAULT '',
      earliest_published_at INTEGER,
      latest_published_at INTEGER,
      known_entry_count INTEGER NOT NULL DEFAULT 0,
      backfilled_entry_count INTEGER NOT NULL DEFAULT 0,
      reused_entry_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT NOT NULL DEFAULT '',
      last_error_message TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_backfill_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      trigger_reason TEXT NOT NULL,
      feed_url TEXT NOT NULL DEFAULT '',
      feed_url_hash TEXT NOT NULL DEFAULT '',
      snapshot_hash TEXT NOT NULL DEFAULT '',
      snapshot_bytes INTEGER NOT NULL DEFAULT 0,
      parser_version TEXT NOT NULL DEFAULT 'rss-backfill-v1',
      input_identity TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'retry_wait', 'paused', 'succeeded', 'failed', 'superseded')),
      run_token TEXT,
      worker_pid INTEGER,
      lease_expires_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      total_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      reused_count INTEGER NOT NULL DEFAULT 0,
      failed_item_count INTEGER NOT NULL DEFAULT 0,
      cursor_json TEXT NOT NULL DEFAULT '{}',
      next_archive_url TEXT NOT NULL DEFAULT '',
      archive_complete INTEGER NOT NULL DEFAULT 0,
      visited_urls_json TEXT NOT NULL DEFAULT '[]',
      archive_depth INTEGER NOT NULL DEFAULT 0,
      cutoff_at INTEGER NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_source_backfill_runs_source
      ON source_backfill_runs(source_id, created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_source_backfill_runs_claim
      ON source_backfill_runs(status, next_retry_at, lease_expires_at, created_at ASC);
  `);
}

module.exports = {
  ensureSourceBackfillSchema,
};
