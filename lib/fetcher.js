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

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FoloReader/1.0',
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

function extractReadableContent(html, baseUrl) {
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
  const content = item.contentEncoded || item['content:encoded'] || item.content || item.summary || item.description || '';
  const link = item.link || item.guid || '';
  const id = crypto.createHash('md5').update(source.id + '|' + (item.guid || link || item.title || '')).digest('hex');
  const text = stripHtml(content);
  let image = firstImage(content, link) || null;
  if (!image && item.itunes && item.itunes.image) image = item.itunes.image;
  if (!image && item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) image = item.mediaThumbnail.$.url;
  if (!image && Array.isArray(item.mediaContent)) {
    const mc = item.mediaContent.find(m => m.$ && m.$.url && /image|jpg|jpeg|png|webp/i.test((m.$.medium || '') + (m.$.type || '') + m.$.url));
    if (mc) image = mc.$.url;
  }
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
  });
  if (updated) updateCachedEntry(entry.id, {
    content: updated.content,
    summary: updated.summary,
    image: updated.image,
    contentHash: updated.contentHash,
  });
  return updated;
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
  let posts = urls.filter(u => {
    try {
      const p = new URL(u.loc).pathname;
      return p.length > 1 && !SITEMAP_SKIP.test(p);
    } catch { return false; }
  });
  const withP = posts.filter(u => u.loc.includes('/p/'));
  if (withP.length) posts = withP;
  posts.sort((a, b) => (Date.parse(b.lastmod || 0) || 0) - (Date.parse(a.lastmod || 0) || 0));
  const limit = Math.min(source.limit || 5, 6);
  const top = posts.slice(0, limit);
  const items = [];
  for (const u of top) {
    let title = decodeURIComponent(new URL(u.loc).pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]/g, ' ');
    let description = '', image = null, published = u.lastmod;
    try {
      const html = await fetchText(u.loc, 12000);
      title = decodeEntities(metaContent(html, ['og:title', 'twitter:title']) || (/<title[^>]*>([^<]+)<\/title>/i.exec(html) || [])[1] || title);
      description = decodeEntities(metaContent(html, ['og:description', 'twitter:description', 'description']) || '');
      image = metaContent(html, ['og:image', 'twitter:image']);
      published = metaContent(html, ['article:published_time']) || u.lastmod;
    } catch { /* keep slug-derived title */ }
    items.push({ title, link: u.loc, guid: u.loc, pubDate: published, content: description ? `<p>${description}</p>` : '', description });
    if (image) items[items.length - 1].mediaThumbnail = { $: { url: image } };
  }
  if (!items.length) throw new Error('sitemap: no posts found');
  return { title: source.name, items };
}

async function fetchSource(source) {
  const candidates = expandCandidates(source.feeds);
  let lastErr = null;
  for (const url of candidates) {
    try {
      const feed = url.startsWith('sitemap:')
        ? await parseSitemapFeed(url.slice(8), source)
        : await parser.parseURL(url);
      const limit = Math.min(source.limit || 20, 30);
      const entries = (feed.items || []).slice(0, limit).map(i => normalizeItem(i, source));
      entries.sort((a, b) => b.publishedTs - a.publishedTs);
      store.upsertEntries(entries);
      cache[source.id] = {
        fetchedAt: Date.now(),
        feedUrl: url,
        feedTitle: feed.title || source.name,
        status: 'ok',
        error: null,
        entries,
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

function getEntries({ sourceId, category, q, limit = 400 } = {}) {
  const byId = Object.fromEntries(SOURCES.map(s => [s.id, s]));
  let all = [];
  for (const [sid, c] of Object.entries(cache)) {
    const src = byId[sid];
    if (!src || !isEnabled(src)) continue;
    if (sourceId && sid !== sourceId) continue;
    if (category && src.category !== category) continue;
    if (c.entries) all = all.concat(c.entries);
  }
  if (q) {
    const needle = q.toLowerCase();
    all = all.filter(e => (e.title + ' ' + e.summary).toLowerCase().includes(needle));
  }
  all.sort((a, b) => b.publishedTs - a.publishedTs);
  return withTranslations(all.slice(0, limit));
}

function getSourceById(id) {
  return SOURCES.find(s => s.id === id) || null;
}

function getEntryById(id) {
  for (const c of Object.values(cache)) {
    const hit = (c.entries || []).find(e => e.id === id);
    if (hit) return withTranslations([hit])[0];
  }
  return store.getEntry(id);
}

function withTranslations(entries) {
  const titleMap = store.getTitleTranslations(entries.map(e => e.id));
  return entries.map(entry => ({
    ...entry,
    titleZh: titleMap[entry.id] || entry.titleZh || null,
  }));
}

module.exports = { loadDisk, fetchSource, refreshAll, getSourcesMeta, getEntries, getSourceById, getEntryById, fetchEntryOriginal, setEnabled, isEnabled };
