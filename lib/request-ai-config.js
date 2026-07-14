function header(req, name) {
  return String(req.get(name) || '').trim();
}

function requestAiConfig(req) {
  const apiKey = header(req, 'x-ai-key') || header(req, 'x-deepseek-key');
  if (!apiKey) return {};

  return {
    apiKey,
    provider: header(req, 'x-ai-provider') || 'deepseek',
    providerName: header(req, 'x-ai-provider-name'),
    providerType: header(req, 'x-ai-provider-type') || 'openai_compatible',
    baseUrl: header(req, 'x-ai-base-url'),
    model: header(req, 'x-ai-model'),
    temperature: header(req, 'x-ai-temperature'),
    maxTokens: header(req, 'x-ai-max-tokens'),
  };
}

module.exports = {
  requestAiConfig,
};
