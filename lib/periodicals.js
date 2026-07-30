const {
  CANONICALIZATION_VERSION,
  canonicalSerialize,
  computeCanonicalHash,
} = require('./content-hashes');
const { mergeSourcesWithPreferences } = require('./source-preferences');
const { SOURCES } = require('./sources');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 6 * HOUR_MS;
const SELECTION_VERSION = 'importance-v1';
const SUMMARY_VERSION = 'fallback-v1';
const CANDIDATE_SNAPSHOT_VERSION = 'periodical-candidate-v1';
const EVENT_IDENTITY_VERSION = 'single-entry-event-v1';
const URL_CANONICALIZATION_VERSION = 'periodical-url-v1';
const SCORE_CONFIG = Object.freeze({
  threshold: 40,
  maxEvents: 12,
  freshnessHalfLifeHours: 36,
  behaviorSignalEnabled: false,
});
const SOURCE_QUALITY_POINTS = Object.freeze({ high: 30, normal: 20, low: 8 });
const SOURCE_PRIORITY_RANK = Object.freeze({ high: 3, normal: 2, low: 1 });
const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'ref_src']);
const THEME_DEFINITIONS = Object.freeze({
  research_models: '研究与模型',
  products_tools: '产品与工具',
  engineering_open_source: '工程与开源',
  industry_business: '产业与商业',
  community_practice: '社区与实践',
  creation_methods: '创作与方法',
});

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
  return Object.prototype.hasOwnProperty.call(SOURCE_QUALITY_POINTS, priority) ? priority : 'normal';
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

function candidateInputContentHash({ source, evidence }) {
  return computeCanonicalHash({
    version: CANDIDATE_SNAPSHOT_VERSION,
    urlCanonicalizationVersion: URL_CANONICALIZATION_VERSION,
    source: {
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
  });
}

function eventScore(source, effectivePublishedAt, now) {
  const priority = normalizedPriority(source.editorialPriority);
  const exactAgeHours = Math.max(0, now - effectivePublishedAt) / HOUR_MS;
  const ageHours = roundOne(exactAgeHours);
  const freshnessPoints = roundOne(20 * (2 ** (-exactAgeHours / SCORE_CONFIG.freshnessHalfLifeHours)));
  return {
    version: SELECTION_VERSION,
    sourceQuality: { priority, points: SOURCE_QUALITY_POINTS[priority] },
    confirmation: { independentSourceCount: 1, points: 0 },
    persistence: { daysPresent: 0, points: 0 },
    trend: { baselineSourceCount: 0, sourceIncrease: 0, points: 0 },
    freshness: {
      ageHours,
      halfLifeHours: SCORE_CONFIG.freshnessHalfLifeHours,
      points: freshnessPoints,
    },
    behavior: { enabled: false, starredCount: 0, viewCount: 0, points: 0 },
  };
}

function whySelected(score) {
  const reasons = [];
  if (score.sourceQuality.points > 0) {
    const label = { high: '高', normal: '普通', low: '低' }[score.sourceQuality.priority];
    reasons.push(`来源质量（${label}）计 ${score.sourceQuality.points} 分`);
  }
  if (score.freshness.points > 0) reasons.push(`时效性计 ${score.freshness.points} 分`);
  return `${reasons.join('；')}。`;
}

function computePeriodicalContentHash({ issue, themes, events, evidence }) {
  const {
    contentHash,
    inputHash,
    lastBuiltAt,
    selectionContext,
    sourceInputHash,
    ...semanticIssue
  } = issue;
  return computeCanonicalHash({
    issue: semanticIssue,
    themes,
    events,
    evidence,
    inputs: [],
  });
}

function compileOpenDaily({
  now,
  sources = [],
  candidates = [],
  revision = 1,
  volumeNo = 1,
  coverageStartedAt,
} = {}) {
  const timestamp = Number(now);
  const period = shanghaiDailyPeriod(timestamp);
  const issueId = `periodical:daily:${period.periodKey}`;
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
    const eventKey = computeCanonicalHash({
      version: EVENT_IDENTITY_VERSION,
      entryIds: [String(candidate.id)],
    });
    const eventId = `${issueId}:event:${eventKey}`;
    const evidence = candidateEvidence({ candidate, source, now: timestamp, eventId });
    if (Number(candidate.createdAt) > timestamp
      || evidence.effectivePublishedAt < period.periodStartAt
      || evidence.effectivePublishedAt >= period.periodEndAt) continue;
    const score = eventScore(source, evidence.effectivePublishedAt, timestamp);
    const importanceScore = roundOne(Object.values(score)
      .filter(component => component && typeof component === 'object' && 'points' in component)
      .reduce((total, component) => total + component.points, 0));
    compiledCandidates.push({
      source,
      evidence,
      inputContentHash: candidateInputContentHash({ source, evidence }),
      event: {
        id: eventId,
        themeId: '',
        eventKey,
        topicKey: null,
        title: String(candidate.titleZh || candidate.title || '(无标题)'),
        summary: eventSummary(candidate, evidence),
        summaryEvidenceIds: [String(candidate.id)],
        whySelected: whySelected(score),
        effectiveAt: evidence.effectivePublishedAt,
        firstSeenAt: evidence.effectivePublishedAt,
        lastSeenAt: evidence.effectivePublishedAt,
        importanceScore,
        score,
        cluster: {
          version: EVENT_IDENTITY_VERSION,
          reason: 'single-candidate',
          entryIds: [String(candidate.id)],
        },
        displayOrder: 0,
      },
      themeKey: fallbackThemeKey(source),
    });
  }

  const selected = compiledCandidates
    .filter(item => item.event.importanceScore >= SCORE_CONFIG.threshold)
    .sort((left, right) => (right.event.importanceScore - left.event.importanceScore)
      || (SOURCE_PRIORITY_RANK[right.evidence.editorialPriority]
        - SOURCE_PRIORITY_RANK[left.evidence.editorialPriority])
      || (right.event.effectiveAt - left.event.effectiveAt)
      || left.event.eventKey.localeCompare(right.event.eventKey))
    .slice(0, SCORE_CONFIG.maxEvents);

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
  const evidence = selected.map(item => item.evidence);
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
  const sourceInputHash = computeCanonicalHash({
    canonicalizationVersion: CANONICALIZATION_VERSION,
    cadence: 'daily',
    periodKey: period.periodKey,
    candidates: eligibleCandidates,
    sources: sourceSnapshot,
    behavior: 'behavior-disabled',
  });
  const selectionContext = {
    canonicalizationVersion: CANONICALIZATION_VERSION,
    candidateSnapshotVersion: CANDIDATE_SNAPSHOT_VERSION,
    urlCanonicalizationVersion: URL_CANONICALIZATION_VERSION,
    eventIdentityVersion: EVENT_IDENTITY_VERSION,
    scoreConfig: SCORE_CONFIG,
    behavior: { enabled: false },
    candidateCount: eligibleCandidates.length,
    eligibleSourceCount: sourceSnapshot.length,
  };
  const inputHash = computeCanonicalHash({
    sourceInputHash,
    asOfAt: timestamp,
    selectionVersion: SELECTION_VERSION,
    scoreConfig: SCORE_CONFIG,
    summaryVersion: SUMMARY_VERSION,
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

function candidatesFromSqlite(db, sources, now) {
  const sourceIds = sources.filter(eligibleSource).map(source => source.id);
  if (!sourceIds.length) return [];
  const period = shanghaiDailyPeriod(now);
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
      input_hash TEXT NOT NULL,
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

function createPeriodicalsModule({ db, mode }) {
  ensurePeriodicalSchema(db);
  const normalizedMode = periodicalsMode(mode);

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

  function syncOpenDaily({ now } = {}) {
    if (normalizedMode !== 'shadow') {
      const error = new Error('open daily compilation requires shadow mode');
      error.statusCode = 409;
      throw error;
    }
    const timestamp = Number(now);
    const period = shanghaiDailyPeriod(timestamp);
    db.exec('BEGIN IMMEDIATE');
    try {
      const sources = configuredSourcesFromSqlite(db);
      const candidates = candidatesFromSqlite(db, sources, timestamp);
      const existing = db.prepare(`
        SELECT volume_no, revision, coverage_started_at, status, source_input_hash
        FROM periodical_issues
        WHERE cadence = 'daily' AND period_key = ?
      `).get(period.periodKey);
      if (existing && existing.status === 'frozen') {
        const error = new Error('periodical is frozen');
        error.statusCode = 409;
        throw error;
      }
      const volumeNo = existing
        ? existing.volume_no
        : Number(db.prepare(`
            SELECT COALESCE(MAX(volume_no), 0) + 1 AS next_volume
            FROM periodical_issues
            WHERE cadence = 'daily'
          `).get().next_volume);
      const compiled = compileOpenDaily({
        now: timestamp,
        sources,
        candidates,
        revision: existing ? Number(existing.revision) + 1 : 1,
        volumeNo,
        coverageStartedAt: existing && existing.coverage_started_at !== null
          ? Number(existing.coverage_started_at)
          : timestamp,
      });
      if (existing
        && existing.status === 'open'
        && existing.source_input_hash === compiled.issue.sourceInputHash) {
        db.exec('COMMIT');
        return getIssue({ cadence: 'daily', periodKey: period.periodKey });
      }
      const issue = compiled.issue;
      db.prepare(`
        INSERT INTO periodical_issues (
          id, cadence, period_key, volume_no, timezone,
          period_start_at, period_end_at, coverage_started_at,
          status, revision, overview, selection_version, summary_version,
          source_input_hash, selection_context_json, input_hash, content_hash,
          summary_status, provider, model, last_built_at, frozen_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          timezone = excluded.timezone,
          period_start_at = excluded.period_start_at,
          period_end_at = excluded.period_end_at,
          coverage_started_at = excluded.coverage_started_at,
          status = excluded.status,
          revision = excluded.revision,
          overview = excluded.overview,
          selection_version = excluded.selection_version,
          summary_version = excluded.summary_version,
          source_input_hash = excluded.source_input_hash,
          selection_context_json = excluded.selection_context_json,
          input_hash = excluded.input_hash,
          content_hash = excluded.content_hash,
          summary_status = excluded.summary_status,
          provider = excluded.provider,
          model = excluded.model,
          last_built_at = excluded.last_built_at,
          frozen_at = excluded.frozen_at,
          updated_at = excluded.updated_at
      `).run(
        issue.id,
        issue.cadence,
        issue.periodKey,
        issue.volumeNo,
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
        issue.lastBuiltAt,
        issue.frozenAt,
        timestamp,
        timestamp,
      );
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
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return getIssue({ cadence: 'daily', periodKey: period.periodKey });
  }

  return {
    mode: normalizedMode,
    isPublic: normalizedMode === 'on',
    getIssue,
    listIssues,
    syncOpenDaily,
  };
}

module.exports = {
  compileOpenDaily,
  createPeriodicalsModule,
  ensurePeriodicalSchema,
  periodicalsMode,
};
