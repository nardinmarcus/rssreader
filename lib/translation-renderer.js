const { buildTranslationInputV2 } = require('./translation-contract');

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'ol', 'ul', 'li', 'blockquote', 'pre', 'code', 'strong', 'em',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'a', 'img', 'hr',
]);
const VOID_TAGS = new Set(['br', 'hr']);

function renderError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeResourceUrl(resource) {
  try {
    const url = new URL(String(resource && resource.url || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe');
    return url.toString();
  } catch {
    throw renderError(
      'ERR_TRANSLATION_RESOURCE_UNSAFE',
      `translation resource ${resource && resource.id || ''} is unsafe`,
      { resourceId: resource && resource.id },
    );
  }
}

function segmentsFromAst(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'text') out.push(node);
    if (node.alt && node.alt.type === 'text') out.push(node.alt);
    if (Array.isArray(node.children)) segmentsFromAst(node.children, out);
  }
  return out;
}

function renderTranslation(document, segmentMap) {
  if (!document || typeof document !== 'object' || !segmentMap || typeof segmentMap !== 'object') {
    throw renderError('ERR_TRANSLATION_RENDER_INCOMPLETE', 'translation document and segment map are required');
  }
  const bodySegments = segmentsFromAst(document.ast);
  const input = buildTranslationInputV2({
    documentId: document.id || document.documentId || document.documentHash,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: bodySegments,
  });
  const content = {};
  for (const segment of input.segments) {
    if (!Object.prototype.hasOwnProperty.call(segmentMap, segment.id)
      || typeof segmentMap[segment.id] !== 'string'
      || !segmentMap[segment.id].trim()) {
      throw renderError(
        'ERR_TRANSLATION_RENDER_INCOMPLETE',
        `translation segment ${segment.id} is missing`,
        { segmentId: segment.id },
      );
    }
    if (segment.role === 'code' && segmentMap[segment.id] !== segment.text) {
      throw renderError(
        'ERR_TRANSLATION_RENDER_INCOMPLETE',
        `code segment ${segment.id} was modified`,
        { segmentId: segment.id },
      );
    }
    content[segment.id] = segmentMap[segment.id];
  }

  const resources = new Map((document.resources || []).map(resource => [resource.id, resource]));
  function resourceFor(node, type) {
    const resource = resources.get(node.resourceId);
    if (!resource || resource.type !== type) {
      throw renderError(
        'ERR_TRANSLATION_RESOURCE_UNSAFE',
        `translation resource ${node.resourceId || ''} is missing`,
        { resourceId: node.resourceId },
      );
    }
    return { resource, url: safeResourceUrl(resource) };
  }

  function renderNode(node) {
    if (node.type === 'text') {
      if (!Object.prototype.hasOwnProperty.call(content, node.id)) {
        throw renderError(
          'ERR_TRANSLATION_RENDER_INCOMPLETE',
          `translation segment ${node.id} is missing`,
          { segmentId: node.id },
        );
      }
      return `${node.leadingSpace ? ' ' : ''}${escapeHtml(content[node.id])}${node.trailingSpace ? ' ' : ''}`;
    }
    if (!node || node.type !== 'element' || !ALLOWED_TAGS.has(node.tag)) {
      throw renderError('ERR_TRANSLATION_RESOURCE_UNSAFE', 'translation AST contains an unsupported node');
    }
    if (VOID_TAGS.has(node.tag)) return `<${node.tag}>`;
    if (node.tag === 'img') {
      const { url } = resourceFor(node, 'image');
      const alt = node.alt ? content[node.alt.id] : '';
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    }
    const children = (node.children || []).map(renderNode).join('');
    if (node.tag === 'a') {
      const { url } = resourceFor(node, 'link');
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${children}</a>`;
    }
    return `<${node.tag}>${children}</${node.tag}>`;
  }

  const titleSegment = input.segments.find(segment => segment.role === 'title');
  const summarySegment = input.segments.find(segment => segment.role === 'summary');
  return {
    titleZh: titleSegment ? content[titleSegment.id] : '',
    summaryZh: summarySegment ? content[summarySegment.id] : '',
    content,
    renderedHtml: (document.ast || []).map(renderNode).join('\n'),
  };
}

module.exports = { renderTranslation };
