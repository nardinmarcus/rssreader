const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { SOURCES, RSSHUB_INSTANCES } = require('./sources');
const store = require('./store');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'cache.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const TIMEOUT_MS = 20000;
const CONCURRENCY = 8;
const USER_SUBMITTED_SOURCE_ID = 'user-submitted';

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 QMReader/1.0',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

// cache: { [sourceId]: { fetchedAt, feedUrl, status, error, entries: [] } }
let cache = {};
// state: { [sourceId]: { enabled } } user overrides
let state = {};

function loadDisk() {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
  for (const c of Object.values(cache)) {
    if (c && Array.isArray(c.entries)) store.upsertEntries(c.entries);
  }
}

let saveTimer = null;
function saveDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }, 500);
}

function isEnabled(source) {
  const o = state[source.id];
  return o && typeof o.enabled === 'boolean' ? o.enabled : source.enabled;
}

function setEnabled(id, enabled) {
  state[id] = { ...(state[id] || {}), enabled };
  saveDisk();
}

function expandCandidates(feeds) {
  const out = [];
  for (const f of feeds) {
    if (f.includes('{rsshub}')) {
      for (const base of RSSHUB_INSTANCES) out.push(f.replace('{rsshub}', base));
    } else {
      out.push(f);
    }
  }
  return out;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw || /^data:/i.test(raw)) return null;
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return /^https?:\/\//i.test(raw) ? raw : null;
  }
}

function firstImage(html, baseUrl = '') {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
  if (m) return absoluteUrl(m[1], baseUrl);
  return null;
}

function firstSrcsetUrl(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .find(Boolean) || '';
}

function normalizeSrcset(value, baseUrl) {
  return String(value || '')
    .split(',')
    .map(part => {
      const pieces = part.trim().split(/\s+/).filter(Boolean);
      const src = absoluteUrl(pieces[0], baseUrl);
      return src ? [src, ...pieces.slice(1)].join(' ') : '';
    })
    .filter(Boolean)
    .join(', ');
}

function removeArticleChrome($, root = $.root()) {
  const $root = root && typeof root.find === 'function' ? root : $(root || $.root());
  $root.find('script,style,noscript,iframe,object,embed,form,button,input,select,textarea,svg,canvas').remove();
  $root.find('.pencraft,.pc-reset,.icon-container,.image-link-expand,.view-image,[class*="image-link"],[class*="view-image"]').each((_, el) => {
    const node = $(el);
    if (!node.find('img').length && !node.text().replace(/\s+/g, '').trim()) node.remove();
  });
  $root.find('a,div,span').each((_, el) => {
    const node = $(el);
    if (node.find('img,video,audio,table,hr').length) return;
    if (node.text().replace(/\s+/g, '').trim()) return;
    node.remove();
  });
}

function normalizeFeedContent(html, baseUrl = '') {
  const raw = String(html || '');
  if (!raw) return '';
  const $ = cheerio.load(raw, { decodeEntities: false }, false);
  removeArticleChrome($);
  $('img').each((_, el) => {
    const img = $(el);
    const src = absoluteUrl(
      img.attr('src') || img.attr('data-src') || img.attr('data-original') || firstSrcsetUrl(img.attr('srcset')),
      baseUrl
    );
    if (src) img.attr('src', src);
    const srcset = normalizeSrcset(img.attr('srcset'), baseUrl);
    if (srcset) img.attr('srcset', srcset);
    else img.removeAttr('srcset');
  });
  $('a').each((_, el) => {
    const a = $(el);
    const href = absoluteUrl(a.attr('href'), baseUrl);
    if (href) a.attr('href', href);
  });
  return $.root().html() || raw;
}

function normalizeRenderedContent(html, baseUrl = '') {
  const raw = String(html || '');
  if (!raw) return '';
  const $ = cheerio.load(raw, { decodeEntities: false }, false);
  return cleanExtractedRoot($, $.root(), baseUrl)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function publicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const err = new Error('原文链接格式不正确');
    err.statusCode = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const err = new Error('只支持 http/https 原文链接');
    err.statusCode = 400;
    throw err;
  }
  const host = url.hostname.toLowerCase();
  const ipType = net.isIP(host);
  const blocked = host === 'localhost'
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || /^169\.254\./.test(host)
    || (ipType === 6 && /^(fc|fd|fe80):/i.test(host));
  if (blocked) {
    const err = new Error('原文链接不能指向本机或内网地址');
    err.statusCode = 400;
    throw err;
  }
  return url.toString();
}

function cleanExtractedRoot($, root, baseUrl) {
  const $root = root.clone();
  $root.find('script,style,noscript,iframe,object,embed,form,button,input,select,textarea,svg,canvas,nav,aside,footer,header').remove();
  removeArticleChrome($, $root);
  $root.find('[hidden],[aria-hidden="true"]').remove();
  $root.find('img').each((_, el) => {
    const img = $(el);
    const src = absoluteUrl(img.attr('src') || img.attr('data-src') || img.attr('data-original'), baseUrl);
    if (!src) {
      img.remove();
      return;
    }
    img.attr('src', src);
    img.removeAttr('srcset sizes loading decoding style class id width height data-src data-original');
  });
  $root.find('a').each((_, el) => {
    const a = $(el);
    const href = absoluteUrl(a.attr('href'), baseUrl);
    if (href) a.attr('href', href);
    else a.removeAttr('href');
    a.attr('target', '_blank');
    a.attr('rel', 'noopener noreferrer nofollow');
    a.removeAttr('style class id');
  });

  const allowed = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr']);
  $root.find('*').each((_, el) => {
    const node = $(el);
    const tag = String(el.name || '').toLowerCase();
    if (!allowed.has(tag)) {
      node.replaceWith(node.contents());
      return;
    }
    for (const attr of Object.keys(el.attribs || {})) {
      if (tag === 'a' && ['href', 'target', 'rel'].includes(attr)) continue;
      if (tag === 'img' && ['src', 'alt'].includes(attr)) continue;
      node.removeAttr(attr);
    }
  });
  return $root.html() || '';
}

function isPaulGrahamUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase() === 'paulgraham.com';
  } catch {
    return false;
  }
}

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};
const JAMES_CLEAR_NEWSLETTER_RE = /^\/3-2-1\/(january|february|march|april|may|june|july|august|september|october|november|december)-([1-9]|[12]\d|3[01])-(20\d{2})\/?$/i;

function jamesClearNewsletterTimestamp(value) {
  try {
    const url = new URL(value);
    if (url.hostname.replace(/^www\./, '').toLowerCase() !== 'jamesclear.com') return 0;
    const match = JAMES_CLEAR_NEWSLETTER_RE.exec(url.pathname);
    if (!match) return 0;
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return 0;
    return date.getTime();
  } catch {
    return 0;
  }
}

function isJamesClearNewsletterUrl(value) {
  return Boolean(jamesClearNewsletterTimestamp(value));
}

function extractPaulGrahamContent(html, baseUrl) {
  if (!isPaulGrahamUrl(baseUrl)) return null;
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const roots = [];
  $('td').each((_, el) => {
    const width = String($(el).attr('width') || '').trim();
    if (width === '435') roots.push($(el));
  });
  $('font').each((_, el) => {
    const face = String($(el).attr('face') || '');
    if (/verdana/i.test(face)) roots.push($(el));
  });

  const candidates = roots
    .map(root => {
      const cleaned = cleanExtractedRoot($, root, baseUrl);
      return { content: cleaned, textLength: stripHtml(cleaned).length };
    })
    .filter(c => c.textLength >= 80)
    .sort((a, b) => b.textLength - a.textLength);

  if (!candidates.length) return null;
  const content = candidates[0].content.replace(/\n{3,}/g, '\n\n').trim();
  const title = decodeEntities(
    metaContent(html, ['og:title', 'twitter:title'])
    || $('td[width="435"] img[alt]').first().attr('alt')
    || $('title').first().text()
    || ''
  ).replace(/\s+/g, ' ').trim();
  const metaImage = absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), baseUrl);
  return {
    title,
    content,
    summary: stripHtml(content).slice(0, 320),
    image: metaImage || firstImage(content, baseUrl),
  };
}

function extractJamesClearNewsletterContent(html, baseUrl) {
  if (!isJamesClearNewsletterUrl(baseUrl)) return null;
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const root = $('.container-outmargin__left .page__content').first();
  if (!root.length) return null;
  const content = cleanExtractedRoot($, root, baseUrl).replace(/\n{3,}/g, '\n\n').trim();
  if (stripHtml(content).length < 80) return null;
  const title = decodeEntities(
    metaContent(html, ['og:title', 'twitter:title'])
    || $('.container-outmargin__left h1').first().text()
    || $('title').first().text()
    || ''
  ).replace(/\s+/g, ' ').replace(/\s-\sJames Clear$/, '').trim();
  const metaImage = absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), baseUrl);
  return {
    title,
    content,
    summary: stripHtml(content).slice(0, 320),
    image: metaImage || firstImage(content, baseUrl),
  };
}

function extractReadableContent(html, baseUrl) {
  const jamesClear = extractJamesClearNewsletterContent(html, baseUrl);
  if (jamesClear && stripHtml(jamesClear.content).length >= 80) return jamesClear;

  const paulGraham = extractPaulGrahamContent(html, baseUrl);
  if (paulGraham && stripHtml(paulGraham.content).length >= 80) return paulGraham;

  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const title = decodeEntities(
    metaContent(html, ['og:title', 'twitter:title'])
    || $('title').first().text()
    || ''
  ).replace(/\s+/g, ' ').trim();
  const metaImage = absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), baseUrl);
  const candidates = [];
  $('article,[itemprop="articleBody"],main,.post-content,.entry-content,.article-content,.prose,.markdown-body').each((_, el) => {
    const root = $(el);
    const cleaned = cleanExtractedRoot($, root, baseUrl);
    const text = stripHtml(cleaned);
    if (text.length >= 80) candidates.push({ content: cleaned, textLength: text.length });
  });
  if (!candidates.length) {
    $('body').find('script,style,noscript,iframe,object,embed,form,button,input,select,textarea,svg,canvas,nav,aside,footer,header').remove();
    const paragraphs = [];
    $('body').find('h1,h2,h3,h4,p,blockquote,li,pre,img').each((_, el) => {
      const cleaned = cleanExtractedRoot($, $(el), baseUrl);
      if (stripHtml(cleaned).length >= 12 || /<img/i.test(cleaned)) paragraphs.push(cleaned);
    });
    const content = paragraphs.join('\n');
    const text = stripHtml(content);
    if (text.length >= 80) candidates.push({ content, textLength: text.length });
  }
  candidates.sort((a, b) => b.textLength - a.textLength);
  const content = (candidates[0] && candidates[0].content || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title,
    content,
    summary: stripHtml(content).slice(0, 320),
    image: metaImage || firstImage(content, baseUrl),
  };
}

function normalizeItem(item, source) {
  const link = item.link || item.guid || '';
  const baseUrl = link || source.siteUrl || '';
  const rawContent = item.contentEncoded || item['content:encoded'] || item.content || item.summary || item.description || '';
  const content = normalizeFeedContent(rawContent, baseUrl);
  const id = crypto.createHash('md5').update(source.id + '|' + (item.guid || link || item.title || '')).digest('hex');
  const text = stripHtml(content);
  let image = firstImage(content, baseUrl) || null;
  if (!image && item.itunes && item.itunes.image) image = item.itunes.image;
  if (!image && item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) image = item.mediaThumbnail.$.url;
  if (!image && Array.isArray(item.mediaContent)) {
    const mc = item.mediaContent.find(m => m.$ && m.$.url && /image|jpg|jpeg|png|webp/i.test((m.$.medium || '') + (m.$.type || '') + m.$.url));
    if (mc) image = mc.$.url;
  }
  image = absoluteUrl(image, baseUrl);
  let audio = null;
  if (item.enclosure && item.enclosure.url && /audio/i.test(item.enclosure.type || '')) {
    audio = { url: item.enclosure.url, type: item.enclosure.type };
  }
  const published = item.isoDate || item.pubDate || null;
  return {
    id,
    sourceId: source.id,
    title: stripHtml(item.title || '(无标题)').slice(0, 300) || '(无标题)',
    link,
    author: item.creator || item.author || (item.itunes && item.itunes.author) || '',
    published,
    publishedTs: published ? Date.parse(published) || 0 : 0,
    summary: text.slice(0, 320),
    content,
    image,
    audio,
  };
}

function hasFullEssayContent(entries) {
  return (entries || []).some(entry => stripHtml(entry.content).length >= 600);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

async function hydratePaulGrahamEntry(entry) {
  const originalLength = stripHtml(entry.content).length;
  if (!entry || !entry.link || !isPaulGrahamUrl(entry.link)) return entry;
  try {
    const url = publicHttpUrl(entry.link);
    const html = await fetchText(url, 15000);
    const extracted = extractReadableContent(html, url);
    const extractedLength = stripHtml(extracted.content).length;
    if (extractedLength < 80 || extractedLength < originalLength * 0.8) return entry;
    return {
      ...entry,
      title: entry.title || extracted.title || '(无标题)',
      summary: extracted.summary || entry.summary,
      content: extracted.content,
      image: extracted.image || entry.image,
    };
  } catch {
    return entry;
  }
}

async function hydrateSourceEntries(source, entries) {
  if (!source || source.id !== 'paulgraham') return entries;
  const hydrated = await mapLimit(entries, 4, hydratePaulGrahamEntry);
  if (!hasFullEssayContent(hydrated)) throw new Error('Paul Graham feed did not provide full essay content');
  return hydrated;
}

function storedEntryForCache(entry) {
  const stored = store.getEntry(entry.id);
  if (!stored) return entry;
  return {
    ...entry,
    ...stored,
    content: stored.content || entry.content || '',
    summary: stored.summary || entry.summary || '',
    image: stored.image || entry.image || null,
    audio: stored.audio || entry.audio || null,
  };
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchText(url, timeout = TIMEOUT_MS) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return res.text();
}

function updateCachedEntry(entryId, fields) {
  for (const c of Object.values(cache)) {
    const hit = (c.entries || []).find(e => e.id === entryId);
    if (!hit) continue;
    Object.assign(hit, fields);
    saveDisk();
    return hit;
  }
  return null;
}

async function fetchEntryOriginal(entry) {
  if (!entry || !entry.id) {
    const err = new Error('entry is required');
    err.statusCode = 400;
    throw err;
  }
  try {
    const url = publicHttpUrl(entry.link);
    const html = await fetchText(url, 30000);
    const extracted = extractReadableContent(html, url);
    if (!extracted.content || stripHtml(extracted.content).length < 80) {
      const err = new Error('没有从原文页面提取到可用正文');
      err.statusCode = 422;
      throw err;
    }
    const updated = store.updateEntryContent(entry.id, {
      content: extracted.content,
      summary: extracted.summary || entry.summary,
      image: extracted.image || entry.image,
      originalFetched: true,
    });
    if (updated) updateCachedEntry(entry.id, {
      content: updated.content,
      summary: updated.summary,
      image: updated.image,
      contentHash: updated.contentHash,
      originalFetchedAt: updated.originalFetchedAt,
      originalFetchAttemptedAt: updated.originalFetchAttemptedAt,
      originalFetchError: updated.originalFetchError,
    });
    return updated;
  } catch (error) {
    const marked = store.markEntryOriginalFetchAttempt(entry.id, error.message || error);
    if (marked) updateCachedEntry(entry.id, {
      originalFetchAttemptedAt: marked.originalFetchAttemptedAt,
      originalFetchError: marked.originalFetchError,
    });
    throw error;
  }
}

function normalizeSubmittedUrl(value) {
  const url = new URL(publicHttpUrl(value));
  url.hash = '';
  return url.toString();
}

function submittedFallbackContent({ title = '', description = '', url = '' } = {}) {
  const parts = [
    description ? `<p>${escapeHtmlForHtml(description)}</p>` : '',
    url ? `<p><a href="${escapeHtmlForHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtmlForHtml(url)}</a></p>` : '',
  ].filter(Boolean);
  return parts.join('\n') || `<p>${escapeHtmlForHtml(title || url || '读者提交链接')}</p>`;
}

function escapeHtmlForHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function submitLink(urlValue, user = {}, { note = '' } = {}) {
  const url = normalizeSubmittedUrl(urlValue);
  const html = await fetchText(url, 30000);
  const extracted = extractReadableContent(html, url);
  const metaDescription = decodeEntities(metaContent(html, ['og:description', 'twitter:description', 'description']) || '');
  const title = stripHtml(extracted.title || metaContent(html, ['og:title', 'twitter:title']) || url)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || url;
  const extractedTextLength = stripHtml(extracted.content).length;
  const summary = (extracted.summary || metaDescription || stripHtml(extracted.content) || title).slice(0, 320);
  const content = extractedTextLength >= 80
    ? extracted.content
    : submittedFallbackContent({ title, description: summary, url });
  const t = Date.now();
  const entry = {
    id: crypto.createHash('md5').update(`${USER_SUBMITTED_SOURCE_ID}|${url}`).digest('hex'),
    sourceId: USER_SUBMITTED_SOURCE_ID,
    title,
    link: url,
    author: user.displayName || user.email || '读者',
    published: new Date(t).toISOString(),
    publishedTs: t,
    summary,
    content,
    image: extracted.image || absoluteUrl(metaContent(html, ['og:image', 'twitter:image']), url) || firstImage(content, url),
    audio: null,
  };
  const saved = store.saveSubmittedEntry(entry, {
    userId: user.id || null,
    author: user.displayName || user.email || '读者',
    note,
  });
  cache[USER_SUBMITTED_SOURCE_ID] = manualSourceCache(getSourceById(USER_SUBMITTED_SOURCE_ID));
  saveDisk();
  return saved;
}

function manualSourceCache(source) {
  const entries = store.getSubmittedEntries({ limit: source && source.limit || 200 });
  const meta = store.getSubmissionMeta();
  return {
    fetchedAt: meta.latestAt || Date.now(),
    feedUrl: '',
    feedTitle: source && source.name || '读者提交',
    status: 'ok',
    error: null,
    entries,
  };
}

const SITEMAP_SKIP = /\/(archive|authors?|subscribe|upgrade|recommendations|tags?|privacy|terms|about|login|account|category|sitemap)(\/|$)|\/$/i;

function metaContent(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i')
      , re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i');
    const m = re.exec(html) || re2.exec(html);
    if (m) return m[1];
  }
  return null;
}

function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

function structuredDatePublished(html) {
  const match = /"datePublished"\s*:\s*"([^"]+)"/.exec(String(html || ''));
  return match ? decodeEntities(match[1]) : '';
}

function wpJsonDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
}

function wpJsonPublished(post) {
  const schemaGraph = post && post.yoast_head_json && post.yoast_head_json.schema && post.yoast_head_json.schema['@graph'];
  const schemaDate = Array.isArray(schemaGraph)
    ? (schemaGraph.find(node => node && node.datePublished) || {}).datePublished
    : '';
  return schemaDate || wpJsonDate(post && (post.date_gmt || post.date || post.modified_gmt));
}

function wpJsonImage(post) {
  const yoast = post && post.yoast_head_json;
  const image = yoast && Array.isArray(yoast.og_image) && yoast.og_image[0] && yoast.og_image[0].url;
  return image || (yoast && yoast.thumbnailUrl) || null;
}

function sitemapPublishedTimestamp(item, source) {
  if (source && source.id === 'james-clear') return jamesClearNewsletterTimestamp(item.loc);
  return Date.parse(item.lastmod || 0) || 0;
}

async function parseWpJsonFeed(url, source) {
  const text = await fetchText(url);
  const posts = JSON.parse(text);
  if (!Array.isArray(posts)) throw new Error('wpjson: expected an array of posts');
  const items = posts.map(post => {
    const link = post && post.link ? String(post.link) : '';
    const content = normalizeRenderedContent(post && post.content && post.content.rendered, link)
      || normalizeRenderedContent(post && post.excerpt && post.excerpt.rendered, link);
    const title = decodeEntities(stripHtml(post && post.title && post.title.rendered || '(无标题)'));
    const description = stripHtml(post && post.excerpt && post.excerpt.rendered || content).slice(0, 320);
    const image = absoluteUrl(wpJsonImage(post), link);
    const item = {
      title,
      link,
      guid: link,
      pubDate: wpJsonPublished(post),
      content,
      description,
    };
    if (image) item.mediaThumbnail = { $: { url: image } };
    return item;
  }).filter(item => item.link && (item.title || item.content));
  items.sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  if (!items.length) throw new Error('wpjson: no posts found');
  return { title: source.name, items };
}

// Fallback for beehiiv-style sites with no public RSS: walk sitemap.xml, fetch top pages for metadata.
async function parseSitemapFeed(url, source) {
  const xml = await fetchText(url);
  const urls = [];
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = blockRe.exec(xml))) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]);
    const mod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]);
    if (loc) urls.push({ loc: loc[1], lastmod: mod ? mod[1] : null });
  }
  let posts = [];
  if (source && source.id === 'james-clear') {
    posts = urls.filter(u => isJamesClearNewsletterUrl(u.loc));
  } else {
    posts = urls.filter(u => {
      try {
        const p = new URL(u.loc).pathname;
        return p.length > 1 && !SITEMAP_SKIP.test(p);
      } catch { return false; }
    });
    const withP = posts.filter(u => u.loc.includes('/p/'));
    if (withP.length) posts = withP;
  }
  posts.sort((a, b) => sitemapPublishedTimestamp(b, source) - sitemapPublishedTimestamp(a, source));
  const limit = Math.min(source.limit || 5, 30);
  const top = posts.slice(0, limit);
  const items = [];
  for (const u of top) {
    let title = decodeURIComponent(new URL(u.loc).pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]/g, ' ');
    let description = '', content = '', image = null;
    const slugTimestamp = sitemapPublishedTimestamp(u, source);
    let published = slugTimestamp ? new Date(slugTimestamp).toISOString() : u.lastmod;
    try {
      const html = await fetchText(u.loc, 12000);
      title = decodeEntities(metaContent(html, ['og:title', 'twitter:title']) || (/<title[^>]*>([^<]+)<\/title>/i.exec(html) || [])[1] || title);
      description = decodeEntities(metaContent(html, ['og:description', 'twitter:description', 'description']) || '');
      image = metaContent(html, ['og:image', 'twitter:image']);
      published = metaContent(html, ['article:published_time']) || structuredDatePublished(html) || published || u.lastmod;
      const extracted = extractReadableContent(html, u.loc);
      if (extracted && stripHtml(extracted.content).length >= 80) {
        title = extracted.title || title;
        description = extracted.summary || description;
        content = extracted.content;
        image = extracted.image || image;
      }
    } catch { /* keep slug-derived title */ }
    items.push({ title, link: u.loc, guid: u.loc, pubDate: published, content: content || (description ? `<p>${description}</p>` : ''), description });
    if (image) items[items.length - 1].mediaThumbnail = { $: { url: image } };
  }
  if (!items.length) throw new Error('sitemap: no posts found');
  return { title: source.name, items };
}

async function fetchSource(source) {
  if (source && source.manual) {
    cache[source.id] = manualSourceCache(source);
    saveDisk();
    return cache[source.id];
  }
  const candidates = expandCandidates(source.feeds);
  let lastErr = null;
  for (const url of candidates) {
    try {
      let feed;
      if (url.startsWith('sitemap:')) {
        feed = await parseSitemapFeed(url.slice(8), source);
      } else if (url.startsWith('wpjson:')) {
        feed = await parseWpJsonFeed(url.slice(7), source);
      } else {
        feed = await parser.parseURL(url);
      }
      const limit = Math.min(source.limit || 20, 30);
      let entries = (feed.items || []).slice(0, limit).map(i => normalizeItem(i, source));
      entries = await hydrateSourceEntries(source, entries);
      entries.sort((a, b) => b.publishedTs - a.publishedTs);
      store.upsertEntries(entries);
      const cachedEntries = entries.map(storedEntryForCache);
      cache[source.id] = {
        fetchedAt: Date.now(),
        feedUrl: url,
        feedTitle: feed.title || source.name,
        status: 'ok',
        error: null,
        entries: cachedEntries,
      };
      saveDisk();
      return cache[source.id];
    } catch (e) {
      lastErr = e;
    }
  }
  const prev = cache[source.id];
  cache[source.id] = {
    ...(prev || { entries: [] }),
    fetchedAt: Date.now(),
    status: prev && prev.entries && prev.entries.length ? 'stale' : 'error',
    error: lastErr ? String(lastErr.message || lastErr).slice(0, 200) : 'unknown error',
  };
  saveDisk();
  return cache[source.id];
}

async function refreshAll(onProgress) {
  const targets = SOURCES.filter(isEnabled);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < targets.length) {
      const source = targets[idx++];
      await fetchSource(source);
      done++;
      if (onProgress) onProgress(done, targets.length, source.id);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function getSourcesMeta() {
  return SOURCES.map(s => {
    if (s.manual) {
      const meta = store.getSubmissionMeta();
      return {
        id: s.id,
        name: s.name,
        category: s.category,
        siteUrl: s.siteUrl,
        description: s.description || '',
        note: s.note || '',
        enabled: isEnabled(s),
        status: 'ok',
        error: null,
        fetchedAt: meta.latestAt,
        entryCount: meta.count,
      };
    }
    const c = cache[s.id];
    return {
      id: s.id,
      name: s.name,
      category: s.category,
      siteUrl: s.siteUrl,
      description: s.description || '',
      note: s.note || '',
      enabled: isEnabled(s),
      status: c ? c.status : 'pending',
      error: c ? c.error : null,
      fetchedAt: c ? c.fetchedAt : null,
      entryCount: c && c.entries ? c.entries.length : 0,
    };
  });
}

function getEntries({ sourceId, category, q, limit = 400, viewer = null } = {}) {
  const byId = Object.fromEntries(SOURCES.map(s => [s.id, s]));
  let all = [];
  for (const src of SOURCES) {
    if (src.manual) {
      if (!isEnabled(src)) continue;
      if (sourceId && src.id !== sourceId) continue;
      if (category && src.category !== category) continue;
      all = all.concat(store.getSubmittedEntries({ limit: src.limit || 200 }));
      continue;
    }
    const sid = src.id;
    const c = cache[sid];
    if (!c || !isEnabled(src)) continue;
    if (sourceId && sid !== sourceId) continue;
    if (category && src.category !== category) continue;
    if (c.entries) all = all.concat(c.entries);
  }
  if (q) {
    const needle = q.toLowerCase();
    all = all.filter(e => (e.title + ' ' + e.summary).toLowerCase().includes(needle));
  }
  all.sort((a, b) => b.publishedTs - a.publishedTs);
  return withTranslations(all.slice(0, limit), viewer);
}

function getSourceById(id) {
  return SOURCES.find(s => s.id === id) || null;
}

function getEntryById(id, viewer = null) {
  for (const c of Object.values(cache)) {
    const hit = (c.entries || []).find(e => e.id === id);
    if (hit) return withTranslations([hit], viewer)[0];
  }
  const stored = store.getEntry(id);
  return stored ? withTranslations([stored], viewer)[0] : null;
}

function withTranslations(entries, viewer = null) {
  const ids = entries.map(e => e.id);
  const titleMap = store.getTitleTranslations(ids);
  const assetMap = store.getEntryAssetSummaries(ids);
  const statsMap = store.getEntryStats(ids, viewer);
  return entries.map(entry => ({
    ...entry,
    titleZh: titleMap[entry.id] || entry.titleZh || null,
    assets: assetMap[entry.id] || entry.assets || { translation: false, rewrite: false, comments: 0, chatMessages: 0, latestAt: 0, latestTypes: [] },
    stats: statsMap[entry.id] || entry.stats || null,
  }));
}

module.exports = { loadDisk, fetchSource, refreshAll, getSourcesMeta, getEntries, getSourceById, getEntryById, fetchEntryOriginal, submitLink, setEnabled, isEnabled };
