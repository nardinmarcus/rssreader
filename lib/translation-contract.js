const {
  canonicalSerialize,
  computePipelineHash,
  computeRawHash,
} = require('./content-hashes');

const SCHEMA_VERSION = 2;
const PROMPT_VERSION = 'translation-prompt-v2';
const VALIDATION_POLICY_VERSION = 'strict-v1';

function normalizeText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

function normalizeCodeText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').normalize('NFC');
}

function stableSegment(role, text) {
  const identity = canonicalSerialize({ role, text });
  return {
    id: `s_${computeRawHash(Buffer.from(identity, 'utf8')).slice(0, 16)}`,
    role,
    text,
  };
}

function buildTranslationInputV2({
  documentId = '',
  sourceHash = '',
  title = '',
  summary = '',
  segments = [],
} = {}) {
  const normalizedTitle = normalizeText(title);
  const context = normalizeText(summary);
  const normalizedSegments = segments.map(segment => {
    const role = normalizeText(segment && segment.role);
    return {
      id: normalizeText(segment && segment.id),
      role,
      text: role === 'code'
        ? normalizeCodeText(segment && segment.text)
        : normalizeText(segment && segment.text),
    };
  });
  const hasBody = normalizedSegments.length > 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    documentId: normalizeText(documentId),
    sourceHash: normalizeText(sourceHash),
    title: normalizedTitle,
    context: hasBody ? context : '',
    segments: [
      ...(normalizedTitle ? [stableSegment('title', normalizedTitle)] : []),
      ...(hasBody ? normalizedSegments : (context ? [stableSegment('summary', context)] : [])),
    ],
  };
}

function translationPipelineHash() {
  return computePipelineHash({
    schemaVersion: SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    validationPolicyVersion: VALIDATION_POLICY_VERSION,
  });
}

function invalidResponse(message) {
  const error = new TypeError(`invalid TranslationResponseV2: ${message}`);
  error.code = 'ERR_TRANSLATION_RESPONSE_INVALID';
  return error;
}

function containsHtmlOrUrl(value) {
  return /<\/?[a-z][^>]*>|<![^>]*>/i.test(value)
    || /\b(?:https?:\/\/|data:|javascript:|file:)/i.test(value)
    || /!?\[[^\]\n]*\]\([^)]+\)/.test(value);
}

function validateTranslationResponse(response, input) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw invalidResponse('response must be an object');
  }
  const allowedResponseFields = new Set(['schemaVersion', 'translations']);
  const extraResponseField = Object.keys(response).find(key => !allowedResponseFields.has(key));
  if (extraResponseField) throw invalidResponse(`unexpected response field ${extraResponseField}`);
  if (response.schemaVersion !== SCHEMA_VERSION) {
    throw invalidResponse(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(response.translations)) throw invalidResponse('translations must be an array');
  const expectedSegments = new Map((input.segments || []).map(segment => [segment.id, segment]));
  const expectedIds = new Set(expectedSegments.keys());
  const translated = new Map();
  for (const item of response.translations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidResponse('translation item must be an object');
    }
    const allowedTranslationFields = new Set(['id', 'target']);
    const extraTranslationField = Object.keys(item).find(key => !allowedTranslationFields.has(key));
    if (extraTranslationField) {
      throw invalidResponse(`unexpected translation field ${extraTranslationField}`);
    }
    if (translated.has(item.id)) throw invalidResponse(`duplicate segment ${item.id}`);
    if (!expectedIds.has(item.id)) throw invalidResponse(`unknown segment ${item.id}`);
    if (typeof item.target !== 'string') throw invalidResponse(`translation for ${item.id} must be text`);
    const expectedSegment = expectedSegments.get(item.id);
    const target = expectedSegment.role === 'code'
      ? normalizeCodeText(item.target)
      : normalizeText(item.target);
    if (!target.trim()) throw invalidResponse(`empty translation for ${item.id}`);
    if (expectedSegment.role !== 'code' && containsHtmlOrUrl(target)) {
      throw invalidResponse(`translation for ${item.id} must be plain text without HTML or URLs`);
    }
    translated.set(item.id, target);
  }
  const mapping = {};
  for (const segment of input.segments || []) {
    if (!translated.has(segment.id)) throw invalidResponse(`missing segment ${segment.id}`);
    if (segment.role === 'code' && translated.get(segment.id) !== normalizeCodeText(segment.text)) {
      throw invalidResponse(`code segment ${segment.id} must be preserved exactly`);
    }
    mapping[segment.id] = translated.get(segment.id);
  }
  return mapping;
}

module.exports = {
  buildTranslationInputV2,
  validateTranslationResponse,
  translationPipelineHash,
};
