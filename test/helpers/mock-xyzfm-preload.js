const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_XYZFM_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_XYZFM_AI_CAPTURE_PATH || '').trim();
const statePath = String(process.env.MOCK_XYZFM_STATE_PATH || '').trim();

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
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first request */ }
  state.requests.push({ url, at: Date.now() });
  fs.writeFileSync(capturePath, JSON.stringify(state));
}

function recordAi(url, init) {
  if (!aiCapturePath) return;
  let state = { calls: [] };
  try { state = JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')); } catch { /* first call */ }
  let payload = {};
  try { payload = JSON.parse(String(init && init.body || '{}')); } catch { /* malformed */ }
  state.calls.push({ url, model: payload.model || '', messages: payload.messages || [] });
  fs.writeFileSync(aiCapturePath, JSON.stringify(state));
}

dns.lookup = async (hostname, options) => {
  const host = String(hostname || '').toLowerCase();
  if ([
    'catalog-fixtures.example',
    'feed.xyzfm.space',
    'www.xiaoyuzhoufm.com',
    'media.xyzcdn.net',
    'other-podcast.example',
    'mock-xyzfm-ai.example',
  ].includes(host)) {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function buildXyzfmFeed({
  title,
  pid,
  author,
  count = 45,
  startIndex = 0,
  querySuffix = '',
  omitAudioOnIndex = -1,
  futureEpisode = null,
  padShowNotesBytes = 0,
  badEpisodeLinkIndex = -1,
  badAudioPidIndex = -1,
  guidIncludesQuery = false,
  validGuidOnBadLink = false,
  channelLinkOverride = '',
}) {
  const baseTs = Date.UTC(2026, 8, 1, 12, 0, 0);
  const padding = padShowNotesBytes > 0 ? `<p>${'节目补充背景资料。'.repeat(Math.ceil(padShowNotesBytes / 27))}</p>` : '';
  const items = [];
  if (futureEpisode) {
    items.push(`
      <item>
        <title>${futureEpisode.title}</title>
        <link>https://www.xiaoyuzhoufm.com/episode/${futureEpisode.eid}${querySuffix}</link>
        <guid isPermaLink="false">https://www.xiaoyuzhoufm.com/episode/${futureEpisode.eid}</guid>
        <pubDate>${new Date(futureEpisode.publishedTs).toUTCString()}</pubDate>
        <description><![CDATA[<p>${futureEpisode.notes}</p>]]></description>
        <enclosure url="https://media.xyzcdn.net/${pid}/${futureEpisode.eid}.m4a" length="2400000" type="audio/mp4" />
      </item>
    `);
  }
  for (let i = 0; i < count; i += 1) {
    const idx = startIndex + i;
    const eid = `${pid.slice(0, 8)}ep${String(idx).padStart(14, '0')}`;
    const pubTs = baseTs - idx * 24 * 3600 * 1000;
    const link = idx === badEpisodeLinkIndex
      ? `https://evil.example/hijacked/${idx}`
      : `https://www.xiaoyuzhoufm.com/episode/${eid}${querySuffix}`;
    const audioPid = idx === badAudioPidIndex ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : pid;
    const audioBaseUrl = String(process.env.MOCK_XYZFM_AUDIO_BASE_URL || '').replace(/\/+$/, '');
    const audioExt = audioBaseUrl ? 'wav' : 'm4a';
    const audioType = audioBaseUrl ? 'audio/wav' : 'audio/mp4';
    const enclosureBase = audioBaseUrl || 'https://media.xyzcdn.net';
    const enclosure = idx === omitAudioOnIndex
      ? ''
      : `<enclosure url="${enclosureBase}/${audioPid}/${eid}.${audioExt}" length="10240000" type="${audioType}" />`;
    const guidVal = (idx === badEpisodeLinkIndex && validGuidOnBadLink)
      ? `https://www.xiaoyuzhoufm.com/episode/${eid}`
      : (guidIncludesQuery ? `https://www.xiaoyuzhoufm.com/episode/${eid}${querySuffix}` : eid);
    items.push(`
      <item>
        <title>${title} 第${count - i}期 · 访谈实录 #${idx}</title>
        <link>${link}</link>
        <guid isPermaLink="false">${guidVal}</guid>
        <pubDate>${new Date(pubTs).toUTCString()}</pubDate>
        <description><![CDATA[<p>本期节目说明（Show Notes）#${idx}：围绕科技与商业一线实践展开讨论。</p>${i === count - 1 ? padding : ''}]]></description>
        ${enclosure}
      </item>
    `);
  }
  const channelLink = channelLinkOverride || `https://www.xiaoyuzhoufm.com/podcast/${pid}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${title}</title>
    <link>${channelLink}</link>
    <description>${title} 官方公开播客订阅</description>
    <itunes:author>${author}</itunes:author>
    ${items.join('\n')}
  </channel>
</rss>`;
}

const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');

function responseForMode(mode, defaults) {
  if (mode === '403') return new Response('forbidden', { status: 403 });
  if (mode === '404') return new Response('not found', { status: 404 });
  if (mode === 'html-403') {
    return new Response('<!doctype html><html><head><title>403 · 无法访问</title></head><body>403 FORBIDDEN</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (mode === 'empty-xml') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'wrong-channel-title') {
    return new Response(buildXyzfmFeed({ ...defaults, title: '伪造的其他播客节目' }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'wrong-channel-pid') {
    return new Response(buildXyzfmFeed({ ...defaults, pid: 'ffffffffffffffffffffffff' }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'wrong-episode-link') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 5, badEpisodeLinkIndex: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'hijacked-link-with-valid-guid') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 5, badEpisodeLinkIndex: 1, validGuidOnBadLink: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'no-channel-pid') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 5, omitAudioOnIndex: 0, channelLinkOverride: 'https://other-host.example/podcast' }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'wrong-audio-pid') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 5, badAudioPidIndex: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'query-variant') {
    return new Response(buildXyzfmFeed({ ...defaults, querySuffix: '?from=share&utm_source=xyzfm', guidIncludesQuery: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'over-5mib') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 35, padShowNotesBytes: 5_400_000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'over-16mib') {
    return new Response(buildXyzfmFeed({ ...defaults, count: 10, padShowNotesBytes: 17_000_000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  if (mode === 'with-future') {
    return new Response(buildXyzfmFeed({
      ...defaults,
      querySuffix: '?utm_source=refresh',
      guidIncludesQuery: true,
      futureEpisode: {
        eid: `${defaults.pid.slice(0, 8)}future0000000001`,
        title: `${defaults.title} 最新一期 Post-Cutoff`,
        notes: '最新一期发布于激活之后，用于验证新旧边界。',
        publishedTs: Date.now() + 60_000,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  return new Response(buildXyzfmFeed({
    ...defaults,
    querySuffix: defaults.querySuffix || '?utm_source=rss',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  record(url);
  const parsed = new URL(url);

  if (parsed.hostname === 'catalog-fixtures.example') {
    return new Response(fixtureOpml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
  }

  const state = readState();
  if (parsed.hostname === 'feed.xyzfm.space' && parsed.pathname === '/dk4yh3pkpjp3') {
    return responseForMode(state.xiaojunMode || 'ok', {
      title: '张小珺Jùn｜商业访谈录',
      pid: '626b46ea9cbbf0451cf5a962',
      author: '张小珺',
      count: Number(state.xiaojunCount) || 48,
      omitAudioOnIndex: state.xiaojunOmitAudioIndex ?? -1,
    });
  }

  if (parsed.hostname === 'feed.xyzfm.space' && parsed.pathname === '/evgg6xle9rdc') {
    return responseForMode(state.fortyTwoMode || 'ok', {
      title: '42章经',
      pid: '648b0b641c48983391a63f98',
      author: '曲凯',
      count: Number(state.fortyTwoCount) || 38,
      omitAudioOnIndex: state.fortyTwoOmitAudioIndex ?? -1,
    });
  }

  if (parsed.hostname === 'other-podcast.example') {
    const pad = 'x'.repeat(5_400_000);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Ordinary RSS</title><link>https://other-podcast.example/</link><item><title>Big</title><link>https://other-podcast.example/1</link><guid>1</guid><description>${pad}</description></item></channel></rss>`,
      { status: 200, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
    );
  }

  if (parsed.hostname === 'mock-xyzfm-ai.example') {
    recordAi(url, init);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"translations":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('unexpected external fetch', { status: 599 });
};
