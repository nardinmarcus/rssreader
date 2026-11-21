const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const appFunctions = require('./helpers/workspace-app');

const projectDir = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(projectDir, 'public', 'sw.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

test('sourceBackfillHtml renders execution status, coverage, progress, error, and admin actions', () => {
  const appSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const constantsMatch = appSource.match(/const BACKFILL_STATUS_LABELS = [\s\S]*?const BACKFILL_ACTION_LABELS = \{[\s\S]*?\};/);
  assert.ok(constantsMatch, 'expected BACKFILL_*_LABELS in public/app.js');
  const context = {
    escapeHtml: value => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    Intl,
  };
  vm.createContext(context);
  vm.runInContext(constantsMatch[0], context);
  appFunctions(context, [
    'formatBackfillDate',
    'formatSourceCoverageRange',
    'sourceCoverageNoticeLabel',
    'sourceBackfillHtml',
  ]);

  const runningHtml = context.sourceBackfillHtml({
    id: 'src-1',
    isCustom: true,
    backfill: {
      status: 'running',
      coverage: {
        status: 'available_window',
        entryCount: 60,
        earliestPublishedAt: Date.UTC(2026, 0, 1),
        latestPublishedAt: Date.UTC(2026, 2, 1),
        summaryText: '已覆盖当前可用供给窗口，更早历史覆盖未知',
      },
      counts: { totalCount: 120, processedCount: 60, insertedCount: 40, reusedCount: 20 },
      run: { id: 'run-1' },
      availableActions: ['pause'],
      error: null,
    },
  });
  assert.match(runningHtml, /回填中/);
  assert.match(runningHtml, /当前窗口/);
  assert.match(runningHtml, /进度 60\/120 · 新增 40 · 复用 20/);
  assert.match(runningHtml, /data-backfill-action="pause"/);
  assert.match(runningHtml, /暂停回填/);

  const failedHtml = context.sourceBackfillHtml({
    id: 'src-1',
    isCustom: true,
    backfill: {
      status: 'failed',
      coverage: {
        status: 'mismatch',
        entryCount: 10,
        summaryText: '供给身份不匹配，已保留先前内容',
      },
      counts: { totalCount: 50, processedCount: 10, insertedCount: 10, reusedCount: 0 },
      run: { id: 'run-2' },
      availableActions: ['retry'],
      error: { code: 'ERR_BACKFILL_ACCOUNT_MISMATCH', message: '供给账号身份与已验证来源不一致，已保留既有内容' },
    },
  });
  assert.match(failedHtml, /回填失败/);
  assert.match(failedHtml, /身份不匹配/);
  assert.match(failedHtml, /供给账号身份与已验证来源不一致/);
  assert.match(failedHtml, /data-backfill-action="retry"/);
  assert.match(failedHtml, /重试回填/);

  const notice = context.sourceCoverageNoticeLabel({
    coverage: {
      status: 'available_window',
      entryCount: 110,
      earliestPublishedAt: Date.UTC(2026, 0, 1),
      latestPublishedAt: Date.UTC(2026, 2, 1),
      summaryText: '已覆盖当前可用供给窗口，更早历史覆盖未知',
    },
  });
  assert.match(notice, /已存 110 篇/);
  assert.match(notice, /已覆盖当前可用供给窗口，更早历史覆盖未知/);
  assert.match(styles, /\.m-backfill/);
  assert.match(styles, /\.source-coverage-banner/);
});

test('renderList keeps source-coverage-banner even when the filtered source list is empty', () => {
  const appended = [];
  const el = {
    innerHTML: '',
    scrollTop: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(node) { appended.push(node); },
  };
  const context = {
    state: {
      view: 'all',
      filterSource: 'src-empty',
      filterCategory: null,
      assetFilter: null,
      listSort: 'latest',
      homeTab: 'entries',
      q: '',
      read: new Set(),
      starred: new Set(),
    },
    $: selector => (selector === '#entry-list' ? el : { classList: { toggle() {} }, innerHTML: '' }),
    document: {
      createElement: tag => ({ tag, className: '', textContent: '', innerHTML: '' }),
    },
    isHomeScope: () => false,
    isSourceHistoryMode: () => true,
    sourceById: () => ({
      id: 'src-empty',
      coverage: { status: 'mismatch', entryCount: 0, summaryText: '供给身份不匹配，已保留先前内容' },
    }),
    renderEntryPaneTabs: () => {},
    renderListControls: () => {},
    renderAssetActivityStrip: () => {},
    visibleEntries: () => [],
    renderEntryListFooter: () => {},
    escapeHtml: v => String(v || ''),
    assetDirectoryLabel: v => v,
    Intl,
  };
  vm.createContext(context);
  appFunctions(context, [
    'formatBackfillDate',
    'formatSourceCoverageRange',
    'sourceCoverageNoticeLabel',
    'renderList',
  ]);
  context.renderList();
  assert.ok(appended.some(node => node.className === 'source-coverage-banner' && /供给身份不匹配/.test(node.textContent)));
  assert.ok(appended.some(node => node.className === 'list-empty'));
});

test('service worker leaves backfill admin and sources APIs network-only', async () => {
  const cachesDeleted = [];
  const listeners = {};
  const context = {
    caches: {
      open: async () => ({ addAll: async () => {} }),
      keys: async () => [],
      delete: async key => cachesDeleted.push(key),
      match: async () => { throw new Error('API request must not read from cache'); },
    },
    fetch: async () => { throw new Error('API request must stay network-only outside respondWith'); },
    self: {
      location: { origin: 'https://reader.test' },
      addEventListener(type, listener) { listeners[type] = listener; },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    },
    URL,
  };
  vm.createContext(context);
  vm.runInContext(sw, context);

  for (const apiPath of ['/api/admin/sources/custom-1/backfill', '/api/sources']) {
    let respondWithCalled = false;
    listeners.fetch({
      request: { method: 'GET', mode: 'cors', url: `https://reader.test${apiPath}` },
      respondWith() { respondWithCalled = true; },
    });
    assert.equal(respondWithCalled, false, `${apiPath} must stay network-only`);
  }
});
