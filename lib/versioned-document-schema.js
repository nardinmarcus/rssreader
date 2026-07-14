function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function ensureColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!/duplicate column name/i.test(String(error && error.message))) throw error;
  }
}

function ensureVersionedDocumentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_snapshots (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      raw_hash TEXT NOT NULL,
      request_url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      charset TEXT NOT NULL,
      response_meta_json TEXT NOT NULL DEFAULT '{}',
      body_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      fetched_at INTEGER NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_snapshots_entry_fetched
      ON source_snapshots(entry_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_snapshots_raw_hash
      ON source_snapshots(raw_hash);

    CREATE TABLE IF NOT EXISTS article_documents (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      snapshot_id TEXT,
      source_components_json TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL CHECK(provenance IN ('fetched', 'feed', 'legacy')),
      raw_status TEXT NOT NULL CHECK(raw_status IN ('available', 'unavailable')),
      document_hash TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      sanitizer_version TEXT NOT NULL,
      segmenter_version TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      normalized_html TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      ast_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(entry_id, document_hash),
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
      FOREIGN KEY(snapshot_id) REFERENCES source_snapshots(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_article_documents_entry_created
      ON article_documents(entry_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS translation_versions (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('system', 'user')),
      user_id TEXT,
      author TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      pipeline_hash TEXT NOT NULL,
      generation_hash TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      title_zh TEXT NOT NULL DEFAULT '',
      summary_zh TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK((owner_type = 'system' AND user_id IS NULL) OR (owner_type = 'user' AND user_id IS NOT NULL)),
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES article_documents(id) ON DELETE RESTRICT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_translation_versions_entry_created
      ON translation_versions(entry_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_translation_versions_document
      ON translation_versions(document_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS translation_jobs (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('system', 'user')),
      user_id TEXT,
      author TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      pipeline_hash TEXT NOT NULL,
      generation_hash TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tuning_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at INTEGER,
      next_retry_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK((owner_type = 'system' AND user_id IS NULL) OR (owner_type = 'user' AND user_id IS NOT NULL)),
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES article_documents(id) ON DELETE RESTRICT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_translation_jobs_status
      ON translation_jobs(status, next_retry_at, priority DESC, created_at);
    CREATE INDEX IF NOT EXISTS idx_translation_jobs_entry
      ON translation_jobs(entry_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS translation_job_chunks (
      job_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
      segment_ids_json TEXT NOT NULL,
      chunk_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(job_id, chunk_index),
      FOREIGN KEY(job_id) REFERENCES translation_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_translation_job_chunks_status
      ON translation_job_chunks(job_id, status, chunk_index);
  `);

  ensureColumn(db, 'entries', 'current_document_id', 'current_document_id TEXT REFERENCES article_documents(id) ON DELETE SET NULL');
  ensureColumn(db, 'entries', 'current_translation_id', 'current_translation_id TEXT REFERENCES translation_versions(id) ON DELETE SET NULL');
  if (hasTable(db, 'entry_ai_asset_contributions')) {
    ensureColumn(
      db,
      'entry_ai_asset_contributions',
      'translation_version_id',
      'translation_version_id TEXT REFERENCES translation_versions(id) ON DELETE SET NULL',
    );
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_asset_contributions_translation_version
        ON entry_ai_asset_contributions(translation_version_id)
        WHERE translation_version_id IS NOT NULL
    `);
  }
}

module.exports = {
  ensureVersionedDocumentSchema,
};
