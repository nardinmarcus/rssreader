const fetcher = require('./fetcher');
const deepseek = require('./deepseek');
const store = require('./store');

const TITLE_TRANSLATION_LIMIT = parseInt(process.env.TITLE_TRANSLATION_LIMIT || '80', 10);
const AUTO_REWRITE_DEFAULT_MODEL = 'deepseek-v4-flash';
const AUTO_REWRITE_SOURCE_IDS = new Set(String(process.env.AUTO_REWRITE_SOURCE_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean));
const AUTO_REWRITE_LIMIT_PER_SOURCE = parseInt(process.env.AUTO_REWRITE_LIMIT_PER_SOURCE || '3', 10);

function plainText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function entryPlainText(entry) {
  const official = entry && entry.officialSiteContext;
  return plainText([
    entry && (entry.content || entry.summary),
    official && official.title,
    official && official.summary,
    official && official.content,
  ].filter(Boolean).join('\n\n'));
}

function shouldAutoFetchOriginal(entry) {
  if (!entry || !/^https?:\/\//i.test(entry.link || '')) return false;
  if (entry.sourceId === 'hackernews') {
    return !entry.originalFetchedAt && !/news\.ycombinator\.com\/item\?/i.test(entry.link || '');
  }
  const contentText = plainText(entry.content);
  const summaryText = plainText(entry.summary);
  const textLength = (contentText || summaryText).length;
  if (textLength >= 600) return false;
  if (!contentText || contentText.length < 300) return true;
  return Boolean(summaryText && contentText.length <= summaryText.length + 25);
}

async function prepareEntryForAiAsset(entry, reason = 'AI asset') {
  if (entry && entry.sourceId === 'producthunt') {
    try {
      const officialSiteContext = await fetcher.fetchProductHuntOfficialContext(entry);
      if (officialSiteContext && entryPlainText({ content: officialSiteContext.content, summary: officialSiteContext.summary }).length >= 80) {
        console.log(`${reason}: fetched Product Hunt official-site context for ${entry.id}`);
        return {
          entry: {
            ...entry,
            officialSiteContext,
          },
          fetched: true,
          officialSiteFetched: true,
        };
      }
    } catch (error) {
      console.warn(`${reason}: Product Hunt official-site context skipped for ${entry.id}:`, error.message || error);
      return {
        entry,
        fetched: false,
        officialSiteFetched: false,
        error: String(error.message || error).slice(0, 200),
      };
    }
  }
  if (!shouldAutoFetchOriginal(entry)) return { entry, fetched: false };
  try {
    const updated = await fetcher.fetchEntryOriginal(entry);
    if (updated && entryPlainText(updated).length > entryPlainText(entry).length) {
      console.log(`${reason}: fetched original content for ${entry.id}`);
      return { entry: updated, fetched: true };
    }
  } catch (error) {
    console.warn(`${reason}: original content auto-fetch skipped for ${entry.id}:`, error.message || error);
    return {
      entry,
      fetched: false,
      error: String(error.message || error).slice(0, 200),
    };
  }
  return { entry: fetcher.getEntryById(entry.id) || entry, fetched: false };
}

async function translateMissingTitles(limit = TITLE_TRANSLATION_LIMIT) {
  if (!deepseek.getConfig().configured) return 0;
  const entries = fetcher.getEntries({ limit: 1000 })
    .filter(entry => deepseek.isLikelyEnglish(entry.title) && !entry.titleZh)
    .slice(0, limit);
  let translated = 0;
  for (let i = 0; i < entries.length; i += 20) {
    const result = await deepseek.translateTitleBatch(entries.slice(i, i + 20), { author: 'system' });
    translated += result.translations.length;
  }
  return translated;
}

async function translateSubmittedTitle(entry) {
  if (!entry || !entry.id || !deepseek.getConfig().configured || !deepseek.isLikelyEnglish(entry.title)) return null;
  try {
    const result = await deepseek.translateTitleBatch([entry], { author: 'system' });
    return result.translations && result.translations[0] ? result.translations[0] : null;
  } catch (error) {
    console.warn(`Submit link title translation skipped for ${entry.id}:`, error.message || error);
    return null;
  }
}

function queueSubmittedContentTranslation(entry) {
  if (!entry || !entry.id || !deepseek.getConfig().configured) return;
  if (!deepseek.isLikelyEnglish(`${entry.title || ''}\n${plainText(entry.content || entry.summary || '').slice(0, 2000)}`)) return;
  setTimeout(async () => {
    try {
      const latest = fetcher.getEntryById(entry.id) || entry;
      await deepseek.translateEntry(latest, {
        author: '向阳乔木',
        temperature: 0.15,
        maxTokens: 6000,
      });
      console.log(`Submitted link translated: ${entry.id}`);
    } catch (error) {
      console.warn(`Submit link content translation skipped for ${entry.id}:`, error.message || error);
    }
  }, 0);
}

function normalizeRewriteEntries(entries = []) {
  const byId = new Map();
  for (const item of entries || []) {
    const entry = typeof item === 'string'
      ? fetcher.getEntryById(item)
      : (item && item.id ? (fetcher.getEntryById(item.id) || item) : null);
    if (entry && entry.id) byId.set(entry.id, entry);
  }
  return Array.from(byId.values());
}

async function autoRewriteEntries(entries = [], { skipped = 'no changed entries' } = {}) {
  const normalized = normalizeRewriteEntries(entries);
  const targets = normalized;
  const skippedEntries = 0;
  if (!targets.length) {
    return {
      rewritten: 0,
      cached: 0,
      failed: [],
      changed: 0,
      skipped: skippedEntries ? 'no rewrite-eligible entries' : skipped,
      skippedEntries,
    };
  }
  const config = deepseek.getConfig({
    provider: 'deepseek',
    model: process.env.AUTO_REWRITE_MODEL || AUTO_REWRITE_DEFAULT_MODEL,
  });
  if (!config.configured) return { rewritten: 0, cached: 0, failed: [], changed: targets.length, skipped: 'AI not configured', skippedEntries };
  let rewritten = 0;
  let cached = 0;
  const failed = [];
  for (const entry of targets) {
    const prepared = await prepareEntryForAiAsset(entry, 'Auto rewrite');
    const targetEntry = prepared.entry || entry;
    const text = entryPlainText(targetEntry);
    if (text.length < 80) {
      failed.push({ entryId: entry.id, title: entry.title, error: '正文太短，无法自动重写' });
      continue;
    }
    const existing = store.getRewrite(targetEntry.id);
    if (existing && existing.contentHash === deepseek.rewriteContentHash(targetEntry)) {
      cached++;
      continue;
    }
    try {
      const result = await deepseek.rewriteEntry(targetEntry, {
        provider: 'deepseek',
        model: config.model,
        author: '向阳乔木',
        temperature: config.temperature,
        maxTokens: Math.max(config.maxTokens, 7000),
      });
      if (result.cached) cached++;
      else rewritten++;
    } catch (error) {
      failed.push({
        entryId: entry.id,
        title: entry.title,
        error: String(error.message || error).slice(0, 200),
      });
    }
  }
  return { rewritten, cached, failed, changed: targets.length, skippedEntries };
}

async function autoRewriteSources(sourceIds = AUTO_REWRITE_SOURCE_IDS) {
  const ids = sourceIds instanceof Set ? sourceIds : new Set(sourceIds);
  if (!ids.size) return { rewritten: 0, cached: 0, failed: [], skipped: 'no sources configured' };

  const limitPerSource = Number.isFinite(AUTO_REWRITE_LIMIT_PER_SOURCE) && AUTO_REWRITE_LIMIT_PER_SOURCE > 0
    ? AUTO_REWRITE_LIMIT_PER_SOURCE
    : Infinity;
  const perSource = new Map();
  for (const entry of fetcher.getEntries({ limit: 1000 })) {
    if (!ids.has(entry.sourceId)) continue;
    const bucket = perSource.get(entry.sourceId) || [];
    if (bucket.length >= limitPerSource) continue;
    bucket.push(entry);
    perSource.set(entry.sourceId, bucket);
  }

  const entries = Array.from(perSource.values()).flat();
  return autoRewriteEntries(entries, { skipped: 'no matching entries' });
}

function defaultAutoRewriteSourceIds() {
  if (AUTO_REWRITE_SOURCE_IDS.size) return Array.from(AUTO_REWRITE_SOURCE_IDS);
  return fetcher.getSourcesMeta()
    .filter(source => source && source.enabled)
    .map(source => source.id)
    .filter(Boolean);
}

function sourceIdsFrom(value, fallback = defaultAutoRewriteSourceIds()) {
  const raw = Array.isArray(value) || value instanceof Set ? Array.from(value) : [];
  const ids = raw.map(id => String(id || '').trim()).filter(Boolean);
  return ids.length ? ids : Array.from(fallback);
}

function compactRefreshResult(refresh) {
  if (!refresh || typeof refresh !== 'object') return refresh;
  const result = { ...refresh };
  if (Array.isArray(result.changedEntries)) {
    result.changedEntryIds = result.changedEntries.map(entry => entry && entry.id).filter(Boolean);
    delete result.changedEntries;
  }
  return result;
}

async function runRefreshJob(job = {}, hooks = {}) {
  fetcher.loadDisk({ upsert: false });
  const kind = String(job.kind || 'refresh').trim();
  const startedAt = Date.now();

  if (kind === 'auto-rewrite') {
    const sourceIds = sourceIdsFrom(job.sourceIds);
    if (hooks.onAutoRewriteStart) hooks.onAutoRewriteStart(sourceIds);
    const autoRewrite = await autoRewriteSources(sourceIds);
    if (hooks.onAutoRewriteDone) hooks.onAutoRewriteDone(autoRewrite);
    fetcher.flushDisk();
    return { kind, sourceIds, autoRewrite, startedAt, finishedAt: Date.now() };
  }

  if (kind !== 'refresh') {
    const err = new Error(`Unknown background job kind: ${kind}`);
    err.statusCode = 400;
    throw err;
  }

  const sourceId = String(job.sourceId || '').trim();
  let refresh = null;
  if (sourceId) {
    const source = fetcher.getSourceById(sourceId);
    if (!source) {
      const err = new Error('source not found');
      err.statusCode = 404;
      throw err;
    }
    if (hooks.onProgress) hooks.onProgress(0, 1, source.id);
    const result = await fetcher.fetchSource(source);
    if (hooks.onProgress) hooks.onProgress(1, 1, source.id);
    refresh = {
      sourceId,
      status: result.status,
      error: result.error || null,
      entryCount: result.entries ? result.entries.length : 0,
      changedEntryCount: Array.isArray(result.changedEntries) ? result.changedEntries.length : 0,
    };
    refresh.changedEntries = result.changedEntries || [];
  } else {
    const result = await fetcher.refreshAll((done, total, id) => {
      if (hooks.onProgress) hooks.onProgress(done, total, id);
    });
    refresh = {
      all: true,
      changedEntryCount: Array.isArray(result && result.changedEntries) ? result.changedEntries.length : 0,
      changedEntries: result && result.changedEntries || [],
    };
  }

  if (hooks.onFetchDone) hooks.onFetchDone(compactRefreshResult(refresh));

  let translated = 0;
  try {
    translated = await translateMissingTitles(sourceId ? 20 : TITLE_TRANSLATION_LIMIT);
  } catch (error) {
    refresh.titleTranslationError = String(error.message || error).slice(0, 200);
  }

  let autoRewrite = null;
  const changedEntries = refresh && Array.isArray(refresh.changedEntries) ? refresh.changedEntries : [];
  if (sourceId) {
    const sourceIds = [sourceId];
    if (hooks.onAutoRewriteStart) hooks.onAutoRewriteStart(sourceIds);
    autoRewrite = await autoRewriteSources(sourceIds);
    if (hooks.onAutoRewriteDone) hooks.onAutoRewriteDone(autoRewrite);
  } else if (changedEntries.length) {
    const sourceIds = [...new Set(changedEntries.map(entry => entry.sourceId).filter(Boolean))];
    if (hooks.onAutoRewriteStart) hooks.onAutoRewriteStart(sourceIds);
    autoRewrite = await autoRewriteEntries(changedEntries);
    if (hooks.onAutoRewriteDone) hooks.onAutoRewriteDone(autoRewrite);
  } else {
    autoRewrite = { rewritten: 0, cached: 0, failed: [], changed: 0, skipped: 'no changed entries' };
  }

  refresh = compactRefreshResult(refresh);

  fetcher.flushDisk();
  return { kind, sourceId, refresh, translated, autoRewrite, startedAt, finishedAt: Date.now() };
}

module.exports = {
  AUTO_REWRITE_SOURCE_IDS,
  plainText,
  entryPlainText,
  prepareEntryForAiAsset,
  translateMissingTitles,
  translateSubmittedTitle,
  queueSubmittedContentTranslation,
  autoRewriteSources,
  runRefreshJob,
};
