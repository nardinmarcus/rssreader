const test = require('node:test');
const assert = require('node:assert/strict');

const { compileFeedDocument } = require('../lib/article-documents');
const { translateDocumentV2 } = require('../lib/translation-pipeline');

function pipelineDocument() {
  return {
    id: 'document-pipeline',
    ...compileFeedDocument({
      entry: {
        title: 'Title',
        summary: 'Context only.',
        link: 'https://example.com/post',
        content: '<p>12345678</p><h2>Head</h2><p>abcdefgh</p>',
      },
    }),
  };
}

function responseFor(input, { omitLast = false } = {}) {
  const segments = omitLast ? input.segments.slice(0, -1) : input.segments;
  return {
    schemaVersion: 2,
    translations: segments.map(segment => ({
      id: segment.id,
      target: segment.role === 'code' ? segment.text : `译文:${segment.text}`,
    })),
  };
}

const limits = {
  maxChunkChars: 20,
  maxSegmentChars: 20,
  maxTotalChars: 100,
};

test('retries only the invalid chunk once and publishes only after the complete document validates', async () => {
  const document = pipelineDocument();
  const calls = [];

  const result = await translateDocumentV2({
    document,
    aiConfig: { model: 'test-model' },
    limits,
    translateChunk: async (chunkInput, context) => {
      calls.push({ ids: chunkInput.segments.map(segment => segment.id), ...context });
      return responseFor(chunkInput, {
        omitLast: context.chunkIndex === 1 && context.attempt === 0,
      });
    },
  });

  assert.deepEqual(calls.map(call => ({
    ids: call.ids,
    chunkIndex: call.chunkIndex,
    attempt: call.attempt,
  })), [
    { ids: calls[0].ids, chunkIndex: 0, attempt: 0 },
    { ids: calls[1].ids, chunkIndex: 1, attempt: 0 },
    { ids: calls[1].ids, chunkIndex: 1, attempt: 1 },
  ]);
  assert.notDeepEqual(calls[0].ids, calls[1].ids);
  assert.equal(result.titleZh, '译文:Title');
  assert.equal(result.summaryZh, '');
  assert.match(result.renderedHtml, /<p>译文:12345678<\/p>/);
  assert.match(result.renderedHtml, /<h2>译文:Head<\/h2>/);
  assert.equal(Object.keys(result.content).length, 4);
});

test('a second invalid response aborts the whole document without retrying completed chunks', async () => {
  const document = pipelineDocument();
  const calls = [];

  await assert.rejects(
    translateDocumentV2({
      document,
      limits,
      translateChunk: async (chunkInput, context) => {
        calls.push({ ids: chunkInput.segments.map(segment => segment.id), ...context });
        return responseFor(chunkInput, { omitLast: context.chunkIndex === 1 });
      },
    }),
    error => error.code === 'ERR_TRANSLATION_CHUNK_INVALID'
      && error.chunkIndex === 1
      && error.cause.code === 'ERR_TRANSLATION_RESPONSE_INVALID',
  );

  assert.deepEqual(calls.map(call => [call.chunkIndex, call.attempt]), [
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
});
