const test = require('node:test');
const assert = require('node:assert/strict');
const { compileOpenDaily } = require('../lib/periodicals');
const {
  computePeriodicalContentHash,
  summarizePeriodicalIssue,
} = require('../lib/periodical-summary');
const {
  computeRevisionContentHash,
  freezeCompiledIssue,
  revisionContentHash,
  revisionHashDocument,
  sealRevisionContentHash,
} = require('../lib/periodical-revision');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');
const PERIOD_END = Date.parse('2026-07-30T16:00:00.000Z');

function source(overrides = {}) {
  return {
    id: 'revision-source',
    name: 'Revision Source',
    category: 'article',
    labels: ['产品'],
    enabled: true,
    manual: false,
    feeds: ['https://example.com/feed.xml'],
    editorialPriority: 'high',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    id: 'revision-entry',
    sourceId: 'revision-source',
    title: 'A published release',
    titleZh: null,
    link: 'https://example.com/releases/one',
    summary: 'The release is available.',
    content: '<p>The release is available.</p>',
    contentHash: 'revision-content-hash',
    publishedTs: NOW - (30 * 60 * 1000),
    createdAt: NOW - (30 * 60 * 1000),
    ...overrides,
  };
}

function compiledOpen(overrides = {}) {
  return compileOpenDaily({
    now: NOW,
    sources: [source()],
    candidates: [candidate()],
    ...overrides,
  });
}

test('the legacy hash alias stays compatible and sealing is idempotent', () => {
  assert.equal(computePeriodicalContentHash, computeRevisionContentHash);
  const revision = compiledOpen();
  assert.equal(revision.issue.contentHash, computeRevisionContentHash(revision));
  assert.deepEqual(sealRevisionContentHash(revision), revision);
  assert.equal(JSON.stringify(sealRevisionContentHash(revision)), JSON.stringify(revision));
});

test('generated expression replaces content without changing selection facts', async () => {
  const open = compiledOpen();
  const generated = await summarizePeriodicalIssue(open, {
    aiAdapter: async () => ({
      content: JSON.stringify({
        overview: '本期完成表达替换。所有内容均来自已保存证据。',
        events: open.events.map(event => ({
          id: event.id,
          themeKey: 'products_tools',
          title: '稳定表达标题',
          summary: '稳定表达摘要。',
          evidenceIds: [open.evidence[0].entryId],
        })),
        themes: [{ themeKey: 'products_tools', trendNote: '本期产品主题保持稳定。' }],
      }),
      provider: 'revision-provider',
      model: 'revision-model',
    }),
  });

  assert.equal(generated.issue.summaryStatus, 'generated');
  assert.equal(generated.issue.sourceInputHash, open.issue.sourceInputHash);
  assert.equal(generated.issue.inputHash, open.issue.inputHash);
  assert.deepEqual(generated.issue.selectionContext, open.issue.selectionContext);
  assert.notEqual(generated.issue.contentHash, open.issue.contentHash);
  assert.equal(generated.issue.contentHash, computeRevisionContentHash(generated));
  assert.equal(open.events[0].title, 'A published release', 'the input revision stays untouched');
});

test('freezing a finalizing revision advances workflow state and seals exactly once', () => {
  const finalizing = compiledOpen({ status: 'finalizing' });
  const frozen = freezeCompiledIssue(finalizing, PERIOD_END + (5 * 60 * 1000));

  assert.equal(frozen.issue.status, 'frozen');
  assert.equal(frozen.issue.frozenAt, PERIOD_END + (5 * 60 * 1000));
  assert.equal(frozen.issue.contentHash, computeRevisionContentHash(frozen));
  assert.notEqual(frozen.issue.contentHash, finalizing.issue.contentHash);
  assert.equal(finalizing.issue.status, 'finalizing', 'freezing never mutates the input revision');
});

test('the shared projection hashes a finalizing Daily as its published open revision', () => {
  const open = compiledOpen();
  const finalizingStored = {
    ...open,
    issue: { ...open.issue, status: 'finalizing' },
  };
  assert.equal(revisionContentHash(finalizingStored), open.issue.contentHash);
  assert.equal(revisionHashDocument(finalizingStored).issue.status, 'open');

  const frozen = freezeCompiledIssue(finalizingStored, open.issue.lastBuiltAt + 1);
  assert.equal(revisionContentHash(frozen), frozen.issue.contentHash);

  const monthlyFinalizing = {
    issue: { id: 'periodical:monthly:2026-07', cadence: 'monthly', status: 'finalizing' },
    themes: [],
    events: [],
    evidence: [],
  };
  assert.equal(
    revisionContentHash(monthlyFinalizing),
    computeRevisionContentHash(monthlyFinalizing),
    'only the Daily workflow state maps back',
  );
});
