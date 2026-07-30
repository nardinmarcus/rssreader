const { computePeriodicalContentHash } = require('../../lib/periodical-summary');

function seedEmptyFrozenDailyMonths(db, monthKeys, { startVolume = 1 } = {}) {
  let volumeNo = startVolume;
  for (const monthKey of monthKeys) {
    const [year, month] = monthKey.split('-').map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) {
      const periodKey = `${monthKey}-${String(day).padStart(2, '0')}`;
      const periodStartAt = Date.parse(`${periodKey}T00:00:00.000+08:00`);
      const periodEndAt = periodStartAt + (24 * 60 * 60 * 1000);
      const issue = {
        id: `periodical:daily:${periodKey}`,
        cadence: 'daily',
        periodKey,
        volumeNo,
        timezone: 'Asia/Shanghai',
        periodStartAt,
        periodEndAt,
        coverageStartedAt: periodStartAt,
        status: 'frozen',
        revision: 1,
        overview: '本日为空日报。第二句。',
        selectionVersion: 'importance-v1',
        summaryVersion: 'constrained-summary-v1',
        sourceInputHash: `fixture-source:${periodKey}`,
        selectionContext: { fixture: true },
        inputHash: `fixture-input:${periodKey}`,
        contentHash: '',
        summaryStatus: 'fallback',
        provider: null,
        model: null,
        lastBuiltAt: periodEndAt,
        frozenAt: periodEndAt + 1,
      };
      issue.contentHash = computePeriodicalContentHash({
        issue,
        themes: [],
        events: [],
        evidence: [],
      });
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
          'finalizing', 1, ?, ?, ?,
          ?, ?, ?, ?,
          'fallback', NULL, NULL, ?, ?,
          ?, ?
        )
      `).run(
        issue.id,
        issue.periodKey,
        issue.volumeNo,
        issue.periodStartAt,
        issue.periodEndAt,
        issue.coverageStartedAt,
        issue.overview,
        issue.selectionVersion,
        issue.summaryVersion,
        issue.sourceInputHash,
        JSON.stringify(issue.selectionContext),
        issue.inputHash,
        issue.contentHash,
        issue.lastBuiltAt,
        issue.frozenAt,
        issue.periodStartAt,
        issue.frozenAt,
      );
      db.prepare(`
        UPDATE periodical_issues SET status = 'frozen' WHERE id = ?
      `).run(issue.id);
      volumeNo += 1;
    }
  }
}

module.exports = { seedEmptyFrozenDailyMonths };
