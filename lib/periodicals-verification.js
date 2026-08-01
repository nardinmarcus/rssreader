const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');
const { canonicalSerialize } = require('./content-hashes');
const { computePeriodicalContentHash } = require('./periodical-summary');
const {
  candidateIdentitySnapshot,
  candidateInputContentHash,
  candidateInputSnapshotHash,
  dailyInputIdentity,
  dailySelectionContext,
  ensurePeriodicalSchema,
  finalizationWindowMs,
  independentEvidenceCount,
  normalizedFrozenDailyHistory,
  periodicalBuildJobId,
  readStoredPeriodicalIssue,
  rollupInputIdentity,
  scoreConfigFor,
  scoringHistoryIdentity,
  shanghaiDailyPeriod,
  shanghaiDailyPeriodFromKey,
  shanghaiIsoWeekPeriodFromKey,
  shanghaiNaturalMonthPeriodFromKey,
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
      `CASE typeof(${identifier})
        WHEN 'real' THEN CAST(printf('%!.26g', ${identifier}) AS BLOB)
        ELSE CAST(${identifier} AS BLOB)
      END AS ${quotedIdentifier(`bytes_${index}`)}`,
    ];
  });
  const hash = crypto.createHash('sha256');
  hash.update('sqlite-exact-rows-v2;', 'ascii');
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

function hasExactKeys(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validCandidateInput(input) {
  if (!hasExactKeys(input, ['source', 'entry'])
    || !hasExactKeys(input.source, ['id', 'name', 'category'])
    || !hasExactKeys(input.entry, [
      'title',
      'titleZh',
      'link',
      'canonicalUrl',
      'summaryExcerpt',
      'contentHash',
      'timestampFallback',
    ])) return false;
  return ['id', 'name', 'category'].every(key => typeof input.source[key] === 'string')
    && typeof input.entry.title === 'string'
    && (input.entry.titleZh === null || typeof input.entry.titleZh === 'string')
    && ['link', 'canonicalUrl', 'summaryExcerpt', 'contentHash']
      .every(key => typeof input.entry[key] === 'string')
    && typeof input.entry.timestampFallback === 'boolean';
}

function validateCandidateSnapshot(item, source, entry) {
  return Boolean(item && source && entry)
    && typeof item.entryId === 'string'
    && item.entryId.length > 0
    && typeof item.sourceId === 'string'
    && item.sourceId.length > 0
    && /^[a-f0-9]{64}$/.test(String(item.contentHash || ''))
    && typeof item.effectivePublishedAt === 'number'
    && Number.isFinite(item.effectivePublishedAt)
    && validCandidateInput(item.input)
    && item.sourceId === source.sourceId
    && item.input.source.id === source.sourceId
    && item.input.source.name === source.name
    && item.input.source.category === source.category
    && item.entryId === entry.id
    && item.sourceId === entry.source_id
    && item.contentHash === candidateInputSnapshotHash(item.input);
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

function invalidRollupInputChain() {
  return { valid: false, inputDailies: [] };
}

function canonicalIssuePeriod(issue) {
  if (issue.cadence === 'daily') {
    const period = shanghaiDailyPeriodFromKey(issue.periodKey);
    if (shanghaiDailyPeriod(period.periodStartAt + 1).periodKey !== issue.periodKey) {
      throw new TypeError('invalid daily period key');
    }
    return period;
  }
  if (issue.cadence === 'weekly') return shanghaiIsoWeekPeriodFromKey(issue.periodKey);
  if (issue.cadence === 'monthly') return shanghaiNaturalMonthPeriodFromKey(issue.periodKey);
  throw new TypeError('invalid cadence');
}

function canonicalIssueIdentityValid(document) {
  try {
    const issue = document && document.issue;
    if (!issue) return false;
    const period = canonicalIssuePeriod(issue);
    const revision = Number(issue.revision);
    const volumeNo = Number(issue.volumeNo);
    const coverageStartedAt = Number(issue.coverageStartedAt);
    const lastBuiltAt = issue.lastBuiltAt === null ? null : Number(issue.lastBuiltAt);
    const frozenAt = issue.frozenAt === null ? null : Number(issue.frozenAt);
    const frozen = issue.status === 'frozen';
    const validStatus = issue.cadence === 'daily'
      ? ['open', 'finalizing', 'frozen'].includes(issue.status)
      : ['finalizing', 'frozen'].includes(issue.status);
    const validCoverage = issue.cadence === 'daily'
      ? Number.isFinite(coverageStartedAt)
        && coverageStartedAt >= period.periodStartAt
        && coverageStartedAt < period.periodEndAt
      : coverageStartedAt === period.periodStartAt;
    const validBuildTimes = revision === 0
      ? lastBuiltAt === null && frozenAt === null && !frozen
      : Number.isFinite(lastBuiltAt)
        && (frozen
          ? Number.isFinite(frozenAt)
            && frozenAt === lastBuiltAt
            && frozenAt >= period.periodEndAt
          : frozenAt === null);
    return issue.id === `periodical:${issue.cadence}:${period.periodKey}`
      && issue.timezone === 'Asia/Shanghai'
      && Number(issue.periodStartAt) === period.periodStartAt
      && Number(issue.periodEndAt) === period.periodEndAt
      && Number.isInteger(volumeNo)
      && volumeNo > 0
      && Number.isInteger(revision)
      && revision >= 0
      && validStatus
      && validCoverage
      && validBuildTimes
      && (revision === 0 || issue.cadence === 'daily' || frozen);
  } catch {
    return false;
  }
}

function canonicalIssueIdentityMismatches(documents) {
  const mismatches = new Set();
  const byCadence = new Map();
  for (const [key, document] of documents) {
    if (!canonicalIssueIdentityValid(document)) mismatches.add(key);
    const cadence = document && document.issue && document.issue.cadence;
    if (!['daily', 'weekly', 'monthly'].includes(cadence)) continue;
    const issues = byCadence.get(cadence) || [];
    issues.push(document.issue);
    byCadence.set(cadence, issues);
  }
  for (const issues of byCadence.values()) {
    issues.sort((left, right) => Number(left.periodStartAt) - Number(right.periodStartAt)
      || String(left.id).localeCompare(String(right.id)));
    issues.forEach((issue, index) => {
      if (Number(issue.volumeNo) !== index + 1) mismatches.add(issue.id);
    });
  }
  return mismatches;
}

function frozenDailyHistoryFromDocuments(
  documents,
  currentPeriodKey,
  visibleAt,
  persistedHistory = [],
) {
  const cutoffAt = Number(visibleAt);
  const persistedPeriodKeys = new Set((Array.isArray(persistedHistory) ? persistedHistory : [])
    .map(item => String(item && item.periodKey || ''))
    .filter(Boolean));
  const history = [...documents.values()]
    .filter(document => document && document.issue
      && document.issue.cadence === 'daily'
      && document.issue.status === 'frozen'
      && Number.isFinite(Number(document.issue.frozenAt))
      && (Number(document.issue.frozenAt) < cutoffAt
        || (Number(document.issue.frozenAt) === cutoffAt
          && persistedPeriodKeys.has(document.issue.periodKey)))
      && document.issue.periodKey < currentPeriodKey)
    .map(document => {
      const evidenceByTopic = new Map();
      for (const event of document.events) {
        if (!event.topicKey) continue;
        const evidence = evidenceByTopic.get(event.topicKey) || [];
        evidence.push(...document.evidence
          .filter(item => item.eventId === event.id)
          .map(item => ({
            entryId: item.entryId,
            sourceId: item.sourceId,
            canonicalUrl: item.canonicalUrl || '',
          })));
        evidenceByTopic.set(event.topicKey, evidence);
      }
      return {
        periodKey: document.issue.periodKey,
        status: 'frozen',
        contentHash: document.issue.contentHash,
        topics: [...evidenceByTopic.entries()]
          .map(([topicKey, evidence]) => ({
            topicKey,
            independentSourceCount: independentEvidenceCount(evidence),
          }))
          .sort((left, right) => left.topicKey.localeCompare(right.topicKey)),
      };
    });
  return normalizedFrozenDailyHistory(history, currentPeriodKey);
}

function canonicalSucceededJob(db, document, {
  sourceInputHash,
  inputHash,
  scoreConfig,
  selectionVersion,
  summaryVersion,
  candidateCount,
  sourceCount,
  rollup = false,
} = {}) {
  const issue = document.issue;
  const jobs = db.prepare(`
    SELECT * FROM periodical_build_jobs
    WHERE issue_id = ? AND input_hash = ?
    ORDER BY id
  `).all(issue.id, issue.inputHash);
  if (jobs.length !== 1) return false;
  const job = jobs[0];
  const asOfAt = Number(job.as_of_at);
  const candidateCutoffAt = Number(job.candidate_cutoff_at);
  const periodStartAt = Number(issue.periodStartAt);
  const periodEndAt = Number(issue.periodEndAt);
  const cutoffValid = rollup
    ? asOfAt === periodEndAt && candidateCutoffAt === periodEndAt
    : issue.status === 'frozen'
      ? asOfAt === periodEndAt
        && candidateCutoffAt >= periodEndAt
        && candidateCutoffAt <= periodEndAt + finalizationWindowMs
      : asOfAt >= periodStartAt
        && asOfAt < periodEndAt
        && candidateCutoffAt === asOfAt;
  return job.id === periodicalBuildJobId({
    issueId: issue.id,
    inputHash,
    summaryVersion,
  })
    && job.issue_id === issue.id
    && job.status === 'succeeded'
    && job.source_input_hash === sourceInputHash
    && job.input_hash === inputHash
    && cutoffValid
    && job.selection_version === selectionVersion
    && job.score_config_json === canonicalSerialize(scoreConfig)
    && job.summary_version === summaryVersion
    && Number(job.candidate_count) === candidateCount
    && Number(job.source_count) === sourceCount
    && Number(job.attempt_count) >= 1
    && job.lease_token === null
    && job.lease_expires_at === null
    && job.next_retry_at === null
    && job.error_code === null
    && job.provider === issue.provider
    && job.model === issue.model
    && Number.isFinite(Number(job.completed_at))
    && Number(job.completed_at) === Number(issue.lastBuiltAt);
}

function validateRollupInputChain(document, documents) {
  try {
    const issue = document && document.issue;
    const inputs = document && document.inputs;
    if (!issue || !Array.isArray(inputs) || !(documents instanceof Map)
      || !['weekly', 'monthly'].includes(issue.cadence)) return invalidRollupInputChain();
    const period = issue.cadence === 'weekly'
      ? shanghaiIsoWeekPeriodFromKey(issue.periodKey)
      : shanghaiNaturalMonthPeriodFromKey(issue.periodKey);
    const expectedCount = (period.periodEndAt - period.periodStartAt) / 86_400_000;
    if (!Number.isInteger(expectedCount)
      || expectedCount < 1
      || !canonicalIssueIdentityValid(document)
      || issue.status !== 'frozen'
      || !Number.isInteger(Number(issue.revision))
      || Number(issue.revision) < 1
      || inputs.length !== expectedCount) return invalidRollupInputChain();

    const seenDailyIds = new Set();
    const inputDailies = [];
    const inputStates = [];
    for (let displayOrder = 0; displayOrder < expectedCount; displayOrder += 1) {
      const expectedPeriod = shanghaiDailyPeriod(period.periodStartAt + (displayOrder * 86_400_000));
      const expectedDailyId = `periodical:daily:${expectedPeriod.periodKey}`;
      const input = inputs[displayOrder];
      if (!input
        || input.issueId !== issue.id
        || Number(input.displayOrder) !== displayOrder
        || input.dailyIssueId !== expectedDailyId
        || seenDailyIds.has(input.dailyIssueId)) return invalidRollupInputChain();
      seenDailyIds.add(input.dailyIssueId);
      const daily = documents.get(input.dailyIssueId);
      if (!daily || !daily.issue
        || !canonicalIssueIdentityValid(daily)
        || daily.issue.id !== expectedDailyId
        || daily.issue.cadence !== 'daily'
        || daily.issue.periodKey !== expectedPeriod.periodKey
        || daily.issue.timezone !== 'Asia/Shanghai'
        || Number(daily.issue.periodStartAt) !== expectedPeriod.periodStartAt
        || Number(daily.issue.periodEndAt) !== expectedPeriod.periodEndAt
        || daily.issue.status !== 'frozen'
        || !Number.isInteger(Number(daily.issue.revision))
        || Number(daily.issue.revision) < 1
        || !/^[a-f0-9]{64}$/.test(String(daily.issue.contentHash || ''))
        || input.dailyContentHash !== daily.issue.contentHash
        || computePeriodicalContentHash(daily) !== daily.issue.contentHash) {
        return invalidRollupInputChain();
      }
      inputDailies.push(daily);
      inputStates.push({
        displayOrder,
        expectedDailyIssueId: expectedDailyId,
        expectedPeriodKey: expectedPeriod.periodKey,
        actualIssueId: daily.issue.id,
        actualCadence: daily.issue.cadence,
        actualPeriodKey: daily.issue.periodKey,
        actualPeriodStartAt: Number(daily.issue.periodStartAt),
        actualPeriodEndAt: Number(daily.issue.periodEndAt),
        actualStatus: daily.issue.status,
        actualRevision: Number(daily.issue.revision),
        dailyContentHash: daily.issue.contentHash,
        validationCode: null,
      });
    }
    const identity = rollupInputIdentity({
      cadence: issue.cadence,
      periodKey: issue.periodKey,
      inputStates,
    });
    if (issue.selectionVersion !== identity.selectionVersion
      || issue.summaryVersion !== identity.summaryVersion
      || issue.sourceInputHash !== identity.sourceInputHash
      || issue.inputHash !== identity.inputHash
      || canonicalSerialize(issue.selectionContext) !== canonicalSerialize(identity.selectionContext)) {
      return invalidRollupInputChain();
    }
    return {
      valid: true,
      inputDailies,
      identity,
      candidateCount: inputDailies.reduce(
        (count, daily) => count + daily.events.length,
        0,
      ),
      sourceCount: new Set(inputDailies.flatMap(daily => (
        daily.evidence.map(item => item.sourceId)
      ))).size,
    };
  } catch {
    return invalidRollupInputChain();
  }
}

function revisionZeroHasDurableState(db, issue) {
  const child = db.prepare(`
    SELECT (
      EXISTS(SELECT 1 FROM periodical_themes WHERE issue_id = ?)
      OR EXISTS(SELECT 1 FROM periodical_events WHERE issue_id = ?)
      OR EXISTS(SELECT 1 FROM periodical_issue_inputs WHERE issue_id = ?)
    ) AS present
  `).get(issue.id, issue.id, issue.id);
  const succeededJob = db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM periodical_build_jobs
      WHERE issue_id = ? AND status = 'succeeded'
    ) AS present
  `).get(issue.id);
  let selectionContextEmpty = false;
  try {
    const context = JSON.parse(issue.selection_context_json);
    selectionContextEmpty = hasExactKeys(context, []);
  } catch {
    selectionContextEmpty = false;
  }
  return Boolean(child.present)
    || Boolean(succeededJob.present)
    || String(issue.content_hash || '') !== ''
    || String(issue.input_hash || '') !== ''
    || String(issue.source_input_hash || '') !== ''
    || !selectionContextEmpty;
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
    issueIdentityMismatchCount: 0,
    issueContentHashMismatchCount: 0,
    sourceInputHashMismatchCount: 0,
    inputHashMismatchCount: 0,
    selectionContextMismatchCount: 0,
    buildIdentityMismatchCount: 0,
    candidateSnapshotMismatchCount: 0,
    rollupSnapshotMismatchCount: 0,
    revisionZeroStateMismatchCount: 0,
  };

  const documents = new Map();
  const issueRows = db.prepare(`
    SELECT * FROM periodical_issues
    ORDER BY cadence, period_key, id
  `).all();
  const unreadableIssueIds = new Set();
  for (const issue of issueRows) {
    try {
      const document = readStoredPeriodicalIssue(db, issue);
      documents.set(issue.id, document);
      if (Number(issue.revision) < 1) {
        if (revisionZeroHasDurableState(db, issue)) {
          result.revisionZeroStateMismatchCount += 1;
        }
        continue;
      }
      if (computePeriodicalContentHash(document) !== issue.content_hash) {
        result.issueContentHashMismatchCount += 1;
      }
    } catch {
      unreadableIssueIds.add(issue.id);
      result.issueContentHashMismatchCount += 1;
    }
  }
  const identityMismatches = canonicalIssueIdentityMismatches(documents);
  for (const issueId of unreadableIssueIds) identityMismatches.add(issueId);
  result.issueIdentityMismatchCount = identityMismatches.size;

  const entryById = new Map(db.prepare(`
    SELECT id, source_id
    FROM entries
    ORDER BY id
  `).all().map(entry => [entry.id, entry]));

  for (const document of documents.values()) {
    if (document.issue.cadence !== 'daily' || Number(document.issue.revision) < 1) continue;
    const context = document.issue.selectionContext;
    const candidates = context && context.candidateSnapshot;
    const sources = context && context.sourceSnapshot;
    const sourceIds = new Set();
    const candidateIds = new Set();
    let snapshotsValid = Array.isArray(candidates) && Array.isArray(sources);
    if (Array.isArray(sources)) {
      for (const source of sources) {
        if (!validBuildSourceSnapshot(source) || sourceIds.has(source.sourceId)) {
          snapshotsValid = false;
          continue;
        }
        sourceIds.add(source.sourceId);
        if (!allowedSourceIds.has(source.sourceId)) result.unknownSourceCount += 1;
      }
    }
    const sourceById = new Map((Array.isArray(sources) ? sources : [])
      .map(source => [source.sourceId, source]));
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        if (candidateIds.has(candidate && candidate.entryId)
          || !validateCandidateSnapshot(
            candidate,
            sourceById.get(candidate && candidate.sourceId),
            entryById.get(candidate && candidate.entryId),
          )) snapshotsValid = false;
        else candidateIds.add(candidate.entryId);
      }
    }
    snapshotsValid = snapshotsValid
      && Number(context.candidateCount) === candidates.length
      && Number(context.eligibleSourceCount) === sources.length
      && canonicalSerialize(candidates.map(candidate => candidate.entryId))
        === canonicalSerialize(candidates.map(candidate => candidate.entryId).sort())
      && canonicalSerialize(sources.map(source => source.sourceId))
        === canonicalSerialize(sources.map(source => source.sourceId).sort());
    if (!snapshotsValid) {
      result.sourceInputHashMismatchCount += 1;
      continue;
    }

    const behaviorSignalEnabled = Boolean(context.scoreConfig
      && context.scoreConfig.behavior
      && context.scoreConfig.behavior.enabled);
    const scoreConfig = scoreConfigFor(behaviorSignalEnabled);
    const expectedSourceInputHash = sourceInputIdentity({
      periodKey: document.issue.periodKey,
      candidates: candidates.map(candidateIdentitySnapshot),
      sources: sources.map(sourceIdentitySnapshot),
      behaviorSignalEnabled,
    });
    if (expectedSourceInputHash !== document.issue.sourceInputHash) {
      result.sourceInputHashMismatchCount += 1;
    }

    const matchingJobs = db.prepare(`
      SELECT as_of_at, candidate_cutoff_at
      FROM periodical_build_jobs
      WHERE issue_id = ? AND input_hash = ?
      ORDER BY id
    `).all(document.issue.id, document.issue.inputHash);
    const expectedHistory = matchingJobs.length === 1
      ? frozenDailyHistoryFromDocuments(
          documents,
          document.issue.periodKey,
          Number(matchingJobs[0].candidate_cutoff_at),
          context.frozenDailyHistory,
        )
      : null;
    if (expectedHistory) {
      const expectedContext = dailySelectionContext({
        scoreConfig,
        candidateSnapshot: candidates,
        sourceSnapshot: sources,
        frozenDailyHistory: expectedHistory,
      });
      if (canonicalSerialize(context) !== canonicalSerialize(expectedContext)) {
        result.selectionContextMismatchCount += 1;
      }
    }
    const expectedIdentity = matchingJobs.length === 1
      ? dailyInputIdentity({
          sourceInputHash: expectedSourceInputHash,
          asOfAt: Number(matchingJobs[0].as_of_at),
          scoringHistoryHash: scoringHistoryIdentity(expectedHistory),
          scoreConfig,
        })
      : null;
    if (!expectedIdentity
      || expectedIdentity.inputHash !== document.issue.inputHash
      || expectedIdentity.selectionVersion !== document.issue.selectionVersion
      || expectedIdentity.summaryVersion !== document.issue.summaryVersion) {
      result.inputHashMismatchCount += 1;
    }
    if (!expectedIdentity || !canonicalSucceededJob(db, document, {
      sourceInputHash: expectedSourceInputHash,
      inputHash: expectedIdentity.inputHash,
      scoreConfig,
      selectionVersion: expectedIdentity.selectionVersion,
      summaryVersion: expectedIdentity.summaryVersion,
      candidateCount: candidates.length,
      sourceCount: sources.length,
    })) {
      result.buildIdentityMismatchCount += 1;
    }

    const candidateById = new Map(candidates.map(candidate => [candidate.entryId, candidate]));
    for (const evidence of document.evidence) {
      const source = sourceById.get(evidence.sourceId);
      const candidate = candidateById.get(evidence.entryId);
      const sourceMatches = source
        && evidence.sourceName === source.name
        && evidence.editorialPriority === source.editorialPriority
        && canonicalSerialize(evidence.sourceLabels) === canonicalSerialize(source.labels);
      const candidateMatches = candidate
        && candidate.sourceId === evidence.sourceId
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
    if (document.issue.cadence === 'daily' || Number(document.issue.revision) < 1) continue;
    const chain = validateRollupInputChain(document, documents);
    if (!chain.valid) {
      result.rollupSnapshotMismatchCount += 1;
      continue;
    }
    if (!canonicalSucceededJob(db, document, {
      sourceInputHash: chain.identity.sourceInputHash,
      inputHash: chain.identity.inputHash,
      scoreConfig: chain.identity.selectionContext.scoreConfig,
      selectionVersion: chain.identity.selectionVersion,
      summaryVersion: chain.identity.summaryVersion,
      candidateCount: chain.candidateCount,
      sourceCount: chain.sourceCount,
      rollup: true,
    })) {
      result.buildIdentityMismatchCount += 1;
    }
    const inputDailies = chain.inputDailies;
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
      SELECT
        id, cadence, period_key, volume_no, timezone,
        period_start_at, period_end_at, coverage_started_at,
        status, revision, overview,
        selection_version, summary_version, source_input_hash,
        selection_context_json, input_hash, content_hash,
        summary_status, provider, model,
        last_built_at, frozen_at, created_at, updated_at
      FROM periodical_issues
      ORDER BY id
    `).iterate()),
    jobs: fingerprintIterator(db.prepare(`
      SELECT
        id, issue_id, source_input_hash, input_hash,
        as_of_at, candidate_cutoff_at,
        selection_version, score_config_json, summary_version,
        trigger_reason, status, attempt_count,
        lease_token, lease_expires_at, next_retry_at,
        provider, model, error_code, candidate_count, source_count,
        created_at, updated_at, completed_at
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
      version: 'periodicals-shadow-verification-v4',
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
  canonicalIssueIdentityValid,
  canonicalIssueIdentityMismatches,
  snapshotDurablePeriodicalState,
  snapshotProtectedFacts,
  validateCandidateSnapshot,
  validateRollupInputChain,
  verifyDatabaseCopy,
  verifyEvidenceProvenance,
  verifyIntegrity,
};
