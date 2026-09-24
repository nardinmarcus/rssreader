const dns = require('dns').promises;
const fs = require('fs');

// Replace only public source-supplier responses. The server, HTTP API, SQLite,
// RSS parser, source persistence, and worker/AI scheduling remain real.
const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_SOURCE_INGESTION_CAPTURE_PATH || '').trim();
const aiCapturePath = String(process.env.MOCK_SOURCE_INGESTION_AI_CAPTURE_PATH || '').trim();
const modePath = String(process.env.MOCK_SOURCE_INGESTION_MODE_PATH || '').trim();
const fixtureFeedUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';

function record(url) {
  if (!capturePath) return;
  let state = { requests: [] };
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first request */ }
  state.requests.push({ url, at: Date.now() });
  fs.writeFileSync(capturePath, JSON.stringify(state));
}

dns.lookup = async (hostname, options) => {
  const host = String(hostname || '').toLowerCase();
  if (host === 'catalog-fixtures.example' || host === 'wechat2rss.bestblogs.dev') {
    const address = { address: '93.184.216.34', family: 4 };
    return options && options.all ? [address] : address;
  }
  return realLookup(hostname, options);
};

function currentMode() {
  try { return fs.readFileSync(modePath, 'utf8').trim() || 'ok'; } catch { return String(process.env.MOCK_SOURCE_INGESTION_MODE || 'ok'); }
}

function recordAi(url, init) {
  if (!aiCapturePath) return;
  let state = { calls: [] };
  try { state = JSON.parse(fs.readFileSync(aiCapturePath, 'utf8')); } catch { /* first call */ }
  let request = {};
  try { request = JSON.parse(String(init && init.body || '{}')); } catch { /* malformed call is still recorded */ }
  state.calls.push({ url, model: request.model || '', messages: request.messages || [] });
  fs.writeFileSync(aiCapturePath, JSON.stringify(state));
}

function appendArticle(body, { suffix, published, title }) {
  const longBody = 'This feed-provided article body remains an excerpt whose completeness is unknown. '.repeat(12);
  const item = `\n    <item><title>${title}</title>`
    + `<link>https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=9${suffix}&amp;idx=1&amp;sn=historical${suffix}</link>`
    + `<guid isPermaLink="false">new-${suffix}</guid><pubDate>${published}</pubDate>`
    + `<description>English teaser</description><content:encoded><![CDATA[<p>${longBody}</p>]]></content:encoded></item>\n  `;
  return body.replace('</channel>', `${item}</channel>`);
}

function feedForMode(mode) {
  if (mode.startsWith('new-historical-')) {
    const suffix = mode.endsWith('-2') ? '2' : '1';
    return appendArticle(fixtureRss, {
      suffix,
      published: new Date(Date.now() - 60 * 60 * 1000).toUTCString(),
      title: `A historical WeChat article ${suffix}`,
    });
  }
  if (mode === 'new-future') {
    return appendArticle(fixtureRss, {
      suffix: '3',
      published: new Date(Date.now() + 60 * 1000).toUTCString(),
      title: 'A new WeChat article after activation',
    });
  }
  return fixtureRss;
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ...headers },
  });
}

const fixtureOpml = fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');
const fixtureRss = fs.readFileSync(require.resolve('../fixtures/wechat-feed.xml'), 'utf8');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  record(url);
  const parsed = new URL(url);
  if (parsed.hostname === 'catalog-fixtures.example' && parsed.href === fixtureFeedUrl) {
    return textResponse(fixtureOpml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  }
  if (parsed.hostname === 'wechat2rss.bestblogs.dev' && parsed.pathname.startsWith('/feed/')) {
    const mode = currentMode();
    if (mode === 'unavailable') return textResponse('unavailable', 503);
    if (mode === 'html') return textResponse('<!doctype html><html><title>not a feed</title></html>', 200, { 'Content-Type': 'text/html' });
    if (mode === 'empty') return textResponse('', 200);
    if (mode === 'wrong-account') {
      return textResponse(fixtureRss.replaceAll('人人都是产品经理', '伪造的其他账号'), 200);
    }
    if (mode === 'account-changed') {
      return textResponse(fixtureRss.replaceAll('MzA1', 'MzB2'), 200);
    }
    if (mode === 'redirect-private') {
      return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:1/redirect-target' } });
    }
    return textResponse(feedForMode(mode));
  }
  if (parsed.hostname === 'mock-source-ai.example') {
    recordAi(url, init);
    let content = '{"translations":[]}';
    let payload = {};
    try { payload = JSON.parse(String(init && init.body || '{}')); } catch { /* use safe fixture response */ }
    if (/英文到中文文章翻译助手/.test(String(payload.messages && payload.messages[0] && payload.messages[0].content || ''))) {
      const userText = String(payload.messages && payload.messages.at(-1) && payload.messages.at(-1).content || '');
      const indexes = Array.from(userText.matchAll(/^i=(\d+)$/gm), match => Number(match[1]));
      content = JSON.stringify({
        titleZh: '人工操作测试译名',
        summaryZh: '人工操作测试摘要',
        blocks: indexes.map(i => ({ i, target: `人工操作译文 ${i}`, targetHtml: `<p>人工操作译文 ${i}</p>` })),
      });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('unexpected external request blocked by test fixture', { status: 599 });
};
