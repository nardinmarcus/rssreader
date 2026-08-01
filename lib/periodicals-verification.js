const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');
const { canonicalSerialize } = require('./content-hashes');
const { ensurePeriodicalSchema } = require('./periodicals');
const { SOURCES } = require('./sources');

const PROTECTED_TABLES = Object.freeze([
  ['sourcePreferences', 'source_preferences'],
  ['customSources', 'custom_sources'],
  ['entries', 'entries'],
  ['users', 'users'],
  ['readingStates', 'user_entry_states'],
  ['entryStats', 'entry_stats'],
]);

function verificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fingerprintIterator(rows) {
  const hash = crypto.createHash('sha256');
  let rowCount = 0;
  hash.update('[');
  for (const row of rows) {
    if (rowCount > 0) hash.update(',');
    hash.update(canonicalSerialize(row), 'utf8');
    rowCount += 1;
  }
  hash.update(']');
  return {
    rowCount,
    sha256: hash.digest('hex'),
  };
}

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableFingerprint(db, table) {
  const exists = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  if (!exists) throw verificationError('ERR_PERIODICAL_PROTECTED_TABLE_MISSING', 'protected table missing');
  const primaryKey = db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all()
    .filter(column => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(column => quotedIdentifier(column.name));
  if (primaryKey.length === 0) {
    throw verificationError('ERR_PERIODICAL_PROTECTED_TABLE_KEY_MISSING', 'protected table key missing');
  }
  return fingerprintIterator(db.prepare(`
    SELECT * FROM ${quotedIdentifier(table)}
    ORDER BY ${primaryKey.join(', ')}
  `).iterate());
}

function snapshotProtectedFacts(db) {
  const snapshot = Object.fromEntries(
    PROTECTED_TABLES.map(([name, table]) => [name, tableFingerprint(db, table)]),
  );
  snapshot.passwordDigests = fingerprintIterator(db.prepare(`
    SELECT id, password_hash, password_salt
    FROM users
    ORDER BY id
  `).iterate());
  return snapshot;
}

function verifyIntegrity(db) {
  const quickRows = db.prepare('PRAGMA quick_check').all();
  const quickCheck = quickRows.length === 1 ? Object.values(quickRows[0])[0] : null;
  if (quickCheck !== 'ok') {
    throw verificationError('ERR_PERIODICAL_SQLITE_QUICK_CHECK', 'SQLite quick check failed');
  }
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (foreignKeyViolations !== 0) {
    throw verificationError('ERR_PERIODICAL_SQLITE_FOREIGN_KEYS', 'SQLite foreign key check failed');
  }
  return { quickCheck, foreignKeyViolations };
}

function validSourceSnapshot(row) {
  if (!String(row.source_name || '').trim()) return false;
  if (!['high', 'normal', 'low'].includes(row.editorial_priority)) return false;
  try {
    const labels = JSON.parse(row.source_labels_json);
    return Array.isArray(labels) && labels.every(label => typeof label === 'string');
  } catch {
    return false;
  }
}

function verifyEvidenceProvenance(db) {
  const allowedSourceIds = new Set(SOURCES.map(source => source.id));
  for (const row of db.prepare('SELECT id FROM custom_sources').all()) {
    allowedSourceIds.add(row.id);
  }
  const rows = db.prepare(`
    SELECT
      evidence.source_id,
      evidence.source_name,
      evidence.source_labels_json,
      evidence.editorial_priority,
      entry.id AS entry_id,
      entry.source_id AS entry_source_id
    FROM periodical_event_evidence AS evidence
    LEFT JOIN entries AS entry ON entry.id = evidence.entry_id
  `).all();
  const result = {
    evidenceCount: rows.length,
    missingEntryCount: rows.filter(row => row.entry_id === null).length,
    sourceMismatchCount: rows.filter(row => row.entry_id !== null && row.source_id !== row.entry_source_id).length,
    unknownSourceCount: rows.filter(row => !allowedSourceIds.has(row.source_id)).length,
    invalidSourceSnapshotCount: rows.filter(row => !validSourceSnapshot(row)).length,
  };
  if (Object.entries(result).some(([key, value]) => key !== 'evidenceCount' && value !== 0)) {
    throw verificationError(
      'ERR_PERIODICAL_EVIDENCE_PROVENANCE',
      'periodical evidence provenance check failed',
    );
  }
  return result;
}

function snapshotDurablePeriodicalState(db) {
  return {
    issues: fingerprintIterator(db.prepare(`
      SELECT id, cadence, period_key, status, revision, content_hash
      FROM periodical_issues
      ORDER BY id
    `).iterate()),
    jobs: fingerprintIterator(db.prepare(`
      SELECT
        id, issue_id, status, input_hash, attempt_count, lease_expires_at,
        next_retry_at, error_code, candidate_count, completed_at
      FROM periodical_build_jobs
      ORDER BY id
    `).iterate()),
  };
}

function sameSnapshot(left, right) {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

async function verifyDatabaseCopy(databaseFile) {
  const resolvedFile = path.resolve(String(databaseFile || ''));
  let stat;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    throw verificationError('ERR_PERIODICAL_DATABASE_COPY_MISSING', 'database copy is missing');
  }
  if (!stat.isFile()) {
    throw verificationError('ERR_PERIODICAL_DATABASE_COPY_INVALID', 'database copy must be a regular file');
  }
  const sourceFileState = { size: stat.size, mtimeMs: stat.mtimeMs };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periodicals-shadow-verification-'));
  const workFile = path.join(workDir, 'work.sqlite');
  let source = null;
  let work = null;
  try {
    source = new DatabaseSync(resolvedFile, { readOnly: true });
    source.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
    const integrityBefore = verifyIntegrity(source);
    await backup(source, workFile);
    source.close();
    source = null;

    work = new DatabaseSync(workFile);
    work.exec('PRAGMA foreign_keys = ON;');
    const protectedBefore = snapshotProtectedFacts(work);
    ensurePeriodicalSchema(work);
    const integrityAfterFirstInit = verifyIntegrity(work);
    const protectedAfterFirstInit = snapshotProtectedFacts(work);
    if (!sameSnapshot(protectedBefore, protectedAfterFirstInit)) {
      throw verificationError('ERR_PERIODICAL_MIGRATION_CHANGED_FACTS', 'migration changed protected facts');
    }

    ensurePeriodicalSchema(work);
    const integrityAfterSecondInit = verifyIntegrity(work);
    const protectedAfterSecondInit = snapshotProtectedFacts(work);
    if (!sameSnapshot(protectedBefore, protectedAfterSecondInit)) {
      throw verificationError('ERR_PERIODICAL_MIGRATION_CHANGED_FACTS', 'repeated migration changed protected facts');
    }
    const provenance = verifyEvidenceProvenance(work);
    const durableState = snapshotDurablePeriodicalState(work);
    work.close();
    work = null;

    const finalSourceStat = fs.statSync(resolvedFile);
    const sourceUnchanged = finalSourceStat.size === sourceFileState.size
      && finalSourceStat.mtimeMs === sourceFileState.mtimeMs;
    if (!sourceUnchanged) {
      throw verificationError('ERR_PERIODICAL_SOURCE_COPY_CHANGED', 'source database copy changed');
    }

    return {
      version: 'periodicals-shadow-verification-v1',
      passed: true,
      sourceReadOnly: true,
      sourceUnchanged,
      integrity: {
        before: integrityBefore,
        afterFirstInit: integrityAfterFirstInit,
        afterSecondInit: integrityAfterSecondInit,
      },
      protectedFacts: {
        before: protectedBefore,
        afterFirstInit: protectedAfterFirstInit,
        afterSecondInit: protectedAfterSecondInit,
      },
      provenance,
      durableState,
    };
  } finally {
    if (work) work.close();
    if (source) source.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  snapshotDurablePeriodicalState,
  snapshotProtectedFacts,
  verifyDatabaseCopy,
  verifyEvidenceProvenance,
  verifyIntegrity,
};
