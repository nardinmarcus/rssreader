function chunkTranslationInput(input, limits = {}) {
  const maxChunkChars = limits.maxChunkChars || 12000;
  const maxSegmentChars = limits.maxSegmentChars || maxChunkChars;
  const maxTotalChars = limits.maxTotalChars || 250000;
  const segments = input.segments || [];
  const totalChars = segments.reduce((sum, segment) => sum + String(segment.text || '').length, 0);

  for (const segment of segments) {
    const segmentChars = String(segment.text || '').length;
    if (segmentChars > maxSegmentChars || segmentChars > maxChunkChars) {
      const error = new RangeError(`translation segment ${segment.id} exceeds the hard limit`);
      error.code = 'ERR_TRANSLATION_SEGMENT_TOO_LARGE';
      error.segmentId = segment.id;
      error.segmentChars = segmentChars;
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

  function flush() {
    if (!current.length) return;
    chunks.push({ ...input, segments: current });
    current = [];
    currentChars = 0;
  }

  for (const segment of segments) {
    const segmentChars = String(segment.text || '').length;
    const startsSection = segment.role === 'heading';
    if (current.length && (startsSection || currentChars + segmentChars > maxChunkChars)) flush();
    current.push(segment);
    currentChars += segmentChars;
  }
  flush();
  return chunks;
}

module.exports = { chunkTranslationInput };
