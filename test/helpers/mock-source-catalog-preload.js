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

function truncatedAfterValidBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head><title>Truncated</title></head><body>'
    + '<outline text="完整号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/trunc000000000000000000000000001.xml"/>'
    + '<outline text="残缺号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/trunc000000000000000000000000002';
}

function mismatchedCloseBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body>'
    + '<outline text="错配号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/mism000000000000000000000000001.xml"/>'
    + '</opml>';
}

function tooManyEntriesBody() {
  const outlines = [];
  for (let index = 1; index <= 5001; index += 1) {
    const id = String(index).padStart(12, '0');
    outlines.push(`<outline text="超限账号 ${id}" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/over${id}"/>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head><title>Over limit</title></head><body>'
    + outlines.join('') + '</body></opml>';
}

function giantAttributeBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body>'
    + '<outline text="正常号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/giant00000000000000000000000001.xml"/>'
    + '<outline text="' + 'x'.repeat(9000) + '" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/giant00000000000000000000000002.xml"/>'
    + '</body></opml>';
}

function unclosedElementBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body>'
    + '<outline text="完好号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/unclosed0000000000000000000001.xml"/>'
    + '<unclosed></body></opml>';
}

function concatenatedRootsBody() {
  const root = (name, id) => '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><body>'
    + `<outline text="${name}" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/${id}.xml"/>`
    + '</body></opml>';
  return root('拼接一号', 'concat0000000000000000000000000001') + root('拼接二号', 'concat0000000000000000000000000002');
}

function commentedAndRealBody() {
  return '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head><title>Comments</title></head><body>'
    + '<!-- <outline text="注释号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/comment00000000000000000000001.xml"/> -->'
    + '<outline text="真实号" type="rss" xmlUrl="https://wechat2rss.bestblogs.dev/feed/realcmp0000000000000000000001.xml"/>'
    + '</body></opml>';
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
    case 'truncated-after-valid': return textResponse(truncatedAfterValidBody());
    case 'mismatched-close': return textResponse(mismatchedCloseBody());
    case 'too-many-entries': return textResponse(tooManyEntriesBody());
    case 'giant-attribute': return textResponse(giantAttributeBody());
    case 'unclosed-element': return textResponse(unclosedElementBody());
    case 'concatenated-roots': return textResponse(concatenatedRootsBody());
    case 'commented-and-real': return textResponse(commentedAndRealBody());
    case 'xxe': return textResponse(externalEntityBody());
    case 'oversize': return textResponse(oversizedBody());
    case 'http-error': return textResponse('service unavailable', 503);
    case 'ok': return textResponse(fixtureOpml());
    default: return textResponse(fixtureOpml());
  }
};
