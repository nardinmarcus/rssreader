const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectDir = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}() in public/app.js`);
  const bodyStart = app.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}()`);
}

test('managed source search matches partial text and composes with existing filters', () => {
  const context = {
    state: {
      sourceManageFilters: {
        query: 'research',
        label: '官方',
        priority: 'high',
        enabled: 'enabled',
        status: 'ok',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('sourceMatchesManageFilters'), context);

  assert.equal(context.sourceMatchesManageFilters({
    name: 'Anthropic Research',
    description: '官方研究文章',
    labels: ['官方', '研究'],
    editorialPriority: 'high',
    enabled: true,
    status: 'ok',
  }), true);
  assert.equal(context.sourceMatchesManageFilters({
    name: 'Anthropic News',
    description: '公司动态',
    labels: ['官方'],
    editorialPriority: 'high',
    enabled: true,
    status: 'ok',
  }), false);

  context.state.sourceManageFilters.query = '研究文章';
  assert.equal(context.sourceMatchesManageFilters({
    name: 'Anthropic Research',
    note: '官方研究文章',
    labels: ['官方'],
    editorialPriority: 'high',
    enabled: true,
    status: 'ok',
  }), true);
});

test('managed sources sort enabled first, then enabled priority, then persisted order', () => {
  const context = {
    MANAGED_SOURCE_PRIORITY_RANK: { high: 0, normal: 1, low: 2 },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('compareManagedSources'), context);

  const sources = [
    { name: 'Disabled high', enabled: false, editorialPriority: 'high', displayOrder: 0 },
    { name: 'Enabled low', enabled: true, editorialPriority: 'low', displayOrder: 1 },
    { name: 'Enabled high later', enabled: true, editorialPriority: 'high', displayOrder: 8 },
    { name: 'Enabled normal', enabled: true, editorialPriority: 'normal', displayOrder: 2 },
    { name: 'Enabled high earlier', enabled: true, editorialPriority: 'high', displayOrder: 3 },
    { name: 'Disabled low', enabled: false, editorialPriority: 'low', displayOrder: 9 },
  ];

  assert.deepEqual(
    sources.sort(context.compareManagedSources).map(source => source.name),
    [
      'Enabled high earlier',
      'Enabled high later',
      'Enabled normal',
      'Enabled low',
      'Disabled high',
      'Disabled low',
    ],
  );
});

test('catalog activation is admin-only, exposes explicit restore, and reports WeChat content scope', () => {
  const context = {
    discoveryState: { activatingKey: '' },
    isAdmin: () => true,
    escapeHtml: value => String(value || ''),
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('discoveryEntryHtml')}\n${extractFunction('wechatContentScopeLabel')}`, context);
  const catalogItem = { key: 'wechat:ABC12345', platform: 'wechat', name: '公众号', online: false };
  const adminHtml = context.discoveryEntryHtml(catalogItem);
  assert.match(adminHtml, /data-discovery-activate="wechat:ABC12345"/);
  assert.match(adminHtml, /加入自定义来源/);

  context.isAdmin = () => false;
  const publicHtml = context.discoveryEntryHtml(catalogItem);
  assert.doesNotMatch(publicHtml, /data-discovery-activate/);
  const publicActiveHtml = context.discoveryEntryHtml({ ...catalogItem, online: true, sourceId: 'public-source' });
  assert.match(publicActiveHtml, /早于当前供给窗口的历史覆盖未知/);

  context.isAdmin = () => true;
  const onlineLegacyHtml = context.discoveryEntryHtml({
    ...catalogItem,
    online: true,
    sourceId: 'legacy-source',
    activated: false,
  });
  assert.match(onlineLegacyHtml, /data-discovery-source="legacy-source"/);
  assert.match(onlineLegacyHtml, /data-discovery-activate="wechat:ABC12345"/);
  assert.match(onlineLegacyHtml, /完成接入/);
  const archivedHtml = context.discoveryEntryHtml({ ...catalogItem, archived: true, activated: true });
  assert.match(archivedHtml, /data-discovery-restore="true"/);
  assert.match(archivedHtml, /恢复来源/);
  assert.equal(context.wechatContentScopeLabel({ platformIdentity: 'wechat:MzA1:1:1', contentScope: 'feed-body' }), '供给正文，完整性未验证');
  assert.equal(context.wechatContentScopeLabel({ platformIdentity: 'wechat:MzA1:1:1', contentScope: 'summary' }), '仅摘要');
  assert.equal(context.wechatContentScopeLabel({ platformIdentity: 'wechat:MzA1:1:1', contentScope: 'unknown' }), '内容范围未知');
  assert.equal(context.wechatContentScopeLabel({ platformIdentity: '', contentScope: 'unknown' }), '');
  assert.match(styles, /\.discovery-badge-archived/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.discovery-entry-action button\s*\{\s*width:\s*100%/);
});

test('article readers see WeChat history coverage as unknown rather than complete', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction('wechatHistoryCoverageLabel'), context);
  assert.equal(
    context.wechatHistoryCoverageLabel({ platformIdentity: 'wechat:MzA1:mid-1:0' }),
    '早于当前供给窗口的历史覆盖未知',
  );
  assert.equal(context.wechatHistoryCoverageLabel({ platformIdentity: 'rss:entry-1' }), '');
  assert.match(app, /wechatHistoryCoverageLabel\(e\)/);
  assert.match(app, /class="reader-source-history"/);
  assert.match(styles, /\.reader-source-history/);
});

test('managed source filters expose an accessible responsive search control', () => {
  const renderFilters = extractFunction('renderSourceManageFilters');

  assert.match(renderFilters, /type="search"/);
  assert.match(renderFilters, /placeholder="搜索订阅源"/);
  assert.match(renderFilters, /aria-label="搜索订阅源"/);
  assert.doesNotMatch(renderFilters, /sr-only/);
  assert.match(renderFilters, /search\.oninput/);
  assert.match(renderFilters, /renderManagedSourceList\(listTarget\)/);
  assert.match(styles, /\.source-manage-filters input/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.source-manage-search\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});
