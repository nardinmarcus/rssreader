const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPeriodicalsController,
  mountPeriodicals,
  parsePeriodicalPath,
} = require('../public/periodicals');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');

function fakeElement(classes = [], tagName = 'DIV') {
  const values = new Set(classes);
  const listeners = new Map();
  const attributes = new Map();
  let scrollLocked = false;
  let scrollValue = 0;
  const node = {
    attributes,
    children: [],
    className: '',
    clientHeight: 100,
    dataset: {},
    scrollHeight: 200,
    tagName,
    classList: {
      add: value => values.add(value),
      contains: value => values.has(value),
      remove: value => values.delete(value),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    append(...children) { this.children.push(...children); },
    dispatch(type, event = {}) {
      return listeners.get(type)?.({ preventDefault() {}, ...event });
    },
    focus() { this.focused = true; },
    get scrollTop() { return scrollValue; },
    removeAttribute: name => attributes.delete(name),
    replaceChildren(...children) { this.children = children; },
    set scrollTop(value) {
      if (!scrollLocked) scrollValue = Number(value) || 0;
    },
    setScrollLocked(value) {
      scrollLocked = Boolean(value);
      if (scrollLocked) {
        scrollValue = 0;
        this.clientHeight = 0;
        this.scrollHeight = 0;
      } else {
        this.clientHeight = 100;
        this.scrollHeight = 200;
      }
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    textContent: '',
  };
  return node;
}

function fakeBrowser({ mode, pathname, responses = [], historyState = null, width = 1280, online = true }) {
  const mobileMediaListeners = [];
  const mobileMedia = {
    matches: width <= 860,
    addEventListener(type, listener) {
      if (type === 'change') mobileMediaListeners.push(listener);
    },
  };
  const elements = {
    '#app': fakeElement(),
    '#periodicals-open': fakeElement(['hidden']),
    '#periodicals-nav': fakeElement(['hidden']),
    '#reader-pane': fakeElement(),
    '#periodicals-reader': fakeElement(['hidden']),
    '#periodicals-empty': fakeElement(['hidden']),
    '#periodicals-document': fakeElement(['hidden']),
    '#periodicals-list': fakeElement(),
    '#periodicals-back': fakeElement(['hidden'], 'BUTTON'),
  };
  const tabs = ['daily', 'weekly', 'monthly'].map(cadence => {
    const tab = fakeElement();
    tab.dataset = { periodicalCadence: cadence };
    return tab;
  });
  const assigned = [];
  const pushed = [];
  const documentListeners = new Map();
  const rootListeners = new Map();
  const fetched = [];
  let fetchCount = 0;
  const document = {
    body: { dataset: { periodicalsMode: mode } },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement: tagName => fakeElement([], String(tagName || 'div').toUpperCase()),
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) || []) listener(event);
    },
    querySelector: selector => elements[selector] || null,
    querySelectorAll: selector => selector === '#periodicals-tabs [role="tab"]' ? tabs : [],
    title: 'Namoo Reader',
  };
  const location = {
    assign: nextPathname => assigned.push(nextPathname),
    pathname,
  };
  const history = {
    state: historyState,
    pushState(state, _title, nextPathname) {
      this.state = state;
      location.pathname = String(nextPathname);
      pushed.push(String(nextPathname));
    },
    replaceState(state, _title, nextPathname) {
      this.state = state;
      if (nextPathname) location.pathname = String(nextPathname);
    },
    back() { this.backCalls = (this.backCalls || 0) + 1; },
  };
  const root = {
    addEventListener(type, listener) {
      const listeners = rootListeners.get(type) || [];
      listeners.push(listener);
      rootListeners.set(type, listeners);
    },
    dispatchEvent(event) {
      return Promise.all((rootListeners.get(event.type) || []).map(listener => listener(event)));
    },
    document,
    fetch: async (url, options) => {
      fetchCount += 1;
      fetched.push([url, options]);
      const payload = responses[fetchCount - 1] || { issues: [], nextCursor: null };
      if (payload instanceof Error) throw payload;
      return {
        ok: payload.ok !== false,
        status: payload.status || 200,
        json: async () => payload.body || payload,
      };
    },
    history,
    innerWidth: width,
    location,
    matchMedia: query => (/max-width:\s*860px/.test(query)
      ? mobileMedia
      : { matches: false }),
    navigator: { onLine: online },
  };
  return {
    assigned,
    elements,
    fetched,
    fetchCount: () => fetchCount,
    pushed,
    async setMobileLayout(matches) {
      mobileMedia.matches = Boolean(matches);
      await Promise.all(mobileMediaListeners.map(listener => listener({ matches: mobileMedia.matches })));
    },
    tabs,
    root,
  };
}

function flattenedText(node) {
  return [node && node.textContent, ...(node && node.children || []).map(flattenedText)]
    .filter(Boolean)
    .join(' ');
}

function descendants(node) {
  return [node, ...(node && node.children || []).flatMap(descendants)];
}

test('periodical client parses canonical routes and rejects invalid period keys', () => {
  assert.deepEqual(parsePeriodicalPath('/periodicals'), { cadence: 'daily', periodKey: '' });
  assert.deepEqual(parsePeriodicalPath('/periodicals/daily/2026-07-30'), {
    cadence: 'daily',
    periodKey: '2026-07-30',
  });
  assert.deepEqual(parsePeriodicalPath('/periodicals/weekly/2026-W31'), {
    cadence: 'weekly',
    periodKey: '2026-W31',
  });
  assert.deepEqual(parsePeriodicalPath('/periodicals/monthly/2026-07'), {
    cadence: 'monthly',
    periodKey: '2026-07',
  });
  assert.equal(parsePeriodicalPath('/periodicals/daily/2026-02-31').invalid, true);
  assert.equal(parsePeriodicalPath('/periodicals/weekly/2021-W53').invalid, true);
  assert.equal(parsePeriodicalPath('/periodicals/yearly/2026').invalid, true);
  assert.equal(parsePeriodicalPath('/articles/example'), null);
});

test('cadence tabs auto-activate with Arrow keys, Home, and End', async () => {
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals',
    responses: Array.from({ length: 4 }, () => ({ issues: [], nextCursor: null })),
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  await browser.tabs[0].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(browser.tabs[1].focused, true);
  assert.equal(browser.tabs[1].attributes.get('aria-selected'), 'true');
  assert.equal(browser.tabs[0].attributes.get('tabindex'), '-1');

  await browser.tabs[1].dispatch('keydown', { key: 'End' });
  assert.equal(browser.tabs[2].focused, true);
  assert.equal(browser.tabs[2].attributes.get('aria-selected'), 'true');

  await browser.tabs[2].dispatch('keydown', { key: 'Home' });
  assert.equal(browser.tabs[0].focused, true);
  assert.equal(browser.tabs[0].attributes.get('aria-selected'), 'true');
  assert.deepEqual(browser.pushed, [
    '/periodicals/weekly',
    '/periodicals/monthly',
    '/periodicals/daily',
  ]);
});

test('periodical controller loads only the SQLite index for root and legal deep links', async () => {
  const requests = [];
  const rendered = [];
  const controller = createPeriodicalsController({
    request: async (url, options) => {
      requests.push([url, options]);
      return { issues: [], nextCursor: null };
    },
    view: {
      enter: cadence => rendered.push(['enter', cadence]),
      renderEmpty: () => rendered.push(['empty']),
      renderError: () => rendered.push(['error']),
      renderIndex: (cadence, issues) => rendered.push(['index', cadence, issues]),
    },
  });

  assert.equal(await controller.open('/periodicals'), true);
  assert.equal(await controller.open('/periodicals/weekly/2026-W31'), true);
  assert.deepEqual(requests, [
    ['/api/periodicals?cadence=daily&limit=30', { cache: 'no-store' }],
    ['/api/periodicals?cadence=weekly&limit=30', { cache: 'no-store' }],
  ]);
  assert.deepEqual(rendered, [
    ['enter', 'daily'],
    ['index', 'daily', []],
    ['empty'],
    ['enter', 'weekly'],
    ['index', 'weekly', []],
    ['empty'],
  ]);
  assert.equal(await controller.open('/periodicals/yearly/2026'), false);
  assert.equal(requests.length, 2);
});

test('periodical controller loads and renders SQLite detail for a legal deep link', async () => {
  const requests = [];
  const rendered = [];
  const detail = {
    issue: { cadence: 'daily', periodKey: '2026-07-30', status: 'open' },
    themes: [],
    events: [],
    evidence: [],
  };
  const controller = createPeriodicalsController({
    request: async (url, options) => {
      requests.push([url, options]);
      if (url.startsWith('/api/periodicals?')) {
        return {
          issues: [{ cadence: 'daily', periodKey: '2026-07-30', status: 'open' }],
          nextCursor: null,
        };
      }
      return detail;
    },
    view: {
      enter: cadence => rendered.push(['enter', cadence]),
      renderEmpty: () => rendered.push(['empty']),
      renderError: () => rendered.push(['error']),
      renderIndex: (cadence, issues) => rendered.push(['index', cadence, issues.length]),
      renderIssue: value => rendered.push(['issue', value]),
    },
  });

  assert.equal(await controller.open('/periodicals/daily/2026-07-30'), true);
  assert.deepEqual(requests, [
    ['/api/periodicals?cadence=daily&limit=30', { cache: 'no-store' }],
    ['/api/periodicals/daily/2026-07-30', { cache: 'no-cache' }],
  ]);
  assert.deepEqual(rendered, [
    ['enter', 'daily'],
    ['index', 'daily', 1],
    ['issue', detail],
  ]);
});

test('periodical controller joins frozen evidence with the current SQLite availability projection', async () => {
  const requests = [];
  const rendered = [];
  const detail = {
    issue: { cadence: 'daily', periodKey: '2026-07-30', status: 'frozen' },
    themes: [],
    events: [],
    evidence: [
      { eventId: 'event-one', entryId: 'entry-active', summaryExcerpt: 'Active snapshot.' },
      { eventId: 'event-one', entryId: 'entry-deleted', summaryExcerpt: 'Deleted snapshot.' },
    ],
  };
  const controller = createPeriodicalsController({
    request: async (url, options) => {
      requests.push([url, options]);
      if (url.includes('evidence-availability')) {
        return {
          evidence: [
            { eventId: 'event-one', entryId: 'entry-active', entryAvailable: true },
            { eventId: 'event-one', entryId: 'entry-deleted', entryAvailable: false },
          ],
        };
      }
      if (url.startsWith('/api/periodicals?')) {
        return { issues: [detail.issue], nextCursor: null };
      }
      return detail;
    },
    view: {
      enter() {},
      renderIndex() {},
      renderIssue: value => rendered.push(value),
    },
  });

  assert.equal(await controller.open('/periodicals/daily/2026-07-30'), true);
  assert.deepEqual(requests, [
    ['/api/periodicals?cadence=daily&limit=30', { cache: 'no-store' }],
    ['/api/periodicals/daily/2026-07-30', { cache: 'no-cache' }],
    ['/api/periodicals/daily/2026-07-30/evidence-availability', { cache: 'no-store' }],
  ]);
  assert.deepEqual(
    rendered[0].evidence.map(item => [item.entryId, item.entryAvailable, item.summaryExcerpt]),
    [
      ['entry-active', true, 'Active snapshot.'],
      ['entry-deleted', false, 'Deleted snapshot.'],
    ],
  );
});

test('periodical controller appends reverse-chronological pages through the opaque cursor', async () => {
  const requests = [];
  const rendered = [];
  const firstPage = Array.from({ length: 30 }, (_, index) => ({
    cadence: 'monthly',
    periodKey: `2024-${String(12 - (index % 12)).padStart(2, '0')}`,
  }));
  const controller = createPeriodicalsController({
    request: async (url, options) => {
      requests.push([url, options]);
      if (url.includes('cursor=')) {
        return {
          issues: [{ cadence: 'monthly', periodKey: '2022-06' }],
          nextCursor: null,
        };
      }
      return { issues: firstPage, nextCursor: 'monthly-scan-v1.opaque+/=' };
    },
    view: {
      enter() {},
      renderEmpty() {},
      renderError() {},
      renderIndex: (_cadence, issues, meta) => rendered.push([issues.length, meta.nextCursor]),
      renderIssue() {},
    },
  });

  await controller.open('/periodicals/monthly/2024-12');
  assert.equal(await controller.loadMore(), true);
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/api/periodicals?')), [
    ['/api/periodicals?cadence=monthly&limit=30', { cache: 'no-store' }],
    ['/api/periodicals?cadence=monthly&limit=30&cursor=monthly-scan-v1.opaque%2B%2F%3D', { cache: 'no-store' }],
  ]);
  assert.deepEqual(rendered, [
    [30, 'monthly-scan-v1.opaque+/='],
    [31, null],
  ]);
});

test('periodical controller rebuilds cursor depth from SQLite before restoring both scroll positions', async () => {
  const requests = [];
  const rendered = [];
  const restored = [];
  const controller = createPeriodicalsController({
    request: async (url, options) => {
      requests.push([url, options]);
      if (url.includes('cursor=cursor-one')) {
        return {
          issues: [{ cadence: 'daily', periodKey: '2026-07-29' }],
          nextCursor: null,
        };
      }
      if (url.startsWith('/api/periodicals?')) {
        return {
          issues: [{ cadence: 'daily', periodKey: '2026-07-30' }],
          nextCursor: 'cursor-one',
        };
      }
      return { issue: { cadence: 'daily', periodKey: '2026-07-30' } };
    },
    view: {
      enter() {},
      renderEmpty() {},
      renderError() {},
      renderIndex: (_cadence, issues) => rendered.push(issues.map(issue => issue.periodKey)),
      renderIssue() {},
      restoreScroll: value => restored.push(value),
    },
  });

  await controller.open('/periodicals/daily/2026-07-30', {
    restore: {
      lastCursor: 'cursor-one',
      listScroll: 240,
      documentScroll: 720,
    },
  });

  assert.deepEqual(requests.map(([url]) => url), [
    '/api/periodicals?cadence=daily&limit=30',
    '/api/periodicals?cadence=daily&limit=30&cursor=cursor-one',
    '/api/periodicals/daily/2026-07-30',
  ]);
  assert.deepEqual(rendered, [
    ['2026-07-30'],
    ['2026-07-30', '2026-07-29'],
  ]);
  assert.deepEqual(restored, [{ listScroll: 240, documentScroll: 720 }]);
});

test('periodical controller keeps index and document failures distinct, including 404', async () => {
  const indexRendered = [];
  const indexController = createPeriodicalsController({
    request: async () => {
      const error = new Error('index unavailable');
      error.status = 503;
      throw error;
    },
    view: {
      enter() {},
      renderIndexError: error => indexRendered.push(['index-error', error.status]),
    },
  });
  assert.equal(await indexController.open('/periodicals/daily'), true);
  assert.deepEqual(indexRendered, [['index-error', 503]]);
  assert.deepEqual(indexController.getState(), {
    cadence: 'daily',
    periodKey: '',
    lastCursor: null,
    nextCursor: null,
  });

  const documentRendered = [];
  let requestCount = 0;
  const detailController = createPeriodicalsController({
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          issues: [{ cadence: 'daily', periodKey: '2026-07-30' }],
          nextCursor: null,
        };
      }
      const error = new Error('missing');
      error.status = 404;
      throw error;
    },
    view: {
      enter() {},
      renderIndex: () => documentRendered.push(['index']),
      renderDocumentError: error => documentRendered.push(['document-error', error.status]),
    },
  });
  assert.equal(await detailController.open('/periodicals/daily/2026-07-30'), true);
  assert.deepEqual(documentRendered, [['index'], ['document-error', 404]]);
});

test('periodical mount gates the trigger and enters only the minimal empty workspace', async () => {
  const off = fakeBrowser({ mode: 'off', pathname: '/periodicals' });
  assert.equal(mountPeriodicals(off.root), false);
  assert.equal(off.elements['#periodicals-open'].classList.contains('hidden'), true);
  assert.equal(off.fetchCount(), 0);

  const home = fakeBrowser({ mode: 'on', pathname: '/' });
  const homeMount = mountPeriodicals(home.root);
  await homeMount.ready;
  assert.equal(home.elements['#periodicals-open'].classList.contains('hidden'), false);
  assert.equal(home.elements['#app'].classList.contains('periodicals-mode'), false);
  assert.equal(home.fetchCount(), 0);
  home.elements['#periodicals-open'].dispatch('click');
  assert.deepEqual(home.assigned, ['/periodicals']);

  const workspace = fakeBrowser({ mode: 'on', pathname: '/periodicals/weekly/2026-W31' });
  const workspaceMount = mountPeriodicals(workspace.root);
  await workspaceMount.ready;
  assert.equal(workspace.fetchCount(), 1);
  assert.equal(workspace.elements['#app'].classList.contains('periodicals-mode'), true);
  assert.equal(workspace.elements['#periodicals-nav'].classList.contains('hidden'), false);
  assert.equal(workspace.elements['#periodicals-reader'].classList.contains('hidden'), false);
  assert.equal(workspace.elements['#periodicals-empty'].classList.contains('hidden'), false);
  assert.equal(workspace.elements['#periodicals-empty'].textContent, '暂无精选周报');
  assert.equal(workspace.elements['#periodicals-open'].attributes.get('aria-current'), 'page');

  workspace.root.document.dispatchEvent({
    type: 'click',
    target: {
      closest: selector => selector.includes('[data-view]') ? { dataset: { view: 'starred' } } : null,
    },
  });
  assert.equal(workspace.elements['#app'].classList.contains('periodicals-mode'), false);
  assert.equal(workspace.elements['#periodicals-nav'].classList.contains('hidden'), true);
  assert.equal(workspace.elements['#periodicals-reader'].classList.contains('hidden'), true);
  assert.equal(workspace.elements['#periodicals-open'].attributes.has('aria-current'), false);
});

test('periodical workspace loads the next cursor and persists independent list and document scroll', async () => {
  const issue = {
    cadence: 'daily',
    periodKey: '2026-07-30',
    status: 'open',
    eventCount: 0,
  };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily/2026-07-30',
    responses: [
      { issues: [issue], nextCursor: '2026-07-30' },
      { issue, themes: [], events: [], evidence: [] },
      {
        issues: [{ ...issue, periodKey: '2026-07-29' }],
        nextCursor: null,
      },
    ],
  });

  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;
  const loadMore = descendants(browser.elements['#periodicals-list'])
    .find(node => node.className === 'periodicals-load-more');
  assert.ok(loadMore);
  await loadMore.dispatch('click');
  assert.match(flattenedText(browser.elements['#periodicals-list']), /2026-07-29/);

  browser.elements['#periodicals-list'].scrollTop = 240;
  browser.elements['#periodicals-list'].dispatch('scroll');
  browser.elements['#reader-pane'].scrollTop = 720;
  browser.elements['#reader-pane'].dispatch('scroll');

  assert.equal(browser.root.location.pathname, '/periodicals/daily/2026-07-30');
  assert.deepEqual(browser.root.history.state.periodicals, {
    cadence: 'daily',
    periodKey: '2026-07-30',
    lastCursor: '2026-07-30',
    nextCursor: null,
    listScroll: 240,
    documentScroll: 720,
  });
});

test('popstate restores cadence, period, cursor depth, and both scroll containers', async () => {
  const daily = { cadence: 'daily', periodKey: '2026-07-30', status: 'open' };
  const weekly = { cadence: 'weekly', periodKey: '2026-W31', status: 'frozen' };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily/2026-07-30',
    responses: [
      { issues: [daily], nextCursor: null },
      { issue: daily, themes: [], events: [], evidence: [] },
      { issues: [weekly], nextCursor: 'weekly-cursor' },
      { issues: [{ ...weekly, periodKey: '2026-W30' }], nextCursor: null },
      { issue: weekly, themes: [], events: [], evidence: [] },
    ],
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  browser.root.location.pathname = '/periodicals/weekly/2026-W31';
  const state = {
    periodicals: {
      cadence: 'weekly',
      periodKey: '2026-W31',
      lastCursor: 'weekly-cursor',
      nextCursor: null,
      listScroll: 180,
      documentScroll: 560,
    },
  };
  browser.root.history.state = state;
  await browser.root.dispatchEvent({ type: 'popstate', state });

  assert.equal(browser.tabs[1].attributes.get('aria-selected'), 'true');
  assert.match(flattenedText(browser.elements['#periodicals-list']), /2026-W30/);
  assert.match(flattenedText(browser.elements['#periodicals-document']), /2026-W31/);
  assert.equal(browser.elements['#periodicals-list'].scrollTop, 180);
  assert.equal(browser.elements['#reader-pane'].scrollTop, 560);
});

test('mobile cadence routes stay list-first and enter detail only after selecting an issue', async () => {
  const issue = { cadence: 'daily', periodKey: '2026-07-30', status: 'open' };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily',
    width: 390,
    responses: [
      { issues: [issue], nextCursor: null },
      { issues: [issue], nextCursor: null },
      { issue, themes: [], events: [], evidence: [] },
    ],
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  assert.equal(browser.fetchCount(), 1);
  assert.equal(browser.elements['#app'].classList.contains('periodical-detail-open'), false);
  const issueLink = descendants(browser.elements['#periodicals-list'])
    .find(node => node.className === 'periodicals-list-item');
  await issueLink.dispatch('click');
  assert.equal(browser.fetchCount(), 3);
  assert.deepEqual(browser.fetched, [
    ['/api/periodicals?cadence=daily&limit=30', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals?cadence=daily&limit=30', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals/daily/2026-07-30', {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    }],
  ]);
  assert.equal(browser.elements['#app'].classList.contains('periodical-detail-open'), true);
  assert.equal(browser.elements['#periodicals-back'].classList.contains('hidden'), false);

  browser.elements['#periodicals-back'].dispatch('click');
  assert.equal(browser.root.history.backCalls, 1);
});

test('mobile cadence routes render their empty state instead of a blank list', async () => {
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/weekly',
    width: 390,
    responses: [{ issues: [], nextCursor: null }],
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  assert.equal(browser.elements['#periodicals-empty'].classList.contains('hidden'), false);
  assert.equal(browser.elements['#periodicals-empty'].textContent, '暂无精选周报');
});

test('periodical routing follows live changes across the mobile breakpoint', async () => {
  const issue = { cadence: 'daily', periodKey: '2026-07-30', status: 'frozen' };
  const page = { issues: [issue], nextCursor: null };
  const detail = { issue, themes: [], events: [], evidence: [] };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily/2026-07-30',
    responses: [page, detail, page, detail, page, detail],
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  assert.equal(browser.elements['#app'].classList.contains('periodical-detail-open'), false);
  browser.elements['#periodicals-list'].scrollTop = 180;
  browser.elements['#periodicals-list'].dispatch('scroll');
  browser.elements['#reader-pane'].scrollTop = 240;
  browser.elements['#reader-pane'].dispatch('scroll');
  assert.equal(browser.root.history.state.periodicals.listScroll, 180);
  assert.equal(browser.root.history.state.periodicals.documentScroll, 240);
  browser.elements['#periodicals-list'].setScrollLocked(true);
  browser.elements['#reader-pane'].setScrollLocked(true);
  await browser.setMobileLayout(true);
  assert.equal(browser.elements['#app'].classList.contains('periodical-detail-open'), true);
  assert.equal(browser.elements['#periodicals-back'].classList.contains('hidden'), false);
  browser.elements['#periodicals-list'].dispatch('scroll');
  browser.elements['#reader-pane'].dispatch('scroll');
  assert.equal(browser.root.history.state.periodicals.listScroll, 180);
  assert.equal(browser.root.history.state.periodicals.documentScroll, 240);

  browser.elements['#periodicals-list'].setScrollLocked(false);
  browser.elements['#reader-pane'].setScrollLocked(false);
  await browser.setMobileLayout(false);
  assert.equal(browser.elements['#app'].classList.contains('periodical-detail-open'), false);
  assert.equal(browser.elements['#periodicals-back'].classList.contains('hidden'), true);
  assert.equal(browser.fetchCount(), 6);
});

test('desktop canonicalizes the current issue into the URL and remembers selection per cadence', async () => {
  const dailyLatest = { cadence: 'daily', periodKey: '2026-07-30', volumeNo: 2, status: 'open' };
  const dailySelected = { cadence: 'daily', periodKey: '2026-07-29', volumeNo: 1, status: 'frozen' };
  const weekly = { cadence: 'weekly', periodKey: '2026-W31', volumeNo: 1, status: 'frozen' };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals',
    responses: [
      { issues: [dailyLatest, dailySelected], nextCursor: null },
      { issue: dailyLatest, themes: [], events: [], evidence: [] },
      { issues: [dailyLatest, dailySelected], nextCursor: null },
      { issue: dailySelected, themes: [], events: [], evidence: [] },
      { issues: [weekly], nextCursor: null },
      { issue: weekly, themes: [], events: [], evidence: [] },
      { issues: [dailyLatest, dailySelected], nextCursor: null },
      { issue: dailySelected, themes: [], events: [], evidence: [] },
    ],
  });
  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;
  assert.equal(browser.root.location.pathname, '/periodicals/daily/2026-07-30');

  const selectedLink = descendants(browser.elements['#periodicals-list'])
    .find(node => node.href === '/periodicals/daily/2026-07-29');
  await selectedLink.dispatch('click');
  await browser.tabs[1].dispatch('click');
  assert.equal(browser.root.location.pathname, '/periodicals/weekly/2026-W31');
  await browser.tabs[0].dispatch('click');

  assert.equal(browser.root.location.pathname, '/periodicals/daily/2026-07-29');
  assert.equal(browser.pushed.at(-1), '/periodicals/daily/2026-07-29');
  assert.match(flattenedText(browser.elements['#periodicals-list']), /第 1 卷/);
});

test('finalizing renders the exact state while preserving the last successful revision', async () => {
  const issue = {
    cadence: 'daily',
    periodKey: '2026-07-29',
    volumeNo: 1,
    status: 'finalizing',
    eventCount: 0,
    overview: '这是跨过上海日界线前最后一次成功生成的内容。',
    lastSuccessfulAt: NOW,
    updateDelayed: true,
    updateState: 'retry_wait',
  };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily/2026-07-29',
    responses: [
      { issues: [issue], nextCursor: null },
      { issue, themes: [], events: [], evidence: [] },
    ],
  });

  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  const indexText = flattenedText(browser.elements['#periodicals-list']);
  assert.match(indexText, /正在定稿/);
  assert.doesNotMatch(indexText, /生成异常/);
  assert.match(flattenedText(browser.elements['#periodicals-document']), /正在定稿/);
  assert.match(
    flattenedText(browser.elements['#periodicals-document']),
    /这是跨过上海日界线前最后一次成功生成的内容/,
  );
});

test('periodical workspace renders the complete cadence, build, empty, and fault state matrix', async () => {
  const issue = overrides => ({
    cadence: 'daily',
    periodKey: '2026-07-30',
    volumeNo: 1,
    status: 'open',
    eventCount: 0,
    updateState: 'succeeded',
    lastSuccessfulAt: NOW,
    overview: '本期概览。',
    ...overrides,
  });
  const cases = [
    {
      name: 'weekly cadence empty',
      pathname: '/periodicals/weekly',
      responses: [{ issues: [], nextCursor: null }],
      expected: /暂无精选周报/,
    },
    {
      name: 'collecting',
      value: issue({ updateState: 'running', lastSuccessfulAt: null }),
      expected: /正在收集本期内容/,
    },
    {
      name: 'below threshold',
      value: issue({}),
      expected: /本期尚未达到入选门槛/,
    },
    {
      name: 'delayed',
      value: issue({ updateDelayed: true, updateState: 'retry_wait' }),
      expected: /本期更新延迟 · 最后成功更新 2026-07-30 12:00/,
    },
    {
      name: 'finalizing',
      value: issue({ status: 'finalizing', updateState: 'running' }),
      expected: /正在定稿/,
    },
    {
      name: 'frozen empty periodical',
      pathname: '/periodicals/monthly/2026-07',
      value: issue({ cadence: 'monthly', periodKey: '2026-07', status: 'frozen' }),
      expected: /本期无入选事件 · 已冻结/,
    },
    {
      name: 'fallback summary',
      value: issue({ summaryStatus: 'fallback' }),
      expected: /本期使用规则摘要/,
    },
    {
      name: 'index error',
      responses: [{ ok: false, status: 503, body: { error: 'index' } }],
      expected: /期刊索引暂时不可用/,
    },
    {
      name: 'offline shell',
      online: false,
      responses: [],
      expected: /^ 需要连接网络 $/,
    },
    {
      name: 'document 404',
      value: issue({}),
      detailResponse: { ok: false, status: 404, body: { error: 'missing' } },
      expected: /未找到这期精选期刊/,
    },
    {
      name: 'document error',
      value: issue({}),
      detailResponse: { ok: false, status: 503, body: { error: 'detail' } },
      expected: /期刊正文暂时不可用/,
    },
  ];

  for (const current of cases) {
    const pathname = current.pathname || '/periodicals/daily/2026-07-30';
    const responses = current.responses || [
      { issues: [current.value], nextCursor: null },
      current.detailResponse || { issue: current.value, themes: [], events: [], evidence: [] },
    ];
    const browser = fakeBrowser({
      mode: 'on',
      pathname,
      responses,
      online: current.online !== false,
    });
    const mounted = mountPeriodicals(browser.root);
    await mounted.ready;
    const text = [
      flattenedText(browser.elements['#periodicals-list']),
      flattenedText(browser.elements['#periodicals-empty']),
      flattenedText(browser.elements['#periodicals-document']),
    ].join(' ');
    assert.match(text, current.expected, current.name);
  }
});

test('periodical mount renders an explainable issue with score reasons and SQLite evidence', async () => {
  const index = {
    issues: [{
      cadence: 'daily',
      periodKey: '2026-07-30',
      volumeNo: 1,
      status: 'open',
      eventCount: 1,
      lastSuccessfulAt: NOW,
      updateDelayed: true,
      updateState: 'retry_wait',
    }],
    nextCursor: null,
  };
  const detail = {
    issue: {
      cadence: 'daily',
      periodKey: '2026-07-30',
      volumeNo: 1,
      periodStartAt: Date.parse('2026-07-30T00:00:00.000+08:00'),
      periodEndAt: Date.parse('2026-07-31T00:00:00.000+08:00'),
      coverageStartedAt: Date.parse('2026-07-30T00:00:00.000+08:00'),
      status: 'open',
      overview: '本期从 SQLite 候选中选出 1 个事件。所有事件保留证据快照。',
      lastSuccessfulAt: NOW,
      updateDelayed: true,
      updateState: 'retry_wait',
    },
    themes: [{
      id: 'theme-products',
      themeKey: 'products_tools',
      title: '产品与工具',
      trendNote: '本期该主题收录 1 个事件。',
      displayOrder: 0,
    }],
    events: [{
      id: 'event-one',
      themeId: 'theme-products',
      title: '一次确定性的发布',
      summary: '事件摘要。',
      whySelected: '来源质量（高）计 30 分；获得 2 个独立来源确认（8 分）；相关主题过去 7 个冻结日报出现 1 天（3.5 分）；独立来源较近 7 日单日峰值增加 1 个（2 分）；时效性计 19.8 分。',
      importanceScore: 63.3,
      score: {
        version: 'importance-v1',
        sourceQuality: { priority: 'high', points: 30 },
        confirmation: { independentSourceCount: 2, points: 8 },
        persistence: { daysPresent: 1, points: 3.5 },
        trend: { baselineSourceCount: 1, sourceIncrease: 1, points: 2 },
        freshness: { ageHours: 0.5, points: 19.8 },
        behavior: { enabled: false, points: 0 },
      },
      displayOrder: 0,
    }],
    evidence: [{
      eventId: 'event-one',
      entryId: 'entry-one',
      sourceName: 'High Source',
      sourceLabels: ['AI', '产品'],
      entryTitle: 'A deterministic release',
      entryLink: 'https://example.com/releases/one',
      entryAvailable: true,
      summaryExcerpt: 'Active frozen evidence snapshot.',
      editorialPriority: 'high',
      effectivePublishedAt: NOW - (30 * 60 * 1000),
      timestampFallback: false,
      displayOrder: 0,
    }, {
      eventId: 'event-one',
      entryId: 'entry-two',
      sourceName: 'Second Source',
      entryTitle: 'A second independent report',
      entryLink: 'https://second.example/releases/one',
      entryAvailable: false,
      summaryExcerpt: 'Deleted frozen evidence snapshot.',
      editorialPriority: 'normal',
      effectivePublishedAt: NOW - (20 * 60 * 1000),
      timestampFallback: false,
      displayOrder: 1,
    }],
  };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/daily/2026-07-30',
    responses: [index, detail],
  });

  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  const documentNode = browser.elements['#periodicals-document'];
  const text = flattenedText(documentNode);
  const indexText = flattenedText(browser.elements['#periodicals-list']);
  assert.equal(browser.fetchCount(), 2);
  assert.equal(documentNode.classList.contains('hidden'), false);
  assert.equal(browser.elements['#periodicals-empty'].classList.contains('hidden'), true);
  assert.match(text, /日报 · 第 1 卷 · 2026-07-30 · 更新中/);
  assert.match(text, /覆盖 2026-07-30/);
  assert.match(text, /本期更新延迟/);
  assert.match(text, /最后成功更新 2026-07-30 12:00/);
  assert.match(indexText, /更新延迟/);
  assert.match(indexText, /最后成功 2026-07-30 12:00/);
  assert.match(text, /本期从 SQLite 候选中选出 1 个事件/);
  assert.match(text, /目录/);
  assert.match(text, /产品与工具/);
  assert.match(text, /一次确定性的发布/);
  assert.match(text, /63\.3 分/);
  assert.match(text, /2 个独立来源/);
  assert.match(text, /评分分量/);
  assert.match(text, /importance-v1/);
  assert.match(text, /独立确认/);
  assert.match(text, /近期持续/);
  assert.match(text, /趋势增量/);
  assert.match(text, /来源质量（高）计 30 分；获得 2 个独立来源确认/);
  assert.match(text, /High Source/);
  assert.match(text, /AI、产品/);
  assert.match(text, /Second Source/);
  assert.match(text, /A deterministic release/);
  assert.match(text, /原文已不可用 · 冻结快照/);
  assert.match(text, /Deleted frozen evidence snapshot/);
  assert.match(text, /高优先级 · 2026-07-30 11:30/);
  const links = descendants(documentNode).filter(node => node.tagName === 'A');
  assert.equal(links.some(link => link.href === '/articles/entry-one'), true);
  assert.equal(links.some(link => link.href === '/articles/entry-two'), false);
  assert.equal(links.some(link => link.href === 'https://example.com/releases/one'), true);
  assert.equal(
    links.filter(link => /^https:/.test(link.href))
      .every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'),
    true,
  );
  assert.equal(descendants(documentNode).some(node => node.tagName === 'DETAILS'), true);
  assert.equal(descendants(documentNode).some(node => node.tagName === 'SUMMARY'), true);

  const internalEvidenceLink = links.find(link => link.href === '/articles/entry-one');
  browser.elements['#reader-pane'].scrollTop = 360;
  internalEvidenceLink.dispatch('click', { type: 'click' });
  assert.equal(browser.root.location.pathname, '/periodicals/daily/2026-07-30');
  assert.equal(browser.root.history.state.periodicals.documentScroll, 360);
});

test('Weekly deep link renders its index, detail, rollup score, and Frozen evidence', async () => {
  const index = {
    issues: [{
      cadence: 'weekly',
      periodKey: '2026-W32',
      volumeNo: 1,
      status: 'frozen',
      eventCount: 1,
      lastSuccessfulAt: NOW,
    }],
    nextCursor: null,
  };
  const detail = {
    issue: {
      cadence: 'weekly',
      periodKey: '2026-W32',
      volumeNo: 1,
      status: 'frozen',
      overview: '本周从七份冻结日报汇总出 1 个事件。',
      lastSuccessfulAt: NOW,
    },
    themes: [{
      id: 'weekly-products',
      themeKey: 'products_tools',
      title: '产品与工具',
      trendNote: '本周该主题收录 1 个跨日事件。',
      displayOrder: 0,
    }],
    events: [{
      id: 'weekly-event',
      themeId: 'weekly-products',
      title: 'Atlas 发布稳定更新',
      summary: 'Frozen Daily 快照显示 Atlas 持续更新。',
      whySelected: '最高日报重要性 80 分；top-3 日报均值 70 分；本周出现 4 天；覆盖 4 个来源。',
      importanceScore: 74.8,
      score: {
        version: 'weekly-rollup-v1',
        maxDailyScore: { value: 80, weight: 0.65, points: 52 },
        meanTop3DailyScores: { value: 70, weight: 0.2, points: 14 },
        occurrenceDays: { daysPresent: 4, periodDays: 7, points: 5 },
        sourceBreadth: { distinctSources: 4, points: 3.8 },
      },
      displayOrder: 0,
    }],
    evidence: Array.from({ length: 4 }, (_, indexValue) => ({
      eventId: 'weekly-event',
      entryId: `weekly-entry-${indexValue}`,
      sourceName: `Frozen Source ${indexValue + 1}`,
      entryTitle: `Frozen Daily evidence ${indexValue + 1}`,
      entryLink: `https://frozen-${indexValue + 1}.example/atlas`,
      editorialPriority: 'high',
      effectivePublishedAt: NOW - (indexValue * 60 * 60 * 1000),
      timestampFallback: false,
      displayOrder: indexValue,
    })),
  };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/weekly/2026-W32',
    responses: [index, detail, {
      evidence: detail.evidence.map(item => ({
        eventId: item.eventId,
        entryId: item.entryId,
        entryAvailable: true,
      })),
    }],
  });

  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  const indexText = flattenedText(browser.elements['#periodicals-list']);
  const detailText = flattenedText(browser.elements['#periodicals-document']);
  assert.equal(browser.fetchCount(), 3);
  assert.deepEqual(browser.fetched, [
    ['/api/periodicals?cadence=weekly&limit=30', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals/weekly/2026-W32', {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals/weekly/2026-W32/evidence-availability', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
  ]);
  assert.match(indexText, /2026-W32/);
  assert.match(indexText, /1 个事件 · 已冻结/);
  assert.match(detailText, /周报 · 第 1 卷 · 2026-W32 · 已冻结/);
  assert.match(detailText, /weekly-rollup-v1/);
  assert.match(detailText, /最高日报分/);
  assert.match(detailText, /Top-3 均值/);
  assert.match(detailText, /出现天数/);
  assert.match(detailText, /来源广度/);
  assert.match(detailText, /4 个来源 · 4 条证据/);
  assert.match(detailText, /最高日报重要性 80 分；top-3 日报均值 70 分/);
  assert.match(detailText, /Frozen Source 1/);
  assert.match(detailText, /Frozen Daily evidence 4/);
});

test('Monthly deep link renders its index, detail, rollup score, and Frozen evidence', async () => {
  const index = {
    issues: [{
      cadence: 'monthly',
      periodKey: '2026-07',
      volumeNo: 1,
      status: 'frozen',
      eventCount: 1,
      lastSuccessfulAt: NOW,
    }],
    nextCursor: null,
  };
  const detail = {
    issue: {
      cadence: 'monthly',
      periodKey: '2026-07',
      volumeNo: 1,
      status: 'frozen',
      overview: '本月从冻结日报汇总出一个事件。所有证据均受冻结边界约束。',
      lastSuccessfulAt: NOW,
    },
    themes: [{
      id: 'monthly-products',
      themeKey: 'products_tools',
      title: '产品与工具',
      trendNote: '本月该主题收录一个跨日事件。',
      displayOrder: 0,
    }],
    events: [{
      id: 'monthly-event',
      themeId: 'monthly-products',
      title: 'Atlas 发布稳定更新',
      summary: 'Frozen Daily 快照显示 Atlas 持续更新。',
      whySelected: '最高日报重要性 80 分；top-3 日报均值 70 分；本月出现 4 天；覆盖 4 个来源。',
      importanceScore: 74.8,
      score: {
        version: 'monthly-rollup-v1',
        maxDailyScore: { value: 80, weight: 0.65, points: 52 },
        meanTop3DailyScores: { value: 70, weight: 0.2, points: 14 },
        occurrenceDays: { daysPresent: 4, periodDays: 31, points: 5 },
        sourceBreadth: { distinctSources: 4, points: 3.8 },
      },
      displayOrder: 0,
    }],
    evidence: Array.from({ length: 4 }, (_, indexValue) => ({
      eventId: 'monthly-event',
      entryId: `monthly-entry-${indexValue}`,
      sourceName: `Frozen Source ${indexValue + 1}`,
      entryTitle: `Frozen Daily evidence ${indexValue + 1}`,
      entryLink: `https://frozen-${indexValue + 1}.example/atlas`,
      editorialPriority: 'high',
      effectivePublishedAt: NOW - (indexValue * 60 * 60 * 1000),
      timestampFallback: false,
      displayOrder: indexValue,
    })),
  };
  const browser = fakeBrowser({
    mode: 'on',
    pathname: '/periodicals/monthly/2026-07',
    responses: [index, detail, {
      evidence: detail.evidence.map(item => ({
        eventId: item.eventId,
        entryId: item.entryId,
        entryAvailable: true,
      })),
    }],
  });

  const mounted = mountPeriodicals(browser.root);
  await mounted.ready;

  const indexText = flattenedText(browser.elements['#periodicals-list']);
  const detailText = flattenedText(browser.elements['#periodicals-document']);
  assert.equal(browser.fetchCount(), 3);
  assert.deepEqual(browser.fetched, [
    ['/api/periodicals?cadence=monthly&limit=30', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals/monthly/2026-07', {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    }],
    ['/api/periodicals/monthly/2026-07/evidence-availability', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }],
  ]);
  assert.match(indexText, /2026-07/);
  assert.match(indexText, /1 个事件 · 已冻结/);
  assert.match(detailText, /月报 · 第 1 卷 · 2026-07 · 已冻结/);
  assert.match(detailText, /monthly-rollup-v1/);
  assert.match(detailText, /最高日报分/);
  assert.match(detailText, /Top-3 均值/);
  assert.match(detailText, /出现天数/);
  assert.match(detailText, /4\/31 天/);
  assert.match(detailText, /来源广度/);
  assert.match(detailText, /4 个来源 · 4 条证据/);
  assert.match(detailText, /本月出现 4 天/);
  assert.match(detailText, /Frozen Source 1/);
  assert.match(detailText, /Frozen Daily evidence 4/);
});
