const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'namoo-reader-fetcher-test-'));
process.env.NAMOO_READER_DATA_DIR = testDataDir;

const fetcher = require('../lib/fetcher');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function runChild(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stdout}\n${stderr}`;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function runLookup(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

function utf16BeBuffer(value, { bom = false } = {}) {
  const littleEndian = Buffer.from(value, 'utf16le');
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]) : bigEndian;
}

test('private, link-local, documentation and mapped IP addresses are blocked', () => {
  const { isNonPublicIpAddress } = fetcher.__test;
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '203.0.113.5']) {
    assert.equal(isNonPublicIpAddress(address), true, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111']) {
    assert.equal(isNonPublicIpAddress(address), false, address);
  }
});

test('validated DNS answers are pinned into the connection lookup', async () => {
  const { createPinnedLookup, resolvePublicTarget } = fetcher.__test;
  let answers = [{ address: '93.184.216.34', family: 4 }];
  let resolutionCount = 0;
  const target = await resolvePublicTarget('https://rebind.test/article', {
    lookup: async () => {
      resolutionCount += 1;
      return answers;
    },
  });

  answers = [{ address: '127.0.0.1', family: 4 }];
  const pinned = await runLookup(createPinnedLookup(target), 'rebind.test', { family: 4 });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
  assert.equal(resolutionCount, 1);
});

test('DNS answers containing private addresses are rejected before connection', async () => {
  const { resolvePublicTarget } = fetcher.__test;
  await assert.rejects(
    resolvePublicTarget('https://unsafe.test/article', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
    /内网地址/
  );
});

test('ordinary RSS feeds use the hardened public fetch boundary', async () => {
  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;
  const originalFetch = global.fetch;
  const fetched = [];
  dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  global.fetch = async (url, options) => {
    fetched.push({ url: String(url), pinned: Boolean(options && options.dispatcher) });
    return new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>Safe Feed</title><item><title>One</title><link>https://safe.example/one</link></item></channel></rss>', {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });
  };
  try {
    const feed = await fetcher.__test.parseRssUrl('https://safe.example/feed.xml');
    assert.equal(feed.title, 'Safe Feed');
    assert.deepEqual(fetched, [{ url: 'https://safe.example/feed.xml', pinned: true }]);
  } finally {
    dnsPromises.lookup = originalLookup;
    global.fetch = originalFetch;
  }
});

test('public fetch re-resolves and pins every manual redirect hop', async () => {
  const { fetchPublicBuffer } = fetcher.__test;
  const resolved = [];
  const dispatched = [];
  let redirectedBodyCancelled = 0;
  const responses = [
    {
      status: 302,
      ok: false,
      headers: new Headers({ location: 'https://second.test/final' }),
      body: { cancel: async () => { redirectedBodyCancelled += 1; } },
    },
    new Response('safe body', { status: 200, headers: { 'content-type': 'text/plain' } }),
  ];

  const result = await fetchPublicBuffer('https://first.test/start', {
    deadline: Date.now() + 1000,
    maxBytes: 100,
  }, {
    resolvePublicTarget: async value => {
      const url = new URL(value).toString();
      resolved.push(url);
      return {
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: url.includes('first.test') ? '93.184.216.34' : '93.184.216.35', family: 4 }],
      };
    },
    createDispatcher: target => {
      dispatched.push(target.addresses[0].address);
      return { close: async () => {}, destroy: () => {} };
    },
    fetch: async (_value, options) => {
      assert.equal(options.redirect, 'manual');
      return responses.shift();
    },
  });

  assert.deepEqual(resolved, ['https://first.test/start', 'https://second.test/final']);
  assert.deepEqual(dispatched, ['93.184.216.34', '93.184.216.35']);
  assert.equal(redirectedBodyCancelled, 1);
  assert.equal(result.buffer.toString('utf8'), 'safe body');
});

test('HTML fetch exposes decoded HTTP bytes and allowlisted response evidence', async () => {
  const { fetchHtmlWithManualRedirects } = fetcher.__test;
  const originalLookup = dns.lookup;
  const originalFetch = global.fetch;
  const raw = Buffer.from('<html><body>Caf\u00e9</body></html>', 'utf8');
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  global.fetch = async input => String(input) === 'https://evidence.example/start'
    ? new Response(null, { status: 302, headers: { location: '/final' } })
    : new Response(raw, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8',
      etag: '"public-etag"',
      'last-modified': 'Tue, 14 Jul 2026 00:00:00 GMT',
      'content-language': 'en',
      'content-encoding': 'gzip',
      'set-cookie': 'session=secret',
      authorization: 'Bearer secret',
      cookie: 'private=value',
      'x-internal-secret': 'never-copy-me',
    } });
  try {
    const result = await fetchHtmlWithManualRedirects('https://evidence.example/start');
    assert.equal(result.url, 'https://evidence.example/final');
    assert.equal(result.finalUrl, 'https://evidence.example/final');
    assert.equal(result.status, 200);
    assert.equal(result.charset, 'utf-8');
    assert.equal(result.contentType, 'text/html; charset=utf-8');
    assert.deepEqual(result.buffer, raw);
    assert.equal(result.html, raw.toString('utf8'));
    assert.deepEqual(result.responseMeta, {
      etag: '"public-etag"',
      'last-modified': 'Tue, 14 Jul 2026 00:00:00 GMT',
      'content-language': 'en',
      'content-encoding': 'gzip',
    });
  } finally {
    dns.lookup = originalLookup;
    global.fetch = originalFetch;
  }
});

test('HTML evidence preserves distinct UTF-8, ISO-8859-1, and UTF-16 bytes before charset decoding', async () => {
  const { fetchHtmlWithManualRedirects } = fetcher.__test;
  const originalLookup = dns.lookup;
  const originalFetch = global.fetch;
  const html = '<html><body>Caf\u00e9</body></html>';
  const cases = [
    {
      buffer: Buffer.from(html, 'utf8'),
      contentType: 'text/html; charset=utf-8',
      charset: 'utf-8',
    },
    {
      buffer: Buffer.from(html, 'latin1'),
      contentType: 'text/html; charset=ISO-8859-1',
      charset: 'windows-1252',
    },
    {
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]),
      contentType: 'text/html',
      charset: 'utf-16le',
    },
  ];
  let responseIndex = 0;
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  global.fetch = async () => {
    const item = cases[responseIndex++];
    return new Response(item.buffer, {
      status: 200,
      headers: { 'content-type': item.contentType },
    });
  };
  try {
    const results = [];
    for (let index = 0; index < cases.length; index += 1) {
      results.push(await fetchHtmlWithManualRedirects(`https://encoding-${index}.example/article`));
    }
    for (let index = 0; index < results.length; index += 1) {
      assert.equal(results[index].html, html);
      assert.equal(results[index].charset, cases[index].charset);
      assert.deepEqual(results[index].buffer, cases[index].buffer);
    }
    const hashes = results.map(result => crypto.createHash('sha256').update(result.buffer).digest('hex'));
    assert.equal(new Set(hashes).size, 3);
  } finally {
    dns.lookup = originalLookup;
    global.fetch = originalFetch;
  }
});

test('public fetch cancels an oversized response body before rejecting it', async () => {
  const { fetchPublicBuffer } = fetcher.__test;
  let cancelled = 0;
  await assert.rejects(
    fetchPublicBuffer('https://large.test/file', {
      deadline: Date.now() + 1000,
      maxBytes: 16,
    }, {
      resolvePublicTarget: async url => ({
        url,
        hostname: 'large.test',
        addresses: [{ address: '93.184.216.34', family: 4 }],
      }),
      createDispatcher: () => ({ close: async () => {}, destroy: () => {} }),
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': '1024' }),
        body: { cancel: async () => { cancelled += 1; } },
      }),
    }),
    /Response too large/
  );
  assert.equal(cancelled, 1);
});

test('public fetch enforces the byte limit for streamed bodies without Content-Length', async () => {
  const { fetchPublicBuffer } = fetcher.__test;
  let reads = 0;
  let cancelled = 0;
  await assert.rejects(
    fetchPublicBuffer('https://chunked.test/file', {
      deadline: Date.now() + 1000,
      maxBytes: 16,
    }, {
      resolvePublicTarget: async url => ({
        url,
        hostname: 'chunked.test',
        addresses: [{ address: '93.184.216.34', family: 4 }],
      }),
      createDispatcher: () => ({ close: async () => {}, destroy: () => {} }),
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1;
              return { done: false, value: new Uint8Array(10) };
            },
            cancel: async () => { cancelled += 1; },
          }),
        },
      }),
    }),
    error => error && error.statusCode === 413 && /Response too large/.test(error.message)
  );
  assert.equal(reads, 2);
  assert.equal(cancelled, 1);
});

test('fetchText honors ISO-8859-1 and windows-1252 declarations from HTTP, XML, and HTML', async () => {
  const { fetchText } = fetcher.__test;
  const responses = [
    {
      headers: new Headers({ 'content-type': 'application/rss+xml; charset=ISO-8859-1' }),
      buffer: Buffer.from('<?xml version="1.0"?><rss><title>Caf\xe9</title></rss>', 'latin1'),
    },
    {
      headers: new Headers({ 'content-type': 'application/rss+xml; charset=not-a-real-encoding' }),
      buffer: Buffer.from('<?xml version="1.0" encoding="latin1"?><rss><title>R\xe9sum\xe9</title></rss>', 'latin1'),
    },
    {
      headers: new Headers({ 'content-type': 'text/html' }),
      buffer: Buffer.from('<html><head><meta charset="windows-1252"></head><body>\x93Caf\xe9\x94</body></html>', 'latin1'),
    },
  ];
  const request = async () => ({ status: 200, ...responses.shift() });

  assert.match(await fetchText('https://example.com/feed', 1000, 1024, { request }), /Café/);
  assert.match(await fetchText('https://example.com/feed', 1000, 1024, { request }), /Résumé/);
  assert.match(await fetchText('https://example.com/page', 1000, 1024, { request }), /“Café”/);
});

test('fetchText detects UTF-16 BOMs and byte order when a charset header is absent', async () => {
  const { fetchText } = fetcher.__test;
  const bigEndianText = '<?xml version="1.0"?><rss><title>中文 Café</title></rss>';
  const littleEndianText = '<?xml version="1.0" encoding="UTF-16"?><rss><title>你好</title></rss>';
  const responses = [
    {
      headers: new Headers({ 'content-type': 'application/xml; charset=windows-1252' }),
      buffer: utf16BeBuffer(bigEndianText, { bom: true }),
    },
    {
      headers: new Headers({ 'content-type': 'application/xml' }),
      buffer: Buffer.from(littleEndianText, 'utf16le'),
    },
  ];
  const request = async () => ({ status: 200, ...responses.shift() });

  assert.equal(await fetchText('https://example.com/be.xml', 1000, 2048, { request }), bigEndianText);
  assert.equal(await fetchText('https://example.com/le.xml', 1000, 2048, { request }), littleEndianText);
});

test('safe favicon type is derived from raster magic bytes only', () => {
  const { safeRasterMimeType } = fetcher.__test;
  const cases = [
    [Buffer.from('89504e470d0a1a0a00000000', 'hex'), 'image/png'],
    [Buffer.from('ffd8ffe000104a464946', 'hex'), 'image/jpeg'],
    [Buffer.from('47494638396101000100', 'hex'), 'image/gif'],
    [Buffer.from('524946460400000057454250', 'hex'), 'image/webp'],
    [Buffer.from('000001000100', 'hex'), 'image/x-icon'],
  ];
  for (const [buffer, expected] of cases) assert.equal(safeRasterMimeType(buffer), expected);
  assert.equal(safeRasterMimeType(Buffer.from('<svg><script>alert(1)</script></svg>')), '');
  assert.equal(safeRasterMimeType(Buffer.from('<html>not an image</html>')), '');
});

test('fetch retries cannot exceed the caller total timeout budget', async () => {
  const { fetchText } = fetcher.__test;
  let now = 1000;
  let attempts = 0;
  await assert.rejects(
    fetchText('https://example.com/feed', 100, 1024, {
      now: () => now,
      request: async () => {
        attempts += 1;
        now += 90;
        return { status: 503, headers: new Headers(), buffer: Buffer.alloc(0) };
      },
      sleep: async delay => { now += delay; },
    }),
    /timed out/
  );
  assert.equal(attempts, 1);
});

test('cache merge overlays only sources changed by the current process', () => {
  const { mergeCacheSources } = fetcher.__test;
  assert.equal(typeof mergeCacheSources, 'function');
  const latest = {
    a: { fetchedAt: 20, entries: ['other-process-a'] },
    b: { fetchedAt: 20, entries: ['other-process-b'] },
  };
  const local = {
    a: { fetchedAt: 30, entries: ['local-a'] },
    b: { fetchedAt: 10, entries: ['stale-local-b'] },
  };
  assert.deepEqual(mergeCacheSources(latest, local, new Set(['a'])), {
    a: local.a,
    b: latest.b,
  });
});

test('cache entry merge preserves a concurrently refreshed source', () => {
  const { mergeCacheEntries } = fetcher.__test;
  assert.equal(typeof mergeCacheEntries, 'function');
  const latest = {
    source: {
      fetchedAt: 30,
      status: 'ok',
      entries: [
        { id: 'kept', content: 'new feed item' },
        { id: 'enriched', content: 'feed summary', originalFetchedAt: 0 },
      ],
    },
  };
  assert.deepEqual(mergeCacheEntries(latest, new Map([
    ['source', new Map([
      ['enriched', { content: 'full article', originalFetchedAt: 99 }],
      ['removed-by-refresh', { content: 'must not be resurrected' }],
    ])],
  ])), {
    source: {
      fetchedAt: 30,
      status: 'ok',
      entries: [
        { id: 'kept', content: 'new feed item' },
        { id: 'enriched', content: 'full article', originalFetchedAt: 99 },
      ],
    },
  });
});

test('cache write lock serializes two real processes', async () => {
  const logFile = path.join(testDataDir, 'cache-lock-order.log');
  const startAt = Date.now() + 500;
  const childScript = `
    const fs = require('node:fs');
    const fetcher = require('./lib/fetcher');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const delay = Number(process.env.LOCK_START_AT) - Date.now();
    if (delay > 0) Atomics.wait(wait, 0, 0, delay);
    if (!fetcher.__test.acquireCacheWriteLock(3000)) process.exit(2);
    try {
      fs.appendFileSync(process.env.LOCK_LOG, 'start:' + process.env.LOCK_ID + '\\n');
      Atomics.wait(wait, 0, 0, 120);
      fs.appendFileSync(process.env.LOCK_LOG, 'end:' + process.env.LOCK_ID + '\\n');
    } finally {
      fetcher.__test.releaseCacheWriteLock();
    }
  `;
  await Promise.all(['a', 'b'].map(id => runChild(childScript, {
    LOCK_ID: id,
    LOCK_LOG: logFile,
    LOCK_START_AT: String(startAt),
    NAMOO_READER_DATA_DIR: testDataDir,
  })));
  const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
  const first = lines[0].split(':')[1];
  const second = first === 'a' ? 'b' : 'a';
  assert.deepEqual(lines, [`start:${first}`, `end:${first}`, `start:${second}`, `end:${second}`]);
});
