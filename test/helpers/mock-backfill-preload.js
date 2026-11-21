const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_BACKFILL_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_BACKFILL_AI_CAPTURE_PATH || '').trim();
const statePath = String(process.env.MOCK_BACKFILL_STATE_PATH || '').trim();

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(next));
}

function record(url) {
  if (!capturePath) return;
  let state = { requests: [] };
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first */ }
  state.requests.push({ url, at: Date.now() });
  fs.writeFileSync(capturePath, JSON.stringify(state));
}

function recordAi(url, init) {
  if (!aiCapturePath) return;
  let state = { calls: [] };
  try { state = JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')); } catch { /* first */ }
  let payload = {};
  try { payload = JSON.parse(String(init && init.body || '{}')); } catch { /* ignore */ }
  state.calls.push({ url, model: payload.model || '', messages: payload.messages || [] });
  fs.writeFileSync(aiCapturePath, JSON.stringify(state));
}

dns.lookup = async (hostname, options) => {
  const host = String(hostname || '').toLowerCase();
  if ([
    'catalog-fixtures.example',
    'wechat2rss.bestblogs.dev',
    'other-rss.example',
    'podcast-rss.example',
    'mock-backfill-ai.example',
  ].includes(host)) {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function buildWechatItems({ count, startIdx, titlePrefix = 'WeChat Historical' }) {
  const baseTs = Date.UTC(2026, 2, 1, 12, 0, 0);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const idx = startIdx + i;
    const pubDate = new Date(baseTs - idx * 3600 * 1000).toUTCString();
    const longBody = `WeChat feed excerpt item ${idx} used to verify zero automatic AI and pagination. `.repeat(6);
    items.push(`<item>
      <title>${titlePrefix} #${idx}</title>
      <link>https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=${5000 + idx}&amp;idx=1&amp;sn=bf${idx}</link>
      <guid isPermaLink="false">wechat:MzA1:${5000 + idx}:1</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[Summary for ${idx}]]></description>
      <content:encoded><![CDATA[<p>${longBody}</p>]]></content:encoded>
    </item>`);
  }
  return items.join('\n');
}

function buildGenericRss({ title, itemsXml, nextUrl = '', complete = false }) {
  const ns = complete ? 'xmlns:fh="http://purl.org/syndication/history/1.0" ' : '';
  const nextTag = nextUrl ? `<atom:link rel="next" href="${nextUrl}" />` : '';
  const completeTag = complete ? '<fh:complete />' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" ${ns}>
  <channel>
    <title>${title}</title>
    <link>https://podcast-rss.example/</link>
    <description>Fixture feed</description>
    ${nextTag}
    ${completeTag}
    ${itemsXml}
  </channel>
</rss>`;
}

function buildPodcastItems({ count, startIdx }) {
  const baseTs = Date.UTC(2026, 1, 15, 8, 0, 0);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const idx = startIdx + i;
    const pubDate = new Date(baseTs - idx * 86400 * 1000).toUTCString();
    items.push(`<item>
      <title>Podcast Episode #${idx}</title>
      <link>https://podcast-rss.example/ep/${idx}</link>
      <guid isPermaLink="false">pod-ep-${idx}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[Show notes for episode ${idx}]]></description>
      <content:encoded><![CDATA[<p>Detailed show notes for podcast episode ${idx}.</p>]]></content:encoded>
      <enclosure url="https://cdn.podcast-rss.example/ep-${idx}.mp3" length="4096000" type="audio/mpeg" />
    </item>`);
  }
  return items.join('\n');
}

const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ...headers },
  });
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  record(url);
  const parsed = new URL(url);
  const state = readState();

  if (parsed.hostname === 'catalog-fixtures.example') {
    return textResponse(fixtureOpml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  }

  if (parsed.hostname === 'wechat2rss.bestblogs.dev') {
    if (parsed.pathname === '/feed/archive-page-2.xml') {
      const mode = state.wechatArchiveMode || 'ok';
      if (mode === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (mode === 'oversize') {
        return textResponse('x'.repeat(5 * 1024 * 1024 + 100), 200);
      }
      if (mode === 'ssrf-redirect') {
        return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:1/secret' } });
      }
      const itemsXml = buildWechatItems({ count: 25, startIdx: 100, titlePrefix: 'WeChat Archive Page2' });
      return textResponse(buildGenericRss({
        title: '人人都是产品经理',
        itemsXml,
        complete: Boolean(state.wechatArchiveComplete),
      }));
    }

    const extraOlder = Number(state.wechatExtraOlderCount) || 0;
    const count = 85 + extraOlder;
    const itemsXml = buildWechatItems({ count, startIdx: 0 });
    return textResponse(buildGenericRss({
      title: '人人都是产品经理',
      itemsXml,
      nextUrl: state.wechatNextUrl || '',
    }));
  }

  if (parsed.hostname === 'other-rss.example') {
    const seq = Number(state.otherRefreshSeq) || 1;
    const itemsXml = `<item>
      <title>Concurrent Fresh News #${seq}</title>
      <link>https://other-rss.example/news/${seq}</link>
      <guid isPermaLink="false">other-news-${seq}</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[Fresh item during backfill]]></description>
    </item>`;
    return textResponse(buildGenericRss({ title: 'Other Fast Source', itemsXml }));
  }

  if (parsed.hostname === 'podcast-rss.example') {
    if (parsed.pathname === '/archive-2.xml') {
      const seq = Array.isArray(state.podcastArchiveResponses) ? state.podcastArchiveResponses : [];
      if (seq.length) {
        const nextAction = seq.shift();
        writeState({ ...state, podcastArchiveResponses: seq });
        if (nextAction === '429') return textResponse('rate limited', 429, { 'Retry-After': '1' });
        if (nextAction === '503') return textResponse('unavailable', 503);
        if (nextAction === '403') return textResponse('forbidden', 403);
        if (nextAction === 'oversize') return textResponse('x'.repeat(5 * 1024 * 1024 + 64), 200);
        if (nextAction === 'ssrf') return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:1/private' } });
      }
      const itemsXml = buildPodcastItems({ count: 15, startIdx: 20 });
      return textResponse(buildGenericRss({ title: 'Podcast Fixture', itemsXml, complete: true }));
    }
    const itemsXml = buildPodcastItems({ count: 10, startIdx: 0 });
    return textResponse(buildGenericRss({
      title: 'Podcast Fixture',
      itemsXml,
      nextUrl: 'https://podcast-rss.example/archive-2.xml',
    }));
  }

  if (parsed.hostname === 'mock-backfill-ai.example') {
    recordAi(url, init);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"translations":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('unexpected host', { status: 599 });
};
