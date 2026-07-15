const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const fetcher = require('../lib/fetcher');
const snapshots = require('../lib/source-snapshots');
const { normalizeFeedAuthor, structuredDatePublished } = fetcher;

function stubPublicDns(hostnames) {
  const originalLookup = dns.lookup;
  const allowed = new Set(hostnames);
  dns.lookup = async (hostname, options) => allowed.has(hostname)
    ? [{ address: '93.184.216.34', family: 4 }]
    : originalLookup(hostname, options);
  return () => { dns.lookup = originalLookup; };
}

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

test('YouTube Atom media groups provide the podcast description and thumbnail', async () => {
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example']);
  const feedUrl = 'https://feeds.example/youtube-podcast.xml';
  globalThis.fetch = async input => {
    assert.equal(String(input), feedUrl);
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom"
        xmlns:yt="http://www.youtube.com/xml/schemas/2015"
        xmlns:media="http://search.yahoo.com/mrss/">
        <title>Zhang Xiaojun Podcast</title>
        <entry>
          <id>yt:video:test-video-id</id>
          <yt:videoId>test-video-id</yt:videoId>
          <title>145. 口述 SpaceX 开发史</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=test-video-id"/>
          <author><name>Zhang Xiaojun Podcast</name></author>
          <published>2026-06-12T11:59:49+00:00</published>
          <media:group>
            <media:thumbnail url="https://i.ytimg.com/vi/test-video-id/hqdefault.jpg" width="480" height="360"/>
            <media:description>张小珺与嘉宾的深度访谈节目简介。</media:description>
          </media:group>
        </entry>
      </feed>`, { status: 200, headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
  };
  try {
    const result = await fetcher.fetchSource({
      id: 'youtube-podcast-fixture',
      name: 'YouTube Podcast fixture',
      category: 'podcast',
      enabled: true,
      limit: 10,
      feeds: [feedUrl],
    });
    const entry = result.entries[0];

    assert.equal(result.status, 'ok');
    assert.equal(entry.title, '145. 口述 SpaceX 开发史');
    assert.equal(entry.link, 'https://www.youtube.com/watch?v=test-video-id');
    assert.equal(entry.author, 'Zhang Xiaojun Podcast');
    assert.equal(entry.published, '2026-06-12T11:59:49.000Z');
    assert.match(entry.summary, /张小珺与嘉宾的深度访谈节目简介/);
    assert.match(entry.content, /张小珺与嘉宾的深度访谈节目简介/);
    assert.equal(entry.image, 'https://i.ytimg.com/vi/test-video-id/hqdefault.jpg');
  } finally {
    restoreDns();
    globalThis.fetch = originalFetch;
  }
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

test('legacy reader-submission cache cannot republish an entry missing from SQLite', () => {
  fs.writeFileSync(`${dataDir}/cache.json`, JSON.stringify({
    'user-submitted': {
      fetchedAt: Date.now(),
      status: 'ok',
      entries: [{
        id: 'stale-reader-submission',
        sourceId: 'user-submitted',
        title: 'Must not return from cache',
        link: 'https://example.com/stale-reader-submission',
        author: 'legacy cache',
        published: '2026-07-01T00:00:00.000Z',
        publishedTs: Date.parse('2026-07-01T00:00:00.000Z'),
        summary: 'This row does not exist in SQLite.',
        content: '<p>stale</p>',
      }],
    },
  }));

  fetcher.loadDisk();

  assert.equal(store.getEntry('stale-reader-submission'), null);
  assert.equal(fetcher.getEntries({ sourceId: 'user-submitted', limit: 20 })
    .some(entry => entry.id === 'stale-reader-submission'), false);
});

test('shadow feed refresh captures the normalized entry without changing the legacy read path', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example']);
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  const feedUrl = 'https://feeds.example/pipeline-shadow.xml';
  globalThis.fetch = async input => {
    assert.equal(String(input), feedUrl);
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>Pipeline shadow feed</title>
        <item><title>Shadow feed entry</title><link>https://example.com/shadow-feed-entry</link>
          <guid>shadow-feed-entry</guid><pubDate>Tue, 14 Jul 2026 08:00:00 GMT</pubDate>
          <description><![CDATA[<p>Legacy feed body with enough text for capture.</p>]]></description>
        </item>
      </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  try {
    const result = await fetcher.fetchSource({
      id: 'pipeline-shadow-source',
      name: 'Pipeline shadow source',
      enabled: true,
      limit: 10,
      feeds: [feedUrl],
    });
    const entry = result.entries[0];
    const current = store.getCurrentArticleDocument(entry.id);

    assert.equal(current.provenance, 'feed');
    assert.equal(current.snapshotId, null);
    assert.equal(store.getEntry(entry.id).content, entry.content);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('Paul Graham hydration carries redirected HTTP bytes into a fetched snapshot', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example', 'paulgraham.com']);
  const feedUrl = 'https://feeds.example/paulgraham.xml';
  const articleUrl = 'https://paulgraham.com/start.html';
  const finalUrl = 'https://paulgraham.com/final/essay.html';
  const rawHtml = `<html><head><title>PG evidence essay</title></head><body><table><tr><td width="435">
    <p>${'A durable Paul Graham essay sentence with enough detail. '.repeat(18)}</p>
    <p><a href="notes.html">Evidence notes</a></p>
  </td></tr></table></body></html>`;
  const rawHash = crypto.createHash('sha256').update(rawHtml).digest('hex');
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === feedUrl) {
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>PG</title>
        <item><title>PG evidence essay</title><link>${articleUrl}</link><guid>pg-evidence</guid>
          <pubDate>Tue, 14 Jul 2026 07:00:00 GMT</pubDate><description>Feed teaser</description></item>
      </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    if (url === articleUrl) return new Response(null, { status: 302, headers: { location: finalUrl } });
    assert.equal(url, finalUrl);
    return new Response(rawHtml, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8',
      etag: 'pg-evidence-etag',
    } });
  };
  try {
    const result = await fetcher.fetchSource({
      id: 'paulgraham',
      name: 'Paul Graham',
      enabled: true,
      limit: 5,
      feeds: [feedUrl],
    });
    const entry = result.entries[0];
    const current = store.getCurrentArticleDocument(entry.id);

    assert.equal(current.provenance, 'fetched');
    assert.notEqual(current.snapshotId, null);
    assert.deepEqual(await snapshots.read(rawHash), Buffer.from(rawHtml));
    assert.equal(current.resources.some(resource => resource.url === 'https://paulgraham.com/final/notes.html'), true);
    assert.doesNotMatch(JSON.stringify(result), /responseMeta|bodyPath|rawHash/);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('sitemap page fetch carries redirected HTTP bytes into a fetched snapshot', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['sitemap.example']);
  const sitemapUrl = 'https://sitemap.example/sitemap.xml';
  const articleUrl = 'https://sitemap.example/p/evidence-post';
  const finalUrl = 'https://sitemap.example/final/evidence-post';
  const rawHtml = `<html><head><title>Sitemap evidence post</title></head><body><article>
    <p>${'A sitemap article body with durable source evidence. '.repeat(6)}</p>
    <img src="image.png" alt="Evidence image">
  </article></body></html>`;
  const rawHash = crypto.createHash('sha256').update(rawHtml).digest('hex');
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === sitemapUrl) {
      return new Response(`<urlset><url><loc>${articleUrl}</loc><lastmod>2026-07-14T06:00:00Z</lastmod></url></urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    if (url === articleUrl) return new Response(null, { status: 302, headers: { location: finalUrl } });
    assert.equal(url, finalUrl);
    return new Response(rawHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try {
    const result = await fetcher.fetchSource({
      id: 'sitemap-evidence-source',
      name: 'Sitemap evidence source',
      enabled: true,
      limit: 5,
      feeds: [`sitemap:${sitemapUrl}`],
    });
    const entry = result.entries[0];
    const current = store.getCurrentArticleDocument(entry.id);

    assert.equal(current.provenance, 'fetched');
    assert.notEqual(current.snapshotId, null);
    assert.deepEqual(await snapshots.read(rawHash), Buffer.from(rawHtml));
    assert.equal(current.resources.some(resource => resource.url === 'https://sitemap.example/final/image.png'), true);
    assert.doesNotMatch(JSON.stringify(result), /responseMeta|bodyPath|rawHash/);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('sitemap extraction preserves srcset and lazy data-src images', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['images.example']);
  const sitemapUrl = 'https://images.example/sitemap.xml';
  const articleUrl = 'https://images.example/p/responsive-images';
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === sitemapUrl) {
      return new Response(`<urlset><url><loc>${articleUrl}</loc><lastmod>2026-07-14T06:00:00Z</lastmod></url></urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    assert.equal(url, articleUrl);
    return new Response(`<html><head><title>Responsive image evidence</title></head><body><article>
      <p>${'Article text keeps the readable extraction path active. '.repeat(5)}</p>
      <figure><img srcset="/images/small.jpg 480w, /images/large.jpg 960w" alt="Responsive evidence"></figure>
      <figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/images/lazy.jpg" alt="Lazy evidence"></figure>
    </article></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  try {
    const result = await fetcher.fetchSource({
      id: 'sitemap-responsive-images-source',
      name: 'Sitemap responsive images source',
      enabled: true,
      limit: 5,
      feeds: [`sitemap:${sitemapUrl}`],
    });
    const current = store.getCurrentArticleDocument(result.entries[0].id);
    const resourceUrls = current.resources.map(resource => resource.url);

    assert.equal(resourceUrls.includes('https://images.example/images/small.jpg'), true);
    assert.equal(resourceUrls.includes('https://images.example/images/lazy.jpg'), true);
    assert.match(current.normalizedHtml, /Responsive evidence/);
    assert.match(current.normalizedHtml, /Lazy evidence/);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('shorter sitemap evidence cannot replace the snapshot behind preserved current content', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['provenance.example']);
  const sitemapUrl = 'https://provenance.example/sitemap.xml';
  const articleUrl = 'https://provenance.example/p/durable-post';
  const fullBody = 'First durable article sentence with enough source detail. '.repeat(18);
  const shortBody = 'Replacement response is shorter but still extractable. '.repeat(3);
  const articleHtml = body => `<html><head><title>Durable post</title></head><body><article><p>${body}</p></article></body></html>`;
  const shortRawHtml = articleHtml(shortBody);
  let revision = 'full';
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === sitemapUrl) {
      return new Response(`<urlset><url><loc>${articleUrl}</loc><lastmod>2026-07-14T06:00:00Z</lastmod></url></urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    assert.equal(url, articleUrl);
    const body = revision === 'full' ? fullBody : shortBody;
    return new Response(articleHtml(body), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  try {
    const source = {
      id: 'sitemap-provenance-source',
      name: 'Sitemap provenance source',
      enabled: true,
      limit: 5,
      feeds: [`sitemap:${sitemapUrl}`],
    };
    const firstResult = await fetcher.fetchSource(source);
    const entryId = firstResult.entries[0].id;
    const firstCurrent = store.getCurrentArticleDocument(entryId);
    const beforeStats = store.getVersionedDocumentStats();

    revision = 'short';
    await fetcher.fetchSource(source);

    const persisted = store.getEntry(entryId);
    const current = store.getCurrentArticleDocument(entryId);
    const afterStats = store.getVersionedDocumentStats();
    assert.match(persisted.content, /First durable article sentence/);
    assert.equal(current.snapshotId, firstCurrent.snapshotId);
    assert.match(current.plainText, /First durable article sentence/);
    assert.doesNotMatch(current.plainText, /Replacement response is shorter/);
    assert.equal(afterStats.sourceSnapshots, beforeStats.sourceSnapshots + 1);
    assert.equal(afterStats.articleDocuments, beforeStats.articleDocuments + 1);
    assert.deepEqual(
      await snapshots.read(crypto.createHash('sha256').update(shortRawHtml).digest('hex')),
      Buffer.from(shortRawHtml),
    );
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('Hacker News hydration hashes submitted text, author replies, and discussion independently', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example', 'hacker-news.firebaseio.com', 'hn.algolia.com']);
  const feedUrl = 'https://feeds.example/hackernews.xml';
  let revision = 1;
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === feedUrl) {
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>HN</title>
        <item><title>HN component evidence</title><link>https://example.com/hn-article</link>
          <guid>https://news.ycombinator.com/item?id=9001</guid><comments>https://news.ycombinator.com/item?id=9001</comments>
          <pubDate>Tue, 14 Jul 2026 05:00:00 GMT</pubDate>
          <description><![CDATA[<p><a href="https://news.ycombinator.com/item?id=9001">HN discussion</a> Feed submission context</p>]]></description></item>
      </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    if (url.endsWith('/v0/item/9001.json')) {
      return Response.json({
        id: 9001,
        type: 'story',
        by: 'alice',
        url: 'https://example.com/hn-article',
        text: `<p>Submitted text revision ${revision}</p>`,
        score: 42,
        descendants: 2,
        kids: [9002],
      });
    }
    if (url.endsWith('/v0/item/9002.json')) {
      return Response.json({ id: 9002, type: 'comment', by: 'bob', text: `<p>Discussion revision ${revision}</p>` });
    }
    if (url.startsWith('https://hn.algolia.com/api/v1/search_by_date?')) {
      return Response.json({ hits: [{ objectID: '9003', author: 'alice', comment_text: `<p>Author reply revision ${revision}</p>` }] });
    }
    throw new Error(`unexpected HN fixture URL: ${url}`);
  };
  try {
    const source = { id: 'hackernews', name: 'Hacker News', enabled: true, limit: 5, feeds: [feedUrl] };
    const firstResult = await fetcher.fetchSource(source);
    const first = store.getCurrentArticleDocument(firstResult.entries[0].id);
    revision = 2;
    const secondResult = await fetcher.fetchSource(source);
    const second = store.getCurrentArticleDocument(secondResult.entries[0].id);
    const firstHashes = Object.fromEntries(first.sourceComponents.map(component => [component.type, component.contentHash]));
    const secondHashes = Object.fromEntries(second.sourceComponents.map(component => [component.type, component.contentHash]));

    assert.deepEqual(Object.keys(firstHashes).sort(), ['author-replies', 'discussion-summary', 'feed', 'submitted-text']);
    assert.notEqual(secondHashes['submitted-text'], firstHashes['submitted-text']);
    assert.notEqual(secondHashes['author-replies'], firstHashes['author-replies']);
    assert.notEqual(secondHashes['discussion-summary'], firstHashes['discussion-summary']);
    assert.notEqual(second.documentHash, first.documentHash);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('Hacker News original fetch preserves the structured discussion components', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['hn-original.example']);
  const articleUrl = 'https://hn-original.example/articles/evidence';
  const entry = {
    id: 'hn-original-components-entry',
    sourceId: 'hackernews',
    title: 'HN original component evidence',
    link: articleUrl,
    author: 'alice',
    published: '2026-07-14T05:00:00.000Z',
    publishedTs: Date.parse('2026-07-14T05:00:00.000Z'),
    summary: 'Hacker News discussion context.',
    content: '<article class="hackernews-brief"><h2>Hacker News 线索</h2><p>Discussion marker 9101.</p></article>',
  };
  const discussionComponents = [
    { type: 'submitted-text', content: '<p>Submitted marker 9101.</p>' },
    { type: 'author-replies', content: [{ id: '9102', author: 'alice', text: 'Author reply marker 9102.' }] },
    { type: 'discussion-summary', content: { points: 51, commentsCount: 7, comments: [] } },
  ];
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  store.upsertEntries([entry]);
  await require('../lib/document-pipeline').captureFeed({
    entry: store.getEntry(entry.id),
    sourceComponents: discussionComponents,
  });
  const before = store.getCurrentArticleDocument(entry.id);
  const beforeHashes = Object.fromEntries(before.sourceComponents.map(component => [component.type, component.contentHash]));
  globalThis.fetch = async input => {
    assert.equal(String(input), articleUrl);
    return new Response(`<html><head><title>HN original article</title></head><body><article>
      <p>${'Original article sentence backed by fetched bytes. '.repeat(8)}</p>
    </article></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  try {
    await fetcher.fetchEntryOriginal(store.getEntry(entry.id));
    const current = store.getCurrentArticleDocument(entry.id);
    const currentHashes = Object.fromEntries(current.sourceComponents.map(component => [component.type, component.contentHash]));

    assert.equal(current.provenance, 'fetched');
    assert.notEqual(current.snapshotId, null);
    assert.equal(currentHashes['submitted-text'], beforeHashes['submitted-text']);
    assert.equal(currentHashes['author-replies'], beforeHashes['author-replies']);
    assert.equal(currentHashes['discussion-summary'], beforeHashes['discussion-summary']);
    assert.match(current.plainText, /Original article sentence/);
    assert.match(current.plainText, /Discussion marker 9101/);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
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
  const restoreDns = stubPublicDns(['tldr.tech']);

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
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
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
    const current = store.getCurrentArticleDocument(entry.id);
    assert.equal(current.provenance, 'fetched');
    assert.notEqual(current.snapshotId, null);
  } finally {
    restoreDns();
    globalThis.fetch = originalFetch;
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
  }
});

test('shadow submitted-link fetch captures raw evidence through the fetched seam', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['submitted.example']);
  const submittedUrl = 'https://submitted.example/articles/pipeline';
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    assert.equal(String(input), submittedUrl);
    return new Response(`<!doctype html><html><head><title>Submitted pipeline article</title></head>
      <body><article><h1>Submitted pipeline article</h1><p>${'Durable submitted article evidence. '.repeat(8)}</p></article></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', etag: 'submitted-etag' },
    });
  };
  try {
    const saved = await fetcher.submitLink(submittedUrl, { displayName: 'Pipeline Reader' });
    const current = store.getCurrentArticleDocument(saved.id);

    assert.equal(current.provenance, 'fetched');
    assert.notEqual(current.snapshotId, null);
    assert.equal(store.getEntry(saved.id).content, saved.content);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('metadata-only sources auto-hydrate at most one newest article per refresh', async () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>TLDR AI test</title>
      <item><title>Newest metadata-only issue</title><link>https://tldr.tech/ai/2026-07-13</link><guid>auto-hydrate-newest</guid><pubDate>Mon, 13 Jul 2026 08:00:00 GMT</pubDate></item>
      <item><title>Older metadata-only issue</title><link>https://tldr.tech/ai/2026-07-12</link><guid>auto-hydrate-older</guid><pubDate>Sun, 12 Jul 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const feedUrl = 'https://feeds.example/tldr.xml';
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example', 'tldr.tech']);
  const articleRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === feedUrl) return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
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
    restoreDns();
    globalThis.fetch = originalFetch;
  }
});

test('failed automatic hydration observes the retry cooldown', async () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>OpenAI test</title>
      <item><title>Cooldown metadata-only issue</title><link>https://example.com/auto-hydrate-cooldown</link><guid>auto-hydrate-cooldown</guid><pubDate>Mon, 13 Jul 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const feedUrl = 'https://feeds.example/openai.xml';
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example', 'example.com']);
  const originalWarn = console.warn;
  let articleRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === feedUrl) return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
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
    restoreDns();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
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

test('shadow refresh cannot replace recovered full content with a short feed document', async () => {
  const previousMode = process.env.VERSIONED_TRANSLATION_MODE;
  const originalFetch = globalThis.fetch;
  const restoreDns = stubPublicDns(['feeds.example']);
  const feedUrl = 'https://feeds.example/preserved-document.xml';
  const source = {
    id: 'preserved-document-source',
    name: 'Preserved document source',
    enabled: true,
    limit: 10,
    feeds: [feedUrl],
  };
  process.env.VERSIONED_TRANSLATION_MODE = 'shadow';
  globalThis.fetch = async input => {
    assert.equal(String(input), feedUrl);
    return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Preserved</title>
      <item><title>Preserved document</title><link>https://example.com/preserved-document</link>
        <guid>preserved-document</guid><pubDate>Tue, 14 Jul 2026 08:00:00 GMT</pubDate>
        <description><![CDATA[<p>Short feed teaser.</p>]]></description></item>
    </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };

  try {
    const first = await fetcher.fetchSource(source);
    const entryId = first.entries[0].id;
    const fullBody = `<p>${'Recovered full article sentence. '.repeat(7)}</p>`;
    store.updateEntryContent(entryId, {
      content: fullBody,
      summary: 'Recovered article summary.',
      originalFetched: true,
    });
    const recovered = store.getEntry(entryId);
    await require('../lib/document-pipeline').captureFetched({
      entry: recovered,
      response: {
        requestUrl: recovered.link,
        finalUrl: recovered.link,
        statusCode: 200,
        contentType: 'text/html; charset=utf-8',
        charset: 'utf-8',
        buffer: Buffer.from(`<html><body>${fullBody}</body></html>`),
      },
    });

    await fetcher.fetchSource(source);

    const persisted = store.getEntry(entryId);
    const current = store.getCurrentArticleDocument(entryId);
    assert.match(persisted.content, /Recovered full article sentence/);
    assert.match(current.plainText, /Recovered full article sentence/);
    assert.doesNotMatch(current.plainText, /Short feed teaser/);
  } finally {
    restoreDns();
    process.env.VERSIONED_TRANSLATION_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});
