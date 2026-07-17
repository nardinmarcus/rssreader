const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const projectDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

function attributesForElement(source, tagName, id) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*\\bid="${id}"[^>]*)>`, 'i');
  const match = source.match(pattern);
  assert.ok(match, `expected <${tagName}>#${id}`);
  return match[1];
}

function sourceForFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}() in public/app.js`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function executeFunction(name, args, globals = {}) {
  const context = { ...globals, args, result: undefined };
  vm.runInNewContext(
    `${sourceForFunction(app, name)}\nresult = ${name}(...args);`,
    context,
  );
  return context;
}

function evaluatePureFunction(name, args, globals = {}) {
  const context = executeFunction(name, args, globals);
  const serialized = JSON.stringify(context.result);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

function balancedBlockAt(source, start) {
  assert.notEqual(start, -1, 'expected block start');
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, 'expected opening brace');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail('expected closing brace');
}

function sourceForAsyncFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `expected async ${name}() in public/app.js`);
  const bodyStart = source.indexOf(') {', start);
  assert.notEqual(bodyStart, -1, `expected body for async ${name}()`);
  return source.slice(start, bodyStart) + balancedBlockAt(source, bodyStart);
}

function blocksForMedia(source, query) {
  const needle = `@media ${query}`;
  const blocks = [];
  let start = source.indexOf(needle);
  while (start !== -1) {
    blocks.push(balancedBlockAt(source, start));
    start = source.indexOf(needle, start + needle.length);
  }
  return blocks;
}

function sourceForDocumentHandler(eventName) {
  const marker = `document.addEventListener('${eventName}', `;
  const listenerStart = app.lastIndexOf(marker);
  assert.notEqual(listenerStart, -1, `expected document ${eventName} listener`);
  return balancedBlockAt(app, listenerStart + marker.length);
}

function assertNoMatch(source, pattern, message) {
  const match = source.match(pattern);
  assert.ok(!match, match ? `${message}: found ${JSON.stringify(match[0])}` : message);
}

test('reader exposes four stable, accessible reading-mode tabs', () => {
  const tabs = {
    original: 'reader-original-panel',
    rewrite: 'reader-rewrite-panel',
    onepage: 'reader-onepage-panel',
    translation: 'reader-translation',
  };

  for (const [tab, panelId] of Object.entries(tabs)) {
    const tabId = `reader-tab-${tab}`;
    const tabAttributes = attributesForElement(html, 'button', tabId);
    const panelAttributes = attributesForElement(html, 'section', panelId);
    assert.match(tabAttributes, new RegExp(`\\bdata-tab="${tab}"`));
    assert.match(tabAttributes, /\brole="tab"/);
    assert.match(tabAttributes, new RegExp(`\\baria-controls="${panelId}"`));
    assert.match(tabAttributes, /\baria-selected="(?:true|false)"/);
    assert.match(panelAttributes, /\brole="tabpanel"/);
    assert.match(panelAttributes, new RegExp(`\\baria-labelledby="${tabId}"`));
  }

  const tabButtons = [...html.matchAll(/<button\b[^>]*>/g)].filter(match => {
    const className = match[0].match(/\bclass="([^"]*)"/)?.[1] || '';
    return className.split(/\s+/).includes('reader-tab');
  });
  assert.equal(tabButtons.length, 4);

  const setReaderTab = sourceForFunction(app, 'setReaderTab');
  assert.match(setReaderTab, /aria-selected|ariaSelected/);
});

test('reader tabs use four equal columns in every declared grid layout', () => {
  const gridRules = [...styles.matchAll(/(?:#app\.reading\s+)?\.reader-tabs\s*\{([^}]*)\}/g)]
    .map(match => match[1])
    .filter(rule => /grid-template-columns:/.test(rule));

  assert.ok(gridRules.length > 0, 'expected at least one reader-tab grid rule');
  for (const rule of gridRules) {
    assert.match(rule, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  }
});

test('mobile reader tabs keep a 44px touch target', () => {
  const mobileBlocks = blocksForMedia(styles, '(max-width: 860px)');
  assert.ok(
    mobileBlocks.some(block => /#app\.reading\s+\.reader-tab\s*\{[^}]*min-height:\s*44px\s*;/s.test(block)),
    'expected mobile reader tabs to be at least 44px high',
  );
});

test('confirmation dialog never treats document-level Enter as confirmation', () => {
  const showConfirmDialog = sourceForFunction(app, 'showConfirmDialog');
  assert.doesNotMatch(
    showConfirmDialog,
    /\.key\s*===\s*['"]Enter['"][\s\S]{0,160}close\(true\)/,
  );
});

test('keyboard article navigation stays immediate and has no reader motion state', () => {
  assertNoMatch(app, /readerNavBusy/, 'reader navigation must not use a busy input lock');
  assertNoMatch(app, /delay\(120\)/, 'reader navigation must not wait before opening an article');
  assertNoMatch(styles, /@keyframes\s+readerNav/, 'reader navigation must not define keyframes');
  assertNoMatch(
    styles,
    /\.reader-nav-(?:enter|exit|edge)-(?:next|prev)\b/,
    'reader navigation must not retain motion classes',
  );
});

test('toast exposes polite live-region semantics', () => {
  const toastAttributes = attributesForElement(html, 'div', 'toast');
  assert.match(toastAttributes, /\brole="status"/);
  assert.match(toastAttributes, /\baria-live="polite"/);
  assert.match(toastAttributes, /\baria-atomic="true"/);
});

test('legacy reader signal rail is absent from markup, behavior, and styles', () => {
  const pattern = /reader-signal-rail|reader-signal-btn|reader-rail-/;
  assertNoMatch(html, pattern, 'reader signal rail must be removed from markup');
  assertNoMatch(app, pattern, 'reader signal rail must be removed from behavior');
  assertNoMatch(styles, pattern, 'reader signal rail must be removed from styles');
});

test('full desktop reader layout starts at 1181px', () => {
  const fullDesktopSelector = /#app\.reading:not\(\.left-collapsed\):not\(\.reader-immersive\)/;
  const desktopBlocks = blocksForMedia(styles, '(min-width: 1181px)');
  assert.ok(
    desktopBlocks.some(block => fullDesktopSelector.test(block)),
    'expected the full desktop reader layout under @media (min-width: 1181px)',
  );

  for (const staleBlock of blocksForMedia(styles, '(min-width: 981px)')) {
    assertNoMatch(
      staleBlock,
      fullDesktopSelector,
      'the old 981px breakpoint must not restore the full desktop reader layout',
    );
  }
});

test('responsive layout bands meet exactly at the supported breakpoints', () => {
  const cases = [
    [1181, 'desktop'],
    [1180, 'compact'],
    [981, 'compact'],
    [980, 'tablet'],
    [861, 'tablet'],
    [860, 'mobile'],
  ];

  for (const [width, expected] of cases) {
    assert.equal(evaluatePureFunction('responsiveLayoutBand', [width]), expected, `${width}px`);
  }
});

test('reader context target respects entry state, viewport, preference, and route intent', () => {
  const target = options => evaluatePureFunction('readerContextTarget', [options]);

  assert.deepEqual(
    target({ band: 'desktop', hasEntry: false, preferenceCollapsed: false }),
    { collapsed: true, auto: true },
  );
  assert.deepEqual(
    target({ band: 'desktop', hasEntry: true, preferenceCollapsed: false, insufficient: false }),
    { collapsed: false, auto: false },
  );
  assert.deepEqual(
    target({ band: 'desktop', hasEntry: true, preferenceCollapsed: true, insufficient: false }),
    { collapsed: true, auto: false },
  );
  assert.deepEqual(
    target({ band: 'desktop', hasEntry: true, preferenceCollapsed: false, insufficient: true }),
    { collapsed: true, auto: true },
  );
  assert.deepEqual(
    target({ band: 'compact', hasEntry: true, preferenceCollapsed: false }),
    { collapsed: false, auto: false },
  );
  assert.deepEqual(
    target({ band: 'compact', hasEntry: true, preferenceCollapsed: true }),
    { collapsed: true, auto: false },
  );
  for (const band of ['tablet', 'mobile']) {
    assert.deepEqual(
      target({ band, hasEntry: true, preferenceCollapsed: false }),
      { collapsed: true, auto: true },
      band,
    );
  }
  assert.deepEqual(
    target({
      band: 'mobile',
      hasEntry: true,
      preserveExpanded: true,
      preferenceCollapsed: true,
      insufficient: true,
    }),
    { collapsed: false, auto: false },
  );
});

test('asset open options preserve the correct immutable asset or item id', () => {
  const globals = {
    ASSET_FILTER_TYPES: ['translation', 'rewrite', 'onepage', 'annotations', 'comments', 'chat'],
  };
  const cases = {
    translation: { aiAssetId: 'translation-id' },
    rewrite: { aiAssetId: 'rewrite-id' },
    onepage: { aiAssetId: 'onepage-id' },
    annotations: { annotationId: 'annotations-id' },
    comments: { commentId: 'comments-id' },
    chat: { chatMessageId: 'chat-id' },
  };

  for (const [type, routedId] of Object.entries(cases)) {
    const id = `${type}-id`;
    assert.deepEqual(
      evaluatePureFunction('assetOpenOptions', [type, id], globals),
      {
        focus: type,
        aiAssetId: '',
        annotationId: '',
        commentId: '',
        chatMessageId: '',
        ...routedId,
      },
      type,
    );
  }
});

test('helpful Onepage previews and item lists select topHelpfulOnepage', () => {
  const topHelpfulOnepage = {
    id: 'onepage-top',
    type: 'onepage',
    text: 'Top Onepage',
    helpfulCount: 12,
    at: 12,
  };
  const entry = {
    assets: {
      topHelpfulOnepage,
      topHelpfulComment: {
        id: 'comment-top',
        type: 'comments',
        text: 'Top comment',
        helpfulCount: 99,
        at: 99,
      },
      items: {
        onepage: [{
          id: 'onepage-other',
          type: 'onepage',
          text: 'Other Onepage',
          helpfulCount: 2,
          at: 2,
        }],
      },
    },
  };
  const state = { view: 'assets', assetSort: 'helpful', assetFilter: 'onepage' };

  assert.equal(
    evaluatePureFunction('assetPreviewForEntry', [entry], {
      state,
      assetPreviewForType: () => null,
    }).id,
    'onepage-top',
  );

  const listHtml = evaluatePureFunction('assetItemListHtml', [entry], {
    state,
    ASSET_FILTER_TYPES: ['translation', 'rewrite', 'onepage', 'annotations', 'comments', 'chat'],
    ASSET_TYPE_LABELS: { onepage: 'Onepage' },
    assetCountForType: () => 2,
    assetPreviewHtml: item => `<article data-id="${item.id}"></article>`,
    escapeHtml: value => String(value ?? ''),
  });
  assert.match(listHtml, /data-id="onepage-top"/);
  assert.doesNotMatch(listHtml, /data-id="comment-top"/);
});

test('opening a My Asset keeps the destination URL available for article navigation', () => {
  const openMyAsset = sourceForFunction(app, 'openMyAsset');
  assert.match(openMyAsset, /closeMyCommentsModal\(\{\s*clearUrl:\s*false\s*\}\)/);
  assert.ok(
    openMyAsset.indexOf('closeMyCommentsModal') < openMyAsset.indexOf('openEntryById'),
    'the dashboard must close without clearing the URL before the article opens',
  );
});

test('internal translation jumps propagate syncUrl false without writing history', () => {
  const performCalls = [];
  executeFunction('performArticleAssetJump', ['translation', { syncUrl: false, replaceUrl: true }], {
    state: { activeEntry: { id: 'entry-1' }, readerFocus: null },
    handleReaderTab: (...args) => performCalls.push(args),
    scrollReaderTarget: () => {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(performCalls)), [[
    'translation',
    { preserveFocus: true, syncUrl: false, replaceUrl: true },
  ]]);

  const setTabCalls = [];
  executeFunction('handleReaderTab', ['translation', {
    preserveFocus: true,
    syncUrl: false,
    replaceUrl: true,
  }], {
    state: { readerFocus: 'translation', readerAssetId: 'translation-id' },
    setReaderTab: (...args) => setTabCalls.push(args),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(setTabCalls)), [[
    'translation',
    { syncUrl: false, replaceUrl: true },
  ]]);

  const pendingJumpCalls = [];
  executeFunction('settlePendingAssetJump', ['translation'], {
    state: { pendingAssetJump: 'translation', activeEntry: { id: 'entry-1' } },
    setTimeout: callback => callback(),
    performArticleAssetJump: (...args) => pendingJumpCalls.push(args),
  });
  assert.equal(pendingJumpCalls.length, 3);
  assert.ok(pendingJumpCalls.every(([, options]) => options.syncUrl === false));

  let historyWrites = 0;
  const panel = () => ({ classList: { toggle() {} }, setAttribute() {} });
  executeFunction('setReaderTab', ['translation', { syncUrl: false, replaceUrl: true }], {
    state: { readerTab: 'original' },
    normalizeReaderTab: tab => tab,
    $$: () => [
      { dataset: { tab: 'original' }, classList: { toggle() {} }, setAttribute() {}, tabIndex: 0 },
      { dataset: { tab: 'translation' }, classList: { toggle() {} }, setAttribute() {}, tabIndex: -1 },
    ],
    $: () => panel(),
    updateReaderTocVisibility: () => {},
    updateReaderLanguageProfile: () => {},
    applyTextAnnotations: () => {},
    syncReaderUrl: () => { historyWrites += 1; },
  });
  assert.equal(historyWrites, 0);
});

test('document shortcuts stop at an open confirmation dialog', () => {
  const keydownHandler = sourceForDocumentHandler('keydown');
  let shortcutPathReached = false;
  let prevented = false;
  const context = {
    handler: null,
    $: selector => {
      assert.equal(selector, '#confirm-modal');
      return { open: true };
    },
    isShortcutEditableTarget: () => {
      shortcutPathReached = true;
      return false;
    },
  };
  vm.runInNewContext(`handler = ${keydownHandler};`, context);
  context.handler({
    key: 'Escape',
    target: null,
    preventDefault: () => { prevented = true; },
  });

  assert.equal(shortcutPathReached, false);
  assert.equal(prevented, false);
  assert.match(keydownHandler, /^\([^)]*\)\s*=>\s*\{\s*if \(\$\('#confirm-modal'\)\?\.open\) return;/);
});

test('article AI expansion is session-scoped and feeds layout normalization', () => {
  const state = { contextPanel: 'annotations', agentSessionExpanded: false };
  executeFunction('setContextPanel', ['agent', { persist: false, expand: true }], {
    state,
    storage: { removeItem() {} },
    $: () => ({
      classList: { toggle() {} },
      setAttribute() {},
    }),
    contextPreferenceAppliesAtCurrentViewport: () => false,
    setAgentCollapsed: () => {},
    renderAnnotations: () => {},
    renderAgentContextStrip: () => {},
  });
  assert.equal(state.agentSessionExpanded, true);

  const openEntry = sourceForFunction(app, 'openEntry');
  assert.match(openEntry, /state\.agentSessionExpanded\s*=\s*requestedFocus\s*===\s*'chat'/);
  assert.match(openEntry, /normalizeReaderWorkbenchLayout\(\{\s*force:\s*true,\s*preserveExpanded:\s*requestedFocus\s*===\s*'chat'\s*\}\)/);

  const closeReader = sourceForFunction(app, 'closeReaderFromRoute');
  assert.match(closeReader, /state\.agentSessionExpanded\s*=\s*false/);
  assert.match(
    app,
    /\$\('#context-close'\)\.onclick\s*=\s*\(\)\s*=>\s*\{\s*state\.agentSessionExpanded\s*=\s*false/,
  );

  const normalizeLayout = sourceForFunction(app, 'normalizeReaderWorkbenchLayout');
  assert.match(
    normalizeLayout,
    /preserveExpanded:\s*preserveExpanded\s*\|\|\s*state\.agentSessionExpanded/,
  );
});

test('reload without a reader clears article AI context before normalizing layout', async () => {
  const state = {
    contributors: [{ id: 'contributor-1' }],
    view: 'all',
    activeEntry: { id: 'entry-1' },
    agentSessionExpanded: true,
  };
  const normalizationCalls = [];
  const context = {
    args: [{ keepReader: false, clearUrl: false }],
    result: undefined,
    state,
    loadEntries: async () => {},
    loadContributors: async () => {},
    updateListTitle: () => {},
    renderList: () => {},
    renderSidebar: () => {},
    resetTranslationRequestState: () => {},
    setWorkspacePage: () => {},
    hideAnnotationPopover: () => {},
    $: () => ({ classList: { add() {}, remove() {} } }),
    document: {
      getElementById: id => {
        assert.equal(id, 'app');
        return { classList: { remove() {} } };
      },
    },
    normalizeReaderWorkbenchLayout: options => {
      normalizationCalls.push({
        options,
        activeEntry: state.activeEntry,
        agentSessionExpanded: state.agentSessionExpanded,
      });
    },
    clearReaderUrl: () => {},
    renderAgent: () => {},
  };
  vm.runInNewContext(
    `${sourceForAsyncFunction(app, 'reload')}\nresult = reload(...args);`,
    context,
  );

  await context.result;

  assert.equal(state.activeEntry, null);
  assert.equal(state.agentSessionExpanded, false);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizationCalls)), [{
    options: { force: true },
    activeEntry: null,
    agentSessionExpanded: false,
  }]);
});

test('compact left-collapsed reading removes the sidebar grid width', () => {
  const compactBlocks = blocksForMedia(styles, '(max-width: 1180px) and (min-width: 981px)');
  assert.ok(compactBlocks.length > 0, 'expected the compact desktop media query');
  assert.ok(
    compactBlocks.some(block => /#app\.reading\.left-collapsed:not\(\.reader-immersive\)\s*\{[^}]*--sidebar-width:\s*0\s*;/s.test(block)),
    'left-collapsed compact reading must set --sidebar-width to 0',
  );
});
