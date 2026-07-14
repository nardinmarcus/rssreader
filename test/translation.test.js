const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
process.env.NAMOO_READER_DATA_DIR = dataDir;
const deepseek = require('../lib/deepseek');
const store = require('../lib/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function withEnv(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, process.env[key]])
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function providerOptions(overrides = {}) {
  return {
    apiKey: 'caller-owned-test-key',
    provider: 'openai-compatible',
    providerName: 'Test provider',
    providerType: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    model: 'test-model',
    temperature: 0.1,
    maxTokens: 5000,
    ...overrides,
  };
}

function openAiResponse(content, finishReason = 'stop', headers = {}) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

test('server-owned DeepSeek ignores caller routing and uses the official V4 Flash route', () => {
  withEnv({
    DEEPSEEK_API_KEY: 'server-owned-test-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
  }, () => {
    const config = deepseek.getConfig({
      provider: 'deepseek',
      baseUrl: 'https://attacker.example/v1',
      model: 'deepseek-v4-flash',
    });

    assert.equal(config.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(config.model, 'deepseek-v4-flash');
    assert.equal(config.usesServerDeepSeekKey, true);
  });
});

test('server-owned DeepSeek rejects a non-official environment route', () => {
  withEnv({
    DEEPSEEK_API_KEY: 'server-owned-test-key',
    DEEPSEEK_BASE_URL: 'https://gateway.example/v1',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
  }, () => {
    assert.throws(
      () => deepseek.getConfig({ provider: 'deepseek' }),
      error => error.statusCode === 500 && /只能请求 https:\/\/api\.deepseek\.com/.test(error.message)
    );
  });
});

test('BYOK DeepSeek is restricted to the official origin and V4 Flash model', () => {
  withEnv({
    DEEPSEEK_API_KEY: undefined,
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
  }, () => {
    assert.throws(
      () => deepseek.getConfig({
        apiKey: 'caller-owned-test-key',
        provider: 'deepseek',
        baseUrl: 'https://gateway.example/v1',
        model: 'deepseek-v4-flash',
      }),
      /只能请求 https:\/\/api\.deepseek\.com/
    );
    assert.throws(
      () => deepseek.getConfig({
        apiKey: 'caller-owned-test-key',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      }),
      /只允许使用 deepseek-v4-flash/
    );
  });
});

test('custom BYOK providers keep their public HTTPS route, model, and tuning', () => {
  const config = deepseek.getConfig({
    apiKey: 'caller-owned-test-key',
    provider: 'openai-compatible',
    providerName: 'Caller gateway',
    providerType: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    model: 'caller-model',
    temperature: 0.4,
    maxTokens: 1200,
  });

  assert.equal(config.baseUrl, 'https://gateway.example/v1');
  assert.equal(config.model, 'caller-model');
  assert.equal(config.temperature, 0.4);
  assert.equal(config.maxTokens, 1200);
  assert.equal(config.usesServerDeepSeekKey, false);
});

test('DeepSeek model discovery exposes V4 Flash only', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro' },
      { id: 'deepseek-chat' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await deepseek.listModels({
      apiKey: 'caller-owned-test-key',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    });
    assert.deepEqual(result.models, ['deepseek-v4-flash']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('finish_reason length rejects truncated model output', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => openAiResponse('partial result', 'length');
  try {
    await assert.rejects(
      deepseek.testConnection(providerOptions()),
      /token 上限/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('temporary model resource interruption retries once and discards partial output', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? openAiResponse('partial result', 'insufficient_system_resource', { 'retry-after': '0' })
      : openAiResponse('complete result');
  };
  try {
    const result = await deepseek.testConnection(providerOptions());
    assert.equal(result.sample, 'complete result');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('5xx HTML responses are retried once', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('<html><body>temporary upstream failure</body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html', 'retry-after': '0' },
      });
    }
    return openAiResponse('complete result');
  };
  try {
    const result = await deepseek.testConnection(providerOptions());
    assert.equal(result.sample, 'complete result');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('response body read failures are retried once', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => { throw new Error('socket closed while reading body'); },
      };
    }
    return openAiResponse('complete result');
  };
  try {
    const result = await deepseek.testConnection(providerOptions());
    assert.equal(result.sample, 'complete result');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('normal stop refusal rewrite output is never persisted', async () => {
  const originalFetch = global.fetch;
  const entry = {
    id: 'refused-stop-rewrite',
    sourceId: 'test',
    title: 'Normal Stop Refusal Test',
    summary: 'A detailed source summary that should produce a real Chinese article.',
    content: `<p>${'Substantive source material with concrete product facts and limitations. '.repeat(20)}</p>`,
  };
  store.upsertEntries([entry]);
  global.fetch = async () => openAiResponse('抱歉，无法处理这篇文章。', 'stop');
  try {
    await assert.rejects(
      deepseek.rewriteEntry(entry, providerOptions()),
      /模型返回了拒答.*未保存不完整结果/
    );
    assert.equal(store.getRewrite(entry.id), null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pathologically short normal stop rewrite output is never persisted', async () => {
  const originalFetch = global.fetch;
  const entry = {
    id: 'short-stop-rewrite',
    sourceId: 'test',
    title: 'Normal Stop Short Rewrite Test',
    summary: 'A detailed source summary that should produce a real Chinese article.',
    content: `<p>${'Substantive source material with concrete product facts, usage scenarios, tradeoffs, and limitations. '.repeat(80)}</p>`,
  };
  store.upsertEntries([entry]);
  global.fetch = async () => openAiResponse('这是一个产品介绍。', 'stop');
  try {
    await assert.rejects(
      deepseek.rewriteEntry(entry, providerOptions()),
      /中文正文过短.*未保存不完整结果/
    );
    assert.equal(store.getRewrite(entry.id), null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('substantive normal stop rewrite output is persisted', async () => {
  const originalFetch = global.fetch;
  const entry = {
    id: 'complete-stop-rewrite',
    sourceId: 'test',
    title: 'Complete Normal Stop Rewrite Test',
    summary: 'A detailed source summary for a complete Chinese draft.',
    content: `<p>${'Source facts describe the product workflow, intended users, tradeoffs, evidence, and limitations. '.repeat(20)}</p>`,
  };
  const completeDraft = [
    '## 为什么值得写',
    '这个产品解决的是团队反复整理资料的问题。它把输入内容转换成结构化结果，同时保留关键来源和待核对信息。'.repeat(3),
    '## 创作角度',
    '实际使用时，最适合需要持续处理大量信息的研究和内容团队。用户仍然要核对事实、时效和原始链接。'.repeat(3),
    '## 发布前检查',
    '它的价值在于减少机械整理，但不能替代人工判断。发布前应该先用真实材料验证准确率、来源和能力边界。'.repeat(3),
  ].join('\n\n');
  store.upsertEntries([entry]);
  global.fetch = async () => openAiResponse(completeDraft, 'stop');
  try {
    const result = await deepseek.rewriteEntry(entry, providerOptions());
    assert.equal(result.cached, false);
    assert.match(result.rewrite.body, /减少机械整理/);
    assert.match(store.getRewrite(entry.id).body, /减少机械整理/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('content filters, tool calls, and refusals reject partial output', async t => {
  const originalFetch = global.fetch;
  try {
    for (const [reason, expected] of [
      ['content_filter', /内容过滤器/],
      ['tool_calls', /工具调用/],
      ['refusal', /拒绝/],
    ]) {
      await t.test(reason, async () => {
        global.fetch = async () => openAiResponse('partial result', reason);
        await assert.rejects(deepseek.testConnection(providerOptions()), expected);
      });
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('Anthropic pause_turn retries once and discards partial output', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const body = calls === 1
      ? { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'partial result' }] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'complete result' }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });
  };
  try {
    const result = await deepseek.testConnection(providerOptions({
      providerType: 'anthropic_compatible',
    }));
    assert.equal(result.sample, 'complete result');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
