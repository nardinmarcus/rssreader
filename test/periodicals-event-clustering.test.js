const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeEvidenceUrl,
  compileOpenDaily,
  eventMergeDecision,
  normalizeEventFeatures,
} = require('../lib/periodicals');

const NOW = Date.parse('2026-07-30T04:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function source(id, overrides = {}) {
  return {
    id,
    name: `Source ${id}`,
    category: 'article',
    labels: ['产品'],
    enabled: true,
    manual: false,
    feeds: [`https://${id}.example/feed.xml`],
    editorialPriority: 'high',
    ...overrides,
  };
}

function candidate(id, sourceId, overrides = {}) {
  return {
    id,
    sourceId,
    title: 'Atlas releases Alpha platform for enterprise teams',
    titleZh: null,
    link: `https://${sourceId}.example/posts/${id}`,
    summary: 'Atlas released the Alpha platform for enterprise teams.',
    content: '<p>Atlas released the Alpha platform for enterprise teams.</p>',
    contentHash: `content-${id}`,
    publishedTs: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function features(title, effectivePublishedAt = NOW) {
  return normalizeEventFeatures({
    entryId: title,
    title,
    titleZh: null,
    summary: title,
    sourceLabels: ['产品'],
    link: `https://example.com/${encodeURIComponent(title)}`,
    effectivePublishedAt,
  });
}

test('event normalization versions tracking removal and Unicode NFKC rules as fixed fixtures', () => {
  assert.equal(
    canonicalizeEvidenceUrl('HTTPS://Example.COM:443/path?utm_source=rss&source=edition&fbclid=x&b=2&a=1#details'),
    'https://example.com/path?a=1&b=2&source=edition',
  );

  const normalized = normalizeEventFeatures({
    entryId: 'unicode-entry',
    title: 'ＯｐｅｎＡＩ　正式发布　ＧＰＴ－５！！！',
    titleZh: 'OpenAI   发布 GPT-5',
    summary: 'OpenAI launches GPT-5.',
    sourceLabels: ['产品'],
    link: 'https://EXAMPLE.com:443/release?gclid=x&source=feed#top',
    effectivePublishedAt: NOW,
  });

  assert.deepEqual(normalized.versions, {
    actionAnchors: 'periodical-action-v1',
    entityAnchors: 'periodical-entity-v1',
    titleNormalization: 'periodical-title-v1',
    urlCanonicalization: 'periodical-url-v1',
  });
  assert.equal(normalized.canonicalUrl, 'https://example.com/release?source=feed');
  assert.deepEqual(normalized.normalizedTitles, [
    'openai 正式发布 gpt-5',
    'openai 发布 gpt-5',
  ]);
  assert.equal(normalized.actionFamily, 'release_update');
  assert.equal(normalized.primaryEntityAnchors.includes('gpt-5'), true);

  const summaryAnchored = normalizeEventFeatures({
    entryId: 'summary-anchored',
    title: 'Major launch with new capabilities',
    summary: 'OpenAI launches GPT-5 for developers.',
    sourceLabels: ['产品'],
    link: 'https://example.com/summary-anchored',
    effectivePublishedAt: NOW,
  });
  assert.equal(summaryAnchored.primaryEntityAnchors.includes('gpt-5'), true);
});

test('semantic merge includes the exact 72-hour boundary and enforces the 0.82 title threshold', () => {
  const aboveLeft = features('atlas releases alpha bravo charlie quartz');
  const aboveRight = features(
    'atlas releases alpha bravo charlie vexing',
    NOW + (72 * HOUR_MS),
  );
  const atBoundary = eventMergeDecision(aboveLeft, aboveRight);
  assert.equal(atBoundary.merge, true);
  assert.equal(atBoundary.reason, 'semantic');
  assert.equal(atBoundary.timeDeltaHours, 72);
  assert.equal(atBoundary.thresholds.titleSimilarity, 0.82);
  assert.equal(atBoundary.titleSimilarity >= 0.82, true);

  const outsideWindow = eventMergeDecision(
    aboveLeft,
    features('atlas releases alpha bravo charlie vexing', NOW + (72 * HOUR_MS) + 1),
  );
  assert.equal(outsideWindow.merge, false);

  const belowThreshold = eventMergeDecision(
    features('atlas releases alpha bravo quartz'),
    features('atlas releases alpha bravo vexing'),
  );
  assert.equal(belowThreshold.titleSimilarity < 0.82, true);
  assert.equal(belowThreshold.merge, false);
});

test('canonical URL merge preserves every evidence while syndication and same-source copies confirm once', () => {
  const sources = [source('source-a'), source('source-b', { editorialPriority: 'normal' })];
  const candidates = [
    candidate('entry-a', 'source-a', {
      title: 'First wording',
      summary: 'First evidence.',
      link: 'https://news.example/item?utm_source=a#one',
    }),
    candidate('entry-b', 'source-b', {
      title: 'Unrelated syndicated wording',
      summary: 'Second evidence.',
      link: 'https://NEWS.example:443/item?fbclid=b',
    }),
    candidate('entry-c', 'source-a', {
      title: 'Third wording',
      summary: 'Third evidence.',
      link: 'https://news.example/item?utm_medium=c',
    }),
  ];

  const forward = compileOpenDaily({ now: NOW, sources, candidates });
  const reversed = compileOpenDaily({ now: NOW, sources, candidates: [...candidates].reverse() });

  assert.equal(forward.events.length, 1);
  assert.equal(forward.evidence.length, 3);
  assert.equal(forward.evidence.filter(item => item.isPrimary).length, 1);
  assert.deepEqual(forward.events[0].score.confirmation, {
    independentSourceCount: 1,
    points: 0,
  });
  assert.equal(forward.events[0].cluster.version, 'event-cluster-v1');
  assert.equal(forward.events[0].cluster.reason, 'canonical-url');
  assert.equal(forward.events[0].cluster.mergeReasons.every(item => item.reason === 'canonical-url'), true);
  assert.deepEqual(
    forward.events.map(event => [event.eventKey, event.cluster.entryIds]),
    reversed.events.map(event => [event.eventKey, event.cluster.entryIds]),
  );
  assert.deepEqual(
    forward.evidence.map(item => [item.entryId, item.displayOrder, item.isPrimary]),
    reversed.evidence.map(item => [item.entryId, item.displayOrder, item.isPrimary]),
  );
  assert.equal(forward.issue.contentHash, reversed.issue.contentHash);
});

test('non-URL clustering is complete-link and remains independent of candidate input order', () => {
  const sources = [source('source-a'), source('source-b'), source('source-c')];
  const candidates = [
    candidate('entry-a', 'source-a', {
      title: 'atlas releases alpha bravo charlie',
      summary: 'atlas releases alpha bravo charlie',
    }),
    candidate('entry-b', 'source-b', {
      title: 'atlas releases alpha bravo charlie delta',
      summary: 'atlas releases alpha bravo charlie delta',
    }),
    candidate('entry-c', 'source-c', {
      title: 'atlas releases alpha charlie delta echo',
      summary: 'atlas releases alpha charlie delta echo',
    }),
  ];

  const forward = compileOpenDaily({ now: NOW, sources, candidates });
  const reversed = compileOpenDaily({ now: NOW, sources, candidates: [...candidates].reverse() });
  const entrySets = forward.events.map(event => event.cluster.entryIds);

  assert.deepEqual(entrySets, [['entry-a', 'entry-b'], ['entry-c']]);
  assert.deepEqual(
    forward.events.map(event => [event.eventKey, event.cluster.entryIds, event.displayOrder]),
    reversed.events.map(event => [event.eventKey, event.cluster.entryIds, event.displayOrder]),
  );
  assert.equal(forward.events[0].cluster.reason, 'complete-link');
  assert.deepEqual(forward.events[0].score.confirmation, {
    independentSourceCount: 2,
    points: 8,
  });
  assert.equal(forward.issue.contentHash, reversed.issue.contentHash);
});

test('same-company different-product same-project different-action and generic titles never merge', () => {
  const sources = Array.from({ length: 6 }, (_, index) => source(
    `source-${index + 1}`,
    index >= 4 ? { labels: ['社区'] } : {},
  ));
  const candidates = [
    candidate('company-alpha', 'source-1', {
      title: 'Acme launches Alpha assistant with private enterprise controls today',
    }),
    candidate('company-beta', 'source-2', {
      title: 'Acme launches Beta assistant with private enterprise controls today',
    }),
    candidate('project-release', 'source-3', {
      title: 'Atlas releases Atlas 2.0 compiler with enterprise controls today',
    }),
    candidate('project-open-source', 'source-4', {
      title: 'Atlas open sources Atlas 2.0 compiler with enterprise controls today',
    }),
    candidate('generic-one', 'source-5', {
      title: 'AI launches new model with major capabilities today',
      summary: 'A new AI model launches with major capabilities today.',
    }),
    candidate('generic-two', 'source-6', {
      title: 'AI launches new model with major capabilities today',
      summary: 'A new AI model launches with major capabilities today.',
    }),
  ];

  const result = compileOpenDaily({ now: NOW, sources, candidates });

  assert.equal(result.events.length, 6);
  assert.equal(result.events.every(event => event.cluster.entryIds.length === 1), true);
  assert.equal(result.events.find(event => event.cluster.entryIds[0] === 'generic-one').topicKey, null);
  assert.equal(result.events.find(event => event.cluster.entryIds[0] === 'generic-two').topicKey, null);
});

test('confirmation persistence and trend use exact caps and only the latest seven frozen daily baselines', () => {
  const sources = Array.from({ length: 5 }, (_, index) => source(`source-${index + 1}`));
  const candidates = sources.map((item, index) => candidate(`entry-${index + 1}`, item.id));
  const seed = compileOpenDaily({
    now: NOW,
    sources: [sources[0]],
    candidates: [candidates[0]],
  });
  const topicKey = seed.events[0].topicKey;
  assert.match(topicKey, /^[a-f0-9]{64}$/);

  const history = [
    ['2026-07-29', 2],
    ['2026-07-28', 1],
    ['2026-07-27', 2],
    ['2026-07-26', 1],
    ['2026-07-25', 2],
    ['2026-07-24', 1],
    ['2026-07-23', 2],
    ['2026-07-22', 99],
  ].map(([periodKey, independentSourceCount]) => ({
    periodKey,
    status: 'frozen',
    topics: [{ topicKey, independentSourceCount }],
  }));

  const forward = compileOpenDaily({
    now: NOW,
    sources,
    candidates,
    frozenDailyHistory: history,
  });
  const reversed = compileOpenDaily({
    now: NOW,
    sources,
    candidates: [...candidates].reverse(),
    frozenDailyHistory: [...history].reverse(),
  });
  const event = forward.events[0];

  assert.equal(forward.events.length, 1);
  assert.deepEqual(event.score.confirmation, { independentSourceCount: 5, points: 25 });
  assert.deepEqual(event.score.persistence, { daysPresent: 7, points: 14 });
  assert.deepEqual(event.score.trend, { baselineSourceCount: 2, sourceIncrease: 3, points: 6 });
  assert.equal(event.importanceScore, 95);
  assert.match(event.whySelected, /5 个独立来源确认/);
  assert.match(event.whySelected, /过去 7 个冻结日报出现 7 天/);
  assert.match(event.whySelected, /单日峰值增加 3 个/);
  assert.doesNotMatch(event.whySelected, /读者热度|行为/);
  assert.deepEqual(
    forward.events.map(item => [item.eventKey, item.importanceScore, item.score]),
    reversed.events.map(item => [item.eventKey, item.importanceScore, item.score]),
  );
  assert.equal(forward.issue.contentHash, reversed.issue.contentHash);
});
