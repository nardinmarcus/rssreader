const ONEPAGE_SCHEMA_VERSION = 1;
const ONEPAGE_MAX_TEXT_CHARS = 1200;

function contractError(message) {
  const error = new TypeError(`Invalid OnepageV1: ${message}`);
  error.code = 'ERR_ONEPAGE_CONTRACT';
  error.statusCode = 422;
  return error;
}

function textSegments(nodes, out = []) {
  for (const node of nodes || []) {
    if (node && node.type === 'text' && node.id) out.push(node);
    if (node && node.alt && node.alt.type === 'text' && node.alt.id) out.push(node.alt);
    if (node && Array.isArray(node.children)) textSegments(node.children, out);
  }
  return out;
}

function cleanText(value, field, { max = 240, allowEmpty = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text && !allowEmpty) throw contractError(`${field} is required`);
  if (text.length > max) throw contractError(`${field} exceeds ${max} characters`);
  if (/https?:\/\//i.test(text)) throw contractError(`${field}: URLs are not allowed`);
  if (/<\/?[a-z][^>]*>/i.test(text) || /\[[^\]]+\]\([^)]+\)/.test(text)) {
    throw contractError(`${field}: markup is not allowed`);
  }
  return text;
}

function segmentIds(value, field, knownIds) {
  if (!Array.isArray(value) || !value.length) throw contractError(`${field} needs source segments`);
  const ids = [...new Set(value.map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) throw contractError(`${field} needs source segments`);
  for (const id of ids) {
    if (!knownIds.has(id)) throw contractError(`${field}: unknown source segment ${id}`);
  }
  return ids;
}

function claim(value, field, knownIds, { withTitle = false, withLabel = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(`${field} must be an object`);
  return {
    ...(withTitle ? { title: cleanText(value.title, `${field}.title`, { max: 42 }) } : {}),
    ...(withLabel ? { label: cleanText(value.label, `${field}.label`, { max: 24 }) } : {}),
    text: cleanText(value.text, `${field}.text`, { max: 180 }),
    segmentIds: segmentIds(value.segmentIds, `${field}.segmentIds`, knownIds),
  };
}

function claimList(value, field, knownIds, { min, max, ...options }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw contractError(`${field} must contain ${min}-${max} items`);
  }
  return value.map((item, index) => claim(item, `${field}[${index}]`, knownIds, options));
}

function normalizeFramework(value, knownIds) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('framework must be an object');
  return {
    title: cleanText(value.title, 'framework.title', { max: 42 }),
    steps: claimList(value.steps, 'framework.steps', knownIds, { min: 2, max: 5, withLabel: true }),
  };
}

function payloadTextLength(payload) {
  const values = [payload.title, payload.thesis.text];
  for (const item of [...payload.keyPoints, ...payload.evidence, ...payload.implications]) {
    values.push(item.title || '', item.label || '', item.text);
  }
  if (payload.framework) {
    values.push(payload.framework.title);
    for (const step of payload.framework.steps) values.push(step.label, step.text);
  }
  values.push(...payload.questions);
  return values.join('').length;
}

function normalizeOnepagePayload(value, document) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('response must be an object');
  if (Number(value.schemaVersion) !== ONEPAGE_SCHEMA_VERSION) throw contractError('schemaVersion must be 1');
  const knownIds = new Set(textSegments(document && document.ast).map(segment => segment.id));
  if (!knownIds.size) throw contractError('pinned document has no source segments');
  const payload = {
    schemaVersion: ONEPAGE_SCHEMA_VERSION,
    title: cleanText(value.title, 'title', { max: 72 }),
    thesis: claim(value.thesis, 'thesis', knownIds),
    keyPoints: claimList(value.keyPoints, 'keyPoints', knownIds, { min: 3, max: 5, withTitle: true }),
    evidence: claimList(value.evidence, 'evidence', knownIds, { min: 2, max: 6 }),
    framework: normalizeFramework(value.framework, knownIds),
    implications: claimList(value.implications, 'implications', knownIds, { min: 1, max: 4 }),
    questions: Array.isArray(value.questions)
      ? value.questions.map((item, index) => cleanText(item, `questions[${index}]`, { max: 100 }))
      : [],
  };
  if (payload.questions.length < 1 || payload.questions.length > 4) {
    throw contractError('questions must contain 1-4 items');
  }
  const contentLength = payloadTextLength(payload);
  if (contentLength > ONEPAGE_MAX_TEXT_CHARS) {
    throw contractError(`content has ${contentLength} characters; maximum is ${ONEPAGE_MAX_TEXT_CHARS}`);
  }
  return payload;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function evidenceAttrs(item) {
  return ` data-segment-ids="${escapeHtml(item.segmentIds.join(' '))}"`;
}

function sourceEvidence(item, segmentMap) {
  const excerpts = item.segmentIds
    .map(id => [id, segmentMap.get(id)])
    .filter(([, text]) => text)
    .map(([id, text]) => {
      const normalized = String(text).replace(/\s+/g, ' ').trim();
      const excerpt = normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
      return `<blockquote data-source-segment-id="${escapeHtml(id)}">${escapeHtml(excerpt)}</blockquote>`;
    });
  if (!excerpts.length) return '';
  return `<details class="onepage-source-evidence"><summary>查看原文依据</summary>${excerpts.join('')}</details>`;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function renderClaims(items, className, segmentMap, { title = false } = {}) {
  return items.map(item => [
    `<li class="${className}"${evidenceAttrs(item)}>` ,
    title ? `<h3>${escapeHtml(item.title)}</h3>` : '',
    `<p>${escapeHtml(item.text)}</p>`,
    sourceEvidence(item, segmentMap),
    '</li>',
  ].join('')).join('');
}

function renderOnepageHtml(payload, { entry = {}, document = {} } = {}) {
  const segmentMap = new Map(textSegments(document.ast).map(segment => [segment.id, segment.text]));
  const sourceUrl = safeSourceUrl(entry.link);
  const sourceTitle = escapeHtml(entry.title || '原文');
  const sourceLine = [entry.author, entry.published].filter(Boolean).map(escapeHtml).join(' · ');
  const framework = payload.framework ? [
    '<section class="onepage-section onepage-framework">',
    `<h2>${escapeHtml(payload.framework.title)}</h2>`,
    '<ol>',
    payload.framework.steps.map(step => `<li${evidenceAttrs(step)}><strong>${escapeHtml(step.label)}</strong><span>${escapeHtml(step.text)}</span>${sourceEvidence(step, segmentMap)}</li>`).join(''),
    '</ol>',
    '</section>',
  ].join('') : '';
  return [
    '<article class="onepage-shell" data-onepage-version="1">',
    '<header class="onepage-hero">',
    '<span class="onepage-kicker">ONEPAGE</span>',
    `<h1>${escapeHtml(payload.title)}</h1>`,
    `<p class="onepage-thesis"${evidenceAttrs(payload.thesis)}>${escapeHtml(payload.thesis.text)}</p>`,
    sourceEvidence(payload.thesis, segmentMap),
    '</header>',
    '<section class="onepage-section onepage-key-points"><h2>关键观点</h2><ol>',
    renderClaims(payload.keyPoints, 'onepage-key-point', segmentMap, { title: true }),
    '</ol></section>',
    '<section class="onepage-section onepage-evidence"><h2>事实依据</h2><ul>',
    renderClaims(payload.evidence, 'onepage-evidence-item', segmentMap),
    '</ul></section>',
    framework,
    '<section class="onepage-section onepage-implications"><h2>意味着什么</h2><ul>',
    renderClaims(payload.implications, 'onepage-implication', segmentMap),
    '</ul></section>',
    '<section class="onepage-section onepage-questions"><h2>继续思考</h2><ul>',
    payload.questions.map(question => `<li>${escapeHtml(question)}</li>`).join(''),
    '</ul></section>',
    '<footer class="onepage-source">',
    '<span>来源</span>',
    sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${sourceTitle}</a>` : `<strong>${sourceTitle}</strong>`,
    sourceLine ? `<small>${sourceLine}</small>` : '',
    '</footer>',
    '</article>',
  ].join('');
}

module.exports = {
  ONEPAGE_MAX_TEXT_CHARS,
  ONEPAGE_SCHEMA_VERSION,
  normalizeOnepagePayload,
  renderOnepageHtml,
  textSegments,
};
