const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('onepage-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');
const {
  ONEPAGE_PIPELINE_VERSION,
  ONEPAGE_PROMPT_VERSION,
  createOnepageModule,
} = require('../lib/onepage');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedEntry(entryId = 'onepage-entry', documentId = `${entryId}-document`, sourceHash = `${entryId}-source-v1`) {
  store.upsertEntries([{
    id: entryId,
    sourceId: 'onepage-test',
    title: 'Reliable agents',
    link: `https://example.com/${entryId}`,
    author: 'Example Lab',
    published: '2026-07-14',
    summary: 'Agent reliability summary.',
    content: '<h2>Reliable agents</h2><p>Tests cover 120 real tasks.</p><p>Recovery is the main failure.</p>',
  }]);
  const document = store.insertArticleDocument({
    id: documentId,
    entryId,
    snapshotId: null,
    sourceComponents: [{ type: 'feed', contentHash: `${sourceHash}-content` }],
    provenance: 'feed',
    rawStatus: 'unavailable',
    documentHash: `${documentId}-hash`,
    sourceHash,
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
    title: 'Reliable agents',
    summary: 'Agent reliability summary.',
    normalizedHtml: '<h2>Reliable agents</h2><p>Tests cover 120 real tasks.</p><p>Recovery is the main failure.</p>',
    plainText: 'Reliable agents\nTests cover 120 real tasks.\nRecovery is the main failure.',
    ast: [
      { type: 'element', tag: 'h2', children: [{ type: 'text', id: 's_title', role: 'heading', text: 'Reliable agents' }] },
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_1', role: 'paragraph', text: 'Tests cover 120 real tasks.' }] },
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_2', role: 'paragraph', text: 'Recovery is the main failure.' }] },
    ],
    resources: [],
    createdAt: Date.now(),
  });
  store.setCurrentArticleDocument(entryId, document.id);
  return { entry: store.getEntry(entryId), document };
}

function payload() {
  return {
    schemaVersion: 1,
    title: '可靠 Agent，不只是更聪明',
    thesis: { text: '竞争重点已经转向可靠完成任务。', segmentIds: ['s_title', 's_fact_2'] },
    keyPoints: [
      { title: '真实任务', text: '评估覆盖了 120 个任务。', segmentIds: ['s_fact_1'] },
      { title: '主要失败', text: '恢复能力是主要问题。', segmentIds: ['s_fact_2'] },
      { title: '系统视角', text: '需要关注完整任务链路。', segmentIds: ['s_title', 's_fact_2'] },
    ],
    evidence: [
      { text: '任务样本数量为 120。', segmentIds: ['s_fact_1'] },
      { text: '恢复是主要失败来源。', segmentIds: ['s_fact_2'] },
    ],
    framework: null,
    implications: [
      { text: '可靠性评估应覆盖恢复路径。', segmentIds: ['s_fact_2'] },
    ],
    questions: ['你的 Agent 能从中断处恢复吗？'],
  };
}

function user(label) {
  return store.createUser({
    email: `${label}@example.com`,
    password: 'correct-horse-battery-staple',
    displayName: label,
  });
}

test('Onepage generation is cached, force creates an immutable version, and publication is explicit', async () => {
  const { entry, document } = seedEntry();
  const owner = user('onepage-owner');
  const stranger = user('onepage-stranger');
  let calls = 0;
  const onepage = createOnepageModule({
    store,
    generatePayload: async () => {
      calls += 1;
      return { payload: payload(), provider: 'fake', model: 'fake-onepage' };
    },
  });

  const first = await onepage.generateOnepage(entry, { viewer: owner });
  const cached = await onepage.generateOnepage(entry, { viewer: owner });
  const forced = await onepage.generateOnepage(entry, { viewer: owner, force: true });

  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(cached.onepage.id, first.onepage.id);
  assert.notEqual(forced.onepage.id, first.onepage.id);
  const pipelineHash = store.hashText([
    ONEPAGE_PIPELINE_VERSION,
    ONEPAGE_PROMPT_VERSION,
    'schema-1',
  ].join('\n'));
  const deterministicHash = store.hashText([
    document.id,
    document.sourceHash,
    pipelineHash,
    owner.id,
    'fake',
    'fake-onepage',
  ].join('\n'));
  assert.equal(first.onepage.generationHash, deterministicHash);
  assert.notEqual(forced.onepage.generationHash, deterministicHash);
  assert.equal(calls, 2);
  assert.equal(first.onepage.visibility, 'private');
  assert.equal(onepage.getOnepage(first.onepage.id, { viewer: stranger }), null);
  assert.equal(onepage.getOnepage(first.onepage.id, { viewer: null }), null);

  const published = onepage.publishOnepage(first.onepage.id, { viewer: owner });
  assert.equal(published.visibility, 'public');
  assert.equal(onepage.getOnepage(first.onepage.id, { viewer: null }).id, first.onepage.id);
  assert.equal(onepage.getOnepage(forced.onepage.id, { viewer: null }), null);
  assert.equal(onepage.getOnepage(first.onepage.id, { viewer: owner }).html.includes('onepage-shell'), true);
});

test('Onepage versions remain addressable and become stale when the current source document changes', async () => {
  const { entry } = seedEntry('stale-entry', 'stale-document-v1', 'stale-source-v1');
  const owner = user('stale-owner');
  const onepage = createOnepageModule({
    store,
    generatePayload: async () => ({ payload: payload(), provider: 'fake', model: 'fake-onepage' }),
  });
  const generated = await onepage.generateOnepage(entry, { viewer: owner });

  seedEntry('stale-entry', 'stale-document-v2', 'stale-source-v2');

  const stale = onepage.getOnepage(generated.onepage.id, { viewer: owner });
  assert.equal(stale.id, generated.onepage.id);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.staleReasons, ['source_document_changed', 'source_hash_changed']);
});

test('Onepage publication is owner-or-admin only', async () => {
  const { entry } = seedEntry('permission-entry');
  const owner = user('permission-owner');
  const stranger = user('permission-stranger');
  const onepage = createOnepageModule({
    store,
    generatePayload: async () => ({ payload: payload(), provider: 'fake', model: 'fake-onepage' }),
  });
  const generated = await onepage.generateOnepage(entry, { viewer: owner });

  assert.throws(
    () => onepage.publishOnepage(generated.onepage.id, { viewer: stranger }),
    /not allowed/i,
  );
});

test('only published Onepages enter public asset summaries, profiles, and helpful reactions', async () => {
  const { entry } = seedEntry('public-asset-entry');
  const owner = user('public-asset-owner');
  const reader = user('public-asset-reader');
  const onepage = createOnepageModule({
    store,
    generatePayload: async () => ({ payload: payload(), provider: 'fake', model: 'fake-onepage' }),
  });
  const generated = await onepage.generateOnepage(entry, { viewer: owner });

  assert.equal(store.getEntryAssetSummaries([entry.id])[entry.id].onepageCount, 0);
  assert.deepEqual(store.getUserOnepages(owner.id), []);

  onepage.publishOnepage(generated.onepage.id, { viewer: owner });
  const summary = store.getEntryAssetSummaries([entry.id])[entry.id];
  assert.equal(summary.onepage, true);
  assert.equal(summary.onepageCount, 1);
  assert.equal(summary.items.onepage[0].id, generated.onepage.id);
  assert.equal(store.getUserOnepages(owner.id)[0].id, generated.onepage.id);

  const reaction = store.setEntryAssetHelpful(entry.id, 'onepage', reader.id, true, generated.onepage.id);
  assert.equal(reaction.helpful_count, 1);
  assert.equal(store.getEntryAssetReaction(entry.id, 'onepage', reader, generated.onepage.id).helpfulByMe, true);
});
