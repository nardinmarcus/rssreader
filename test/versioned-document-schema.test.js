const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { ensureVersionedDocumentSchema } = require('../lib/versioned-document-schema');

const rootDir = path.resolve(__dirname, '..');
const storePath = path.join(rootDir, 'lib', 'store.js');

function startStore(dataDir) {
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(storePath)})`], {
    cwd: rootDir,
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
}

function createCurrentLegacyEntriesTable(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      author TEXT,
      published TEXT,
      published_ts INTEGER DEFAULT 0,
      summary TEXT,
      content TEXT,
      image TEXT,
      audio_json TEXT,
      content_hash TEXT,
      original_fetched_at INTEGER,
      original_fetch_attempted_at INTEGER,
      original_fetch_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.close();
}

function assertVersionedSchema(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  for (const table of [
    'source_snapshots',
    'article_documents',
    'translation_versions',
    'translation_jobs',
    'translation_job_chunks',
  ]) assert.equal(tables.has(table), true, `missing table ${table}`);

  const entryColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map(row => row.name));
  assert.equal(entryColumns.has('current_document_id'), true);
  assert.equal(entryColumns.has('current_translation_id'), true);
  const contributionColumns = new Set(db.prepare('PRAGMA table_info(entry_ai_asset_contributions)').all().map(row => row.name));
  assert.equal(contributionColumns.has('translation_version_id'), true);

  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name));
  for (const index of [
    'idx_source_snapshots_entry_fetched',
    'idx_source_snapshots_raw_hash',
    'idx_article_documents_entry_created',
    'idx_translation_versions_entry_created',
    'idx_translation_versions_document',
    'idx_translation_jobs_status',
    'idx_translation_jobs_entry',
    'idx_translation_job_chunks_status',
    'idx_ai_asset_contributions_translation_version',
  ]) assert.equal(indexes.has(index), true, `missing index ${index}`);
  for (const table of ['translation_versions', 'translation_jobs']) {
    const userForeignKey = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find(row => row.table === 'users');
    assert.equal(userForeignKey && userForeignKey.on_delete, 'RESTRICT');
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
}

test('versioned DDL starts from empty, current legacy, and already migrated databases', () => {
  const dataDirs = [createTempDataDir(), createTempDataDir(), createTempDataDir()];
  try {
    startStore(dataDirs[0]);
    assertVersionedSchema(dataDirs[0]);

    createCurrentLegacyEntriesTable(dataDirs[1]);
    startStore(dataDirs[1]);
    assertVersionedSchema(dataDirs[1]);

    startStore(dataDirs[2]);
    startStore(dataDirs[2]);
    assertVersionedSchema(dataDirs[2]);
  } finally {
    for (const dataDir of dataDirs) fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('versioned unique constraints and user ownership foreign keys fail closed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE entries (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
  `);
  ensureVersionedDocumentSchema(db);
  db.exec(`
    INSERT INTO entries (id) VALUES ('entry-constraints');
    INSERT INTO users (id) VALUES ('user-constraints'), ('user-version-constraints');
    INSERT INTO source_snapshots (
      id, entry_id, raw_hash, request_url, final_url, status_code, content_type,
      charset, response_meta_json, body_path, size_bytes, fetched_at
    ) VALUES (
      'snapshot-constraints', 'entry-constraints', 'raw', 'https://example.com',
      'https://example.com', 200, 'text/html', 'utf-8', '{}', 'raw/file.gz', 10, 1
    );
    INSERT INTO article_documents (
      id, entry_id, snapshot_id, source_components_json, provenance, raw_status,
      document_hash, source_hash, extractor_version, sanitizer_version, segmenter_version,
      title, summary, normalized_html, plain_text, ast_json, resources_json, created_at
    ) VALUES (
      'document-constraints', 'entry-constraints', 'snapshot-constraints', '[]', 'fetched',
      'available', 'document-hash', 'source-hash', 'e1', 's1', 'g1', 'Title', '',
      '<p>Body</p>', 'Body', '[]', '[]', 2
    );
    INSERT INTO translation_jobs (
      id, entry_id, document_id, owner_type, user_id, author, source_hash, pipeline_hash,
      generation_hash, provider, model, tuning_json, priority, status, attempt_count,
      created_at, updated_at
    ) VALUES (
      'job-constraints', 'entry-constraints', 'document-constraints', 'user', 'user-constraints',
      'User', 'source-hash', 'pipeline-hash', 'generation-hash', 'provider', 'model', '{}',
      0, 'queued', 0, 3, 3
    );
    INSERT INTO translation_versions (
      id, entry_id, document_id, owner_type, user_id, author, source_hash, pipeline_hash,
      generation_hash, schema_version, title_zh, summary_zh, content_json, provider, model, created_at
    ) VALUES (
      'version-constraints', 'entry-constraints', 'document-constraints', 'user',
      'user-version-constraints', 'User', 'source-hash', 'pipeline-hash',
      'version-generation-hash', 2, '', '', '{}', 'provider', 'model', 3
    );
    INSERT INTO translation_job_chunks (
      job_id, chunk_index, segment_ids_json, chunk_hash, status, attempt_count, created_at, updated_at
    ) VALUES ('job-constraints', 0, '["s_1"]', 'chunk-hash', 'pending', 0, 4, 4);
  `);

  assert.throws(() => db.exec(`
    INSERT INTO article_documents (
      id, entry_id, source_components_json, provenance, raw_status, document_hash, source_hash,
      extractor_version, sanitizer_version, segmenter_version, title, summary, normalized_html,
      plain_text, ast_json, resources_json, created_at
    ) VALUES ('document-duplicate', 'entry-constraints', '[]', 'legacy', 'unavailable',
      'document-hash', 'other-source', 'e1', 's1', 'g1', 'Other', '', '', '', '[]', '[]', 5)
  `), /unique constraint/i);
  assert.throws(() => db.exec(`
    INSERT INTO translation_versions (
      id, entry_id, document_id, owner_type, user_id, author, source_hash, pipeline_hash,
      generation_hash, schema_version, title_zh, summary_zh, content_json, provider, model, created_at
    ) VALUES ('version-duplicate', 'entry-constraints', 'document-constraints', 'user',
      'user-version-constraints', 'User', 'source-hash', 'pipeline-hash',
      'version-generation-hash', 2, '', '', '{}', 'provider', 'model', 5)
  `), /unique constraint/i);
  assert.throws(() => db.exec(`
    INSERT INTO translation_jobs (
      id, entry_id, document_id, owner_type, author, source_hash, pipeline_hash,
      generation_hash, provider, model, status, created_at, updated_at
    ) VALUES ('job-duplicate', 'entry-constraints', 'document-constraints', 'system', 'System',
      'source-hash', 'pipeline-hash', 'generation-hash', 'provider', 'model', 'queued', 5, 5)
  `), /unique constraint/i);
  assert.throws(() => db.exec(`
    INSERT INTO translation_job_chunks (
      job_id, chunk_index, segment_ids_json, chunk_hash, status, created_at, updated_at
    ) VALUES ('job-constraints', 0, '[]', 'other-chunk', 'pending', 5, 5)
  `), /unique constraint/i);
  assert.throws(() => db.exec("DELETE FROM users WHERE id = 'user-constraints'"), /foreign key constraint/i);
  assert.throws(() => db.exec("DELETE FROM users WHERE id = 'user-version-constraints'"), /foreign key constraint/i);
  db.close();
});
