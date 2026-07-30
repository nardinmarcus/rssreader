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
          evidence.effective_published_at, evidence.is_primary,
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
          isPrimary: Boolean(item.is_primary),
          displayOrder: item.display_order,
        })),
        generatedAt: issue.last_built_at,
        frozenAt: issue.frozen_at,
      };
    });
  }

  return {
    mode: normalizedMode,
    isPublic: normalizedMode === 'on',
    getIssue,
    listIssues,
  };
}

module.exports = {
  createPeriodicalsModule,
  ensurePeriodicalSchema,
  periodicalsMode,
};
