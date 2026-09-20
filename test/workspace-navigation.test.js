const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceNavigation } = require('../public/workspace-navigation');

function fixture() {
  const elements = new Map();
  const order = [];
  const root = {
    document: { querySelector(selector) {
      if (!elements.has(selector)) {
        const classes = new Set();
        elements.set(selector, {
          scrollTop: 50,
          classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
          setAttribute() {}, removeAttribute() {},
        });
      }
      return elements.get(selector);
    } },
    history: { state: { extra: 'preserved' }, replaceState(state) { this.state = state; order.push('replace'); }, pushState(state) { this.state = state; order.push('push'); } },
    NamooPeriodicals: { capture() { order.push('capture'); }, invalidate() { order.push('leave'); } },
  };
  let authenticated = true;
  const navigation = createWorkspaceNavigation(root, {
    canEnterDashboard: () => authenticated,
    requestLogin: () => order.push('login'),
    onViewChange: view => order.push(view),
    hasEntry: () => true,
    openPeriodicals: () => true,
  });
  return { navigation, root, order, elements, logout: () => { authenticated = false; } };
}

test('accepted workspace visits have unique ownership including A-B-A', () => {
  const { navigation } = fixture();
  navigation.go('contributor');
  const first = navigation.current();
  navigation.go('dashboard');
  navigation.go('contributor');
  const last = navigation.current();
  assert.equal(first.isCurrent(), false);
  assert.equal(last.isCurrent(), true);
  assert.equal(first.push({}, '/old'), false);
});

test('departure captures periodical state before hiding, while history restore never snapshots over destination', () => {
  const { navigation, order, root } = fixture();
  navigation.go('periodicals');
  order.length = 0;
  navigation.go('dashboard');
  assert.deepEqual(order, ['capture', 'leave', 'dashboard']);
  navigation.go('periodicals');
  order.length = 0;
  const destination = { dashboard: true, extra: 'destination' };
  root.history.state = destination;
  navigation.restore({ url: '/me', state: destination });
  assert.deepEqual(order, ['leave', 'dashboard']);
  assert.equal(root.history.state, destination);
});

test('denied personal-space navigation preserves current workspace and ownership', () => {
  const { navigation, logout, order } = fixture();
  navigation.go('reading');
  const reading = navigation.current();
  logout();
  navigation.go('dashboard');
  assert.equal(reading.isCurrent(), true);
  assert.equal(order.at(-1), 'login');
});

const appFunctions = require('./helpers/workspace-app');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function productionFixture() {
  const f = fixture();
  const requests = [];
  const state = { me: { id: 'me' }, contributor: { sort: 'latest', tab: 'comments' }, entries: [], dashboardTab: 'profile' };
  f.root.NamooWorkspaceNavigation = { createWorkspaceNavigation };
  f.root.location = { pathname: '/', href: 'https://reader.invalid/' };
  return { ...f, requests, context: {
    window: f.root, document: f.root.document, history: f.root.history, state,
    $: selector => f.root.document.querySelector(selector),
    api: (url, options = {}) => { const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise; },
    normalizeContributorAssetSort: x => x, normalizeUserAssetTab: x => x,
    renderContributorAssets() {}, contributorPageTitle: () => state.contributor.profile?.name || 'loading',
    contributorUrlFor: id => `/contributors/${id}`, escapeHtml: x => x,
    toast: message => f.order.push(message), openAuth: () => f.order.push('login'),
    normalizeDashboardTab: x => x, setDashboardTab: x => { state.dashboardTab = x; },
    dashboardUrlFor: () => '/me', renderProfileEditor() {}, loadNotifications() {}, renderMyAssetTabs() {}, renderMyAssets() {},
  } };
}

test('real contributor opener rejects the first A after A-personal-A, including success history timing', async () => {
  const f = productionFixture();
  const c = appFunctions(f.context, ['getWorkspaceNavigation', 'prepareWorkspaceRestore', 'setWorkspacePage', 'openContributor', 'loadContributor', 'openMyCommentsModal', 'loadMyComments']);
  const first = c.openContributor('A');
  assert.equal(f.order.includes('push'), false);
  const personal = c.openMyCommentsModal();
  assert.equal(f.order.filter(x => x === 'push').length, 1);
  const last = c.openContributor('A');
  f.requests[0].resolve({ contributor: { name: 'obsolete' } });
  await first;
  assert.equal(f.root.document.title, '我的空间 · Namoo Reader');
  f.requests.at(-1).resolve({ contributor: { name: 'current' } });
  await last;
  assert.equal(f.root.document.title, 'current');
  assert.equal(f.order.filter(x => x === 'push').length, 2);
  f.requests.slice(1, -1).forEach(request => request.resolve({}));
  await personal;
  assert.equal(f.root.document.title, 'current');
});

test('real entry-by-id opener takes ownership before fetching an absent entry', async () => {
  const f = productionFixture();
  let opened = false;
  f.context.loadEntry = async () => { opened = true; };
  const c = appFunctions(f.context, ['getWorkspaceNavigation', 'prepareWorkspaceRestore', 'setWorkspacePage', 'openEntryById', 'loadEntryById', 'openContributor', 'loadContributor']);
  const article = c.openEntryById('missing');
  const contributor = c.openContributor('B');
  f.requests[0].resolve({ entry: { id: 'missing' } });
  await article;
  assert.equal(opened, false);
  f.requests[1].resolve({});
  await contributor;
});

for (const name of ['loadRewrite', 'loadOnepage', 'loadAnnotations', 'loadComments', 'loadAgentMessages']) {
  for (const outcome of ['success', 'error']) {
    test(`real ${name} ignores late ${outcome} including catch/finally after A-B-A`, async () => {
      const f = productionFixture();
      const rendered = [];
      const c = f.context;
      c.state.activeEntry = { id: 'A' };
      c.getWorkspaceNavigation = () => f.navigation;
      for (const render of ['renderRewrite', 'renderOnepage', 'renderAnnotations', 'renderComments', 'renderAgent', 'renderList', 'maybeGenerateRewriteAfterLoad']) {
        c[render] = () => rendered.push(render);
      }
      c.updateEntryAssets = () => rendered.push('assets');
      c.entryAssetHelpfulPatch = () => ({});
      c.annotationAssetPatch = () => ({});
      appFunctions(c, [name]);
      f.navigation.go('reading');
      const loading = c[name]({ id: 'A' });
      f.navigation.go('dashboard');
      f.navigation.go('reading');
      c.state.rewriteLoading = true;
      c.state.onepageLoading = true;
      rendered.length = 0;
      if (outcome === 'error') f.requests[0].reject(new Error('obsolete'));
      else f.requests[0].resolve({ rewrite: { body: 'old' }, onepage: {}, annotations: [], comments: [], messages: [] });
      await loading;
      assert.deepEqual(rendered, []);
      assert.equal(c.state.rewriteLoading, true);
      assert.equal(c.state.onepageLoading, true);
    });
  }
}

test('queued real administrator search cannot replace contributor URL after leaving', () => {
  const f = productionFixture();
  const mutations = [];
  let callback;
  Object.assign(f.context, {
    getWorkspaceNavigation: () => f.navigation,
    clearTimeout() {}, setTimeout: fn => { callback = fn; },
    resetUserManagementSubmissions: () => mutations.push('reset'),
    syncUserManagementUrl: () => mutations.push('url'), loadUserManagement: () => mutations.push('load'),
  });
  f.context.state.userManagement = {};
  const c = appFunctions(f.context, ['scheduleUserManagementSearch']);
  f.navigation.go('dashboard');
  c.scheduleUserManagementSearch('alice');
  f.navigation.go('contributor');
  callback();
  assert.deepEqual(mutations, []);
});

for (const outcome of ['false', 'success', 'error']) {
  test(`real article pagination ignores stale ${outcome} without rolling back the new limit`, async () => {
    const f = productionFixture();
    const pending = deferred(), effects = [];
    Object.assign(f.context, {
      getWorkspaceNavigation: () => f.navigation,
      loadEntries: () => pending.promise,
      ENTRY_MAX_LIMIT: 1000, ENTRY_PAGE_SIZE: 50,
      renderList: () => effects.push('list'), renderSidebar: () => effects.push('sidebar'),
      toast: () => effects.push('error'),
    });
    f.context.state.entryLimit = 50;
    const c = appFunctions(f.context, ['loadMoreEntries']);
    const loading = c.loadMoreEntries({ textContent: 'more' });
    f.navigation.go('contributor');
    c.state.entryLimit = 75;
    if (outcome === 'error') pending.reject(new Error('obsolete'));
    else pending.resolve(outcome === 'success');
    await loading;
    assert.deepEqual(effects, []);
    assert.equal(c.state.entryLimit, 75);
  });
}

for (const outcome of ['success', 'error']) {
  test(`real user submissions ignores late ${outcome} and does not clear a new visit's loading state`, async () => {
    const f = productionFixture();
    const effects = [];
    Object.assign(f.context, { getWorkspaceNavigation: () => f.navigation,
      renderUserManagement: () => effects.push('render'), toast: () => effects.push('error') });
    f.context.state.userManagement = { userId: 'alice', submissionsRequestSequence: 0 };
    const c = appFunctions(f.context, ['loadAllUserSubmissions']);
    const loading = c.loadAllUserSubmissions('alice');
    f.navigation.go('contributor');
    effects.length = 0;
    if (outcome === 'error') f.requests[0].reject(new Error('obsolete'));
    else f.requests[0].resolve({ submissions: [{ id: 'old' }] });
    await loading;
    assert.deepEqual(effects, []);
    assert.equal(c.state.userManagement.allSubmissions, undefined);
    assert.equal(c.state.userManagement.allSubmissionsLoading, true);
  });
}

test('real article opener never paints first A content after A-contributor-A', async () => {
  const f = productionFixture();
  const painted = [];
  const c = f.context;
  Object.assign(c, {
    contentCache: new Map(), ASSET_FILTER_TYPES: [],
    sourceById: () => null, friendlyDateTime: () => '', normalizeReaderOpenTab: tab => tab || 'original',
    readerRouteTitle: entry => entry.id,
    renderOriginalContent: (entry, content) => painted.push([entry.id, content]),
  });
  c.state.read = new Set();
  c.state.originalFetchOperations = new Map();
  c.document.getElementById = id => c.$(`#${id}`);
  c.document.querySelector('#app').classList.add = () => {};
  for (const name of ['resetTranslationRequestState', 'recordEntryView', 'syncEntryState', 'persist',
    'renderAdminEntryControls', 'renderTitle', 'updateRewriteUiLabels', 'renderReaderStatsUi', 'hideAnnotationPopover',
    'renderReaderAssets', 'renderReaderAssetSummary', 'updateFetchOriginalButton', 'setReaderTab',
    'loadTranslation', 'loadRewrite', 'loadOnepage', 'loadAnnotations', 'loadComments', 'loadAgentMessages',
    'syncReaderUrl', 'normalizeReaderWorkbenchLayout', 'applyReaderPrefs', 'renderAgent', 'renderEntryStateUi']) c[name] = () => {};
  // Add DOM class operations used by the real renderer.
  const select = c.$;
  c.$ = selector => {
    const node = select(selector);
    node.classList.add ||= () => {};
    node.classList.remove ||= () => {};
    return node;
  };
  appFunctions(c, ['getWorkspaceNavigation', 'prepareWorkspaceRestore', 'openEntry', 'loadEntry', 'loadOriginalContent', 'loadReaderRelatedData', 'observeOriginalFetch', 'openContributor', 'loadContributor']);
  const first = c.openEntry({ id: 'A' });
  const other = c.openContributor('B');
  await c.openEntry({ id: 'A', content: 'current body' });
  f.requests[0].resolve({ entry: { id: 'A', content: 'obsolete body' } });
  f.requests[1].resolve({});
  await Promise.all([first, other]);
  assert.deepEqual(painted, [['A', 'current body']]);
  assert.equal(c.state.activeEntry.content, 'current body');
});

test('queued asset-jump scroll does not revive first A after A-B-A', () => {
  const f = productionFixture();
  const callbacks = [], jumps = [];
  Object.assign(f.context, { getWorkspaceNavigation: () => f.navigation,
    setTimeout: fn => callbacks.push(fn), performArticleAssetJump: type => jumps.push(type) });
  f.context.state.activeEntry = { id: 'A' };
  f.context.state.pendingAssetJump = 'translation';
  const c = appFunctions(f.context, ['settlePendingAssetJump']);
  c.settlePendingAssetJump('translation');
  f.navigation.go('contributor');
  f.navigation.go('reading');
  callbacks.forEach(fn => fn());
  assert.deepEqual(jumps, []);
  assert.equal(c.state.pendingAssetJump, 'translation');
});

for (const outcome of ['success', 'error']) {
  test(`an already-started rewrite continues but cannot publish late ${outcome} into a new workspace`, async () => {
    const f = productionFixture();
    const effects = [];
    Object.assign(f.context, {
      getWorkspaceNavigation: () => f.navigation, requireAuth: () => true,
      setReaderTab: () => effects.push('tab'), rewriteAiConfig: () => ({}),
      rewriteUiCopy: () => ({}), applyServerEntryUpdate: () => effects.push('entry'),
      renderRewrite: () => effects.push('render'), toast: () => effects.push('toast'),
    });
    f.context.state.activeEntry = { id: 'A' };
    const c = appFunctions(f.context, ['generateRewrite']);
    const generation = c.generateRewrite();
    assert.equal(f.requests[0].url, '/api/entry/A/rewrite');
    f.navigation.go('contributor');
    effects.length = 0;
    if (outcome === 'error') f.requests[0].reject(new Error('obsolete'));
    else f.requests[0].resolve({});
    await generation;
    assert.deepEqual(effects, []);
  });
}

test('queued real annotation animation-frame scroll belongs to the visit that scheduled it', () => {
  const f = productionFixture();
  const callbacks = [];
  let scrolls = 0;
  Object.assign(f.context, {
    getWorkspaceNavigation: () => f.navigation,
    requestAnimationFrame: fn => callbacks.push(fn), setTimeout() {},
  });
  f.context.document.getElementById = () => ({ scrollIntoView: () => { scrolls += 1; }, classList: { add() {} } });
  const c = appFunctions(f.context, ['revealSideAnnotation']);
  c.revealSideAnnotation('A');
  f.navigation.go('contributor');
  callbacks.shift()();
  assert.equal(scrolls, 0);
  c.revealSideAnnotation('B');
  callbacks.shift()();
  assert.equal(scrolls, 1);
});

for (const pathname of ['/contributors', '/contributors/', '/contributors/alice', '/contributors/alice/']) {
  test(`restoration agrees with the real content route for ${pathname}`, async () => {
    const f = productionFixture();
    const destinations = [];
    Object.assign(f.context, {
      URL, URLSearchParams, ASSET_FILTER_TYPES: [], articleRouteFromPath: () => null,
      userManagementRouteFromParams: () => ({}), normalizeContributorSort: () => 'latest',
    });
    const c = appFunctions(f.context, ['routeStateFromUrl']);
    const navigation = createWorkspaceNavigation(f.root, {
      readRoute: c.routeStateFromUrl,
      openReading: target => destinations.push(['reading', target.view, c.routeStateFromUrl(pathname).view]),
      openContributor: target => destinations.push(['contributor', target.contributorId]),
    });
    await navigation.restore({ url: pathname, state: { preserved: true } });
    assert.deepEqual(destinations, pathname.includes('alice')
      ? [['contributor', 'alice']]
      : [['reading', 'reading', 'contributors']]);
    assert.equal(f.order.filter(item => item === 'push').length, 0);
  });
}

function retainedReaderFixture() {
  const f = productionFixture();
  const c = f.context;
  Object.assign(c.state, { activeEntry: { id: 'A', content: 'body' }, readerTab: 'original',
    originalFetchOperations: new Map(), translationRequestSequence: 0, siteAi: { onepageEnabled: true } });
  const select = c.$;
  c.$ = selector => {
    const node = select(selector);
    node.classList.add ||= name => node.classList.toggle(name, true);
    node.classList.remove ||= name => node.classList.toggle(name, false);
    node.querySelector ||= () => ({ textContent: '' });
    return node;
  };
  Object.assign(c, {
    $$: () => [], clearTimeout() {},
    requireAuth: () => true, hasUsableAiConfig: () => true,
    rewriteAiConfig: () => ({}), onepageAiConfig: () => ({}), translationAiConfig: () => ({}),
    rewriteUiCopy: () => ({ action: '生成', generating: '生成中' }),
    setReaderTab: tab => { c.state.readerTab = tab; },
    isVersionedTranslationEnvelope: () => false,
    readerUrlFor: () => '/articles/A', readerRouteTitle: () => 'Article A', listUrlFor: () => '/', listRouteTitle: () => 'List',
  });
  for (const name of ['updateRewriteUiLabels', 'renderReaderStatsUi', 'renderAssetHelpfulButton',
    'setTranslationJobStatus', 'updateEntryAssets', 'renderList', 'renderReaderAssetSummary',
    'renderAnnotations', 'renderComments', 'renderAgent', 'annotationAssetPatch']) c[name] = () => {};
  appFunctions(c, ['getWorkspaceNavigation', 'prepareWorkspaceRestore', 'setWorkspacePage',
    'resumeRetainedReader', 'loadOriginalContent', 'loadReaderRelatedData', 'observeOriginalFetch', 'openMyCommentsModal', 'loadMyComments', 'closeMyCommentsModal', 'openContributor', 'loadContributor', 'closeContributorModal',
    'generateRewrite', 'generateOnepage', 'generateTranslation', 'loadRewrite', 'loadOnepage', 'loadTranslation',
    'loadAnnotations', 'loadComments', 'loadAgentMessages',
    'renderRewrite', 'renderOnepage', 'renderTranslation', 'onepageCanGenerate', 'entryAssetHasContent',
    'resetTranslationRequestState', 'currentTranslationAssetId', 'isTranslationRequestCurrent', 'maybeGenerateRewriteAfterLoad']);
  return { ...f, c };
}

for (const [generate, flag, button] of [
  ['generateRewrite', 'rewriteGenerating', '#reader-rewrite'],
  ['generateOnepage', 'onepageGenerating', '#reader-onepage'],
  ['generateTranslation', 'translationGenerating', '#reader-bilingual'],
]) {
  for (const view of ['personal', 'contributor']) {
    for (const outcome of ['success', 'error']) {
      test(`return from ${view} takes over ${generate} UI after old ${outcome} without another generation`, async () => {
        const { c, requests, root } = retainedReaderFixture();
        const generating = c[generate]();
        assert.equal(c.state[flag], true);
        const away = view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
        requests.slice(1).forEach(request => request.resolve({}));
        await away;
        root.location.pathname = view === 'personal' ? '/me' : '/contributors/B';
        const beforeReturn = requests.length;
        c.state.pendingTranslationGenerate = true;
        c.state.pendingRewriteGenerate = true;
        const returning = view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
        requests.slice(beforeReturn).forEach(request => request.resolve({}));
        await returning;
        if (outcome === 'error') requests[0].reject(new Error('old generation failed'));
        else requests[0].resolve({});
        await generating;
        assert.equal(c.state[flag], false);
        assert.equal(c.$(button).disabled, false);
        assert.equal(c.state.translationLoading, false);
        assert.equal(c.state.rewriteLoading, false);
        assert.equal(c.state.onepageLoading, false);
        assert.equal(c.state.readerTab, generate === 'generateRewrite' ? 'rewrite' : generate === 'generateOnepage' ? 'onepage' : 'translation');
        assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
        assert.deepEqual(requests.slice(beforeReturn).map(request => request.url).sort(),
          ['/api/entry/A/annotations', '/api/entry/A/chat', '/api/entry/A/comments',
            '/api/entry/A/onepage', '/api/entry/A/rewrite', '/api/entry/A/translation']);
        const retry = c[generate]();
        assert.equal(requests.filter(request => request.options.method === 'POST').length, 2);
        requests.at(-1).resolve({});
        await retry;
      });
    }
  }
}

for (const view of ['personal', 'contributor']) {
  test(`return from ${view} clears abandoned loader state even when fresh asset reads fail`, async () => {
    const { c, requests, root } = retainedReaderFixture();
    const oldLoads = [c.loadTranslation(c.state.activeEntry), c.loadRewrite(c.state.activeEntry), c.loadOnepage(c.state.activeEntry)];
    const away = view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
    requests.slice(3).forEach(request => request.resolve({}));
    await away;
    root.location.pathname = view === 'personal' ? '/me' : '/contributors/B';
    const beforeReturn = requests.length;
    const returning = view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
    requests.slice(beforeReturn).forEach(request => request.reject(new Error('current read failed')));
    await returning;
    requests.slice(0, 3).forEach(request => request.reject(new Error('abandoned read failed')));
    await Promise.all(oldLoads);
    for (const field of ['translationLoading', 'rewriteLoading', 'onepageLoading']) assert.equal(c.state[field], false);
    for (const selector of ['#reader-bilingual', '#reader-rewrite', '#reader-onepage']) assert.equal(c.$(selector).disabled, false);
    assert.equal(requests.filter(request => request.options.method === 'POST').length, 0);
  });
}

for (const view of ['personal', 'contributor']) {
  for (const oldOutcome of ['success', 'error']) {
    for (const freshOutcome of ['success', 'error']) {
      test(`pending original resumes from ${view}: old ${oldOutcome}, fresh ${freshOutcome}`, async () => {
        const { c, requests, root } = retainedReaderFixture();
        const painted = [], views = [];
        Object.assign(c, {
          contentCache: new Map(), ASSET_FILTER_TYPES: [],
          sourceById: () => null, friendlyDateTime: () => '', normalizeReaderOpenTab: tab => tab || 'original',
          recordEntryView: id => views.push(id),
          renderOriginalContent: (entry, content) => {
            painted.push([entry.id, content || entry.summary]);
            c.$('#reader-content').innerHTML = content || entry.summary;
          },
        });
        c.state.read = new Set();
        c.state.originalFetchOperations = new Map();
        c.document.getElementById = id => c.$(`#${id}`);
        for (const name of ['syncEntryState', 'persist', 'renderAdminEntryControls', 'renderTitle',
          'hideAnnotationPopover', 'renderReaderAssets', 'updateFetchOriginalButton', 'syncReaderUrl', 'normalizeReaderWorkbenchLayout',
          'applyReaderPrefs', 'renderAgent', 'renderEntryStateUi']) c[name] = () => {};
        appFunctions(c, ['openEntry', 'loadEntry', 'loadOriginalContent', 'loadReaderRelatedData', 'observeOriginalFetch']);
        const opening = c.openEntry({ id: 'A', summary: 'fallback' }, { tab: 'rewrite' });
        const oldDetail = requests.find(request => request.url === '/api/entry/A');
        const readerReads = ['/api/entry/A', '/api/entry/A/annotations', '/api/entry/A/chat',
          '/api/entry/A/comments', '/api/entry/A/onepage', '/api/entry/A/rewrite', '/api/entry/A/translation'];
        assert.deepEqual(requests.map(request => request.url).sort(), readerReads);
        const away = view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
        requests.filter(request => request !== oldDetail).forEach(request => request.resolve({}));
        await away;
        root.location.pathname = view === 'personal' ? '/me' : '/contributors/B';
        const beforeReturn = requests.length;
        const returning = view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
        const freshDetail = requests.slice(beforeReturn).find(request => request.url === '/api/entry/A');
        assert.deepEqual(requests.slice(beforeReturn).map(request => request.url).sort(), readerReads);
        assert.ok(freshDetail, 'new visit must reread the unfinished original');
        if (oldOutcome === 'error') oldDetail.reject(new Error('obsolete detail failed'));
        else oldDetail.resolve({ entry: { id: 'A', content: 'obsolete' } });
        await opening;
        assert.deepEqual(painted, []);
        assert.equal(c.contentCache.has('A'), false);
        requests.slice(beforeReturn).filter(request => request !== freshDetail).forEach(request => request.resolve({}));
        if (freshOutcome === 'error') freshDetail.reject(new Error('current detail failed'));
        else freshDetail.resolve({ entry: { id: 'A', content: 'current body' } });
        await returning;
        assert.deepEqual(painted, [['A', freshOutcome === 'error' ? 'fallback' : 'current body']]);
        assert.equal(c.state.readerTab, 'rewrite');
        assert.equal(c.$('#reader-content').innerHTML.includes('加载内容中'), false);
        if (freshOutcome === 'error') {
          const retryAway = view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
          requests.forEach(request => request.resolve({}));
          await retryAway;
          const retryStart = requests.length;
          const retry = view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
          const retryDetail = requests.slice(retryStart).find(request => request.url === '/api/entry/A');
          assert.ok(retryDetail, 'failed detail remains retryable on return');
          requests.slice(retryStart).forEach(request => request.resolve(
            request === retryDetail ? { entry: { id: 'A', content: 'recovered body' } } : {}));
          await retry;
          assert.deepEqual(painted.at(-1), ['A', 'recovered body']);
        }
        assert.deepEqual(views, ['A']);
        assert.equal(requests.filter(request => request.options.method === 'POST').length, 0);
      });
    }
  }
}

for (const [loader, field, endpoint, responseField] of [
  ['loadAnnotations', 'annotations', 'annotations', 'annotations'],
  ['loadComments', 'comments', 'comments', 'comments'],
  ['loadAgentMessages', 'agentMessages', 'chat', 'messages'],
]) {
  for (const view of ['personal', 'contributor']) {
    for (const oldOutcome of ['success', 'error']) {
      for (const freshOutcome of ['success', 'error']) {
        test(`retained ${field} from ${view}: old ${oldOutcome}, fresh ${freshOutcome}`, async () => {
          const { c, requests, root } = retainedReaderFixture();
          const renders = [];
          const renderer = field === 'annotations' ? 'renderAnnotations' : field === 'comments' ? 'renderComments' : 'renderAgent';
          c[renderer] = () => renders.push(JSON.stringify(c.state[field]));
          c.state.readerTab = 'rewrite';
          c.state.pendingCommentId = 'comment-focus';
          c.state.pendingAnnotationId = 'annotation-focus';
          c.state.pendingChatMessageId = 'chat-focus';
          const oldLoad = c[loader](c.state.activeEntry);
          const oldRequest = requests[0];
          const away = view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
          requests.slice(1).forEach(request => request.resolve({}));
          await away;
          root.location.pathname = view === 'personal' ? '/me' : '/contributors/B';
          const beforeReturn = requests.length;
          const returning = view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
          const freshRequest = requests.slice(beforeReturn).find(request => request.url === `/api/entry/A/${endpoint}`);
          assert.ok(freshRequest, 'return must read every existing reader resource under the new visit');
          const renderCount = renders.length;
          if (oldOutcome === 'error') oldRequest.reject(new Error('obsolete read failed'));
          else oldRequest.resolve({ [responseField]: [{ id: 'obsolete' }] });
          await oldLoad;
          assert.equal(renders.length, renderCount, 'old success/catch must not render');
          assert.deepEqual(Array.from(c.state[field]), []);
          requests.slice(beforeReturn).filter(request => request !== freshRequest).forEach(request => request.resolve({}));
          if (freshOutcome === 'error') freshRequest.reject(new Error('current read failed'));
          else freshRequest.resolve({ [responseField]: [{ id: 'current' }] });
          await returning;
          assert.deepEqual(Array.from(c.state[field]), freshOutcome === 'error' ? [] : [{ id: 'current' }]);
          assert.equal(renders.length, renderCount + 1, 'new success/catch renders its result');
          assert.equal(c.state.readerTab, 'rewrite');
          assert.equal(c.state.pendingCommentId, 'comment-focus');
          assert.equal(c.state.pendingAnnotationId, 'annotation-focus');
          assert.equal(c.state.pendingChatMessageId, 'chat-focus');
          assert.equal(requests.filter(request => request.options.method === 'POST').length, 0);
        });
      }
    }
  }
}

for (const cachedContent of ['', 'short cached body']) {
  for (const view of ['personal', 'contributor']) {
    for (const outcome of ['success', 'error']) {
      for (const nextVisit of ['retained', 'leave-again', 'A-B-A', 'leave-during-read', 'A-B-A-during-read', 'read-error']) {
        test(`original operation observed from ${view}: ${outcome}, ${nextVisit}, cache=${cachedContent.length}`, async () => {
          const { c, requests, root } = retainedReaderFixture();
          const paints = [];
          c.state.activeEntry = { id: 'A', link: 'https://example.invalid/a', summary: 'short', content: cachedContent };
          c.state.fetchingOriginalIds = new Set();
          c.contentCache = new Map();
          Object.assign(c, {
            hasUsableOriginalContent: entry => Boolean(entry.content && entry.content !== cachedContent),
            setButtonIconLabel: (button, icon, label) => { button.textContent = label; },
            renderOriginalEmptyState: () => {}, renderTitle: () => {},
            renderOriginalContent: (entry, content) => paints.push([entry.id, content]),
          });
          appFunctions(c, ['fetchOriginalContent', 'updateFetchOriginalButton']);
          const fetching = c.fetchOriginalContent();
          const post = requests[0];
          const openAway = () => view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
          const closeAway = () => view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
          const resolveReads = from => requests.slice(from).forEach(request => request.resolve(
            request.url === '/api/entry/A' ? { entry: { id: 'A', content: '' } } : {}));
          const away = openAway();
          resolveReads(1);
          await away;
          root.location.pathname = view === 'personal' ? '/me' : '/contributors/B';
          let start = requests.length;
          const returning = closeAway();
          resolveReads(start);
          await returning;
          assert.equal(c.$('#reader-fetch-original').disabled, true);
          if (['leave-again', 'A-B-A'].includes(nextVisit)) {
            start = requests.length;
            const awayAgain = openAway();
            resolveReads(start);
            await awayAgain;
            if (nextVisit === 'A-B-A') {
              // The intermediate reader visit must invalidate the first A watcher too.
              c.state.activeEntry = { id: 'B', content: 'B body' };
              start = requests.length;
              const b = closeAway();
              resolveReads(start);
              await b;
              start = requests.length;
              const awayB = openAway();
              resolveReads(start);
              await awayB;
              c.state.activeEntry = { id: 'A', link: 'https://example.invalid/a', summary: 'short' };
              start = requests.length;
              const a = closeAway();
              resolveReads(start);
              await a;
            }
          }
          const beforeCompletion = requests.length;
          const paintCount = paints.length;
          if (outcome === 'error') post.reject(new Error('fetch failed'));
          else post.resolve({ entry: { id: 'A', content: 'POST body must not paint' } });
          await fetching;
          await new Promise(setImmediate);
          assert.equal(c.state.fetchingOriginalIds.has('A'), false);
          const rereads = requests.slice(beforeCompletion);
          if (nextVisit === 'leave-again') {
            assert.equal(rereads.length, 0, 'abandoned watcher must not read or render');
            assert.equal(c.state.originalFetchOperations.has('A'), true);
          } else {
            assert.deepEqual(rereads.map(request => request.url), ['/api/entry/A']);
            assert.equal(paints.length, paintCount, 'old POST must not paint');
            if (['leave-during-read', 'A-B-A-during-read'].includes(nextVisit)) {
              start = requests.length;
              const awayDuringRead = openAway();
              resolveReads(start);
              await awayDuringRead;
              if (nextVisit === 'A-B-A-during-read') {
                c.state.activeEntry = { id: 'B', content: 'B body' };
                start = requests.length;
                const b = closeAway();
                resolveReads(start);
                await b;
                start = requests.length;
                const awayB = openAway();
                resolveReads(start);
                await awayB;
                c.state.activeEntry = { id: 'A', link: 'https://example.invalid/a', summary: 'new A' };
                start = requests.length;
                const a = closeAway();
                resolveReads(start);
                await a;
              }
              const beforeStaleRead = paints.length;
              const activeBeforeStaleRead = c.state.activeEntry;
              if (outcome === 'error') rereads[0].reject(new Error('obsolete observation failed'));
              else rereads[0].resolve({ entry: { id: 'A', content: 'obsolete observation' } });
              await new Promise(setImmediate);
              assert.equal(paints.length, beforeStaleRead);
              assert.equal(c.state.activeEntry, activeBeforeStaleRead);
              assert.equal(c.state.originalFetchOperations.has('A'), true, 'stale read cannot consume completion');
              if (nextVisit === 'A-B-A-during-read') {
                resolveReads(beforeCompletion + 1);
                await new Promise(setImmediate);
                assert.equal(c.state.originalFetchOperations.has('A'), false, 'latest A consumes completion');
              }
            } else if (nextVisit === 'read-error') {
              rereads[0].reject(new Error('observation GET failed'));
              await new Promise(setImmediate);
              assert.equal(c.$('#reader-fetch-original').disabled, false);
              assert.equal(c.$('#reader-fetch-original').textContent, '获取正文');
              assert.equal(c.state.originalFetchOperations.has('A'), true, 'failed read preserves completion');
              start = requests.length;
              const retryAway = openAway();
              resolveReads(start);
              await retryAway;
              start = requests.length;
              const retryReturn = closeAway();
              resolveReads(start);
              await retryReturn;
              await new Promise(setImmediate);
              resolveReads(start);
              await new Promise(setImmediate);
              assert.equal(c.state.originalFetchOperations.has('A'), false, 'successful retry consumes completion');
            } else {
              rereads[0].resolve({ entry: { id: 'A', content: outcome === 'success' ? 'GET body' : '',
                originalFetchError: outcome === 'error' ? 'fetch failed' : '' } });
              await new Promise(setImmediate);
              assert.equal(c.$('#reader-fetch-original').textContent, outcome === 'error' ? '重新获取正文' : '获取正文');
              assert.equal(c.$('#reader-fetch-original').disabled, outcome === 'success');
              assert.deepEqual(paints.at(-1), ['A', outcome === 'success' ? 'GET body' : '']);
            }
          }
          assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
        });
      }
    }
  }

}

for (const view of ['personal', 'contributor']) {
  for (const outcome of ['success', 'error']) {
    for (const cachedContent of ['', 'short cached body']) {
      for (const phase of ['stay', 'before-leave', 'while-away']) {
        test(`original completion phase ${phase}, ${view}, ${outcome}, cache=${cachedContent.length}`, async () => {
          const { c, requests } = retainedReaderFixture();
          c.state.activeEntry = { id: 'A', link: 'https://example.invalid/a', content: cachedContent, summary: 'short' };
          c.state.fetchingOriginalIds = new Set();
          c.contentCache = new Map();
          Object.assign(c, {
            plainTextFromHtml: value => String(value || ''),
            setButtonIconLabel: (button, icon, label) => { button.textContent = label; },
            renderOriginalEmptyState() {}, renderOriginalContent() {}, renderTitle() {},
          });
          appFunctions(c, ['fetchOriginalContent', 'updateFetchOriginalButton', 'hasUsableOriginalContent', 'entryOriginalTextLength']);
          const fetching = c.fetchOriginalContent();
          const post = requests[0];
          const saved = { id: 'A', content: outcome === 'success' ? 'long body '.repeat(100) : cachedContent,
            originalFetchError: outcome === 'error' ? 'fetch failed' : '' };
          const settleReads = from => requests.slice(from).forEach(request => request.resolve(
            request.url === '/api/entry/A' ? { entry: saved } : {}));
          const openAway = () => view === 'personal' ? c.openMyCommentsModal() : c.openContributor('B');
          const closeAway = () => view === 'personal' ? c.closeMyCommentsModal() : c.closeContributorModal();
          if (phase === 'while-away') {
            const away = openAway();
            settleReads(1);
            await away;
          }
          if (outcome === 'error') post.reject(new Error('fetch failed'));
          else post.resolve({ entry: saved });
          await fetching;
          assert.equal(c.state.fetchingOriginalIds.has('A'), false);
          if (phase !== 'stay') {
            if (phase === 'before-leave') {
              const start = requests.length;
              const away = openAway();
              settleReads(start);
              await away;
            }
            const start = requests.length;
            const returning = closeAway();
            settleReads(start);
            await returning;
            await new Promise(setImmediate);
            settleReads(start);
            await new Promise(setImmediate);
            if (phase === 'while-away') {
              assert.ok(requests.slice(start).some(request => request.url === '/api/entry/A'), 'completed operation still requires a saved-result read');
            }
          }
          assert.equal(c.$('#reader-fetch-original').disabled, outcome === 'success');
          assert.equal(c.$('#reader-fetch-original').textContent, outcome === 'error' ? '重新获取正文' : '获取正文');
          assert.equal(c.state.originalFetchOperations.has('A'), false, 'effective result consumption clears the signal');
          assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
        });
      }
    }
  }
}
