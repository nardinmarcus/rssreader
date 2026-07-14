const crypto = require('crypto');
const cheerio = require('cheerio');
const {
  canonicalSerialize,
  computeDocumentHash,
  computeRawHash,
  computeSourceHash,
} = require('./content-hashes');

const EXTRACTOR_VERSION = 'article-document-extractor-v1';
const SANITIZER_VERSION = 'article-document-sanitizer-v1';
const SEGMENTER_VERSION = 'article-document-segmenter-v1';

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'ol', 'ul', 'li', 'blockquote', 'pre', 'code', 'strong', 'em',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'a', 'img', 'hr',
]);
const REMOVED_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'form', 'svg', 'canvas', 'object', 'embed',
  'template', 'noscript', 'meta', 'link', 'base',
]);
const VOID_TAGS = new Set(['br', 'hr']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeText(value, preserveWhitespace = false) {
  const normalized = String(value || '').replace(/\r\n?/g, '\n').normalize('NFC');
  if (!preserveWhitespace) return normalized.replace(/\s+/g, ' ').trim();
  const lines = normalized.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function safeUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, baseUrl || undefined);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedComponent(component = {}) {
  let contentHash = String(component.contentHash || '').trim();
  if (!contentHash) {
    const content = Object.prototype.hasOwnProperty.call(component, 'content')
      ? component.content
      : component.text || '';
    const serialized = canonicalSerialize(content);
    contentHash = computeRawHash(Buffer.from(serialized, 'utf8'));
  }
  return {
    type: String(component.type || ''),
    contentHash,
    snapshotId: component.snapshotId ? String(component.snapshotId) : null,
  };
}

function normalizeSourceComponents(components = []) {
  return (Array.isArray(components) ? components : [])
    .map(normalizedComponent)
    .sort((left, right) => {
      const a = canonicalSerialize(left);
      const b = canonicalSerialize(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

function textRole(path, override = '') {
  if (override) return override;
  const tags = new Set(path);
  if (tags.has('code') || tags.has('pre')) return 'code';
  if (path.some(tag => /^h[1-6]$/.test(tag))) return 'heading';
  if (tags.has('figcaption')) return 'caption';
  if (tags.has('th') || tags.has('td')) return 'tableCell';
  if (tags.has('blockquote')) return 'quote';
  if (tags.has('li')) return 'listItem';
  return 'paragraph';
}

function makeTextSegment(rawText, context, state, { preserveWhitespace = false } = {}) {
  const text = normalizeText(rawText, preserveWhitespace);
  if (!text) return null;
  const role = textRole(context.path, context.role);
  const resourceRefs = [...new Set(context.resourceRefs || [])].sort();
  const identity = canonicalSerialize({
    path: context.path,
    role,
    text,
    resourceRefs,
  });
  const occurrence = state.segmentOccurrences.get(identity) || 0;
  state.segmentOccurrences.set(identity, occurrence + 1);
  const raw = String(rawText || '');
  const segment = {
    type: 'text',
    id: `s_${digest(canonicalSerialize({ identity, occurrence })).slice(0, 16)}`,
    role,
    text,
  };
  if (resourceRefs.length) segment.resourceRefs = resourceRefs;
  if (!preserveWhitespace && /^\s/.test(raw)) segment.leadingSpace = true;
  if (!preserveWhitespace && /\s$/.test(raw)) segment.trailingSpace = true;
  return segment;
}

function addResource(state, resource) {
  const key = canonicalSerialize({ type: resource.type, url: resource.url });
  const existing = state.resourceByKey.get(key);
  if (existing) return existing;
  const saved = { id: `r_${digest(key).slice(0, 16)}`, ...resource };
  state.resourceByKey.set(key, saved);
  state.resources.push(saved);
  return saved;
}

function compileNode(node, context, state) {
  if (!node) return [];
  if (node.type === 'text') {
    const preserveWhitespace = context.path.includes('pre') || context.path.includes('code');
    const segment = makeTextSegment(node.data, context, state, { preserveWhitespace });
    return segment ? [segment] : [];
  }
  const tag = String(node.name || node.tagName || '').toLowerCase();
  if (!tag || REMOVED_WITH_CONTENT.has(tag)) return [];

  if (tag === 'img') {
    const url = safeUrl(node.attribs && node.attribs.src, state.finalUrl);
    if (!url) return [];
    const altText = normalizeText(node.attribs && node.attribs.alt);
    const resource = addResource(state, { type: 'image', url, alt: altText });
    const alt = altText
      ? makeTextSegment(altText, {
        path: [...context.path, 'img'],
        role: 'imageAlt',
        resourceRefs: [resource.id],
      }, state)
      : null;
    return [{ type: 'element', tag: 'img', resourceId: resource.id, ...(alt ? { alt } : {}) }];
  }

  if (tag === 'a') {
    const url = safeUrl(node.attribs && node.attribs.href, state.finalUrl);
    if (!url) return (node.children || []).flatMap(child => compileNode(child, context, state));
    const resource = addResource(state, { type: 'link', url, rel: 'noopener noreferrer' });
    const children = (node.children || []).flatMap(child => compileNode(child, {
      path: [...context.path, 'a'],
      role: 'linkText',
      resourceRefs: [...(context.resourceRefs || []), resource.id],
    }, state));
    return [{ type: 'element', tag: 'a', resourceId: resource.id, children }];
  }

  if (!ALLOWED_TAGS.has(tag)) {
    return (node.children || []).flatMap(child => compileNode(child, context, state));
  }
  if (VOID_TAGS.has(tag)) return [{ type: 'element', tag, children: [] }];

  const childContext = {
    ...context,
    path: [...context.path, tag],
  };
  const children = (node.children || []).flatMap(child => compileNode(child, childContext, state));
  return [{ type: 'element', tag, children }];
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeNode(node, resourcesById) {
  if (node.type === 'text') {
    return `${node.leadingSpace ? ' ' : ''}${escapeHtml(node.text)}${node.trailingSpace ? ' ' : ''}`;
  }
  if (node.tag === 'hr' || node.tag === 'br') return `<${node.tag}>`;
  if (node.tag === 'img') {
    const resource = resourcesById.get(node.resourceId);
    if (!resource) return '';
    const alt = node.alt && node.alt.text || resource.alt || '';
    return `<img src="${escapeHtml(resource.url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const children = (node.children || []).map(child => serializeNode(child, resourcesById)).join('');
  if (node.tag === 'a') {
    const resource = resourcesById.get(node.resourceId);
    return resource
      ? `<a href="${escapeHtml(resource.url)}" rel="noopener noreferrer">${children}</a>`
      : children;
  }
  return `<${node.tag}>${children}</${node.tag}>`;
}

function segmentsFromAst(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'text') out.push(node);
    if (node.alt && node.alt.type === 'text') out.push(node.alt);
    if (Array.isArray(node.children)) segmentsFromAst(node.children, out);
  }
  return out;
}

function compileHtml(html, finalUrl) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false }, false);
  const state = {
    finalUrl,
    resources: [],
    resourceByKey: new Map(),
    segmentOccurrences: new Map(),
  };
  const roots = $('body').length ? $('body').first().contents().toArray() : $.root().contents().toArray();
  const ast = roots.flatMap(node => compileNode(node, { path: [], role: '', resourceRefs: [] }, state));
  const resourcesById = new Map(state.resources.map(resource => [resource.id, resource]));
  const segments = segmentsFromAst(ast);
  return {
    ast,
    resources: state.resources,
    normalizedHtml: ast.map(node => serializeNode(node, resourcesById)).join('\n'),
    plainText: segments.map(segment => segment.text).join('\n'),
    segments,
  };
}

function compileDocument({
  entry = {},
  html = '',
  finalUrl = '',
  provenance,
  rawStatus,
  primaryRawHash = '',
  snapshotId = null,
  sourceComponents = [],
}) {
  const resolvedFinalUrl = String(finalUrl || entry.link || '');
  const compiled = compileHtml(html, resolvedFinalUrl);
  const normalizedComponents = normalizeSourceComponents(sourceComponents);
  const astText = compiled.segments.map(segment => ({
    id: segment.id,
    role: segment.role,
    text: segment.text,
    resourceRefs: segment.resourceRefs || [],
  }));
  const resourceRefs = compiled.resources.map(resource => ({
    id: resource.id,
    type: resource.type,
    url: resource.url,
  }));
  const sourceHash = computeSourceHash({
    title: String(entry.title || ''),
    summary: String(entry.summary || ''),
    astText,
    resourceRefs,
    sourceComponents: normalizedComponents,
  });
  const documentHash = computeDocumentHash({
    primaryRawHash,
    sourceComponents: normalizedComponents,
    finalUrl: resolvedFinalUrl,
    extractorVersion: EXTRACTOR_VERSION,
    sanitizerVersion: SANITIZER_VERSION,
    segmenterVersion: SEGMENTER_VERSION,
    semanticInputHash: sourceHash,
  });
  return {
    provenance,
    rawStatus,
    snapshotId: snapshotId ? String(snapshotId) : null,
    finalUrl: resolvedFinalUrl,
    extractorVersion: EXTRACTOR_VERSION,
    sanitizerVersion: SANITIZER_VERSION,
    segmenterVersion: SEGMENTER_VERSION,
    title: String(entry.title || ''),
    summary: String(entry.summary || ''),
    normalizedHtml: compiled.normalizedHtml,
    plainText: compiled.plainText,
    ast: compiled.ast,
    resources: compiled.resources,
    sourceComponents: normalizedComponents,
    documentHash,
    sourceHash,
  };
}

function compileFetchedDocument(options = {}) {
  const html = String(options.html || '');
  const bytes = Buffer.isBuffer(options.buffer) ? options.buffer : Buffer.from(html, 'utf8');
  const primaryRawHash = String(options.rawHash || '') || computeRawHash(bytes);
  return compileDocument({
    ...options,
    html,
    provenance: 'fetched',
    rawStatus: 'available',
    primaryRawHash,
  });
}

function compileFeedDocument(options = {}) {
  const entry = options.entry || {};
  const html = String(entry.content || entry.summary || '');
  const sourceComponents = [
    ...(options.sourceComponents || []),
    { type: 'feed', content: { title: entry.title || '', summary: entry.summary || '', html } },
  ];
  return compileDocument({
    ...options,
    entry,
    html,
    provenance: 'feed',
    rawStatus: 'unavailable',
    sourceComponents,
  });
}

function compileLegacyDocument(options = {}) {
  const entry = options.entry || {};
  const html = String(entry.content || '');
  const existingContentHash = String(entry.contentHash || '')
    || computeRawHash(Buffer.from(html, 'utf8'));
  const sourceComponents = [
    ...(options.sourceComponents || []),
    { type: 'legacy', contentHash: existingContentHash },
  ];
  return compileDocument({
    ...options,
    entry,
    html,
    provenance: 'legacy',
    rawStatus: 'unavailable',
    primaryRawHash: existingContentHash,
    sourceComponents,
  });
}

function articleDocumentProjection(document = {}) {
  return {
    extractorVersion: String(document.extractorVersion || ''),
    sanitizerVersion: String(document.sanitizerVersion || ''),
    segmenterVersion: String(document.segmenterVersion || ''),
    title: String(document.title || ''),
    summary: String(document.summary || ''),
    normalizedHtml: String(document.normalizedHtml || ''),
    plainText: String(document.plainText || ''),
    ast: Array.isArray(document.ast) ? document.ast : [],
    resources: Array.isArray(document.resources) ? document.resources : [],
  };
}

function matchesEntryProjection(document, compiled) {
  return canonicalSerialize(articleDocumentProjection(document))
    === canonicalSerialize(articleDocumentProjection(compiled));
}

module.exports = {
  compileFetchedDocument,
  compileFeedDocument,
  compileLegacyDocument,
  matchesEntryProjection,
};
