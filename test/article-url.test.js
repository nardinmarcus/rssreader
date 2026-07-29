const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const projectDir = path.join(__dirname, '..');
const sources = [
  ['server', fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8')],
  ['browser', fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8')],
];

function sourceForFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}()`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`expected closing brace for ${name}()`);
}

function evaluate(source, names, expression, globals = {}) {
  const context = { ...globals, result: undefined };
  vm.runInNewContext(
    `${names.map(name => sourceForFunction(source, name)).join('\n')}\nresult = ${expression};`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

test('article locators use the original English title and remain ASCII-only', () => {
  const entry = {
    id: '8ce46c6026d60dd0a0156762f7b29d0d',
    title: 'Document-borne AI worms can self-propagate through Copilot for Word',
    titleZh: '文档传播的AI蠕虫可通过Word的Copilot自我复制',
  };
  const expected = 'document-borne-ai-worms-can-self-propagate-through-copilot-for-word--8ce46c6026d6';

  for (const [label, source] of sources) {
    const locator = evaluate(
      source,
      ['slugifyForUrl', 'entrySlug', 'entryShortId', 'entryArticleLocator'],
      'entryArticleLocator(entry)',
      { entry, ARTICLE_SHORT_ID_LENGTH: 12 },
    );
    assert.equal(locator, expected, label);
    assert.match(locator, /^[a-z0-9-]+$/, label);
  }
});

test('article locators fall back to an English alias for non-Latin titles', () => {
  const entry = {
    id: 'cc623303b19c0827b18263ae60995f30',
    title: '谁在运行那些微小的服务器？',
    titleZh: '谁在运行那些微小的服务器？',
  };

  for (const [label, source] of sources) {
    const locator = evaluate(
      source,
      ['slugifyForUrl', 'entrySlug', 'entryShortId', 'entryArticleLocator'],
      'entryArticleLocator(entry)',
      { entry, ARTICLE_SHORT_ID_LENGTH: 12 },
    );
    assert.equal(locator, 'article--cc623303b19c', label);
  }
});

test('legacy Unicode article locators remain parseable by short id', () => {
  const legacy = '文档传播的ai蠕虫可通过word的copilot自我复制--8ce46c6026d6';

  for (const [label, source] of sources) {
    const parsed = evaluate(source, ['splitArticleLocator'], 'splitArticleLocator(legacy)', { legacy });
    assert.deepEqual(parsed, {
      slug: '文档传播的ai蠕虫可通过word的copilot自我复制',
      shortId: '8ce46c6026d6',
    }, label);
  }
});
