const test = require('node:test');
const assert = require('node:assert/strict');
const { compileOpenDaily } = require('../lib/periodicals');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');

function highPrioritySource(overrides = {}) {
  return {
    id: 'source-high',
    name: 'High Source',
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
    id: 'entry-one',
    sourceId: 'source-high',
    title: 'A deterministic release',
    titleZh: '一次确定性的发布',
    link: 'https://example.com/releases/one?utm_source=test#details',
    summary: 'The release is available with a reproducible build.',
    content: '<p>The release is available with a reproducible build.</p>',
    contentHash: 'entry-content-hash-one',
    publishedTs: NOW - (30 * 60 * 1000),
    createdAt: NOW - (20 * 60 * 1000),
    ...overrides,
  };
}

test('open daily compiles one eligible SQLite candidate into a complete explainable event', () => {
  const result = compileOpenDaily({
    now: NOW,
    sources: [highPrioritySource()],
    candidates: [candidate()],
  });

  assert.equal(result.issue.cadence, 'daily');
  assert.equal(result.issue.periodKey, '2026-07-30');
  assert.equal(result.issue.timezone, 'Asia/Shanghai');
  assert.equal(result.issue.status, 'open');
  assert.equal(result.issue.revision, 1);
  assert.equal(result.issue.summaryStatus, 'fallback');
  assert.match(result.issue.overview, /1 个达到 40 分门槛的事件/);
  assert.match(result.issue.contentHash, /^[a-f0-9]{64}$/);

  assert.deepEqual(result.themes.map(theme => [theme.themeKey, theme.title]), [
    ['products_tools', '产品与工具'],
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, '一次确定性的发布');
  assert.equal(result.events[0].importanceScore, 49.8);
  assert.deepEqual(result.events[0].score, {
    version: 'importance-v1',
    sourceQuality: { priority: 'high', points: 30 },
    confirmation: { independentSourceCount: 1, points: 0 },
    persistence: { daysPresent: 0, points: 0 },
    trend: { baselineSourceCount: 0, sourceIncrease: 0, points: 0 },
    freshness: { ageHours: 0.5, halfLifeHours: 36, points: 19.8 },
    behavior: { enabled: false, starredCount: 0, viewCount: 0, points: 0 },
  });
  assert.equal(result.events[0].whySelected, '来源质量（高）计 30 分；时效性计 19.8 分。');

  assert.deepEqual(result.evidence, [{
    eventId: result.events[0].id,
    entryId: 'entry-one',
    sourceId: 'source-high',
    sourceName: 'High Source',
    sourceLabels: ['产品'],
    editorialPriority: 'high',
    entryTitle: 'A deterministic release',
    entryTitleZh: '一次确定性的发布',
    entryLink: 'https://example.com/releases/one?utm_source=test#details',
    canonicalUrl: 'https://example.com/releases/one',
    summaryExcerpt: 'The release is available with a reproducible build.',
    contentHash: 'entry-content-hash-one',
    effectivePublishedAt: NOW - (30 * 60 * 1000),
    timestampFallback: false,
    isPrimary: true,
    displayOrder: 0,
  }]);
});

test('freshness uses the exact age before rounding the persisted points', () => {
  const result = compileOpenDaily({
    now: NOW,
    sources: [highPrioritySource()],
    candidates: [candidate({
      publishedTs: NOW - (8 * 60 * 1000),
      createdAt: NOW - (8 * 60 * 1000),
    })],
  });

  assert.equal(result.events[0].score.freshness.ageHours, 0.1);
  assert.equal(result.events[0].score.freshness.points, 19.9);
  assert.equal(result.events[0].importanceScore, 49.9);
});

test('empty candidate text receives a deterministic summary and overview states actual coverage start', () => {
  const result = compileOpenDaily({
    now: NOW,
    coverageStartedAt: NOW - (60 * 60 * 1000),
    sources: [highPrioritySource()],
    candidates: [candidate({
      titleZh: null,
      summary: '',
      content: '',
    })],
  });

  assert.equal(result.events.length, 1);
  assert.match(result.events[0].summary, /A deterministic release/);
  assert.match(result.events[0].summary, /未提供可用摘要/);
  assert.equal(result.evidence[0].summaryExcerpt, '');
  assert.match(result.issue.overview, /精选规则于 2026-07-30 11:00（Asia\/Shanghai）启用/);
});

test('source eligibility and editorial priority are explicit while refresh priority is irrelevant', () => {
  const sources = [
    highPrioritySource(),
    highPrioritySource({ id: 'source-normal', name: 'Normal Source', editorialPriority: 'normal' }),
    highPrioritySource({ id: 'source-disabled', enabled: false }),
    highPrioritySource({ id: 'source-manual', manual: true }),
    highPrioritySource({ id: 'source-no-feed', feeds: [] }),
  ];
  const candidates = sources.map((source, index) => candidate({
    id: `entry-${source.id}`,
    sourceId: source.id,
    publishedTs: NOW,
    createdAt: NOW,
    contentHash: `hash-${index}`,
  }));
  const first = compileOpenDaily({
    now: NOW,
    sources: sources.map(source => ({ ...source, refreshPriority: 1 })),
    candidates,
  });
  const refreshChanged = compileOpenDaily({
    now: NOW,
    sources: sources.map(source => ({ ...source, refreshPriority: 999 })),
    candidates,
  });

  assert.deepEqual(first.evidence.map(item => item.sourceId).sort(), [
    'source-high',
    'source-normal',
  ]);
  assert.equal(first.events.length, 2);
  assert.equal(first.events.find(event => event.importanceScore === 40).score.sourceQuality.priority, 'normal');
  assert.deepEqual(refreshChanged.events, first.events);
  assert.equal(refreshChanged.issue.contentHash, first.issue.contentHash);
});

test('Shanghai window, build cutoff, and future timestamp fallback are strict and explainable', () => {
  const periodStart = Date.parse('2026-07-29T16:00:00.000Z');
  const periodEnd = Date.parse('2026-07-30T16:00:00.000Z');
  const result = compileOpenDaily({
    now: NOW,
    sources: [highPrioritySource()],
    candidates: [
      candidate({ id: 'at-start', publishedTs: periodStart, createdAt: periodStart }),
      candidate({ id: 'before-start', publishedTs: periodStart - 1, createdAt: periodStart - 1 }),
      candidate({ id: 'created-after-cutoff', publishedTs: NOW, createdAt: NOW + 1 }),
      candidate({ id: 'within-future-tolerance', publishedTs: NOW + (5 * 60 * 60 * 1000), createdAt: NOW }),
      candidate({ id: 'future-fallback', publishedTs: NOW + (7 * 60 * 60 * 1000), createdAt: NOW - 1000 }),
    ],
  });

  assert.deepEqual(result.evidence.map(item => item.entryId).sort(), [
    'at-start',
    'future-fallback',
    'within-future-tolerance',
  ]);
  const tolerated = result.evidence.find(item => item.entryId === 'within-future-tolerance');
  assert.equal(tolerated.effectivePublishedAt, NOW + (5 * 60 * 60 * 1000));
  assert.equal(tolerated.timestampFallback, false);
  const fallback = result.evidence.find(item => item.entryId === 'future-fallback');
  assert.equal(fallback.effectivePublishedAt, NOW - 1000);
  assert.equal(fallback.timestampFallback, true);

  const endBoundary = compileOpenDaily({
    now: periodEnd - 1,
    sources: [highPrioritySource()],
    candidates: [candidate({
      id: 'at-period-end',
      publishedTs: periodEnd,
      createdAt: periodEnd - 1,
    })],
  });
  assert.equal(endBoundary.events.length, 0);
});

test('each candidate remains an independent event and AI HOT body links do not confirm it', () => {
  const source = highPrioritySource({
    id: 'aihot-daily',
    name: 'AI HOT 日报',
    labels: ['产品', '产业'],
  });
  const sharedLink = 'https://aihot.virxact.com/daily/2026-07-30';
  const result = compileOpenDaily({
    now: NOW,
    sources: [source],
    candidates: [
      candidate({
        id: 'aihot-one',
        sourceId: source.id,
        link: sharedLink,
        content: '<a href="https://openai.com">OpenAI</a><a href="https://anthropic.com">Anthropic</a>',
      }),
      candidate({ id: 'aihot-two', sourceId: source.id, link: sharedLink }),
    ],
  });

  assert.equal(result.events.length, 2);
  assert.equal(result.evidence.length, 2);
  assert.equal(new Set(result.events.map(event => event.eventKey)).size, 2);
  for (const event of result.events) {
    assert.deepEqual(event.score.confirmation, { independentSourceCount: 1, points: 0 });
    assert.equal(event.cluster.reason, 'single-candidate');
    assert.doesNotMatch(event.whySelected, /确认|OpenAI|Anthropic/);
  }
});

test('stable tie-break caps the issue at 12 and is independent of candidate input order', () => {
  const candidates = Array.from({ length: 13 }, (_, index) => candidate({
    id: `tied-entry-${String(index + 1).padStart(2, '0')}`,
    link: `https://example.com/tied/${index + 1}`,
    contentHash: `tied-content-${index + 1}`,
    publishedTs: NOW,
    createdAt: NOW,
  }));
  const forward = compileOpenDaily({
    now: NOW,
    sources: [highPrioritySource()],
    candidates,
  });
  const reversed = compileOpenDaily({
    now: NOW,
    sources: [highPrioritySource()],
    candidates: [...candidates].reverse(),
  });

  assert.equal(forward.events.length, 12);
  assert.deepEqual(
    forward.events.map(event => [event.eventKey, event.importanceScore, event.displayOrder]),
    reversed.events.map(event => [event.eventKey, event.importanceScore, event.displayOrder]),
  );
  assert.equal(forward.issue.contentHash, reversed.issue.contentHash);
});
