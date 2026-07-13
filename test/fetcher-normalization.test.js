const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const fetcher = require('../lib/fetcher');
const { normalizeFeedAuthor, structuredDatePublished } = fetcher;

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('feed author objects and arrays become SQLite-safe text', () => {
  assert.equal(normalizeFeedAuthor({
    name: ['Philipp Schmid'],
    title: ['Developer Relations Engineer'],
  }), 'Philipp Schmid');
  assert.equal(normalizeFeedAuthor(['Alice', { name: ['Bob'] }]), 'Alice、Bob');
  assert.equal(normalizeFeedAuthor(null), '');
});

test('embedded article publication date wins over CMS update metadata', () => {
  const html = String.raw`self.__next_f.push([1,"{\"_createdAt\":\"2025-02-24T14:37:19Z\",\"_updatedAt\":\"2026-07-03T10:15:42Z\",\"publishedOn\":\"2025-02-24T14:38:00.000Z\"}"])`;

  assert.equal(structuredDatePublished(html), '2025-02-24T14:38:00.000Z');
});

test('SQLite remains the article and source-count truth when cache.json is empty', () => {
  store.upsertEntries([{
    id: 'sqlite-only-entry',
    sourceId: 'openai',
    title: 'SQLite survives an empty runtime cache',
    link: 'https://example.com/sqlite-entry',
    author: 'Namoo',
    published: '2026-07-11T00:00:00.000Z',
    publishedTs: Date.parse('2026-07-11T00:00:00.000Z'),
    summary: 'The persisted article must remain visible without cache.json.',
    content: '<p>Persisted content</p>',
  }]);

  fetcher.loadDisk({ upsert: false });
  const entries = fetcher.getEntries({ limit: 5 });
  const openai = fetcher.getSourcesMeta().find(source => source.id === 'openai');
  assert.equal(entries.some(entry => entry.id === 'sqlite-only-entry'), true);
  assert.equal(openai.entryCount, 1);
  assert.equal(openai.status, 'cached');
});

test('TLDR original fetch preserves every newsletter article in page order', async () => {
  const entry = {
    id: 'tldr-metadata-only-entry',
    sourceId: 'tldrai',
    title: 'TLDR metadata-only issue',
    link: 'https://tldr.tech/ai/2026-07-06',
    published: '2026-07-06T00:00:00.000Z',
    publishedTs: Date.parse('2026-07-06T00:00:00.000Z'),
    summary: '',
    content: '',
  };
  store.upsertEntries([entry]);

  const html = `<!doctype html><html><body>
    <div class="content-center max-w-xl mt-5">
      <section><h2>Headlines and Launches</h2>
        <article class="mt-3"><h3>Seedance 2.5</h3><p>First editorial section with enough useful detail for readers. It explains the product update, the relevant context, and why the change matters to practitioners.</p></article>
        <article class="mt-3"><h3>Partner update (Sponsor)</h3><p>Sponsored section remains explicitly labelled. It contains a complete partner description, supporting context, and a clear disclosure for the reader.</p></article>
      </section>
      <section><h2>Deep Dives and Guides</h2>
        <article class="mt-3"><h3>Field Guide to Fable</h3><p>Final editorial section must remain after the sponsor. It provides a practical guide, several concrete details, and an ending that proves page order is preserved.</p></article>
      </section>
    </div>
  </body></html>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.equal(String(input), entry.link);
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
  };

  try {
    const updated = await fetcher.fetchEntryOriginal(store.getEntry(entry.id));
    assert.match(updated.content, /Headlines and Launches/);
    assert.match(updated.content, /Deep Dives and Guides/);
    assert.match(updated.content, /Seedance 2\.5/);
    assert.match(updated.content, /Partner update \(Sponsor\)/);
    assert.match(updated.content, /Field Guide to Fable/);
    assert.ok(updated.content.indexOf('Seedance 2.5') < updated.content.indexOf('Partner update (Sponsor)'));
    assert.ok(updated.content.indexOf('Partner update (Sponsor)') < updated.content.indexOf('Field Guide to Fable'));
    assert.match(updated.summary, /Seedance 2\.5/);
    assert.doesNotMatch(updated.summary, /Sponsor/);
    assert.equal(updated.originalFetchedAt > 0, true);
    assert.equal(store.getEntry(entry.id).content, updated.content);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metadata-only sources auto-hydrate at most one newest article per refresh', async () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>TLDR AI test</title>
      <item><title>Newest metadata-only issue</title><link>https://tldr.tech/ai/2026-07-13</link><guid>auto-hydrate-newest</guid><pubDate>Mon, 13 Jul 2026 08:00:00 GMT</pubDate></item>
      <item><title>Older metadata-only issue</title><link>https://tldr.tech/ai/2026-07-12</link><guid>auto-hydrate-older</guid><pubDate>Sun, 12 Jul 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(feed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`;
  const originalFetch = globalThis.fetch;
  const articleRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === feedUrl) return originalFetch(input, init);
    articleRequests.push(url);
    return new Response(`<!doctype html><div class="content-center max-w-xl mt-5"><section><h2>Headlines</h2><article><h3>Recovered article</h3><p>This original page contains enough editorial detail to qualify as useful article content and prove that controlled hydration persisted the newest metadata-only entry.</p></article></section></div>`, { status: 200 });
  };

  try {
    const result = await fetcher.fetchSource({
      id: 'tldrai',
      name: 'TLDR AI test',
      enabled: true,
      limit: 10,
      feeds: [feedUrl],
    });
    assert.deepEqual(articleRequests, ['https://tldr.tech/ai/2026-07-13']);
    const newest = result.entries.find(entry => entry.link === articleRequests[0]);
    const older = result.entries.find(entry => entry.link === 'https://tldr.tech/ai/2026-07-12');
    assert.equal(newest.originalFetchedAt > 0, true);
    assert.match(newest.content, /Recovered article/);
    assert.equal(older.content, '');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed automatic hydration observes the retry cooldown', async () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>OpenAI test</title>
      <item><title>Cooldown metadata-only issue</title><link>https://example.com/auto-hydrate-cooldown</link><guid>auto-hydrate-cooldown</guid><pubDate>Mon, 13 Jul 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(feed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const feedUrl = `http://127.0.0.1:${server.address().port}/feed.xml`;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let articleRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === feedUrl) return originalFetch(input, init);
    articleRequests += 1;
    throw new Error('synthetic upstream failure');
  };
  console.warn = () => {};
  const source = { id: 'openai', name: 'OpenAI test', enabled: true, limit: 10, feeds: [feedUrl] };

  try {
    await fetcher.fetchSource(source);
    const second = await fetcher.fetchSource(source);
    assert.equal(articleRequests, 1);
    assert.match(second.entries[0].originalFetchError, /synthetic upstream failure/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    await new Promise(resolve => server.close(resolve));
  }
});

test('RSS refresh cannot erase content that was recovered from the original page', () => {
  const entry = {
    id: 'preserve-recovered-content',
    sourceId: 'openai',
    title: 'Preserve recovered content',
    link: 'https://example.com/preserve-recovered-content',
    publishedTs: Date.now(),
    summary: '',
    content: '',
  };
  store.upsertEntries([entry]);
  store.updateEntryContent(entry.id, {
    content: `<p>${'Recovered sentence. '.repeat(7)}</p>`,
    originalFetched: true,
  });

  store.upsertEntries([{ ...entry, content: '' }]);

  const persisted = store.getEntry(entry.id);
  assert.equal(persisted.originalFetchedAt > 0, true);
  assert.match(persisted.content, /Recovered sentence/);
});
