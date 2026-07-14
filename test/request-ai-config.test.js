const test = require('node:test');
const assert = require('node:assert/strict');

const { requestAiConfig } = require('../lib/request-ai-config');

function request(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
  };
}

test('requests without a browser key cannot control the server-owned AI route', () => {
  const config = requestAiConfig(request({
    'x-ai-provider': 'openai-compatible',
    'x-ai-provider-name': 'Attacker gateway',
    'x-ai-provider-type': 'anthropic_compatible',
    'x-ai-base-url': 'https://attacker.example/v1',
    'x-ai-model': 'attacker-model',
    'x-ai-temperature': '2',
    'x-ai-max-tokens': '32768',
  }));

  assert.deepEqual(config, {});
});

test('BYOK requests preserve the caller-owned provider configuration', () => {
  const config = requestAiConfig(request({
    'x-ai-key': 'caller-owned-test-key',
    'x-ai-provider': 'openai-compatible',
    'x-ai-provider-name': 'Caller gateway',
    'x-ai-provider-type': 'openai_compatible',
    'x-ai-base-url': 'https://gateway.example/v1',
    'x-ai-model': 'caller-model',
    'x-ai-temperature': '0.4',
    'x-ai-max-tokens': '1200',
  }));

  assert.deepEqual(config, {
    apiKey: 'caller-owned-test-key',
    provider: 'openai-compatible',
    providerName: 'Caller gateway',
    providerType: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    model: 'caller-model',
    temperature: '0.4',
    maxTokens: '1200',
  });
});

test('legacy DeepSeek BYOK header still establishes caller ownership', () => {
  assert.deepEqual(requestAiConfig(request({
    'x-deepseek-key': 'legacy-caller-key',
  })), {
    apiKey: 'legacy-caller-key',
    provider: 'deepseek',
    providerName: '',
    providerType: 'openai_compatible',
    baseUrl: '',
    model: '',
    temperature: '',
    maxTokens: '',
  });
});
