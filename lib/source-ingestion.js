const crypto = require('crypto');

const INITIAL_ACTIVATION_WINDOW = 30;

function ingestionError(message, statusCode = 422, code = 'invalid-wechat-feed') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function publicCatalogSupplierError(error, platform = 'wechat') {
  const statusCode = Number(error && error.statusCode);
  if (Number(error && error.response && error.response.status) !== statusCode) return error;
  const label = platform === 'podcast' ? '播客' : '公众号';
  const prefix = platform === 'podcast' ? 'podcast' : 'wechat';
  const publicErrors = {
    403: [`供给方拒绝读取该${label}订阅源，请核对目录条目后重试。`, `${prefix}-feed-forbidden`],
    404: [`供给方未找到该${label}订阅源，请核对目录条目后重试。`, `${prefix}-feed-not-found`],
    429: ['供给方暂时限制请求，请稍后重试。', `${prefix}-feed-rate-limited`],
  };
  const mapped = publicErrors[statusCode];
  return mapped ? ingestionError(mapped[0], statusCode, mapped[1]) : error;
}

function normalizedAccountName(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（(](?:微信公众号|公众号|微信|小宇宙|播客|podcast|rss|订阅)[^）)]*[）)]/gi, '')
    .replace(/(?:[-_·|：:]?\s*)(?:微信公众号|公众号|微信订阅|rss订阅|rss)$/i, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function xiaoyuzhouPidFromUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'xiaoyuzhoufm.com') {
      const match = /^\/podcast\/([a-f0-9]{24})(?:\/|$)/i.exec(url.pathname);
      return match ? match[1].toLowerCase() : '';
    }
    if (host === 'media.xyzcdn.net' || host === 'image.xyzcdn.net') {
      const match = /^\/([a-f0-9]{24})\//i.exec(url.pathname);
      return match ? match[1].toLowerCase() : '';
    }
    return '';
  } catch {
    return '';
  }
}

function verifyXyzfmFeed(catalogEntry, parsed, { expectedPid = '' } = {}) {
  const rawPid = String(expectedPid || (catalogEntry && (catalogEntry.pid || catalogEntry.referencePid)) || '').trim().toLowerCase();
  const pid = rawPid.startsWith('xiaoyuzhou:') ? rawPid.slice('xiaoyuzhou:'.length) : rawPid;
  if (!/^[a-f0-9]{24}$/.test(pid)) {
    throw ingestionError('invalid Xiaoyuzhou podcast identity', 400, 'invalid-catalog-key');
  }

  const channelUrls = [
    parsed && parsed.feedSiteUrl,
    parsed && parsed.feedLink,
    parsed && parsed.feedImage,
    parsed && parsed.feedUrl,
  ].filter(Boolean);
  let hasMatchingChannelPid = false;
  for (const url of channelUrls) {
    const seenPid = xiaoyuzhouPidFromUrl(url);
    if (seenPid && seenPid !== pid) {
      throw ingestionError('播客频道身份与所选节目不一致，未接入来源。', 422, 'podcast-channel-mismatch');
    }
    if (seenPid === pid) hasMatchingChannelPid = true;
  }
  if (!hasMatchingChannelPid) {
    throw ingestionError('播客频道身份与所选节目不一致，未接入来源。', 422, 'podcast-channel-mismatch');
  }

  const expectedNames = (
    Array.isArray(catalogEntry && catalogEntry.expectedTitles) && catalogEntry.expectedTitles.length
      ? catalogEntry.expectedTitles
      : [catalogEntry && catalogEntry.name]
  )
    .map(normalizedAccountName)
    .filter(Boolean);
  const actualName = normalizedAccountName(parsed && parsed.feedTitle);
  if (expectedNames.length && (!actualName || !expectedNames.includes(actualName))) {
    throw ingestionError('播客频道名称与所选节目不一致，未接入来源。', 422, 'podcast-channel-mismatch');
  }

  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  if (!entries.length) {
    throw ingestionError('播客订阅源暂无可用单集，未接入来源。', 422, 'podcast-empty-feed');
  }

  const expectedPrefix = `xiaoyuzhou:${pid}:episode:`;
  const episodeLinkPattern = /^https?:\/\/(?:www\.)?xiaoyuzhoufm\.com\/episode\/[A-Za-z0-9_-]{6,80}(?:[/?#]|$)/i;
  const identities = new Set();
  for (const entry of entries) {
    const identity = String(entry && entry.platformIdentity || '').trim();
    if (!identity || !identity.startsWith(expectedPrefix)) {
      throw ingestionError('播客单集缺少可验证的小宇宙单集身份，未接入来源。', 422, 'podcast-episode-mismatch');
    }
    const entryLink = String(entry && entry.link || '').trim();
    if (entryLink && !episodeLinkPattern.test(entryLink)) {
      throw ingestionError('播客单集缺少可验证的小宇宙单集身份，未接入来源。', 422, 'podcast-episode-mismatch');
    }
    const audioPid = entry && entry.audio && entry.audio.url ? xiaoyuzhouPidFromUrl(entry.audio.url) : '';
    if (audioPid && audioPid !== pid) {
      throw ingestionError('播客音频归属与所选节目不一致，未接入来源。', 422, 'podcast-episode-mismatch');
    }
    identities.add(identity);
  }
  if (!identities.size) {
    throw ingestionError('播客订阅源暂无可用单集，未接入来源。', 422, 'podcast-empty-feed');
  }
  return { entries, platformAccountId: pid };
}

function normalizedFeedUrlForCompare(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function computePodcastScopeStatus(entryCount, platformDeclaredCount) {
  if (platformDeclaredCount == null || !Number.isFinite(Number(platformDeclaredCount))) {
    return 'unknown';
  }
  return Number(entryCount) === Number(platformDeclaredCount) ? 'aligned_count' : 'mismatch';
}

function verifyPodcastFeed(verifiedShow, parsed, { finalUrl = '', expectedAccountId = '', validateName = true } = {}) {
  if (!verifiedShow || typeof verifiedShow !== 'object') {
    throw ingestionError('verified podcast configuration is required', 404, 'podcast-config-missing');
  }
  const cleanFinalUrl = normalizedFeedUrlForCompare(finalUrl);
  const allowedUrls = (Array.isArray(verifiedShow.allowedFinalFeedUrls) ? verifiedShow.allowedFinalFeedUrls : [])
    .map(normalizedFeedUrlForCompare)
    .filter(Boolean);
  if (cleanFinalUrl && allowedUrls.length && !allowedUrls.includes(cleanFinalUrl)) {
    throw ingestionError('podcast feed redirected to an unverified location', 422, 'podcast-redirect-mismatch');
  }

  const podcastGuid = String(parsed && parsed.podcastGuid || '').trim();
  if (expectedAccountId && podcastGuid && podcastGuid !== expectedAccountId) {
    throw ingestionError('podcast feed identity does not match the registered show', 409, 'podcast-account-mismatch');
  }

  const expectedTitles = new Set(
    [
      verifiedShow.name,
      ...(Array.isArray(verifiedShow.expectedTitles) ? verifiedShow.expectedTitles : []),
    ]
      .map(normalizedAccountName)
      .filter(Boolean),
  );
  const actualTitle = normalizedAccountName(parsed && parsed.feedTitle);
  const titleMatches = Boolean(actualTitle && expectedTitles.has(actualTitle));
  if ((validateName || !podcastGuid) && !titleMatches) {
    throw ingestionError('podcast feed identity does not match the selected verified show', expectedAccountId ? 409 : 422, 'podcast-account-mismatch');
  }

  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  if (!entries.length) {
    throw ingestionError('podcast feed contains no readable episodes', 422, 'invalid-podcast-feed');
  }
  for (const entry of entries) {
    const identity = String(entry && entry.platformIdentity || '');
    const validHashedIdentity = /^podcast:[^:]+:(?:guid|url):[a-f0-9]+$/i.test(identity);
    const validPlainPodcastIdentity = /^podcast:guid:.+$/i.test(identity) || Boolean(entry && (entry.guid || entry.link));
    if (!entry || (!validHashedIdentity && !validPlainPodcastIdentity)) {
      throw ingestionError('podcast feed contains an episode without a stable GUID or canonical URL identity', 422, 'invalid-podcast-feed');
    }
  }
  if (!entries.some(entry => entry && entry.audio && /^https?:\/\//i.test(String(entry.audio.url || '')))) {
    throw ingestionError('podcast feed contains no playable audio enclosures', 422, 'invalid-podcast-feed');
  }

  return {
    entries,
    platformAccountId: String(verifiedShow.platformAccountId || podcastGuid || expectedAccountId || verifiedShow.pid || ''),
  };
}

function verifyRegisteredFeed({
  ingestion,
  verifiedShow = null,
  sourceName = '',
  feedTitle = '',
  feedLink = '',
  feedSiteUrl = '',
  feedImage = '',
  podcastGuid = '',
  entries = [],
  finalUrl = '',
} = {}) {
  if (!ingestion) return null;
  if (ingestion.platform === 'wechat') {
    return verifyWechatFeed(
      { name: sourceName },
      { feedTitle, entries },
      {
        expectedAccountId: ingestion.platformAccountId,
        validateName: !ingestion.platformAccountId,
      },
    );
  }
  if (ingestion.platform === 'xiaoyuzhou' || (verifiedShow && verifiedShow.verificationType === 'xyzfm')) {
    return verifyXyzfmFeed(
      verifiedShow || { name: sourceName, pid: ingestion.platformAccountId },
      { feedTitle, feedLink, feedSiteUrl, feedImage, feedUrl: finalUrl, entries },
      { expectedPid: (verifiedShow && verifiedShow.pid) || ingestion.platformAccountId },
    );
  }
  if (ingestion.platform === 'podcast') {
    return verifyPodcastFeed(
      verifiedShow,
      { feedTitle, podcastGuid, entries },
      {
        finalUrl,
        expectedAccountId: ingestion.platformAccountId,
        validateName: !ingestion.platformAccountId,
      },
    );
  }
  return null;
}

async function probeSingleAudioEnclosure(audioUrl, fetchBuffer) {
  const opts = {
    timeout: 8000,
    maxBytes: 4096,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NamooReader/1.0)',
      Accept: 'audio/*,*/*;q=0.8',
    },
  };
  let response = await fetchBuffer(audioUrl, { ...opts, method: 'HEAD' });
  if (!response || response.status === 405 || response.status === 501) {
    response = await fetchBuffer(audioUrl, {
      ...opts,
      method: 'GET',
      headers: { ...opts.headers, Range: 'bytes=0-1023' },
    });
  }
  if (!response || (response.status !== 200 && response.status !== 206)) {
    throw ingestionError('播客音频不可访问，暂不能作为可上线来源', 422, 'podcast-audio-unavailable');
  }
  const contentType = typeof response.headers?.get === 'function'
    ? String(response.headers.get('content-type') || '').toLowerCase()
    : '';
  if (contentType && /text\/html|application\/(?:xhtml\+)?xml|application\/json/i.test(contentType)) {
    throw ingestionError('播客音频地址未返回有效音频响应', 422, 'podcast-audio-unavailable');
  }
}

async function verifyPodcastAudioAvailability(entries = [], { fetchBuffer, newestEntriesFn } = {}) {
  if (typeof fetchBuffer !== 'function') return;
  const ordered = typeof newestEntriesFn === 'function'
    ? newestEntriesFn(entries, entries.length)
    : entries.slice();
  const withAudio = ordered.filter(entry => entry && entry.audio && /^https?:\/\//i.test(String(entry.audio.url || '')));
  if (!withAudio.length) {
    throw ingestionError('podcast feed contains no playable audio enclosures', 422, 'podcast-audio-unavailable');
  }
  const samples = [withAudio[0]];
  if (withAudio.length > 1) {
    const oldest = withAudio[withAudio.length - 1];
    if (oldest.audio.url !== withAudio[0].audio.url) samples.push(oldest);
  }
  for (const sample of samples) {
    try {
      await probeSingleAudioEnclosure(sample.audio.url, fetchBuffer);
    } catch (error) {
      if (error && error.code === 'podcast-audio-unavailable') throw error;
      if (error && error.statusCode === 400) throw error;
      throw ingestionError('播客音频样本核验失败，暂不能作为可上线来源', 422, 'podcast-audio-unavailable');
    }
  }
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
    if (/^wechat:/.test(key)) {
      return sourceDiscovery.findLegacyWechatSourceByCatalogKey(key);
    }
    return null;
  }

  async function activateCatalogKey(keyValue, { restore = false } = {}) {
    const rawKey = String(keyValue || '').trim();
    const verifiedShow = typeof sourceDiscovery.resolveVerifiedShowConfig === 'function'
      ? sourceDiscovery.resolveVerifiedShowConfig(rawKey)
      : (typeof sourceDiscovery.resolveVerifiedShow === 'function'
        ? sourceDiscovery.resolveVerifiedShow(rawKey, { requireFeed: true })
        : null);
    const isWechat = /^wechat:[A-Za-z0-9_-]{6,80}$/.test(rawKey);
    const key = verifiedShow ? verifiedShow.key : rawKey;
    if (!isWechat && !verifiedShow) {
      const status = /^podcast:[a-z0-9_-]{3,80}$/.test(rawKey) ? 422 : 400;
      const code = status === 422 ? 'podcast-activation-unsupported' : 'invalid-catalog-key';
      const message = status === 422 ? '该播客来源暂未配置已核验订阅源' : 'invalid catalog key';
      throw ingestionError(message, status, code);
    }
    if (inFlight.has(key)) return inFlight.get(key);
    const task = activateOnce(key, {
      platform: verifiedShow ? 'podcast' : 'wechat',
      restore: restore === true,
      verifiedShow,
    });
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
    }
  }

  async function activateWechatCatalogKey(keyValue, { restore = false } = {}) {
    const key = String(keyValue || '').trim();
    if (!/^wechat:[A-Za-z0-9_-]{6,80}$/.test(key)) {
      throw ingestionError('invalid WeChat catalog key', 400, 'invalid-catalog-key');
    }
    return activateCatalogKey(key, { restore });
  }

  async function activateOnce(key, { platform, restore, verifiedShow = null }) {
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
        platform,
      };
    }
    if (existing && existing.archivedAt && !restore) {
      throw ingestionError(
        'source is archived; explicit restore is required',
        409,
        verifiedShow ? 'podcast-source-archived' : 'wechat-source-archived',
      );
    }

    let catalogEntry = verifiedShow
      ? {
        key: verifiedShow.key,
        name: verifiedShow.name,
        feedUrl: verifiedShow.verifiedFeedUrl || verifiedShow.feedUrl,
        siteUrl: verifiedShow.siteUrl || '',
        description: verifiedShow.description || '',
      }
      : null;
    if (!catalogEntry) {
      await sourceDiscovery.ensureSourceCatalogFresh();
      catalogEntry = sourceDiscovery.resolveWechatCatalogEntry(key);
      if (!catalogEntry) throw ingestionError('WeChat catalog entry is unavailable', 404, 'wechat-catalog-entry-not-found');
    }

    const sourceId = existing ? existing.id : `custom-${crypto.randomUUID()}`;
    let parsed;
    try {
      if (verifiedShow && verifiedShow.usePodcastRssHeaders && typeof fetcher.readPodcastFeedForIngestion === 'function') {
        parsed = await fetcher.readPodcastFeedForIngestion(catalogEntry, sourceId);
      } else if (typeof fetcher.readFeedForIngestion === 'function') {
        parsed = await fetcher.readFeedForIngestion(catalogEntry, sourceId, {
          category: verifiedShow ? verifiedShow.category : 'article',
          catalogKey: key,
        });
      } else {
        parsed = await fetcher.readWechatFeedForIngestion(catalogEntry, sourceId);
      }
    } catch (error) {
      throw publicCatalogSupplierError(error, platform);
    }

    const verified = verifiedShow
      ? (verifiedShow.verificationType === 'xyzfm'
        ? verifyXyzfmFeed(verifiedShow, parsed, {
          expectedPid: verifiedShow.pid || (existingIngestion && existingIngestion.platformAccountId),
        })
        : verifyPodcastFeed(verifiedShow, parsed, {
          finalUrl: parsed.feedUrl,
          expectedAccountId: existingIngestion && existingIngestion.platformAccountId,
        }))
      : verifyWechatFeed(catalogEntry, parsed, {
        expectedAccountId: existingIngestion && existingIngestion.platformAccountId,
      });

    if (verifiedShow && verifiedShow.verifyAudioOnActivation && typeof fetcher.fetchPublicBuffer === 'function') {
      await verifyPodcastAudioAvailability(verified.entries, {
        fetchBuffer: fetcher.fetchPublicBuffer,
        newestEntriesFn: fetcher.newestEntries,
      });
    }

    let probe = { platformDeclaredCount: null, platformVerifiedAt: null };
    if (verifiedShow && verifiedShow.probeDeclaredCount && verifiedShow.referencePlatform === 'xiaoyuzhou'
        && typeof fetcher.probeXiaoyuzhouDeclaredCount === 'function') {
      probe = await fetcher.probeXiaoyuzhouDeclaredCount(verifiedShow).catch(() => ({
        platformDeclaredCount: null,
        platformVerifiedAt: null,
      }));
    }
    const scopeStatus = verifiedShow && verifiedShow.probeDeclaredCount
      ? computePodcastScopeStatus(verified.entries.length, probe.platformDeclaredCount)
      : 'unknown';

    const immediateEntries = verified.entries.length > INITIAL_ACTIVATION_WINDOW && typeof fetcher.newestEntries === 'function'
      ? fetcher.newestEntries(verified.entries, INITIAL_ACTIVATION_WINDOW)
      : verified.entries;
    const commitFn = typeof store.commitCatalogActivation === 'function'
      ? store.commitCatalogActivation
      : store.commitWechatCatalogActivation;
    const committed = commitFn({
      platform,
      catalogKey: key,
      feedUrl: catalogEntry.feedUrl,
      resolvedFeedUrl: parsed.feedUrl || catalogEntry.feedUrl,
      name: catalogEntry.name,
      siteUrl: verifiedShow
        ? (verifiedShow.probeDeclaredCount ? (catalogEntry.siteUrl || parsed.feedSiteUrl) : (parsed.feedSiteUrl || catalogEntry.siteUrl))
        : (catalogEntry.siteUrl || parsed.feedSiteUrl),
      description: catalogEntry.description || parsed.feedDescription,
      category: verifiedShow ? (verifiedShow.category || 'podcast') : 'article',
      labels: verifiedShow && Array.isArray(verifiedShow.labels) ? verifiedShow.labels : [],
      platformAccountId: verified.platformAccountId,
      platformDeclaredCount: probe.platformDeclaredCount,
      platformVerifiedAt: probe.platformVerifiedAt,
      scopeStatus,
      sourceId,
      existingSourceId: existing && existing.id,
      entries: immediateEntries,
      explicitRestore: restore,
      nowAt: now(),
    });

    if (parsed.headers && typeof fetcher.saveFeedHttpCache === 'function') {
      fetcher.saveFeedHttpCache(catalogEntry.feedUrl, parsed.headers);
    }
    if (!committed.alreadyActivated) {
      fetcher.recordIngestedSource(committed.source, committed.entries, {
        feedUrl: catalogEntry.feedUrl,
        feedTitle: parsed.feedTitle,
      });
    }
    if (parsed.rawBuffer) {
      try {
        await require('./source-backfill').discoverFromFeed({
          source: { ...committed.source, catalogKey: key },
          feedUrl: catalogEntry.feedUrl,
          rawBuffer: parsed.rawBuffer,
          xml: parsed.xml || '',
          feed: parsed.feed || null,
          cutoffAt: committed.activationCutoff,
          fetcherImpl: fetcher,
        });
      } catch (error) {
        console.warn(`[source-backfill] activation discovery skipped for ${committed.source.id}:`, error && error.message || error);
      }
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
      platform,
      contentScope: verifiedShow
        ? (verifiedShow.verificationType === 'xyzfm' ? 'show-notes' : 'show-notes/unknown')
        : 'feed-body/summary/unknown',
      historyCoverage: verifiedShow
        ? (verifiedShow.verificationType === 'xyzfm'
          ? '已加入所选 RSS 公开单集后台回填队列'
          : (verifiedShow.probeDeclaredCount
            ? '仅基于官网 RSS，与小宇宙范围尚未对齐'
            : '当前供给窗口之外的更早历史暂无已验证入口'))
        : '当前供给窗口之外的更早历史暂无已验证入口',
    };
  }

  function getCatalogSourceStatus(keyValue) {
    const rawKey = String(keyValue || '').trim();
    const verifiedShow = typeof sourceDiscovery.resolveVerifiedShowConfig === 'function'
      ? sourceDiscovery.resolveVerifiedShowConfig(rawKey)
      : null;
    const key = verifiedShow ? verifiedShow.key : rawKey;
    const existing = sourceForCatalogKey(key);
    const source = existing ? fetcher.getSourceById(existing.id) : null;
    const online = Boolean(existing && !existing.archivedAt && source && fetcher.isEnabled(source));
    return {
      source: existing || null,
      online,
      archived: Boolean(existing && existing.archivedAt),
    };
  }

  return { activateCatalogKey, activateWechatCatalogKey, getCatalogSourceStatus };
}

module.exports = {
  createSourceIngestion,
  verifyWechatFeed,
  verifyXyzfmFeed,
  verifyPodcastFeed,
  verifyRegisteredFeed,
  verifyPodcastAudioAvailability,
  computePodcastScopeStatus,
  xiaoyuzhouPidFromUrl,
};
