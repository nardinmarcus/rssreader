const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const store = require('./store');

const PRODUCTHUNT_SOURCE_ID = 'producthunt';
const HACKERNEWS_SOURCE_ID = 'hackernews';
const SERVER_DEEPSEEK_MODEL = 'deepseek-v4-flash';

const PROVIDERS = {
  deepseek: {
    title: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
  },
  codex: {
    title: 'Codex / aigocode',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'codex-auto-review',
  },
  anthropic: {
    title: 'Anthropic / Claude',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'claude-sonnet-4-6',
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
  if (type === 'anthropic_compatible' || type === 'anthropic_messages') return 'anthropic_compatible';
  const err = new Error('暂只支持 OpenAI-compatible 或 Anthropic-compatible 模型接口');
  err.statusCode = 400;
  throw err;
}

function inferProviderType({ providerType, provider, providerName, model, baseUrl }) {
  const normalized = normalizeProviderType(providerType);
  if (normalized !== 'openai_compatible') return normalized;
  const identity = `${provider || ''} ${providerName || ''} ${model || ''}`.toLowerCase();
  if (isAigocodeBaseUrl(baseUrl) && /\b(anthropic|claude)\b|^claude[-/]/i.test(identity)) {
    return 'anthropic_compatible';
  }
  return normalized;
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

function assertOfficialDeepSeekBaseUrl(value, statusCode = 400) {
  const url = new URL(value);
  if (url.origin !== 'https://api.deepseek.com') {
    const err = new Error('DeepSeek 官方配置只能请求 https://api.deepseek.com');
    err.statusCode = statusCode;
    throw err;
  }
}

function getConfig(options = {}) {
  loadEnv();
  const provider = normalizeProvider(options.provider || process.env.AI_PROVIDER || 'deepseek');
  const defaults = providerDefaults(provider, options.providerName);
  const envBaseUrl = provider === 'deepseek' ? process.env.DEEPSEEK_BASE_URL : process.env.AI_BASE_URL;
  const envModel = provider === 'deepseek' ? process.env.DEEPSEEK_MODEL : process.env.AI_MODEL;
  const explicitApiKey = String(options.apiKey || '').trim();
  const serverApiKey = String((provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.AI_API_KEY) || '').trim();
  const usesServerDeepSeekKey = provider === 'deepseek' && !explicitApiKey && Boolean(serverApiKey);
  const deepseekModelOverrides = [envModel, options.model]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (provider === 'deepseek' && deepseekModelOverrides.some(model => model !== SERVER_DEEPSEEK_MODEL)) {
    const err = new Error(`DeepSeek 官方配置只允许使用 ${SERVER_DEEPSEEK_MODEL}`);
    err.statusCode = usesServerDeepSeekKey ? 500 : 400;
    throw err;
  }
  const apiKey = explicitApiKey || serverApiKey;
  const rawBaseUrl = String(
    usesServerDeepSeekKey
      ? envBaseUrl || defaults.defaultBaseUrl
      : options.baseUrl || envBaseUrl || defaults.defaultBaseUrl
  ).trim();
  const rawModel = String(
    provider === 'deepseek'
      ? SERVER_DEEPSEEK_MODEL
      : options.model || envModel || defaults.defaultModel
  ).trim();
  const baseUrl = assertPublicHttpsBaseUrl(rawBaseUrl);
  if (provider === 'deepseek') {
    assertOfficialDeepSeekBaseUrl(baseUrl, usesServerDeepSeekKey ? 500 : 400);
  }
  const model = rawModel || defaults.defaultModel;
  const providerType = inferProviderType({
    providerType: options.providerType || process.env.AI_PROVIDER_TYPE || 'openai_compatible',
    provider,
    providerName: options.providerName,
    model,
    baseUrl,
  });
  return {
    provider,
    providerType,
    providerTitle: defaults.title,
    apiKey,
    configured: Boolean(apiKey),
    baseUrl,
    model,
    temperature: clampTemperature(options.temperature ?? process.env.AI_TEMPERATURE, 0.7),
    maxTokens: clampMaxTokens(options.maxTokens ?? process.env.AI_MAX_TOKENS, 2000),
    usesServerDeepSeekKey,
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

const NAMOO_CREATION_DRAFT_PROMPT = [
  '你是大月 Namoo 的创作协作者，不是代替他发表文章的枪手。',
  '账号使命是激发大家对 AI 的好奇，表达底色是“有见识的普通人在认真聊一件打动他的事”。',
  '你的任务是把给定材料整理成可继续加工的 Namoo 创作草稿，保留事实与来源，同时把必须由真人完成的判断和经历显式留出来。',
  '',
  '真实性边界：',
  '- 只使用给定材料中的事实、数据、人物、时间、实验结果和链接，严格区分事实、原作者观点、社区观点与推断',
  '- 不得替大月编造第一手观察、亲身试用、踩坑、情绪、个人判断、访谈、调查或教程实测',
  '- 材料没有真人细节时，使用 `[需要 Namoo 补充：具体内容]`，不要用看似真实的第一人称填空',
  '- 原文作者的 I / we 不能改写成大月的“我”',
  '- 信息不足、时间可能过期或来源无法支撑时，要在发布前检查里明确指出',
  '',
  'Namoo 风格方向：',
  '- 像朋友聊天，短段落、有节奏、有好奇心，讲人话但不装懂',
  '- 判断要有证据，允许承认不确定，不写导师口吻、营销软文或滴水不漏的报告',
  '- 知识像聊天时顺手掏出来，不用教科书式科普',
  '- 具体产品和模型使用真实名称，不写“某个 AI 工具”一类空泛称呼',
  '- 禁用“说白了”“这意味着”“本质上”“换句话说”“不可否认”“综上所述”“值得注意的是”“让我们来看看”等 AI 套话',
  '- 禁止编造假设性经历，禁止中文或英文破折号，避免水平分隔线和过度加粗',
  '',
  '链接要求：',
  '- 论文、代码、产品、数据、官网和原文链接都是事实资产，必须保留为 Markdown 链接，URL 不得改写',
  '- 第一次提到链接对应对象时尽量嵌入链接，不能只在结尾留下无上下文 URL',
  '- 图片 Markdown 引用按内容需要保留，不得虚构图片',
  '',
  '只输出中文 Markdown，并严格按下面六个二级标题输出，不增加一级标题或第七个二级标题：',
  '## 为什么值得写',
  '用 HKR 判断素材的好奇心、信息量和共鸣潜力，并说明缺失项。',
  '## 创作角度',
  '给出 2 到 3 个不同角度，每个说明核心判断、读者价值和需要 Namoo 决定的地方；明确标记一个“推荐角度”。',
  '## 事实底稿与原始链接',
  '列出关键事实、数据、归属和原始链接，不能把推断写成事实。',
  '## Namoo 风格草稿',
  '按推荐角度写一版可编辑正文。正文内部尽量不用小标题；需要真人经验、情绪、实测或核心判断时必须放占位符。',
  '## 需要 Namoo 补充',
  '汇总所有真人输入位，写成具体问题，让 Namoo 可以逐项补充。',
  '## 发布前检查',
  '列出需要核实的事实、时效、引用、可能误读和仍未完成的真人内容。',
].join('\n');

const NAMOO_PAPER_DRAFT_PROMPT = [
  NAMOO_CREATION_DRAFT_PROMPT,
  '',
  'AI 论文补充要求：',
  '- 不逐句翻译摘要，要判断这篇论文解决什么问题、方法关键在哪里、是否值得继续读',
  '- 材料只有摘要时明确写“摘要里没有交代”，不得编造实验结果、代码、机构背书或榜单排名',
  '- 保留 arXiv、PDF、Hugging Face、代码和项目链接',
  '- 事实底稿必须包含论文贡献、局限和待验证点',
].join('\n');

const NAMOO_PRODUCTHUNT_DRAFT_PROMPT = [
  NAMOO_CREATION_DRAFT_PROMPT,
  '',
  'Product Hunt 创作草稿补充要求：',
  '- 把材料当作一个产品发现条目，不要只复述 Product Hunt 的一句话 tagline',
  '- 如果材料里有“产品官网抓取资料”，必须优先基于官网信息判断这个产品实际做什么、适合谁、怎么用',
  '- 第一次提到产品名时尽量链接到产品官网，不要只链接 Product Hunt 讨论页',
  '- 如果官网资料不足或抓取失败，要明确保持边界，不要编造价格、团队、融资、用户量、集成能力或路线图',
  '- 文章应包含真实用途、可能的使用场景、和读者需要留意的限制，不写成软文',
].join('\n');

const NAMOO_HACKERNEWS_DRAFT_PROMPT = [
  NAMOO_CREATION_DRAFT_PROMPT,
  '',
  'Hacker News 创作草稿补充要求：',
  '- 把 Hacker News 条目当作“原文链接 + 社区讨论”的组合材料，不要只复述外链标题',
  '- “作者回复”是一级材料，优先保留作者澄清、路线图、边界、动机、技术选择、定价和开放问题',
  '- “讨论摘录”用于补足读者视角：哪些地方被质疑、哪些经验有价值、哪些限制需要提醒',
  '- 明确区分原文事实、作者回复和社区评论，不要把评论区观点写成原文结论',
  '- 如果只有讨论元信息而没有原文正文，要保持边界，写成 HN 讨论速读，不编造外链内容',
  '- 第一次提到原文或 HN 讨论时保留对应 Markdown 链接',
].join('\n');

function isPaperInterpretationEntry(entry) {
  return Boolean(entry && entry.sourceId === 'huggingface');
}

function isProductHuntEntry(entry) {
  return Boolean(entry && entry.sourceId === PRODUCTHUNT_SOURCE_ID);
}

function isHackerNewsEntry(entry) {
  return Boolean(entry && entry.sourceId === HACKERNEWS_SOURCE_ID);
}

function rewritePromptKey(entry) {
  if (isPaperInterpretationEntry(entry)) return 'namoo-paper-creation-draft-v1';
  if (isProductHuntEntry(entry)) return 'namoo-producthunt-creation-draft-v1';
  if (isHackerNewsEntry(entry)) return 'namoo-hackernews-creation-draft-v1';
  return 'namoo-creation-draft-v1';
}

function rewritePromptForEntry(entry) {
  if (isPaperInterpretationEntry(entry)) return NAMOO_PAPER_DRAFT_PROMPT;
  if (isProductHuntEntry(entry)) return NAMOO_PRODUCTHUNT_DRAFT_PROMPT;
  if (isHackerNewsEntry(entry)) return NAMOO_HACKERNEWS_DRAFT_PROMPT;
  return NAMOO_CREATION_DRAFT_PROMPT;
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

function officialSiteContext(entry) {
  const context = entry && entry.officialSiteContext;
  return context && typeof context === 'object' ? context : null;
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
  const official = officialSiteContext(entry);
  if (official && official.url) add(official.url, official.title || '产品官网', official.summary || '');

  const html = String(entry && entry.content || '');
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html))) add(match[1], match[2], match[2]);

  const officialMarkdown = String(official && official.content || '');
  const markdownLinkRe = /\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)\)/gi;
  while ((match = markdownLinkRe.exec(officialMarkdown))) add(match[2], match[1], match[1]);

  const textWithUrls = `${entry && entry.summary || ''}\n${stripHtmlKeepBreaks(html)}\n${officialMarkdown}`;
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
  const official = officialSiteContext(entry);
  if (official && official.image) add(official.image, official.title || 'official site');
  const html = String(entry && entry.content || '');
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    const tag = match[0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '';
    add(src, alt);
  }
  const officialMarkdown = String(official && official.content || '');
  const markdownImgRe = /!\[([^\]\n]{0,120})\]\((https?:\/\/[^)\s]+)\)/gi;
  while ((match = markdownImgRe.exec(officialMarkdown))) add(match[2], match[1] || 'official site');
  return refs.slice(0, 8);
}

function rewriteInputParts(entry) {
  const source = rewriteSourceText(entry);
  const imageRefs = markdownImageRefs(entry);
  const linkRefs = markdownLinkRefs(entry);
  const official = officialSiteContext(entry);
  const contentHash = store.hashText([
    rewritePromptKey(entry),
    entry.title || '',
    entry.summary || '',
    entry.content || '',
    official && official.url || '',
    official && official.title || '',
    official && official.summary || '',
    official && official.content || '',
    official && official.fetchedVia || '',
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
  const links = missing.map(ref => `- [${markdownLinkLabel(ref.label)}](${ref.url})`).join('\n');
  const heading = '## 事实底稿与原始链接';
  const headingIndex = text.indexOf(heading);
  if (headingIndex < 0) return [text, heading, links].join('\n\n');
  const nextHeading = text.indexOf('\n## ', headingIndex + heading.length);
  if (nextHeading < 0) return `${text}\n\n${links}`;
  return `${text.slice(0, nextHeading).trimEnd()}\n\n${links}\n${text.slice(nextHeading)}`;
}

function rewriteSourceText(entry) {
  if (isPaperInterpretationEntry(entry)) {
    return paperRewriteSourceText(entry);
  }
  if (isProductHuntEntry(entry)) {
    return productHuntRewriteSourceText(entry);
  }
  const translation = store.getTranslation(entry.id);
  if (translation && Array.isArray(translation.content) && translation.content.length) {
    return {
      kind: '已有中文翻译',
      text: [
        translation.titleZh ? `标题：${translation.titleZh}` : `标题：${entry.title || ''}`,
        translation.summaryZh ? `摘要：${translation.summaryZh}` : '',
        ...translation.content.map(pair => pair && (pair.target || stripHtml(pair.targetHtml))).filter(Boolean),
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

function productHuntRewriteSourceText(entry) {
  const official = officialSiteContext(entry);
  const productHuntBlocks = htmlToBlocks(entry.content, entry.summary);
  const officialBlocks = official ? htmlToBlocks(official.content, official.summary) : [];
  return {
    kind: official
      ? 'Product Hunt 条目 + 产品官网抓取资料'
      : 'Product Hunt 条目',
    text: [
      `Product Hunt 标题：${entry.title || ''}`,
      entry.summary ? `Product Hunt 摘要：${stripHtml(entry.summary)}` : '',
      entry.link ? `Product Hunt 页面：${entry.link}` : '',
      productHuntBlocks.length ? `Product Hunt RSS 内容：\n${productHuntBlocks.join('\n\n')}` : '',
      official ? [
        '产品官网抓取资料：',
        official.url ? `官网 URL：${official.url}` : '',
        official.title ? `官网标题：${official.title}` : '',
        official.summary ? `官网摘要：${official.summary}` : '',
        official.fetchedVia ? `抓取方式：${official.fetchedVia}` : '',
        officialBlocks.length ? officialBlocks.join('\n\n') : '',
      ].filter(Boolean).join('\n\n') : '',
    ].filter(Boolean).join('\n\n'),
  };
}

function paperAbstractFromEntry(entry) {
  const text = stripHtmlKeepBreaks(entry && (entry.content || entry.summary) || '');
  const match = text.match(/(?:^|\n)\s*摘要\s*\n+([\s\S]+)/);
  const abstract = match ? match[1] : text;
  return trimText(abstract.replace(/\n{3,}/g, '\n\n'), 12000);
}

function paperRewriteSourceText(entry) {
  return {
    kind: 'Hugging Face 每日论文摘要',
    text: [
      `论文标题：${entry.title || ''}`,
      entry.author ? `作者：${entry.author}` : '',
      entry.published ? `发布时间：${entry.published}` : '',
      entry.link ? `论文链接：${entry.link}` : '',
      `摘要：${paperAbstractFromEntry(entry)}`,
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

function rewritePlainText(value) {
  return stripHtml(String(value || '')
    .replace(/!\[[^\]\n]*\]\([^\n)]+\)/g, ' ')
    .replace(/\[([^\]\n]+)\]\([^\n)]+\)/g, '$1')
    .replace(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[`*_~]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function rewriteSignalLength(value) {
  return (rewritePlainText(value).match(/[\p{Letter}\p{Number}]/gu) || []).length;
}

function rewriteHanLength(value) {
  return (rewritePlainText(value).match(/\p{Script=Han}/gu) || []).length;
}

function rewriteParagraphCount(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map(block => block
      .split('\n')
      .filter(line => !/^\s{0,3}#{1,6}(?:\s|$)/.test(line))
      .join(' '))
    .filter(block => rewriteSignalLength(block) >= 12)
    .length;
}

function rewriteQuality(sourceText, body) {
  const plainBody = rewritePlainText(body);
  const sourceLength = rewriteSignalLength(sourceText);
  const hanLength = rewriteHanLength(body);
  const paragraphCount = rewriteParagraphCount(body);
  const minHanLength = Math.max(48, Math.min(360, Math.ceil(sourceLength * 0.09)));
  const minParagraphCount = sourceLength >= 2400 ? 3 : sourceLength >= 700 ? 2 : 1;
  const opening = plainBody.slice(0, 220);
  const refusal = [
    /^(?:我\s*)?(?:很|非常)?抱歉(?:[，,。.!！]|\s|$)/,
    /^(?:(?:我|本模型|当前模型|该模型|系统|当前|暂时|目前)\s*)?(?:无法|不能)(?:处理|完成|提供|改写|翻译|回答|访问|浏览)/,
    /作为\s*(?:一个|一名)?\s*(?:AI|人工智能)(?:语言)?(?:助手|模型)/i,
    /作为\s*(?:一个|一名)?\s*(?:AI|人工智能)\s*[，,]\s*(?:我)?(?:无法|不能|不会)/i,
    /^(?:i(?:'|’)m sorry|i (?:can(?:not|'t)|am unable to))/i,
  ].some(pattern => pattern.test(opening));
  if (refusal) return { ok: false, reason: '模型返回了拒答' };
  if (hanLength < minHanLength) return { ok: false, reason: `中文正文过短（${hanLength}/${minHanLength}）` };
  if (paragraphCount < minParagraphCount) return { ok: false, reason: `正文段落不足（${paragraphCount}/${minParagraphCount}）` };
  return { ok: true };
}

function requestHeaders(config) {
  if (config.providerType === 'anthropic_compatible') {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function isAigocodeBaseUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'api.aigocode.app'
      || host.endsWith('.aigocode.app')
      || host === 'api.aigocode.com'
      || host.endsWith('.aigocode.com');
  } catch {
    return false;
  }
}

function appendEndpointPath(baseUrl, parts) {
  const url = new URL(baseUrl);
  for (const part of parts) url.pathname = `${url.pathname.replace(/\/+$/, '')}/${part}`;
  return url.toString().replace(/\/$/, '');
}

function completionUrl(config) {
  if (config.providerType === 'anthropic_compatible') {
    if (/\/messages$/i.test(config.baseUrl)) return config.baseUrl;
    if (/\/v1$/i.test(config.baseUrl)) return appendEndpointPath(config.baseUrl, ['messages']);
    return appendEndpointPath(config.baseUrl, ['v1', 'messages']);
  }
  if (/\/chat\/completions$/i.test(config.baseUrl)) return config.baseUrl;
  if (isAigocodeBaseUrl(config.baseUrl) && new URL(config.baseUrl).pathname.replace(/\/+$/, '') === '') {
    return appendEndpointPath(config.baseUrl, ['v1', 'chat', 'completions']);
  }
  return `${config.baseUrl}/chat/completions`;
}

function modelsUrl(config) {
  if (/\/models$/i.test(config.baseUrl)) return config.baseUrl;
  if (/\/v1$/i.test(config.baseUrl)) return appendEndpointPath(config.baseUrl, ['models']);
  if (isAigocodeBaseUrl(config.baseUrl) && new URL(config.baseUrl).pathname.replace(/\/+$/, '') === '') {
    return appendEndpointPath(config.baseUrl, ['v1', 'models']);
  }
  return `${config.baseUrl}/models`;
}

function providerRequestUrlLabel(config, url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function htmlResponseError(config, url, status, text) {
  const snippet = stripHtml(text).slice(0, 160) || text.slice(0, 160);
  const err = new Error(`${config.providerTitle} 返回了 HTML 页面而不是 JSON。通常是 Base URL 路径不对；本次请求地址：${providerRequestUrlLabel(config, url)}。${snippet ? `页面提示：${snippet}` : ''}`);
  err.statusCode = status >= 500 ? 502 : 400;
  err.retryable = status >= 500;
  return err;
}

function parseProviderJsonResponse(config, url, text, status = 200) {
  const trimmed = String(text || '').trim();
  if (/^</.test(trimmed)) throw htmlResponseError(config, url, status, trimmed);
  try {
    return JSON.parse(trimmed || '{}');
  } catch (error) {
    const err = new Error(`${config.providerTitle} 返回格式不是合法 JSON：${String(error.message || error)}。请求地址：${providerRequestUrlLabel(config, url)}`);
    err.statusCode = status >= 500 ? 502 : 400;
    throw err;
  }
}

function anthropicPayload(config, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = messages
    .filter(message => message && message.role === 'system' && message.content)
    .map(message => String(message.content).trim())
    .filter(Boolean);
  const chatMessages = messages
    .filter(message => message && message.role !== 'system' && message.content)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content),
    }));
  return {
    model: config.model,
    system: systemParts.join('\n\n') || undefined,
    messages: chatMessages.length ? chatMessages : [{ role: 'user', content: 'ping' }],
    max_tokens: body.max_tokens || config.maxTokens,
    temperature: body.temperature === undefined ? config.temperature : body.temperature,
    stream: false,
  };
}

function finishReasonError(config, reason, { anthropic = false } = {}) {
  const finishReason = String(reason || '').trim().toLowerCase();
  const successful = anthropic
    ? !finishReason || finishReason === 'end_turn' || finishReason === 'stop_sequence'
    : !finishReason || finishReason === 'stop';
  if (successful) return null;

  const labels = {
    length: '输出达到 token 上限或上下文上限',
    max_tokens: '输出达到 token 上限',
    model_context_window_exceeded: '输入超过模型上下文上限',
    content_filter: '输出被内容过滤器截断',
    refusal: '模型拒绝了本次请求',
    tool_calls: '模型意外返回了工具调用',
    tool_use: '模型意外返回了工具调用',
    insufficient_system_resource: '推理服务资源不足，生成被中断',
    pause_turn: '推理服务暂停了当前生成',
  };
  const err = new Error(`${config.providerTitle} ${labels[finishReason] || `以 ${finishReason} 结束`}，未保存不完整结果`);
  err.retryable = finishReason === 'insufficient_system_resource' || finishReason === 'pause_turn';
  err.statusCode = err.retryable ? 503 : 422;
  return err;
}

function providerRetryDelay(res, attempt) {
  const retryAfter = Number.parseFloat(res && res.headers && res.headers.get('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5000, retryAfter * 1000);
  return 400 * (2 ** attempt) + Math.floor(Math.random() * 200);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postChatCompletion(config, body, timeout = 60000) {
  const payload = config.providerType === 'anthropic_compatible'
    ? anthropicPayload(config, body)
    : {
      model: config.model,
      stream: false,
      ...body,
    };
  if (config.providerType !== 'anthropic_compatible') {
    if (payload.temperature === undefined) payload.temperature = config.temperature;
    if (payload.max_tokens === undefined) payload.max_tokens = config.maxTokens;
    if (config.provider === 'deepseek') payload.thinking = { type: 'disabled' };
  }
  const url = completionUrl(config);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(config),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
      let text = '';
      try {
        text = await res.text();
      } catch (error) {
        error.retryable = true;
        error.statusCode = 502;
        throw error;
      }

      if (!res.ok) {
        if (/^\s*</.test(text)) throw htmlResponseError(config, url, res.status, text);
        const err = new Error(`${config.providerTitle} request failed: ${res.status} ${text.slice(0, 180)}`);
        err.statusCode = res.status >= 500 ? 502 : 400;
        throw err;
      }

      const data = parseProviderJsonResponse(config, url, text, res.status);
      const anthropicContent = Array.isArray(data.content)
        ? data.content.map(item => item && item.text).filter(Boolean).join('\n')
        : '';
      const choice = data && data.choices && data.choices[0];
      const content = anthropicContent || (choice && choice.message
        ? choice.message.content
        : '');
      const finishReason = String(data.stop_reason || (choice && choice.finish_reason) || '').toLowerCase();
      const interrupted = finishReasonError(config, finishReason, {
        anthropic: Object.prototype.hasOwnProperty.call(data, 'stop_reason'),
      });
      if (interrupted) throw interrupted;
      if (!content) throw new Error(`${config.providerTitle} returned an empty response`);
      return content;
    } catch (error) {
      lastError = error;
      const retryable = error.retryable || error.name === 'TimeoutError' || error.name === 'AbortError';
      if (!retryable || attempt > 0) throw error;
      await delay(providerRetryDelay(res, attempt));
    }
  }
  throw lastError || new Error(`${config.providerTitle} request failed`);
}

async function listModels(options = {}) {
  const config = getConfig(options);
  assertConfigured(config);
  const url = modelsUrl(config);
  const res = await fetch(url, {
    headers: requestHeaders(config),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (/^\s*</.test(text)) throw htmlResponseError(config, url, res.status, text);
    const err = new Error(`${config.providerTitle} models request failed: ${res.status} ${text.slice(0, 180)}`);
    err.statusCode = res.status >= 500 ? 502 : 400;
    throw err;
  }
  const data = parseProviderJsonResponse(config, url, text, res.status);
  const remoteModels = Array.isArray(data.data)
    ? data.data.map(item => String(item.id || '')).filter(Boolean)
    : [];
  const models = config.provider === 'deepseek'
    ? remoteModels.filter(model => model === SERVER_DEEPSEEK_MODEL)
    : remoteModels;
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

const TRANSLATABLE_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,pre,table,figure,img,hr';

function compactHtml(value, max = 1600) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeInlineHtml(value) {
  return String(value || '').replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function isNestedInSelectedBlock($, el) {
  const parent = $(el).parent().closest(TRANSLATABLE_BLOCK_SELECTOR);
  return parent.length > 0;
}

function sourceHtmlForTranslationBlock($, el) {
  const node = $(el);
  const tag = String(el.name || '').toLowerCase();
  const parent = node.parent();
  if (/^h[1-6]$/.test(tag) && parent && String(parent.prop('tagName') || '').toLowerCase() === 'a') {
    const href = parent.attr('href');
    if (href) {
      const safeHref = String(href).replace(/"/g, '&quot;');
      return `<${tag}><a href="${safeHref}">${node.html() || escapeInlineHtml(stripHtml(node.text()))}</a></${tag}>`;
    }
  }
  return $.html(node);
}

function htmlToTranslationBlocks(html, fallback = '') {
  const sourceHtml = String(html || '').trim();
  const blocks = [];
  if (sourceHtml) {
    const $ = cheerio.load(sourceHtml, { decodeEntities: false }, false);
    $(TRANSLATABLE_BLOCK_SELECTOR).each((_, el) => {
      if (blocks.length >= 32 || isNestedInSelectedBlock($, el)) return;
      const tag = String(el.name || '').toLowerCase();
      const rawHtml = sourceHtmlForTranslationBlock($, el);
      const source = stripHtml(rawHtml);
      const isMedia = tag === 'img' || tag === 'figure' || tag === 'hr';
      if (!isMedia && source.length < 12) return;
      blocks.push({
        i: blocks.length,
        tag,
        source: source.slice(0, 1200),
        sourceHtml: compactHtml(rawHtml),
        kind: isMedia ? 'media' : 'text',
      });
    });
  }

  if (!blocks.some(block => block.kind === 'text')) {
    return htmlToBlocks(html, fallback).map((source, i) => ({
      i,
      tag: 'p',
      source,
      sourceHtml: '',
      kind: 'text',
    }));
  }

  const out = [];
  let total = 0;
  for (const block of blocks) {
    if (out.length >= 28 || total >= 11000) break;
    out.push(block);
    total += block.source.length + block.sourceHtml.length;
  }
  return out;
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

async function translateTitleBatch(entries, { apiKey = '', author = 'system', provider = '', providerName = '', providerType = '', baseUrl = '', model = '', temperature, maxTokens } = {}) {
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

async function translateEntry(entry, { apiKey = '', provider = '', providerName = '', providerType = '', baseUrl = '', model = '', temperature, maxTokens, author = 'system', userId = null, force = false } = {}) {
  if (!entry || !entry.id) throw new Error('entry is required');
  const contentHash = store.hashText((entry.title || '') + '\n' + (entry.content || entry.summary || ''));
  const cached = store.getTranslation(entry.id);
  if (!force && cached && cached.content && cached.contentHash === contentHash) {
    return { translation: cached, cached: true };
  }

  const config = getConfig({ apiKey, provider, providerName, providerType, baseUrl, model, temperature, maxTokens });
  assertConfigured(config);

  const blocks = htmlToTranslationBlocks(entry.content, entry.summary);
  const content = await postChatCompletion(config, {
    messages: [
      {
        role: 'system',
        content: [
          '你是专业的英文到中文文章翻译助手。',
          '只输出 JSON：{"titleZh":"","summaryZh":"","blocks":[{"i":0,"target":"","targetHtml":""}]}。',
          '忠实、自然、不要扩写，不要省略。',
          'target 是纯中文文本；targetHtml 是中文 HTML，必须尽量保持原始块的外层标签和阅读结构。',
          '保留原文中的 a href、img src、strong/em/code/pre、列表、引用、表格和图片位置；URL 和图片地址不得改写。',
          '不要新增 hr 或水平分割线；只有原始块本身是 hr 时才保留。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `标题：${entry.title || ''}`,
          `摘要：${entry.summary || ''}`,
          '待翻译结构块。请按 i 返回每块译文：',
          ...blocks.map(block => [
            `i=${block.i}`,
            `tag=${block.tag}`,
            `kind=${block.kind}`,
            `text=${block.source}`,
            block.sourceHtml ? `html=${block.sourceHtml}` : '',
          ].filter(Boolean).join('\n')),
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 4500,
    temperature: 0.15,
  }, 90000);

  const raw = parseJsonResponse(content);
  const translated = Array.isArray(raw.blocks)
    ? raw.blocks
    : Array.isArray(raw.paragraphs)
      ? raw.paragraphs
      : [];
  const zhByIndex = new Map(translated.map(item => {
    const targetHtml = trimText(item.targetHtml || item.html || '', 5000);
    const target = trimText(item.target || item.zh || stripHtml(targetHtml), 3000);
    return [Number(item.i), { target, targetHtml }];
  }));
  const paragraphPairs = blocks.map((block, i) => {
    const translatedBlock = zhByIndex.get(Number(block.i)) || zhByIndex.get(i) || {};
    return {
      i: Number(block.i) || i,
      tag: block.tag || 'p',
      kind: block.kind || 'text',
      source: block.source || '',
      sourceHtml: block.sourceHtml || '',
      target: translatedBlock.target || '',
      targetHtml: translatedBlock.targetHtml || '',
    };
  }).filter(pair => (pair.source || pair.sourceHtml) && (pair.target || pair.targetHtml || pair.kind === 'media'));

  if (!paragraphPairs.length) throw new Error(`${config.providerTitle} returned an empty translation`);

  const translation = store.saveTranslation(entry.id, {
    titleZh: isLikelyEnglish(entry.title) ? trimString(raw.titleZh, 180) : '',
    summaryZh: trimText(raw.summaryZh, 600),
    content: paragraphPairs,
    model: config.model,
    provider: config.provider,
    createdBy: author,
    userId,
    contentHash,
    titleHash: store.hashText(entry.title || ''),
  });

  return { translation, cached: false };
}

async function rewriteEntry(entry, { apiKey = '', provider = '', providerName = '', providerType = '', baseUrl = '', model = '', temperature, maxTokens, author = 'system', userId = null, force = false } = {}) {
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
        content: rewritePromptForEntry(entry),
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
  const draft = cleanRewriteMarkdown(rawBody);
  if (!draft) throw new Error(`${config.providerTitle} returned an empty rewrite`);
  const quality = rewriteQuality(source.text, draft);
  if (!quality.ok) {
    const error = new Error(`${config.providerTitle} 改写质量校验失败：${quality.reason}，未保存不完整结果`);
    error.statusCode = 422;
    throw error;
  }
  const body = ensureRewriteLinks(draft, linkRefs);
  const rewrite = store.saveRewrite(entry.id, {
    title: entry.title || '',
    body,
    model: config.model,
    provider: config.provider,
    createdBy: author,
    userId,
    contentHash,
  });
  return { rewrite, cached: false };
}

async function chatWithEntry(entry, messages, { apiKey = '', provider = '', providerName = '', providerType = '', baseUrl = '', model = '', temperature, maxTokens, author = '读者', userId = null } = {}) {
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
    userId,
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
  rewritePromptForEntry,
  rewritePromptKey,
  ensureRewriteLinks,
  testConnection,
  translateEntry,
  translateTitleBatch,
};
