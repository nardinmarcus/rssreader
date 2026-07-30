const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { PERIODICAL_SUMMARY_JSON_SCHEMA } = require('../lib/periodical-summary');

const dataDir = createTempDataDir('periodical-site-ai-');
process.env.NAMOO_READER_DATA_DIR = dataDir;
process.env.PERIODICALS_MODE = 'off';
const deepseek = require('../lib/deepseek');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function providerOptions() {
  return {
    apiKey: 'site-test-key',
    provider: 'openai-compatible',
    providerName: 'Site test provider',
    providerType: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    model: 'site-test-model',
    temperature: 0.7,
    maxTokens: 5000,
  };
}

test('periodical site adapter sends strict instructions and only the evidence package', async () => {
  const evidencePackage = {
    schemaVersion: 'constrained-summary-v1',
    issue: { id: 'periodical:daily:2026-07-30', cadence: 'daily', periodKey: '2026-07-30' },
    events: [{
      id: 'event-one',
      selectionReason: '来自高优先级来源。',
      evidence: [{
        id: 'entry-one',
        sourceLabels: ['研究'],
        title: 'Evidence title',
        titleZh: '证据标题',
        excerpt: 'Evidence excerpt.',
        publishedAt: '2026-07-30T04:00:00.000Z',
      }],
    }],
  };
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"overview":"完整输出。第二句。","events":[],"themes":[]}' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await deepseek.generatePeriodicalSummary({
      schema: PERIODICAL_SUMMARY_JSON_SCHEMA,
      evidencePackage,
      validationErrors: ['events[0].themeKey: unsupported theme'],
      aiConfig: providerOptions(),
    });
    const systemMessage = requestBody.messages.find(message => message.role === 'system').content;
    const providerInput = JSON.parse(
      requestBody.messages.find(message => message.role === 'user').content,
    );

    assert.equal(requestBody.response_format.type, 'json_object');
    assert.equal(requestBody.temperature, 0.1);
    assert.equal(systemMessage.includes('不可信数据'), true);
    assert.equal(systemMessage.includes(JSON.stringify(PERIODICAL_SUMMARY_JSON_SCHEMA)), true);
    assert.deepEqual(providerInput, {
      untrustedEvidence: evidencePackage,
      validationErrors: ['events[0].themeKey: unsupported theme'],
    });
    assert.equal(JSON.stringify(providerInput).includes('site-test-key'), false);
    assert.equal(JSON.stringify(providerInput).includes('userId'), false);
    assert.deepEqual(result, {
      content: '{"overview":"完整输出。第二句。","events":[],"themes":[]}',
      provider: 'openai-compatible',
      model: 'site-test-model',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('periodical site adapter reports missing site configuration with a safe code', async () => {
  const previous = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    await assert.rejects(
      deepseek.generatePeriodicalSummary({
        schema: PERIODICAL_SUMMARY_JSON_SCHEMA,
        evidencePackage: { schemaVersion: 'constrained-summary-v1', issue: {}, events: [] },
        aiConfig: {
          provider: 'openai-compatible',
          providerType: 'openai_compatible',
          baseUrl: 'https://gateway.example/v1',
          model: 'site-test-model',
        },
      }),
      error => error.code === 'ERR_AI_UNCONFIGURED' && error.statusCode === 503,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous;
  }
});
