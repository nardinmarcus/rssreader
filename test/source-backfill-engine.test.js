const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('namoo-backfill-engine-');
process.env.NAMOO_READER_DATA_DIR = dataDir;

const store = require('../lib/store');
const fetcher = require('../lib/fetcher');
const snapshots = require('../lib/source-snapshots');
const backfill = require('../lib/source-backfill');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createCustomSourceFixture({ name = 'Backfill Test RSS', feedUrl = 'https://feeds.example/rss.xml', category = 'article' } = {}) {
  const id = `custom-bf-${crypto.randomUUID().slice(0, 8)}`;
  const source = store.createCustomSource({
    id,
    name,
    feedUrl,
    siteUrl: 'https://feeds.example/',
    category,
    description: 'backfill fixture',
    labels: ['test'],
  });
  store.saveSourcePreference({
    sourceId: id,
    enabled: true,
    editorialPriority: 'normal',
    displayOrder: 10,
  });
  return {
    ...source,
    feeds: [feedUrl],
    enabled: true,
    isCustom: true,
  };
}

function buildGenericRssXml({
  title = 'Backfill Test RSS',
  count = 120,
  startIndex = 0,
  nextUrl = '',
  complete = false,
  withAudioEnclosure = false,
  omitDates = false,
} = {}) {
  const items = [];
  const baseTs = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < count; i += 1) {
    const idx = startIndex + i;
    const pubTs = baseTs - idx * 3600 * 1000;
    const pubDate = omitDates ? '' : `<pubDate>${new Date(pubTs).toUTCString()}</pubDate>`;
    const enclosure = withAudioEnclosure
      ? `<enclosure url="https://cdn.example/audio-${idx}.mp3" length="123456" type="audio/mpeg" />`
      : '';
    items.push(`
      <item>
        <title>Episode or Article #${idx}</title>
        <link>https://feeds.example/posts/${idx}</link>
        <guid isPermaLink="false">guid-${idx}</guid>
        ${pubDate}
        <description><![CDATA[Summary for item ${idx}]]></description>
        <content:encoded><![CDATA[<p>Full feed body for item ${idx}. Long enough to inspect content normalization.</p>]]></content:encoded>
        ${enclosure}
      </item>
    `);
  }
  const ns = complete ? 'xmlns:fh="http://purl.org/syndication/history/1.0" ' : '';
  const nextTag = nextUrl ? `<atom:link rel="next" href="${nextUrl}" />` : '';
  const completeTag = complete ? '<fh:complete />' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" ${ns}>
  <channel>
    <title>${title}</title>
    <link>https://feeds.example/</link>
    <description>Generic RSS fixture</description>
    ${nextTag}
    ${completeTag}
    ${items.join('\n')}
  </channel>
</rss>`;
}

test('snapshot pinning, <=50 item batching, reused vs inserted counts, generic RSS/enclosure/dates, and auto-AI exclusion', async () => {
  const source = createCustomSourceFixture({ category: 'podcast', feedUrl: 'https://feeds.example/podcast.xml' });
  const xml = buildGenericRssXml({
    title: 'Podcast Backfill Fixture',
    count: 115,
    withAudioEnclosure: true,
  });
  const rawBuffer = Buffer.from(xml, 'utf8');

  // Seed first 10 items as if already imported in latest window (reused), plus 1 soft-deleted item
  const parsed = await backfill.parseFeedBuffer(rawBuffer, { baseUrl: source.feedUrl });
  const preExisting = parsed.feed.items.slice(0, 10).map(item => fetcher.__test ? item : item);
  const normalizedPre = preExisting.map(item => {
    const id = crypto.createHash('md5').update(`${source.id}|${item.guid}`).digest('hex');
    return {
      id,
      sourceId: source.id,
      title: item.title,
      link: item.link,
      author: '',
      published: item.pubDate,
      publishedTs: Date.parse(item.pubDate),
      summary: 'existing',
      content: '<p>existing</p>',
      image: null,
      audio: { url: 'https://cdn.example/audio.mp3', type: 'audio/mpeg' },
      autoAiExcludedAt: null, // post-cutoff entry in latest window must preserve its eligibility
    };
  });
  store.upsertEntries(normalizedPre);
  store.softDeleteEntry(normalizedPre[9].id, { reason: 'admin deleted' });

  const cutoff = Date.now() - 1000;
  const discovered = await backfill.discoverFromFeed({
    source,
    feedUrl: source.feedUrl,
    rawBuffer,
    xml,
    feed: parsed.feed,
    cutoffAt: cutoff,
  });
  assert.equal(discovered.enqueued, true);
  assert.equal(discovered.run.totalCount, 115);
  assert.equal(discovered.run.snapshotHash, crypto.createHash('sha256').update(rawBuffer).digest('hex'));
  assert.equal(discovered.run.parserVersion, backfill.BACKFILL_PARSER_VERSION);

  // Batch size capped at <= 50 even if a larger override is requested
  const step1 = await backfill.runNext({ batchSize: 200, getSourceById: id => (id === source.id ? source : null) });
  assert.equal(step1.status, 'running');
  assert.equal(step1.processedCount, 50);
  assert.equal(step1.reusedCount, 10);
  assert.equal(step1.insertedCount, 40);
  assert.equal(step1.cursor.offset, 50);
  assert.equal(step1.cursor.inputIdentity, discovered.run.inputIdentity);

  const step2 = await backfill.runNext({ batchSize: 50, getSourceById: id => (id === source.id ? source : null) });
  assert.equal(step2.status, 'running');
  assert.equal(step2.processedCount, 100);
  assert.equal(step2.reusedCount, 10);
  assert.equal(step2.insertedCount, 90);

  const step3 = await backfill.runNext({ batchSize: 50, getSourceById: id => (id === source.id ? source : null) });
  assert.equal(step3.status, 'succeeded');
  assert.equal(step3.processedCount, 115);
  assert.equal(step3.reusedCount, 10);
  assert.equal(step3.insertedCount, 105);

  const status = backfill.getAdminBackfillStatus(source.id, {
    fetcherImpl: { getSourceById: id => (id === source.id ? source : null) },
  });
  assert.equal(status.status, 'succeeded');
  assert.equal(status.coverage.status, 'available_window');
  assert.equal(status.coverage.hasGap, true);
  assert.equal(status.counts.totalCount, 115);
  assert.equal(status.counts.insertedCount, 105);
  assert.equal(status.counts.reusedCount, 10);

  // Soft-deleted entry stayed deleted; latest window reused entries kept null autoAiExcludedAt; newly backfilled entries have autoAiExcludedAt set + audio enclosure
  assert.equal(store.getEntry(normalizedPre[9].id), null);
  assert.equal(store.getEntry(normalizedPre[0].id).autoAiExcludedAt, null);
  const backfilledAll = store.getEntriesBySourceIds([source.id], { limit: 200 });
  assert.equal(backfilledAll.length, 114); // 9 active pre-existing + 105 new
  const oldest = backfilledAll.find(e => e.title === 'Episode or Article #114');
  assert.ok(oldest);
  assert.equal(oldest.autoAiExcludedAt, cutoff);
  assert.deepEqual(oldest.audio, { url: 'https://cdn.example/audio-114.mp3', type: 'audio/mpeg' });

  // No new input -> no fake backfill created
  const repeat = await backfill.discoverFromFeed({
    source,
    feedUrl: source.feedUrl,
    rawBuffer,
    xml,
    feed: parsed.feed,
    cutoffAt: Date.now(),
  });
  assert.equal(repeat.enqueued, false);
  assert.equal(repeat.reason, 'no-new-input');
});

test('transient 429/5xx/network honors Retry-After and 3-retry cap, permanent errors fail immediately, and manual retry resumes from checkpoint', async () => {
  const source = createCustomSourceFixture({ feedUrl: 'https://feeds.example/archive-main.xml' });
  const page1Xml = buildGenericRssXml({
    count: 5,
    startIndex: 0,
    nextUrl: 'https://feeds.example/archive-page-2.xml',
  });
  const page2Xml = buildGenericRssXml({
    count: 12,
    startIndex: 5,
    complete: true,
  });

  // Page 1 snapshot already fetched; points to page 2
  const page1Buf = Buffer.from(page1Xml, 'utf8');
  const page1Parsed = await backfill.parseFeedBuffer(page1Buf, { baseUrl: source.feedUrl });
  await backfill.discoverFromFeed({
    source,
    feedUrl: source.feedUrl,
    rawBuffer: page1Buf,
    xml: page1Xml,
    feed: page1Parsed.feed,
  });

  let nowTs = 1_750_000_000_000;
  const getSource = id => (id === source.id ? source : null);
  const page1Done = await backfill.runNext({ now: () => nowTs, getSourceById: getSource });
  assert.equal(page1Done.status, 'succeeded');
  assert.equal(page1Done.insertedCount, 5);

  // Now page 2 should be queued automatically!
  const page2Queued = store.sourceBackfill.getLatestRunForSource(source.id);
  assert.equal(page2Queued.status, 'queued');
  assert.equal(page2Queued.feedUrl, 'https://feeds.example/archive-page-2.xml');

  // Inject 429 with Retry-After: 5, then 503, then network timeout, then 502 (exhausts 3 auto retries)
  let fetchMode = '429';
  const fetchBuffer = async () => {
    if (fetchMode === '429') {
      return { status: 429, headers: new Headers({ 'Retry-After': '5' }), buffer: Buffer.alloc(0) };
    }
    if (fetchMode === '503') {
      return { status: 503, headers: new Headers(), buffer: Buffer.alloc(0) };
    }
    if (fetchMode === 'timeout') {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    if (fetchMode === '403') {
      return { status: 403, headers: new Headers(), buffer: Buffer.alloc(0) };
    }
    return { status: 200, headers: new Headers({ 'content-type': 'application/rss+xml' }), buffer: Buffer.from(page2Xml, 'utf8') };
  };

  // Attempt 1 (initial) -> 429 Retry-After: 5 => retry_wait, retryCount=1, nextRetryAt >= nowTs + 5000
  const r1 = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(r1.status, 'retry_wait');
  assert.equal(r1.retryCount, 1);
  assert.ok(r1.nextRetryAt >= nowTs + 5000);

  // Before nextRetryAt, claimNext returns null
  assert.equal(await backfill.runNext({ now: () => nowTs + 4000, retryBaseMs: 100, fetchBuffer, getSourceById: getSource }), null);

  // Retry 1 -> 503 => retryCount=2
  nowTs += 6000;
  fetchMode = '503';
  const r2 = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(r2.status, 'retry_wait');
  assert.equal(r2.retryCount, 2);

  // Retry 2 -> TimeoutError => retryCount=3
  nowTs += 1000;
  fetchMode = 'timeout';
  const r3 = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(r3.status, 'retry_wait');
  assert.equal(r3.retryCount, 3);

  // Retry 3 -> still failing -> exceeds 3-retry cap -> failed!
  nowTs += 1000;
  const r4 = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(r4.status, 'failed');
  assert.equal(r4.retryCount, 3);

  // Previously fetched 5 entries from page 1 remain preserved
  assert.equal(store.getEntriesBySourceIds([source.id], { limit: 100 }).length, 5);

  // Manual retry resets retryCount, transitions to queued; permanent 403 fails immediately with 0 retries
  const retried1 = backfill.applyAdminBackfillAction(source.id, { action: 'retry' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  assert.equal(retried1.status, 'queued');
  fetchMode = '403';
  const permFail = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(permFail.status, 'failed');
  assert.equal(permFail.retryCount, 0);
  assert.equal(permFail.errorCode, 'ERR_BACKFILL_FORBIDDEN');

  // Manual retry again -> succeeds and reaches provider_archive_exhausted!
  backfill.applyAdminBackfillAction(source.id, { action: 'retry' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  fetchMode = 'ok';
  const done = await backfill.runNext({ now: () => nowTs, retryBaseMs: 100, fetchBuffer, getSourceById: getSource });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.insertedCount, 12);
  assert.equal(store.getEntriesBySourceIds([source.id], { limit: 100 }).length, 17);

  const finalAdmin = backfill.getAdminBackfillStatus(source.id, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  assert.equal(finalAdmin.coverage.status, 'provider_archive_exhausted');
  assert.equal(finalAdmin.coverage.hasGap, false);
});

test('fault injection (pre-tx, post-commit-pre-ack, corrupt snapshot, document capture failure) recovers without skipping or duplicating', async () => {
  const source = createCustomSourceFixture({ feedUrl: 'https://feeds.example/faults.xml' });
  const xml = buildGenericRssXml({ count: 35, startIndex: 0 });
  const buf = Buffer.from(xml, 'utf8');
  const parsed = await backfill.parseFeedBuffer(buf, { baseUrl: source.feedUrl });
  await backfill.discoverFromFeed({ source, feedUrl: source.feedUrl, rawBuffer: buf, xml, feed: parsed.feed });
  const getSource = id => (id === source.id ? source : null);

  // 1) Pre-tx crash on batch 1 (batchSize 10)
  await assert.rejects(
    backfill.runNext({
      batchSize: 10,
      getSourceById: getSource,
      beforeBatchCommit() { throw new Error('simulated pre-tx crash'); },
    }),
    /simulated pre-tx crash/,
  );
  // Nothing committed; checkpoint still at 0; reclaim after lease expiry resumes from 0
  let currentRun = store.sourceBackfill.getLatestRunForSource(source.id);
  assert.equal(currentRun.processedCount, 0);
  const futureNow = () => Date.now() + 120_000;
  const b1 = await backfill.runNext({ batchSize: 10, now: futureNow, getSourceById: getSource });
  assert.equal(b1.processedCount, 10);
  assert.equal(b1.insertedCount, 10);

  // 2) Post-commit pre-ack crash on batch 2
  await assert.rejects(
    backfill.runNext({
      batchSize: 10,
      now: futureNow,
      getSourceById: getSource,
      afterBatchCommitBeforeAck() { throw new Error('simulated post-commit pre-ack crash'); },
    }),
    /simulated post-commit pre-ack crash/,
  );
  // Batch 2 IS committed (processedCount=20); next run resumes from offset 20 without duplicating [10..20)
  currentRun = store.sourceBackfill.getLatestRunForSource(source.id);
  assert.equal(currentRun.processedCount, 20);
  assert.equal(currentRun.insertedCount, 20);

  // 3) Document capture failure on batch 3 -> run fails, does NOT mark succeeded, does NOT advance checkpoint past 20
  const b3Fail = await backfill.runNext({
    batchSize: 10,
    now: futureNow,
    getSourceById: getSource,
    writesVersionedDocuments: () => true,
    captureFeedDocument() { throw new Error('doc capture failure'); },
  });
  assert.equal(b3Fail.status, 'failed');
  assert.equal(b3Fail.errorCode, 'ERR_BACKFILL_ITEM_CAPTURE_FAILED');
  assert.equal(b3Fail.processedCount, 20);

  // Retry after fixing doc capture -> batch 3 completes [20..30)
  backfill.applyAdminBackfillAction(source.id, { action: 'retry' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  const b3Ok = await backfill.runNext({ batchSize: 10, now: futureNow, getSourceById: getSource });
  assert.equal(b3Ok.status, 'running');
  assert.equal(b3Ok.processedCount, 30);
  assert.equal(b3Ok.insertedCount, 30);

  // 4) Missing snapshot on disk before final batch -> fails with ERR_BACKFILL_SNAPSHOT_MISSING, cannot mark succeeded!
  const snapRel = snapshots.relativePath(b3Ok.snapshotHash);
  const snapAbs = path.join(dataDir, ...snapRel.split('/'));
  fs.rmSync(snapAbs, { force: true });
  const b4Missing = await backfill.runNext({ batchSize: 10, now: futureNow, getSourceById: getSource });
  assert.equal(b4Missing.status, 'failed');
  assert.equal(b4Missing.errorCode, 'ERR_BACKFILL_SNAPSHOT_MISSING');

  // Corrupt snapshot on disk after re-pinning -> fails with ERR_BACKFILL_SNAPSHOT_CORRUPT, cannot mark succeeded!
  await snapshots.put(buf);
  fs.writeFileSync(snapAbs, Buffer.from('corrupted-gzip-bytes'));
  backfill.applyAdminBackfillAction(source.id, { action: 'retry' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  const recoverFetch = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/rss+xml' }),
    buffer: buf,
  });
  // First step fails on corrupt existing snapshot? Since previous errorCode was ERR_BACKFILL_SNAPSHOT_MISSING, retry cleared snapshot_hash and re-fetches!
  const b4CorruptCheck = await backfill.runNext({ batchSize: 10, now: futureNow, fetchBuffer: recoverFetch, getSourceById: getSource });
  assert.equal(b4CorruptCheck.processedCount, 10);
  fs.writeFileSync(snapAbs, Buffer.from('corrupted-gzip-bytes'));
  const b4Corrupt = await backfill.runNext({ batchSize: 10, now: futureNow, getSourceById: getSource });
  assert.equal(b4Corrupt.status, 'failed');
  assert.equal(b4Corrupt.errorCode, 'ERR_BACKFILL_SNAPSHOT_CORRUPT');
  assert.notEqual(b4Corrupt.status, 'succeeded');

  // Manual retry when snapshot was corrupt re-fetches from feedUrl, resets run counters so inserted+reused === totalCount without double counting
  backfill.applyAdminBackfillAction(source.id, { action: 'retry' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  const final = await backfill.runNext({ batchSize: 50, now: futureNow, fetchBuffer: recoverFetch, getSourceById: getSource });
  assert.equal(final.status, 'succeeded');
  assert.equal(final.insertedCount + final.reusedCount, final.totalCount);
  assert.equal(store.getEntriesBySourceIds([source.id], { limit: 100 }).length, 35);
});

test('stale run tokens are rejected across pause, archive, source-change, and new run', async () => {
  const source = createCustomSourceFixture({ feedUrl: 'https://feeds.example/tokens.xml' });
  const xml = buildGenericRssXml({ count: 20, startIndex: 0 });
  const buf = Buffer.from(xml, 'utf8');
  const parsed = await backfill.parseFeedBuffer(buf, { baseUrl: source.feedUrl });
  await backfill.discoverFromFeed({ source, feedUrl: source.feedUrl, rawBuffer: buf, xml, feed: parsed.feed });
  const getSource = id => (id === source.id ? source : null);

  // Claim run token 1 and pause mid-step via beforeBatchCommit
  let pauseTriggered = false;
  const res1 = await backfill.runNext({
    batchSize: 5,
    getSourceById: getSource,
    beforeBatchCommit() {
      if (!pauseTriggered) {
        pauseTriggered = true;
        backfill.applyAdminBackfillAction(source.id, { action: 'pause' }, {
          fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
        });
      }
    },
  });
  assert.equal(res1.status, 'stale_run_token');
  assert.equal(store.getEntriesBySourceIds([source.id], { limit: 50 }).length, 0);

  // Resume, then supersede with a new run mid-step -> old token rejected
  backfill.applyAdminBackfillAction(source.id, { action: 'resume' }, {
    fetcherImpl: { getSourceById: getSource, isEnabled: () => true },
  });
  const xml2 = buildGenericRssXml({ count: 10, startIndex: 100 });
  const buf2 = Buffer.from(xml2, 'utf8');
  let newRunTriggered = false;
  const res2 = await backfill.runNext({
    batchSize: 5,
    getSourceById: getSource,
    beforeBatchCommit() {
      if (!newRunTriggered) {
        newRunTriggered = true;
        store.sourceBackfill.enqueueRun({
          sourceId: source.id,
          triggerReason: 'refresh',
          feedUrl: source.feedUrl,
          snapshotHash: crypto.createHash('sha256').update(buf2).digest('hex'),
          snapshotBytes: buf2.length,
          totalCount: 10,
          forceNew: true,
        });
      }
    },
  });
  assert.equal(res2.status, 'stale_run_token');

  // Change source feedUrl mid-step -> old token rejected
  await snapshots.put(buf2);
  let changeTriggered = false;
  const res3 = await backfill.runNext({
    batchSize: 5,
    getSourceById: getSource,
    beforeBatchCommit() {
      if (!changeTriggered) {
        changeTriggered = true;
        store.updateCustomSource(source.id, {
          name: source.name,
          feedUrl: 'https://feeds.example/tokens-v2.xml',
          siteUrl: source.siteUrl,
          category: source.category,
          description: source.description,
          labels: source.labels,
        });
      }
    },
  });
  assert.equal(res3.status, 'stale_run_token');

  // Enqueue and archive mid-step -> old token rejected, source stays archived until explicit restore
  const enq = store.sourceBackfill.enqueueRun({
    sourceId: source.id,
    triggerReason: 'refresh',
    feedUrl: 'https://feeds.example/tokens-v2.xml',
    snapshotHash: crypto.createHash('sha256').update(buf2).digest('hex'),
    snapshotBytes: buf2.length,
    totalCount: 10,
    forceNew: true,
  });
  assert.equal(enq.enqueued, true);
  let archiveTriggered = false;
  const res4 = await backfill.runNext({
    batchSize: 5,
    getSourceById: getSource,
    beforeBatchCommit() {
      if (!archiveTriggered) {
        archiveTriggered = true;
        store.archiveCustomSource(source.id);
      }
    },
  });
  assert.equal(res4.status, 'stale_run_token');
  assert.throws(() => backfill.applyAdminBackfillAction(source.id, { action: 'resume' }, {
    fetcherImpl: { getSourceById: () => null, isEnabled: () => false },
  }), /source must be enabled and not archived/);
});

test('POST action validation rejects unknown actions and disallowed fields', () => {
  const source = createCustomSourceFixture({ feedUrl: 'https://feeds.example/validate.xml' });
  const fetcherStub = { getSourceById: id => (id === source.id ? source : null), isEnabled: () => true };

  assert.throws(() => backfill.applyAdminBackfillAction(source.id, { action: 'pause', url: 'https://evil.example' }, { fetcherImpl: fetcherStub }), /only action is accepted/);
  assert.throws(() => backfill.applyAdminBackfillAction(source.id, { action: 'resume', cursor: 'abc' }, { fetcherImpl: fetcherStub }), /only action is accepted/);
  assert.throws(() => backfill.applyAdminBackfillAction(source.id, { action: 'retry', kind: 'backfill' }, { fetcherImpl: fetcherStub }), /only action is accepted/);
  assert.throws(() => backfill.applyAdminBackfillAction(source.id, { action: 'start' }, { fetcherImpl: fetcherStub }), /pause, resume, or retry/);
});
