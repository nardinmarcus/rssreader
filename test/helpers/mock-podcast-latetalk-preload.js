const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_LATETALK_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_LATETALK_AI_CAPTURE_PATH || '').trim();
const statePath = String(process.env.MOCK_LATETALK_STATE_PATH || '').trim();
const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
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
    'podcast.latepost.com',
    'feeds.fireside.fm',
    'aphid.fireside.fm',
    'www.xiaoyuzhoufm.com',
    'evil.example',
    'other-healthy.example',
    'mock-latetalk-ai.example',
  ].includes(host)) {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function buildLatetalkItems(state) {
  const mode = state.feedMode || 'normal';
  if (mode === 'empty-items') return '';
  const baseCount = Number(state.baseCount) || 65;
  const baseTs = Date.UTC(2026, 10, 19, 0, 0, 0);
  const items = [];

  if (mode === 'new-post-cutoff') {
    const futureTs = Date.now() + 120 * 1000;
    items.push(`<item>
      <title>190: Post-activation live AI episode</title>
      <link>https://podcast.latepost.com/190</link>
      <guid isPermaLink="false">latetalk-guid-190</guid>
      <pubDate>${new Date(futureTs).toUTCString()}</pubDate>
      <itunes:author>晚点 LatePost</itunes:author>
      <content:encoded><![CDATA[<p>Episode 190 show notes published after activation cutoff. Enough text to pass auto-rewrite minimum length thresholds cleanly.</p>]]></content:encoded>
      <enclosure url="https://aphid.fireside.fm/d/1437767933/latetalk/ep-190.mp3" length="12345678" type="audio/mpeg" />
    </item>`);
  }

  const startIdx = mode === 'shrunk' ? 1 : 0;
  for (let i = startIdx; i < baseCount; i += 1) {
    const epNum = baseCount - i;
    const pubDate = new Date(baseTs - i * 86400 * 1000).toUTCString();
    const titlePrefix = mode === 'title-updated' ? `修订标题 ${epNum}` : `${epNum}: LateTalk Episode`;
    const link = mode === 'title-updated'
      ? `https://podcast.latepost.com/${epNum}?ref=rss`
      : `https://podcast.latepost.com/${epNum}`;
    const guidTag = mode === 'no-guid-url-only'
      ? ''
      : `<guid isPermaLink="false">latetalk-guid-${epNum}</guid>`;
    const longBody = `第 ${epNum} 期晚点聊节目说明（Show Notes）与嘉宾观点梳理，包含足够长度用于验证历史条目禁止自动 AI。 `.repeat(5);
    items.push(`<item>
      <title>${titlePrefix} - Tech &amp; Business</title>
      <link>${link}</link>
      ${guidTag}
      <pubDate>${pubDate}</pubDate>
      <dc:creator>podcast@latepost.com (晚点 LatePost)</dc:creator>
      <itunes:author>晚点 LatePost</itunes:author>
      <itunes:duration>01:12:34</itunes:duration>
      <description><![CDATA[Summary for episode ${epNum}]]></description>
      <content:encoded><![CDATA[<p>${longBody}</p>]]></content:encoded>
      <enclosure url="https://aphid.fireside.fm/d/1437767933/latetalk/ep-${epNum}.mp3" length="4567890" type="audio/mpeg" />
    </item>`);
  }

  if (mode === 'extra-historical') {
    const oldestTs = baseTs - (baseCount + 5) * 86400 * 1000;
    items.push(`<item>
      <title>0: Extra Historical Episode</title>
      <link>https://podcast.latepost.com/0</link>
      <guid isPermaLink="false">latetalk-guid-0</guid>
      <pubDate>${new Date(oldestTs).toUTCString()}</pubDate>
      <itunes:author>晚点 LatePost</itunes:author>
      <content:encoded><![CDATA[<p>Historical episode 0 show notes surfaced later from archive. Must stay excluded from auto AI.</p>]]></content:encoded>
      <enclosure url="https://aphid.fireside.fm/d/1437767933/latetalk/ep-0.mp3" length="3456789" type="audio/mpeg" />
    </item>`);
  }

  return items.join('\n');
}

function buildLatetalkFeedXml(state) {
  const title = state.feedMode === 'wrong-title' ? '其他播客节目' : '晚点聊 LateTalk';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${title}</title>
    <link>https://podcast.latepost.com</link>
    <description>《晚点聊 LateTalk》由《晚点 LatePost》出品。最一手的科技访谈，最真实的从业者思考。</description>
    <itunes:author>晚点 LatePost</itunes:author>
    ${buildLatetalkItems(state)}
  </channel>
</rss>`;
}

function xiaoyuzhouHtml(pid, episodeCount) {
  const payload = {
    props: {
      pageProps: {
        podcast: {
          type: 'PODCAST',
          pid,
          title: '晚点聊 LateTalk',
          author: '晚点 LatePost',
          episodeCount,
        },
      },
    },
  };
  return `<!doctype html><html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></head><body></body></html>`;
}

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

  if (parsed.hostname === 'podcast.latepost.com' && parsed.pathname === '/rss') {
    const redirectMode = state.redirectMode || 'official';
    if (redirectMode === 'private-hop') {
      return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:1/latetalk/rss' } });
    }
    if (redirectMode === 'lan-hop') {
      return new Response('', { status: 302, headers: { Location: 'http://10.0.0.5/rss' } });
    }
    if (redirectMode === 'unverified-host') {
      return new Response('', { status: 302, headers: { Location: 'https://evil.example/latetalk/rss' } });
    }
    if (redirectMode === 'direct') {
      if (state.feedMode === 'unavailable') return textResponse('service unavailable', 503);
      return textResponse(buildLatetalkFeedXml(state));
    }
    return new Response('', { status: 302, headers: { Location: 'https://feeds.fireside.fm/latetalk/rss' } });
  }

  if (parsed.hostname === 'feeds.fireside.fm' && parsed.pathname === '/latetalk/rss') {
    if (state.feedMode === 'unavailable') return textResponse('service unavailable', 503);
    return textResponse(buildLatetalkFeedXml(state));
  }

  if (parsed.hostname === 'evil.example') {
    return textResponse(buildLatetalkFeedXml(state));
  }

  if (parsed.hostname === 'aphid.fireside.fm') {
    if (state.audioMode === 'unavailable') {
      return new Response('audio unavailable', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    if (state.audioMode === 'html-error') {
      return new Response('<!doctype html><html><body>blocked</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    const method = String(init && init.method || 'GET').toUpperCase();
    return new Response(method === 'HEAD' ? null : Buffer.from('ID3mockmp3data'), {
      status: method === 'HEAD' ? 200 : 206,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  }

  if (parsed.hostname === 'www.xiaoyuzhoufm.com' && parsed.pathname.startsWith('/podcast/')) {
    const xyzMode = state.xiaoyuzhouMode || 'unavailable';
    if (xyzMode === 'unavailable') return textResponse('upstream unavailable', 503, { 'Content-Type': 'text/html; charset=utf-8' });
    if (xyzMode === 'wrong-pid') {
      return new Response(xiaoyuzhouHtml('other-show-pid', 999), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    const count = state.xiaoyuzhouEpisodeCount !== undefined ? Number(state.xiaoyuzhouEpisodeCount) : 66;
    return new Response(xiaoyuzhouHtml('61933ace1b4320461e91fd55', count), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (parsed.hostname === 'other-healthy.example') {
    const seq = Number(state.otherSeq) || 1;
    const pubDate = new Date(Date.now() - 1000).toUTCString();
    return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Other Healthy News</title><link>https://other-healthy.example/</link>
<item><title>Healthy News #${seq}</title><link>https://other-healthy.example/n/${seq}</link><guid>healthy-${seq}</guid><pubDate>${pubDate}</pubDate><description>Healthy item ${seq}</description></item>
</channel></rss>`);
  }

  if (parsed.hostname === 'mock-latetalk-ai.example') {
    recordAi(url, init);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ translations: [] }) },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('unexpected external request blocked by test fixture', { status: 599 });
};
