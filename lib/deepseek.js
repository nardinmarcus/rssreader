const fs = require('fs');
const path = require('path');
const store = require('./store');

const PROVIDERS = {
  deepseek: {
    title: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  'openai-compatible': {
    title: 'OpenAI 兼容',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'gpt-5.4-mini',
  },
  'anthropic-compatible': {
    title: 'Claude 兼容',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'claude-sonnet-4-6',
  },
};

let loadedEnv = false;

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = parseEnvValue(line.slice(idx + 1));
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadEnv() {
  if (loadedEnv) return;
  loadedEnv = true;
  loadEnvFile(path.join(__dirname, '..', '.env'));
  loadEnvFile(path.join(__dirname, '..', '.env.local'));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlKeepBreaks(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|blockquote|div|section|article|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLikelyEnglish(text) {
  const letters = String(text || '').match(/[A-Za-z]/g) || [];
  const cjk = String(text || '').match(/[\u3400-\u9fff]/g) || [];
  return letters.length >= 6 && cjk.length <= 2;
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return value || 'deepseek';
}

function providerDefaults(provider, providerName = '') {
  const known = PROVIDERS[provider];
  if (known) return known;
  const title = String(providerName || provider || 'AI').trim();
  return {
    title,
    defaultBaseUrl: '',
    defaultModel: '',
  };
}

function normalizeProviderType(value) {
  const type = String(value || 'openai_compatible').trim().toLowerCase().replace(/-/g, '_');
  if (type === 'openai_compatible') return type;
  const err = new Error('暂只支持 OpenAI-compatible 模型接口');
  err.statusCode = 400;
  throw err;
}

function clampTemperature(value, fallback = 0.7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(2, n));
}

function clampMaxTokens(value, fallback = 2000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(32768, Math.floor(n)));
}

function assertPublicHttpsBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const err = new Error('Base URL 格式不正确');
    err.statusCode = 400;
    throw err;
  }
  if (url.protocol !== 'https:') {
    const err = new Error('Base URL 必须使用 https');
    err.statusCode = 400;
    throw err;
  }
  const host = url.hostname.toLowerCase();
  const blocked = host === 'localhost'
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '127.0.0.1'
    || host === '::1'
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || /^169\.254\./.test(host);
  if (blocked) {
    const err = new Error('Base URL 不能指向本机或内网地址');
    err.statusCode = 400;
    throw err;
  }
  return url.toString().replace(/\/$/, '');
}

function getConfig(options = {}) {
  loadEnv();
  const provider = normalizeProvider(options.provider || process.env.AI_PROVIDER || 'deepseek');
  const providerType = normalizeProviderType(options.providerType || process.env.AI_PROVIDER_TYPE || 'openai_compatible');
  const defaults = providerDefaults(provider, options.providerName);
  const envBaseUrl = provider === 'deepseek' ? process.env.DEEPSEEK_BASE_URL : process.env.AI_BASE_URL;
  const envModel = provider === 'deepseek' ? process.env.DEEPSEEK_MODEL : process.env.AI_MODEL;
  const apiKey = String(options.apiKey || (provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.AI_API_KEY) || '').trim();
  const rawBaseUrl = String(options.baseUrl || envBaseUrl || defaults.defaultBaseUrl).trim();
  const rawModel = String(options.model || envModel || defaults.defaultModel).trim();
  return {
    provider,
    providerType,
    providerTitle: defaults.title,
    apiKey,
    configured: Boolean(apiKey),
    baseUrl: assertPublicHttpsBaseUrl(rawBaseUrl),
    model: rawModel || defaults.defaultModel,
    temperature: clampTemperature(options.temperature ?? process.env.AI_TEMPERATURE, 0.7),
    maxTokens: clampMaxTokens(options.maxTokens ?? process.env.AI_MAX_TOKENS, 2000),
  };
}

function trimString(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function trimText(value, max = 6000) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek did not return JSON');
    return JSON.parse(match[0]);
  }
}

function requestHeaders(config) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function completionUrl(config) {
  if (/\/chat\/completions$/i.test(config.baseUrl)) return config.baseUrl;
  return `${config.baseUrl}/chat/completions`;
}

async function postChatCompletion(config, body, timeout = 60000) {
  const payload = {
    model: config.model,
    stream: false,
    ...body,
  };
  if (payload.temperature === undefined) payload.temperature = config.temperature;
  if (payload.max_tokens === undefined) payload.max_tokens = config.maxTokens;
  if (config.provider === 'deepseek') payload.thinking = { type: 'disabled' };

  const res = await fetch(completionUrl(config), {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${config.providerTitle} request failed: ${res.status} ${text.slice(0, 180)}`);
    err.statusCode = res.status >= 500 ? 502 : 400;
    throw err;
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!content) throw new Error(`${config.providerTitle} returned an empty response`);
  return content;
}

async function listModels(options = {}) {
  const config = getConfig(options);
  assertConfigured(config);
  const res = await fetch(`${config.baseUrl}/models`, {
    headers: requestHeaders(config),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${config.providerTitle} models request failed: ${res.status} ${text.slice(0, 180)}`);
    err.statusCode = res.status >= 500 ? 502 : 400;
    throw err;
  }
  const data = await res.json();
  const models = Array.isArray(data.data)
    ? data.data.map(item => String(item.id || '')).filter(Boolean)
    : [];
  return { provider: config.provider, providerTitle: config.providerTitle, model: config.model, models };
}

async function testConnection(options = {}) {
  const config = getConfig(options);
  assertConfigured(config);
  const startedAt = Date.now();
  const content = await postChatCompletion(config, {
    messages: [
      {
        role: 'system',
        content: '你是 API 连通性测试助手，只回复 pong。',
      },
      {
        role: 'user',
        content: 'ping',
      },
    ],
    max_tokens: 32,
    temperature: 0,
  }, 30000);
  return {
    success: true,
    provider: config.provider,
    providerTitle: config.providerTitle,
    model: config.model,
    latencyMs: Date.now() - startedAt,
    sample: trimString(content, 120),
  };
}

function htmlToBlocks(html, fallback = '') {
  const sourceHtml = String(html || '');
  const cleanedHtml = sourceHtml
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const blocks = [];
  const blockRe = /<(p|li|h[1-6]|blockquote|pre|td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRe.exec(cleanedHtml))) {
    const text = stripHtml(match[2]);
    if (text.length >= 12) blocks.push(text);
  }

  if (blocks.length < 2) {
    blocks.push(...stripHtmlKeepBreaks(cleanedHtml)
      .split(/\n{2,}/)
      .map(block => block.replace(/\s+/g, ' ').trim())
      .filter(block => block.length >= 12));
  }

  let text = stripHtmlKeepBreaks(cleanedHtml);
  if (!text) text = stripHtml(fallback);
  if (!blocks.length) {
    blocks.push(...text
    .split(/\n{2,}|(?<=[。！？.!?])\s+(?=[A-Z0-9\u3400-\u9fff])/)
    .map(block => block.replace(/\s+/g, ' ').trim())
    .filter(block => block.length >= 12));
  }

  const out = [];
  let total = 0;
  for (const block of blocks) {
    if (out.length >= 28 || total >= 9000) break;
    const sliced = block.slice(0, 900);
    out.push(sliced);
    total += sliced.length;
  }
  return out.length ? out : [text.slice(0, 1200)].filter(Boolean);
}

function assertConfigured(config) {
  if (config.configured) return;
  const err = new Error(`${config.providerTitle} API Key 未配置`);
  err.statusCode = 503;
  throw err;
}

function articleContext(entry) {
  return [
    `标题：${entry.title || ''}`,
    `来源：${entry.author || entry.sourceId || ''}`,
    `发布时间：${entry.published || ''}`,
    `摘要：${entry.summary || ''}`,
    `正文片段：${stripHtml(entry.content || entry.summary || '').slice(0, 8000)}`,
  ].join('\n');
}

function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({
      role: message.role,
      content: trimString(message.content, 3000),
    }))
    .filter(message => message.content)
    .slice(-12);
}

async function translateTitleBatch(entries, { apiKey = '', author = 'system', provider = 'deepseek', providerName = '', providerType = 'openai_compatible', baseUrl = '', model = '', temperature, maxTokens } = {}) {
  const candidates = (entries || [])
    .filter(entry => entry && entry.id && entry.title && isLikelyEnglish(entry.title))
    .slice(0, 24);
  if (!candidates.length) return { translations: [], model: getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens }).model };

  const config = getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens });
  assertConfigured(config);

  const content = await postChatCompletion(config, {
    messages: [
      {
        role: 'system',
        content: '你是严谨的标题翻译助手。只输出 JSON：{"translations":[{"id":"...","titleZh":"..."}]}。中文自然、准确、短，不要解释。',
      },
      {
        role: 'user',
        content: candidates.map(entry => `id=${entry.id}\ntitle=${entry.title}`).join('\n\n'),
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1200,
    temperature: 0.15,
  }, 60000);

  const raw = parseJsonResponse(content);
  const translations = Array.isArray(raw.translations) ? raw.translations : [];
  const byId = Object.fromEntries(candidates.map(entry => [entry.id, entry]));
  const normalized = translations
    .map(item => ({
      entryId: String(item.id || ''),
      titleZh: trimString(item.titleZh, 180),
    }))
    .filter(item => item.entryId && byId[item.entryId] && item.titleZh && item.titleZh !== byId[item.entryId].title)
    .map(item => ({
      ...item,
      titleHash: store.hashText(byId[item.entryId].title),
    }));

  store.saveTitleTranslations(normalized, { model: config.model, provider: config.provider, author });
  return { translations: normalized, model: config.model };
}

async function translateEntry(entry, { apiKey = '', provider = 'deepseek', providerName = '', providerType = 'openai_compatible', baseUrl = '', model = '', temperature, maxTokens, author = 'system', force = false } = {}) {
  if (!entry || !entry.id) throw new Error('entry is required');
  const contentHash = store.hashText((entry.title || '') + '\n' + (entry.content || entry.summary || ''));
  const cached = store.getTranslation(entry.id);
  if (!force && cached && cached.content && cached.contentHash === contentHash) {
    return { translation: cached, cached: true };
  }

  const config = getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens });
  assertConfigured(config);

  const blocks = htmlToBlocks(entry.content, entry.summary);
  const content = await postChatCompletion(config, {
    messages: [
      {
        role: 'system',
        content: [
          '你是专业的英文到中文双语阅读翻译助手。',
          '只输出 JSON：{"titleZh":"","summaryZh":"","paragraphs":[{"i":0,"zh":""}]}。',
          '忠实、自然、不要扩写，不要省略，不要输出 Markdown。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `标题：${entry.title || ''}`,
          `摘要：${entry.summary || ''}`,
          '段落：',
          ...blocks.map((block, i) => `${i}. ${block}`),
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 4500,
    temperature: 0.15,
  }, 90000);

  const raw = parseJsonResponse(content);
  const translated = Array.isArray(raw.paragraphs) ? raw.paragraphs : [];
  const zhByIndex = new Map(translated.map(item => [Number(item.i), trimText(item.zh, 3000)]));
  const paragraphPairs = blocks.map((source, i) => ({
    source,
    target: zhByIndex.get(i) || '',
  })).filter(pair => pair.source && pair.target);

  if (!paragraphPairs.length) throw new Error(`${config.providerTitle} returned an empty translation`);

  const translation = store.saveTranslation(entry.id, {
    titleZh: isLikelyEnglish(entry.title) ? trimString(raw.titleZh, 180) : '',
    summaryZh: trimText(raw.summaryZh, 600),
    content: paragraphPairs,
    model: config.model,
    provider: config.provider,
    createdBy: author,
    contentHash,
    titleHash: store.hashText(entry.title || ''),
  });

  return { translation, cached: false };
}

async function chatWithEntry(entry, messages, { apiKey = '', provider = 'deepseek', providerName = '', providerType = 'openai_compatible', baseUrl = '', model = '', temperature, maxTokens, author = '读者', userId = null } = {}) {
  if (!entry || !entry.id) throw new Error('entry is required');
  const config = getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens });
  assertConfigured(config);

  const chatMessages = sanitizeChatMessages(messages);
  if (!chatMessages.length || chatMessages[chatMessages.length - 1].role !== 'user') {
    const err = new Error('A user message is required');
    err.statusCode = 400;
    throw err;
  }

  const answer = trimText(await postChatCompletion(config, {
      messages: [
        {
          role: 'system',
          content: [
            '你是一个嵌入 RSS 阅读器的文章上下文 Agent。',
            '只基于给定文章上下文和对话回答；如果文章里没有依据，要明确说明。',
            '用中文回答，保持简洁、有判断，可用 Markdown 列表，但不要编造来源。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `当前文章上下文如下：\n${articleContext(entry)}`,
        },
        {
          role: 'assistant',
          content: '已读取当前文章上下文。你可以继续提问。',
        },
        ...chatMessages,
      ],
      max_tokens: Math.min(config.maxTokens || 1500, 6000),
      temperature: clampTemperature(temperature, 0.35),
    }, 60000), 6000);
  if (!answer) throw new Error(`${config.providerTitle} returned an empty answer`);
  const userMessage = store.addChatMessage(entry.id, {
    userId,
    role: 'user',
    author,
    content: chatMessages[chatMessages.length - 1].content,
  });
  const assistantMessage = store.addChatMessage(entry.id, {
    role: 'assistant',
    author: config.providerTitle,
    content: answer,
    model: config.model,
  });
  return { answer, model: config.model, userMessage, assistantMessage };
}

loadEnv();

module.exports = {
  chatWithEntry,
  getConfig,
  isLikelyEnglish,
  listModels,
  testConnection,
  translateEntry,
  translateTitleBatch,
};
