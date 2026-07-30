const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPeriodicalsController,
  mountPeriodicals,
  parsePeriodicalPath,
} = require('../public/periodicals');

function fakeElement(classes = []) {
  const values = new Set(classes);
  const listeners = new Map();
  const attributes = new Map();
  return {
    attributes,
    children: [],
    classList: {
      add: value => values.add(value),
      contains: value => values.has(value),
      remove: value => values.delete(value),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    dispatch: type => listeners.get(type)?.({ preventDefault() {} }),
    removeAttribute: name => attributes.delete(name),
    replaceChildren(...children) { this.children = children; },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    textContent: '',
  };
}

function fakeBrowser({ mode, pathname }) {
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
    createElement: () => fakeElement(),
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
        return { ok: true, json: async () => ({ issues: [], nextCursor: null }) };
      },
      location: {
        assign: pathname => assigned.push(pathname),
        pathname,
      },
    },
  };
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
