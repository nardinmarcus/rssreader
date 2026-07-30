const crypto = require('crypto');
const {
  CANONICALIZATION_VERSION,
  canonicalSerialize,
  computeCanonicalHash,
} = require('./content-hashes');
const { mergeSourcesWithPreferences } = require('./source-preferences');
const { SOURCES } = require('./sources');
const {
  SUMMARY_VERSION,
  computePeriodicalContentHash,
  summarizePeriodicalIssue,
} = require('./periodical-summary');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 6 * HOUR_MS;
const EVENT_MERGE_WINDOW_MS = 72 * HOUR_MS;
const TITLE_SIMILARITY_THRESHOLD = 0.82;
const SELECTION_VERSION = 'importance-v1';
const CANDIDATE_SNAPSHOT_VERSION = 'periodical-candidate-v1';
const EVENT_CLUSTER_VERSION = 'event-cluster-v1';
const URL_CANONICALIZATION_VERSION = 'periodical-url-v1';
const TITLE_NORMALIZATION_VERSION = 'periodical-title-v1';
const ENTITY_ANCHOR_VERSION = 'periodical-entity-v1';
const ACTION_ANCHOR_VERSION = 'periodical-action-v1';
const TOPIC_VERSION = 'periodical-topic-v1';
const INPUT_IDENTITY_VERSION = 'periodical-input-v1';
const LEGACY_SUMMARY_VERSION = 'fallback-v1';
const SCORING_HISTORY_VERSION = 'periodical-scoring-history-v1';
const SCORE_CONFIG = Object.freeze({
  threshold: 40,
  maxEvents: 12,
  sourceQuality: Object.freeze({ high: 30, normal: 20, low: 8 }),
  confirmation: Object.freeze({
    pointsPerAdditionalSource: 8,
    maxPoints: 25,
  }),
  persistence: Object.freeze({
    lookbackFrozenDailyIssues: 7,
    pointsPerDay: 3.5,
    maxPoints: 14,
  }),
  trend: Object.freeze({
    lookbackFrozenDailyIssues: 7,
    baseline: 'max-daily-independent-source-count',
    pointsPerAdditionalSource: 2,
    maxPoints: 6,
  }),
  freshness: Object.freeze({
    maxPoints: 20,
    halfLifeHours: 36,
  }),
  behavior: Object.freeze({
    enabled: false,
    maxPoints: 5,
    starWeight: 2,
    viewWeight: 0.5,
  }),
});
const LEGACY_SCORE_CONFIG = Object.freeze({
  threshold: 40,
  maxEvents: 12,
  freshnessHalfLifeHours: 36,
  behaviorSignalEnabled: false,
});
const SOURCE_PRIORITY_RANK = Object.freeze({ high: 3, normal: 2, low: 1 });
const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'ref_src']);
const GENERIC_ENTITY_TOKENS = new Set([
  'a', 'an', 'and', 'app', 'application', 'artificial', 'assistant', 'by', 'capabilities',
  'company', 'controls', 'daily', 'enterprise', 'feature', 'features', 'for', 'intelligence',
  'latest', 'major', 'model', 'new', 'official', 'platform', 'product', 'project', 'service',
  'software', 'system', 'teams', 'technology', 'the', 'today', 'tool', 'tools', 'version',
  'with', 'ai', '公司', '产品', '人工智能', '今日', '功能', '助手', '平台', '应用', '技术',
  '上游来源', '产业', '创作', '官方', '控制', '新', '最新', '模型', '正式', '版本', '社区',
  '系统', '重磅', '项目', '服务', '能力', '工具',
]);
const ACTION_RULES = Object.freeze([
  {
    family: 'open_source',
    pattern: /\b(?:open[\s-]+sourc(?:e|es|ed|ing)|opensource(?:s|d|ing)?)\b|开源/giu,
  },
  {
    family: 'funding_acquisition',
    pattern: /\b(?:funding|funded|raises?|raised|series|acquires?|acquired|acquisition|merges?|merged|investment)\b|融资|募资|收购|并购|投资/giu,
  },
  {
    family: 'research_result',
    pattern: /\b(?:research|study|paper|result|results|benchmark|discovery|discovers?|discovered)\b|研究|论文|结果|发现|突破/giu,
  },
  {
    family: 'policy_change',
    pattern: /\b(?:policy|regulation|regulatory|law|laws|rule|rules|ban|bans|banned)\b|政策|监管|法规|法案|禁令/giu,
  },
  {
    family: 'release_update',
    pattern: /\b(?:launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|announc(?:e|es|ed|ing)|introduc(?:e|es|ed|ing)|unveil(?:s|ed|ing)?|ship(?:s|ped|ping)?|updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing))\b|发布|推出|上线|更新|升级/giu,
  },
]);
const THEME_DEFINITIONS = Object.freeze({
  research_models: '研究与模型',
  products_tools: '产品与工具',
  engineering_open_source: '工程与开源',
  industry_business: '产业与商业',
  community_practice: '社区与实践',
  creation_methods: '创作与方法',
});

const ACTIVE_BUILD_STATES = Object.freeze(['queued', 'running', 'retry_wait']);
const BUILD_RETRY_DELAYS_MS = Object.freeze([1000, 5000]);
const MAX_BUILD_ATTEMPTS = BUILD_RETRY_DELAYS_MS.length + 1;

function scoreConfigFor(behaviorSignalEnabled) {
  return Object.freeze({
    ...SCORE_CONFIG,
    behavior: Object.freeze({
      ...SCORE_CONFIG.behavior,
      enabled: Boolean(behaviorSignalEnabled),
    }),
  });
}

function resolvedNow(value) {
  const timestamp = Number(typeof value === 'function' ? value() : value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function roundOne(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function shanghaiDailyPeriod(now) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError('now must be a finite timestamp');
  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const periodStartAt = Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS;
  return {
    periodKey: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    periodStartAt,
    periodEndAt: periodStartAt + DAY_MS,
  };
}

function shanghaiDailyPeriodFromKey(periodKey) {
  const match = String(periodKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError('invalid daily period key');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const periodStartAt = Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS;
  return {
    periodKey: `${match[1]}-${match[2]}-${match[3]}`,
    periodStartAt,
    periodEndAt: periodStartAt + DAY_MS,
  };
}

function shanghaiDateTime(value) {
  const local = new Date(Number(value) + SHANGHAI_OFFSET_MS);
  const day = [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, '0'),
    String(local.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(local.getUTCHours()).padStart(2, '0'),
    String(local.getUTCMinutes()).padStart(2, '0'),
  ].join(':');
  return `${day} ${time}`;
}

function normalizedPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SCORE_CONFIG.sourceQuality, priority)
    ? priority
    : 'normal';
}

function normalizedLabels(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(label => String(label || '').trim())
    .filter(Boolean))];
}

function hasConfiguredFeed(source) {
  if (String(source && source.feedUrl || '').trim()) return true;
  return Array.isArray(source && source.feeds)
    && source.feeds.some(feed => String(feed || '').trim());
}

function eligibleSource(source) {
  return Boolean(source)
    && source.enabled !== false
    && source.manual !== true
    && hasConfiguredFeed(source);
}

function canonicalizeEvidenceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => {
        const normalized = key.toLowerCase();
        return !normalized.startsWith('utm_') && !TRACKING_QUERY_KEYS.has(normalized);
      })
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      });
    url.search = '';
    for (const [key, item] of kept) url.searchParams.append(key, item);
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeEventTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/(^|[^\p{L}\p{N}])-+|-+(?=$|[^\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function actionMatches(value) {
  const matches = [];
  for (const [priority, rule] of ACTION_RULES.entries()) {
    rule.pattern.lastIndex = 0;
    for (const match of String(value || '').matchAll(rule.pattern)) {
      matches.push({
        family: rule.family,
        anchor: normalizeEventTitle(match[0]),
        index: match.index,
        end: match.index + match[0].length,
        priority,
      });
    }
  }
  return matches.sort((left, right) => (left.index - right.index)
    || (left.priority - right.priority)
    || left.anchor.localeCompare(right.anchor));
}

function eventEntityTokens(value) {
  const normalized = normalizeEventTitle(value);
  const tokens = normalized.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  return tokens.filter(token => {
    if (GENERIC_ENTITY_TOKENS.has(token) || /^\d+$/.test(token)) return false;
    if ([...token].length < 2) return false;
    return actionMatches(token).every(match => match.anchor !== token);
  });
}

function primaryEntityAnchor(value) {
  const normalized = normalizeEventTitle(value);
  if (!normalized) return '';
  const action = actionMatches(normalized)[0];
  if (!action) return eventEntityTokens(normalized)[0] || '';
  const before = normalized.slice(0, action.index).trim();
  const after = normalized.slice(action.end).trim();
  const passive = /^(?:by\b|由)/u.test(after);
  const preferred = passive ? eventEntityTokens(before).at(-1) : eventEntityTokens(after)[0];
  return preferred || eventEntityTokens(before).at(-1) || '';
}

function normalizeEventFeatures({
  entryId = '',
  title = '',
  titleZh = '',
  summary = '',
  sourceLabels = [],
  link = '',
  canonicalUrl = '',
  effectivePublishedAt = 0,
} = {}) {
  const normalizedTitles = [...new Set([title, titleZh]
    .map(normalizeEventTitle)
    .filter(Boolean))];
  const normalizedSummary = normalizeEventTitle(summary);
  const normalizedLabels = (Array.isArray(sourceLabels) ? sourceLabels : [])
    .map(normalizeEventTitle)
    .filter(Boolean);
  const titleActionMatches = normalizedTitles.flatMap(actionMatches);
  const fallbackActionMatches = [normalizedSummary, ...normalizedLabels].flatMap(actionMatches);
  const selectedActions = titleActionMatches.length ? titleActionMatches : fallbackActionMatches;
  const actionFamily = selectedActions[0] ? selectedActions[0].family : null;
  const actionAnchors = [...new Set([...titleActionMatches, ...fallbackActionMatches]
    .map(match => match.anchor)
    .filter(Boolean))].sort();
  const entityAnchors = [...new Set([
    ...normalizedTitles,
    normalizedSummary,
    ...normalizedLabels,
  ].flatMap(eventEntityTokens))].sort();
  let primaryEntityAnchors = [...new Set(normalizedTitles
    .map(primaryEntityAnchor)
    .filter(Boolean))].sort();
  if (!primaryEntityAnchors.length && normalizedSummary) {
    primaryEntityAnchors = [primaryEntityAnchor(normalizedSummary)].filter(Boolean);
  }
  if (!primaryEntityAnchors.length) {
    primaryEntityAnchors = [...new Set(normalizedLabels
      .map(primaryEntityAnchor)
      .filter(Boolean))].sort();
  }

  return {
    entryId: String(entryId || ''),
    versions: {
      actionAnchors: ACTION_ANCHOR_VERSION,
      entityAnchors: ENTITY_ANCHOR_VERSION,
      titleNormalization: TITLE_NORMALIZATION_VERSION,
      urlCanonicalization: URL_CANONICALIZATION_VERSION,
    },
    canonicalUrl: canonicalizeEvidenceUrl(canonicalUrl || link),
    normalizedTitles,
    entityAnchors,
    primaryEntityAnchors,
    actionAnchors,
    actionFamily,
    effectivePublishedAt: Number(effectivePublishedAt) || 0,
  };
}

function titleTokens(value) {
  const tokens = normalizeEventTitle(value).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  const normalized = [];
  for (const token of tokens) {
    if (/^\p{Script=Han}+$/u.test(token) && [...token].length > 1) {
      const characters = [...token];
      for (let index = 0; index < characters.length - 1; index += 1) {
        normalized.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      normalized.push(token);
    }
  }
  return new Set(normalized);
}

function titleTrigrams(value) {
  const normalized = normalizeEventTitle(value);
  if (!normalized) return new Set();
  if ([...normalized].length < 3) return new Set([normalized]);
  const characters = [...normalized];
  const trigrams = new Set();
  for (let index = 0; index < characters.length - 2; index += 1) {
    trigrams.add(characters.slice(index, index + 3).join(''));
  }
  return trigrams;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function bestTitleSimilarity(leftTitles, rightTitles) {
  let best = {
    score: 0,
    titleTokenJaccard: 0,
    titleTrigramDice: 0,
  };
  for (const left of leftTitles) {
    for (const right of rightTitles) {
      const titleTokenJaccard = jaccard(titleTokens(left), titleTokens(right));
      const titleTrigramDice = dice(titleTrigrams(left), titleTrigrams(right));
      const score = Math.max(titleTokenJaccard, titleTrigramDice);
      if (score > best.score) {
        best = { score, titleTokenJaccard, titleTrigramDice };
      }
    }
  }
  return best;
}

function eventMergeDecision(left, right) {
  const thresholds = {
    titleSimilarity: TITLE_SIMILARITY_THRESHOLD,
    timeWindowHours: EVENT_MERGE_WINDOW_MS / HOUR_MS,
  };
  if (left.canonicalUrl && left.canonicalUrl === right.canonicalUrl) {
    return {
      merge: true,
      reason: 'canonical-url',
      canonicalUrl: left.canonicalUrl,
      thresholds,
    };
  }

  const sharedEntityAnchors = left.primaryEntityAnchors
    .filter(anchor => right.primaryEntityAnchors.includes(anchor))
    .sort();
  const actionCompatible = Boolean(left.actionFamily)
    && left.actionFamily === right.actionFamily;
  const timeDeltaMs = Math.abs(left.effectivePublishedAt - right.effectivePublishedAt);
  const similarity = bestTitleSimilarity(left.normalizedTitles, right.normalizedTitles);
  const merge = sharedEntityAnchors.length > 0
    && actionCompatible
    && timeDeltaMs <= EVENT_MERGE_WINDOW_MS
    && similarity.score >= TITLE_SIMILARITY_THRESHOLD;
  let failure = null;
  if (!sharedEntityAnchors.length) failure = 'entity-anchor';
  else if (!actionCompatible) failure = 'action-anchor';
  else if (timeDeltaMs > EVENT_MERGE_WINDOW_MS) failure = 'time-window';
  else if (similarity.score < TITLE_SIMILARITY_THRESHOLD) failure = 'title-similarity';

  return {
    merge,
    reason: merge ? 'semantic' : failure,
    sharedEntityAnchors,
    actionFamily: actionCompatible ? left.actionFamily : null,
    timeDeltaHours: timeDeltaMs / HOUR_MS,
    titleSimilarity: similarity.score,
    titleTokenJaccard: similarity.titleTokenJaccard,
    titleTrigramDice: similarity.titleTrigramDice,
    thresholds,
  };
}

function plainTextExcerpt(...values) {
  const value = values.find(item => String(item || '').trim()) || '';
  const text = String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= 280 ? text : `${text.slice(0, 279).trimEnd()}…`;
}

function boundedFallbackTitle(value) {
  const title = String(value || '(无标题)').replace(/\s+/g, ' ').trim() || '(无标题)';
  return Array.from(title).slice(0, 160).join('');
}

function boundedFallbackSummary(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^。！？.!?]+(?:[。！？.!?]+|$)/gu) || [];
  const summary = (sentences.slice(0, 3).join('').trim() || text);
  return Array.from(summary).slice(0, 600).join('');
}

function fallbackThemeKey(source) {
  const labels = new Set(normalizedLabels(source.labels));
  if (labels.has('研究')) return 'research_models';
  if (labels.has('产品') || labels.has('官方')) return 'products_tools';
  if (labels.has('产业')) return 'industry_business';
  if (labels.has('社区')) return 'community_practice';
  if (labels.has('创作') || labels.has('上游来源')) return 'creation_methods';
  if (source.category === 'news') return 'industry_business';
  if (source.category === 'podcast') return 'community_practice';
  return 'engineering_open_source';
}

function candidateEvidence({ candidate, source, now, eventId }) {
  const publishedAt = Number(candidate.publishedTs) || 0;
  const createdAt = Number(candidate.createdAt) || 0;
  const timestampFallback = publishedAt > now + FUTURE_TIMESTAMP_TOLERANCE_MS;
  const effectivePublishedAt = publishedAt > 0 && !timestampFallback ? publishedAt : createdAt;
  const summaryExcerpt = plainTextExcerpt(
    candidate.summaryZh,
    candidate.summary,
    candidate.content,
  );
  return {
    eventId,
    entryId: String(candidate.id || ''),
    sourceId: source.id,
    sourceName: String(source.name || source.id),
    sourceLabels: normalizedLabels(source.labels),
    editorialPriority: normalizedPriority(source.editorialPriority),
    entryTitle: String(candidate.title || '(无标题)'),
    entryTitleZh: candidate.titleZh ? String(candidate.titleZh) : null,
    entryLink: String(candidate.link || ''),
    canonicalUrl: canonicalizeEvidenceUrl(candidate.link),
    summaryExcerpt,
    contentHash: String(candidate.contentHash || computeCanonicalHash({
      title: candidate.title || '',
      summary: candidate.summary || '',
      content: candidate.content || '',
    })),
    effectivePublishedAt,
    timestampFallback,
    isPrimary: true,
    displayOrder: 0,
  };
}

function eventSummary(candidate, evidence) {
  if (evidence.summaryExcerpt) return evidence.summaryExcerpt;
  const title = plainTextExcerpt(candidate.titleZh, candidate.title) || '无标题';
  return plainTextExcerpt(`原始条目“${title}”未提供可用摘要。`);
}

function candidateInputSnapshot({ source, evidence }) {
  return {
    source: {
      id: evidence.sourceId,
      name: evidence.sourceName,
      category: String(source.category || ''),
    },
    entry: {
      title: evidence.entryTitle,
      titleZh: evidence.entryTitleZh,
      link: evidence.entryLink,
      canonicalUrl: evidence.canonicalUrl,
      summaryExcerpt: evidence.summaryExcerpt,
      contentHash: evidence.contentHash,
      timestampFallback: evidence.timestampFallback,
    },
  };
}

function candidateInputContentHash(input) {
  return computeCanonicalHash(candidateInputSnapshot(input));
}

function legacyCandidateInputContentHash(input) {
  return computeCanonicalHash({
    version: CANDIDATE_SNAPSHOT_VERSION,
    urlCanonicalizationVersion: URL_CANONICALIZATION_VERSION,
    ...candidateInputSnapshot(input),
  });
}

function independentEvidenceCount(evidence) {
  const parent = evidence.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < evidence.length; left += 1) {
    for (let right = left + 1; right < evidence.length; right += 1) {
      const sameSource = evidence[left].sourceId === evidence[right].sourceId;
      const sameCanonicalUrl = evidence[left].canonicalUrl
        && evidence[left].canonicalUrl === evidence[right].canonicalUrl;
      if (sameSource || sameCanonicalUrl) union(left, right);
    }
  }
  return new Set(evidence.map((_, index) => find(index))).size;
}

function primaryCandidateOrder(left, right) {
  return (SOURCE_PRIORITY_RANK[right.evidence.editorialPriority]
    - SOURCE_PRIORITY_RANK[left.evidence.editorialPriority])
    || (right.evidence.effectivePublishedAt - left.evidence.effectivePublishedAt)
    || left.evidence.entryId.localeCompare(right.evidence.entryId);
}

function normalizedFrozenDailyHistory(history, currentPeriodKey) {
  const byPeriod = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    const periodKey = String(item && item.periodKey || '');
    if (!validPeriodKey('daily', periodKey)
      || periodKey >= currentPeriodKey
      || (item.status && item.status !== 'frozen')
      || byPeriod.has(periodKey)) continue;
    const topics = new Map();
    for (const topic of Array.isArray(item.topics) ? item.topics : []) {
      const topicKey = String(topic && topic.topicKey || '');
      const independentSourceCount = Math.max(0, Math.floor(Number(
        topic && topic.independentSourceCount,
      ) || 0));
      if (!topicKey) continue;
      topics.set(topicKey, Math.max(topics.get(topicKey) || 0, independentSourceCount));
    }
    byPeriod.set(periodKey, {
      periodKey,
      contentHash: String(item.contentHash || ''),
      topics: [...topics.entries()]
        .map(([topicKey, independentSourceCount]) => ({ topicKey, independentSourceCount }))
        .sort((left, right) => left.topicKey.localeCompare(right.topicKey)),
    });
  }
  return [...byPeriod.values()]
    .sort((left, right) => right.periodKey.localeCompare(left.periodKey))
    .slice(0, SCORE_CONFIG.persistence.lookbackFrozenDailyIssues);
}

function topicHistoryScore(topicKey, history) {
  if (!topicKey) return { daysPresent: 0, baselineSourceCount: 0 };
  const dailyCounts = history
    .map(day => day.topics.find(topic => topic.topicKey === topicKey)?.independentSourceCount || 0)
    .filter(count => count > 0);
  return {
    daysPresent: dailyCounts.length,
    baselineSourceCount: dailyCounts.length ? Math.max(...dailyCounts) : 0,
  };
}

function scoringHistoryIdentity(frozenDailyHistory) {
  return computeCanonicalHash({
    version: SCORING_HISTORY_VERSION,
    frozenDailyHistory,
  });
}

function sourceInputIdentity({
  periodKey,
  candidates,
  sources,
  behaviorSignalEnabled = false,
}) {
  return computeCanonicalHash({
    cadence: 'daily',
    periodKey,
    candidates,
    sources,
    behavior: { enabled: Boolean(behaviorSignalEnabled) },
  });
}

function legacySourceInputIdentity({ periodKey, candidates, sources }) {
  return computeCanonicalHash({
    canonicalizationVersion: CANONICALIZATION_VERSION,
    cadence: 'daily',
    periodKey,
    candidates,
    sources,
    behavior: 'behavior-disabled',
  });
}

function fullInputIdentity({
  sourceInputHash,
  asOfAt,
  scoringHistoryHash = scoringHistoryIdentity([]),
  scoreConfig = SCORE_CONFIG,
}) {
  return computeCanonicalHash({
    sourceInputHash,
    asOfAt,
    scoringHistoryHash,
    inputIdentityVersion: INPUT_IDENTITY_VERSION,
    ...selectionAlgorithmContext(scoreConfig),
    selectionVersion: SELECTION_VERSION,
    summaryVersion: SUMMARY_VERSION,
  });
}

function legacyFullInputIdentity({ sourceInputHash, asOfAt }) {
  return computeCanonicalHash({
    sourceInputHash,
    asOfAt,
    selectionVersion: SELECTION_VERSION,
    scoreConfig: LEGACY_SCORE_CONFIG,
    summaryVersion: LEGACY_SUMMARY_VERSION,
  });
}

function eventScore(
  source,
  effectivePublishedAt,
  now,
  independentSourceCount = 1,
  topicHistory = { daysPresent: 0, baselineSourceCount: 0 },
  scoreConfig = SCORE_CONFIG,
) {
  const priority = normalizedPriority(source.editorialPriority);
  const exactAgeHours = Math.max(0, now - effectivePublishedAt) / HOUR_MS;
  const ageHours = roundOne(exactAgeHours);
  const freshnessPoints = roundOne(scoreConfig.freshness.maxPoints
    * (2 ** (-exactAgeHours / scoreConfig.freshness.halfLifeHours)));
  const daysPresent = Math.max(0, Number(topicHistory.daysPresent) || 0);
  const baselineSourceCount = Math.max(0, Number(topicHistory.baselineSourceCount) || 0);
  const sourceIncrease = baselineSourceCount > 0
    ? Math.max(0, independentSourceCount - baselineSourceCount)
    : 0;
  return {
    version: SELECTION_VERSION,
    sourceQuality: { priority, points: scoreConfig.sourceQuality[priority] },
    confirmation: {
      independentSourceCount,
      points: Math.min(
        scoreConfig.confirmation.maxPoints,
        scoreConfig.confirmation.pointsPerAdditionalSource
          * Math.max(0, independentSourceCount - 1),
      ),
    },
    persistence: {
      daysPresent,
      points: Math.min(
        scoreConfig.persistence.maxPoints,
        scoreConfig.persistence.pointsPerDay * daysPresent,
      ),
    },
    trend: {
      baselineSourceCount,
      sourceIncrease,
      points: baselineSourceCount > 0
        ? Math.min(
            scoreConfig.trend.maxPoints,
            scoreConfig.trend.pointsPerAdditionalSource * sourceIncrease,
          )
        : 0,
    },
    freshness: {
      ageHours,
      halfLifeHours: scoreConfig.freshness.halfLifeHours,
      points: freshnessPoints,
    },
    behavior: {
      enabled: scoreConfig.behavior.enabled,
      starredCount: 0,
      viewCount: 0,
      points: 0,
    },
  };
}

function whySelected(score) {
  const reasons = [];
  if (score.sourceQuality.points > 0) {
    const label = { high: '高', normal: '普通', low: '低' }[score.sourceQuality.priority];
    reasons.push(`来源质量（${label}）计 ${score.sourceQuality.points} 分`);
  }
  if (score.confirmation.points > 0) {
    reasons.push(`获得 ${score.confirmation.independentSourceCount} 个独立来源确认（${score.confirmation.points} 分）`);
  }
  if (score.persistence.points > 0) {
    reasons.push(`相关主题过去 ${SCORE_CONFIG.persistence.lookbackFrozenDailyIssues} 个冻结日报出现 ${score.persistence.daysPresent} 天（${score.persistence.points} 分）`);
  }
  if (score.trend.points > 0) {
    reasons.push(`独立来源较近 ${SCORE_CONFIG.trend.lookbackFrozenDailyIssues} 日单日峰值增加 ${score.trend.sourceIncrease} 个（${score.trend.points} 分）`);
  }
  if (score.freshness.points > 0) reasons.push(`时效性计 ${score.freshness.points} 分`);
  return `${reasons.join('；')}。`;
}

function selectionAlgorithmContext(scoreConfig = SCORE_CONFIG) {
  return {
    canonicalizationVersion: CANONICALIZATION_VERSION,
    candidateSnapshotVersion: CANDIDATE_SNAPSHOT_VERSION,
    urlCanonicalizationVersion: URL_CANONICALIZATION_VERSION,
    titleNormalizationVersion: TITLE_NORMALIZATION_VERSION,
    entityAnchorVersion: ENTITY_ANCHOR_VERSION,
    actionAnchorVersion: ACTION_ANCHOR_VERSION,
    eventIdentityVersion: EVENT_CLUSTER_VERSION,
    topicVersion: TOPIC_VERSION,
    scoringHistoryVersion: SCORING_HISTORY_VERSION,
    scoreConfig,
  };
}

function selectionAlgorithmMatches(value, scoreConfig = SCORE_CONFIG) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    const expected = selectionAlgorithmContext(scoreConfig);
    const actual = Object.fromEntries(Object.keys(expected).map(key => [key, parsed[key]]));
    return canonicalSerialize(actual) === canonicalSerialize(expected);
  } catch {
    return false;
  }
}

function invalidBuild(message) {
  const error = new Error(message);
  error.code = 'ERR_PERIODICAL_BUILD_INVALID';
  return error;
}

function validateCompiledOpenDaily(compiled, { job, issue }) {
  if (!compiled || typeof compiled !== 'object') throw invalidBuild('compiled issue is missing');
  if (!compiled.issue || !Array.isArray(compiled.themes)
    || !Array.isArray(compiled.events) || !Array.isArray(compiled.evidence)) {
    throw invalidBuild('compiled issue is incomplete');
  }
  const document = compiled.issue;
  if (document.id !== issue.id || document.cadence !== 'daily'
    || document.periodKey !== issue.period_key || document.status !== 'open') {
    throw invalidBuild('compiled issue identity is invalid');
  }
  if (document.sourceInputHash !== job.sourceInputHash
    || document.inputHash !== job.inputHash
    || document.selectionVersion !== job.selectionVersion
    || document.summaryVersion !== job.summaryVersion) {
    throw invalidBuild('compiled input identity is invalid');
  }
  if (document.revision !== Number(issue.revision) + 1
    || document.volumeNo !== Number(issue.volume_no)) {
    throw invalidBuild('compiled revision identity is invalid');
  }

  const themeIds = new Set();
  for (const theme of compiled.themes) {
    if (!theme || !theme.id || themeIds.has(theme.id)) throw invalidBuild('compiled themes are invalid');
    themeIds.add(theme.id);
  }
  const eventIds = new Set();
  for (const event of compiled.events) {
    if (!event || !event.id || eventIds.has(event.id) || !themeIds.has(event.themeId)) {
      throw invalidBuild('compiled events are invalid');
    }
    eventIds.add(event.id);
  }
  const evidenceIds = new Set();
  for (const evidence of compiled.evidence) {
    const identity = `${evidence && evidence.eventId}\u0000${evidence && evidence.entryId}`;
    if (!evidence || !eventIds.has(evidence.eventId) || !evidence.entryId
      || evidenceIds.has(identity)) {
      throw invalidBuild('compiled evidence is invalid');
    }
    evidenceIds.add(identity);
  }
  const expectedContentHash = computePeriodicalContentHash(compiled);
  if (document.contentHash !== expectedContentHash) {
    throw invalidBuild('compiled content hash is invalid');
  }
  return compiled;
}

function compileOpenDaily({
  now,
  sources = [],
  candidates = [],
  frozenDailyHistory = [],
  revision = 1,
  volumeNo = 1,
  coverageStartedAt,
  behaviorSignalEnabled = false,
} = {}) {
  const timestamp = Number(now);
  const scoreConfig = scoreConfigFor(behaviorSignalEnabled);
  const period = shanghaiDailyPeriod(timestamp);
  const issueId = `periodical:daily:${period.periodKey}`;
  const history = normalizedFrozenDailyHistory(frozenDailyHistory, period.periodKey);
  const sourceMap = new Map(sources
    .filter(eligibleSource)
    .map(source => [String(source.id || ''), {
      ...source,
      id: String(source.id || ''),
      labels: normalizedLabels(source.labels),
      editorialPriority: normalizedPriority(source.editorialPriority),
    }])
    .filter(([sourceId]) => sourceId));

  const compiledCandidates = [];
  for (const candidate of candidates) {
    const source = sourceMap.get(String(candidate && candidate.sourceId || ''));
    if (!source || !candidate || !candidate.id || candidate.deletedAt) continue;
    const evidence = candidateEvidence({ candidate, source, now: timestamp, eventId: '' });
    if (Number(candidate.createdAt) > timestamp
      || evidence.effectivePublishedAt < period.periodStartAt
      || evidence.effectivePublishedAt >= period.periodEndAt) continue;
    compiledCandidates.push({
      candidate,
      source,
      evidence,
      features: normalizeEventFeatures({
        entryId: evidence.entryId,
        title: evidence.entryTitle,
        titleZh: evidence.entryTitleZh,
        summary: [candidate.summaryZh, candidate.summary].filter(Boolean).join(' '),
        sourceLabels: evidence.sourceLabels,
        canonicalUrl: evidence.canonicalUrl,
        effectivePublishedAt: evidence.effectivePublishedAt,
      }),
      inputContentHash: candidateInputContentHash({ source, evidence }),
    });
  }

  const canonicalGroups = new Map();
  for (const item of [...compiledCandidates]
    .sort((left, right) => left.evidence.entryId.localeCompare(right.evidence.entryId))) {
    const groupKey = item.evidence.canonicalUrl
      ? `url:${item.evidence.canonicalUrl}`
      : `entry:${item.evidence.entryId}`;
    const group = canonicalGroups.get(groupKey) || [];
    group.push(item);
    canonicalGroups.set(groupKey, group);
  }
  const eventClusters = [];
  const canonicalSeeds = [...canonicalGroups.values()]
    .sort((left, right) => left[0].evidence.entryId.localeCompare(right[0].evidence.entryId));
  for (const seed of canonicalSeeds) {
    const destination = eventClusters.find(cluster => seed.every(candidate => cluster.every(existing => (
      eventMergeDecision(candidate.features, existing.features).merge
    ))));
    if (destination) destination.push(...seed);
    else eventClusters.push([...seed]);
  }

  const clusteredCandidates = eventClusters.map(group => {
    const entryIds = group.map(item => item.evidence.entryId).sort();
    const eventKey = computeCanonicalHash({
      version: EVENT_CLUSTER_VERSION,
      entryIds,
    });
    const eventId = `${issueId}:event:${eventKey}`;
    const ordered = [...group].sort(primaryCandidateOrder);
    const primary = ordered[0];
    const evidence = ordered.map((item, displayOrder) => ({
      ...item.evidence,
      eventId,
      isPrimary: displayOrder === 0,
      displayOrder,
    }));
    const independentSourceCount = independentEvidenceCount(evidence);
    const effectiveAt = Math.max(...evidence.map(item => item.effectivePublishedAt));
    const commonPrimaryEntityAnchors = group.slice(1).reduce(
      (anchors, item) => anchors.filter(anchor => item.features.primaryEntityAnchors.includes(anchor)),
      [...group[0].features.primaryEntityAnchors],
    ).sort();
    const actionFamilies = new Set(group.map(item => item.features.actionFamily).filter(Boolean));
    const actionFamily = actionFamilies.size === 1 ? [...actionFamilies][0] : null;
    const topicKey = commonPrimaryEntityAnchors.length && actionFamily
      ? computeCanonicalHash({
          version: TOPIC_VERSION,
          primaryEntityAnchors: commonPrimaryEntityAnchors,
          actionFamily,
        })
      : null;
    const score = eventScore(
      primary.source,
      effectiveAt,
      timestamp,
      independentSourceCount,
      topicHistoryScore(topicKey, history),
      scoreConfig,
    );
    const importanceScore = roundOne(Object.values(score)
      .filter(component => component && typeof component === 'object' && 'points' in component)
      .reduce((total, component) => total + component.points, 0));
    const byEntryId = new Map(group.map(item => [item.evidence.entryId, item]));
    const mergeReasons = [];
    for (let left = 0; left < entryIds.length; left += 1) {
      for (let right = left + 1; right < entryIds.length; right += 1) {
        const decision = eventMergeDecision(
          byEntryId.get(entryIds[left]).features,
          byEntryId.get(entryIds[right]).features,
        );
        if (decision.reason === 'canonical-url') {
          mergeReasons.push({
            entryIds: [entryIds[left], entryIds[right]],
            reason: decision.reason,
            canonicalUrl: decision.canonicalUrl,
          });
        } else {
          mergeReasons.push({
            entryIds: [entryIds[left], entryIds[right]],
            reason: decision.reason,
            sharedEntityAnchors: decision.sharedEntityAnchors,
            actionFamily: decision.actionFamily,
            timeDeltaHours: decision.timeDeltaHours,
            titleSimilarity: decision.titleSimilarity,
            titleTokenJaccard: decision.titleTokenJaccard,
            titleTrigramDice: decision.titleTrigramDice,
            thresholds: decision.thresholds,
          });
        }
      }
    }
    const mergeReasonKinds = new Set(mergeReasons.map(reason => reason.reason));
    const clusterReason = group.length === 1
      ? 'single-candidate'
      : mergeReasonKinds.size === 1 && mergeReasonKinds.has('canonical-url')
        ? 'canonical-url'
        : mergeReasonKinds.size === 1 && mergeReasonKinds.has('semantic')
          ? 'complete-link'
          : 'mixed';
    return {
      evidence,
      event: {
        id: eventId,
        themeId: '',
        eventKey,
        topicKey,
        title: boundedFallbackTitle(primary.candidate.titleZh || primary.candidate.title),
        summary: boundedFallbackSummary(eventSummary(primary.candidate, primary.evidence)),
        summaryEvidenceIds: [primary.evidence.entryId],
        whySelected: whySelected(score),
        effectiveAt,
        firstSeenAt: Math.min(...evidence.map(item => item.effectivePublishedAt)),
        lastSeenAt: effectiveAt,
        importanceScore,
        score,
        cluster: {
          version: EVENT_CLUSTER_VERSION,
          topicVersion: TOPIC_VERSION,
          primaryEntityAnchors: commonPrimaryEntityAnchors,
          actionFamily,
          reason: clusterReason,
          entryIds,
          mergeReasons,
        },
        displayOrder: 0,
      },
      themeKey: fallbackThemeKey(primary.source),
    };
  });

  const selected = clusteredCandidates
    .filter(item => item.event.importanceScore >= scoreConfig.threshold)
    .sort((left, right) => (right.event.importanceScore - left.event.importanceScore)
      || (right.event.score.confirmation.independentSourceCount
        - left.event.score.confirmation.independentSourceCount)
      || (SOURCE_PRIORITY_RANK[right.event.score.sourceQuality.priority]
        - SOURCE_PRIORITY_RANK[left.event.score.sourceQuality.priority])
      || (right.event.effectiveAt - left.event.effectiveAt)
      || left.event.eventKey.localeCompare(right.event.eventKey))
    .slice(0, scoreConfig.maxEvents);

  const themes = [];
  const themeMap = new Map();
  selected.forEach((item, displayOrder) => {
    item.event.displayOrder = displayOrder;
    if (!themeMap.has(item.themeKey)) {
      const theme = {
        id: `${issueId}:theme:${item.themeKey}`,
        themeKey: item.themeKey,
        title: THEME_DEFINITIONS[item.themeKey],
        trendNote: '',
        displayOrder: themes.length,
      };
      themes.push(theme);
      themeMap.set(item.themeKey, theme);
    }
    item.event.themeId = themeMap.get(item.themeKey).id;
  });
  for (const theme of themes) {
    const count = selected.filter(item => item.event.themeId === theme.id).length;
    theme.trendNote = `本期该主题收录 ${count} 个事件。`;
  }

  const events = selected.map(item => item.event);
  const evidence = selected.flatMap(item => item.evidence);
  const normalizedCoverageStartedAt = Number.isFinite(Number(coverageStartedAt))
    ? Number(coverageStartedAt)
    : timestamp;
  const overviewSummary = events.length
    ? `本期从 SQLite 候选中选出 ${events.length} 个达到 40 分门槛的事件，分布于 ${themes.length} 个主题。所有事件均按来源质量与时效性确定性排序，并保留原始证据快照。`
    : '本期没有事件达到 40 分入选门槛。开放日报仍保留完整的构建身份，等待符合条件的 SQLite 候选。';
  const overview = `${overviewSummary} 精选规则于 ${shanghaiDateTime(normalizedCoverageStartedAt)}（Asia/Shanghai）启用。`;
  const eligibleCandidates = compiledCandidates
    .map(item => ({
      entryId: item.evidence.entryId,
      contentHash: item.inputContentHash,
      effectivePublishedAt: item.evidence.effectivePublishedAt,
    }))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
  const sourceSnapshot = [...sourceMap.values()]
    .map(source => ({
      sourceId: source.id,
      enabled: true,
      editorialPriority: source.editorialPriority,
      labels: source.labels,
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sourceInputHash = sourceInputIdentity({
    periodKey: period.periodKey,
    candidates: eligibleCandidates,
    sources: sourceSnapshot,
    behaviorSignalEnabled,
  });
  const selectionContext = {
    ...selectionAlgorithmContext(scoreConfig),
    candidateCount: eligibleCandidates.length,
    eligibleSourceCount: sourceSnapshot.length,
    frozenDailyHistory: history,
  };
  const inputHash = fullInputIdentity({
    sourceInputHash,
    asOfAt: timestamp,
    scoringHistoryHash: scoringHistoryIdentity(history),
    scoreConfig,
  });
  const issue = {
    id: issueId,
    cadence: 'daily',
    periodKey: period.periodKey,
    volumeNo,
    timezone: 'Asia/Shanghai',
    periodStartAt: period.periodStartAt,
    periodEndAt: period.periodEndAt,
    coverageStartedAt: normalizedCoverageStartedAt,
    status: 'open',
    revision,
    overview,
    selectionVersion: SELECTION_VERSION,
    summaryVersion: SUMMARY_VERSION,
    sourceInputHash,
    selectionContext,
    inputHash,
    contentHash: '',
    summaryStatus: 'fallback',
    provider: null,
    model: null,
    lastBuiltAt: timestamp,
    frozenAt: null,
  };
  issue.contentHash = computePeriodicalContentHash({ issue, themes, events, evidence });

  return { issue, themes, events, evidence };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function configuredSourcesFromSqlite(db) {
  const customSources = db.prepare(`
    SELECT id, name, feed_url, site_url, category, description, labels_json
    FROM custom_sources
    WHERE archived_at IS NULL AND TRIM(feed_url) <> ''
    ORDER BY id
  `).all().map((row, index) => ({
    id: row.id,
    name: row.name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url || '',
    category: row.category,
    description: row.description || '',
    labels: safeJsonArray(row.labels_json),
    enabled: true,
    manual: false,
    editorialPriority: 'normal',
    displayOrder: SOURCES.length + index,
    isCustom: true,
  }));
  const preferences = db.prepare(`
    SELECT source_id, enabled, editorial_priority, display_order
    FROM source_preferences
    ORDER BY source_id
  `).all().map(row => ({
    sourceId: row.source_id,
    enabled: Boolean(row.enabled),
    editorialPriority: row.editorial_priority,
    displayOrder: Number(row.display_order) || 0,
  }));
  return mergeSourcesWithPreferences([...SOURCES, ...customSources], preferences);
}

function candidatesFromSqlite(db, sources, now, requestedPeriod = null) {
  const sourceIds = sources.filter(eligibleSource).map(source => source.id);
  if (!sourceIds.length) return [];
  const period = requestedPeriod || shanghaiDailyPeriod(now);
  const placeholders = sourceIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT
      entry.id,
      entry.source_id,
      entry.title,
      translation.title_zh,
      entry.link,
      entry.published_ts,
      entry.summary,
      translation.summary_zh,
      entry.content,
      entry.content_hash,
      entry.created_at,
      entry.deleted_at
    FROM entries AS entry
    LEFT JOIN entry_translations AS translation ON translation.entry_id = entry.id
    WHERE entry.source_id IN (${placeholders})
      AND COALESCE(entry.deleted_at, 0) = 0
      AND entry.created_at <= ?
      AND CASE
        WHEN entry.published_ts > 0 AND entry.published_ts <= ?
          THEN entry.published_ts
        ELSE entry.created_at
      END >= ?
      AND CASE
        WHEN entry.published_ts > 0 AND entry.published_ts <= ?
          THEN entry.published_ts
        ELSE entry.created_at
      END < ?
    ORDER BY entry.id
  `).all(
    ...sourceIds,
    now,
    now + FUTURE_TIMESTAMP_TOLERANCE_MS,
    period.periodStartAt,
    now + FUTURE_TIMESTAMP_TOLERANCE_MS,
    period.periodEndAt,
  ).map(row => ({
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    titleZh: row.title_zh || null,
    link: row.link || '',
    publishedTs: Number(row.published_ts) || 0,
    summary: row.summary || '',
    summaryZh: row.summary_zh || '',
    content: row.content || '',
    contentHash: row.content_hash || '',
    createdAt: Number(row.created_at) || 0,
    deletedAt: Number(row.deleted_at) || null,
  }));
}

function frozenDailyHistoryFromSqlite(db, currentPeriodKey) {
  const issues = db.prepare(`
    SELECT id, period_key, content_hash
    FROM periodical_issues
    WHERE cadence = 'daily'
      AND status = 'frozen'
      AND period_key < ?
    ORDER BY period_key DESC
    LIMIT ?
  `).all(currentPeriodKey, SCORE_CONFIG.persistence.lookbackFrozenDailyIssues);
  const topicEvidence = db.prepare(`
    SELECT
      event.topic_key,
      evidence.entry_id,
      evidence.source_id,
      evidence.canonical_url
    FROM periodical_events AS event
    INNER JOIN periodical_event_evidence AS evidence ON evidence.event_id = event.id
    WHERE event.issue_id = ? AND event.topic_key IS NOT NULL
    ORDER BY event.topic_key, event.display_order, evidence.display_order
  `);
  return issues.map(issue => {
    const byTopic = new Map();
    for (const row of topicEvidence.all(issue.id)) {
      const evidence = byTopic.get(row.topic_key) || [];
      evidence.push({
        entryId: row.entry_id,
        sourceId: row.source_id,
        canonicalUrl: row.canonical_url || '',
      });
      byTopic.set(row.topic_key, evidence);
    }
    return {
      periodKey: issue.period_key,
      status: 'frozen',
      contentHash: issue.content_hash,
      topics: [...byTopic.entries()]
        .map(([topicKey, evidence]) => ({
          topicKey,
          independentSourceCount: independentEvidenceCount(evidence),
        }))
        .sort((left, right) => left.topicKey.localeCompare(right.topicKey)),
    };
  });
}

function snapshotOpenDailyInput({
  db,
  now,
  periodKey = '',
  behaviorSignalEnabled = false,
}) {
  const timestamp = Number(now);
  const period = periodKey
    ? shanghaiDailyPeriodFromKey(periodKey)
    : shanghaiDailyPeriod(timestamp);
  const frozenDailyHistory = normalizedFrozenDailyHistory(
    frozenDailyHistoryFromSqlite(db, period.periodKey),
    period.periodKey,
  );
  const sources = configuredSourcesFromSqlite(db);
  const candidates = candidatesFromSqlite(db, sources, timestamp, period);
  const sourceMap = new Map(sources
    .filter(eligibleSource)
    .map(source => [String(source.id || ''), source])
    .filter(([sourceId]) => sourceId));
  const candidateSnapshot = [];
  const legacyCandidateSnapshot = [];
  for (const candidate of candidates) {
    const source = sourceMap.get(String(candidate && candidate.sourceId || ''));
    if (!source || !candidate || !candidate.id || candidate.deletedAt) continue;
    const evidence = candidateEvidence({ candidate, source, now: timestamp, eventId: '' });
    if (Number(candidate.createdAt) > timestamp
      || evidence.effectivePublishedAt < period.periodStartAt
      || evidence.effectivePublishedAt >= period.periodEndAt) continue;
    const input = { source, evidence };
    const identity = {
      entryId: evidence.entryId,
      effectivePublishedAt: evidence.effectivePublishedAt,
    };
    candidateSnapshot.push({
      ...identity,
      contentHash: candidateInputContentHash(input),
    });
    legacyCandidateSnapshot.push({
      ...identity,
      contentHash: legacyCandidateInputContentHash(input),
    });
  }
  candidateSnapshot.sort((left, right) => left.entryId.localeCompare(right.entryId));
  legacyCandidateSnapshot.sort((left, right) => left.entryId.localeCompare(right.entryId));
  const sourceSnapshot = [...sourceMap.values()]
    .map(source => ({
      sourceId: String(source.id),
      enabled: true,
      editorialPriority: normalizedPriority(source.editorialPriority),
      labels: normalizedLabels(source.labels),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sourceInputHash = sourceInputIdentity({
    periodKey: period.periodKey,
    candidates: candidateSnapshot,
    sources: sourceSnapshot,
    behaviorSignalEnabled,
  });
  const legacySourceInputHash = behaviorSignalEnabled
    ? null
    : legacySourceInputIdentity({
      periodKey: period.periodKey,
      candidates: legacyCandidateSnapshot,
      sources: sourceSnapshot,
    });
  return {
    period,
    sources,
    candidates,
    candidateSnapshot,
    sourceSnapshot,
    sourceInputHash,
    legacySourceInputHash,
    frozenDailyHistory,
    scoringHistoryHash: scoringHistoryIdentity(frozenDailyHistory),
    candidateCount: candidateSnapshot.length,
    sourceCount: sourceSnapshot.length,
  };
}

function ensurePeriodicalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS periodical_issues (
      id TEXT PRIMARY KEY,
      cadence TEXT NOT NULL CHECK(cadence IN ('daily', 'weekly', 'monthly')),
      period_key TEXT NOT NULL,
      volume_no INTEGER NOT NULL CHECK(volume_no > 0),
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      period_start_at INTEGER NOT NULL,
      period_end_at INTEGER NOT NULL,
      coverage_started_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('open', 'finalizing', 'frozen')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      overview TEXT NOT NULL DEFAULT '',
      selection_version TEXT NOT NULL,
      summary_version TEXT NOT NULL,
      source_input_hash TEXT NOT NULL DEFAULT '',
      selection_context_json TEXT NOT NULL DEFAULT '{}',
      input_hash TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      summary_status TEXT NOT NULL DEFAULT 'fallback'
        CHECK(summary_status IN ('generated', 'fallback')),
      provider TEXT,
      model TEXT,
      last_built_at INTEGER,
      frozen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(cadence, period_key),
      UNIQUE(cadence, volume_no),
      CHECK(period_start_at < period_end_at)
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_issues_cadence_period
      ON periodical_issues(cadence, period_key DESC);
    CREATE INDEX IF NOT EXISTS idx_periodical_issues_status_end
      ON periodical_issues(status, period_end_at);

    CREATE TABLE IF NOT EXISTS periodical_themes (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      theme_key TEXT NOT NULL,
      title TEXT NOT NULL,
      trend_note TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL CHECK(display_order >= 0),
      UNIQUE(issue_id, display_order),
      FOREIGN KEY(issue_id) REFERENCES periodical_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_themes_issue_order
      ON periodical_themes(issue_id, display_order);

    CREATE TABLE IF NOT EXISTS periodical_events (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      topic_key TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summary_evidence_json TEXT NOT NULL DEFAULT '[]',
      why_selected TEXT NOT NULL DEFAULT '',
      effective_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      importance_score REAL NOT NULL,
      score_json TEXT NOT NULL,
      cluster_json TEXT NOT NULL,
      display_order INTEGER NOT NULL CHECK(display_order >= 0),
      UNIQUE(issue_id, event_key),
      UNIQUE(issue_id, display_order),
      FOREIGN KEY(issue_id) REFERENCES periodical_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(theme_id) REFERENCES periodical_themes(id) ON DELETE CASCADE,
      CHECK(first_seen_at <= last_seen_at)
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_events_issue_order
      ON periodical_events(issue_id, display_order);

    CREATE TABLE IF NOT EXISTS periodical_event_evidence (
      event_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_labels_json TEXT NOT NULL DEFAULT '[]',
      editorial_priority TEXT NOT NULL
        CHECK(editorial_priority IN ('high', 'normal', 'low')),
      entry_title TEXT NOT NULL,
      entry_title_zh TEXT,
      entry_link TEXT,
      canonical_url TEXT,
      summary_excerpt TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      effective_published_at INTEGER NOT NULL,
      timestamp_fallback INTEGER NOT NULL DEFAULT 0 CHECK(timestamp_fallback IN (0, 1)),
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      display_order INTEGER NOT NULL CHECK(display_order >= 0),
      PRIMARY KEY(event_id, entry_id),
      UNIQUE(event_id, display_order),
      FOREIGN KEY(event_id) REFERENCES periodical_events(id) ON DELETE CASCADE,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_evidence_event_order
      ON periodical_event_evidence(event_id, display_order);

    CREATE TABLE IF NOT EXISTS periodical_issue_inputs (
      issue_id TEXT NOT NULL,
      daily_issue_id TEXT NOT NULL,
      daily_content_hash TEXT NOT NULL,
      display_order INTEGER NOT NULL CHECK(display_order >= 0),
      PRIMARY KEY(issue_id, daily_issue_id),
      UNIQUE(issue_id, display_order),
      FOREIGN KEY(issue_id) REFERENCES periodical_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(daily_issue_id) REFERENCES periodical_issues(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_issue_inputs_issue_order
      ON periodical_issue_inputs(issue_id, display_order);
    CREATE INDEX IF NOT EXISTS idx_periodical_issue_inputs_daily
      ON periodical_issue_inputs(daily_issue_id);

    CREATE TABLE IF NOT EXISTS periodical_build_jobs (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      source_input_hash TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      as_of_at INTEGER NOT NULL,
      selection_version TEXT NOT NULL,
      score_config_json TEXT NOT NULL,
      summary_version TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      lease_token TEXT,
      lease_expires_at INTEGER,
      next_retry_at INTEGER,
      provider TEXT,
      model TEXT,
      error_code TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
      source_count INTEGER NOT NULL DEFAULT 0 CHECK(source_count >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(issue_id, input_hash, summary_version),
      FOREIGN KEY(issue_id) REFERENCES periodical_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_periodical_build_jobs_status_wake
      ON periodical_build_jobs(status, next_retry_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_entries_periodical_candidates
      ON entries(
        source_id,
        (CASE WHEN published_ts > 0 THEN published_ts ELSE created_at END) DESC,
        created_at DESC
      );
  `);

  const evidenceColumns = db.prepare('PRAGMA table_info(periodical_event_evidence)').all();
  if (!evidenceColumns.some(column => column.name === 'timestamp_fallback')) {
    db.exec(`
      ALTER TABLE periodical_event_evidence
      ADD COLUMN timestamp_fallback INTEGER NOT NULL DEFAULT 0
        CHECK(timestamp_fallback IN (0, 1));
    `);
  }

  const buildJobColumns = new Set(db.prepare('PRAGMA table_info(periodical_build_jobs)').all()
    .map(column => column.name));
  const additiveBuildJobColumns = [
    ['source_input_hash', "source_input_hash TEXT NOT NULL DEFAULT ''"],
    ['as_of_at', 'as_of_at INTEGER NOT NULL DEFAULT 0'],
    ['selection_version', `selection_version TEXT NOT NULL DEFAULT '${SELECTION_VERSION}'`],
    ['score_config_json', "score_config_json TEXT NOT NULL DEFAULT '{}'"],
    ['candidate_count', 'candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0)'],
    ['source_count', 'source_count INTEGER NOT NULL DEFAULT 0 CHECK(source_count >= 0)'],
  ];
  for (const [name, definition] of additiveBuildJobColumns) {
    if (!buildJobColumns.has(name)) {
      db.exec(`ALTER TABLE periodical_build_jobs ADD COLUMN ${definition}`);
    }
  }
}

const PERIODICAL_CADENCES = new Set(['daily', 'weekly', 'monthly']);

function periodicalsMode(value) {
  const mode = String(value || 'off').trim().toLowerCase();
  return ['off', 'shadow', 'on'].includes(mode) ? mode : 'off';
}

function invalidPeriodicalRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function missingPeriodical() {
  const error = new Error('periodical not found');
  error.statusCode = 404;
  return error;
}

function readPeriodicalData(read) {
  try {
    return read();
  } catch (cause) {
    if (cause && cause.statusCode) throw cause;
    const error = new Error('periodicals unavailable', { cause });
    error.statusCode = 503;
    throw error;
  }
}

function validPeriodKey(cadence, value) {
  const key = String(value || '');
  if (cadence === 'monthly') return /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  if (cadence === 'weekly') {
    const weekMatch = key.match(/^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/);
    if (!weekMatch) return false;
    const year = Number(weekMatch[1]);
    const week = Number(weekMatch[2]);
    const januaryFirst = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return week <= 52 || januaryFirst === 4 || (januaryFirst === 3 && leapYear);
  }
  const match = key.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function periodicalLimit(value) {
  if (value === undefined) return 30;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw invalidPeriodicalRequest('invalid limit');
  const limit = Number(raw);
  if (limit < 1 || limit > 100) throw invalidPeriodicalRequest('invalid limit');
  return limit;
}

function normalizeBuildJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    issueId: row.issue_id,
    sourceInputHash: row.source_input_hash,
    inputHash: row.input_hash,
    asOfAt: Number(row.as_of_at),
    selectionVersion: row.selection_version,
    scoreConfigJson: row.score_config_json,
    summaryVersion: row.summary_version,
    triggerReason: row.trigger_reason,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at),
    provider: row.provider,
    model: row.model,
    errorCode: row.error_code,
    candidateCount: Number(row.candidate_count),
    sourceCount: Number(row.source_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function safeBuildLog(logger, fields) {
  if (typeof logger !== 'function') return;
  const parts = [
    '[periodical-build]',
    `issue=${fields.issueId}`,
    `job=${fields.jobId}`,
    `source=${String(fields.sourceInputHash || '').slice(0, 12)}`,
    `input=${String(fields.inputHash || '').slice(0, 12)}`,
    `revision=${Number(fields.revision) || 0}`,
    `candidates=${Number(fields.candidateCount) || 0}`,
    `events=${Number(fields.eventCount) || 0}`,
    `state=${fields.state}`,
    `durationMs=${Math.max(0, Number(fields.durationMs) || 0)}`,
  ];
  logger(parts.join(' '));
}

function createPeriodicalsModule({
  db,
  mode,
  aiAdapter,
  behaviorSignalEnabled = false,
  logger = console.log,
}) {
  ensurePeriodicalSchema(db);
  const normalizedMode = periodicalsMode(mode);
  const scoreConfig = scoreConfigFor(behaviorSignalEnabled);

  function issueUpdateState(issueId, lastBuiltAt) {
    const latest = db.prepare(`
      SELECT status
      FROM periodical_build_jobs
      WHERE issue_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(issueId);
    const updateState = latest ? latest.status : (lastBuiltAt === null ? 'idle' : 'succeeded');
    return {
      lastSuccessfulAt: lastBuiltAt === null ? null : Number(lastBuiltAt),
      updateDelayed: updateState === 'retry_wait' || updateState === 'failed',
      updateState,
    };
  }

  function listIssues({ cadence, cursor, limit: requestedLimit }) {
    const normalizedCadence = String(cadence || '').trim().toLowerCase();
    if (!PERIODICAL_CADENCES.has(normalizedCadence)) {
      throw invalidPeriodicalRequest('invalid cadence');
    }
    const normalizedCursor = cursor === undefined ? null : String(cursor).trim();
    if (normalizedCursor !== null && !validPeriodKey(normalizedCadence, normalizedCursor)) {
      throw invalidPeriodicalRequest('invalid cursor');
    }
    const limit = periodicalLimit(requestedLimit);
    return readPeriodicalData(() => {
      const rows = db.prepare(`
        SELECT
          issue.id,
          issue.cadence,
          issue.period_key,
          issue.volume_no,
          issue.period_start_at,
          issue.period_end_at,
          issue.coverage_started_at,
          issue.status,
          issue.revision,
          issue.last_built_at,
          issue.content_hash,
          COUNT(event.id) AS event_count
        FROM periodical_issues AS issue
        LEFT JOIN periodical_events AS event ON event.issue_id = issue.id
        WHERE issue.cadence = ?
          AND (? IS NULL OR issue.period_key < ?)
        GROUP BY issue.id
        ORDER BY issue.period_key DESC
        LIMIT ?
      `).all(normalizedCadence, normalizedCursor, normalizedCursor, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        issues: page.map(row => ({
          cadence: row.cadence,
          periodKey: row.period_key,
          volumeNo: row.volume_no,
          periodStartAt: row.period_start_at,
          periodEndAt: row.period_end_at,
          coverageStartedAt: row.coverage_started_at,
          status: row.status,
          revision: row.revision,
          eventCount: row.event_count,
          lastBuiltAt: row.last_built_at,
          contentHash: row.content_hash,
          ...issueUpdateState(row.id, row.last_built_at),
        })),
        nextCursor: hasMore ? page[page.length - 1].period_key : null,
      };
    });
  }

  function getIssue({ cadence, periodKey }) {
    const normalizedCadence = String(cadence || '').trim().toLowerCase();
    if (!PERIODICAL_CADENCES.has(normalizedCadence)) {
      throw invalidPeriodicalRequest('invalid cadence');
    }
    const normalizedPeriodKey = String(periodKey || '').trim();
    if (!validPeriodKey(normalizedCadence, normalizedPeriodKey)) {
      throw invalidPeriodicalRequest('invalid period key');
    }

    return readPeriodicalData(() => {
      const issue = db.prepare(`
        SELECT
          id, cadence, period_key, volume_no, timezone,
          period_start_at, period_end_at, coverage_started_at,
          status, revision, overview, selection_version, summary_version,
          content_hash, summary_status, provider, model, last_built_at, frozen_at
        FROM periodical_issues
        WHERE cadence = ? AND period_key = ?
      `).get(normalizedCadence, normalizedPeriodKey);
      if (!issue) throw missingPeriodical();

      const themes = db.prepare(`
        SELECT id, theme_key, title, trend_note, display_order
        FROM periodical_themes
        WHERE issue_id = ?
        ORDER BY display_order
      `).all(issue.id);
      const events = db.prepare(`
        SELECT
          id, theme_id, event_key, topic_key, title, summary,
          summary_evidence_json, why_selected, effective_at,
          first_seen_at, last_seen_at, importance_score,
          score_json, cluster_json, display_order
        FROM periodical_events
        WHERE issue_id = ?
        ORDER BY display_order
      `).all(issue.id);
      const evidence = db.prepare(`
        SELECT
          evidence.event_id, evidence.entry_id, evidence.source_id,
          evidence.source_name, evidence.source_labels_json,
          evidence.editorial_priority, evidence.entry_title,
          evidence.entry_title_zh, evidence.entry_link, evidence.canonical_url,
          evidence.summary_excerpt, evidence.content_hash,
          evidence.effective_published_at, evidence.timestamp_fallback,
          evidence.is_primary,
          evidence.display_order
        FROM periodical_event_evidence AS evidence
        INNER JOIN periodical_events AS event ON event.id = evidence.event_id
        WHERE event.issue_id = ?
        ORDER BY event.display_order, evidence.display_order
      `).all(issue.id);
      const updateState = issueUpdateState(issue.id, issue.last_built_at);

      return {
        issue: {
          id: issue.id,
          cadence: issue.cadence,
          periodKey: issue.period_key,
          volumeNo: issue.volume_no,
          timezone: issue.timezone,
          periodStartAt: issue.period_start_at,
          periodEndAt: issue.period_end_at,
          coverageStartedAt: issue.coverage_started_at,
          status: issue.status,
          revision: issue.revision,
          overview: issue.overview,
          selectionVersion: issue.selection_version,
          summaryVersion: issue.summary_version,
          contentHash: issue.content_hash,
          summaryStatus: issue.summary_status,
          provider: issue.provider,
          model: issue.model,
          ...updateState,
        },
        themes: themes.map(theme => ({
          id: theme.id,
          themeKey: theme.theme_key,
          title: theme.title,
          trendNote: theme.trend_note,
          displayOrder: theme.display_order,
        })),
        events: events.map(event => ({
          id: event.id,
          themeId: event.theme_id,
          eventKey: event.event_key,
          topicKey: event.topic_key,
          title: event.title,
          summary: event.summary,
          summaryEvidenceIds: JSON.parse(event.summary_evidence_json),
          whySelected: event.why_selected,
          effectiveAt: event.effective_at,
          firstSeenAt: event.first_seen_at,
          lastSeenAt: event.last_seen_at,
          importanceScore: event.importance_score,
          score: JSON.parse(event.score_json),
          cluster: JSON.parse(event.cluster_json),
          displayOrder: event.display_order,
        })),
        evidence: evidence.map(item => ({
          eventId: item.event_id,
          entryId: item.entry_id,
          sourceId: item.source_id,
          sourceName: item.source_name,
          sourceLabels: JSON.parse(item.source_labels_json),
          editorialPriority: item.editorial_priority,
          entryTitle: item.entry_title,
          entryTitleZh: item.entry_title_zh,
          entryLink: item.entry_link,
          canonicalUrl: item.canonical_url,
          summaryExcerpt: item.summary_excerpt,
          contentHash: item.content_hash,
          effectivePublishedAt: item.effective_published_at,
          timestampFallback: Boolean(item.timestamp_fallback),
          isPrimary: Boolean(item.is_primary),
          displayOrder: item.display_order,
        })),
        generatedAt: issue.last_built_at,
        frozenAt: issue.frozen_at,
      };
    });
  }

  function getBuildJob(jobId) {
    return normalizeBuildJob(db.prepare(`
      SELECT * FROM periodical_build_jobs WHERE id = ?
    `).get(String(jobId || '')));
  }

  function buildJobUsesCurrentIdentity(row, sourceInputHash, scoringHistoryHash) {
    return Boolean(row)
      && row.source_input_hash === sourceInputHash
      && row.selection_version === SELECTION_VERSION
      && row.score_config_json === canonicalSerialize(scoreConfig)
      && row.summary_version === SUMMARY_VERSION
      && row.input_hash === fullInputIdentity({
        sourceInputHash,
        asOfAt: Number(row.as_of_at),
        scoringHistoryHash,
        scoreConfig,
      });
  }

  function publishedIssueUsesCurrentIdentity(
    issue,
    publishedJob,
    sourceInputHash,
    legacySourceInputHash,
    scoringHistoryHash,
  ) {
    if (!issue || Number(issue.revision) <= 0
      || issue.selection_version !== SELECTION_VERSION
      || !selectionAlgorithmMatches(issue.selection_context_json, scoreConfig)) {
      return false;
    }
    const asOfAt = Number(publishedJob ? publishedJob.as_of_at : issue.last_built_at);
    if (!Number.isFinite(asOfAt)) return false;
    if (publishedJob) {
      return issue.summary_version === SUMMARY_VERSION
        && issue.source_input_hash === sourceInputHash
        && buildJobUsesCurrentIdentity(publishedJob, sourceInputHash, scoringHistoryHash)
        && issue.input_hash === fullInputIdentity({
          sourceInputHash,
          asOfAt,
          scoringHistoryHash,
          scoreConfig,
        });
    }
    if (issue.summary_version === SUMMARY_VERSION
      && issue.source_input_hash === sourceInputHash
      && issue.input_hash === fullInputIdentity({
        sourceInputHash,
        asOfAt,
        scoringHistoryHash,
        scoreConfig,
      })) {
      return true;
    }
    return issue.summary_version === LEGACY_SUMMARY_VERSION
      && Boolean(legacySourceInputHash)
      && issue.source_input_hash === legacySourceInputHash
      && issue.input_hash === legacyFullInputIdentity({
        sourceInputHash: legacySourceInputHash,
        asOfAt,
      });
  }

  function claimNextBuild(now, leaseMs = 60 * 1000) {
    const timestamp = Number(now);
    const leaseDuration = Number(leaseMs);
    if (!Number.isFinite(timestamp)) throw new TypeError('now must be a finite timestamp');
    if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) {
      throw new TypeError('leaseMs must be a positive number');
    }
    const leaseToken = crypto.randomUUID();
    let claimed = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`
        SELECT id
        FROM periodical_build_jobs
        WHERE status = 'queued'
          OR (status = 'retry_wait' AND COALESCE(next_retry_at, 0) <= ?)
          OR (status = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
        ORDER BY
          CASE status WHEN 'running' THEN 0 WHEN 'retry_wait' THEN 1 ELSE 2 END,
          created_at,
          id
        LIMIT 1
      `).get(timestamp, timestamp);
      if (row) {
        const updated = db.prepare(`
          UPDATE periodical_build_jobs
          SET status = 'running', attempt_count = attempt_count + 1,
              lease_token = ?, lease_expires_at = ?, next_retry_at = NULL,
              error_code = NULL, updated_at = ?, completed_at = NULL
          WHERE id = ?
            AND (
              status = 'queued'
              OR (status = 'retry_wait' AND COALESCE(next_retry_at, 0) <= ?)
              OR (status = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
            )
        `).run(
          leaseToken,
          timestamp + leaseDuration,
          timestamp,
          row.id,
          timestamp,
          timestamp,
        );
        if (Number(updated.changes)) claimed = getBuildJob(row.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return claimed ? { ...claimed, jobId: claimed.id } : null;
  }

  function renewBuildLease(jobId, leaseToken, now, leaseMs = 60 * 1000) {
    const timestamp = Number(now);
    const leaseDuration = Number(leaseMs);
    if (!Number.isFinite(timestamp) || !Number.isFinite(leaseDuration) || leaseDuration <= 0) {
      return false;
    }
    const updated = db.prepare(`
      UPDATE periodical_build_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status = 'running'
        AND lease_expires_at > ?
    `).run(
      timestamp + leaseDuration,
      timestamp,
      String(jobId || ''),
      String(leaseToken || ''),
      timestamp,
    );
    return Number(updated.changes) === 1;
  }

  function hasActiveBuildJobs() {
    const placeholders = ACTIVE_BUILD_STATES.map(() => '?').join(', ');
    return Boolean(db.prepare(`
      SELECT 1 FROM periodical_build_jobs
      WHERE status IN (${placeholders})
      LIMIT 1
    `).get(...ACTIVE_BUILD_STATES));
  }

  function getNextBuildWakeAt() {
    const row = db.prepare(`
      SELECT MIN(CASE
        WHEN status = 'queued' THEN 0
        WHEN status = 'retry_wait' THEN COALESCE(next_retry_at, 0)
        WHEN status = 'running' THEN COALESCE(lease_expires_at, 0)
      END) AS wake_at
      FROM periodical_build_jobs
      WHERE status IN ('queued', 'running', 'retry_wait')
    `).get();
    return row.wake_at === null ? null : Number(row.wake_at);
  }

  function supersedeClaimedBuild(jobId, leaseToken, timestamp) {
    const updated = db.prepare(`
      UPDATE periodical_build_jobs
      SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
          next_retry_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status = 'running'
    `).run(timestamp, timestamp, jobId, leaseToken);
    return Number(updated.changes) === 1;
  }

  function retryableBuildError(error) {
    const statusCode = Number(error && error.statusCode);
    const code = String(error && error.code || '');
    return statusCode === 408
      || statusCode === 425
      || statusCode === 429
      || statusCode >= 500
      || code.startsWith('ERR_SQLITE')
      || code === 'SQLITE_BUSY'
      || code === 'SQLITE_LOCKED';
  }

  function safeBuildErrorCode(error) {
    const code = String(error && error.code || '').trim();
    if (/^[A-Z0-9_]{1,80}$/.test(code)) return code;
    const statusCode = Number(error && error.statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
      return `HTTP_${statusCode}`;
    }
    return 'ERR_PERIODICAL_BUILD';
  }

  function finishBuildError(jobId, leaseToken, error, timestamp) {
    const job = getBuildJob(jobId);
    if (!job || job.status !== 'running' || job.leaseToken !== leaseToken) {
      return job || { id: jobId, status: 'lease_lost' };
    }
    const retry = retryableBuildError(error) && job.attemptCount < MAX_BUILD_ATTEMPTS;
    const nextRetryAt = retry
      ? timestamp + BUILD_RETRY_DELAYS_MS[Math.max(0, job.attemptCount - 1)]
      : null;
    const status = retry ? 'retry_wait' : 'failed';
    const updated = db.prepare(`
      UPDATE periodical_build_jobs
      SET status = ?, lease_token = NULL, lease_expires_at = NULL,
          next_retry_at = ?, error_code = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status = 'running'
    `).run(
      status,
      nextRetryAt,
      safeBuildErrorCode(error),
      retry ? null : timestamp,
      timestamp,
      jobId,
      leaseToken,
    );
    return Number(updated.changes) ? getBuildJob(jobId) : { id: jobId, status: 'lease_lost' };
  }

  function replaceCompiledIssueRows(compiled, issueRow, timestamp) {
    const issue = compiled.issue;
    const updated = db.prepare(`
      UPDATE periodical_issues
      SET timezone = ?, period_start_at = ?, period_end_at = ?,
          coverage_started_at = ?, status = ?, revision = ?, overview = ?,
          selection_version = ?, summary_version = ?, source_input_hash = ?,
          selection_context_json = ?, input_hash = ?, content_hash = ?,
          summary_status = ?, provider = ?, model = ?, last_built_at = ?,
          frozen_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open' AND revision = ?
    `).run(
      issue.timezone,
      issue.periodStartAt,
      issue.periodEndAt,
      issue.coverageStartedAt,
      issue.status,
      issue.revision,
      issue.overview,
      issue.selectionVersion,
      issue.summaryVersion,
      issue.sourceInputHash,
      canonicalSerialize(issue.selectionContext),
      issue.inputHash,
      issue.contentHash,
      issue.summaryStatus,
      issue.provider,
      issue.model,
      timestamp,
      issue.frozenAt,
      timestamp,
      issue.id,
      Number(issueRow.revision),
    );
    if (Number(updated.changes) !== 1) throw invalidBuild('periodical revision changed before publish');

    db.prepare('DELETE FROM periodical_themes WHERE issue_id = ?').run(issue.id);
    const insertTheme = db.prepare(`
      INSERT INTO periodical_themes (
        id, issue_id, theme_key, title, trend_note, display_order
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const theme of compiled.themes) {
      insertTheme.run(
        theme.id,
        issue.id,
        theme.themeKey,
        theme.title,
        theme.trendNote,
        theme.displayOrder,
      );
    }

    const insertEvent = db.prepare(`
      INSERT INTO periodical_events (
        id, issue_id, theme_id, event_key, topic_key, title, summary,
        summary_evidence_json, why_selected, effective_at,
        first_seen_at, last_seen_at, importance_score,
        score_json, cluster_json, display_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of compiled.events) {
      insertEvent.run(
        event.id,
        issue.id,
        event.themeId,
        event.eventKey,
        event.topicKey,
        event.title,
        event.summary,
        canonicalSerialize(event.summaryEvidenceIds),
        event.whySelected,
        event.effectiveAt,
        event.firstSeenAt,
        event.lastSeenAt,
        event.importanceScore,
        canonicalSerialize(event.score),
        canonicalSerialize(event.cluster),
        event.displayOrder,
      );
    }

    const insertEvidence = db.prepare(`
      INSERT INTO periodical_event_evidence (
        event_id, entry_id, source_id, source_name, source_labels_json,
        editorial_priority, entry_title, entry_title_zh, entry_link,
        canonical_url, summary_excerpt, content_hash,
        effective_published_at, timestamp_fallback, is_primary, display_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of compiled.evidence) {
      insertEvidence.run(
        item.eventId,
        item.entryId,
        item.sourceId,
        item.sourceName,
        canonicalSerialize(item.sourceLabels),
        item.editorialPriority,
        item.entryTitle,
        item.entryTitleZh,
        item.entryLink,
        item.canonicalUrl,
        item.summaryExcerpt,
        item.contentHash,
        item.effectivePublishedAt,
        item.timestampFallback ? 1 : 0,
        item.isPrimary ? 1 : 0,
        item.displayOrder,
      );
    }
  }

  function publishClaimedBuild({ job, compiled, leaseToken, timestamp }) {
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentJob = db.prepare(`
        SELECT * FROM periodical_build_jobs WHERE id = ?
      `).get(job.id);
      const issueRow = db.prepare(`
        SELECT * FROM periodical_issues WHERE id = ?
      `).get(job.issueId);
      if (!currentJob || currentJob.status !== 'running'
        || currentJob.lease_token !== leaseToken
        || Number(currentJob.lease_expires_at) <= timestamp) {
        db.exec('ROLLBACK');
        return getBuildJob(job.id) || { id: job.id, status: 'lease_lost' };
      }
      if (!issueRow || issueRow.status !== 'open') {
        supersedeClaimedBuild(job.id, leaseToken, timestamp);
        db.exec('COMMIT');
        return getBuildJob(job.id);
      }

      const currentInput = snapshotOpenDailyInput({
        db,
        now: timestamp,
        periodKey: issueRow.period_key,
        behaviorSignalEnabled,
      });
      if (currentInput.sourceInputHash !== job.sourceInputHash
        || job.inputHash !== fullInputIdentity({
          sourceInputHash: job.sourceInputHash,
          asOfAt: job.asOfAt,
          scoringHistoryHash: currentInput.scoringHistoryHash,
          scoreConfig,
        })) {
        supersedeClaimedBuild(job.id, leaseToken, timestamp);
        db.exec('COMMIT');
        return getBuildJob(job.id);
      }

      validateCompiledOpenDaily(compiled, { job, issue: issueRow });
      replaceCompiledIssueRows(compiled, issueRow, timestamp);
      const succeeded = db.prepare(`
        UPDATE periodical_build_jobs
        SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, provider = ?, model = ?, error_code = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running'
      `).run(
        compiled.issue.provider,
        compiled.issue.model,
        timestamp,
        timestamp,
        job.id,
        leaseToken,
      );
      if (Number(succeeded.changes) !== 1) throw invalidBuild('build lease changed before completion');
      db.exec('COMMIT');
      result = getBuildJob(job.id);
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  async function runNextBuild({
    now: nowValue,
    leaseMs = 60 * 1000,
    compileIssue = compileOpenDaily,
  } = {}) {
    const startedAt = resolvedNow(nowValue);
    const claimed = claimNextBuild(startedAt, leaseMs);
    if (!claimed) return null;
    const job = getBuildJob(claimed.id);
    const leaseToken = job.leaseToken;
    let compiled;
    try {
      const issueRow = db.prepare(`
        SELECT * FROM periodical_issues WHERE id = ?
      `).get(job.issueId);
      if (!issueRow || issueRow.status !== 'open'
        || job.selectionVersion !== SELECTION_VERSION
        || job.summaryVersion !== SUMMARY_VERSION
        || job.scoreConfigJson !== canonicalSerialize(scoreConfig)) {
        supersedeClaimedBuild(job.id, leaseToken, resolvedNow(nowValue));
        return getBuildJob(job.id);
      }
      const buildInput = snapshotOpenDailyInput({
        db,
        now: job.asOfAt,
        periodKey: issueRow.period_key,
        behaviorSignalEnabled,
      });
      if (buildInput.sourceInputHash !== job.sourceInputHash
        || job.inputHash !== fullInputIdentity({
          sourceInputHash: job.sourceInputHash,
          asOfAt: job.asOfAt,
          scoringHistoryHash: buildInput.scoringHistoryHash,
          scoreConfig,
        })) {
        supersedeClaimedBuild(job.id, leaseToken, resolvedNow(nowValue));
        return getBuildJob(job.id);
      }
      compiled = await compileIssue({
        now: job.asOfAt,
        sources: buildInput.sources,
        candidates: buildInput.candidates,
        frozenDailyHistory: buildInput.frozenDailyHistory,
        revision: Number(issueRow.revision) + 1,
        volumeNo: Number(issueRow.volume_no),
        coverageStartedAt: Number(issueRow.coverage_started_at),
        behaviorSignalEnabled,
      });
      validateCompiledOpenDaily(compiled, { job, issue: issueRow });
      compiled = await summarizePeriodicalIssue(compiled, {
        aiAdapter,
        logger,
        beforeAttempt() {
          const summaryAttemptAt = resolvedNow(nowValue);
          if (!renewBuildLease(job.id, leaseToken, summaryAttemptAt, leaseMs)) {
            const error = new Error('build lease changed before summary');
            error.code = 'ERR_PERIODICAL_LEASE_LOST';
            throw error;
          }
        },
      });
      const publishingAt = resolvedNow(nowValue);
      if (!renewBuildLease(job.id, leaseToken, publishingAt, leaseMs)) {
        return getBuildJob(job.id) || { id: job.id, status: 'lease_lost' };
      }
      compiled.issue.lastBuiltAt = publishingAt;
      validateCompiledOpenDaily(compiled, { job, issue: issueRow });
      const finished = publishClaimedBuild({
        job,
        compiled,
        leaseToken,
        timestamp: publishingAt,
      });
      safeBuildLog(logger, {
        issueId: job.issueId,
        jobId: job.id,
        sourceInputHash: job.sourceInputHash,
        inputHash: job.inputHash,
        revision: compiled.issue.revision,
        candidateCount: job.candidateCount,
        eventCount: compiled.events.length,
        state: finished.status,
        durationMs: publishingAt - startedAt,
      });
      return finished;
    } catch (error) {
      const failedAt = resolvedNow(nowValue);
      const failed = finishBuildError(job.id, leaseToken, error, failedAt);
      safeBuildLog(logger, {
        issueId: job.issueId,
        jobId: job.id,
        sourceInputHash: job.sourceInputHash,
        inputHash: job.inputHash,
        revision: 0,
        candidateCount: job.candidateCount,
        eventCount: compiled && Array.isArray(compiled.events) ? compiled.events.length : 0,
        state: failed.status,
        durationMs: failedAt - startedAt,
      });
      return failed;
    }
  }

  function syncOpenDaily({ now, trigger = 'unspecified' } = {}) {
    if (normalizedMode === 'off') return { action: 'disabled', job: null };
    const timestamp = Number(now);
    if (!Number.isFinite(timestamp)) throw new TypeError('now must be a finite timestamp');
    const triggerReason = String(trigger || 'unspecified')
      .trim()
      .replace(/[^a-z0-9:_-]+/gi, '-')
      .slice(0, 80) || 'unspecified';
    let result;

    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = snapshotOpenDailyInput({
        db,
        now: timestamp,
        behaviorSignalEnabled,
      });
      const issueId = `periodical:daily:${snapshot.period.periodKey}`;
      let issue = db.prepare(`
        SELECT * FROM periodical_issues WHERE id = ?
      `).get(issueId);
      if (issue && issue.status === 'frozen') {
        const error = new Error('periodical is frozen');
        error.statusCode = 409;
        throw error;
      }

      if (!issue) {
        const volumeNo = Number(db.prepare(`
          SELECT COALESCE(MAX(volume_no), 0) + 1 AS next_volume
          FROM periodical_issues
          WHERE cadence = 'daily'
        `).get().next_volume);
        db.prepare(`
          INSERT INTO periodical_issues (
            id, cadence, period_key, volume_no, timezone,
            period_start_at, period_end_at, coverage_started_at,
            status, revision, overview, selection_version, summary_version,
            source_input_hash, selection_context_json, input_hash, content_hash,
            summary_status, provider, model, last_built_at, frozen_at,
            created_at, updated_at
          ) VALUES (
            ?, 'daily', ?, ?, 'Asia/Shanghai',
            ?, ?, ?,
            'open', 0, '', ?, ?,
            '', '{}', '', '',
            'fallback', NULL, NULL, NULL, NULL,
            ?, ?
          )
        `).run(
          issueId,
          snapshot.period.periodKey,
          volumeNo,
          snapshot.period.periodStartAt,
          snapshot.period.periodEndAt,
          timestamp,
          SELECTION_VERSION,
          SUMMARY_VERSION,
          timestamp,
          timestamp,
        );
        issue = db.prepare('SELECT * FROM periodical_issues WHERE id = ?').get(issueId);
      }

      const latestJobRow = db.prepare(`
        SELECT *
        FROM periodical_build_jobs
        WHERE issue_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(issueId);
      const publishedJobRow = issue.input_hash
        ? db.prepare(`
            SELECT *
            FROM periodical_build_jobs
            WHERE issue_id = ? AND input_hash = ? AND status = 'succeeded'
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          `).get(issueId, issue.input_hash)
        : null;
      const publishedInputIsCurrent = publishedIssueUsesCurrentIdentity(
        issue,
        publishedJobRow,
        snapshot.sourceInputHash,
        snapshot.legacySourceInputHash,
        snapshot.scoringHistoryHash,
      );
      const latestJobInputIsCurrent = latestJobRow
        && !['superseded', 'succeeded'].includes(latestJobRow.status)
        && buildJobUsesCurrentIdentity(
          latestJobRow,
          snapshot.sourceInputHash,
          snapshot.scoringHistoryHash,
        );

      if (publishedInputIsCurrent) {
        db.prepare(`
          UPDATE periodical_build_jobs
          SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NULL, completed_at = ?, updated_at = ?
          WHERE issue_id = ? AND source_input_hash <> ?
            AND status IN ('queued', 'running', 'retry_wait', 'failed')
        `).run(timestamp, timestamp, issueId, snapshot.sourceInputHash);
        result = {
          action: 'noop',
          issueId,
          sourceInputHash: issue.source_input_hash,
          inputHash: issue.input_hash,
          job: normalizeBuildJob(publishedJobRow),
          revision: Number(issue.revision),
        };
      } else if (latestJobInputIsCurrent) {
        result = {
          action: 'noop',
          issueId,
          sourceInputHash: snapshot.sourceInputHash,
          inputHash: latestJobRow.input_hash,
          job: normalizeBuildJob(latestJobRow),
          revision: Number(issue.revision),
        };
      } else {
        db.prepare(`
          UPDATE periodical_build_jobs
          SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NULL, completed_at = ?, updated_at = ?
          WHERE issue_id = ? AND status IN ('queued', 'running', 'retry_wait')
        `).run(timestamp, timestamp, issueId);

        let jobId;
        const inputHash = fullInputIdentity({
          sourceInputHash: snapshot.sourceInputHash,
          asOfAt: timestamp,
          scoringHistoryHash: snapshot.scoringHistoryHash,
          scoreConfig,
        });
        const exactJobRow = db.prepare(`
          SELECT * FROM periodical_build_jobs
          WHERE issue_id = ? AND input_hash = ? AND summary_version = ?
        `).get(issueId, inputHash, SUMMARY_VERSION);
        if (exactJobRow && exactJobRow.status === 'superseded') {
          jobId = exactJobRow.id;
          db.prepare(`
            UPDATE periodical_build_jobs
            SET selection_version = ?, score_config_json = ?, summary_version = ?,
                trigger_reason = ?, status = 'queued', attempt_count = 0,
                lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL,
                provider = NULL, model = NULL, error_code = NULL,
                candidate_count = ?, source_count = ?, updated_at = ?, completed_at = NULL
            WHERE id = ? AND status = 'superseded'
          `).run(
            SELECTION_VERSION,
            canonicalSerialize(scoreConfig),
            SUMMARY_VERSION,
            triggerReason,
            snapshot.candidateCount,
            snapshot.sourceCount,
            timestamp,
            jobId,
          );
        } else if (exactJobRow) {
          result = {
            action: 'noop',
            issueId,
            sourceInputHash: snapshot.sourceInputHash,
            inputHash,
            job: normalizeBuildJob(exactJobRow),
            revision: Number(issue.revision),
          };
        } else {
          jobId = `periodical-job:${computeCanonicalHash({
            issueId,
            inputHash,
            summaryVersion: SUMMARY_VERSION,
          })}`;
          db.prepare(`
            INSERT INTO periodical_build_jobs (
              id, issue_id, source_input_hash, input_hash, as_of_at,
              selection_version, score_config_json, summary_version,
              trigger_reason, status, attempt_count,
              lease_token, lease_expires_at, next_retry_at,
              provider, model, error_code, candidate_count, source_count,
              created_at, updated_at, completed_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, 'queued', 0,
              NULL, NULL, NULL,
              NULL, NULL, NULL, ?, ?,
              ?, ?, NULL
            )
          `).run(
            jobId,
            issueId,
            snapshot.sourceInputHash,
            inputHash,
            timestamp,
            SELECTION_VERSION,
            canonicalSerialize(scoreConfig),
            SUMMARY_VERSION,
            triggerReason,
            snapshot.candidateCount,
            snapshot.sourceCount,
            timestamp,
            timestamp,
          );
        }
        if (!result) {
          result = {
            action: 'queued',
            issueId,
            sourceInputHash: snapshot.sourceInputHash,
            inputHash,
            job: getBuildJob(jobId),
            revision: Number(issue.revision),
          };
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }

    safeBuildLog(logger, {
      issueId: result.issueId,
      jobId: result.job && result.job.id || '-',
      sourceInputHash: result.sourceInputHash,
      inputHash: result.inputHash,
      revision: result.revision,
      candidateCount: result.job && result.job.candidateCount || 0,
      eventCount: 0,
      state: result.action === 'queued' ? 'queued' : 'noop',
      durationMs: 0,
    });
    return result;
  }

  return {
    mode: normalizedMode,
    isPublic: normalizedMode === 'on',
    getIssue,
    getBuildJob,
    claimNextBuild,
    getNextBuildWakeAt,
    hasActiveBuildJobs,
    listIssues,
    renewBuildLease,
    runNextBuild,
    syncOpenDaily,
  };
}

module.exports = {
  canonicalizeEvidenceUrl,
  compileOpenDaily,
  createPeriodicalsModule,
  ensurePeriodicalSchema,
  eventMergeDecision,
  normalizeEventFeatures,
  periodicalsMode,
};
