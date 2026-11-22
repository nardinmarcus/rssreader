const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_BANNATIE_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_BANNATIE_AI_CAPTURE_PATH || '').trim();
const statePath = String(process.env.MOCK_BANNATIE_STATE_PATH || '').trim();

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function recordRequest(url, init) {
  if (!capturePath) return;
  let state = { requests: [] };
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first */ }
  const rawHeaders = (init && init.headers) || {};
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    normalizedHeaders[k.toLowerCase()] = String(v);
  }
  state.requests.push({ url, headers: normalizedHeaders, at: Date.now() });
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
    'proxy.wavpub.com',
    'other-rss.example',
    'api.deepseek.com',
  ].includes(host)) {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function buildBannatieFeedXml({
  episodeCount = 240,
  targetBytes = 5.5 * 1024 * 1024,
  title = '半拿铁 | 商业沉浮录',
  podcastGuid = '37bcf640-2690-47fd-9a87-01f31e593d49',
  extraNewest = false,
} = {}) {
  const baseTs = Date.UTC(2026, 10, 18, 12, 0, 0);
  const perItemPadSize = Math.max(200, Math.floor((targetBytes - 4096) / Math.max(1, episodeCount)) - 720);
  const padChunk = '商业案例复盘与史料时间线：从创业起点、组织演化、供应链调整到周期转折的真实记录。'.repeat(
    Math.max(1, Math.ceil(perItemPadSize / 120)),
  );
  const items = [];
  if (extraNewest) {
    const futureTs = Date.now() + 60 * 60 * 1000;
    items.push(`<item>
      <wavpub:guid>new-guid-241</wavpub:guid>
      <link>https://www.ximalaya.com/sound/2000000241</link>
      <title><![CDATA[No.241 新增一集：公司治理长周期复盘]]></title>
      <description><![CDATA[<p>主播 | 潇磊 刘飞</p><p>${padChunk.slice(0, 600)}</p>]]></description>
      <enclosure url="https://tk.wavpub.com/WPTK_TEST_NEW_241.m4a" length="123456789" type="audio/x-m4a"/>
      <guid isPermaLink="false">xmly_track_2000000241</guid>
      <pubDate>${new Date(futureTs).toUTCString()}</pubDate>
      <itunes:duration>4200</itunes:duration>
    </item>`);
  }
  for (let i = 0; i < episodeCount; i += 1) {
    const num = episodeCount - 1 - i;
    const trackId = 514191286 + num * 1000;
    const pubDate = new Date(baseTs - i * 3 * 24 * 3600 * 1000).toUTCString();
    const token = `WPTK_${String(num).padStart(4, '0')}_fixture`;
    items.push(`<item>
      <wavpub:guid>0f4b26b4-1574-4755-8aa9-${String(num).padStart(12, '0')}</wavpub:guid>
      <link>https://www.ximalaya.com/sound/${trackId}</link>
      <title><![CDATA[No.${num} 商业故事与案例研究第 ${num} 期]]></title>
      <description><![CDATA[<p>主播 | 潇磊 刘飞</p><p>节目说明第 ${num} 期：${padChunk}</p>]]></description>
      <enclosure url="https://tk.wavpub.com/${token}.m4a" length="155401471" type="audio/x-m4a"/>
      <media:content type="audio/x-m4a" url="https://tk.wavpub.com/${token}.m4a"/>
      <guid isPermaLink="false">xmly_track_${trackId}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>3888</itunes:duration>
      <itunes:episode>${i + 1}</itunes:episode>
    </item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:wavpub="https://wav.pub/ns/1.0">
  <channel>
    <generator>WavPub 3.0</generator>
    <wavpub:version>3.0</wavpub:version>
    <podcast:license url="https://wav.pub/copyright/podcast-license-v2">wavpub-podcast-license-v2</podcast:license>
    <podcast:guid>${podcastGuid}</podcast:guid>
    <atom:link rel="self" type="application/rss+xml" href="https://proxy.wavpub.com/caffebreve.xml"/>
    <link>https://www.ximalaya.com/album/60629838</link>
    <title><![CDATA[${title}]]></title>
    <description><![CDATA[<p>商业不枯燥，来杯半拿铁，边喝边唠。</p>]]></description>
    <language>zh-cn</language>
    <itunes:author>潇磊&amp;刘飞</itunes:author>
    <copyright><![CDATA[半拿铁@喜马拉雅FM]]></copyright>
    ${items.join('\n')}
  </channel>
</rss>`;
}

const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');
let cachedLargeFeedXml = null;

function getLargeFeedXml() {
  if (!cachedLargeFeedXml) {
    cachedLargeFeedXml = buildBannatieFeedXml({ episodeCount: 240, targetBytes: 5.5 * 1024 * 1024 });
  }
  return cachedLargeFeedXml;
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  recordRequest(url, init);
  const parsed = new URL(url);
  const state = readState();

  if (parsed.hostname === 'catalog-fixtures.example') {
    return new Response(fixtureOpml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
  }

  if (parsed.hostname === 'proxy.wavpub.com' && parsed.pathname === '/caffebreve.xml') {
    const mode = state.mode || 'ok';
    const etag = state.etag || '"bannatie-etag-v1"';
    const lastModified = state.lastModified || 'Thu, 19 Nov 2026 05:46:14 GMT';
    const cacheControl = state.cacheControl || 'public, max-age=1800';

    if (mode === 'ssrf-redirect') {
      return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:1/private.xml' } });
    }
    if (mode === 'oversize-16m') {
      const tooBig = 'x'.repeat(16 * 1024 * 1024 + 1024);
      return new Response(tooBig, {
        status: 200,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(tooBig)),
        },
      });
    }
    if (mode === 'mismatch-podcast') {
      const xml = buildBannatieFeedXml({
        episodeCount: 5,
        targetBytes: 12000,
        title: '完全不相干的另一个播客',
        podcastGuid: '99999999-9999-4999-8999-999999999999',
      });
      return new Response(xml, {
        status: 200,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          ETag: '"mismatch-etag"',
          'Cache-Control': 'public, max-age=1800',
        },
      });
    }

    const reqHeaders = (init && init.headers) || {};
    const ifNoneMatch = reqHeaders['If-None-Match'] || reqHeaders['if-none-match'] || '';
    if (mode === 'conditional-304' || (ifNoneMatch && ifNoneMatch === etag && state.allow304)) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
        },
      });
    }

    const xml = mode === 'new-episode'
      ? buildBannatieFeedXml({ episodeCount: 240, targetBytes: 5.5 * 1024 * 1024, extraNewest: true })
      : getLargeFeedXml();
    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(xml)),
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
      },
    });
  }

  if (parsed.hostname === 'other-rss.example') {
    if (state.otherOversize) {
      const oversized = 'x'.repeat(5 * 1024 * 1024 + 512);
      return new Response(oversized, {
        status: 200,
        headers: {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(oversized)),
        },
      });
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Ordinary Feed</title><link>https://other-rss.example/</link>
<item><title>Ordinary Item</title><link>https://other-rss.example/1</link><guid>ord-1</guid><pubDate>${new Date().toUTCString()}</pubDate><description>Hello</description></item>
</channel></rss>`;
    return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
  }

  if (parsed.hostname === 'api.deepseek.com') {
    recordAi(url, init);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"translations":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('unexpected host', { status: 599 });
};
