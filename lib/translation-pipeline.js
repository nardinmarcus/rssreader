const { chunkTranslationInput } = require('./translation-chunker');
const { articleDocumentSegments } = require('./article-documents');
const {
  buildTranslationInputV2,
  validateTranslationResponse,
} = require('./translation-contract');
const { renderTranslation } = require('./translation-renderer');

async function defaultTranslateChunk(chunkInput, { aiConfig }) {
  const { translateChunkV2 } = require('./deepseek');
  return translateChunkV2(chunkInput, aiConfig);
}

async function translateDocumentV2({ document, aiConfig = {}, translateChunk, limits } = {}) {
  if (!document || typeof document !== 'object') throw new TypeError('document is required');
  const input = buildTranslationInputV2({
    documentId: document.id || document.documentId || document.documentHash,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: articleDocumentSegments(document.ast),
  });
  const chunkLimits = {
    ...(aiConfig && aiConfig.maxTokens ? { maxOutputTokens: aiConfig.maxTokens } : {}),
    ...(limits || {}),
  };
  const chunks = chunkTranslationInput(input, chunkLimits);
  const runChunk = translateChunk || defaultTranslateChunk;
  const content = {};

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunkInput = chunks[chunkIndex];
    let chunkMap;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await runChunk(chunkInput, { chunkIndex, attempt, aiConfig });
        chunkMap = validateTranslationResponse(response, chunkInput);
        break;
      } catch (error) {
        if (error.code !== 'ERR_TRANSLATION_RESPONSE_INVALID') throw error;
        if (attempt === 0) continue;
        const chunkError = new Error(`translation chunk ${chunkIndex} remained invalid`, { cause: error });
        chunkError.code = 'ERR_TRANSLATION_CHUNK_INVALID';
        chunkError.chunkIndex = chunkIndex;
        throw chunkError;
      }
    }
    Object.assign(content, chunkMap);
  }

  return renderTranslation(document, content);
}

module.exports = { translateDocumentV2 };
