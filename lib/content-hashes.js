const crypto = require('crypto');

const HASH_ALGORITHM = 'sha256';
const CANONICALIZATION_VERSION = 'canonical-json-v1';

function normalizeCanonicalString(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function unsupportedCanonicalValue(value) {
  const type = value === null ? 'null' : typeof value;
  throw new TypeError(`Unsupported canonical value: ${type}`);
}

function canonicalSerialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(normalizeCanonicalString(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return unsupportedCanonicalValue(value);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalSerialize(item)).join(',')}]`;
  }
  if (typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return unsupportedCanonicalValue(value);
  }

  const entries = Object.entries(value).map(([key, item]) => [normalizeCanonicalString(key), item]);
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) throw new TypeError('Unsupported canonical value: duplicate normalized object key');
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`).join(',')}}`;
}

function computeRawHash(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('Raw hash input must be bytes');
  }
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return crypto.createHash(HASH_ALGORITHM).update(bytes).digest('hex');
}

function computeCanonicalHash(value) {
  return crypto.createHash(HASH_ALGORITHM).update(canonicalSerialize(value), 'utf8').digest('hex');
}

function normalizeSourceComponents(value = []) {
  if (!Array.isArray(value)) throw new TypeError('sourceComponents must be an array');
  return value.map(component => ({
    type: String(component && component.type || ''),
    contentHash: String(component && component.contentHash || ''),
    snapshotId: component && component.snapshotId ? String(component.snapshotId) : null,
  })).sort((left, right) => {
    const a = canonicalSerialize(left);
    const b = canonicalSerialize(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function normalizeSemanticSourceComponents(value = []) {
  return normalizeSourceComponents(value).map(component => ({
    type: component.type,
    contentHash: component.contentHash,
  }));
}

function computeDocumentHash({
  primaryRawHash = '',
  sourceComponents = [],
  finalUrl = '',
  extractorVersion = '',
  sanitizerVersion = '',
  segmenterVersion = '',
  semanticInputHash = '',
} = {}) {
  return computeCanonicalHash({
    primaryRawHash,
    sourceComponents: normalizeSourceComponents(sourceComponents),
    finalUrl,
    extractorVersion,
    sanitizerVersion,
    segmenterVersion,
    ...(semanticInputHash ? { semanticInputHash } : {}),
  });
}

function computeSourceHash({
  title = '',
  summary = '',
  astText = [],
  resourceRefs = [],
  sourceComponents = [],
} = {}) {
  return computeCanonicalHash({
    title,
    ...(summary ? { summary } : {}),
    astText,
    resourceRefs,
    sourceComponents: normalizeSemanticSourceComponents(sourceComponents),
  });
}

function computePipelineHash({
  schemaVersion,
  promptVersion = '',
  validationPolicyVersion = '',
} = {}) {
  return computeCanonicalHash({
    schemaVersion,
    promptVersion,
    validationPolicyVersion,
  });
}

function computeGenerationHash({
  documentId = '',
  sourceHash = '',
  pipelineHash = '',
  ownerPolicy = '',
  provider = '',
  model = '',
  tuning = {},
} = {}) {
  return computeCanonicalHash({
    documentId,
    sourceHash,
    pipelineHash,
    ownerPolicy,
    provider,
    model,
    tuning,
  });
}

module.exports = {
  CANONICALIZATION_VERSION,
  HASH_ALGORITHM,
  canonicalSerialize,
  computeDocumentHash,
  computeGenerationHash,
  computePipelineHash,
  computeRawHash,
  computeSourceHash,
};
