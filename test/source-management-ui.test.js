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
