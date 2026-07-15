const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RSSHUB_INSTANCES,
  SOURCES,
  parseRsshubInstances,
} = require('../lib/sources');

test('source ids, labels, priorities, and default orders are complete', () => {
  assert.equal(new Set(SOURCES.map(source => source.id)).size, SOURCES.length);
  SOURCES.forEach((source, index) => {
    assert.ok(Array.isArray(source.labels) && source.labels.length, `${source.id} needs labels`);
    assert.match(source.editorialPriority, /^(high|normal|low)$/);
    assert.equal(source.displayOrder, index);
  });
});

test('Namoo core source catalog is present without duplicating existing sources', () => {
  const ids = new Set(SOURCES.map(source => source.id));
  [
    'openai',
    'anthropic',
    'anthropic-research',
    'google-deepmind',
    'google-ai',
    'huggingface-blog',
    'the-batch',
    'meta-ai',
    'importai',
    'simonwillison',
    'latentspace',
  ].forEach(id => assert.ok(ids.has(id), `missing ${id}`));
  const anthropicResearch = SOURCES.find(source => source.id === 'anthropic-research');
  assert.equal(anthropicResearch.enabled, true);
  assert.equal(anthropicResearch.editorialPriority, 'high');
  assert.equal(anthropicResearch.sitemapPathPrefix, '/research/');
  assert.deepEqual(anthropicResearch.labels, ['官方', '研究']);
  assert.equal(SOURCES.find(source => source.id === 'qiaomu-blog').enabled, false);
  assert.deepEqual(SOURCES.find(source => source.id === 'qiaomu-blog').labels, ['上游来源']);
  assert.equal(SOURCES.find(source => source.id === 'meta-ai').enabled, false);
});

test('the six approved high-signal sources use official endpoints and no XiaoHu proxy', () => {
  const expected = {
    'claude-blog': ['sitemap:https://claude.com/sitemap.xml', '/blog/'],
    'langchain-blog': ['sitemap:https://www.langchain.com/sitemap.xml', '/blog/'],
    every: ['https://every.to/feeds/global.xml', undefined],
    'thinking-machines': ['https://thinkingmachines.ai/index.xml', undefined],
    'lilian-weng': ['https://lilianweng.github.io/index.xml', undefined],
    'google-research': ['https://research.google/blog/rss/', undefined],
  };

  for (const [id, [feed, sitemapPathPrefix]] of Object.entries(expected)) {
    const source = SOURCES.find(item => item.id === id);
    assert.ok(source, `missing ${id}`);
    assert.equal(source.enabled, true);
    assert.deepEqual(source.feeds, [feed]);
    assert.equal(source.sitemapPathPrefix, sitemapPathPrefix);
    assert.equal(source.editorialPriority, 'high');
  }
  assert.equal(SOURCES.some(source => /xiaohu/i.test(`${source.id} ${source.name} ${source.siteUrl}`)), false);
});

test('RSSHub instances are parsed, normalized, and deduplicated', () => {
  assert.deepEqual(parseRsshubInstances('https://one.example/, https://one.example, http://two.example/'), [
    'https://one.example',
    'http://two.example',
  ]);
  assert.deepEqual(parseRsshubInstances('not-a-url'), DEFAULT_RSSHUB_INSTANCES);
  assert.deepEqual(parseRsshubInstances(''), DEFAULT_RSSHUB_INSTANCES);
});
