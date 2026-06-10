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

const QIAOMU_REWRITE_PROMPT = [
  '你是向阳乔木，一位中文科技内容作者。擅长把信息密度高的英文报告、机器翻译稿或直播文字稿，改写成逻辑清晰、读感流畅的中文文章。',
  '目标读者是有一定技术背景的从业者，时间有限，不喜欢废话，但愿意为真正有价值的内容停下来细读。',
  '',
  '语言风格：',
  '- 口语化，对话感强，像和读者面对面聊天',
  '- 短段落，多留白，视觉舒适',
  '- 善用生活化类比解释复杂概念，在专业性和可读性之间自然平衡',
  '- 始终使用第三人称视角叙述',
  '- 不要用第一人称自称，不要把原文里的 I / we / you 机械直译成作者对读者喊话',
  '- 真诚、不装，承认困惑，专业但不掉书袋',
  '- 数据和案例支撑观点，有洞察力，给读者“原来如此”的感觉',
  '',
  '格式规范：',
  '- 重要观点用 **加粗** 突出',
  '- 全程使用中文标点',
  '- 禁止使用中文破折号和英文破折号',
  '- 禁止使用水平分隔线',
  '- 原文中的图片 Markdown 引用原样保留，位置与上下文匹配',
  '- 原文中的链接是内容资产，论文、代码、产品、数据、原文引用等链接必须保留为 Markdown 链接，不要只保留链接文字',
  '- 如果改写稿提到某个链接指向的对象，要在第一次出现处嵌入对应链接，URL 不得改写',
  '- 不输出一级标题，直接从开头钩子进入正文，小标题使用二级或三级标题',
  '',
  '禁用表达：',
  '- 禁用句式：不是……而是、想象一下、你有没有想过、值得注意的是、不难理解、毋庸置疑、随着……的发展、对于……来说、在……方面',
  '- 禁用词汇：精准打击、赋能、落地、深度融合、全面布局、强势崛起等空洞套话',
  '- 禁用预告式渲染表达，比如“最让我吃惊的是”“最扎心的是”，但后面内容并不强',
  '- 英文 newsletter 的寒暄、订阅提醒、邮箱打扰、欢迎语不要直译，要删除或改写成真正的信息开场',
  '',
  '写作结构：',
  '- 开头前三行必须有钩子，可以是反常识数据、尖锐问题，或让人想继续读的矛盾',
  '- 每个段落只说一件事',
  '- 每一个数据后面，都解释这说明什么',
  '- 因果关系写清楚，不只是并列事实',
  '- 遇到反直觉结论，在读者产生疑问之前主动解释',
  '- 不满足于表面解释，延伸到更深的思考',
  '- 善于在技术、生活、认知之间建立联系',
  '- 小标题要有实际信息量，不用“背景介绍”“数据分析”这类无意义标题',
  '- 结尾给出对读者真正有用的行动结论，不做空泛总结',
  '',
  '忠实度要求：',
  '- 保留原文所有关键数据和核心结论，不遗漏，不夸大',
  '- 可以调整结构和顺序，但不能改变原意',
  '- 如果原始材料是直播或访谈文字稿，AI 语音识别可能存在错误，要尽可能理解实际表达和专业名词，合理还原',
  '',
  '完成后自查：读不懂的句子要重写；删掉翻译腔和 AI 感表达；所有数据都要解释意义；小标题要有信息量；开头要抓人；结尾要给明确可操作结论；全程中文标点；不得出现破折号或水平分隔线。',
  '',
  '只输出改写后的中文 Markdown 文章，不要解释过程，不要输出自查清单。',
].join('\n');

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek did not return JSON');
    return JSON.parse(match[0]);
  }
}

function absoluteHttpUrl(value, baseUrl = '') {
  const raw = String(value || '').trim().replace(/[，。；、,.!?]+$/g, '');
  if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) return '';
  try {
    const url = new URL(raw, baseUrl || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return /^https?:\/\//i.test(raw) ? raw : '';
  }
}

function markdownLinkLabel(value, fallback = '链接') {
  return trimString(String(value || fallback).replace(/[\[\]\n\r]+/g, ' ').replace(/\s+/g, ' '), 90) || fallback;
}

function markdownLinkRefs(entry) {
  const refs = [];
  const seen = new Set();
  const baseUrl = String(entry && entry.link || '');
  const add = (href, label = '', context = '') => {
    const url = absoluteHttpUrl(href, baseUrl);
    if (!url || seen.has(url) || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i.test(url)) return;
    seen.add(url);
    let cleanLabel = stripHtml(label);
    if (!cleanLabel || /^https?:\/\//i.test(cleanLabel)) {
      try { cleanLabel = new URL(url).hostname.replace(/^www\./, ''); } catch { cleanLabel = '链接'; }
    }
    const cleanContext = trimString(stripHtml(context), 150);
    const safeLabel = markdownLinkLabel(cleanLabel);
    refs.push({
      label: safeLabel,
      url,
      context: cleanContext,
      markdown: cleanContext ? `- [${safeLabel}](${url})：${cleanContext}` : `- [${safeLabel}](${url})`,
    });
  };

  if (entry && entry.link) add(entry.link, '原文链接', entry.title || '');

  const html = String(entry && entry.content || '');
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html))) add(match[1], match[2], match[2]);

  const textWithUrls = `${entry && entry.summary || ''}\n${stripHtmlKeepBreaks(html)}`;
  const urlRe = /https?:\/\/[^\s"'<>）)]+/gi;
  while ((match = urlRe.exec(textWithUrls))) add(match[0], match[0], '');

  return refs.slice(0, 32);
}

function markdownImageRefs(entry) {
  const refs = [];
  const seen = new Set();
  const add = (src, alt = '') => {
    const url = String(src || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    refs.push(`![${String(alt || 'image').trim() || 'image'}](${url})`);
  };
  if (entry && entry.image) add(entry.image, entry.title || 'cover');
  const html = String(entry && entry.content || '');
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    const tag = match[0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '';
    add(src, alt);
  }
  return refs.slice(0, 8);
}

function rewriteInputParts(entry) {
  const source = rewriteSourceText(entry);
  const imageRefs = markdownImageRefs(entry);
  const linkRefs = markdownLinkRefs(entry);
  const contentHash = store.hashText([
    'qiaomu-rewrite-link-preservation-v1',
    entry.title || '',
    entry.summary || '',
    entry.content || '',
    source.kind,
    source.text,
    imageRefs.join('\n'),
    linkRefs.map(ref => ref.markdown).join('\n'),
  ].join('\n'));
  return { source, imageRefs, linkRefs, contentHash };
}

function rewriteContentHash(entry) {
  return rewriteInputParts(entry).contentHash;
}

function comparableUrl(value) {
  const raw = String(value || '').trim().replace(/[，。；、,.!?]+$/g, '');
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function ensureRewriteLinks(body, linkRefs) {
  const text = String(body || '').trim();
  if (!text || !Array.isArray(linkRefs) || !linkRefs.length) return text;
  const existing = new Set();
  const urlRe = /https?:\/\/[^\s)\]]+/gi;
  let match;
  while ((match = urlRe.exec(text))) existing.add(comparableUrl(match[0]));
  const missing = linkRefs
    .filter(ref => ref && ref.url && !existing.has(comparableUrl(ref.url)))
    .slice(0, 16);
  if (!missing.length) return text;
  return [
    text,
    '## 参考链接',
    missing.map(ref => `- [${markdownLinkLabel(ref.label)}](${ref.url})`).join('\n'),
  ].join('\n\n');
}

function rewriteSourceText(entry) {
  const translation = store.getTranslation(entry.id);
  if (translation && Array.isArray(translation.content) && translation.content.length) {
    return {
      kind: '已有中文翻译',
      text: [
        translation.titleZh ? `标题：${translation.titleZh}` : `标题：${entry.title || ''}`,
        translation.summaryZh ? `摘要：${translation.summaryZh}` : '',
        ...translation.content.map(pair => pair.target).filter(Boolean),
      ].filter(Boolean).join('\n\n'),
    };
  }
  const blocks = htmlToBlocks(entry.content, entry.summary);
  return {
    kind: isLikelyEnglish(`${entry.title || ''}\n${blocks.join('\n')}`) ? '英文原文' : '原始内容',
    text: [
      `标题：${entry.title || ''}`,
      entry.summary ? `摘要：${stripHtml(entry.summary)}` : '',
      ...blocks,
    ].filter(Boolean).join('\n\n'),
  };
}

function cleanRewriteMarkdown(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*#\s+[^\n]+\n+/, '')
    .split('\n')
    .filter(line => !/^\s*-{3,}\s*$/.test(line))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
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

async function rewriteEntry(entry, { apiKey = '', provider = 'deepseek', providerName = '', providerType = 'openai_compatible', baseUrl = '', model = '', temperature, maxTokens, author = 'system', force = false } = {}) {
  if (!entry || !entry.id) throw new Error('entry is required');
  const { source, imageRefs, linkRefs, contentHash } = rewriteInputParts(entry);
  const cached = store.getRewrite(entry.id);
  if (!force && cached && cached.body && cached.contentHash === contentHash) {
    return { rewrite: cached, cached: true };
  }

  const config = getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens });
  assertConfigured(config);

  const rawBody = await postChatCompletion(config, {
    messages: [
      {
        role: 'system',
        content: QIAOMU_REWRITE_PROMPT,
      },
      {
        role: 'user',
        content: [
          `材料类型：${source.kind}`,
          `原始标题：${entry.title || ''}`,
          imageRefs.length ? `图片 Markdown 引用，必要时原样保留：\n${imageRefs.join('\n')}` : '',
          linkRefs.length ? `原文链接清单。改写中提到对应对象时，必须用这些 Markdown 链接保留 URL，不要丢链接：\n${linkRefs.map(ref => ref.markdown).join('\n')}` : '',
          '待处理材料：',
          trimText(source.text, 14000),
        ].filter(Boolean).join('\n\n'),
      },
    ],
    max_tokens: Math.min(config.maxTokens || 6000, 9000),
    temperature: clampTemperature(temperature, 0.6),
  }, 120000);
  const body = ensureRewriteLinks(cleanRewriteMarkdown(rawBody), linkRefs);

  if (!body) throw new Error(`${config.providerTitle} returned an empty rewrite`);
  const rewrite = store.saveRewrite(entry.id, {
    title: entry.title || '',
    body,
    model: config.model,
    provider: config.provider,
    createdBy: author,
    contentHash,
  });
  return { rewrite, cached: false };
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
  rewriteEntry,
  rewriteContentHash,
  testConnection,
  translateEntry,
  translateTitleBatch,
};
