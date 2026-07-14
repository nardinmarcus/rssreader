const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../lib/translation-contract');

function contractInput() {
  return contract.buildTranslationInputV2({
    documentId: 'document-contract-errors',
    sourceHash: 'source-contract-errors',
    title: 'Contract errors',
    segments: [
      { id: 's_body', role: 'paragraph', text: 'Source body.' },
      { id: 's_code', role: 'code', text: 'const answer = 42;' },
    ],
  });
}

function completeResponse(input = contractInput()) {
  return {
    schemaVersion: 2,
    translations: input.segments.map(segment => ({
      id: segment.id,
      target: segment.role === 'code' ? segment.text : `译文 ${segment.id}`,
    })),
  };
}

test('TranslationInputV2 exposes only the fixed text wire schema and golden pipeline hash', () => {
  const input = contract.buildTranslationInputV2({
    documentId: 'document-v2-001',
    sourceHash: 'source-hash-001',
    title: 'A Cafe\u0301\r\nStory',
    summary: 'Summary context for the translator.',
    segments: [
      {
        id: 's_heading',
        role: 'heading',
        text: 'A Cafe\u0301 Story',
        resourceRefs: ['r_link'],
        href: 'https://example.com/private-resource-shape',
        html: '<a href="https://example.com/private-resource-shape">A Café Story</a>',
      },
    ],
  });

  assert.deepEqual(Object.keys(contract).sort(), [
    'buildTranslationInputV2',
    'translationPipelineHash',
    'validateTranslationResponse',
  ]);
  assert.deepEqual(input, {
    schemaVersion: 2,
    documentId: 'document-v2-001',
    sourceHash: 'source-hash-001',
    title: 'A Café\nStory',
    context: 'Summary context for the translator.',
    segments: [
      { id: 's_f3410f7d36082bd0', role: 'title', text: 'A Café\nStory' },
      { id: 's_heading', role: 'heading', text: 'A Café Story' },
    ],
  });
  assert.equal(
    contract.translationPipelineHash(),
    '0043ce0a57d2eb785b9f549ca2fd5f48ede575663ad5cfb8d99f3ab57a2428e3',
  );
});

test('summary is context when body exists and becomes a stable segment only when body is absent', () => {
  const identity = {
    documentId: 'document-summary-policy',
    sourceHash: 'source-summary-policy',
    title: 'Summary policy',
    summary: 'Only the summary is available.',
  };

  const withBody = contract.buildTranslationInputV2({
    ...identity,
    segments: [{ id: 's_body', role: 'paragraph', text: 'Full body text.' }],
  });
  const summaryOnly = contract.buildTranslationInputV2({ ...identity, segments: [] });

  assert.equal(withBody.context, 'Only the summary is available.');
  assert.deepEqual(withBody.segments, [
    { id: 's_3e42e089fba2af25', role: 'title', text: 'Summary policy' },
    { id: 's_body', role: 'paragraph', text: 'Full body text.' },
  ]);
  assert.equal(summaryOnly.context, '');
  assert.deepEqual(summaryOnly.segments, [
    { id: 's_3e42e089fba2af25', role: 'title', text: 'Summary policy' },
    { id: 's_ec7082110987d9dc', role: 'summary', text: 'Only the summary is available.' },
  ]);
});

test('valid V2 response normalizes to an input-ordered segment ID to plain-text mapping', () => {
  const input = contract.buildTranslationInputV2({
    documentId: 'document-valid-response',
    sourceHash: 'source-valid-response',
    title: 'Valid response',
    segments: [
      { id: 's_heading', role: 'heading', text: 'A heading' },
      { id: 's_code', role: 'code', text: 'const café = 1;\nconsole.log(café);' },
    ],
  });

  const mapping = contract.validateTranslationResponse({
    schemaVersion: 2,
    translations: [
      { id: 's_code', target: 'const cafe\u0301 = 1;\r\nconsole.log(cafe\u0301);' },
      { id: 's_heading', target: '  一个标题  ' },
      { id: 's_222e953ebc86939d', target: '有效响应' },
    ],
  }, input);

  assert.deepEqual(mapping, {
    s_222e953ebc86939d: '有效响应',
    s_heading: '一个标题',
    s_code: 'const café = 1;\nconsole.log(café);',
  });
});

test('title remains chunk context and is also a stable translatable segment', () => {
  const input = contract.buildTranslationInputV2({
    documentId: 'document-title-segment',
    sourceHash: 'source-title-segment',
    title: 'A Café\r\nStory',
    summary: 'Context only.',
    segments: [{ id: 's_body', role: 'paragraph', text: 'Body.' }],
  });

  assert.equal(input.title, 'A Café\nStory');
  assert.deepEqual(input.segments, [
    { id: 's_f3410f7d36082bd0', role: 'title', text: 'A Café\nStory' },
    { id: 's_body', role: 'paragraph', text: 'Body.' },
  ]);
});

test('validator rejects a response with the wrong schema version', () => {
  const input = contractInput();
  const response = { ...completeResponse(input), schemaVersion: 1 };

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /schemaVersion must be 2/,
  );
});

test('validator rejects a response missing any requested segment', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations = response.translations.filter(item => item.id !== 's_code');

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /missing segment s_code/,
  );
});

test('validator rejects duplicate segment IDs', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations.push({ id: 's_body', target: '第二份重复译文' });

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /duplicate segment s_body/,
  );
});

test('validator rejects unknown segment IDs', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations.push({ id: 's_model_invented', target: '模型新增内容' });

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /unknown segment s_model_invented/,
  );
});

test('validator rejects empty translated text', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations.find(item => item.id === 's_body').target = ' \r\n ';

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /empty translation for s_body/,
  );
});

test('validator rejects extra top-level response fields', () => {
  const input = contractInput();
  const response = { ...completeResponse(input), titleZh: '旧结构标题' };

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /unexpected response field titleZh/,
  );
});

test('validator rejects HTML, URL, resource, and legacy fields on translation items', () => {
  const input = contractInput();
  for (const field of ['targetHtml', 'html', 'zh', 'href', 'src', 'resource']) {
    const response = completeResponse(input);
    response.translations[0][field] = field === 'resource' ? { url: 'https://example.com/image.png' } : 'https://example.com/editable';

    assert.throws(
      () => contract.validateTranslationResponse(response, input),
      new RegExp(`unexpected translation field ${field}`),
    );
  }
});

test('validator rejects a modified code segment', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations.find(item => item.id === 's_code').target = 'const answer = 43;';

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /code segment s_code must be preserved exactly/,
  );
});

test('validator accepts only plain translated text without HTML or editable URLs', () => {
  const input = contractInput();
  for (const target of [
    '<strong>模型 HTML</strong>',
    '模型新增链接 https://attacker.example/changed',
    '![模型图片](https://attacker.example/image.png)',
    '[模型相对链接](/changed)',
  ]) {
    const response = completeResponse(input);
    response.translations.find(item => item.id === 's_body').target = target;

    assert.throws(
      () => contract.validateTranslationResponse(response, input),
      /translation for s_body must be plain text without HTML or URLs/,
    );
  }
});

test('validator does not trim away model changes around code segments', () => {
  const input = contractInput();
  const response = completeResponse(input);
  response.translations.find(item => item.id === 's_code').target = ' const answer = 42;';

  assert.throws(
    () => contract.validateTranslationResponse(response, input),
    /code segment s_code must be preserved exactly/,
  );
});

test('builder preserves code whitespace while normalizing line endings and Unicode', () => {
  const input = contract.buildTranslationInputV2({
    documentId: 'document-code-whitespace',
    sourceHash: 'source-code-whitespace',
    title: '',
    segments: [{
      id: 's_indented_code',
      role: 'code',
      text: '\r\n  const cafe\u0301 = 1;\r\n',
    }],
  });

  assert.deepEqual(input.segments, [{
    id: 's_indented_code',
    role: 'code',
    text: '\n  const café = 1;\n',
  }]);
});

test('validator explicitly rejects legacy paragraphs, blocks, zh, and html response shapes', () => {
  const input = contractInput();
  const legacyResponses = [
    { schemaVersion: 2, paragraphs: [{ i: 0, zh: '旧译文' }] },
    { schemaVersion: 2, blocks: [{ i: 0, target: '旧译文', targetHtml: '<p>旧译文</p>' }] },
    {
      schemaVersion: 2,
      translations: completeResponse(input).translations.map((item, index) => (
        index === 0 ? { id: item.id, target: item.target, zh: item.target, html: `<p>${item.target}</p>` } : item
      )),
    },
  ];

  for (const response of legacyResponses) {
    assert.throws(() => contract.validateTranslationResponse(response, input), /invalid TranslationResponseV2/);
  }
});
