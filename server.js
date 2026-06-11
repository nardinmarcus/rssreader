const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const fetcher = require('./lib/fetcher');
const deepseek = require('./lib/deepseek');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 8080;
const DAILY_REFRESH_HOUR_SHANGHAI = 8;
const TITLE_TRANSLATION_LIMIT = parseInt(process.env.TITLE_TRANSLATION_LIMIT || '80', 10);
const AUTO_REWRITE_SOURCE_IDS = new Set(String(process.env.AUTO_REWRITE_SOURCE_IDS || 'bensbites,readwise-wise,nlp-elvis')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean));
const AUTO_REWRITE_LIMIT_PER_SOURCE = parseInt(process.env.AUTO_REWRITE_LIMIT_PER_SOURCE || '3', 10);
const SESSION_COOKIE = 'qm_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const DEFAULT_TITLE = 'QMReader · RSS 阅读器';
const DEFAULT_DESCRIPTION = '围绕 RSS 文章沉淀中文翻译、乔木风格重写、人工点评和文章对话的公开阅读站。';
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ASSET_DIRECTORY_META = {
  translation: {
    label: '中文翻译',
    description: 'QMReader 已沉淀中文双语对照翻译的公开 RSS 文章目录。',
  },
  rewrite: {
    label: '乔木风格重写',
    description: 'QMReader 已沉淀乔木风格中文重写的公开 RSS 文章目录。',
  },
  comments: {
    label: '人工点评',
    description: 'QMReader 已沉淀人工点评的公开 RSS 文章目录。',
  },
  chat: {
    label: '文章对话',
    description: 'QMReader 已沉淀公开 AI 文章对话的 RSS 文章目录。',
  },
};

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.user = store.getUserBySessionToken(cookieValue(req, SESSION_COOKIE));
  next();
});

let refreshing = false;
let refreshProgress = { done: 0, total: 0 };
let autoRewriteRunning = false;
let autoRewriteLast = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

function safeJsonForHtml(value) {
  const escapes = {
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => escapes[char]);
}

function jsonLdScript(value) {
  if (!value) return '';
  return `<script type="application/ld+json">${safeJsonForHtml(value)}</script>`;
}

function clipText(value, max = 180) {
  const text = String(value || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function publicUrl(req, target = req.originalUrl || '/') {
  const host = req.get('host') || 'rss.qiaomu.ai';
  const proto = req.protocol || (req.get('x-forwarded-proto') || 'https').split(',')[0];
  return `${proto}://${host}${target}`;
}

function absolutePublicUrl(req, value) {
  if (!value) return '';
  try {
    return new URL(value, publicUrl(req, '/')).href;
  } catch {
    return '';
  }
}

function normalizeAssetDirectoryType(value) {
  return ASSET_DIRECTORY_META[value] ? value : '';
}

function requestAssetDirectoryType(req) {
  const queryType = normalizeAssetDirectoryType(String(req.query.asset || ''));
  if (queryType) return queryType;
  const match = String(req.path || '').match(/^\/assets\/([^/.]+)\/?$/);
  return normalizeAssetDirectoryType(match ? match[1] : '');
}

function isAssetDirectoryRequest(req) {
  if (String(req.query.view || '') === 'assets') return true;
  return /^\/assets(?:\/[^/.]+)?\/?$/.test(String(req.path || ''));
}

function requestAssetFocus(req) {
  if (String(req.query.comment || '').trim()) return 'comments';
  if (String(req.query.chat || '').trim()) return 'chat';
  const focus = normalizeAssetDirectoryType(String(req.query.focus || ''));
  if (focus) return focus;
  const tab = String(req.query.tab || '');
  if (tab === 'translation') return 'translation';
  if (tab === 'rewrite') return 'rewrite';
  return '';
}

function assetDirectoryMeta(req) {
  if (!isAssetDirectoryRequest(req)) return null;
  const type = requestAssetDirectoryType(req);
  const q = clipText(String(req.query.q || '').trim(), 48);
  const stats = assetDirectoryStats(type, q);
  const searchSuffix = stats.summary || '';
  const latestSuffix = stats.latestText || '';
  if (!type) {
    if (q) {
      return {
        title: `公开资产搜索：${q} · QMReader`,
        description: `搜索“${q}”相关的公开资产，包含中文翻译、乔木风格重写、人工点评和文章对话。${searchSuffix}`,
      };
    }
    return {
      title: stats.assetCount ? `公开资产（${stats.assetCount} 条） · QMReader` : '公开资产 · QMReader',
      description: stats.assetCount
        ? `QMReader 已沉淀 ${stats.assetCount} 条公开资产，覆盖 ${stats.entryCount} 篇文章，包括中文翻译、乔木风格重写、人工点评和文章对话。${latestSuffix}`
        : DEFAULT_DESCRIPTION,
    };
  }
  const meta = ASSET_DIRECTORY_META[type];
  if (q) {
    return {
      title: `${meta.label}资产搜索：${q} · QMReader`,
      description: `搜索“${q}”相关的${meta.label}资产。${searchSuffix}`,
    };
  }
  return {
    title: stats.assetCount ? `${meta.label}资产（${stats.assetCount} 条） · QMReader` : `${meta.label}资产 · QMReader`,
    description: stats.assetCount
      ? `QMReader 已沉淀 ${stats.assetCount} 条${meta.label}资产，覆盖 ${stats.entryCount} 篇文章，可通过网页或 RSS 浏览。${latestSuffix}`
      : meta.description,
  };
}

function assetDirectoryStats(type = '', q = '') {
  const assetType = normalizeAssetDirectoryType(type);
  const query = normalizeSearchText(q);
  const entries = fetcher.getEntries({ limit: 1000 })
    .filter(entry => entry && entry.id && hasPublicAssets(entry))
    .filter(entry => !assetType || hasPublicAssetType(entry, assetType))
    .filter(entry => !query || normalizeSearchText(entryDirectorySearchText(entry)).includes(query));
  let assetCount = 0;
  let latestAt = 0;
  for (const entry of entries) {
    assetCount += entryAssetCount(entry, assetType);
    latestAt = Math.max(latestAt, entryAssetTypeTimestamp(entry, assetType));
  }
  const latestText = latestAt ? `最新更新 ${formatShanghaiMinute(latestAt)}。` : '';
  const summary = assetCount ? `${assetCount} 条 · ${entries.length} 篇文章。${latestText}` : '';
  return {
    assetCount,
    entryCount: entries.length,
    latestAt,
    latestText,
    summary,
    entries,
  };
}

function entryAssetCount(entry, type = '') {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation') return assets.translation ? 1 : 0;
  if (type === 'rewrite') return assets.rewrite ? 1 : 0;
  if (type === 'comments') return Number(assets.comments) || 0;
  if (type === 'chat') return Number(assets.chatMessages) || 0;
  return Object.keys(ASSET_DIRECTORY_META).reduce((sum, itemType) => sum + entryAssetCount(entry, itemType), 0);
}

function entryDirectorySearchText(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const parts = [entry.title, entry.titleZh, entry.summary, entry.summaryZh];
  for (const preview of Object.values(assets.previews || {})) {
    parts.push(preview.type, preview.author, preview.model, preview.role, preview.text);
  }
  for (const items of Object.values(assets.items || {})) {
    for (const item of items || []) parts.push(item.type, item.author, item.model, item.role, item.text);
  }
  return parts.filter(Boolean).join(' ');
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatShanghaiMinute(timestamp) {
  const t = Number(timestamp) || 0;
  if (!t) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(t));
  } catch {
    return '';
  }
}

function socialMetaTags(req, entry) {
  const directoryMeta = entry ? null : assetDirectoryMeta(req);
  const focus = entry ? requestAssetFocus(req) : '';
  const title = entry
    ? entryShareTitle(entry, focus, req)
    : (directoryMeta?.title || DEFAULT_TITLE);
  const description = entry
    ? entryShareDescription(entry, focus, req)
    : clipText(directoryMeta?.description || DEFAULT_DESCRIPTION);
  const modifiedTime = entry ? entryShareModifiedTime(entry, focus, req) : '';
  const url = publicUrl(req);
  const image = entry ? absolutePublicUrl(req, entry.image) : '';
  const tags = [
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta property="og:site_name" content="QMReader" />`,
    `<meta property="og:type" content="${entry ? 'article' : 'website'}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}" />`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}" />`);
  }
  if (entry && entry.published) {
    tags.push(`<meta property="article:published_time" content="${escapeHtml(entry.published)}" />`);
  }
  if (modifiedTime) {
    tags.push(`<meta property="article:modified_time" content="${escapeHtml(modifiedTime)}" />`);
    tags.push(`<meta property="og:updated_time" content="${escapeHtml(modifiedTime)}" />`);
  }
  const structuredData = shareStructuredData(req, {
    entry,
    focus,
    directoryMeta,
    title,
    description,
    modifiedTime,
    image,
    url,
  });
  if (structuredData) tags.push(jsonLdScript(structuredData));
  return { title, tags: tags.join('\n  ') };
}

function shareStructuredData(req, { entry, focus, directoryMeta, title, description, modifiedTime, image, url }) {
  if (entry) return entryStructuredData(req, entry, { focus, title, description, modifiedTime, image, url });
  if (directoryMeta) return assetDirectoryStructuredData(req, directoryMeta, { title, description, url });
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'QMReader',
    url,
    description,
  };
}

function siteStructuredData(req) {
  return {
    '@type': 'WebSite',
    name: 'QMReader',
    url: publicUrl(req, '/'),
  };
}

function assetDirectoryStructuredData(req, directoryMeta, { title, description, url }) {
  const type = requestAssetDirectoryType(req);
  const stats = directoryMeta.stats || assetDirectoryStats(type, String(req.query.q || '').trim());
  const label = type ? `${ASSET_DIRECTORY_META[type].label}资产` : '公开资产';
  const entries = (stats.entries || [])
    .slice()
    .sort((a, b) => entryAssetTypeTimestamp(b, type) - entryAssetTypeTimestamp(a, type))
    .slice(0, 10);
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title.replace(/\s·\sQMReader$/, ''),
    description,
    url,
    isPartOf: siteStructuredData(req),
    dateModified: timestampIso(stats.latestAt) || undefined,
    mainEntity: {
      '@type': 'ItemList',
      name: label,
      numberOfItems: stats.assetCount || 0,
      itemListElement: entries.map((entry, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: entryPublicUrl(req, entry, type),
        name: clipText(entry.titleZh || entry.title || '文章', 120),
        dateModified: entryAssetTypeLastModified(entry, type) || entryLastModified(entry) || undefined,
      })),
    },
  };
}

function entryStructuredData(req, entry, { focus, title, description, modifiedTime, image, url }) {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: clipText(entry.titleZh || entry.title || title, 120),
    alternativeHeadline: entry.titleZh && entry.title ? clipText(entry.title, 120) : undefined,
    description,
    url,
    mainEntityOfPage: url,
    datePublished: entry.published || undefined,
    dateModified: modifiedTime || entryLastModified(entry) || entry.published || undefined,
    image: image || undefined,
    author: structuredAuthor(entry.author || sourceNameForEntry(entry) || 'QMReader'),
    publisher: {
      '@type': 'Organization',
      name: 'QMReader',
      url: publicUrl(req, '/'),
    },
    inLanguage: entry.titleZh || entry.summaryZh ? 'zh-CN' : undefined,
  };
  const part = entryAssetStructuredPart(req, entry, focus);
  if (part) article.hasPart = part;
  return article;
}

function entryAssetStructuredPart(req, entry, focus) {
  const type = normalizeAssetDirectoryType(focus);
  if (!type) return null;
  const exactPreview = exactAssetPreview(entry, type, req);
  const preview = exactPreview || entry.assets?.previews?.[type];
  if (!preview || !preview.text) return null;
  const itemUrl = entryAssetItemUrl(req, entry, type, preview);
  const itemIdUrl = entryAssetItemUrl(req, entry, type, preview, { includeHash: false });
  const base = {
    '@id': `${itemIdUrl}#structured`,
    name: assetShareIdentity(type, preview) || ASSET_DIRECTORY_META[type]?.label || '公开资产',
    text: clipText(preview.text, 500),
    url: itemUrl,
    dateCreated: timestampIso(preview.at) || undefined,
    dateModified: timestampIso(preview.at) || undefined,
    author: structuredAuthor(preview.author || preview.model || 'QMReader'),
    isPartOf: entryPublicUrl(req, entry),
  };
  if (type === 'comments') return { '@type': 'Comment', ...base };
  if (type === 'chat') {
    const schemaType = preview.role === 'user' ? 'Question' : preview.role === 'assistant' ? 'Answer' : 'CreativeWork';
    return { '@type': schemaType, ...base };
  }
  return {
    '@type': 'CreativeWork',
    ...base,
    about: ASSET_DIRECTORY_META[type]?.label || '公开资产',
  };
}

function structuredAuthor(name) {
  const text = clipText(name || 'QMReader', 80);
  const isOrg = /ai|deepseek|openai|anthropic|claude|gemini|gpt|qmreader/i.test(text);
  return {
    '@type': isOrg ? 'Organization' : 'Person',
    name: text,
  };
}

function sourceNameForEntry(entry) {
  const source = fetcher.getSourceById(entry && entry.sourceId);
  return source ? source.name : '';
}

function entryShareTitle(entry, focus = '', req = null) {
  return assetShareTitle(entry, focus, exactAssetPreview(entry, focus, req));
}

function assetShareTitle(entry, focus = '', preview = null) {
  const articleTitle = clipText(entry.titleZh || entry.title || '文章', 72);
  const label = ASSET_DIRECTORY_META[focus]?.label || '';
  if (!label) return `${articleTitle} · QMReader`;
  const identity = assetShareIdentity(focus, preview);
  return `${identity || label} · ${articleTitle} · QMReader`;
}

function assetShareIdentity(focus = '', preview = null) {
  if (!preview) return '';
  const author = clipText(preview.author || preview.model || '', 24);
  if (focus === 'comments') return author ? `${author}的点评` : '人工点评';
  if (focus === 'chat') {
    const roleLabel = preview.role === 'user' ? '提问' : '回答';
    const speaker = author || (preview.role === 'user' ? '读者' : 'AI');
    return `${speaker}的${roleLabel}`;
  }
  return '';
}

function assetFeedTitle(entry, type, preview = null) {
  return assetShareTitle(entry, type, preview)
    .replace(/\s·\sQMReader$/, '')
    .replace(/\s·\s/, '：');
}

function assetFeedPreviews(entry, type, previews = {}) {
  if (type === 'comments') {
    return store.getComments(entry.id).map(comment => ({
      type: 'comments',
      id: comment.id,
      author: comment.author,
      model: comment.model || '',
      text: comment.body,
      at: comment.updatedAt || comment.createdAt,
    }));
  }
  if (type === 'chat') {
    return store.getChatMessages(entry.id).map(message => ({
      type: 'chat',
      id: message.id,
      role: message.role,
      author: message.author,
      model: message.model || '',
      text: message.content,
      at: message.createdAt,
    }));
  }
  return [previews[type] || {}];
}

function entryShareDescription(entry, focus = '', req = null) {
  const exactPreview = exactAssetPreview(entry, focus, req);
  if (exactPreview && exactPreview.text) return assetPreviewDescription(focus, exactPreview);
  const assets = entry && entry.assets ? entry.assets : {};
  const previews = assets.previews || {};
  const preview = focus && previews[focus] ? previews[focus] : null;
  if (preview && preview.text) return assetPreviewDescription(focus, preview);
  return clipText(entry.summaryZh || entry.summary || DEFAULT_DESCRIPTION);
}

function entryShareModifiedTime(entry, focus = '', req = null) {
  const exactPreview = exactAssetPreview(entry, focus, req);
  if (exactPreview && exactPreview.at) return timestampIso(exactPreview.at);
  const focusedAt = focus ? entryAssetTypeTimestamp(entry, focus) : 0;
  return timestampIso(focusedAt || entryAssetTypeTimestamp(entry));
}

function assetPreviewDescription(focus, preview) {
  const label = ASSET_DIRECTORY_META[focus]?.label || '公开资产';
  const source = [preview.author, preview.model].filter(Boolean).join(' · ');
  const prefix = source ? `${label}（${source}）` : label;
  return clipText(`${prefix}：${preview.text}`, 220);
}

function exactAssetPreview(entry, focus, req) {
  if (!entry || !req) return null;
  if (focus === 'comments') {
    const comment = store.getComment(entry.id, String(req.query.comment || '').trim());
    if (!comment) return null;
    return {
      type: 'comments',
      id: comment.id,
      author: comment.author,
      model: comment.model || '',
      text: comment.body,
      at: comment.updatedAt || comment.createdAt,
    };
  }
  if (focus === 'chat') {
    const message = store.getChatMessage(entry.id, String(req.query.chat || '').trim());
    if (!message) return null;
    return {
      type: 'chat',
      id: message.id,
      role: message.role,
      author: message.author,
      model: message.model || '',
      text: message.content,
      at: message.createdAt,
    };
  }
  return null;
}

function hasPublicAssets(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  return Boolean(assets.translation || assets.rewrite || assets.comments || assets.chatMessages);
}

function hasPublicAssetType(entry, type) {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation') return Boolean(assets.translation);
  if (type === 'rewrite') return Boolean(assets.rewrite);
  if (type === 'comments') return Boolean(assets.comments);
  if (type === 'chat') return Boolean(assets.chatMessages);
  return hasPublicAssets(entry);
}

function publicAssetTypes(entry) {
  return Object.keys(ASSET_DIRECTORY_META).filter(type => hasPublicAssetType(entry, type));
}

function timestampIso(timestamp) {
  const t = Number(timestamp) || 0;
  if (!t) return '';
  try {
    return new Date(t).toISOString();
  } catch {
    return '';
  }
}

function entryLastModified(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const timestamp = Math.max(Number(assets.latestAt) || 0, Number(entry && entry.publishedTs) || 0);
  return timestampIso(timestamp);
}

function entryAssetTypeTimestamp(entry, type = '') {
  const assetType = normalizeAssetDirectoryType(type);
  const assets = entry && entry.assets ? entry.assets : {};
  if (!assetType) return Math.max(Number(assets.latestAt) || 0, Number(entry && entry.publishedTs) || 0);
  if (!hasPublicAssetType(entry, assetType)) return 0;
  const itemAt = Number(assets.items?.[assetType]?.[0]?.at || 0);
  const previewAt = Number(assets.previews?.[assetType]?.at || 0);
  const latestAt = Array.isArray(assets.latestTypes) && assets.latestTypes.includes(assetType)
    ? Number(assets.latestAt) || 0
    : 0;
  return Math.max(itemAt, previewAt, latestAt);
}

function entryAssetTypeLastModified(entry, type = '', fallback = '') {
  return timestampIso(entryAssetTypeTimestamp(entry, type)) || fallback;
}

function latestAssetTypeLastModified(entries, type = '') {
  let latest = 0;
  for (const entry of entries) latest = Math.max(latest, entryAssetTypeTimestamp(entry, type));
  return timestampIso(latest);
}

function assetItemLastModified(item, fallback = '') {
  return timestampIso(item && (item.updatedAt || item.createdAt)) || fallback;
}

function sitemapUrlXml(loc, { lastmod = '', changefreq = 'weekly', priority = '0.7' } = {}) {
  const parts = [
    `  <url>`,
    `    <loc>${escapeHtml(loc)}</loc>`,
    lastmod ? `    <lastmod>${escapeHtml(lastmod)}</lastmod>` : '',
    changefreq ? `    <changefreq>${escapeHtml(changefreq)}</changefreq>` : '',
    priority ? `    <priority>${escapeHtml(priority)}</priority>` : '',
    `  </url>`,
  ];
  return parts.filter(Boolean).join('\n');
}

function entryPublicUrl(req, entry, focus = '') {
  const query = new URLSearchParams({ entry: entry.id });
  const assetFocus = normalizeAssetDirectoryType(focus);
  if (assetFocus) query.set('focus', assetFocus);
  return publicUrl(req, `/?${query.toString()}`);
}

function assetDirectoryUrl(req, type = '') {
  const assetType = normalizeAssetDirectoryType(type);
  return publicUrl(req, assetType ? `/assets/${assetType}` : '/assets');
}

function assetFeedUrl(req, type = '') {
  const assetType = normalizeAssetDirectoryType(type);
  return publicUrl(req, assetType ? `/assets/${assetType}.xml` : '/assets.xml');
}

function rssAlternateTag(req) {
  const type = isAssetDirectoryRequest(req) ? requestAssetDirectoryType(req) : '';
  const meta = type ? ASSET_DIRECTORY_META[type] : null;
  const title = meta ? `QMReader ${meta.label}资产 RSS` : 'QMReader 公开资产 RSS';
  return `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(title)}" href="${escapeHtml(assetFeedUrl(req, type))}" />`;
}

function entryAssetItemUrl(req, entry, type, preview = {}, { includeHash = true } = {}) {
  const query = new URLSearchParams({ entry: entry.id, focus: type });
  const itemId = String(preview.id || '').trim();
  let hash = '';
  if (type === 'comments' && itemId) {
    query.set('comment', itemId);
    if (includeHash) hash = `#comment-${encodeURIComponent(itemId)}`;
  }
  if (type === 'chat' && itemId) {
    query.set('chat', itemId);
    if (includeHash) hash = `#chat-${encodeURIComponent(itemId)}`;
  }
  return publicUrl(req, `/?${query.toString()}${hash}`);
}

function publicExactAssetSitemapUrls(req, entry, lastmod = '') {
  const urls = [];
  if (hasPublicAssetType(entry, 'comments')) {
    const commentsLastmod = entryAssetTypeLastModified(entry, 'comments', lastmod);
    for (const comment of store.getComments(entry.id)) {
      urls.push(sitemapUrlXml(entryAssetItemUrl(req, entry, 'comments', comment, { includeHash: false }), {
        lastmod: assetItemLastModified(comment, commentsLastmod),
        changefreq: 'monthly',
        priority: '0.72',
      }));
    }
  }
  if (hasPublicAssetType(entry, 'chat')) {
    const chatLastmod = entryAssetTypeLastModified(entry, 'chat', lastmod);
    for (const message of store.getChatMessages(entry.id)) {
      urls.push(sitemapUrlXml(entryAssetItemUrl(req, entry, 'chat', message, { includeHash: false }), {
        lastmod: assetItemLastModified(message, chatLastmod),
        changefreq: 'monthly',
        priority: '0.72',
      }));
    }
  }
  return urls;
}

function rssDate(timestamp) {
  const t = Number(timestamp) || 0;
  if (!t) return '';
  try {
    return new Date(t).toUTCString();
  } catch {
    return '';
  }
}

function publicAssetFeedItems(req, type = '') {
  const assetType = normalizeAssetDirectoryType(type);
  return fetcher.getEntries({ limit: 1000 })
    .filter(entry => entry && entry.id && hasPublicAssets(entry))
    .flatMap(entry => {
      const assets = entry.assets || {};
      const previews = assets.previews || {};
      const types = assetType ? [assetType] : publicAssetTypes(entry);
      return types
        .filter(itemType => hasPublicAssetType(entry, itemType))
        .flatMap(itemType => assetFeedPreviews(entry, itemType, previews).map(preview => {
          const label = ASSET_DIRECTORY_META[itemType].label;
          const at = Number(preview.at) || Number(assets.latestAt) || Number(entry.publishedTs) || Date.now();
          const source = [preview.author, preview.model].filter(Boolean).join(' · ');
          const description = preview.text
            ? assetPreviewDescription(itemType, preview)
            : clipText(`${label}：${entry.summaryZh || entry.summary || entry.titleZh || entry.title || ''}`, 220);
          const title = assetFeedTitle(entry, itemType, preview);
          const link = entryAssetItemUrl(req, entry, itemType, preview);
          return {
            type: itemType,
            title,
            link,
            description,
            source,
            at,
            guid: `qmreader:${entry.id}:${itemType}:${preview.id || at}`,
          };
        }));
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 80);
}

function renderAssetFeed(req, type = '') {
  const assetType = normalizeAssetDirectoryType(type);
  const meta = assetType ? ASSET_DIRECTORY_META[assetType] : null;
  const items = publicAssetFeedItems(req, assetType);
  const title = meta ? `${meta.label}资产 · QMReader` : 'QMReader 公开资产';
  const description = meta ? meta.description : DEFAULT_DESCRIPTION;
  const selfUrl = assetFeedUrl(req, assetType);
  const directoryUrl = assetDirectoryUrl(req, assetType);
  const lastBuildDate = rssDate(items[0]?.at || Date.now());
  const itemXml = items.map(item => [
    '    <item>',
    `      <title>${escapeHtml(item.title)}</title>`,
    `      <link>${escapeHtml(item.link)}</link>`,
    `      <guid isPermaLink="false">${escapeHtml(item.guid)}</guid>`,
    `      <pubDate>${escapeHtml(rssDate(item.at))}</pubDate>`,
    `      <category>${escapeHtml(ASSET_DIRECTORY_META[item.type].label)}</category>`,
    item.source ? `      <dc:creator>${escapeHtml(item.source)}</dc:creator>` : '',
    `      <description>${escapeHtml(item.description)}</description>`,
    '    </item>',
  ].filter(Boolean).join('\n')).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeHtml(title)}</title>`,
    `    <link>${escapeHtml(directoryUrl)}</link>`,
    `    <description>${escapeHtml(description)}</description>`,
    '    <language>zh-CN</language>',
    `    <lastBuildDate>${escapeHtml(lastBuildDate)}</lastBuildDate>`,
    `    <atom:link href="${escapeHtml(selfUrl)}" rel="self" type="application/rss+xml" />`,
    itemXml,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function renderSitemap(req) {
  const entries = fetcher.getEntries({ limit: 1000 })
    .filter(entry => entry && entry.id)
    .sort((a, b) => {
      const assetDelta = Number(hasPublicAssets(b)) - Number(hasPublicAssets(a));
      if (assetDelta) return assetDelta;
      return Math.max(Number(b.assets?.latestAt) || 0, Number(b.publishedTs) || 0)
        - Math.max(Number(a.assets?.latestAt) || 0, Number(a.publishedTs) || 0);
    });

  const urls = [
    [
      `  <url>`,
      `    <loc>${escapeHtml(publicUrl(req, '/'))}</loc>`,
      `    <changefreq>daily</changefreq>`,
      `    <priority>1.0</priority>`,
      `  </url>`,
    ].join('\n'),
  ];

  const assetEntries = entries.filter(hasPublicAssets);
  if (assetEntries.length) {
    const latestAssetLastmod = latestAssetTypeLastModified(assetEntries);
    urls.push([
      `  <url>`,
      `    <loc>${escapeHtml(assetDirectoryUrl(req))}</loc>`,
      latestAssetLastmod ? `    <lastmod>${escapeHtml(latestAssetLastmod)}</lastmod>` : '',
      `    <changefreq>daily</changefreq>`,
      `    <priority>0.7</priority>`,
      `  </url>`,
    ].filter(Boolean).join('\n'));

    for (const type of Object.keys(ASSET_DIRECTORY_META)) {
      const typeEntries = assetEntries.filter(entry => hasPublicAssetType(entry, type));
      if (!typeEntries.length) continue;
      const typeLastmod = latestAssetTypeLastModified(typeEntries, type);
      urls.push([
        `  <url>`,
        `    <loc>${escapeHtml(assetDirectoryUrl(req, type))}</loc>`,
        typeLastmod ? `    <lastmod>${escapeHtml(typeLastmod)}</lastmod>` : '',
        `    <changefreq>weekly</changefreq>`,
        `    <priority>0.65</priority>`,
        `  </url>`,
      ].filter(Boolean).join('\n'));
    }
  }

  for (const entry of entries) {
    const lastmod = entryLastModified(entry);
    const priority = hasPublicAssets(entry) ? '0.8' : '0.5';
    const changefreq = hasPublicAssets(entry) ? 'weekly' : 'monthly';
    urls.push([
      `  <url>`,
      `    <loc>${escapeHtml(entryPublicUrl(req, entry))}</loc>`,
      lastmod ? `    <lastmod>${escapeHtml(lastmod)}</lastmod>` : '',
      `    <changefreq>${changefreq}</changefreq>`,
      `    <priority>${priority}</priority>`,
      `  </url>`,
    ].filter(Boolean).join('\n'));

    for (const type of publicAssetTypes(entry)) {
      const typeLastmod = entryAssetTypeLastModified(entry, type, lastmod);
      urls.push([
        `  <url>`,
        `    <loc>${escapeHtml(entryPublicUrl(req, entry, type))}</loc>`,
        typeLastmod ? `    <lastmod>${escapeHtml(typeLastmod)}</lastmod>` : '',
        `    <changefreq>weekly</changefreq>`,
        `    <priority>0.75</priority>`,
        `  </url>`,
      ].filter(Boolean).join('\n'));
    }
    urls.push(...publicExactAssetSitemapUrls(req, entry, lastmod));
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.join('\n'),
    '</urlset>',
    '',
  ].join('\n');
}

function renderIndex(req, entry = null) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const { title, tags } = socialMetaTags(req, entry);
  return html
    .replace(/<link rel="alternate" type="application\/rss\+xml" title="[^"]*" href="[^"]*" \/>/, rssAlternateTag(req))
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace('</head>', `  ${tags}\n</head>`);
}

app.get('/', (req, res) => {
  const entryId = String(req.query.entry || '').trim();
  const entry = entryId ? fetcher.getEntryById(entryId) : null;
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req, entry));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${publicUrl(req, '/sitemap.xml')}`,
    '',
  ].join('\n'));
});

app.get('/favicon.ico', (req, res) => {
  res.redirect(302, '/favicon.svg');
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.type('application/xml').send(renderSitemap(req));
});

app.get('/assets.xml', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.type('application/rss+xml').send(renderAssetFeed(req));
});

app.get('/assets/:type.xml', (req, res) => {
  const type = normalizeAssetDirectoryType(String(req.params.type || ''));
  if (!type) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.type('application/rss+xml').send(renderAssetFeed(req, type));
});

app.get('/assets', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req));
});

app.get('/assets/:type', (req, res) => {
  const type = normalizeAssetDirectoryType(String(req.params.type || ''));
  if (!type) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function cookieValue(req, name) {
  const header = String(req.headers.cookie || '');
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return '';
}

function secureCookie(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https' || process.env.COOKIE_SECURE === '1';
}

function setSessionCookie(req, res, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}`,
  ];
  if (secureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function sendError(res, error, fallback = 'request failed') {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || fallback });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: '请先登录或注册账号' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: '需要管理员权限' });
}

function requestAiConfig(req) {
  return {
    apiKey: String(req.get('x-ai-key') || req.get('x-deepseek-key') || '').trim(),
    provider: String(req.get('x-ai-provider') || 'deepseek').trim(),
    providerName: String(req.get('x-ai-provider-name') || '').trim(),
    providerType: String(req.get('x-ai-provider-type') || 'openai_compatible').trim(),
    baseUrl: String(req.get('x-ai-base-url') || '').trim(),
    model: String(req.get('x-ai-model') || '').trim(),
    temperature: String(req.get('x-ai-temperature') || '').trim(),
    maxTokens: String(req.get('x-ai-max-tokens') || '').trim(),
  };
}

function requestAuthor(req) {
  return req.user ? req.user.displayName : '读者';
}

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
  return plainText(entry && (entry.content || entry.summary));
}

function shouldAutoFetchOriginal(entry) {
  if (!entry || !/^https?:\/\//i.test(entry.link || '')) return false;
  const contentText = plainText(entry.content);
  const summaryText = plainText(entry.summary);
  const textLength = (contentText || summaryText).length;
  if (textLength >= 600) return false;
  if (!contentText || contentText.length < 300) return true;
  return Boolean(summaryText && contentText.length <= summaryText.length + 25);
}

async function prepareEntryForAiAsset(entry, reason = 'AI asset') {
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

function translationResponse(entry) {
  const translation = store.getTranslation(entry.id);
  if (!translation) return null;
  const contentHash = store.hashText((entry.title || '') + '\n' + (entry.content || entry.summary || ''));
  return {
    ...translation,
    stale: Boolean(translation.contentHash && translation.contentHash !== contentHash),
  };
}

function rewriteResponse(entry) {
  const rewrite = store.getRewrite(entry.id);
  if (!rewrite) return null;
  const contentHash = deepseek.rewriteContentHash(entry);
  return {
    ...rewrite,
    stale: Boolean(rewrite.contentHash && rewrite.contentHash !== contentHash),
  };
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

async function autoRewriteSources(sourceIds = AUTO_REWRITE_SOURCE_IDS) {
  const ids = sourceIds instanceof Set ? sourceIds : new Set(sourceIds);
  if (!ids.size) return { rewritten: 0, cached: 0, failed: [], skipped: 'no sources configured' };
  const config = deepseek.getConfig();
  if (!config.configured) return { rewritten: 0, cached: 0, failed: [], skipped: 'AI not configured' };

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
  let rewritten = 0;
  let cached = 0;
  const failed = [];
  for (const entry of entries) {
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
  return { rewritten, cached, failed };
}

function queueAutoRewriteSources(sourceIds = AUTO_REWRITE_SOURCE_IDS) {
  const ids = Array.from(sourceIds instanceof Set ? sourceIds : new Set(sourceIds)).filter(Boolean);
  if (!ids.length) return { started: false, running: autoRewriteRunning, skipped: 'no sources configured' };
  if (autoRewriteRunning) return { started: false, running: true, skipped: 'already running' };

  autoRewriteRunning = true;
  const startedAt = Date.now();
  autoRewriteLast = { sourceIds: ids, startedAt, finishedAt: 0, running: true };
  autoRewriteSources(ids)
    .then(result => {
      autoRewriteLast = { ...result, sourceIds: ids, startedAt, finishedAt: Date.now(), running: false };
      console.log(`Auto rewrite: sources=${ids.join(',')}, rewritten=${result.rewritten}, cached=${result.cached}, failed=${result.failed.length}${result.skipped ? `, skipped=${result.skipped}` : ''}`);
    })
    .catch(error => {
      autoRewriteLast = {
        sourceIds: ids,
        startedAt,
        finishedAt: Date.now(),
        running: false,
        rewritten: 0,
        cached: 0,
        failed: [],
        error: String(error.message || error).slice(0, 200),
      };
      console.warn('Auto rewrite skipped:', error.message || error);
    })
    .finally(() => {
      autoRewriteRunning = false;
    });
  return { started: true, running: true, sourceIds: ids, startedAt };
}

function seedAdminFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!email || !password) return;
  try {
    store.ensureAdminUser({
      email,
      password,
      displayName: process.env.ADMIN_NAME || '向阳乔木',
    });
    console.log(`Admin user ready: ${email}`);
  } catch (error) {
    console.warn('Admin user seed skipped:', error.message || error);
  }
}

async function doRefreshAll() {
  if (refreshing) return;
  refreshing = true;
  refreshProgress = { done: 0, total: 0 };
  try {
    await fetcher.refreshAll((done, total) => { refreshProgress = { done, total }; });
    try {
      await translateMissingTitles();
    } catch (e) {
      console.warn('Title translation skipped:', e.message || e);
    }
    queueAutoRewriteSources();
  } catch (e) {
    console.error('Refresh failed:', e.message || e);
  } finally {
    refreshing = false;
  }
}

function nextShanghaiRefreshDelay() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now).map(part => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const addDay = hour >= DAILY_REFRESH_HOUR_SHANGHAI ? 1 : 0;
  const targetUtc = Date.UTC(year, month - 1, day + addDay, DAILY_REFRESH_HOUR_SHANGHAI - 8, 0, 0);
  return Math.max(targetUtc - now.getTime(), 60 * 1000);
}

function scheduleDailyRefresh() {
  const delay = nextShanghaiRefreshDelay();
  setTimeout(async () => {
    try {
      await doRefreshAll();
    } finally {
      scheduleDailyRefresh();
    }
  }, delay);
}

app.get('/api/sources', (req, res) => {
  res.json({
    sources: fetcher.getSourcesMeta(),
    refreshing,
    progress: refreshProgress,
    autoRewrite: { running: autoRewriteRunning, last: autoRewriteLast },
  });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/register', (req, res) => {
  try {
    const user = store.createUser({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      displayName: req.body && req.body.displayName,
    });
    const session = store.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({ user });
  } catch (e) {
    sendError(res, e, 'register failed');
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = store.authenticateUser(req.body && req.body.email, req.body && req.body.password);
    const session = store.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({ user });
  } catch (e) {
    sendError(res, e, 'login failed');
  }
});

app.post('/api/auth/logout', (req, res) => {
  store.deleteSession(cookieValue(req, SESSION_COOKIE));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me/entry-states', requireLogin, (req, res) => {
  res.json({ states: store.getUserEntryStates(req.user.id) });
});

app.post('/api/me/entry-state', requireLogin, (req, res) => {
  const { entryId, read, starred } = req.body || {};
  const entry = fetcher.getEntryById(entryId);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const entryState = store.setUserEntryState(req.user.id, entry.id, {
      read: typeof read === 'boolean' ? read : undefined,
      starred: typeof starred === 'boolean' ? starred : undefined,
    });
    res.json({ entryState });
  } catch (e) {
    sendError(res, e, 'entry state update failed');
  }
});

app.post('/api/me/entry-states/read', requireLogin, (req, res) => {
  const requested = Array.isArray(req.body && req.body.entryIds) ? req.body.entryIds : [];
  const entryIds = requested
    .map(id => fetcher.getEntryById(id))
    .filter(Boolean)
    .map(entry => entry.id);
  try {
    res.json({ states: store.markEntriesRead(req.user.id, entryIds) });
  } catch (e) {
    sendError(res, e, 'entry states update failed');
  }
});

app.post('/api/ai/models', requireLogin, async (req, res) => {
  try {
    const result = await deepseek.listModels(requestAiConfig(req));
    res.json(result);
  } catch (e) {
    sendError(res, e, 'models request failed');
  }
});

app.post('/api/ai/test', requireLogin, async (req, res) => {
  try {
    const result = await deepseek.testConnection(requestAiConfig(req));
    res.json(result);
  } catch (e) {
    sendError(res, e, 'AI connection test failed');
  }
});

// List endpoint omits full content to keep the payload small; fetch it per-entry on open.
app.get('/api/entries', (req, res) => {
  const { source, category, q, limit } = req.query;
  const entries = fetcher.getEntries({
    sourceId: source || undefined,
    category: category || undefined,
    q: q || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  }).map(({ content, ...rest }) => rest);
  res.json({ entries });
});

app.get('/api/entry/:id', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ entry });
});

app.post('/api/entry/:id/content', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const updated = await fetcher.fetchEntryOriginal(entry);
    res.json({ entry: updated });
  } catch (e) {
    sendError(res, e, 'fetch original content failed');
  }
});

app.get('/api/entry/:id/translation', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ translation: translationResponse(entry) });
});

app.post('/api/entry/:id/translation', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const prepared = await prepareEntryForAiAsset(entry, 'Translation');
    const result = await deepseek.translateEntry(prepared.entry, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      force: Boolean(req.body && req.body.force),
    });
    res.json({ ...result, originalFetched: prepared.fetched, originalFetchError: prepared.error || null, entry: prepared.fetched ? prepared.entry : undefined });
  } catch (e) {
    sendError(res, e, 'translation failed');
  }
});

app.get('/api/entry/:id/rewrite', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ rewrite: rewriteResponse(entry) });
});

app.post('/api/entry/:id/rewrite', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const prepared = await prepareEntryForAiAsset(entry, 'Rewrite');
    const result = await deepseek.rewriteEntry(prepared.entry, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      force: Boolean(req.body && req.body.force),
    });
    res.json({ ...result, originalFetched: prepared.fetched, originalFetchError: prepared.error || null, entry: prepared.fetched ? prepared.entry : undefined });
  } catch (e) {
    sendError(res, e, 'rewrite failed');
  }
});

app.get('/api/entry/:id/comments', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ comments: store.getComments(entry.id, req.user) });
});

app.post('/api/entry/:id/comments', requireLogin, (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'comment body is required' });
  const comment = store.addComment(entry.id, {
    userId: req.user.id,
    author: requestAuthor(req),
    body,
  });
  res.json({ comment, comments: store.getComments(entry.id, req.user) });
});

app.patch('/api/entry/:id/comments/:commentId', requireLogin, (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const comment = store.updateComment(entry.id, req.params.commentId, {
      body: req.body && req.body.body,
    }, req.user);
    if (!comment) return res.status(404).json({ error: 'comment not found' });
    res.json({ comment, comments: store.getComments(entry.id, req.user) });
  } catch (e) {
    sendError(res, e, 'update comment failed');
  }
});

app.delete('/api/entry/:id/comments/:commentId', requireLogin, (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const deleted = store.deleteComment(entry.id, req.params.commentId, req.user);
    if (!deleted) return res.status(404).json({ error: 'comment not found' });
    res.json({ ok: true, comments: store.getComments(entry.id, req.user) });
  } catch (e) {
    sendError(res, e, 'delete comment failed');
  }
});

app.post('/api/entry/:id/chat', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const result = await deepseek.chatWithEntry(entry, req.body && req.body.messages, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      userId: req.user.id,
    });
    res.json(result);
  } catch (e) {
    sendError(res, e, 'chat failed');
  }
});

app.get('/api/entry/:id/chat', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ messages: store.getChatMessages(entry.id, req.user) });
});

app.delete('/api/entry/:id/chat/:messageId', requireLogin, (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const deleted = store.deleteChatMessage(entry.id, req.params.messageId, req.user);
    if (!deleted) return res.status(404).json({ error: 'chat message not found' });
    res.json({ ok: true, messages: store.getChatMessages(entry.id, req.user) });
  } catch (e) {
    sendError(res, e, 'delete chat message failed');
  }
});

app.post('/api/translate-titles', requireAdmin, async (req, res) => {
  try {
    const translated = await translateMissingTitles(parseInt((req.body && req.body.limit) || TITLE_TRANSLATION_LIMIT, 10));
    res.json({ translated });
  } catch (e) {
    sendError(res, e, 'title translation failed');
  }
});

app.post('/api/auto-rewrite', requireAdmin, async (req, res) => {
  try {
    const requested = Array.isArray(req.body && req.body.sourceIds) ? req.body.sourceIds : [];
    const sourceIds = requested.length ? requested : Array.from(AUTO_REWRITE_SOURCE_IDS);
    const result = queueAutoRewriteSources(sourceIds);
    res.json({ autoRewrite: result });
  } catch (e) {
    sendError(res, e, 'auto rewrite failed');
  }
});

app.post('/api/refresh', requireAdmin, async (req, res) => {
  const { sourceId } = req.body || {};
  if (sourceId) {
    const src = fetcher.getSourceById(sourceId);
    if (!src) return res.status(404).json({ error: 'source not found' });
    const result = await fetcher.fetchSource(src);
    await translateMissingTitles(20);
    let autoRewrite = null;
    if (AUTO_REWRITE_SOURCE_IDS.has(src.id)) {
      autoRewrite = queueAutoRewriteSources([src.id]);
    }
    return res.json({ status: result.status, error: result.error, entryCount: result.entries ? result.entries.length : 0, autoRewrite });
  }
  doRefreshAll();
  res.json({ started: true });
});

app.post('/api/sources/:id/toggle', requireAdmin, async (req, res) => {
  const src = fetcher.getSourceById(req.params.id);
  if (!src) return res.status(404).json({ error: 'source not found' });
  const enabled = !fetcher.isEnabled(src);
  fetcher.setEnabled(src.id, enabled);
  if (enabled) fetcher.fetchSource(src);
  res.json({ id: src.id, enabled });
});

app.listen(PORT, () => {
  console.log(`QMReader listening on http://localhost:${PORT}`);
  seedAdminFromEnv();
  fetcher.loadDisk();
  doRefreshAll();
  scheduleDailyRefresh();
});
