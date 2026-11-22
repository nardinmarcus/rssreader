const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const realFetch = globalThis.fetch;
const capturePath = String(process.env.MOCK_CROSS_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_CROSS_AI_CAPTURE_PATH || '').trim();
const statePath = String(process.env.MOCK_CROSS_STATE_PATH || '').trim();

const MOCKED_HOSTS = new Set([
  'catalog-fixtures.example',
  'wechat2rss.bestblogs.dev',
  'feed.xyzfm.space',
  'www.xiaoyuzhoufm.com',
  'media.xyzcdn.net',
  'podcast.latepost.com',
  'feeds.fireside.fm',
  'aphid.fireside.fm',
  'proxy.wavpub.com',
  'tk.wavpub.com',
  'other-rss.example',
  'mock-cross-ai.example',
]);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function appendJsonArray(filePath, key, item) {
  if (!filePath) return;
  let state = { [key]: [] };
  try { state = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* first entry */ }
  if (!Array.isArray(state[key])) state[key] = [];
  state[key].push(item);
  fs.writeFileSync(filePath, JSON.stringify(state));
}

function recordRequest(url) {
  appendJsonArray(capturePath, 'requests', { url, at: Date.now() });
}

function recordAi(url, payload) {
  appendJsonArray(aiCapturePath, 'calls', {
    url,
    model: payload && payload.model || '',
    messages: payload && payload.messages || [],
    at: Date.now(),
  });
}

dns.lookup = async (hostname, options) => {
  const host = String(hostname || '').toLowerCase();
  if (MOCKED_HOSTS.has(host)) {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ...headers },
  });
}

function buildWechatRss({ count = 85, startIdx = 0, titlePrefix = 'WeChat Historical Report', nextUrl = '', complete = false } = {}) {
  const baseTs = Date.UTC(2026, 2, 1, 12, 0, 0);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const idx = startIdx + i;
    const pubDate = new Date(baseTs - idx * 3600 * 1000).toUTCString();
    const body = `WeChat historical research analysis item ${idx} for cross-source verification and zero auto-AI enforcement. `.repeat(6);
    items.push(`<item>
      <title>${titlePrefix} #${idx} - Deep Tech Analysis</title>
      <link>https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=${6000 + idx}&amp;idx=1&amp;sn=cs${idx}</link>
      <guid isPermaLink="false">wechat:MzA1:${6000 + idx}:1</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[Summary for WeChat item ${idx}]]></description>
      <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>
    </item>`);
  }
  const ns = complete ? 'xmlns:fh="http://purl.org/syndication/history/1.0" ' : '';
  const nextTag = nextUrl ? `<atom:link rel="next" href="${nextUrl}" />` : '';
  const completeTag = complete ? '<fh:complete />' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" ${ns}>
  <channel>
    <title>人人都是产品经理</title>
    <link>https://wechat2rss.bestblogs.dev/account/MzA1</link>
    <description>人人都是产品经理公众号订阅</description>
    ${nextTag}
    ${completeTag}
    ${items.join('\n')}
  </channel>
</rss>`;
}

function buildXyzfmRss({ title, pid, author, count = 40 } = {}) {
  const baseTs = Date.UTC(2026, 8, 1, 12, 0, 0);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const eid = `${pid.slice(0, 8)}ep${String(i).padStart(14, '0')}`;
    const pubDate = new Date(baseTs - i * 86400 * 1000).toUTCString();
    items.push(`<item>
      <title>${title} Ep.${count - i} - AI &amp; Tech Interview #${i}</title>
      <link>https://www.xiaoyuzhoufm.com/episode/${eid}?utm_source=rss</link>
      <guid isPermaLink="false">${eid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[<p>Show notes for ${title} episode ${i}. Discussing engineering and product strategy in depth.</p>]]></description>
      <enclosure url="https://media.xyzcdn.net/${pid}/${eid}.m4a" length="10240000" type="audio/mp4" />
    </item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${title}</title>
    <link>https://www.xiaoyuzhoufm.com/podcast/${pid}</link>
    <description>${title} 官方公开播客订阅</description>
    <itunes:author>${author}</itunes:author>
    ${items.join('\n')}
  </channel>
</rss>`;
}

function buildLatetalkRss({ count = 65 } = {}) {
  const baseTs = Date.UTC(2026, 10, 19, 0, 0, 0);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const epNum = count - i;
    const pubDate = new Date(baseTs - i * 86400 * 1000).toUTCString();
    const notes = `第 ${epNum} 期晚点聊节目说明（Show Notes）与深度访谈纪要，包含足够文本长度以验证历史禁止自动 AI。 `.repeat(5);
    items.push(`<item>
      <title>${epNum}: LateTalk Episode - Tech &amp; Industry</title>
      <link>https://podcast.latepost.com/${epNum}</link>
      <guid isPermaLink="false">latetalk-guid-${epNum}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:author>晚点 LatePost</itunes:author>
      <description><![CDATA[Summary for LateTalk ${epNum}]]></description>
      <content:encoded><![CDATA[<p>${notes}</p>]]></content:encoded>
      <enclosure url="https://aphid.fireside.fm/d/1437767933/latetalk/ep-${epNum}.mp3" length="4567890" type="audio/mpeg" />
    </item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>晚点聊 LateTalk</title>
    <link>https://podcast.latepost.com</link>
    <description>晚点LatePost 出品的对话节目</description>
    <itunes:author>晚点 LatePost</itunes:author>
    ${items.join('\n')}
  </channel>
</rss>`;
}

let cachedBannatieXml = null;
function buildBannatieRss({ episodeCount = 240, targetBytes = 5.4 * 1024 * 1024 } = {}) {
  if (cachedBannatieXml && episodeCount === 240) return cachedBannatieXml;
  const baseTs = Date.UTC(2026, 10, 18, 12, 0, 0);
  const perItemPadSize = Math.max(200, Math.floor((targetBytes - 4096) / Math.max(1, episodeCount)) - 700);
  const padChunk = '商业案例复盘与史料时间线：从创业起点、组织演化、供应链调整到周期转折的真实记录。'.repeat(
    Math.max(1, Math.ceil(perItemPadSize / 120)),
  );
  const items = [];
  for (let i = 0; i < episodeCount; i += 1) {
    const num = episodeCount - 1 - i;
    const trackId = 514191286 + num * 1000;
    const pubDate = new Date(baseTs - i * 3 * 24 * 3600 * 1000).toUTCString();
    const token = `WPTK_${String(num).padStart(4, '0')}_cross`;
    items.push(`<item>
      <wavpub:guid>0f4b26b4-1574-4755-8aa9-${String(num).padStart(12, '0')}</wavpub:guid>
      <link>https://www.ximalaya.com/sound/${trackId}</link>
      <title><![CDATA[No.${num} 商业故事与案例研究第 ${num} 期 - Business History]]></title>
      <description><![CDATA[<p>主播 | 潇磊 刘飞</p><p>节目说明第 ${num} 期：${padChunk}</p>]]></description>
      <enclosure url="https://tk.wavpub.com/${token}.m4a" length="155401471" type="audio/x-m4a"/>
      <guid isPermaLink="false">xmly_track_${trackId}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>3888</itunes:duration>
    </item>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wavpub="https://wav.pub/ns/1.0">
  <channel>
    <generator>WavPub 3.0</generator>
    <podcast:license url="https://wav.pub/copyright/podcast-license-v2">wavpub-podcast-license-v2</podcast:license>
    <podcast:guid>37bcf640-2690-47fd-9a87-01f31e593d49</podcast:guid>
    <atom:link rel="self" type="application/rss+xml" href="https://proxy.wavpub.com/caffebreve.xml"/>
    <link>https://www.ximalaya.com/album/60629838</link>
    <title><![CDATA[半拿铁 | 商业沉浮录]]></title>
    <description><![CDATA[<p>商业不枯燥，来杯半拿铁，边喝边唠。</p>]]></description>
    <itunes:author>潇磊&amp;刘飞</itunes:author>
    ${items.join('\n')}
  </channel>
</rss>`;
  if (episodeCount === 240) cachedBannatieXml = xml;
  return xml;
}

const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');

function buildMockAiResponse(payload) {
  const sys = String(payload && payload.messages && payload.messages[0] && payload.messages[0].content || '');
  const userContent = String(payload && payload.messages && payload.messages.at(-1) && payload.messages.at(-1).content || '');
  if (sys.includes('"schemaVersion":2')) {
    let parsedInput = {};
    try { parsedInput = JSON.parse(userContent); } catch { parsedInput = {}; }
    const segments = Array.isArray(parsedInput.segments) ? parsedInput.segments : [];
    return JSON.stringify({
      schemaVersion: 2,
      translations: segments.map(seg => ({
        id: seg.id,
        target: seg.role === 'title' ? '人工翻译标题' : `人工译文 ${String(seg.id || '').slice(0, 8)}`,
      })),
    });
  }
  if (sys.includes('标题翻译助手')) {
    const matches = Array.from(userContent.matchAll(/^id=([^\n]+)\ntitle=([^\n]+)/gm));
    return JSON.stringify({
      translations: matches.map(m => ({ id: m[1], titleZh: `中文标题：${m[2].slice(0, 24)}` })),
    });
  }
  if (sys.includes('英文到中文文章翻译助手')) {
    const indexes = Array.from(userContent.matchAll(/^i=(\d+)$/gm), m => Number(m[1]));
    return JSON.stringify({
      titleZh: '人工操作测试译名',
      summaryZh: '人工操作测试摘要',
      blocks: indexes.map(i => ({ i, target: `人工操作译文 ${i}`, targetHtml: `<p>人工操作译文 ${i}</p>` })),
    });
  }
  return '{"translations":[]}';
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    return realFetch(input, init);
  }
  recordRequest(url);
  const state = readState();

  if (parsed.hostname === 'catalog-fixtures.example') {
    return textResponse(fixtureOpml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  }

  if (parsed.hostname === 'wechat2rss.bestblogs.dev') {
    if (parsed.pathname === '/feed/archive-page-2.xml') {
      if (state.wechatArchiveDelayMs) {
        await new Promise(resolve => setTimeout(resolve, Number(state.wechatArchiveDelayMs)));
      }
      return textResponse(buildWechatRss({ count: 25, startIdx: 100, titlePrefix: 'WeChat Archive Page2', complete: Boolean(state.wechatArchiveComplete) }));
    }
    return textResponse(buildWechatRss({
      count: Number(state.wechatCount) || 85,
      startIdx: 0,
      nextUrl: state.wechatNextUrl || '',
    }));
  }

  if (parsed.hostname === 'feed.xyzfm.space') {
    if (parsed.pathname === '/dk4yh3pkpjp3') {
      if (state.xiaojunMode === '403') return textResponse('forbidden', 403);
      return textResponse(buildXyzfmRss({
        title: '张小珺Jùn｜商业访谈录',
        pid: '626b46ea9cbbf0451cf5a962',
        author: '张小珺',
        count: Number(state.xiaojunCount) || 40,
      }));
    }
    if (parsed.pathname === '/evgg6xle9rdc') {
      if (state.fortyTwoMode === '403') return textResponse('forbidden', 403);
      return textResponse(buildXyzfmRss({
        title: '42章经',
        pid: '648b0b641c48983391a63f98',
        author: '曲凯',
        count: Number(state.fortyTwoCount) || 38,
      }));
    }
  }

  if (parsed.hostname === 'podcast.latepost.com' && parsed.pathname === '/rss') {
    return new Response('', {
      status: 302,
      headers: { Location: 'https://feeds.fireside.fm/latetalk/rss' },
    });
  }

  if (parsed.hostname === 'feeds.fireside.fm' && parsed.pathname === '/latetalk/rss') {
    return textResponse(buildLatetalkRss({ count: Number(state.latetalkCount) || 65 }));
  }

  if (parsed.hostname === 'aphid.fireside.fm') {
    return new Response(Buffer.from('ID3mockaudio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '12' },
    });
  }

  if (parsed.hostname === 'www.xiaoyuzhoufm.com' && parsed.pathname === '/podcast/61933ace1b4320461e91fd55') {
    const nextData = JSON.stringify({
      props: { pageProps: { podcast: { pid: '61933ace1b4320461e91fd55', title: '晚点聊 LateTalk', episodeCount: 189 } } },
    });
    return textResponse(`<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`, 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  if (parsed.hostname === 'proxy.wavpub.com' && parsed.pathname === '/caffebreve.xml') {
    if (state.bannatieDelayMs) {
      await new Promise(resolve => setTimeout(resolve, Number(state.bannatieDelayMs)));
    }
    return textResponse(buildBannatieRss({ episodeCount: Number(state.bannatieCount) || 240 }));
  }

  if (parsed.hostname === 'other-rss.example') {
    const seq = Number(state.otherRefreshSeq) || 1;
    const itemsXml = `<item>
      <title>Concurrent Ordinary Tech Update #${seq}</title>
      <link>https://other-rss.example/news/${seq}</link>
      <guid isPermaLink="false">other-news-${seq}</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[Fresh ordinary news item ${seq} published after startup for concurrent refresh verification.]]></description>
    </item>`;
    return textResponse(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Other Fast Source</title><link>https://other-rss.example/</link>${itemsXml}</channel></rss>`);
  }

  if (parsed.hostname === 'mock-cross-ai.example') {
    let payload = {};
    try { payload = JSON.parse(String(init && init.body || '{}')); } catch { /* ignore */ }
    recordAi(url, payload);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: buildMockAiResponse(payload) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('unexpected external host in cross-source test', { status: 599 });
};
