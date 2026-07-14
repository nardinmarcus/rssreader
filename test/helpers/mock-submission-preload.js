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
  if (String(hostname).toLowerCase() !== 'approved.example') return realLookup(hostname, options);
  const address = { address: '93.184.216.34', family: 4 };
  return options && options.all ? [address] : address;
};

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://approved.example/')) return realFetch(input, init);
  capture(url);
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
