const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkspaceNavigation } = require('../public/workspace-navigation');
const appFunctions = require('./helpers/workspace-app');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createListFixture() {
  const requests = [];
  const effects = [];
  const root = {
    document: {
      querySelector() {
        return {
          scrollTop: 0,
          classList: { toggle() {}, add() {}, remove() {} },
          setAttribute() {},
          removeAttribute() {},
        };
      },
    },
    history: {
      state: {},
      replaceState(s) { this.state = s; },
      pushState(s) { this.state = s; },
    },
  };
  const navigation = createWorkspaceNavigation(root, {
    canEnterDashboard: () => true,
    hasEntry: () => false,
    openReading: () => true,
    openDashboard: () => true,
    openContributor: () => true,
  });
  const context = {
    URLSearchParams,
    ENTRY_PAGE_SIZE: 100,
    ENTRY_MAX_LIMIT: 400,
    SOURCE_HISTORY_PAGE_SIZE: 50,
    categoryEntryCache: new Map(),
    entryListRequestSequence: 0,
    state: {
      entries: [],
      entryLimit: 100,
      view: 'all',
      filterSource: null,
      filterCategory: null,
      assetFilter: null,
      assetSort: 'latest',
      contributorSort: 'latest',
      q: '',
      sourceHistory: {
        sourceId: '',
        nextCursor: null,
        hasMore: false,
        loading: false,
        error: '',
      },
    },
    getWorkspaceNavigation: () => navigation,
    api: (url, options = {}) => {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
    updateListTitle: () => effects.push('title'),
    renderList: opts => effects.push(['list', opts || null]),
    renderSidebar: () => effects.push('sidebar'),
    toast: msg => effects.push(['toast', msg]),
    timeAgo: ts => (ts ? `${ts}ms` : ''),
    friendlyDateTime: ts => (ts ? `dt:${ts}` : ''),
    listRouteTitle: () => 'Namoo Reader',
    closeReaderFromRoute: () => effects.push('closeReader'),
    clearReaderUrl: () => {},
    loadContributors: async () => true,
  };
  appFunctions(context, [
    'isSourceHistoryMode',
    'resetSourceHistoryState',
    'entryPublishedTimestamp',
    'entryPublishedListLabel',
    'entryListParams',
    'loadEntries',
    'loadMoreEntries',
    'loadReaderRoute',
  ]);
  return { context, navigation, requests, effects };
}

test('entryPublishedListLabel explicitly surfaces unknown dates', () => {
  const { context } = createListFixture();
  assert.equal(context.entryPublishedListLabel({ id: 'u1', publishedTs: 0, published: null }), '未知日期');
  assert.equal(context.entryPublishedListLabel({ id: 'd1', publishedTs: 1750000000000 }), '1750000000000ms');
});

test('source history pagination retries with the same cursor and drops late responses after switching sources', async () => {
  const { context, navigation, requests, effects } = createListFixture();
  navigation.go('reading');

  // Load page 1 for source A
  context.state.filterSource = 'source-a';
  const loadA = context.loadEntries();
  assert.equal(requests[0].url, '/api/sources/source-a/history?limit=50');
  requests[0].resolve({
    entries: [{ id: 'a1', sourceId: 'source-a' }, { id: 'a2', sourceId: 'source-a' }],
    hasMore: true,
    nextCursor: 'cursor-a-1',
  });
  assert.equal(await loadA, true);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-1');
  assert.equal(context.state.sourceHistory.hasMore, true);

  // Page 2 fails -> preserves nextCursor and surfaces error for retry
  const button = { disabled: false, textContent: '加载更早内容' };
  const failPage2 = context.loadMoreEntries(button);
  assert.equal(requests[1].url, '/api/sources/source-a/history?cursor=cursor-a-1&limit=50');
  requests[1].reject(new Error('network blip'));
  assert.equal(await failPage2, false);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-1');
  assert.equal(context.state.sourceHistory.hasMore, true);
  assert.equal(context.state.sourceHistory.loading, false);
  assert.equal(context.state.sourceHistory.error, 'network blip');

  // Retry succeeds with the preserved cursor and deduplicates overlapping entries
  const retryPage2 = context.loadMoreEntries(button);
  assert.equal(requests[2].url, '/api/sources/source-a/history?cursor=cursor-a-1&limit=50');
  requests[2].resolve({
    entries: [{ id: 'a2', sourceId: 'source-a' }, { id: 'a3', sourceId: 'source-a' }],
    hasMore: true,
    nextCursor: 'cursor-a-2',
  });
  assert.equal(await retryPage2, true);
  assert.deepEqual(Array.from(context.state.entries, item => item.id), ['a1', 'a2', 'a3']);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-2');

  // Start page 3 for source A, then switch A -> B -> A while request 3 is in flight
  const stalePage3 = context.loadMoreEntries(button);
  assert.equal(requests[3].url, '/api/sources/source-a/history?cursor=cursor-a-2&limit=50');
  navigation.go('reading');
  context.state.filterSource = 'source-b';
  const loadB = context.loadEntries();
  assert.equal(requests[4].url, '/api/sources/source-b/history?limit=50');
  requests[4].resolve({ entries: [{ id: 'b1', sourceId: 'source-b' }], hasMore: false, nextCursor: null });
  await loadB;

  navigation.go('reading');
  context.state.filterSource = 'source-a';
  const reloadA = context.loadEntries();
  requests[5].resolve({
    entries: [{ id: 'a-fresh', sourceId: 'source-a' }],
    hasMore: true,
    nextCursor: 'cursor-a-fresh',
  });
  await reloadA;

  // Late response from stalePage3 must not mutate current source A state or list
  effects.length = 0;
  requests[3].resolve({
    entries: [{ id: 'a-stale', sourceId: 'source-a' }],
    hasMore: false,
    nextCursor: null,
  });
  assert.equal(await stalePage3, false);
  assert.deepEqual(Array.from(context.state.entries, item => item.id), ['a-fresh']);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-fresh');
  assert.deepEqual(effects, []);
});

test('loadReaderRoute preserves active source history when returning via back navigation', async () => {
  const { context, navigation, requests, effects } = createListFixture();
  const owner = navigation.go('reading');
  context.state.filterSource = 'source-a';
  context.state.entries = [{ id: 'a1' }, { id: 'a51' }];
  context.state.sourceHistory = {
    sourceId: 'source-a',
    nextCursor: 'cursor-a-2',
    hasMore: true,
    loading: false,
    error: '',
  };

  await context.loadReaderRoute({
    entriesLoaded: false,
    navigation: navigation.current(),
    listView: '',
    entryId: '',
  });
  assert.equal(requests.length, 0, 'returning from an entry must not discard and re-fetch source history');
  assert.equal(context.state.filterSource, 'source-a');
  assert.deepEqual(context.state.entries.map(item => item.id), ['a1', 'a51']);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-2');
  assert.ok(effects.includes('closeReader'));
  assert.ok(owner);
});

test('opening an entry while loadMoreEntries is in flight does not leave sourceHistory.loading stuck on back', async () => {
  const { context, navigation, requests } = createListFixture();
  navigation.go('reading');
  context.state.filterSource = 'source-a';
  const loadA = context.loadEntries();
  requests[0].resolve({
    entries: [{ id: 'a1', sourceId: 'source-a' }],
    hasMore: true,
    nextCursor: 'cursor-a-1',
  });
  await loadA;

  const button = { disabled: false, textContent: '加载更早内容' };
  const pendingMore = context.loadMoreEntries(button);
  assert.equal(context.state.sourceHistory.loading, true);

  // User opens an article while page 2 is still in flight (changes workspace visit)
  navigation.go('reading');
  // User returns back to list before or after late response
  await context.loadReaderRoute({
    entriesLoaded: false,
    navigation: navigation.current(),
    listView: '',
    entryId: '',
  });
  assert.equal(context.state.sourceHistory.loading, false);

  // Late page-2 response resolves -> must not mutate entries or cursor
  requests[1].resolve({
    entries: [{ id: 'a2', sourceId: 'source-a' }],
    hasMore: false,
    nextCursor: null,
  });
  assert.equal(await pendingMore, false);
  assert.deepEqual(Array.from(context.state.entries, item => item.id), ['a1']);
  assert.equal(context.state.sourceHistory.nextCursor, 'cursor-a-1');
  assert.equal(context.state.sourceHistory.loading, false);
});

test('service worker leaves /api/sources/:id/history and /api/entry/:id network-only', async () => {
  const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const listeners = new Map();
  const cachePutCalls = [];
  const fetchCalls = [];
  const context = {
    self: {
      location: { origin: 'https://reader.example' },
      addEventListener(type, fn) { listeners.set(type, fn); },
    },
    URL,
    caches: {
      async open() { return { async addAll() {}, async put(req) { cachePutCalls.push(req); } }; },
      async match() { return null; },
      async keys() { return []; },
    },
    fetch: async req => {
      fetchCalls.push(req.url);
      return { ok: true };
    },
  };
  vm.createContext(context);
  vm.runInContext(swSource, context);

  const onFetch = listeners.get('fetch');
  assert.equal(typeof onFetch, 'function');
  for (const apiPath of ['/api/sources/custom-1/history?limit=50', '/api/entry/entry-1']) {
    let responded = false;
    onFetch({
      request: { method: 'GET', mode: 'cors', url: `https://reader.example${apiPath}` },
      respondWith() { responded = true; },
    });
    assert.equal(responded, false, `${apiPath} must bypass SW cache completely`);
  }
  assert.equal(cachePutCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});
