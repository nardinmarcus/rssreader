function chunkTranslationInput(input, limits = {}) {
  const maxChunkChars = limits.maxChunkChars || 12000;
  const maxSegmentChars = limits.maxSegmentChars || maxChunkChars;
  const maxTotalChars = limits.maxTotalChars || 250000;
  const configuredOutputTokens = Number(limits.maxOutputTokens ?? 2000);
  if (!Number.isFinite(configuredOutputTokens) || configuredOutputTokens <= 0) {
    throw new TypeError('maxOutputTokens must be a positive number');
  }
  const outputTokenBudget = Math.max(1, Math.floor(configuredOutputTokens * 0.8));
  const segments = input.segments || [];
  const totalChars = segments.reduce((sum, segment) => sum + String(segment.text || '').length, 0);

  function estimatedOutputTokens(segment) {
    if (segment.role === 'code') return 0;
    return 16 + Math.ceil(String(segment.text || '').length * 0.75);
  }

  for (const segment of segments) {
    const segmentChars = String(segment.text || '').length;
    if (segmentChars > maxSegmentChars || segmentChars > maxChunkChars) {
      const error = new RangeError(`translation segment ${segment.id} exceeds the hard limit`);
      error.code = 'ERR_TRANSLATION_SEGMENT_TOO_LARGE';
      error.segmentId = segment.id;
      error.segmentChars = segmentChars;
      throw error;
    }
    const estimatedTokens = estimatedOutputTokens(segment);
    if (estimatedTokens > outputTokenBudget) {
      const error = new RangeError(`translation segment ${segment.id} exceeds the provider output budget`);
      error.code = 'ERR_TRANSLATION_SEGMENT_OUTPUT_TOO_LARGE';
      error.segmentId = segment.id;
      error.estimatedOutputTokens = estimatedTokens;
      error.outputTokenBudget = outputTokenBudget;
      throw error;
    }
  }
  if (totalChars > maxTotalChars) {
    const error = new RangeError('translation document exceeds the hard limit');
    error.code = 'ERR_TRANSLATION_DOCUMENT_TOO_LARGE';
    error.totalChars = totalChars;
    throw error;
  }

  const chunks = [];
  let current = [];
  let currentChars = 0;
  let currentOutputTokens = 0;

  function flush() {
    if (!current.length) return;
    chunks.push({ ...input, segments: current });
    current = [];
    currentChars = 0;
    currentOutputTokens = 0;
  }

  for (const segment of segments) {
    const segmentChars = String(segment.text || '').length;
    const segmentOutputTokens = estimatedOutputTokens(segment);
    const startsSection = segment.role === 'heading';
    if (current.length && (
      startsSection
      || currentChars + segmentChars > maxChunkChars
      || currentOutputTokens + segmentOutputTokens > outputTokenBudget
    )) flush();
    current.push(segment);
    currentChars += segmentChars;
    currentOutputTokens += segmentOutputTokens;
  }
  flush();
  return chunks;
}

module.exports = { chunkTranslationInput };
