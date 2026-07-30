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
  return {
    attributes,
    children: [],
    className: '',
    dataset: {},
    tagName,
    classList: {
      add: value => values.add(value),
      contains: value => values.has(value),
      remove: value => values.delete(value),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    append(...children) { this.children.push(...children); },
    dispatch: type => listeners.get(type)?.({ preventDefault() {} }),
    removeAttribute: name => attributes.delete(name),
    replaceChildren(...children) { this.children = children; },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    textContent: '',
  };
}

function fakeBrowser({ mode, pathname, responses = [] }) {
  const elements = {
    '#app': fakeElement(),
    '#periodicals-open': fakeElement(['hidden']),
    '#periodicals-nav': fakeElement(['hidden']),
    '#periodicals-reader': fakeElement(['hidden']),
    '#periodicals-empty': fakeElement(['hidden']),
    '#periodicals-document': fakeElement(['hidden']),
    '#periodicals-list': fakeElement(),
  };
  const tabs = ['daily', 'weekly', 'monthly'].map(cadence => {
    const tab = fakeElement();
    tab.dataset = { periodicalCadence: cadence };
    return tab;
  });
  const assigned = [];
  const documentListeners = new Map();
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
  return {
    assigned,
    elements,
    fetchCount: () => fetchCount,
    root: {
      document,
      fetch: async () => {
        fetchCount += 1;
        const payload = responses[fetchCount - 1] || { issues: [], nextCursor: null };
        return { ok: true, json: async () => payload };
      },
      location: {
        assign: pathname => assigned.push(pathname),
        pathname,
      },
    },
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

test('periodical controller loads only the SQLite index for root and legal deep links', async () => {
  const requests = [];
  const rendered = [];
  const controller = createPeriodicalsController({
    request: async url => {
      requests.push(url);
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
    '/api/periodicals?cadence=daily&limit=30',
    '/api/periodicals?cadence=weekly&limit=30',
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
    request: async url => {
      requests.push(url);
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
    '/api/periodicals?cadence=daily&limit=30',
    '/api/periodicals/daily/2026-07-30',
  ]);
  assert.deepEqual(rendered, [
    ['enter', 'daily'],
    ['index', 'daily', 1],
    ['issue', detail],
  ]);
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
  assert.equal(workspace.elements['#periodicals-empty'].textContent, '精选期刊正在准备第一期');
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

test('periodical mount renders an explainable issue with score reasons and SQLite evidence', async () => {
  const index = {
    issues: [{
      cadence: 'daily',
      periodKey: '2026-07-30',
      volumeNo: 1,
      status: 'open',
      eventCount: 1,
    }],
    nextCursor: null,
  };
  const detail = {
    issue: {
      cadence: 'daily',
      periodKey: '2026-07-30',
      volumeNo: 1,
      status: 'open',
      overview: '本期从 SQLite 候选中选出 1 个事件。所有事件保留证据快照。',
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
      entryTitle: 'A deterministic release',
      entryLink: 'https://example.com/releases/one',
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
  assert.equal(browser.fetchCount(), 2);
  assert.equal(documentNode.classList.contains('hidden'), false);
  assert.equal(browser.elements['#periodicals-empty'].classList.contains('hidden'), true);
  assert.match(text, /日报 · 第 1 卷 · 2026-07-30 · 更新中/);
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
  assert.match(text, /Second Source/);
  assert.match(text, /A deterministic release/);
  assert.match(text, /高优先级 · 2026-07-30 11:30/);
  const links = descendants(documentNode).filter(node => node.tagName === 'A');
  assert.equal(links.some(link => link.href === 'https://example.com/releases/one'), true);
  assert.equal(descendants(documentNode).some(node => node.tagName === 'DETAILS'), true);
  assert.equal(descendants(documentNode).some(node => node.tagName === 'SUMMARY'), true);
});
