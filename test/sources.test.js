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
    'google-deepmind',
    'google-ai',
    'huggingface-blog',
    'the-batch',
    'meta-ai',
    'importai',
    'simonwillison',
    'latentspace',
  ].forEach(id => assert.ok(ids.has(id), `missing ${id}`));
  assert.equal(SOURCES.find(source => source.id === 'qiaomu-blog').enabled, false);
  assert.deepEqual(SOURCES.find(source => source.id === 'qiaomu-blog').labels, ['上游来源']);
  assert.equal(SOURCES.find(source => source.id === 'meta-ai').enabled, false);
});

test('RSSHub instances are parsed, normalized, and deduplicated', () => {
  assert.deepEqual(parseRsshubInstances('https://one.example/, https://one.example, http://two.example/'), [
    'https://one.example',
    'http://two.example',
  ]);
  assert.deepEqual(parseRsshubInstances('not-a-url'), DEFAULT_RSSHUB_INSTANCES);
  assert.deepEqual(parseRsshubInstances(''), DEFAULT_RSSHUB_INSTANCES);
});
