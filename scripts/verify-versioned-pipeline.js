const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { compileLegacyDocument, matchesEntryProjection } = require('../lib/article-documents');

const DATABASE_FILENAME = 'qmreader.sqlite';
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_COMPRESSED_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES + 1024 * 1024;

function parseArgs(argv) {
  let dataDir = String(process.env.NAMOO_READER_DATA_DIR || '').trim()
    || path.resolve(__dirname, '..', 'data');
  let readOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--read-only') {
      readOnly = true;
      continue;
    }
    if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('data-dir requires a value');
      dataDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
      if (!dataDir) throw new Error('data-dir requires a value');
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { dataDir: path.resolve(dataDir), readOnly };
}

function count(db, sql) {
  return Number(db.prepare(sql).get().count);
}

function staleDocumentCount(db) {
  const rows = db.prepare(`
    SELECT e.id, e.source_id, e.title, e.link, e.summary, e.content, e.content_hash,
           d.extractor_version, d.sanitizer_version, d.segmenter_version,
           d.title AS document_title, d.summary AS document_summary,
           d.normalized_html, d.plain_text, d.ast_json, d.resources_json
    FROM entries e
    JOIN article_documents d ON d.id = e.current_document_id
    WHERE d.entry_id = e.id
      AND COALESCE(e.deleted_at, 0) = 0
  `).all();
  return rows.reduce((total, row) => {
    try {
      const expected = compileLegacyDocument({
        entry: {
          id: row.id,
          sourceId: row.source_id,
          title: row.title,
          link: row.link || '',
          summary: row.summary || '',
          content: row.content || '',
          contentHash: row.content_hash || '',
        },
      });
      const current = {
        extractorVersion: row.extractor_version,
        sanitizerVersion: row.sanitizer_version,
        segmenterVersion: row.segmenter_version,
        title: row.document_title,
        summary: row.document_summary,
        normalizedHtml: row.normalized_html,
        plainText: row.plain_text,
        ast: JSON.parse(row.ast_json),
        resources: JSON.parse(row.resources_json),
      };
      return total + Number(!matchesEntryProjection(current, expected));
    } catch {
      return total + 1;
    }
  }, 0);
}

function migrationCounts(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM entries) AS entries,
      (SELECT COUNT(*) FROM entries WHERE current_document_id IS NOT NULL) AS entries_with_current_document,
      (SELECT COUNT(*) FROM entries WHERE current_document_id IS NULL) AS entries_without_current_document,
      (SELECT COUNT(*) FROM entries WHERE current_translation_id IS NOT NULL) AS entries_with_current_translation,
      (SELECT COUNT(*) FROM entries WHERE current_translation_id IS NULL) AS entries_without_current_translation,
      (SELECT COUNT(*) FROM source_snapshots) AS source_snapshots,
      (SELECT COUNT(*) FROM article_documents) AS article_documents,
      (SELECT COUNT(*) FROM translation_versions) AS translation_versions,
      (SELECT COUNT(*) FROM translation_jobs) AS translation_jobs,
      (SELECT COUNT(*) FROM translation_job_chunks) AS translation_job_chunks,
      (SELECT COUNT(*) FROM entry_translations) AS legacy_translations,
      (SELECT COUNT(*) FROM entry_ai_asset_contributions WHERE asset_type = 'translation') AS legacy_translation_contributions
  `).get();
  return {
    entries: Number(row.entries),
    entriesWithCurrentDocument: Number(row.entries_with_current_document),
    entriesWithoutCurrentDocument: Number(row.entries_without_current_document),
    entriesWithCurrentTranslation: Number(row.entries_with_current_translation),
    entriesWithoutCurrentTranslation: Number(row.entries_without_current_translation),
    sourceSnapshots: Number(row.source_snapshots),
    articleDocuments: Number(row.article_documents),
    translationVersions: Number(row.translation_versions),
    translationJobs: Number(row.translation_jobs),
    translationJobChunks: Number(row.translation_job_chunks),
    legacyTranslations: Number(row.legacy_translations),
    legacyTranslationContributions: Number(row.legacy_translation_contributions),
  };
}

function pointerCounts(db) {
  return {
    staleDocuments: staleDocumentCount(db),
    missingDocuments: count(db, `
      SELECT COUNT(*) AS count
      FROM entries e
      LEFT JOIN article_documents d ON d.id = e.current_document_id
      WHERE e.current_document_id IS NOT NULL AND d.id IS NULL
    `),
    mismatchedDocuments: count(db, `
      SELECT COUNT(*) AS count
      FROM entries e
      JOIN article_documents d ON d.id = e.current_document_id
      WHERE d.entry_id <> e.id
    `),
    missingTranslations: count(db, `
      SELECT COUNT(*) AS count
      FROM entries e
      LEFT JOIN translation_versions v ON v.id = e.current_translation_id
      WHERE e.current_translation_id IS NOT NULL AND v.id IS NULL
    `),
    mismatchedTranslationEntries: count(db, `
      SELECT COUNT(*) AS count
      FROM entries e
      JOIN translation_versions v ON v.id = e.current_translation_id
      WHERE v.entry_id <> e.id
    `),
    mismatchedTranslationDocuments: count(db, `
      SELECT COUNT(*) AS count
      FROM entries e
      JOIN article_documents d ON d.id = e.current_document_id
      JOIN translation_versions v ON v.id = e.current_translation_id
      WHERE v.document_id <> e.current_document_id
        AND v.source_hash <> d.source_hash
    `),
    mismatchedTranslationAssetHeads: count(db, `
      SELECT COUNT(*) AS count
      FROM entry_ai_asset_contributions c
      LEFT JOIN translation_versions v ON v.id = c.translation_version_id
      WHERE c.translation_version_id IS NOT NULL
        AND (
          c.asset_type <> 'translation'
          OR v.id IS NULL
          OR v.entry_id <> c.entry_id
          OR v.owner_type <> 'user'
          OR COALESCE(v.user_id, '') <> COALESCE(c.user_id, '')
        )
    `),
  };
}

function listRawBlobs(dataDir) {
  const root = path.join(dataDir, 'raw');
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.html.gz')) files.push(absolute);
    }
  }
  return files;
}

function verifySnapshots(db, dataDir) {
  const rows = db.prepare('SELECT raw_hash, body_path, size_bytes FROM source_snapshots').all();
  const snapshots = {
    records: rows.length,
    checked: 0,
    missing: 0,
    invalidPath: 0,
    pathMismatch: 0,
    invalidGzip: 0,
    hashMismatch: 0,
    sizeMismatch: 0,
    tooLarge: 0,
  };
  const rawRoot = path.resolve(dataDir, 'raw');
  const referenced = new Set();
  for (const row of rows) {
    const bodyPath = String(row.body_path || '');
    const absolute = path.resolve(dataDir, bodyPath);
    const relativeToRaw = path.relative(rawRoot, absolute);
    if (!bodyPath || path.isAbsolute(bodyPath)
      || relativeToRaw.startsWith('..') || path.isAbsolute(relativeToRaw)) {
      snapshots.invalidPath += 1;
      continue;
    }
    referenced.add(absolute);
    const rawHash = String(row.raw_hash || '').trim().toLowerCase();
    const canonicalPath = /^[a-f0-9]{64}$/.test(rawHash)
      ? path.posix.join(
        'raw',
        'sha256',
        rawHash.slice(0, 2),
        rawHash.slice(2, 4),
        `${rawHash}.html.gz`,
      )
      : '';
    if (bodyPath !== canonicalPath) snapshots.pathMismatch += 1;
    if (!fs.existsSync(absolute)) {
      snapshots.missing += 1;
      continue;
    }
    snapshots.checked += 1;
    try {
      if (fs.statSync(absolute).size > MAX_COMPRESSED_SNAPSHOT_BYTES) {
        snapshots.tooLarge += 1;
        continue;
      }
      const body = zlib.gunzipSync(fs.readFileSync(absolute), {
        maxOutputLength: MAX_SNAPSHOT_BYTES,
      });
      const actualHash = crypto.createHash('sha256').update(body).digest('hex');
      if (actualHash !== rawHash) {
        snapshots.hashMismatch += 1;
      }
      if (body.length !== Number(row.size_bytes)) snapshots.sizeMismatch += 1;
    } catch (error) {
      if (error && error.code === 'ERR_BUFFER_TOO_LARGE') snapshots.tooLarge += 1;
      else snapshots.invalidGzip += 1;
    }
  }
  const files = listRawBlobs(dataDir);
  return {
    snapshots,
    rawBlobs: {
      files: files.length,
      orphaned: files.filter(file => !referenced.has(path.resolve(file))).length,
    },
  };
}

function addFailure(failures, code, countValue) {
  if (countValue > 0) failures.push({ code, count: countValue });
}

function verify(dataDir, readOnly) {
  const databaseFile = path.join(dataDir, DATABASE_FILENAME);
  if (!fs.existsSync(databaseFile)) {
    return { ok: false, failures: [{ code: 'database_missing', count: 1 }] };
  }
  const db = new DatabaseSync(databaseFile, { readOnly });
  try {
    const quickRows = db.prepare('PRAGMA quick_check').all();
    const quickCheck = quickRows.length === 1 && quickRows[0].quick_check === 'ok' ? 'ok' : 'failed';
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    const migration = migrationCounts(db);
    const pointers = pointerCounts(db);
    const { snapshots, rawBlobs } = verifySnapshots(db, dataDir);
    const failures = [];
    addFailure(failures, 'database.quick_check', quickCheck === 'ok' ? 0 : 1);
    addFailure(failures, 'database.foreign_key', foreignKeyViolations);
    for (const [name, value] of Object.entries(pointers)) {
      addFailure(failures, `pointer.${name}`, value);
    }
    for (const [name, value] of Object.entries(snapshots)) {
      if (name !== 'records' && name !== 'checked') addFailure(failures, `snapshot.${name}`, value);
    }
    addFailure(failures, 'raw_blob.orphaned', rawBlobs.orphaned);
    return {
      ok: failures.length === 0,
      database: { quickCheck, foreignKeyViolations },
      migration,
      pointers,
      snapshots,
      rawBlobs,
      failures,
    };
  } finally {
    db.close();
  }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const { dataDir, readOnly } = parseArgs(process.argv.slice(2));
  const result = verify(dataDir, readOnly);
  output(result);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const code = /argument|requires a value/i.test(String(error && error.message || error))
    ? 'invalid_arguments'
    : 'verification_failed';
  output({ ok: false, failures: [{ code, count: 1 }] });
  process.exitCode = 1;
}
