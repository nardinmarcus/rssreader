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

// The fetcher retains transport/security policy and durable original updates.
// Intent makes the two existing short-official-context policies explicit.
function createAiInputPreparation({ fetcher, intent, wake = () => {}, logger = console }) {
  if (intent !== 'interactive' && intent !== 'background') throw new Error('Unknown AI preparation intent');
  return async function prepareEntryForAiAsset(entry, reason = 'AI asset', { productHuntOfficialSite = true } = {}) {
    if (productHuntOfficialSite && entry && entry.sourceId === 'producthunt') {
      try {
        const officialSiteContext = await fetcher.fetchProductHuntOfficialContext(entry);
        if (officialSiteContext && entryPlainText({ content: officialSiteContext.content, summary: officialSiteContext.summary }).length >= 80) {
          logger.log(`${reason}: fetched Product Hunt official-site context for ${entry.id}`);
          if (intent === 'interactive') wake();
          return {
            entry: {
              ...entry,
              officialSiteContext,
            },
            fetched: true,
            officialSiteFetched: true,
          };
        }
        if (intent === 'background') {
          return {
            entry, fetched: false, officialSiteFetched: false,
            error: 'Product Hunt 官网正文不足，未使用 RSS 摘要替代',
          };
        }
      } catch (error) {
        logger.warn(`${reason}: Product Hunt official-site context skipped for ${entry.id}:`, error.message || error);
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
        logger.log(`${reason}: fetched original content for ${entry.id}`);
        if (intent === 'interactive') wake();
        return { entry: updated, fetched: true };
      }
    } catch (error) {
      logger.warn(`${reason}: original content auto-fetch skipped for ${entry.id}:`, error.message || error);
      return {
        entry,
        fetched: false,
        error: String(error.message || error).slice(0, 200),
      };
    }
    return { entry: fetcher.getEntryById(entry.id) || entry, fetched: false };
  };
}

module.exports = { createAiInputPreparation, plainText, entryPlainText };
