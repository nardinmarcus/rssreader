const cheerio = require('cheerio');
const fs = require('fs');
const Parser = require('rss-parser');
const snapshots = require('./source-snapshots');
const { verifyWechatFeed } = require('./source-ingestion');
const { compileFeedDocument } = require('./article-documents');
const rollout = require('./translation-rollout');
const store = require('./store');
const {
  BACKFILL_PARSER_VERSION,
  BACKFILL_MAX_BATCH_SIZE,
  BACKFILL_DEFAULT_LEASE_MS,
  ACTIVE_RUN_STATUSES,
  sha256Hex,
} = require('./source-backfill-store');

const MAX_BACKFILL_FEED_BYTES = 5 * 1024 * 1024;
const BACKFILL_FETCH_TIMEOUT_MS = 20_000;
const BACKFILL_MAX_REDIRECTS = 6;

const RSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Namoo Reader/1.0',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
};

const backfillParser = new Parser({
  timeout: BACKFILL_FETCH_TIMEOUT_MS,
  headers: RSS_HEADERS,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:group', 'mediaGroup'],
      ['content:encoded', 'contentEncoded'],
      ['comments', 'comments'],
      ['dc:creator', 'dcCreator'],
    ],
  },
});

const COVERAGE_SUMMARIES = {
  unknown: '早于当前供给窗口的历史覆盖未知',
  available_window: '已覆盖当前可用供给窗口，更早历史覆盖未知',
  provider_archive_exhausted: '已完成当前供给全部归档',
  mismatch: '供给身份不匹配，已保留先前内容',
};

function defaultFetcher() {
  return require('./fetcher');
}

function backfillError(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function defaultRetryBaseMs() {
  const configured = Number(process.env.SOURCE_BACKFILL_RETRY_BASE_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 1000;
}

function configuredBatchSize(override) {
  const raw = override !== undefined ? override : process.env.SOURCE_BACKFILL_BATCH_SIZE;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.min(BACKFILL_MAX_BATCH_SIZE, parsed);
  }
  return BACKFILL_MAX_BATCH_SIZE;
}

function parseRetryAfterMs(headers, nowAt = Date.now()) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? String(headers.get('retry-after') || '').trim()
    : String(headers['retry-after'] || headers['Retry-After'] || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowAt) : null;
}

function sanitizeSafeErrorMessage(code, rawMessage = '') {
  switch (code) {
    case 'ERR_BACKFILL_RATE_LIMITED':
      return '供给方暂时限制请求，将按退避节奏自动重试';
    case 'ERR_BACKFILL_TRANSIENT_HTTP':
      return '供给方服务暂时不可用，将自动重试';
    case 'ERR_BACKFILL_NETWORK':
      return '网络连接中断或超时，将自动重试';
    case 'ERR_BACKFILL_FORBIDDEN':
      return '供给方拒绝访问该订阅源';
    case 'ERR_BACKFILL_NOT_FOUND':
      return '供给方未找到该归档或订阅源入口';
    case 'ERR_BACKFILL_INVALID_FEED':
      return '订阅内容格式无效，无法解析历史条目';
    case 'ERR_BACKFILL_TOO_LARGE':
      return '订阅响应超过 5 MiB 默认上限';
    case 'ERR_BACKFILL_SSRF_BLOCKED':
      return '订阅地址或重定向目标不符合安全策略';
    case 'ERR_BACKFILL_ACCOUNT_MISMATCH':
      return '供给账号身份与已验证来源不一致，已保留既有内容';
    case 'ERR_BACKFILL_SNAPSHOT_MISSING':
      return '固定原始快照文件缺失，请手工重试';
    case 'ERR_BACKFILL_SNAPSHOT_CORRUPT':
      return '固定原始快照校验失败或已损坏，请手工重试';
    case 'ERR_BACKFILL_ITEM_CAPTURE_FAILED':
      return '历史条目或文档捕获失败，未计入完成';
    default:
      return String(rawMessage || '历史回填失败').replace(/https?:\/\/[^\s)]+/gi, '[url]').slice(0, 160);
  }
}

function classifyHttpOrNetworkError(error, response = null, nowAt = Date.now()) {
  const errCode = String(error && (error.code || (error.cause && error.cause.code)) || '');
  const msg = String(error && error.message || '');
  const status = Number((response && response.status) || (error && (error.statusCode || error.status)) || 0);

  if (!response && status === 400 && /本机|内网|private|loopback|disallowed|non-public|http\/https|链接格式|credentials/i.test(msg)) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_SSRF_BLOCKED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_SSRF_BLOCKED'),
      retryAfterMs: null,
    };
  }
  if (status === 429) {
    return {
      transient: true,
      code: 'ERR_BACKFILL_RATE_LIMITED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_RATE_LIMITED'),
      retryAfterMs: parseRetryAfterMs(response && response.headers, nowAt),
    };
  }
  if (status === 408 || (status >= 500 && status <= 599)) {
    return {
      transient: true,
      code: 'ERR_BACKFILL_TRANSIENT_HTTP',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_TRANSIENT_HTTP'),
      retryAfterMs: parseRetryAfterMs(response && response.headers, nowAt),
    };
  }
  if (status === 401 || status === 403) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_FORBIDDEN',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_FORBIDDEN'),
      retryAfterMs: null,
    };
  }
  if (status === 404 || status === 410) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_NOT_FOUND',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_NOT_FOUND'),
      retryAfterMs: null,
    };
  }
  if (status === 413) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_TOO_LARGE',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_TOO_LARGE'),
      retryAfterMs: null,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_INVALID_FEED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_INVALID_FEED'),
      retryAfterMs: null,
    };
  }

  if (errCode === 'ERR_SNAPSHOT_TOO_LARGE' || /exceeds .* bytes/i.test(msg)) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_TOO_LARGE',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_TOO_LARGE'),
      retryAfterMs: null,
    };
  }
  if (errCode === 'ERR_BACKFILL_ACCOUNT_MISMATCH' || errCode === 'wechat-account-mismatch' || errCode === 'wechat-account-identity-changed') {
    return {
      transient: false,
      code: 'ERR_BACKFILL_ACCOUNT_MISMATCH',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_ACCOUNT_MISMATCH'),
      coverageStatus: 'mismatch',
      retryAfterMs: null,
    };
  }
  if (errCode === 'ERR_BACKFILL_INVALID_FEED') {
    return {
      transient: false,
      code: 'ERR_BACKFILL_INVALID_FEED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_INVALID_FEED'),
      retryAfterMs: null,
    };
  }
  if (/private|loopback|disallowed|non-public|invalid url|http\/https|credentials/i.test(msg)) {
    return {
      transient: false,
      code: 'ERR_BACKFILL_SSRF_BLOCKED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_SSRF_BLOCKED'),
      retryAfterMs: null,
    };
  }
  if (errCode === 'ERR_BACKFILL_SNAPSHOT_MISSING' || errCode === 'ENOENT') {
    return {
      transient: false,
      code: 'ERR_BACKFILL_SNAPSHOT_MISSING',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_SNAPSHOT_MISSING'),
      retryAfterMs: null,
    };
  }
  if (errCode === 'ERR_SNAPSHOT_HASH_MISMATCH' || String(errCode).startsWith('Z_') || errCode === 'ERR_BACKFILL_SNAPSHOT_CORRUPT') {
    return {
      transient: false,
      code: 'ERR_BACKFILL_SNAPSHOT_CORRUPT',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_SNAPSHOT_CORRUPT'),
      retryAfterMs: null,
    };
  }
  if (errCode === 'ERR_BACKFILL_ITEM_CAPTURE_FAILED') {
    return {
      transient: false,
      code: 'ERR_BACKFILL_ITEM_CAPTURE_FAILED',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_ITEM_CAPTURE_FAILED'),
      retryAfterMs: null,
    };
  }

  const transientNetCodes = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'EPIPE',
  ]);
  if (!status && (
    transientNetCodes.has(errCode.toUpperCase())
    || (error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError || error.retryable === true))
    || /timed out|timeout|network|socket|fetch failed/i.test(msg)
  )) {
    return {
      transient: true,
      code: 'ERR_BACKFILL_NETWORK',
      message: sanitizeSafeErrorMessage('ERR_BACKFILL_NETWORK'),
      retryAfterMs: null,
    };
  }

  return {
    transient: false,
    code: 'ERR_BACKFILL_FAILED',
    message: sanitizeSafeErrorMessage('ERR_BACKFILL_FAILED', msg),
    retryAfterMs: null,
  };
}

/**
 * Extracts RFC 5005 paging metadata (`rel="next"` and `<fh:complete/>`) from feed XML.
 */
function extractFeedPagingMetadata(xml, baseUrl = '', publicUrlValidator = null) {
  const text = String(xml || '');
  if (!text.trim()) return { nextArchiveUrl: '', archiveComplete: false };
  const $ = cheerio.load(text, { xmlMode: true });
  const container = $('rss > channel').first().length ? $('rss > channel').first() : $('feed').first();
  if (!container.length) return { nextArchiveUrl: '', archiveComplete: false };

  let nextArchiveUrl = '';
  let archiveComplete = false;
  container.children().each((_, element) => {
    const tag = String(element.name || element.tagName || '').toLowerCase();
    const localName = tag.includes(':') ? tag.split(':').pop() : tag;
    if (localName === 'complete' && (tag === 'fh:complete' || tag === 'archive:complete' || tag === 'namoo:archive-complete')) {
      archiveComplete = true;
    }
    if (!nextArchiveUrl && localName === 'link') {
      const rel = String($(element).attr('rel') || '').trim().toLowerCase();
      if (rel === 'next' || rel === 'prev-archive') {
        const href = String($(element).attr('href') || '').trim();
        if (href) {
          try {
            const resolved = new URL(href, baseUrl || undefined);
            if ((resolved.protocol === 'https:' || resolved.protocol === 'http:') && !resolved.username && !resolved.password) {
              if (typeof publicUrlValidator === 'function') {
                publicUrlValidator(resolved.toString());
              }
              nextArchiveUrl = resolved.toString();
            }
          } catch { /* ignore invalid or non-public next link */ }
        }
      }
    }
  });
  return { nextArchiveUrl, archiveComplete };
}

async function parseFeedBuffer(buffer, { headers = {}, baseUrl = '', decodeBuffer = null, publicUrlValidator = null } = {}) {
  if (!Buffer.isBuffer(buffer)) throw backfillError('ERR_BACKFILL_INVALID_FEED', 'feed snapshot must be a Buffer', 422);
  if (buffer.length > MAX_BACKFILL_FEED_BYTES) {
    throw backfillError('ERR_BACKFILL_TOO_LARGE', 'feed exceeds 5 MiB limit', 413);
  }
  const decoder = decodeBuffer || (defaultFetcher().__test && defaultFetcher().__test.decodeResponseBuffer) || (buf => buf.toString('utf8'));
  const xml = decoder(buffer, headers);
  if (!xml || !xml.trim() || /<!ENTITY/i.test(xml)) {
    throw backfillError('ERR_BACKFILL_INVALID_FEED', 'invalid or unsafe XML feed', 422);
  }
  let feed;
  try {
    feed = await backfillParser.parseString(xml);
  } catch {
    throw backfillError('ERR_BACKFILL_INVALID_FEED', 'feed XML could not be parsed', 422);
  }
  const paging = extractFeedPagingMetadata(xml, baseUrl, publicUrlValidator);
  return {
    xml,
    feed,
    nextArchiveUrl: paging.nextArchiveUrl,
    archiveComplete: paging.archiveComplete,
  };
}

/**
 * Inspects a fetched feed and enqueues a new backfill run only when unimported entries or unseen archive links exist.
 */
async function discoverFromFeed({
  source,
  feedUrl = '',
  rawBuffer,
  xml = '',
  feed = null,
  cutoffAt = Date.now(),
  fetcherImpl = null,
  backfillStore = store.sourceBackfill,
  snapshotStore = snapshots,
} = {}) {
  if (!source || !source.id || source.manual) return { enqueued: false, reason: 'not-eligible' };
  const fetcherApi = fetcherImpl || defaultFetcher();
  if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length || rawBuffer.length > MAX_BACKFILL_FEED_BYTES) {
    return { enqueued: false, reason: 'no-valid-buffer' };
  }
  const cleanFeedUrl = String(feedUrl || (Array.isArray(source.feeds) && source.feeds[0]) || '').trim();
  const parsedFeed = feed || await backfillParser.parseString(xml || rawBuffer.toString('utf8')).catch(() => null);
  if (!parsedFeed) return { enqueued: false, reason: 'unparseable-feed' };

  const xmlText = xml || rawBuffer.toString('utf8');
  const validator = fetcherApi.publicHttpUrl || (fetcherApi.__test && fetcherApi.__test.publicHttpUrl) || null;
  const paging = extractFeedPagingMetadata(xmlText, cleanFeedUrl, validator);
  const normalizedItems = (Array.isArray(parsedFeed.items) ? parsedFeed.items : [])
    .map(item => fetcherApi.normalizeItem(item, source, { feedUrl: cleanFeedUrl }));

  const hasUnimported = backfillStore.hasAnyUnimportedCandidate(source.id, normalizedItems);
  const hasUnseenArchive = Boolean(
    paging.nextArchiveUrl && !backfillStore.hasCompletedOrActiveRunForFeedUrl(source.id, paging.nextArchiveUrl),
  );
  if (!hasUnimported && !hasUnseenArchive) {
    return { enqueued: false, reason: 'no-new-input' };
  }

  if (hasUnimported) {
    const snapshotHash = await snapshotStore.put(rawBuffer);
    return backfillStore.enqueueRun({
      sourceId: source.id,
      triggerReason: 'feed-snapshot',
      feedUrl: cleanFeedUrl,
      snapshotHash,
      snapshotBytes: rawBuffer.length,
      parserVersion: BACKFILL_PARSER_VERSION,
      totalCount: normalizedItems.length,
      nextArchiveUrl: paging.nextArchiveUrl,
      archiveComplete: paging.archiveComplete,
      cutoffAt,
    });
  }

  return backfillStore.enqueueRun({
    sourceId: source.id,
    triggerReason: 'archive-next',
    feedUrl: paging.nextArchiveUrl,
    snapshotHash: '',
    snapshotBytes: 0,
    parserVersion: BACKFILL_PARSER_VERSION,
    totalCount: 0,
    visitedUrls: [cleanFeedUrl, paging.nextArchiveUrl].filter(Boolean),
    cutoffAt,
  });
}

function maybeTestFaultOnce(phase) {
  if (process.env.NODE_ENV !== 'test') return;
  const markerFile = String(process.env.SOURCE_BACKFILL_FAULT_FILE || '').trim();
  if (!markerFile) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    return;
  }
  if (!config || config.phase !== phase || config.triggered) return;
  config.triggered = true;
  fs.writeFileSync(markerFile, JSON.stringify(config));
  if (config.mode === 'exit') {
    process.exit(config.exitCode || 1);
  }
  const error = new Error(config.message || `injected fault at ${phase}`);
  error.code = config.errorCode || 'ERR_BACKFILL_INJECTED_FAULT';
  throw error;
}

function recordSnapshotFetchFailure({ backfillStore, run, error = null, response = null, retryBaseMs, nowFn }) {
  const failedAt = nowFn();
  const classified = classifyHttpOrNetworkError(error, response, failedAt);
  if (classified.transient) {
    const backoffDelay = retryBaseMs * (2 ** Math.max(0, run.retryCount));
    const delayMs = classified.retryAfterMs != null ? Math.max(classified.retryAfterMs, backoffDelay) : backoffDelay;
    backfillStore.scheduleRetry({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: classified.code,
      errorMessage: classified.message,
      nextRetryAt: failedAt + delayMs,
      at: failedAt,
    });
  } else {
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: classified.code,
      errorMessage: classified.message,
      coverageStatus: classified.coverageStatus || null,
      at: failedAt,
    });
  }
  return backfillStore.getRun(run.id);
}

async function acquireRunSnapshot({ run, source, ingestion, backfillStore, fetcherApi, snapshotStore, fetchBuffer, leaseMs, retryBaseMs, nowFn }) {
  if (!run.feedUrl) {
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: 'ERR_BACKFILL_NOT_FOUND',
      errorMessage: sanitizeSafeErrorMessage('ERR_BACKFILL_NOT_FOUND'),
      at: nowFn(),
    });
    return { done: true, result: backfillStore.getRun(run.id) };
  }

  let response;
  try {
    response = await fetchBuffer(run.feedUrl, {
      timeout: BACKFILL_FETCH_TIMEOUT_MS,
      maxBytes: MAX_BACKFILL_FEED_BYTES,
      maxRedirects: BACKFILL_MAX_REDIRECTS,
      headers: RSS_HEADERS,
    });
  } catch (error) {
    return { done: true, result: recordSnapshotFetchFailure({ backfillStore, run, error, retryBaseMs, nowFn }) };
  }

  if (!response || response.status < 200 || response.status >= 300) {
    return { done: true, result: recordSnapshotFetchFailure({ backfillStore, run, response, retryBaseMs, nowFn }) };
  }

  try {
    const parsed = await parseFeedBuffer(response.buffer, {
      headers: response.headers,
      baseUrl: response.url || run.feedUrl,
      decodeBuffer: fetcherApi.__test && fetcherApi.__test.decodeResponseBuffer,
      publicUrlValidator: fetcherApi.publicHttpUrl,
    });
    const items = Array.isArray(parsed.feed && parsed.feed.items) ? parsed.feed.items : [];
    if (ingestion && ingestion.platform === 'wechat') {
      const normalizedForVerify = items.map(item => fetcherApi.normalizeItem(item, source, { feedUrl: run.feedUrl }));
      try {
        verifyWechatFeed(
          { name: source.name },
          {
            feedTitle: String(parsed.feed && parsed.feed.title || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
            entries: normalizedForVerify,
          },
          {
            expectedAccountId: ingestion.platformAccountId,
            validateName: !ingestion.platformAccountId,
          },
        );
      } catch (verifyErr) {
        throw backfillError('ERR_BACKFILL_ACCOUNT_MISMATCH', verifyErr.message, 409);
      }
    }

    const snapshotHash = await snapshotStore.put(response.buffer);
    const pinned = backfillStore.pinFetchedSnapshot({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      snapshotHash,
      snapshotBytes: response.buffer.length,
      parserVersion: run.parserVersion || BACKFILL_PARSER_VERSION,
      totalCount: items.length,
      nextArchiveUrl: parsed.nextArchiveUrl,
      archiveComplete: parsed.archiveComplete,
      at: nowFn(),
      leaseMs,
    });
    if (!pinned.ok) {
      return { done: true, result: { id: run.id, sourceId: run.sourceId, status: 'stale_run_token', reason: pinned.reason } };
    }
    return { done: false, run: pinned.run };
  } catch (error) {
    const classified = classifyHttpOrNetworkError(error, null, nowFn());
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: classified.code,
      errorMessage: classified.message,
      coverageStatus: classified.coverageStatus || null,
      at: nowFn(),
    });
    return { done: true, result: backfillStore.getRun(run.id) };
  }
}

/**
 * Executes a single bounded step/batch for the next eligible backfill run.
 */
async function runNext(options = {}) {
  const nowFn = options.now || Date.now;
  const backfillStore = options.backfillStore || store.sourceBackfill;
  const fetcherApi = options.fetcher || defaultFetcher();
  const snapshotStore = options.snapshots || snapshots;
  const leaseMs = Number.isFinite(options.leaseMs) ? options.leaseMs : BACKFILL_DEFAULT_LEASE_MS;
  const batchSize = configuredBatchSize(options.batchSize);
  const retryBaseMs = Number.isFinite(options.retryBaseMs) ? options.retryBaseMs : defaultRetryBaseMs();
  const fetchBuffer = options.fetchBuffer || ((url, fetchOpts) => fetcherApi.fetchPublicBuffer(url, fetchOpts));
  const writesDocs = typeof options.writesVersionedDocuments === 'function'
    ? options.writesVersionedDocuments
    : rollout.writesVersionedDocuments;
  const compileDoc = options.compileFeedDocument || compileFeedDocument;
  const workerPid = Number.isInteger(options.workerPid) ? options.workerPid : process.pid;

  let run = backfillStore.claimNextRun({ at: nowFn(), leaseMs, workerPid });
  if (!run) return null;

  const source = (options.getSourceById ? options.getSourceById(run.sourceId) : fetcherApi.getSourceById(run.sourceId))
    || store.getCustomSourceById(run.sourceId, { includeArchived: true });
  if (!source || source.archivedAt || !fetcherApi.isEnabled(source)) {
    backfillStore.invalidateActiveRuns(run.sourceId, { supersede: false, at: nowFn() });
    return backfillStore.getRun(run.id);
  }

  const ingestion = store.getSourceIngestionBySourceId(run.sourceId);

  // Phase 1: Acquire and pin the immutable RSS snapshot over HTTP outside any SQLite transaction.
  if (!run.snapshotHash) {
    const acquired = await acquireRunSnapshot({
      run, source, ingestion, backfillStore, fetcherApi, snapshotStore, fetchBuffer, leaseMs, retryBaseMs, nowFn,
    });
    if (acquired.done) return acquired.result;
    run = acquired.run;
  }

  // Phase 2: Read and verify the pinned immutable snapshot, then process at most one batch (<= 50).
  let buffer;
  try {
    buffer = await snapshotStore.read(run.snapshotHash);
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'ERR_BACKFILL_SNAPSHOT_MISSING' : 'ERR_BACKFILL_SNAPSHOT_CORRUPT';
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: code,
      errorMessage: sanitizeSafeErrorMessage(code),
      at: nowFn(),
    });
    return backfillStore.getRun(run.id);
  }

  let parsed;
  try {
    parsed = await parseFeedBuffer(buffer, {
      baseUrl: run.feedUrl,
      decodeBuffer: fetcherApi.__test && fetcherApi.__test.decodeResponseBuffer,
      publicUrlValidator: fetcherApi.publicHttpUrl,
    });
  } catch (error) {
    const classified = classifyHttpOrNetworkError(error, null, nowFn());
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: classified.code,
      errorMessage: classified.message,
      at: nowFn(),
    });
    return backfillStore.getRun(run.id);
  }

  const allItems = Array.isArray(parsed.feed && parsed.feed.items) ? parsed.feed.items : [];
  const offset = Math.max(0, Number(run.cursor && run.cursor.offset) || run.processedCount || 0);
  const batchItems = allItems.slice(offset, offset + batchSize);
  const nextOffset = offset + batchItems.length;

  const entries = [];
  const documents = [];
  try {
    for (const item of batchItems) {
      const entry = fetcherApi.normalizeItem(item, source, { feedUrl: run.feedUrl });
      if (!entry || !entry.id) {
        throw backfillError('ERR_BACKFILL_ITEM_CAPTURE_FAILED', 'normalized item missing id', 500);
      }
      entries.push(entry);
      if (writesDocs()) {
        const compiled = typeof options.captureFeedDocument === 'function'
          ? await options.captureFeedDocument({ entry, finalUrl: entry.link })
          : compileDoc({ entry, finalUrl: entry.link });
        if (!compiled || !compiled.documentHash) {
          throw backfillError('ERR_BACKFILL_ITEM_CAPTURE_FAILED', 'document capture returned invalid output', 500);
        }
        documents.push({ entryId: entry.id, ...compiled });
      }
    }
  } catch {
    const code = 'ERR_BACKFILL_ITEM_CAPTURE_FAILED';
    backfillStore.failRun({
      runId: run.id,
      runToken: run.runToken,
      generation: run.generation,
      errorCode: code,
      errorMessage: sanitizeSafeErrorMessage(code),
      failedItemsDelta: 1,
      at: nowFn(),
    });
    return backfillStore.getRun(run.id);
  }

  if (typeof options.beforeBatchCommit === 'function') {
    await options.beforeBatchCommit({ run, entries, offset, nextOffset });
  }
  maybeTestFaultOnce('pre-tx');

  const committed = backfillStore.commitBatch({
    runId: run.id,
    runToken: run.runToken,
    generation: run.generation,
    entries,
    documents,
    nextOffset,
    batchProcessedCount: batchItems.length,
    at: nowFn(),
    leaseMs,
  });

  if (!committed.ok) {
    return { id: run.id, sourceId: run.sourceId, status: 'stale_run_token', reason: committed.reason };
  }

  if (typeof options.afterBatchCommitBeforeAck === 'function') {
    await options.afterBatchCommitBeforeAck({ run: committed.run, inserted: committed.inserted, reused: committed.reused });
  }
  maybeTestFaultOnce('post-commit-pre-ack');

  if (typeof options.onBatchProgress === 'function') {
    options.onBatchProgress(committed);
  }

  return committed.run;
}

function buildPublicCoverageSummary(sourceId, stateRow, entryStats) {
  const status = stateRow && stateRow.coverageStatus ? stateRow.coverageStatus : 'unknown';
  const entryCount = Number(entryStats && entryStats.entryCount) || 0;
  const earliestPublishedAt = Number(entryStats && entryStats.earliestPublishedAt)
    || Number(stateRow && stateRow.earliestPublishedAt)
    || null;
  const latestPublishedAt = Number(entryStats && entryStats.latestPublishedAt)
    || Number(stateRow && stateRow.latestPublishedAt)
    || null;
  return {
    status,
    entryCount,
    earliestPublishedAt,
    latestPublishedAt,
    hasGap: status !== 'provider_archive_exhausted',
    summaryText: COVERAGE_SUMMARIES[status] || COVERAGE_SUMMARIES.unknown,
  };
}

function availableActionsForRun(run, { enabled = true, archived = false } = {}) {
  if (!run) return [];
  if (ACTIVE_RUN_STATUSES.has(run.status)) return ['pause'];
  if (run.status === 'paused' && enabled && !archived) return ['resume'];
  if (run.status === 'failed' && enabled && !archived) return ['retry'];
  return [];
}

function buildAdminBackfillProjection({ source, stateRow, runRow, entryStats }) {
  const coverage = buildPublicCoverageSummary(source.id, stateRow, entryStats);
  const status = runRow ? runRow.status : 'idle';
  const totalCount = runRow ? runRow.totalCount : 0;
  const processedCount = runRow ? runRow.processedCount : 0;
  const insertedCount = runRow ? runRow.insertedCount : 0;
  const reusedCount = runRow ? runRow.reusedCount : 0;
  const failedItemCount = runRow ? runRow.failedItemCount : 0;
  const remainingCount = Math.max(0, totalCount - processedCount);
  const progressRatio = totalCount > 0 ? Math.min(1, Number((processedCount / totalCount).toFixed(4))) : (status === 'succeeded' ? 1 : 0);
  const errorCode = (runRow && runRow.errorCode) || (stateRow && stateRow.lastErrorCode) || '';
  const errorMessage = (runRow && runRow.errorMessage) || (stateRow && stateRow.lastErrorMessage) || '';
  const archived = Boolean(source.archivedAt);
  const enabled = Boolean(source.enabled !== false && !archived);

  return {
    sourceId: source.id,
    sourceName: source.name || source.id,
    enabled,
    archived,
    status,
    coverage,
    counts: {
      totalCount,
      processedCount,
      insertedCount,
      reusedCount,
      failedItemCount,
      remainingCount,
      progressRatio,
      cumulativeInsertedCount: Number(stateRow && stateRow.backfilledEntryCount) || insertedCount,
      cumulativeReusedCount: Number(stateRow && stateRow.reusedEntryCount) || reusedCount,
    },
    run: runRow ? {
      id: runRow.id,
      triggerReason: runRow.triggerReason,
      parserVersion: runRow.parserVersion,
      snapshotHash: runRow.snapshotHash,
      inputIdentity: runRow.inputIdentity,
      attemptCount: runRow.attemptCount,
      retryCount: runRow.retryCount,
      nextRetryAt: runRow.nextRetryAt,
      createdAt: runRow.createdAt,
      updatedAt: runRow.updatedAt,
      completedAt: runRow.completedAt,
    } : null,
    error: errorCode || errorMessage ? {
      code: errorCode || 'ERR_BACKFILL_FAILED',
      message: errorMessage || sanitizeSafeErrorMessage(errorCode),
    } : null,
    availableActions: availableActionsForRun(runRow, { enabled, archived }),
  };
}

/**
 * Returns safe public coverage metadata keyed by source ID for `/api/sources`.
 */
function getPublicSourcesCoverage(backfillStore = store.sourceBackfill) {
  const states = new Map(backfillStore.listAllStates().map(item => [item.sourceId, item]));
  const statsMap = backfillStore.getAllSourceEntryStats();
  const result = {};
  const allIds = new Set([...states.keys(), ...Object.keys(statsMap)]);
  for (const sourceId of allIds) {
    result[sourceId] = buildPublicCoverageSummary(sourceId, states.get(sourceId) || null, statsMap[sourceId] || null);
  }
  return result;
}

function getAdminSourcesBackfillMap(sources = [], backfillStore = store.sourceBackfill) {
  const states = new Map(backfillStore.listAllStates().map(item => [item.sourceId, item]));
  const runs = backfillStore.listActiveOrLatestRunsBySource();
  const statsMap = backfillStore.getAllSourceEntryStats();
  const result = {};
  for (const source of sources || []) {
    if (!source || !source.id) continue;
    result[source.id] = buildAdminBackfillProjection({
      source,
      stateRow: states.get(source.id) || null,
      runRow: runs[source.id] || null,
      entryStats: statsMap[source.id] || null,
    });
  }
  return result;
}

function resolveAdminSource(sourceId, fetcherApi = defaultFetcher()) {
  const cleanId = String(sourceId || '').trim();
  if (!cleanId) return null;
  const active = fetcherApi.getSourceById(cleanId);
  if (active) return active;
  const archived = store.getCustomSourceById(cleanId, { includeArchived: true });
  if (!archived) return null;
  return {
    ...archived,
    enabled: false,
    isCustom: true,
  };
}

function getAdminBackfillStatus(sourceId, { fetcherImpl = null, backfillStore = store.sourceBackfill } = {}) {
  const fetcherApi = fetcherImpl || defaultFetcher();
  const source = resolveAdminSource(sourceId, fetcherApi);
  if (!source) throw backfillError('source-not-found', 'source not found', 404);
  return buildAdminBackfillProjection({
    source,
    stateRow: backfillStore.getState(source.id),
    runRow: backfillStore.getLatestRunForSource(source.id),
    entryStats: backfillStore.getSourceEntryStats(source.id),
  });
}

function applyAdminBackfillAction(sourceId, payload = {}, { fetcherImpl = null, backfillStore = store.sourceBackfill } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw backfillError('invalid-backfill-payload', 'request body must be an object', 400);
  }
  const keys = Object.keys(payload);
  if (keys.some(key => key !== 'action')) {
    throw backfillError('invalid-backfill-fields', 'only action is accepted', 400);
  }
  const action = String(payload.action || '').trim();
  if (!['pause', 'resume', 'retry'].includes(action)) {
    throw backfillError('invalid-backfill-action', 'action must be pause, resume, or retry', 400);
  }
  const fetcherApi = fetcherImpl || defaultFetcher();
  const source = resolveAdminSource(sourceId, fetcherApi);
  if (!source) throw backfillError('source-not-found', 'source not found', 404);

  backfillStore.applyAdminAction(source.id, action);
  return getAdminBackfillStatus(source.id, { fetcherImpl: fetcherApi, backfillStore });
}

module.exports = {
  BACKFILL_PARSER_VERSION,
  BACKFILL_MAX_BATCH_SIZE,
  MAX_BACKFILL_FEED_BYTES,
  extractFeedPagingMetadata,
  parseFeedBuffer,
  discoverFromFeed,
  runNext,
  getPublicSourcesCoverage,
  getAdminSourcesBackfillMap,
  getAdminBackfillStatus,
  applyAdminBackfillAction,
  buildPublicCoverageSummary,
  classifyHttpOrNetworkError,
  sanitizeSafeErrorMessage,
  sha256Hex,
};
