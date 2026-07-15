const dns = require('dns').promises;
const fs = require('fs');

const realLookup = dns.lookup.bind(dns);
const realFetch = globalThis.fetch;
const capturePath = String(process.env.MOCK_SUBMISSION_CAPTURE_PATH || '').trim();

function capture(url) {
  if (!capturePath) return;
  let state = { fetches: [] };
  try { state = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch { /* first fetch */ }
  state.fetches.push(url);
  fs.writeFileSync(capturePath, JSON.stringify(state));
}

dns.lookup = async (hostname, options) => {
  if (!['approved.example', 'feeds.approved.example', 'www.latent.space'].includes(String(hostname).toLowerCase())) {
    return realLookup(hostname, options);
  }
  const address = { address: '93.184.216.34', family: 4 };
  return options && options.all ? [address] : address;
};

function weeklyRss() {
  const items = Array.from({ length: 12 }, (_, index) => {
    const issue = String(index + 1).padStart(2, '0');
    return [
      '<item>',
      `<title>Approved Weekly ${issue}</title>`,
      `<link>https://feeds.approved.example/weekly/${issue}</link>`,
      `<guid>approved-weekly-${issue}</guid>`,
      `<pubDate>${new Date(Date.UTC(2026, 0, index + 1)).toUTCString()}</pubDate>`,
      `<description>Approved weekly issue ${issue} contains useful reader material.</description>`,
      '</item>',
    ].join('');
  }).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    '<title>Approved Weekly</title>',
    '<link>https://feeds.approved.example/weekly</link>',
    '<description>A safely approved weekly feed.</description>',
    items,
    '</channel></rss>',
  ].join('');
}

function atomDigest() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '<title>Approved Atom Digest</title>',
    '<link href="https://feeds.approved.example/digest" />',
    '<subtitle>A safely approved Atom feed.</subtitle>',
    '<entry><title>Approved Atom 01</title><id>approved-atom-01</id>',
    '<updated>2026-01-02T00:00:00Z</updated><link href="https://feeds.approved.example/digest/01" />',
    '<summary>Approved Atom issue one.</summary></entry>',
    '<entry><title>Approved Atom 02</title><id>approved-atom-02</id>',
    '<updated>2026-01-01T00:00:00Z</updated><link href="https://feeds.approved.example/digest/02" />',
    '<summary>Approved Atom issue two.</summary></entry>',
    '</feed>',
  ].join('');
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://approved.example/')
    && !url.startsWith('https://feeds.approved.example/')
    && url !== 'https://www.latent.space/feed') {
    return realFetch(input, init);
  }
  capture(url);
  if (url === 'https://feeds.approved.example/feeds/weekly.xml') {
    return new Response(weeklyRss(), {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
  if (url === 'https://feeds.approved.example/feeds/digest.atom') {
    return new Response(atomDigest(), {
      status: 200,
      headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
    });
  }
  if (url === 'https://feeds.approved.example/feeds/broken.xml') {
    return new Response('<?xml version="1.0"?><rss><channel><title>Broken</title><item></channel></rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
  if (url === 'https://www.latent.space/feed') {
    return new Response(weeklyRss(), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  }
  return new Response([
    '<!doctype html><html><head>',
    '<title>Approved Article</title>',
    '<meta name="description" content="A safely approved article." />',
    '</head><body><article><h1>Approved Article</h1>',
    `<p>${'This approved article has enough useful content for the reader. '.repeat(12)}</p>`,
    '</article></body></html>',
  ].join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
