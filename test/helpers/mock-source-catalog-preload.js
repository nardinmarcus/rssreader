const dns = require('dns').promises;
const fs = require('fs');

// Test-only preload: substitutes the external catalog supplier and records every
// outbound request so tests can prove zero per-account feed fetches. Storage,
// approval, and business chains stay real.
const realLookup = dns.lookup.bind(dns);
const capturePath = String(process.env.MOCK_CATALOG_CAPTURE_PATH || '').trim();

function record(url) {
  if (!capturePath) return;
  let state = { requests: [] };
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first request */ }
  state.requests.push({ url, at: Date.now() });
  fs.writeFileSync(capturePath, JSON.stringify(state));
}

dns.lookup = async (hostname, options) => {
  if (String(hostname).toLowerCase() !== 'catalog-fixtures.example') {
    return realLookup(hostname, options);
  }
  const address = { address: '93.184.216.34', family: 4 };
  return options && options.all ? [address] : address;
};

function fixtureOpml() {
  return fs.readFileSync(require.resolve('../fixtures/source-catalog.opml'), 'utf8');
}

function oversizedBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body>'
    + '<outline text="超限" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/oversize.xml"/>'
    + 'x'.repeat(5 * 1024 * 1024 + 1024)
    + '</body></opml>';
}

function externalEntityBody() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE opml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    '<opml version="1.0"><head><title>&xxe;</title></head><body>',
    '<outline text="外部实体号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/xxe.xml"/></body></opml>',
  ].join('');
}

function malformedBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body><outline text="截断" type="rss"';
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  record(url);
  if (!url.startsWith('https://catalog-fixtures.example/')) {
    return new Response('unexpected external fetch', { status: 599 });
  }
  switch (String(process.env.MOCK_CATALOG_MODE || 'ok')) {
    case 'empty': return textResponse('');
    case 'whitespace': return textResponse('   \n  ');
    case 'malformed': return textResponse(malformedBody());
    case 'xxe': return textResponse(externalEntityBody());
    case 'oversize': return textResponse(oversizedBody());
    case 'http-error': return textResponse('service unavailable', 503);
    case 'ok': return textResponse(fixtureOpml());
    default: return textResponse(fixtureOpml());
  }
};
