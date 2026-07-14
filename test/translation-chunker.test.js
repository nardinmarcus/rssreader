const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkTranslationInput } = require('../lib/translation-chunker');

function inputWith(segments) {
  return {
    schemaVersion: 2,
    documentId: 'document-chunking',
    sourceHash: 'source-chunking',
    title: 'Chunking',
    context: 'Stable context.',
    segments,
  };
}

test('chunks every segment exactly once in stable order and prefers heading boundaries', () => {
  const input = inputWith([
    { id: 's_title', role: 'title', text: 'Title' },
    { id: 's_intro', role: 'paragraph', text: '12345678' },
    { id: 's_heading', role: 'heading', text: 'Head' },
    { id: 's_body_1', role: 'paragraph', text: 'abcdefgh' },
    { id: 's_body_2', role: 'paragraph', text: 'ABCDEFGH' },
  ]);

  const chunks = chunkTranslationInput(input, {
    maxChunkChars: 20,
    maxSegmentChars: 20,
    maxTotalChars: 100,
  });

  assert.deepEqual(chunks.map(chunk => chunk.segments.map(segment => segment.id)), [
    ['s_title', 's_intro'],
    ['s_heading', 's_body_1', 's_body_2'],
  ]);
  assert.deepEqual(chunks.flatMap(chunk => chunk.segments.map(segment => segment.id)), input.segments.map(segment => segment.id));
  assert.equal(new Set(chunks.flatMap(chunk => chunk.segments.map(segment => segment.id))).size, input.segments.length);
  assert.ok(chunks.every(chunk => chunk.documentId === input.documentId));
  assert.ok(chunks.every(chunk => chunk.context === input.context));
});

test('fails explicitly when a single segment exceeds its hard limit instead of slicing it', () => {
  const oversized = { id: 's_oversized', role: 'paragraph', text: '0123456789TAIL' };
  const input = inputWith([oversized]);

  assert.throws(
    () => chunkTranslationInput(input, {
      maxChunkChars: 20,
      maxSegmentChars: 10,
      maxTotalChars: 100,
    }),
    error => error.code === 'ERR_TRANSLATION_SEGMENT_TOO_LARGE'
      && error.segmentId === oversized.id
      && oversized.text.endsWith('TAIL'),
  );
});

test('fails explicitly when the complete document exceeds its hard limit', () => {
  const input = inputWith([
    { id: 's_one', role: 'paragraph', text: '12345678' },
    { id: 's_two', role: 'paragraph', text: 'abcdefgh' },
  ]);

  assert.throws(
    () => chunkTranslationInput(input, {
      maxChunkChars: 10,
      maxSegmentChars: 10,
      maxTotalChars: 15,
    }),
    error => error.code === 'ERR_TRANSLATION_DOCUMENT_TOO_LARGE'
      && error.totalChars === 16,
  );
});
