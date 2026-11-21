const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(dataDir, env = {}) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      NAMOO_READER_DATA_DIR: dataDir,
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      SOURCE_INTERACTION_REFRESH_COOLDOWN_MS: String(Number.MAX_SAFE_INTEGER),
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
      COOKIE_SECURE: '0',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/sources`);
      if (response.ok) return { child, baseUrl, logs };
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function adminCookie(baseUrl) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function registerUser(baseUrl, email, displayName) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reader-password-123', displayName }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
    user: body.user,
  };
}

function seedSyntheticSourceEntries(dataDir, { sourceId, count = 5150, baseTime = 1750000000000 } = {}) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  try {
    const now = baseTime + 500000000;
    db.exec('BEGIN');
    db.prepare(`INSERT OR IGNORE INTO custom_sources
      (id, name, feed_url, category, created_at, updated_at)
      VALUES (?, 'Synthetic History Source', 'https://example.com/history.xml', 'article', ?, ?)`)
      .run(sourceId, now, now);
    db.prepare(`INSERT OR IGNORE INTO source_preferences
      (source_id, enabled, editorial_priority, display_order, updated_at)
      VALUES (?, 1, 'normal', 0, ?)`)
      .run(sourceId, new Date(now).toISOString());

    const stmt = db.prepare(`INSERT INTO entries
      (id, source_id, title, link, author, published, published_ts, summary, content, content_hash,
       platform_identity, content_scope, auto_ai_excluded_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Author', ?, ?, ?, ?, ?, NULL, 'feed-body', ?, ?, ?)`);

    // Include:
    // - 5 entries with unknown publication date (published_ts = 0) and very recent created_at
    // - 8 entries sharing an exact boundary timestamp across the first page (items 48..55)
    // - 1 older entry imported later (older published_ts, newer created_at)
    // - remaining dated entries spanning >5000 items
    const boundaryTs = baseTime + (count - 50) * 60000;
    const tag = sourceId === 'custom-history-other' ? 'ob' : 'oa';
    for (let i = 0; i < count; i += 1) {
      const id = `h${String(i).padStart(5, '0')}-${tag}-${sourceId}`;
      let publishedTs = baseTime + i * 60000;
      let createdAt = baseTime + i * 60000;
      if (i < 5) {
        publishedTs = 0;
        createdAt = now + i * 1000;
      } else if (i >= count - 56 && i <= count - 49) {
        publishedTs = boundaryTs;
      } else if (i === 10) {
        publishedTs = baseTime + 1000;
        createdAt = now + 999999;
      }
      const published = publishedTs > 0 ? new Date(publishedTs).toISOString() : null;
      const bodyText = `Historical body content for ${id}. `.repeat(35);
      stmt.run(
        id,
        sourceId,
        `Entry ${i}`,
        `https://example.com/posts/${id}`,
        published,
        publishedTs,
        `Summary ${i}`,
        `<p>${bodyText}</p>`,
        `hash-${id}`,
        now - 1000,
        createdAt,
        createdAt,
      );
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

test('GET /api/sources/:id/history paginates >5000 entries cleanly with concurrent inserts, retries, tie-breaks, and unknown dates', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-history-');
  const sourceId = 'custom-history-5k';
  const otherSourceId = 'custom-history-other';
  const preloadPath = path.join(dataDir, 'mock-translation-preload.js');
  const translationCapturePath = path.join(dataDir, 'translation-capture.json');
  fs.writeFileSync(preloadPath, [
    "const fs = require('fs');",
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init) => {',
    "  const url = String(input && input.url ? input.url : input);",
    "  if (!url.startsWith('https://mock-history-ai.example/')) return realFetch(input, init);",
    "  const payload = JSON.parse(String(init && init.body || '{}'));",
    "  fs.writeFileSync(process.env.MOCK_TRANSLATION_CAPTURE_PATH, JSON.stringify(payload));",
    "  const userText = String(payload.messages && payload.messages.at(-1) && payload.messages.at(-1).content || '');",
    "  const indexes = Array.from(userText.matchAll(/^i=(\\d+)$/gm), match => Number(match[1]));",
    "  const content = JSON.stringify({ titleZh: '历史旧文中文标题', summaryZh: '旧文摘要', blocks: indexes.map(i => ({ i, target: `历史译文 ${i}`, targetHtml: `<p>历史译文 ${i}</p>` })) });",
    "  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });",
    '};',
  ].join('\n'));

  let server = null;
  try {
    server = await startServer(dataDir, {
      VERSIONED_TRANSLATION_MODE: 'off',
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_TRANSLATION_CAPTURE_PATH: translationCapturePath,
    });
    const admin = await adminCookie(server.baseUrl);
    const readerA = await registerUser(server.baseUrl, 'history-a@example.com', 'Reader A');
    const readerB = await registerUser(server.baseUrl, 'history-b@example.com', 'Reader B');

    seedSyntheticSourceEntries(dataDir, { sourceId, count: 5150 });
    seedSyntheticSourceEntries(dataDir, { sourceId: otherSourceId, count: 5 });

    // 1. Default limit 50, max limit 100, and /api/entries keeps 5000 limit
    const firstDefault = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history`);
    assert.equal(firstDefault.response.status, 200, JSON.stringify(firstDefault.body));
    assert.equal(firstDefault.body.entries.length, 50);
    assert.equal(firstDefault.body.hasMore, true);
    assert.ok(typeof firstDefault.body.nextCursor === 'string' && firstDefault.body.nextCursor.length > 0);
    assert.equal(Object.hasOwn(firstDefault.body.entries[0], 'content'), false);
    assert.equal(Object.hasOwn(firstDefault.body.entries[0], 'autoAiExcludedAt'), false);

    const capped = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=999`);
    assert.equal(capped.response.status, 200);
    assert.equal(capped.body.entries.length, 100, 'history endpoint caps limit at 100');

    const globalEntries = await jsonRequest(server.baseUrl, `/api/entries?source=${encodeURIComponent(sourceId)}&limit=5500`);
    assert.equal(globalEntries.response.status, 200);
    assert.equal(globalEntries.body.entries.length, 5000, 'existing /api/entries 5000 cap remains unchanged');

    // 2. Retry same cursor returns identical page
    const page2a = await jsonRequest(
      server.baseUrl,
      `/api/sources/${encodeURIComponent(sourceId)}/history?cursor=${encodeURIComponent(firstDefault.body.nextCursor)}&limit=50`,
    );
    const page2b = await jsonRequest(
      server.baseUrl,
      `/api/sources/${encodeURIComponent(sourceId)}/history?cursor=${encodeURIComponent(firstDefault.body.nextCursor)}&limit=50`,
    );
    assert.equal(page2a.response.status, 200);
    assert.deepEqual(page2a.body, page2b.body, 'retrying a cursor returns the exact same page');

    // 3. Reject malformed, cross-source, and unsupported sort cursors
    const malformed = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?cursor=bad_cursor!!`);
    assert.equal(malformed.response.status, 400);
    const crossSource = await jsonRequest(
      server.baseUrl,
      `/api/sources/${encodeURIComponent(otherSourceId)}/history?cursor=${encodeURIComponent(firstDefault.body.nextCursor)}`,
    );
    assert.equal(crossSource.response.status, 400);
    const badSort = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?sort=hot`);
    assert.equal(badSort.response.status, 400);

    // 4. Full traversal >5000 entries with boundary ties, retries, and concurrent inserts mid-traversal
    const seenIds = [];
    const seenSet = new Set();
    let cursor = '';
    let pageCount = 0;
    let concurrentInserted = false;
    let concurrentIds = [];
    while (true) {
      const qs = new URLSearchParams({ limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const res = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qs.toString()}`);
      assert.equal(res.response.status, 200, JSON.stringify(res.body));
      pageCount += 1;
      for (const entry of res.body.entries) {
        assert.equal(seenSet.has(entry.id), false, `duplicate entry across pagination: ${entry.id}`);
        seenSet.add(entry.id);
        seenIds.push(entry.id);
      }
      if (!concurrentInserted && pageCount === 2) {
        concurrentInserted = true;
        const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
        try {
          const tNew = 1900000000000;
          const insert = db.prepare(`INSERT INTO entries
            (id, source_id, title, link, author, published, published_ts, summary, content, content_hash,
             content_scope, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'Author', ?, ?, 'New summary', '<p>New body</p>', ?, 'feed-body', ?, ?)`);
          insert.run(`${sourceId}-concurrent-new`, sourceId, 'Concurrent New', 'https://example.com/c-new', new Date(tNew).toISOString(), tNew, 'c-new', tNew, tNew);
          insert.run(`${sourceId}-concurrent-unknown`, sourceId, 'Concurrent Unknown', 'https://example.com/c-unk', null, 0, 'c-unk', tNew + 5000, tNew + 5000);
          concurrentIds = [`${sourceId}-concurrent-new`, `${sourceId}-concurrent-unknown`];
        } finally {
          db.close();
        }
      }
      if (!res.body.hasMore) {
        assert.equal(res.body.nextCursor, null);
        break;
      }
      assert.ok(res.body.nextCursor);
      cursor = res.body.nextCursor;
      assert.ok(pageCount < 100, 'pagination must terminate cleanly');
    }

    // All 5150 pre-existing entries must have been traversed without any missing item
    for (let i = 0; i < 5150; i += 1) {
      const expectedId = `h${String(i).padStart(5, '0')}-oa-${sourceId}`;
      assert.equal(seenSet.has(expectedId), true, `missing entry ${expectedId} after traversal`);
    }
    // Concurrent unknown-date entry landed in the undated tail at the end, never ahead of dated items
    assert.equal(seenSet.has(`${sourceId}-concurrent-unknown`), true);
    assert.equal(seenSet.has(`${sourceId}-concurrent-new`), false, 'concurrent newer dated entry before cursor did not shift or duplicate traversed pages');
    assert.equal(seenIds.length, 5151);

    // Unknown-date entries must all be at the very end (after every entry with publishedTs > 0)
    const firstUnknownIdx = seenIds.findIndex(id => id.endsWith('-concurrent-unknown') || /^h0000[0-4]-oa-/.test(id));
    assert.ok(firstUnknownIdx >= 5145, `unknown-date entries must sort after all dated entries, got idx=${firstUnknownIdx}`);
    // Old entry imported late (i = 10) must NOT jump ahead of newer dated entries
    const lateImportedIdx = seenIds.indexOf(`h00010-oa-${sourceId}`);
    const newerDatedIdx = seenIds.indexOf(`h00100-oa-${sourceId}`);
    assert.ok(lateImportedIdx > newerDatedIdx, 'import time must not elevate older publication date');

    // Oldest entry (>5000th) supports deep link, stats overlay isolation, translation version, and Highlight Annotation
    const oldestDatedId = `h00005-oa-${sourceId}`;
    const prefix = oldestDatedId.slice(0, 12);
    const byId = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}`);
    assert.equal(byId.response.status, 200);
    assert.equal(byId.body.entry.id, oldestDatedId);

    const reactA = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}/reaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ reaction: 'like' }),
    });
    assert.equal(reactA.response.status, 200);
    const starA = await jsonRequest(server.baseUrl, '/api/me/entry-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({ entryId: oldestDatedId, starred: true }),
    });
    assert.equal(starA.response.status, 200);

    const translationRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}/translation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: admin,
        'X-AI-Key': 'mock-key',
        'X-AI-Provider': 'openai-compatible',
        'X-AI-Provider-Name': 'Mock AI',
        'X-AI-Provider-Type': 'openai_compatible',
        'X-AI-Base-URL': 'https://mock-history-ai.example/v1',
        'X-AI-Model': 'mock-model',
      },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(translationRes.response.status, 200, JSON.stringify(translationRes.body));
    const translationAssetId = translationRes.body.translation.id;

    const annotationRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerA.cookie },
      body: JSON.stringify({
        surface: 'original',
        quote: `Historical body content for ${oldestDatedId}.`,
        body: 'Old history highlight note',
      }),
    });
    assert.equal(annotationRes.response.status, 200, JSON.stringify(annotationRes.body));
    const annotationId = annotationRes.body.annotation.id;

    // Walk to the last page containing oldestDatedId as Guest, Reader A, and Reader B -> no stats cache bleed!
    let tailCursor = '';
    let tailPages = 0;
    let foundGuest = null;
    while (tailPages < 100) {
      const qs = new URLSearchParams({ limit: '100' });
      if (tailCursor) qs.set('cursor', tailCursor);
      const page = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qs.toString()}`);
      assert.equal(page.response.status, 200);
      const match = page.body.entries.find(item => item.id === oldestDatedId);
      if (match) {
        foundGuest = match;
        break;
      }
      if (!page.body.hasMore) break;
      tailCursor = page.body.nextCursor;
      tailPages += 1;
    }
    assert.ok(foundGuest, 'oldest dated entry must be reachable in history pages');
    assert.equal(foundGuest.stats.reactionByMe, '');
    assert.equal(foundGuest.stats.favoriteCount, 1);
    assert.equal(foundGuest.stats.likeCount, 1);
    assert.equal(foundGuest.assets.annotations, 1);
    assert.equal(foundGuest.assets.translation, true);

    const qsTail = new URLSearchParams({ limit: '100' });
    if (tailCursor) qsTail.set('cursor', tailCursor);
    const pageForA = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qsTail.toString()}`, {
      headers: { Cookie: readerA.cookie },
    });
    const pageForB = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qsTail.toString()}`, {
      headers: { Cookie: readerB.cookie },
    });
    const pageForGuestAgain = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qsTail.toString()}`);

    const entryForA = pageForA.body.entries.find(item => item.id === oldestDatedId);
    const entryForB = pageForB.body.entries.find(item => item.id === oldestDatedId);
    const entryForGuest = pageForGuestAgain.body.entries.find(item => item.id === oldestDatedId);
    assert.equal(entryForA.stats.reactionByMe, 'like');
    assert.equal(entryForB.stats.reactionByMe, '', 'User B must not receive User A stats overlay');
    assert.equal(entryForGuest.stats.reactionByMe, '', 'Guest must not receive User A stats overlay');

    // Soft-deleted entry disappears from source history
    const softDeletedId = `h05149-oa-${sourceId}`;
    const delRes = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(softDeletedId)}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    });
    assert.equal(delRes.response.status, 200);
    const afterDelete = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=10`);
    assert.equal(afterDelete.body.entries.some(item => item.id === softDeletedId), false);

    // Server restart preserves >5000th entries, translation version, annotations, and prefix lookup
    await stopServer(server);
    server = await startServer(dataDir, { NODE_OPTIONS: '', MOCK_TRANSLATION_CAPTURE_PATH: '' });
    const adminAfterRestart = await adminCookie(server.baseUrl);

    const restartedPage = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qsTail.toString()}`);
    assert.equal(restartedPage.response.status, 200);
    assert.ok(restartedPage.body.entries.some(item => item.id === oldestDatedId));
    const oldDetail = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}`);
    assert.equal(oldDetail.response.status, 200);
    const oldTrans = await jsonRequest(
      server.baseUrl,
      `/api/entry/${encodeURIComponent(oldestDatedId)}/translation?assetId=${encodeURIComponent(translationAssetId)}`,
    );
    assert.equal(oldTrans.response.status, 200);
    assert.equal(oldTrans.body.translation.id, translationAssetId);
    const oldAnns = await jsonRequest(server.baseUrl, `/api/entry/${encodeURIComponent(oldestDatedId)}/annotations`);
    assert.equal(oldAnns.response.status, 200);
    assert.ok(oldAnns.body.annotations.some(ann => ann.id === annotationId));
    const deepLinkPage = await fetch(`${server.baseUrl}/articles/${encodeURIComponent(`entry-5--${prefix}`)}`);
    assert.equal(deepLinkPage.status, 200);
    assert.match(await deepLinkPage.text(), /Historical body content|Entry 5/);
    const legacyDeepLink = await fetch(`${server.baseUrl}/articles/${encodeURIComponent(oldestDatedId)}`);
    assert.equal(legacyDeepLink.status, 200);
    const annotationDeepLink = await fetch(
      `${server.baseUrl}/articles/${encodeURIComponent(`entry-5--${prefix}`)}/annotations/${encodeURIComponent(annotationId)}`,
    );
    assert.equal(annotationDeepLink.status, 200);

    // Disabled and archived sources are rejected even with valid previously-issued cursor
    const savedCursor = restartedPage.body.nextCursor;
    const disableRes = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminAfterRestart },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableRes.response.status, 200);
    for (const headers of [{}, { Cookie: readerB.cookie }, { Cookie: adminAfterRestart }]) {
      const disabledGuest = await jsonRequest(
        server.baseUrl,
        `/api/sources/${encodeURIComponent(sourceId)}/history${savedCursor ? `?cursor=${encodeURIComponent(savedCursor)}` : ''}`,
        { headers },
      );
      assert.equal(disabledGuest.response.status, 404);
    }

    // Re-enable, then archive -> also 404
    await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminAfterRestart },
      body: JSON.stringify({ enabled: true }),
    });
    const archivedRes = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: { Cookie: adminAfterRestart },
    });
    assert.equal(archivedRes.response.status, 200);
    const archivedHistory = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history`, {
      headers: { Cookie: adminAfterRestart },
    });
    assert.equal(archivedHistory.response.status, 404);

    // Unknown source -> 404
    const missingHistory = await jsonRequest(server.baseUrl, '/api/sources/nonexistent-source-id/history');
    assert.equal(missingHistory.response.status, 404);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('real refresh worker preserves >5000 persisted historical entries across refresh and restart', { timeout: 60000 }, async () => {
  const dataDir = createTempDataDir('namoo-source-history-worker-');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-source-ingestion-preload.js');
  const modePath = path.join(dataDir, 'feed-mode.txt');
  const capturePath = path.join(dataDir, 'capture.json');
  const catalogUrl = 'https://catalog-fixtures.example/opml/bestblogs_wechat2rss.xml';
  const catalogKey = 'wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22';
  fs.writeFileSync(modePath, 'ok');
  const env = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    MOCK_SOURCE_INGESTION_CAPTURE_PATH: capturePath,
    MOCK_SOURCE_INGESTION_MODE_PATH: modePath,
    SOURCE_CATALOG_FEED_URL: catalogUrl,
    SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
  };
  let server = null;
  try {
    server = await startServer(dataDir, env);
    const cookie = await adminCookie(server.baseUrl);
    const activated = await jsonRequest(server.baseUrl, `/api/admin/source-catalog/${encodeURIComponent(catalogKey)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
    const sourceId = activated.body.source.id;

    // Seed 5050 older entries into this activated source directly in SQLite
    seedSyntheticSourceEntries(dataDir, { sourceId, count: 5050, baseTime: 1650000000000 });

    fs.writeFileSync(modePath, 'new-future');
    const refreshRes = await jsonRequest(server.baseUrl, '/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sourceId }),
    });
    assert.equal(refreshRes.response.status, 200, JSON.stringify(refreshRes.body));

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const meta = await jsonRequest(server.baseUrl, '/api/sources', { headers: { Cookie: cookie } });
      if (!meta.body.backgroundJob?.fetch?.running && !meta.body.refreshing) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const firstPage = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?limit=100`);
    assert.equal(firstPage.response.status, 200);
    assert.equal(firstPage.body.entries[0].title, 'A new WeChat article after activation');

    await stopServer(server);
    server = await startServer(dataDir, env);

    let cursor = '';
    let count = 0;
    let foundOldest = false;
    let pages = 0;
    while (pages < 80) {
      const qs = new URLSearchParams({ limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const page = await jsonRequest(server.baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/history?${qs.toString()}`);
      assert.equal(page.response.status, 200);
      pages += 1;
      count += page.body.entries.length;
      if (page.body.entries.some(entry => entry.id === `h00005-oa-${sourceId}`)) foundOldest = true;
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor;
    }
    assert.equal(foundOldest, true, 'oldest >5000th record remains readable after worker refresh and restart');
    assert.ok(count >= 5053);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
