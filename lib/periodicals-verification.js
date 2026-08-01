const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');
const { canonicalSerialize } = require('./content-hashes');
const { computePeriodicalContentHash } = require('./periodical-summary');
const {
  candidateInputContentHash,
  ensurePeriodicalSchema,
  readStoredPeriodicalIssue,
  sourceIdentitySnapshot,
  sourceInputIdentity,
} = require('./periodicals');
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

function updateExactFrame(hash, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : (value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(String(value), 'utf8'));
  hash.update(`${bytes.length}:`, 'ascii');
  hash.update(bytes);
  hash.update(';', 'ascii');
}

function exactSelectedFingerprint(db, table, columns, orderBy) {
  const projections = columns.flatMap((column, index) => {
    const identifier = quotedIdentifier(column);
    return [
      `typeof(${identifier}) AS ${quotedIdentifier(`type_${index}`)}`,
      `CAST(${identifier} AS BLOB) AS ${quotedIdentifier(`bytes_${index}`)}`,
    ];
  });
  const hash = crypto.createHash('sha256');
  hash.update('sqlite-exact-rows-v1;', 'ascii');
  for (const column of columns) updateExactFrame(hash, column);
  let rowCount = 0;
  for (const row of db.prepare(`
    SELECT ${projections.join(', ')}
    FROM ${quotedIdentifier(table)}
    ORDER BY ${orderBy.map(quotedIdentifier).join(', ')}
  `).iterate()) {
    hash.update('row;', 'ascii');
    for (let index = 0; index < columns.length; index += 1) {
      updateExactFrame(hash, row[`type_${index}`]);
      const value = row[`bytes_${index}`];
      if (value === null) hash.update('null;', 'ascii');
      else updateExactFrame(hash, value);
    }
    rowCount += 1;
  }
  return { rowCount, sha256: hash.digest('hex') };
}

function tableFingerprint(db, table) {
  const exists = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  if (!exists) throw verificationError('ERR_PERIODICAL_PROTECTED_TABLE_MISSING', 'protected table missing');
  const tableInfo = db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all()
    .sort((left, right) => Number(left.cid) - Number(right.cid));
  const primaryKey = tableInfo
    .filter(column => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(column => column.name);
  if (primaryKey.length === 0) {
    throw verificationError('ERR_PERIODICAL_PROTECTED_TABLE_KEY_MISSING', 'protected table key missing');
  }
  return exactSelectedFingerprint(
    db,
    table,
    tableInfo.map(column => column.name),
    primaryKey,
  );
}

function snapshotProtectedFacts(db) {
  const snapshot = Object.fromEntries(
    PROTECTED_TABLES.map(([name, table]) => [name, tableFingerprint(db, table)]),
  );
  snapshot.passwordDigests = exactSelectedFingerprint(
    db,
    'users',
    ['id', 'password_hash', 'password_salt'],
    ['id'],
  );
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

function rollupEvidenceSnapshot(evidence) {
  return {
    sourceId: evidence.sourceId,
    sourceName: evidence.sourceName,
    sourceLabels: evidence.sourceLabels,
    editorialPriority: evidence.editorialPriority,
    entryTitle: evidence.entryTitle,
    entryTitleZh: evidence.entryTitleZh,
    entryLink: evidence.entryLink,
    canonicalUrl: evidence.canonicalUrl,
    summaryExcerpt: evidence.summaryExcerpt,
    contentHash: evidence.contentHash,
    effectivePublishedAt: evidence.effectivePublishedAt,
    timestampFallback: evidence.timestampFallback,
  };
}

function validCandidateSnapshot(item) {
  return Boolean(item)
    && typeof item.entryId === 'string'
    && item.entryId.length > 0
    && /^[a-f0-9]{64}$/.test(String(item.contentHash || ''))
    && Number.isFinite(Number(item.effectivePublishedAt));
}

function validBuildSourceSnapshot(item) {
  return Boolean(item)
    && typeof item.sourceId === 'string'
    && item.sourceId.length > 0
    && typeof item.name === 'string'
    && item.name.trim().length > 0
    && typeof item.category === 'string'
    && item.enabled === true
    && ['high', 'normal', 'low'].includes(item.editorialPriority)
    && Array.isArray(item.labels)
    && item.labels.every(label => typeof label === 'string');
}

function verifyEvidenceProvenance(db) {
  const allowedSourceIds = new Set(SOURCES.map(source => source.id));
  for (const row of db.prepare('SELECT id FROM custom_sources').all()) {
    allowedSourceIds.add(row.id);
  }
  const rows = db.prepare(`
    SELECT
      event.issue_id,
      issue.cadence,
      evidence.source_id,
      evidence.source_name,
      evidence.source_labels_json,
      evidence.editorial_priority,
      entry.id AS entry_id,
      entry.source_id AS entry_source_id
    FROM periodical_event_evidence AS evidence
    INNER JOIN periodical_events AS event ON event.id = evidence.event_id
    INNER JOIN periodical_issues AS issue ON issue.id = event.issue_id
    LEFT JOIN entries AS entry ON entry.id = evidence.entry_id
  `).all();
  const result = {
    evidenceCount: rows.length,
    missingEntryCount: rows.filter(row => row.entry_id === null).length,
    sourceMismatchCount: rows.filter(row => row.entry_id !== null && row.source_id !== row.entry_source_id).length,
    unknownSourceCount: rows.filter(row => !allowedSourceIds.has(row.source_id)).length,
    invalidSourceSnapshotCount: rows.filter(row => !validSourceSnapshot(row)).length,
    issueContentHashMismatchCount: 0,
    sourceInputHashMismatchCount: 0,
    candidateSnapshotMismatchCount: 0,
    rollupSnapshotMismatchCount: 0,
  };

  const documents = new Map();
  const issueRows = db.prepare(`
    SELECT * FROM periodical_issues
    ORDER BY cadence, period_key, id
  `).all();
  for (const issue of issueRows) {
    if (Number(issue.revision) < 1) continue;
    try {
      const document = readStoredPeriodicalIssue(db, issue);
      documents.set(issue.id, document);
      if (computePeriodicalContentHash(document) !== issue.content_hash) {
        result.issueContentHashMismatchCount += 1;
      }
    } catch {
      result.issueContentHashMismatchCount += 1;
    }
  }

  for (const document of documents.values()) {
    if (document.issue.cadence !== 'daily') continue;
    const context = document.issue.selectionContext;
    const candidates = context && context.candidateSnapshot;
    const sources = context && context.sourceSnapshot;
    const sourceIds = new Set();
    const candidateIds = new Set();
    const snapshotsValid = Array.isArray(candidates)
      && Array.isArray(sources)
      && candidates.every(candidate => {
        if (!validCandidateSnapshot(candidate) || candidateIds.has(candidate.entryId)) return false;
        candidateIds.add(candidate.entryId);
        return true;
      })
      && sources.every(source => {
        if (!validBuildSourceSnapshot(source) || sourceIds.has(source.sourceId)) return false;
        sourceIds.add(source.sourceId);
        if (!allowedSourceIds.has(source.sourceId)) result.unknownSourceCount += 1;
        return true;
      })
      && Number(context.candidateCount) === candidates.length
      && Number(context.eligibleSourceCount) === sources.length;
    if (!snapshotsValid) {
      result.sourceInputHashMismatchCount += 1;
      continue;
    }

    const expectedSourceInputHash = sourceInputIdentity({
      periodKey: document.issue.periodKey,
      candidates,
      sources: sources.map(sourceIdentitySnapshot),
      behaviorSignalEnabled: Boolean(context.scoreConfig
        && context.scoreConfig.behavior
        && context.scoreConfig.behavior.enabled),
    });
    if (expectedSourceInputHash !== document.issue.sourceInputHash) {
      result.sourceInputHashMismatchCount += 1;
    }

    const sourceById = new Map(sources.map(source => [source.sourceId, source]));
    const candidateById = new Map(candidates.map(candidate => [candidate.entryId, candidate]));
    for (const evidence of document.evidence) {
      const source = sourceById.get(evidence.sourceId);
      const candidate = candidateById.get(evidence.entryId);
      const sourceMatches = source
        && evidence.sourceName === source.name
        && evidence.editorialPriority === source.editorialPriority
        && canonicalSerialize(evidence.sourceLabels) === canonicalSerialize(source.labels);
      const candidateMatches = candidate
        && Number(candidate.effectivePublishedAt) === Number(evidence.effectivePublishedAt)
        && candidate.contentHash === candidateInputContentHash({
          source: { category: source && source.category },
          evidence,
        });
      if (!sourceMatches) result.invalidSourceSnapshotCount += 1;
      if (!candidateMatches) result.candidateSnapshotMismatchCount += 1;
    }
  }

  for (const document of documents.values()) {
    if (document.issue.cadence === 'daily') continue;
    const inputDailies = [];
    for (const input of document.inputs) {
      const daily = documents.get(input.dailyIssueId);
      if (!daily
        || daily.issue.cadence !== 'daily'
        || daily.issue.status !== 'frozen'
        || daily.issue.contentHash !== input.dailyContentHash) {
        result.rollupSnapshotMismatchCount += 1;
      } else {
        inputDailies.push(daily);
      }
    }
    const dailyEvidence = inputDailies.flatMap(daily => daily.evidence)
      .map(evidence => ({
        entryId: evidence.entryId,
        snapshot: canonicalSerialize(rollupEvidenceSnapshot(evidence)),
      }));
    for (const evidence of document.evidence) {
      const snapshot = canonicalSerialize(rollupEvidenceSnapshot(evidence));
      if (!dailyEvidence.some(item => item.entryId === evidence.entryId && item.snapshot === snapshot)) {
        result.rollupSnapshotMismatchCount += 1;
      }
    }
  }

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

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('hex');
}

function fileMetadata(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return {
      present: true,
      bytes: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false };
    throw error;
  }
}

function sourceMetadata(databaseFile) {
  const wal = fileMetadata(`${databaseFile}-wal`);
  return {
    main: fileMetadata(databaseFile),
    wal: wal.present && wal.bytes !== '0' ? wal : { present: false },
  };
}

function sqliteDataVersion(db) {
  const row = db.prepare('PRAGMA data_version').get();
  return Number(Object.values(row)[0]);
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

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periodicals-shadow-verification-'));
  fs.chmodSync(workDir, 0o700);
  const snapshotFile = path.join(workDir, 'snapshot.sqlite');
  const workFile = path.join(workDir, 'work.sqlite');
  let source = null;
  let snapshot = null;
  let work = null;
  try {
    const metadataBefore = sourceMetadata(resolvedFile);
    source = new DatabaseSync(resolvedFile, { readOnly: true });
    source.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const dataVersionBefore = sqliteDataVersion(source);
    await backup(source, snapshotFile);
    const dataVersionAfter = sqliteDataVersion(source);
    const metadataAfterBackup = sourceMetadata(resolvedFile);
    source.close();
    source = null;
    const metadataAfterClose = sourceMetadata(resolvedFile);
    const sourceUnchanged = dataVersionBefore === dataVersionAfter
      && sameSnapshot(metadataBefore, metadataAfterBackup)
      && sameSnapshot(metadataBefore, metadataAfterClose);
    if (!sourceUnchanged) {
      throw verificationError('ERR_PERIODICAL_SOURCE_COPY_CHANGED', 'source database copy changed');
    }

    fs.chmodSync(snapshotFile, 0o400);
    const snapshotSha256Before = await hashFile(snapshotFile);
    const snapshotStat = fs.statSync(snapshotFile);
    snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
    snapshot.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
    const integrityBefore = verifyIntegrity(snapshot);
    const protectedBefore = snapshotProtectedFacts(snapshot);
    snapshot.close();
    snapshot = null;
    const snapshotSha256After = await hashFile(snapshotFile);
    if (snapshotSha256Before !== snapshotSha256After) {
      throw verificationError('ERR_PERIODICAL_DATABASE_SNAPSHOT_CHANGED', 'database snapshot changed');
    }

    fs.copyFileSync(snapshotFile, workFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(workFile, 0o600);
    work = new DatabaseSync(workFile);
    work.exec('PRAGMA foreign_keys = ON;');
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

    return {
      version: 'periodicals-shadow-verification-v2',
      passed: true,
      sourceReadOnly: true,
      sourceUnchanged,
      databaseSnapshot: {
        sha256: snapshotSha256After,
        bytes: snapshotStat.size,
        readOnly: true,
      },
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
    if (snapshot) snapshot.close();
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
