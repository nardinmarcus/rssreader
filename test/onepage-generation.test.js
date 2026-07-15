const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir('onepage-generation-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
const deepseek = require('../lib/deepseek');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function providerOptions() {
  return {
    apiKey: 'caller-owned-test-key',
    provider: 'openai-compatible',
    providerName: 'Test provider',
    providerType: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    model: 'test-model',
    temperature: 0.1,
    maxTokens: 2000,
  };
}

function document() {
  return {
    id: 'onepage-document',
    sourceHash: 'onepage-source',
    ast: [
      { type: 'element', tag: 'h2', children: [{ type: 'text', id: 's_title', role: 'heading', text: 'Reliable agents' }] },
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_1', role: 'paragraph', text: 'Tests cover 120 real tasks.' }] },
      { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_2', role: 'paragraph', text: 'Recovery is the main failure.' }] },
    ],
  };
}

function payload() {
  return {
    schemaVersion: 1,
    title: '可靠 Agent，不只是更聪明',
    thesis: { text: '竞争重点已经转向可靠完成任务。', segmentIds: ['s_title', 's_fact_2'] },
    keyPoints: [
      { title: '真实任务', text: '评估覆盖了 120 个任务。', segmentIds: ['s_fact_1'] },
      { title: '主要失败', text: '恢复能力是主要问题。', segmentIds: ['s_fact_2'] },
      { title: '系统视角', text: '需要关注完整任务链路。', segmentIds: ['s_title', 's_fact_2'] },
    ],
    evidence: [
      { text: '任务样本数量为 120。', segmentIds: ['s_fact_1'] },
      { text: '恢复是主要失败来源。', segmentIds: ['s_fact_2'] },
    ],
    framework: null,
    implications: [{ text: '可靠性评估应覆盖恢复路径。', segmentIds: ['s_fact_2'] }],
    questions: ['你的 Agent 能从中断处恢复吗？'],
  };
}

test('Onepage adapter sends only bounded document segments and returns validated structured text', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload()) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await deepseek.generateOnepagePayload({
      entry: {
        id: 'onepage-entry',
        title: 'Reliable agents',
        summary: 'Agent reliability summary.',
        link: 'https://example.com/never-send-this-url',
      },
      document: document(),
      aiConfig: providerOptions(),
    });
    const input = JSON.parse(requestBody.messages.find(message => message.role === 'user').content);

    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'test-model');
    assert.equal(requestBody.max_tokens, 4500);
    assert.deepEqual(input.segments.map(segment => segment.id), ['s_title', 's_fact_1', 's_fact_2']);
    assert.equal(JSON.stringify(input).includes('https://example.com'), false);
    assert.deepEqual(result.payload, payload());
  } finally {
    global.fetch = originalFetch;
  }
});

test('Onepage adapter fails closed when model evidence does not resolve to the document', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const invalid = payload();
    invalid.evidence[0].segmentIds = ['s_unknown'];
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(
      deepseek.generateOnepagePayload({
        entry: { id: 'onepage-entry', title: 'Reliable agents' },
        document: document(),
        aiConfig: providerOptions(),
      }),
      error => error.code === 'ERR_ONEPAGE_CONTRACT',
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Onepage adapter retries one contract-invalid response before succeeding', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const responsePayload = payload();
    if (calls === 1) responsePayload.framework = { title: '无效框架', steps: [] };
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responsePayload) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await deepseek.generateOnepagePayload({
      entry: { id: 'onepage-entry', title: 'Reliable agents' },
      document: document(),
      aiConfig: providerOptions(),
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.payload, payload());
  } finally {
    global.fetch = originalFetch;
  }
});

test('Onepage adapter gives an oversized response a concrete compact-output repair budget', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  let repairInstruction = '';
  global.fetch = async (_url, options) => {
    calls += 1;
    const requestBody = JSON.parse(options.body);
    if (calls === 2) repairInstruction = requestBody.messages.at(-1).content;
    const responsePayload = payload();
    if (calls === 1) {
      responsePayload.keyPoints = Array.from({ length: 5 }, (_, index) => ({
        title: `观点 ${index + 1}`,
        text: '甲'.repeat(180),
        segmentIds: ['s_fact_1'],
      }));
      responsePayload.evidence = Array.from({ length: 6 }, () => ({
        text: '乙'.repeat(180),
        segmentIds: ['s_fact_1'],
      }));
      responsePayload.implications = Array.from({ length: 4 }, () => ({
        text: '丙'.repeat(180),
        segmentIds: ['s_fact_2'],
      }));
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responsePayload) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await deepseek.generateOnepagePayload({
      entry: { id: 'onepage-entry', title: 'Reliable agents' },
      document: document(),
      aiConfig: providerOptions(),
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.payload, payload());
    assert.match(repairInstruction, /实际总文本 \d+ 个字符/);
    assert.match(repairInstruction, /压缩至 900 个字符内/);
    assert.match(repairInstruction, /3 项 keyPoints、2 项 evidence、1 项 implications、1 个 question/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Onepage input stays text-only and bounded across representative article shapes', async () => {
  const originalFetch = global.fetch;
  const capturedInputs = [];
  global.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    const input = JSON.parse(requestBody.messages.find(message => message.role === 'user').content);
    capturedInputs.push(input);
    const segmentId = input.segments[0].id;
    const responsePayload = payload();
    responsePayload.thesis.segmentIds = [segmentId];
    responsePayload.keyPoints.forEach(item => { item.segmentIds = [segmentId]; });
    responsePayload.evidence.forEach(item => { item.segmentIds = [segmentId]; });
    responsePayload.implications.forEach(item => { item.segmentIds = [segmentId]; });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responsePayload) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const fixtures = [
    {
      id: 'research-paper',
      ast: [
        { type: 'element', tag: 'h2', children: [{ type: 'text', id: 'research-heading', role: 'heading', text: 'Method and results' }] },
        { type: 'element', tag: 'p', children: [{ type: 'text', id: 'research-result', role: 'paragraph', text: 'The benchmark covers 120 tasks and reports confidence intervals.' }] },
      ],
    },
    {
      id: 'product-launch',
      ast: [
        { type: 'element', tag: 'h2', children: [{ type: 'text', id: 'launch-heading', role: 'heading', text: 'Product launch' }] },
        { type: 'element', tag: 'p', children: [{ type: 'text', id: 'launch-detail', role: 'paragraph', text: 'The release adds recovery checkpoints for agent workflows.' }] },
      ],
    },
    {
      id: 'long-essay',
      ast: Array.from({ length: 24 }, (_, index) => ({
        type: 'element',
        tag: 'p',
        children: [{ type: 'text', id: `long-${index}`, role: 'paragraph', text: `Section ${index} ` + 'long argument '.repeat(500) }],
      })),
    },
    {
      id: 'sparse-feed',
      ast: [{ type: 'element', tag: 'p', children: [{ type: 'text', id: 'sparse-1', role: 'paragraph', text: 'A short but usable feed summary.' }] }],
    },
    {
      id: 'links-and-images',
      resources: [
        { type: 'link', url: 'https://untrusted.example/reference' },
        { type: 'image', url: 'https://untrusted.example/image.png' },
      ],
      ast: [
        { type: 'element', tag: 'p', children: [{ type: 'text', id: 'media-1', role: 'paragraph', text: 'The article includes linked evidence and an illustration.' }] },
      ],
    },
  ];

  try {
    for (const fixture of fixtures) {
      await deepseek.generateOnepagePayload({
        entry: { id: fixture.id, title: fixture.id, link: `https://example.com/${fixture.id}` },
        document: { ...fixture, sourceHash: `${fixture.id}-source` },
        aiConfig: providerOptions(),
      });
    }
    assert.equal(capturedInputs.length, fixtures.length);
    for (const input of capturedInputs) {
      assert.equal(JSON.stringify(input).includes('https://'), false);
      assert.equal(input.segments.every(segment => segment.text.length <= 4000), true);
      assert.equal(input.segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 60000, true);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
