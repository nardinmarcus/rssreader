const crypto = require('crypto');
const deepseek = require('./deepseek');
const translationJobs = require('./translation-jobs');
const { canonicalSerialize, computeGenerationHash, computeRawHash } = require('./content-hashes');
const { buildTranslationInputV2, translationPipelineHash } = require('./translation-contract');
const { chunkTranslationInput } = require('./translation-chunker');

function articleDocumentSegments(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'text') out.push(node);
    if (node.alt && node.alt.type === 'text') out.push(node.alt);
    if (Array.isArray(node.children)) articleDocumentSegments(node.children, out);
  }
  return out;
}

function chunkHash(chunk) {
  return computeRawHash(Buffer.from(canonicalSerialize({
    schemaVersion: chunk.schemaVersion,
    documentId: chunk.documentId,
    sourceHash: chunk.sourceHash,
    segments: chunk.segments,
  }), 'utf8'));
}

function enqueueDocumentTranslation({
  entryId,
  document,
  ownerType,
  userId = null,
  author,
  priority = 0,
  force = false,
} = {}) {
  const config = deepseek.getConfig();
  if (!config.configured) {
    const error = new Error('站点 AI 尚未配置');
    error.statusCode = 503;
    throw error;
  }
  const input = buildTranslationInputV2({
    documentId: document && document.id,
    sourceHash: document && document.sourceHash,
    title: document && document.title,
    summary: document && document.summary,
    segments: articleDocumentSegments(document && document.ast),
  });
  const pipelineHash = translationPipelineHash();
  const tuning = { temperature: 0.15, maxTokens: config.maxTokens };
  const normalizedUserId = String(userId || '').trim() || null;
  const reusableGenerationHash = computeGenerationHash({
    documentId: document && document.id,
    sourceHash: document && document.sourceHash,
    pipelineHash,
    ownerPolicy: ownerType === 'user' ? `user:${normalizedUserId}` : 'system',
    provider: config.provider,
    model: config.model,
    tuning,
  });
  const generationHash = force
    ? computeRawHash(Buffer.from(canonicalSerialize({
      reusableGenerationHash,
      regenerationId: crypto.randomUUID(),
    }), 'utf8'))
    : reusableGenerationHash;
  const job = translationJobs.enqueue({
    entryId,
    documentId: document && document.id,
    ownerType,
    userId: normalizedUserId,
    author,
    sourceHash: document && document.sourceHash,
    pipelineHash,
    generationHash,
    provider: config.provider,
    model: config.model,
    tuning,
    priority,
    chunks: chunkTranslationInput(input).map(chunk => ({
      segmentIds: chunk.segments.map(segment => segment.id),
      chunkHash: chunkHash(chunk),
    })),
  });
  const promoted = translationJobs.promote(job.id, { priority });
  return { ...promoted, created: job.created };
}

module.exports = { enqueueDocumentTranslation };
