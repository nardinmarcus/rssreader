const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('data paths resolve one configured directory and keep the SQLite filename stable', () => {
  const { DATABASE_FILENAME, resolveDataDir, resolveDataPaths } = require('../lib/data-paths');
  const configured = path.join('tmp', 'namoo-reader-data');
  const dataDir = resolveDataDir({ NAMOO_READER_DATA_DIR: configured });
  const paths = resolveDataPaths({ NAMOO_READER_DATA_DIR: configured });

  assert.equal(DATABASE_FILENAME, 'qmreader.sqlite');
  assert.equal(dataDir, path.resolve(configured));
  assert.deepEqual(paths, {
    dataDir,
    databaseFile: path.join(dataDir, 'qmreader.sqlite'),
  });
  assert.equal(resolveDataDir({}), path.resolve(__dirname, '..', 'data'));
});

test('canonical serialization fixes Unicode, key, array, empty value, and newline rules', () => {
  const { CANONICALIZATION_VERSION, canonicalSerialize } = require('../lib/content-hashes');
  const value = {
    z: ['second', 'first', null, ''],
    a: {
      y: 'line1\r\nline2\rline3',
      x: 'Cafe\u0301',
    },
  };

  assert.equal(CANONICALIZATION_VERSION, 'canonical-json-v1');
  assert.equal(
    canonicalSerialize(value),
    '{"a":{"x":"Café","y":"line1\\nline2\\nline3"},"z":["second","first",null,""]}'
  );
  assert.throws(() => canonicalSerialize({ missing: undefined }), /unsupported canonical value/i);
});

test('raw hash is the golden SHA-256 of the exact response bytes', () => {
  const { computeRawHash } = require('../lib/content-hashes');
  const bytes = Buffer.from([0x00, 0x43, 0x61, 0x66, 0xc3, 0xa9, 0x0d, 0x0a, 0xff]);

  assert.equal(
    computeRawHash(bytes),
    '2b9bede9a15adc7014c46cd166e8a48aa266d2e82f13a6eb365cb748ea4c8995'
  );
  assert.throws(() => computeRawHash('Café'), /raw hash input must be bytes/i);
});

test('document hash matches the golden canonical identity with stable source components', () => {
  const { computeDocumentHash } = require('../lib/content-hashes');
  const input = {
    primaryRawHash: 'raw-primary',
    sourceComponents: [
      { type: 'submission', contentHash: 'hash-submission', snapshotId: 'snapshot-submission' },
      { type: 'discussion', contentHash: 'hash-discussion' },
    ],
    finalUrl: 'https://example.com/article?x=1',
    extractorVersion: 'extractor-v2',
    sanitizerVersion: 'sanitizer-v3',
    segmenterVersion: 'segmenter-v4',
  };

  assert.equal(
    computeDocumentHash(input),
    'a308463fa6fa1f96b2048af2aff58795d4ab3b6022b4ec4fb636bd018ce5400b'
  );
  assert.equal(computeDocumentHash({ ...input, sourceComponents: [...input.sourceComponents].reverse() }), computeDocumentHash(input));
});

test('source hash matches the golden semantic document identity', () => {
  const { computeSourceHash } = require('../lib/content-hashes');
  const input = {
    title: 'A Cafe\u0301\r\nStory',
    astText: [
      { id: 's_heading', role: 'heading', text: 'A Café Story' },
      { id: 's_body', role: 'paragraph', text: 'Line one.\r\nLine two.' },
    ],
    resourceRefs: [
      { id: 'r_link', type: 'link', url: 'https://example.com/docs' },
    ],
    sourceComponents: [
      { type: 'submission', contentHash: 'hash-submission', snapshotId: 'snapshot-submission' },
      { type: 'discussion', contentHash: 'hash-discussion' },
    ],
  };

  assert.equal(
    computeSourceHash(input),
    '6777bd3bf7894314b6941cef3b02fd95d5b78f08dae27a3f126e46dc96baf8c5'
  );
});

test('source identity ignores observation-only snapshot ids while document evidence keeps them', () => {
  const { computeDocumentHash, computeSourceHash } = require('../lib/content-hashes');
  const semantic = {
    title: 'Stable source',
    astText: [{ id: 's_body', role: 'paragraph', text: 'Stable body.' }],
    resourceRefs: [],
    sourceComponents: [{ type: 'discussion', contentHash: 'stable-component', snapshotId: 'snapshot-one' }],
  };
  const evidence = {
    primaryRawHash: 'stable-raw',
    sourceComponents: semantic.sourceComponents,
    finalUrl: 'https://example.com/stable',
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
  };
  const observedAgain = [{ ...semantic.sourceComponents[0], snapshotId: 'snapshot-two' }];

  assert.equal(
    computeSourceHash({ ...semantic, sourceComponents: observedAgain }),
    computeSourceHash(semantic),
  );
  assert.notEqual(
    computeDocumentHash({ ...evidence, sourceComponents: observedAgain }),
    computeDocumentHash(evidence),
  );
  assert.notEqual(
    computeSourceHash({
      ...semantic,
      sourceComponents: [{ ...semantic.sourceComponents[0], contentHash: 'changed-component' }],
    }),
    computeSourceHash(semantic),
  );
});

test('pipeline hash matches the golden schema, prompt, and validation identity', () => {
  const { computePipelineHash } = require('../lib/content-hashes');

  assert.equal(
    computePipelineHash({
      schemaVersion: 2,
      promptVersion: 'translation-prompt-v2',
      validationPolicyVersion: 'strict-v1',
    }),
    'e9f8e34335db1708d76c8be32bd42c95111979c41001c2c7affd5da5be65824d'
  );
});

test('generation hash matches the golden owner and model identity', () => {
  const { computeGenerationHash } = require('../lib/content-hashes');

  assert.equal(
    computeGenerationHash({
      documentId: 'entry-1-document-1',
      sourceHash: '45a7572fc3ccdb84b01a9b9d6a22eddf692b35b0915e2b692b234be9bf790268',
      pipelineHash: 'e9f8e34335db1708d76c8be32bd42c95111979c41001c2c7affd5da5be65824d',
      ownerPolicy: 'system',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      tuning: { temperature: 0.15, maxTokens: 4096 },
    }),
    'adc196347fe82c928642ff02bd95fecee24f6b7695d99326dd1e582a0bdd0d7b'
  );
});

test('document hash changes with final URL, source components, or document pipeline versions', () => {
  const { computeDocumentHash } = require('../lib/content-hashes');
  const base = {
    primaryRawHash: 'raw-primary',
    sourceComponents: [{ type: 'discussion', contentHash: 'discussion-v1' }],
    finalUrl: 'https://example.com/article',
    extractorVersion: 'extractor-v1',
    sanitizerVersion: 'sanitizer-v1',
    segmenterVersion: 'segmenter-v1',
  };
  const baseHash = computeDocumentHash(base);

  assert.notEqual(computeDocumentHash({ ...base, finalUrl: 'https://example.net/article' }), baseHash);
  assert.notEqual(computeDocumentHash({ ...base, sourceComponents: [{ type: 'discussion', contentHash: 'discussion-v2' }] }), baseHash);
  assert.notEqual(computeDocumentHash({ ...base, extractorVersion: 'extractor-v2' }), baseHash);
  assert.notEqual(computeDocumentHash({ ...base, sanitizerVersion: 'sanitizer-v2' }), baseHash);
  assert.notEqual(computeDocumentHash({ ...base, segmenterVersion: 'segmenter-v2' }), baseHash);
});

test('changing only the model changes generation hash without changing source hash', () => {
  const { computeGenerationHash, computeSourceHash } = require('../lib/content-hashes');
  const sourceInput = {
    title: 'Stable article',
    astText: [{ id: 's_1', role: 'paragraph', text: 'Stable source text.' }],
    resourceRefs: [],
    sourceComponents: [],
  };
  const sourceHash = computeSourceHash(sourceInput);
  const generation = {
    documentId: 'entry-1-document-1',
    sourceHash,
    pipelineHash: 'pipeline-v1',
    ownerPolicy: 'system',
    provider: 'deepseek',
    model: 'model-a',
    tuning: { temperature: 0.15 },
  };

  assert.equal(computeSourceHash(sourceInput), sourceHash);
  assert.notEqual(computeGenerationHash({ ...generation, model: 'model-b' }), computeGenerationHash(generation));
});

test('generation hash keeps identical source content isolated by document identity', () => {
  const { computeGenerationHash } = require('../lib/content-hashes');
  const generation = {
    sourceHash: 'same-source-hash',
    pipelineHash: 'pipeline-v2',
    ownerPolicy: 'system',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tuning: { temperature: 0.15, maxTokens: 6000 },
  };

  assert.notEqual(
    computeGenerationHash({ ...generation, documentId: 'entry-a-document' }),
    computeGenerationHash({ ...generation, documentId: 'entry-b-document' }),
  );
});
