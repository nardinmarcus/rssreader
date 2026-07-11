const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const {
  ensureRewriteLinks,
  rewritePromptForEntry,
  rewritePromptKey,
} = require('../lib/deepseek');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const expectedHeadings = [
  '## 为什么值得写',
  '## 创作角度',
  '## 事实底稿与原始链接',
  '## Namoo 风格草稿',
  '## 需要 Namoo 补充',
  '## 发布前检查',
];

test('default prompt defines the six-part Namoo creation draft and human boundaries', () => {
  const prompt = rewritePromptForEntry({ sourceId: 'openai' });
  assert.deepEqual(prompt.split('\n').filter(line => line.startsWith('## ')), expectedHeadings);
  assert.match(prompt, /\[需要 Namoo 补充：具体内容\]/);
  assert.match(prompt, /不得替大月编造第一手观察/);
  assert.match(prompt, /2 到 3 个不同角度/);
  assert.match(rewritePromptKey({ sourceId: 'openai' }), /^namoo-/);
});

test('paper, Product Hunt, and Hacker News keep their material-specific boundaries', () => {
  assert.match(rewritePromptForEntry({ sourceId: 'huggingface' }), /摘要里没有交代/);
  assert.match(rewritePromptForEntry({ sourceId: 'producthunt' }), /产品官网抓取资料/);
  assert.match(rewritePromptForEntry({ sourceId: 'hackernews' }), /明确区分原文事实、作者回复和社区评论/);
});

test('missing source links are inserted inside the fact section without a seventh heading', () => {
  const draft = expectedHeadings.map(heading => `${heading}\n内容`).join('\n\n');
  const linked = ensureRewriteLinks(draft, [{ label: '原文', url: 'https://example.com/article' }]);
  assert.match(linked, /## 事实底稿与原始链接[\s\S]*\[原文\]\(https:\/\/example\.com\/article\)[\s\S]*## Namoo 风格草稿/);
  assert.deepEqual(linked.split('\n').filter(line => line.startsWith('## ')), expectedHeadings);
});
