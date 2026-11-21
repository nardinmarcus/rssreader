const SOURCE_HISTORY_SORT = 'published_desc';
const SOURCE_HISTORY_DEFAULT_LIMIT = 50;
const SOURCE_HISTORY_MAX_LIMIT = 100;
const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 2048;
const CURSOR_KEYS = ['v', 'sourceId', 'sort', 'hasPublished', 'ts', 'id'];

function historyError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Parses and bounds the per-source history page size (default 50, max 100).
 */
function parseSourceHistoryLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
    return SOURCE_HISTORY_DEFAULT_LIMIT;
  }
  if (typeof rawLimit !== 'string' && typeof rawLimit !== 'number') {
    return SOURCE_HISTORY_DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SOURCE_HISTORY_DEFAULT_LIMIT;
  }
  return Math.min(SOURCE_HISTORY_MAX_LIMIT, parsed);
}

/**
 * Validates the sort order for source history pagination.
 */
function parseSourceHistorySort(rawSort) {
  if (rawSort === undefined || rawSort === null || rawSort === '') {
    return SOURCE_HISTORY_SORT;
  }
  if (rawSort === SOURCE_HISTORY_SORT) {
    return SOURCE_HISTORY_SORT;
  }
  throw historyError('invalid-history-sort', 'unsupported history sort', 400);
}

/**
 * Derives the deterministic keyset sort tuple for an entry.
 * Entries with a positive publication timestamp always sort ahead of entries
 * with unknown dates (publishedTs <= 0), preventing import time from boosting
 * undated items ahead of dated publications.
 */
function sourceHistorySortKey(entry) {
  const publishedTs = Number(entry && entry.publishedTs) || 0;
  const hasPublished = publishedTs > 0 ? 1 : 0;
  const ts = hasPublished
    ? Math.trunc(publishedTs)
    : Math.max(0, Math.trunc(Number(entry && entry.createdAt) || 0));
  const id = String(entry && entry.id || '');
  return { hasPublished, ts, id };
}

/**
 * Encodes an opaque keyset cursor bound to sourceId, sort order, and tie-breaker ID.
 */
function encodeSourceHistoryCursor({ sourceId, sort = SOURCE_HISTORY_SORT, entry }) {
  const cleanSourceId = String(sourceId || '').trim();
  const cleanSort = parseSourceHistorySort(sort);
  const key = sourceHistorySortKey(entry);
  if (!cleanSourceId || !key.id) {
    throw historyError('invalid-history-cursor', 'cannot encode cursor without sourceId and entry id', 400);
  }
  const payload = {
    v: CURSOR_VERSION,
    sourceId: cleanSourceId,
    sort: cleanSort,
    hasPublished: key.hasPublished,
    ts: key.ts,
    id: key.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a keyset cursor against the expected source and sort.
 */
function decodeSourceHistoryCursor(rawCursor, {
  expectedSourceId = '',
  expectedSort = SOURCE_HISTORY_SORT,
} = {}) {
  if (rawCursor === undefined || rawCursor === null || rawCursor === '') {
    return null;
  }
  if (typeof rawCursor !== 'string') {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }
  if (rawCursor.trim() !== rawCursor || rawCursor.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }

  let parsed;
  try {
    const json = Buffer.from(rawCursor, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== rawCursor) {
      throw new Error('non-canonical base64url');
    }
    parsed = JSON.parse(json);
  } catch {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== CURSOR_KEYS.length || !CURSOR_KEYS.every(key => Object.prototype.hasOwnProperty.call(parsed, key))) {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }

  const { v, sourceId, sort, hasPublished, ts, id } = parsed;
  if (
    v !== CURSOR_VERSION
    || typeof sourceId !== 'string'
    || !sourceId
    || sourceId !== sourceId.trim()
    || typeof sort !== 'string'
    || (hasPublished !== 0 && hasPublished !== 1)
    || !Number.isSafeInteger(ts)
    || ts < 0
    || (hasPublished === 1 && ts <= 0)
    || typeof id !== 'string'
    || !id
    || id.length > 512
  ) {
    throw historyError('invalid-history-cursor', 'invalid history cursor', 400);
  }

  if (expectedSourceId && sourceId !== expectedSourceId) {
    throw historyError('cross-source-cursor', 'cursor does not match source', 400);
  }
  if (expectedSort && sort !== expectedSort) {
    throw historyError('history-cursor-sort-mismatch', 'cursor sort does not match', 400);
  }

  return { sourceId, sort, hasPublished, ts, id };
}

module.exports = {
  SOURCE_HISTORY_SORT,
  SOURCE_HISTORY_DEFAULT_LIMIT,
  SOURCE_HISTORY_MAX_LIMIT,
  parseSourceHistoryLimit,
  parseSourceHistorySort,
  sourceHistorySortKey,
  encodeSourceHistoryCursor,
  decodeSourceHistoryCursor,
};
