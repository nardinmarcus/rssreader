const crypto = require('crypto');

function ingestionError(message, statusCode = 422, code = 'invalid-wechat-feed') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizedAccountName(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（(](?:微信公众号|公众号|微信|rss|订阅)[^）)]*[）)]/gi, '')
    .replace(/(?:[-_·|：:]?\s*)(?:微信公众号|公众号|微信订阅|rss订阅|rss)$/i, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function verifyWechatFeed(catalogEntry, parsed, { expectedAccountId = '', validateName = true } = {}) {
  const expectedName = normalizedAccountName(catalogEntry && catalogEntry.name);
  const actualName = normalizedAccountName(parsed && parsed.feedTitle);
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  const allEntriesHaveAccountIdentity = entries.length > 0 && entries.every(entry => (
    /^wechat:[^:]+:[^:]+:[^:]+$/.test(String(entry && entry.platformIdentity || ''))
  ));
  if ((validateName || (expectedAccountId && !allEntriesHaveAccountIdentity))
      && (!expectedName || !actualName || expectedName !== actualName)) {
    throw ingestionError('feed account identity does not match the selected catalog entry', 422, 'wechat-account-mismatch');
  }

  if (!entries.length) throw ingestionError('feed contains no readable WeChat articles');
  const identities = new Set();
  const bizValues = new Set();
  for (const entry of entries) {
    if (!entry || !entry.platformIdentity || !/^https:\/\/mp\.weixin\.qq\.com\//i.test(String(entry.link || ''))) {
      throw ingestionError('feed contains an article without a trusted WeChat identity');
    }
    const identity = String(entry.platformIdentity);
    identities.add(identity);
    const match = /^wechat:([^:]+):[^:]+:[^:]+$/.exec(identity);
    if (match) bizValues.add(match[1]);
  }
  if (!identities.size || bizValues.size > 1) {
    throw ingestionError('feed mixes WeChat account identities');
  }
  const accountId = bizValues.size ? decodeURIComponent(Array.from(bizValues)[0]) : '';
  if (expectedAccountId && accountId && accountId !== expectedAccountId) {
    throw ingestionError('feed WeChat account identity changed', 409, 'wechat-account-identity-changed');
  }
  return { entries, platformAccountId: accountId || expectedAccountId };
}

function createSourceIngestion({ store, sourceDiscovery, fetcher, now = Date.now } = {}) {
  if (!store || !sourceDiscovery || !fetcher) throw new Error('source ingestion dependencies are required');
  const inFlight = new Map();

  function sourceForCatalogKey(key) {
    const registered = store.getSourceIngestionByCatalogKey(key);
    if (registered) {
      return store.getCustomSourceById(registered.sourceId, { includeArchived: true });
    }
    return sourceDiscovery.findLegacyWechatSourceByCatalogKey(key);
  }

  async function activateWechatCatalogKey(keyValue, { restore = false } = {}) {
    const key = String(keyValue || '').trim();
    if (!/^wechat:[A-Za-z0-9_-]{6,80}$/.test(key)) {
      throw ingestionError('invalid WeChat catalog key', 400, 'invalid-catalog-key');
    }
    if (inFlight.has(key)) return inFlight.get(key);
    const task = activateOnce(key, { restore: restore === true });
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
    }
  }

  async function activateOnce(key, { restore }) {
    const existing = sourceForCatalogKey(key);
    const existingIngestion = store.getSourceIngestionByCatalogKey(key);
    if (existing && !existing.archivedAt && existingIngestion && existingIngestion.activationCompletedAt) {
      return {
        source: fetcher.getSourceById(existing.id),
        created: false,
        restored: false,
        alreadyActivated: true,
        entryCount: 0,
        activationCutoff: existingIngestion.activationCutoff,
      };
    }
    if (existing && existing.archivedAt && !restore) {
      throw ingestionError('source is archived; explicit restore is required', 409, 'wechat-source-archived');
    }

    await sourceDiscovery.ensureSourceCatalogFresh();
    const catalogEntry = sourceDiscovery.resolveWechatCatalogEntry(key);
    if (!catalogEntry) throw ingestionError('WeChat catalog entry is unavailable', 404, 'wechat-catalog-entry-not-found');

    const sourceId = existing ? existing.id : `custom-${crypto.randomUUID()}`;
    const parsed = await fetcher.readWechatFeedForIngestion(catalogEntry, sourceId);
    const verified = verifyWechatFeed(catalogEntry, parsed, {
      expectedAccountId: existingIngestion && existingIngestion.platformAccountId,
    });
    const committed = store.commitWechatCatalogActivation({
      catalogKey: key,
      feedUrl: catalogEntry.feedUrl,
      name: catalogEntry.name,
      siteUrl: catalogEntry.siteUrl || parsed.feedSiteUrl,
      description: catalogEntry.description || parsed.feedDescription,
      platformAccountId: verified.platformAccountId,
      sourceId,
      existingSourceId: existing && existing.id,
      entries: verified.entries,
      explicitRestore: restore,
      nowAt: now(),
    });

    if (!committed.alreadyActivated) {
      fetcher.recordIngestedSource(committed.source, committed.entries, {
        feedUrl: catalogEntry.feedUrl,
        feedTitle: parsed.feedTitle,
      });
    }
    const source = fetcher.getSourceById(committed.source.id)
      || store.getCustomSourceById(committed.source.id, { includeArchived: true });
    return {
      source,
      created: committed.created,
      restored: committed.restored,
      alreadyActivated: committed.alreadyActivated,
      entryCount: committed.entries.length,
      activationCutoff: committed.activationCutoff,
      contentScope: 'feed-body/summary/unknown',
      historyCoverage: '当前供给窗口之外的更早历史暂无已验证入口',
    };
  }

  return { activateWechatCatalogKey };
}

module.exports = { createSourceIngestion, verifyWechatFeed };
