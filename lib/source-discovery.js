// Source discovery: read-only catalog snapshot, verified show registry, and
// public projection for the discovery overlay. This slice never activates
// sources and never fetches per-account feeds; browse/search reads the
// persisted snapshot or one merged catalog refresh.
const crypto = require('crypto');

const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/ginobefun/BestBlogs/main/opml/bestblogs_wechat2rss_opml_all.opml';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CATALOG_ENTRIES = 5000;
const MAX_STRUCTURE_TAGS = 20000;
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_TAG_SCAN_LENGTH = 8192;
const DEFAULT_CURSOR_LIMIT = 1000000;
const WECHAT_PLATFORM = 'wechat';
const PODCAST_PLATFORM = 'podcast';

// Verified show registry (PRD #26 research evidence). Identity is platform +
// stable show key; feed URLs stay server-side and are never projected. A show
// with a sourceId is already online in the existing reading workspace.
const VERIFIED_SHOWS = [
  {
    key: 'podcast:xiaojun-shangye-fangtanlu',
    platform: PODCAST_PLATFORM,
    name: '张小珺商业访谈录',
    sourceId: 'xiaojunpodcast',
    siteUrl: 'https://www.youtube.com/@xiaojunpodcast',
    description: '商业、科技与创新人物的深度访谈（已上线）',
  },
  {
    key: 'podcast:42zhangjing',
    platform: PODCAST_PLATFORM,
    name: '42章经',
    description: '商业与科技领域的深度讨论节目',
  },
  {
    key: 'podcast:wandianliao',
    platform: PODCAST_PLATFORM,
    name: '晚点聊',
    siteUrl: 'https://podcast.latepost.com',
    description: '晚点LatePost 出品的对话节目',
  },
  {
    key: 'podcast:bannatie',
    platform: PODCAST_PLATFORM,
    name: '半拿铁',
    description: '商业案例与公司故事科普节目',
  },
];

function catalogError(code, message, statusCode = 502) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const NAMED_XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
};

function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (Object.prototype.hasOwnProperty.call(NAMED_XML_ENTITIES, entity)) return NAMED_XML_ENTITIES[entity];
    const codePoint = entity[0] === '#'
      ? (entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10))
      : NaN;
    if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return '';
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return '';
    }
  });
}

function sanitizeCatalogName(value) {
  const withoutTags = String(value || '').replace(/<[^>]*>/g, ' ');
  const withoutControl = [...withoutTags]
    .filter(character => {
      const code = character.codePointAt(0);
      return code >= 32 || code === 9;
    })
    .join('');
  return withoutControl.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function normalizeCatalogUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

// Stable catalog key: platform plus supplier feed identity when the URL shape
// is recognized, otherwise a digest of the normalized feed URL.
function wechatCatalogKey(feedUrl) {
  const match = /\/feed\/([A-Za-z0-9_-]{6,80})(?:\.xml)?$/.exec(new URL(feedUrl).pathname);
  if (match) return `${WECHAT_PLATFORM}:${match[1]}`;
  return `${WECHAT_PLATFORM}:${crypto.createHash('sha256').update(feedUrl).digest('hex').slice(0, 32)}`;
}

function parseAttribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
    || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
  return match ? decodeXmlEntities(match[1]) : '';
}

// Bounded, entity-free, structurally correct OPML validation and outline
// extraction. The parser never resolves external entities: any DOCTYPE/ENTITY
// declaration is rejected outright. A single quote-aware scan validates the
// whole document — one opml root, balanced elements, whitespace-only text
// nodes, comments and processing instructions skipped — so damaged input can
// never replace the last good snapshot with a partial catalog.
function parseOpmlCatalog(text) {
  if (!text || !String(text).trim()) {
    throw catalogError('catalog-empty-response', 'catalog response was empty');
  }
  const body = String(text);
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) {
    throw catalogError('catalog-unsafe-xml', 'catalog response declares entities');
  }
  if (!/<opml[\s>]/i.test(body)) {
    throw catalogError('catalog-malformed', 'catalog response is not OPML');
  }

  const entries = [];
  const seenFeedUrls = new Set();
  let duplicates = 0;
  let skipped = 0;
  const stack = [];
  let opmlRootSeen = false;
  let opmlRootClosed = false;
  let scanned = 0;
  let cursor = 0;

  const recordOutline = (tagInner) => {
    if (!stack.includes('body')) {
      throw catalogError('catalog-malformed', 'outline element outside of body');
    }
    if (entries.length >= MAX_CATALOG_ENTRIES) {
      throw catalogError('catalog-too-large', 'catalog response exceeds the catalog limits');
    }
    const type = parseAttribute(tagInner, 'type');
    if (type && type.toLowerCase() !== 'rss') return;
    const feedUrl = normalizeCatalogUrl(parseAttribute(tagInner, 'xmlUrl'));
    const name = sanitizeCatalogName(parseAttribute(tagInner, 'title') || parseAttribute(tagInner, 'text'));
    if (!feedUrl || !name) {
      skipped += 1;
      return;
    }
    if (seenFeedUrls.has(feedUrl)) {
      duplicates += 1;
      return;
    }
    seenFeedUrls.add(feedUrl);
    const siteUrl = normalizeCatalogUrl(parseAttribute(tagInner, 'htmlUrl')) || '';
    entries.push({
      key: wechatCatalogKey(feedUrl),
      platform: WECHAT_PLATFORM,
      name,
      feedUrl,
      siteUrl,
      description: '',
    });
  };

  while (cursor < body.length) {
    if (scanned >= MAX_STRUCTURE_TAGS) {
      throw catalogError('catalog-too-large', 'catalog response exceeds the scan limits');
    }
    const lt = body.indexOf('<', cursor);
    if (lt === -1) {
      if (/\S/.test(body.slice(cursor))) {
        throw catalogError('catalog-malformed', 'catalog response has content after the opml root');
      }
      break;
    }
    // Character data is only valid inside head-level leaf elements. Body only
    // contains outline elements, and nothing may appear outside the root.
    if (/\S/.test(body.slice(cursor, lt)) && (stack.includes('body') || !stack.length || stack[stack.length - 1] === 'opml')) {
      throw catalogError('catalog-malformed', 'catalog response contains unexpected text content');
    }
    if (body.startsWith('<!--', lt)) {
      const commentEnd = body.indexOf('-->', lt + 4);
      if (commentEnd === -1) {
        throw catalogError('catalog-malformed', 'catalog response contains an unterminated comment');
      }
      scanned += 1;
      cursor = commentEnd + 3;
      continue;
    }
    if (body.startsWith('<?', lt)) {
      const instructionEnd = body.indexOf('?>', lt + 2);
      if (instructionEnd === -1) {
        throw catalogError('catalog-malformed', 'catalog response contains an unterminated processing instruction');
      }
      scanned += 1;
      cursor = instructionEnd + 2;
      continue;
    }
    const tagEnd = findTagEnd(body, lt);
    if (tagEnd === -1) {
      // A tag that never closes within the bounded window is malformed input:
      // failing loudly protects the previous snapshot.
      throw catalogError('catalog-malformed', 'catalog response contains an unterminated tag');
    }
    scanned += 1;
    const inner = body.slice(lt + 1, tagEnd);
    cursor = tagEnd + 1;
    if (inner[0] === '/') {
      const closingName = inner.slice(1).trim().toLowerCase();
      if (!stack.length || stack[stack.length - 1] !== closingName) {
        throw catalogError('catalog-malformed', 'catalog response has mismatched closing tags');
      }
      stack.pop();
      if (closingName === 'opml') opmlRootClosed = true;
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9._-]*)/.exec(inner);
    if (!nameMatch) {
      throw catalogError('catalog-malformed', 'catalog response contains an invalid tag');
    }
    const name = nameMatch[1].toLowerCase();
    if (name === 'opml') {
      if (stack.length || opmlRootSeen) {
        throw catalogError('catalog-malformed', 'catalog response has duplicate or nested opml roots');
      }
      opmlRootSeen = true;
    }
    if (name === 'body' || name === 'head') {
      if (stack.includes(name)) {
        throw catalogError('catalog-malformed', `catalog response has duplicate ${name} elements`);
      }
    }
    if (name === 'outline') recordOutline(inner);
    if (!selfClosing) stack.push(name);
  }

  if (!opmlRootSeen) {
    throw catalogError('catalog-malformed', 'catalog response has no opml root');
  }
  if (stack.length) {
    throw catalogError('catalog-malformed', 'catalog response has unclosed elements');
  }
  if (!entries.length) {
    throw catalogError('catalog-empty-catalog', 'catalog response contained no valid entries');
  }
  return { entries, duplicates, skipped };
}

// First unquoted '>' after the tag opening, or -1 when the tag never closes
// within the bounded scan window.
function findTagEnd(body, start) {
  const limit = Math.min(body.length, start + MAX_TAG_SCAN_LENGTH);
  let inQuote = '';
  for (let index = start; index < limit; index += 1) {
    const character = body[index];
    if (inQuote) {
      if (character === inQuote) inQuote = '';
    } else if (character === '"' || character === '\'') {
      inQuote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function decodeCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return 0;
  const match = /^offset:([0-9]+)$/.exec(raw);
  if (!match) {
    throw catalogError('catalog-invalid-cursor', 'invalid catalog cursor', 400);
  }
  const offset = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(offset) || offset > DEFAULT_CURSOR_LIMIT) {
    throw catalogError('catalog-invalid-cursor', 'invalid catalog cursor', 400);
  }
  return offset;
}

function encodeCursor(offset) {
  return `offset:${offset}`;
}

function createSourceDiscovery({
  store,
  isSourceOnline = () => false,
  fetchCatalogText,
  feedUrl = String(process.env.SOURCE_CATALOG_FEED_URL || '').trim() || DEFAULT_FEED_URL,
  maxAgeMs = Number.parseInt(process.env.SOURCE_CATALOG_MAX_AGE_MS || `${DEFAULT_MAX_AGE_MS}`, 10),
  now = Date.now,
} = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) maxAgeMs = DEFAULT_MAX_AGE_MS;
  let refreshInFlight = null;

  function hasCatalogSnapshot(state) {
    return Number(state.lastSuccessAt) > 0 && state.entryCount > 0;
  }

  async function refreshSourceCatalog() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const attemptedAt = now();
      try {
        if (!fetchCatalogText) throw catalogError('catalog-transport-missing', 'catalog transport is not configured', 500);
        const text = await fetchCatalogText(feedUrl);
        const parsed = parseOpmlCatalog(text);
        store.replaceSourceCatalogSnapshot({
          entries: parsed.entries,
          feedUrl,
          duplicates: parsed.duplicates,
          skipped: parsed.skipped,
          updatedAt: now(),
          attemptedAt,
        });
        return { ok: true };
      } catch (error) {
        store.recordSourceCatalogRefreshFailure({ feedUrl, attemptedAt });
        console.warn(`[source-catalog] refresh failed: ${error && (error.code || error.message) || error}`);
        return { ok: false, error };
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  // A snapshot exists once a refresh has ever succeeded; a later failed
  // attempt must not make it disappear. Attempt spacing is bounded by the
  // durability of lastAttemptAt: cold start (never attempted) awaits one
  // merged refresh; stale snapshots trigger at most one background refresh
  // per freshness window, so the next daily retry is never blocked forever.
  async function ensureSourceCatalogFresh() {
    const state = store.getSourceCatalogState();
    const at = now();
    const attemptAge = state.lastAttemptAt == null ? Infinity : at - Number(state.lastAttemptAt);
    const canAttempt = attemptAge > maxAgeMs;
    if (!hasCatalogSnapshot(state)) {
      if (canAttempt) await refreshSourceCatalog();
      return;
    }
    const successAge = at - Number(state.lastSuccessAt);
    if (successAge > maxAgeMs && canAttempt && !refreshInFlight) {
      refreshSourceCatalog();
    }
  }

  function catalogMeta() {
    const state = store.getSourceCatalogState();
    if (!hasCatalogSnapshot(state)) {
      return { status: 'unavailable', updatedAt: null };
    }
    const failedAfterSuccess = state.lastStatus === 'failed'
      && Number(state.lastAttemptAt) > Number(state.lastSuccessAt);
    const stale = failedAfterSuccess
      || (Number.isFinite(maxAgeMs) && (now() - Number(state.lastSuccessAt)) > maxAgeMs);
    return {
      status: stale ? 'stale' : 'ok',
      updatedAt: new Date(Number(state.lastSuccessAt)).toISOString(),
    };
  }

  function projectShow(show, query) {
    if (query && !show.name.toLowerCase().includes(query)) return null;
    const online = Boolean(show.sourceId && isSourceOnline(show.sourceId));
    const projected = {
      key: show.key,
      platform: show.platform,
      name: show.name,
      online,
    };
    if (online) projected.sourceId = show.sourceId;
    if (show.siteUrl) projected.siteUrl = show.siteUrl;
    if (show.description) projected.description = show.description;
    return projected;
  }

  // Public projection: catalog key, platform, name, readable status, and safe
  // metadata only. Feed URLs, user data, and internal errors never appear.
  function getPublicSourceCatalog({ platform, q, cursor, limit } = {}) {
    const offset = decodeCursor(cursor);
    const pageSize = Number.parseInt(limit, 10);
    const safePageSize = Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(pageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const query = String(q || '').trim().toLowerCase();
    const requestedPlatform = String(platform || '').trim().toLowerCase();

    const total = store.countSourceCatalogEntries({ platform: requestedPlatform, q: query });
    const rows = store.listSourceCatalogEntries({
      platform: requestedPlatform,
      q: query,
      limit: safePageSize,
      offset,
    });
    const items = rows.map(row => ({
      key: row.key,
      platform: row.platform,
      name: row.name,
      online: false,
    }));

    const recommended = (requestedPlatform && requestedPlatform !== PODCAST_PLATFORM)
      ? []
      : VERIFIED_SHOWS
        .map(show => projectShow(show, query))
        .filter(Boolean);

    const consumed = offset + items.length;
    const nextCursor = consumed < total ? encodeCursor(consumed) : null;

    return {
      recommended,
      items,
      total,
      nextCursor,
      catalog: catalogMeta(),
    };
  }

  return {
    refreshSourceCatalog,
    ensureSourceCatalogFresh,
    getPublicSourceCatalog,
  };
}

module.exports = {
  createSourceDiscovery,
  parseOpmlCatalog,
  sanitizeCatalogName,
  VERIFIED_SHOWS,
  DEFAULT_FEED_URL,
};
