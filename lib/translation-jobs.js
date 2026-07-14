const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { canonicalSerialize } = require('./content-hashes');
const { resolveDataPaths } = require('./data-paths');
const {
  buildTranslationInputV2,
  validateTranslationResponse,
  translationPipelineHash,
} = require('./translation-contract');
const { renderTranslation } = require('./translation-renderer');
const store = require('./store');

const { databaseFile } = resolveDataPaths();
const db = new DatabaseSync(databaseFile);
db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

const ENQUEUE_FIELDS = new Set([
  'entryId', 'documentId', 'ownerType', 'userId', 'author', 'sourceHash', 'pipelineHash',
  'generationHash', 'provider', 'model', 'tuning', 'priority', 'chunks',
]);
const TUNING_FIELDS = new Set(['temperature', 'maxTokens']);
const SECRET_KEY = /(?:api.?key|authorization|access.?token|secret)/i;
const DEFAULT_LEASE_MS = 240_000;

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw inputError(`${label} is required`);
  return normalized;
}

function containsSecret(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => SECRET_KEY.test(key) || containsSecret(item, seen));
}

function normalizeTuning(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError('tuning must be an object');
  }
  const unknown = Object.keys(value).find(key => !TUNING_FIELDS.has(key));
  if (unknown) throw inputError(`unsupported tuning field ${unknown}`);
  const tuning = {};
  if (Object.prototype.hasOwnProperty.call(value, 'temperature')) {
    if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)) {
      throw inputError('temperature must be a finite number');
    }
    if (value.temperature < 0 || value.temperature > 2) {
      throw inputError('temperature must be between 0 and 2');
    }
    tuning.temperature = value.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'maxTokens')) {
    if (!Number.isInteger(value.maxTokens) || value.maxTokens <= 0) {
      throw inputError('maxTokens must be a positive integer');
    }
    tuning.maxTokens = value.maxTokens;
  }
  return tuning;
}

function segmentsFromAst(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'text') out.push(node);
    if (node.alt && node.alt.type === 'text') out.push(node.alt);
    if (Array.isArray(node.children)) segmentsFromAst(node.children, out);
  }
  return out;
}

function normalizeChunks(chunks, document) {
  if (!Array.isArray(chunks) || !chunks.length) throw inputError('chunks are required');
  const input = buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: segmentsFromAst(document.ast),
  });
  const expected = new Set(input.segments.map(segment => segment.id));
  const seen = new Set();
  const normalized = chunks.map((chunk, chunkIndex) => {
    const segmentIds = Array.isArray(chunk && chunk.segmentIds)
      ? chunk.segmentIds.map(id => required(id, `chunk ${chunkIndex} segment id`))
      : [];
    if (!segmentIds.length) throw inputError(`chunk ${chunkIndex} segmentIds are required`);
    for (const segmentId of segmentIds) {
      if (!expected.has(segmentId)) throw inputError(`chunk ${chunkIndex} has unknown segment ${segmentId}`);
      if (seen.has(segmentId)) throw inputError(`duplicate translation segment ${segmentId}`);
      seen.add(segmentId);
    }
    return {
      chunkIndex,
      segmentIds,
      chunkHash: required(chunk.chunkHash, `chunk ${chunkIndex} hash`),
    };
  });
  if (seen.size !== expected.size) throw inputError('chunks must cover every translation segment');
  return normalized;
}

function normalizeJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    entryId: row.entry_id,
    documentId: row.document_id,
    ownerType: row.owner_type,
    userId: row.user_id || null,
    author: row.author,
    sourceHash: row.source_hash,
    pipelineHash: row.pipeline_hash,
    generationHash: row.generation_hash,
    provider: row.provider,
    model: row.model,
    tuning: JSON.parse(row.tuning_json || '{}'),
    priority: row.priority,
    status: row.status,
    attemptCount: row.attempt_count,
    leaseExpiresAt: row.lease_expires_at || null,
    nextRetryAt: row.next_retry_at || null,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
}

function normalizeChunkRow(row) {
  return {
    chunkIndex: row.chunk_index,
    segmentIds: JSON.parse(row.segment_ids_json || '[]'),
    chunkHash: row.chunk_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
  };
}

function getStatus(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const job = normalizeJobRow(db.prepare('SELECT * FROM translation_jobs WHERE id = ?').get(id));
  if (!job) return null;
  const chunks = db.prepare(`
    SELECT * FROM translation_job_chunks WHERE job_id = ? ORDER BY chunk_index ASC
  `).all(id).map(normalizeChunkRow);
  return { ...job, chunks };
}

function enqueue(input = {}) {
  if (containsSecret(input)) throw inputError('secret credentials are not accepted by translation jobs');
  const unknown = Object.keys(input).find(key => !ENQUEUE_FIELDS.has(key));
  if (unknown) throw inputError(`unsupported enqueue field ${unknown}`);
  const documentId = required(input.documentId, 'documentId');
  const document = store.getArticleDocument(documentId);
  if (!document) throw inputError('article document not found');
  const entryId = required(input.entryId, 'entryId');
  if (document.entryId !== entryId) throw inputError('article document does not belong to entry');
  const sourceHash = required(input.sourceHash, 'sourceHash');
  if (document.sourceHash !== sourceHash) throw inputError('sourceHash does not match article document');
  const ownerType = required(input.ownerType, 'ownerType');
  const userId = String(input.userId || '').trim() || null;
  if (!['system', 'user'].includes(ownerType) || (ownerType === 'system' && userId) || (ownerType === 'user' && !userId)) {
    throw inputError('invalid translation job ownership');
  }
  const chunks = normalizeChunks(input.chunks, document);
  const normalized = {
    id: `translation-job-${crypto.randomUUID()}`,
    entryId,
    documentId,
    ownerType,
    userId,
    author: required(input.author, 'author'),
    sourceHash,
    pipelineHash: required(input.pipelineHash, 'pipelineHash'),
    generationHash: required(input.generationHash, 'generationHash'),
    provider: required(input.provider, 'provider'),
    model: required(input.model, 'model'),
    tuning: normalizeTuning(input.tuning),
    priority: Number.isInteger(input.priority) ? input.priority : 0,
  };
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      INSERT INTO translation_jobs (
        id, entry_id, document_id, owner_type, user_id, author, source_hash, pipeline_hash,
        generation_hash, provider, model, tuning_json, priority, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(generation_hash) DO NOTHING
    `).run(
      normalized.id, normalized.entryId, normalized.documentId, normalized.ownerType, normalized.userId,
      normalized.author, normalized.sourceHash, normalized.pipelineHash, normalized.generationHash,
      normalized.provider, normalized.model, canonicalSerialize(normalized.tuning), normalized.priority, now, now,
    );
    const row = db.prepare('SELECT * FROM translation_jobs WHERE generation_hash = ?').get(normalized.generationHash);
    if (Number(result.changes) === 0) {
      const immutableMatches = row.entry_id === normalized.entryId
        && row.document_id === normalized.documentId
        && row.owner_type === normalized.ownerType
        && (row.user_id || null) === normalized.userId
        && row.author === normalized.author
        && row.source_hash === normalized.sourceHash
        && row.pipeline_hash === normalized.pipelineHash
        && row.provider === normalized.provider
        && row.model === normalized.model
        && row.tuning_json === canonicalSerialize(normalized.tuning);
      const existingChunks = db.prepare(`
        SELECT chunk_index, segment_ids_json, chunk_hash
        FROM translation_job_chunks
        WHERE job_id = ?
        ORDER BY chunk_index ASC
      `).all(row.id);
      const chunksMatch = existingChunks.length === chunks.length && chunks.every((chunk, index) => {
        const existing = existingChunks[index];
        return existing.chunk_index === chunk.chunkIndex
          && existing.segment_ids_json === canonicalSerialize(chunk.segmentIds)
          && existing.chunk_hash === chunk.chunkHash;
      });
      if (!immutableMatches || !chunksMatch) {
        throw inputError('generationHash conflicts with a different translation job');
      }
      if (['failed', 'superseded'].includes(row.status)) {
        const current = db.prepare(`
          SELECT 1
          FROM entries e
          JOIN article_documents d ON d.id = e.current_document_id
          WHERE e.id = ?
            AND e.current_document_id = ?
            AND d.source_hash = ?
            AND NOT EXISTS (
              SELECT 1 FROM translation_versions v WHERE v.generation_hash = ?
            )
        `).get(
          normalized.entryId,
          normalized.documentId,
          normalized.sourceHash,
          normalized.generationHash,
        );
        if (current) {
          db.prepare(`
            UPDATE translation_jobs
            SET status = 'queued', attempt_count = 0,
                lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL,
                error_code = NULL, error_message = NULL, completed_at = NULL,
                priority = MAX(priority, ?), updated_at = ?
            WHERE id = ? AND status IN ('failed', 'superseded')
          `).run(normalized.priority, now, row.id);
          db.prepare(`
            UPDATE translation_job_chunks
            SET status = 'pending', attempt_count = 0, result_json = NULL,
                error_code = NULL, error_message = NULL, updated_at = ?
            WHERE job_id = ? AND status <> 'succeeded'
          `).run(now, row.id);
        }
      }
    }
    if (Number(result.changes) > 0) {
      const insertChunk = db.prepare(`
        INSERT INTO translation_job_chunks (
          job_id, chunk_index, segment_ids_json, chunk_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `);
      for (const chunk of chunks) {
        insertChunk.run(row.id, chunk.chunkIndex, canonicalSerialize(chunk.segmentIds), chunk.chunkHash, now, now);
      }
    }
    db.exec('COMMIT');
    return { ...getStatus(row.id), created: Number(result.changes) > 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function promote(jobId, { priority = 100 } = {}) {
  const id = required(jobId, 'jobId');
  if (!Number.isInteger(priority)) throw inputError('priority must be an integer');
  db.prepare(`
    UPDATE translation_jobs
    SET priority = MAX(priority, ?), updated_at = ?
    WHERE id = ? AND status IN ('queued', 'retry_wait')
  `).run(priority, Date.now(), id);
  return getStatus(id);
}

function resolvedNow(value) {
  const now = typeof value === 'function' ? value() : value;
  return Number.isFinite(now) ? Number(now) : Date.now();
}

function claimNext(now, leaseMs) {
  const leaseToken = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`
      SELECT id
      FROM translation_jobs
      WHERE status = 'queued'
         OR (status = 'retry_wait' AND COALESCE(next_retry_at, 0) <= ?)
         OR (status = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    `).get(now, now);
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    db.prepare(`
      UPDATE translation_jobs
      SET status = 'running', attempt_count = attempt_count + 1,
          lease_token = ?, lease_expires_at = ?, next_retry_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(leaseToken, now + leaseMs, now, row.id);
    db.prepare(`
      UPDATE translation_job_chunks
      SET status = 'pending', updated_at = ?
      WHERE job_id = ? AND status IN ('running', 'retry_wait')
        AND EXISTS (
          SELECT 1 FROM translation_jobs j
          WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ?
        )
    `).run(now, row.id, leaseToken);
    db.exec('COMMIT');
    return { jobId: row.id, leaseToken };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function leaseGuard(jobId, leaseToken) {
  return db.prepare(`SELECT 1 FROM translation_jobs WHERE id = ? AND lease_token = ? AND status = 'running'`)
    .get(jobId, leaseToken);
}

function renewLease(jobId, leaseToken, now, leaseMs) {
  return Number(db.prepare(`
    UPDATE translation_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running'
  `).run(now + leaseMs, now, jobId, leaseToken).changes) === 1;
}

function supersedeObsoletePipeline(jobId, leaseToken, now) {
  return Number(db.prepare(`
    UPDATE translation_jobs
    SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, error_code = 'ERR_TRANSLATION_PIPELINE_SUPERSEDED',
        error_message = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running'
  `).run(now, now, jobId, leaseToken).changes) === 1;
}

function failJob(jobId, chunkIndex, leaseToken, error, now) {
  if (chunkIndex >= 0) {
    db.prepare(`
      UPDATE translation_job_chunks
      SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
      WHERE job_id = ? AND chunk_index = ?
        AND EXISTS (
          SELECT 1 FROM translation_jobs j
          WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ? AND j.status = 'running'
        )
    `).run(
      String(error && error.code || 'ERR_TRANSLATION_JOB_FAILED'),
      String(error && error.message || error).slice(0, 500),
      now, jobId, chunkIndex, leaseToken,
    );
  }
  db.prepare(`
    UPDATE translation_jobs
    SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running'
  `).run(
    String(error && error.code || 'ERR_TRANSLATION_JOB_FAILED'),
    String(error && error.message || error).slice(0, 500),
    now, now, jobId, leaseToken,
  );
}

function isTransientError(error) {
  const statusCode = Number(error && (error.statusCode || error.status));
  const code = String(error && (error.code || error.cause && error.cause.code) || '').toUpperCase();
  return error && error.retryable === true
    || statusCode === 429
    || statusCode >= 500
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
    || error && error.name === 'AbortError';
}

function retryJob(job, chunkIndex, leaseToken, error, now) {
  const delay = Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)));
  db.prepare(`
    UPDATE translation_job_chunks
    SET status = 'retry_wait', error_code = ?, error_message = ?, updated_at = ?
    WHERE job_id = ? AND chunk_index = ?
      AND EXISTS (
        SELECT 1 FROM translation_jobs j
        WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ? AND j.status = 'running'
      )
  `).run(
    String(error && error.code || `HTTP_${error && error.statusCode || 'RETRY'}`),
    String(error && error.message || error).slice(0, 500),
    now, job.id, chunkIndex, leaseToken,
  );
  db.prepare(`
    UPDATE translation_jobs
    SET status = 'retry_wait', lease_token = NULL, lease_expires_at = NULL,
        next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running'
  `).run(
    now + delay,
    String(error && error.code || `HTTP_${error && error.statusCode || 'RETRY'}`),
    String(error && error.message || error).slice(0, 500),
    now, job.id, leaseToken,
  );
}

async function defaultTranslateChunk(input, context) {
  const { translateChunkV2 } = require('./deepseek');
  return translateChunkV2(input, context.aiConfig || {});
}

async function runNext({
  now: nowValue,
  leaseMs = DEFAULT_LEASE_MS,
  translateChunk = defaultTranslateChunk,
  publishTranslationVersion = store.publishTranslationVersion,
} = {}) {
  const timestamp = () => resolvedNow(nowValue);
  const claimedAt = timestamp();
  const claimed = claimNext(claimedAt, leaseMs);
  if (!claimed) return null;
  const { jobId, leaseToken } = claimed;
  const job = getStatus(jobId);
  if (job.pipelineHash !== translationPipelineHash()) {
    const supersededAt = timestamp();
    if (!supersedeObsoletePipeline(jobId, leaseToken, supersededAt)) {
      return { id: jobId, status: 'lease_lost' };
    }
    return getStatus(jobId);
  }
  const document = store.getArticleDocument(job.documentId);
  const fullInput = buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: segmentsFromAst(document.ast),
  });
  const segments = new Map(fullInput.segments.map(segment => [segment.id, segment]));
  const content = {};
  let activeChunkIndex = -1;

  try {
    for (const chunk of job.chunks) {
      if (chunk.status === 'succeeded' && chunk.result) {
        Object.assign(content, chunk.result);
        continue;
      }
      activeChunkIndex = chunk.chunkIndex;
      const chunkInput = {
        ...fullInput,
        segments: chunk.segmentIds.map(id => segments.get(id)),
      };
      const chunkStartedAt = timestamp();
      if (!renewLease(jobId, leaseToken, chunkStartedAt, leaseMs)) {
        return { id: jobId, status: 'lease_lost' };
      }
      const running = db.prepare(`
        UPDATE translation_job_chunks
        SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE job_id = ? AND chunk_index = ?
          AND EXISTS (
            SELECT 1 FROM translation_jobs j
            WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ? AND j.status = 'running'
          )
      `).run(chunkStartedAt, jobId, chunk.chunkIndex, leaseToken);
      if (!Number(running.changes)) return { id: jobId, status: 'lease_lost' };
      let result;
      for (let schemaAttempt = 0; schemaAttempt < 2; schemaAttempt += 1) {
        try {
          const response = await translateChunk(chunkInput, {
            jobId,
            chunkIndex: chunk.chunkIndex,
            attempt: chunk.attemptCount + schemaAttempt,
            provider: job.provider,
            model: job.model,
            tuning: job.tuning,
            aiConfig: {
              provider: job.provider,
              model: job.model,
              ...job.tuning,
            },
          });
          const responseAt = timestamp();
          if (!renewLease(jobId, leaseToken, responseAt, leaseMs)) {
            return { id: jobId, status: 'lease_lost' };
          }
          result = validateTranslationResponse(response, chunkInput);
          break;
        } catch (error) {
          if (error && error.code === 'ERR_TRANSLATION_RESPONSE_INVALID' && schemaAttempt === 0) {
            const incremented = db.prepare(`
              UPDATE translation_job_chunks
              SET attempt_count = attempt_count + 1, updated_at = ?
              WHERE job_id = ? AND chunk_index = ?
                AND EXISTS (
                  SELECT 1 FROM translation_jobs j
                  WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ? AND j.status = 'running'
                )
            `).run(timestamp(), jobId, chunk.chunkIndex, leaseToken);
            if (!Number(incremented.changes)) return { id: jobId, status: 'lease_lost' };
            continue;
          }
          if (error && error.code === 'ERR_TRANSLATION_RESPONSE_INVALID') {
            const invalid = new Error(`translation chunk ${chunk.chunkIndex} remained invalid`, { cause: error });
            invalid.code = 'ERR_TRANSLATION_CHUNK_INVALID';
            throw invalid;
          }
          throw error;
        }
      }
      const saved = db.prepare(`
        UPDATE translation_job_chunks
        SET status = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE job_id = ? AND chunk_index = ?
          AND EXISTS (
            SELECT 1 FROM translation_jobs j
            WHERE j.id = translation_job_chunks.job_id AND j.lease_token = ? AND j.status = 'running'
          )
      `).run(canonicalSerialize(result), timestamp(), jobId, chunk.chunkIndex, leaseToken);
      if (!Number(saved.changes)) return { id: jobId, status: 'lease_lost' };
      Object.assign(content, result);
    }
    const publishingAt = timestamp();
    if (!renewLease(jobId, leaseToken, publishingAt, leaseMs) || !leaseGuard(jobId, leaseToken)) {
      return { id: jobId, status: 'lease_lost' };
    }
    const rendered = renderTranslation(document, content);
    const version = {
      id: `translation-version-${job.generationHash}`,
      entryId: job.entryId,
      documentId: job.documentId,
      ownerType: job.ownerType,
      userId: job.userId,
      author: job.author,
      sourceHash: job.sourceHash,
      pipelineHash: job.pipelineHash,
      generationHash: job.generationHash,
      schemaVersion: 2,
      titleZh: rendered.titleZh,
      summaryZh: rendered.summaryZh,
      content: {
        schemaVersion: 2,
        translations: Object.entries(rendered.content).map(([id, target]) => ({ id, target })),
      },
      provider: job.provider,
      model: job.model,
      createdAt: publishingAt,
    };
    const completedAt = resolvedNow(nowValue);
    await publishTranslationVersion(version, {
      promotion: 'auto',
      jobFence: { jobId, leaseToken, completedAt },
    });
    if (getStatus(jobId).status !== 'succeeded') {
      const finished = db.prepare(`
        UPDATE translation_jobs
        SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running'
      `).run(completedAt, completedAt, jobId, leaseToken);
      if (!Number(finished.changes)) return { id: jobId, status: 'lease_lost' };
    }
    return getStatus(jobId);
  } catch (error) {
    if (error && error.code === 'ERR_TRANSLATION_JOB_LEASE_LOST') {
      return { id: jobId, status: 'lease_lost' };
    }
    if (activeChunkIndex >= 0 && isTransientError(error)) {
      retryJob(job, activeChunkIndex, leaseToken, error, timestamp());
    } else {
      failJob(jobId, activeChunkIndex, leaseToken, error, timestamp());
    }
    return getStatus(jobId);
  }
}

module.exports = {
  enqueue,
  getStatus,
  runNext,
  promote,
};
