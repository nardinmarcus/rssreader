/* QMReader front-end */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// localStorage throws SecurityError inside sandboxed iframes — fall back to in-memory
const storage = (() => {
  try {
    const t = window.localStorage;
    t.getItem('__probe__');
    return t;
  } catch {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  }
})();

function readJson(key, fallback) {
  try { return JSON.parse(storage.getItem(key) || fallback); } catch { return JSON.parse(fallback); }
}

const CATEGORY_LABELS = { article: '文章', news: '资讯', podcast: '播客' };
const READER_TABS = ['original', 'translation', 'rewrite'];
const ASSET_FILTER_TYPES = ['translation', 'rewrite', 'comments', 'chat'];
const ASSET_FOCUS_LABELS = { translation: '中文翻译', rewrite: '乔木风格重写', comments: '人工点评', chat: '文章对话' };
const COMMENT_TEMPLATES = {
  insight: '观点：',
  question: '疑问：',
  action: '行动：',
  quote: '引用：',
  source: '资料：',
};
const COMMENT_TEMPLATE_LABELS = {
  insight: '观点',
  question: '疑问',
  action: '行动',
  quote: '引用',
  source: '资料',
};
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const AI_PROVIDER_CATEGORIES = ['海外大模型', '海外聚合', '国内大模型', '国内聚合'];
const AI_PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    providerType: 'openai_compatible',
    category: '国内大模型',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    quickModels: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    description: 'DeepSeek 官方接口',
    recommended: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerType: 'openai_compatible',
    category: '海外聚合',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    quickModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    description: '多模型聚合平台，模型最全',
    recommended: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    providerType: 'openai_compatible',
    category: '海外大模型',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    quickModels: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    description: 'OpenAI 官方接口',
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    providerType: 'openai_compatible',
    category: '海外大模型',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-0709',
    quickModels: ['grok-4-0709', 'grok-3-mini'],
    apiKeyUrl: 'https://console.x.ai/team/api-keys',
    description: 'xAI 官方 Grok',
  },
  {
    id: 'groq',
    name: 'Groq',
    providerType: 'openai_compatible',
    category: '海外聚合',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    quickModels: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'gemma2-9b-it'],
    apiKeyUrl: 'https://console.groq.com/keys',
    description: '高吞吐低延迟',
  },
  {
    id: 'together',
    name: 'Together',
    providerType: 'openai_compatible',
    category: '海外聚合',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'deepseek-ai/DeepSeek-R1-0528',
    quickModels: ['deepseek-ai/DeepSeek-R1-0528', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    description: '开源模型聚合',
  },
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    providerType: 'openai_compatible',
    category: '国内大模型',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    quickModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    description: '月之暗面 Kimi',
  },
  {
    id: 'zhipu',
    name: '智谱',
    providerType: 'openai_compatible',
    category: '国内大模型',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    quickModels: ['glm-4-plus', 'glm-4-flash'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    description: '智谱 GLM 系列',
  },
  {
    id: 'qwen',
    name: '阿里百炼',
    providerType: 'openai_compatible',
    category: '国内大模型',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    quickModels: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    apiKeyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    description: '通义千问',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    providerType: 'openai_compatible',
    category: '国内聚合',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    quickModels: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    description: '国产聚合平台',
    recommended: true,
  },
  {
    id: 'doubao',
    name: '火山方舟',
    providerType: 'openai_compatible',
    category: '国内大模型',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'ep-20250616135538-zdz4b',
    quickModels: ['ep-20250616135538-zdz4b'],
    apiKeyUrl: 'https://www.volcengine.com/experience/ark',
    description: '豆包 / 火山引擎',
  },
  {
    id: 'aihubmix',
    name: 'AiHubMix',
    providerType: 'openai_compatible',
    category: '国内聚合',
    baseUrl: 'https://aihubmix.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    quickModels: ['claude-sonnet-4-20250514', 'o3-mini', 'gemini-2.5-pro-search'],
    apiKeyUrl: 'https://aihubmix.com/token',
    description: '国内聚合平台',
  },
  {
    id: 'workers_ai',
    name: 'Cloudflare Workers AI',
    providerType: 'openai_compatible',
    category: '海外大模型',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    quickModels: ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b'],
    apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    description: 'Cloudflare 官方 Workers AI，Base URL 里的 <ACCOUNT_ID> 需替换为你的账号 ID。',
  },
];
const AI_PROVIDER_MAP = Object.fromEntries(AI_PROVIDER_PRESETS.map(preset => [preset.id, preset]));
const DEFAULT_AI_PRESET_ID = 'deepseek';

function createId(prefix) {
  const random = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`;
}

function normalizeBaseUrl(input) {
  return String(input || '').trim().replace(/\/+$/, '');
}

function normalizeReaderTab(tab) {
  return READER_TABS.includes(tab) ? tab : 'original';
}

function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(2, n));
}

function clampMaxTokens(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  const n = Number(digits || 2000);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  return Math.max(1, Math.min(32768, Math.floor(n)));
}

function maskApiKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function presetById(id) {
  return AI_PROVIDER_MAP[id] || AI_PROVIDER_MAP[DEFAULT_AI_PRESET_ID];
}

function createProfileFromPreset(presetId = DEFAULT_AI_PRESET_ID, overrides = {}) {
  const preset = presetById(presetId);
  const now = Date.now();
  return {
    id: createId('ai'),
    name: preset.name,
    provider: preset.id,
    providerName: preset.name,
    providerType: preset.providerType,
    providerCategory: preset.category,
    apiKeyUrl: preset.apiKeyUrl || '',
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    temperature: 0.7,
    maxTokens: 2000,
    apiKey: '',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createCustomProfile(overrides = {}) {
  const now = Date.now();
  return {
    id: createId('ai'),
    name: '自定义模型',
    provider: 'custom',
    providerName: '自定义',
    providerType: 'openai_compatible',
    providerCategory: '',
    apiKeyUrl: '',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 2000,
    apiKey: '',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function normalizeProfile(raw, index = 0) {
  const provider = String(raw && raw.provider || DEFAULT_AI_PRESET_ID).trim() || DEFAULT_AI_PRESET_ID;
  const preset = AI_PROVIDER_MAP[provider];
  const hasDefaultFlag = raw && (Object.prototype.hasOwnProperty.call(raw, 'isDefault') || Object.prototype.hasOwnProperty.call(raw, 'is_default'));
  return {
    id: String(raw && raw.id || createId('ai')),
    name: String(raw && raw.name || (preset ? preset.name : '自定义模型')).trim(),
    provider,
    providerName: String(raw && (raw.providerName || raw.provider_name) || (preset ? preset.name : provider)).trim(),
    providerType: String(raw && (raw.providerType || raw.provider_type) || (preset ? preset.providerType : 'openai_compatible')).trim(),
    providerCategory: String(raw && (raw.providerCategory || raw.provider_category) || (preset ? preset.category : '')).trim(),
    apiKeyUrl: String(raw && (raw.apiKeyUrl || raw.api_key_url) || (preset ? preset.apiKeyUrl || '' : '')).trim(),
    baseUrl: normalizeBaseUrl(raw && (raw.baseUrl || raw.base_url) || (preset ? preset.baseUrl : '')),
    model: String(raw && raw.model || (preset ? preset.defaultModel : '')).trim(),
    temperature: clampTemperature(raw && raw.temperature),
    maxTokens: clampMaxTokens(raw && (raw.maxTokens || raw.max_tokens)),
    apiKey: String(raw && (raw.apiKey || raw.api_key) || '').trim(),
    isDefault: hasDefaultFlag ? Boolean(raw.isDefault || raw.is_default) : index === 0,
    createdAt: Number(raw && raw.createdAt) || Date.now(),
    updatedAt: Number(raw && raw.updatedAt) || Date.now(),
  };
}

const state = {
  sources: [],
  entries: [],
  view: 'all',            // all | unread | starred | assets
  filterSource: null,
  filterCategory: null,
  assetFilter: null,
  q: '',
  activeEntry: null,
  guestRead: new Set(readJson('fr_read', '[]')),
  guestStarred: new Set(readJson('fr_starred', '[]')),
  read: new Set(readJson('fr_read', '[]')),
  starred: new Set(readJson('fr_starred', '[]')),
  agentMessages: [],
  comments: [],
  translation: null,
  translationLoading: false,
  translationGenerating: false,
  pendingTranslationGenerate: false,
  rewrite: null,
  rewriteGenerating: false,
  readerTab: 'original',
  readerFocus: null,
  pendingAssetJump: null,
  pendingCommentId: '',
  pendingChatMessageId: '',
  fetchingOriginal: false,
  agentBusy: false,
  agentCollapsed: storage.getItem('qm_agent_collapsed') === '1',
  me: null,
  authMode: 'login',
  aiProfiles: [],
  activeAiProfileId: '',
  editingAiProfileId: '',
  aiConfigReason: '',
  pendingAiAction: '',
  pendingAgentText: '',
  loadedAiScope: '',
};

function routeStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hash = decodeURIComponent(String(window.location.hash || '').replace(/^#/, ''));
  const commentId = hash.startsWith('comment-') ? hash.slice('comment-'.length).trim() : '';
  const chatMessageId = hash.startsWith('chat-') ? hash.slice('chat-'.length).trim() : '';
  const focus = ASSET_FILTER_TYPES.includes(params.get('focus')) ? params.get('focus') : null;
  return {
    entryId: String(params.get('entry') || '').trim(),
    tab: normalizeReaderTab(params.get('tab')),
    view: params.get('view') === 'assets' ? 'assets' : '',
    assetFilter: ASSET_FILTER_TYPES.includes(params.get('asset')) ? params.get('asset') : null,
    focus: commentId ? 'comments' : chatMessageId ? 'chat' : focus,
    commentId,
    chatMessageId,
  };
}

function listRouteTitle(view = state.view, assetFilter = state.assetFilter) {
  if (view === 'assets') {
    return assetFilter ? `${ASSET_TYPE_LABELS[assetFilter] || '公开'}资产 · QMReader` : '公开资产 · QMReader';
  }
  return 'QMReader · RSS 阅读器';
}

function readerRouteTitle(entry = state.activeEntry, focus = state.readerFocus) {
  const title = entry ? (entry.titleZh || entry.title || '文章') : '文章';
  const prefix = focus && ASSET_FOCUS_LABELS[focus] ? `${ASSET_FOCUS_LABELS[focus]} · ` : '';
  return `${prefix}${title} · QMReader`;
}

function readerUrlFor(entry = state.activeEntry, tab = state.readerTab, focus = state.readerFocus) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  if (entry && entry.id) {
    url.searchParams.set('entry', entry.id);
    const nextTab = normalizeReaderTab(tab);
    if (nextTab !== 'original') url.searchParams.set('tab', nextTab);
    if (focus && ASSET_FILTER_TYPES.includes(focus)) url.searchParams.set('focus', focus);
  }
  return url;
}

function readerAssetUrl(type, entry = state.activeEntry) {
  if (!entry || !ASSET_FILTER_TYPES.includes(type)) return '';
  const tab = type === 'translation' ? 'translation' : type === 'rewrite' ? 'rewrite' : 'original';
  return readerUrlFor(entry, tab, type).href;
}

function commentUrl(commentId, entry = state.activeEntry) {
  if (!entry || !commentId) return '';
  const url = readerUrlFor(entry, 'original', 'comments');
  url.hash = `comment-${encodeURIComponent(commentId)}`;
  return url.href;
}

function chatMessageUrl(messageId, entry = state.activeEntry) {
  if (!entry || !messageId) return '';
  const url = readerUrlFor(entry, 'original', 'chat');
  url.hash = `chat-${encodeURIComponent(messageId)}`;
  return url.href;
}

function readerShareFocus() {
  if (state.readerFocus && ASSET_FILTER_TYPES.includes(state.readerFocus)) return state.readerFocus;
  if (state.readerTab === 'translation' && state.translation) return 'translation';
  if (state.readerTab === 'rewrite' && state.rewrite) return 'rewrite';
  return null;
}

function copyReaderLink() {
  const entry = state.activeEntry;
  if (!entry) return;
  const focus = readerShareFocus();
  const tab = focus === 'translation' ? 'translation' : focus === 'rewrite' ? 'rewrite' : state.readerTab;
  const url = readerUrlFor(entry, tab, focus);
  document.title = readerRouteTitle(entry, focus);
  if (url.href !== window.location.href) {
    history.replaceState({ entryId: entry.id, tab, focus }, '', url);
  }
  copyText(url.href, focus && ASSET_FOCUS_LABELS[focus] ? `${ASSET_FOCUS_LABELS[focus]}链接已复制` : '文章链接已复制');
}

function listUrlFor(view = state.view, assetFilter = state.assetFilter) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  if (view === 'assets') {
    url.searchParams.set('view', 'assets');
    if (assetFilter && ASSET_FILTER_TYPES.includes(assetFilter)) {
      url.searchParams.set('asset', assetFilter);
    }
  }
  return url;
}

function syncReaderUrl({ replace = false, commentId = '', chatMessageId = '' } = {}) {
  const entry = state.activeEntry;
  if (!entry || !entry.id) return;
  const url = readerUrlFor(entry, state.readerTab);
  if (commentId) url.hash = `comment-${encodeURIComponent(commentId)}`;
  if (chatMessageId) url.hash = `chat-${encodeURIComponent(chatMessageId)}`;
  document.title = readerRouteTitle(entry);
  if (url.href === window.location.href) return;
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ entryId: entry.id, tab: state.readerTab, commentId, chatMessageId }, '', url);
}

function syncListUrl({ replace = false } = {}) {
  const url = listUrlFor();
  document.title = listRouteTitle();
  if (url.href === window.location.href) return;
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ view: state.view, assetFilter: state.assetFilter }, '', url);
}

function clearReaderUrl({ replace = true } = {}) {
  const url = readerUrlFor(null);
  document.title = 'QMReader · RSS 阅读器';
  if (url.href === window.location.href) return;
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ entryId: null }, '', url);
}

function persist() {
  if (state.me) return;
  state.guestRead = new Set(state.read);
  state.guestStarred = new Set(state.starred);
  storage.setItem('fr_read', JSON.stringify([...state.guestRead].slice(-5000)));
  storage.setItem('fr_starred', JSON.stringify([...state.guestStarred]));
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function escapeJsString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

function renderInlineMarkdown(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" />`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdownLite(value) {
  const escaped = escapeHtml(value).replace(/\r\n/g, '\n').replace(/\n\s*-{3,}\s*\n/g, '\n\n');
  const blocks = escaped.split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    const first = lines[0].trim();
    if (/^#{1,4}\s+/.test(first) && lines.length === 1) {
      const level = Math.min(first.match(/^#+/)[0].length, 4);
      return `<h${level}>${renderInlineMarkdown(first.replace(/^#{1,4}\s+/, ''))}</h${level}>`;
    }
    if (lines.every(line => /^&gt;\s+/.test(line.trim()))) {
      return `<blockquote>${lines.map(line => renderInlineMarkdown(line.trim().replace(/^&gt;\s+/, ''))).join('<br>')}</blockquote>`;
    }
    if (lines.every(line => /^[-*]\s+/.test(line.trim()))) {
      return `<ul>${lines.map(line => `<li>${renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every(line => /^\d+\.\s+/.test(line.trim()))) {
      return `<ol>${lines.map(line => `<li>${renderInlineMarkdown(line.trim().replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${renderInlineMarkdown(lines.join('<br>'))}</p>`;
  }).join('');

  return blocks;
}

async function copyText(value, success = '已复制') {
  const text = String(value || '');
  if (!text.trim()) {
    toast('没有可复制的内容');
    return false;
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(success);
    return true;
  } catch {
    toast('复制失败，请手动选中复制', 4000);
    return false;
  }
}

function fallbackFavicon(img, letter) {
  const icon = document.createElement('span');
  icon.className = 'letter-icon';
  icon.style.setProperty('--icon-size', img.style.getPropertyValue('--icon-size') || '17px');
  icon.textContent = letter || '?';
  img.replaceWith(icon);
}

function faviconHtml(siteUrl, name, size = 17) {
  const d = domainOf(siteUrl);
  const letter = ((name || '?').trim()[0] || '?').toUpperCase();
  const safeSize = Math.max(12, Math.min(Number(size) || 17, 48));
  if (!d) return `<span class="letter-icon" style="--icon-size:${safeSize}px">${escapeHtml(letter)}</span>`;
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=${Math.max(32, safeSize * 4)}`;
  return `<img class="favicon" style="--icon-size:${safeSize}px" src="${escapeHtml(src)}" loading="lazy" referrerpolicy="no-referrer"
    onerror="fallbackFavicon(this, '${escapeJsString(letter)}')" />`;
}

function isLikelyEnglishTitle(title) {
  const text = String(title || '');
  const letters = text.match(/[A-Za-z]/g) || [];
  const cjk = text.match(/[\u3400-\u9fff]/g) || [];
  return letters.length >= 6 && cjk.length <= 2;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ---------- API ---------- */
function aiScope() {
  return state.me ? `user:${state.me.id || state.me.email}` : 'guest';
}

function aiProfilesKey(scope = aiScope()) {
  return `qm_ai_profiles:${scope}`;
}

function aiActiveProfileKey(scope = aiScope()) {
  return `qm_ai_active_profile:${scope}`;
}

function migrateLegacyAiProfiles() {
  const profiles = [];
  const legacyConfigs = readJson('qm_ai_configs', '{}');
  const legacyKey = String(storage.getItem('qm_deepseek_key') || '').trim();

  for (const [provider, config] of Object.entries(legacyConfigs || {})) {
    if (!config || typeof config !== 'object') continue;
    const preset = AI_PROVIDER_MAP[provider];
    if (!preset && !config.baseUrl && !config.model && !config.apiKey) continue;
    profiles.push(createProfileFromPreset(preset ? provider : DEFAULT_AI_PRESET_ID, {
      name: preset ? preset.name : String(provider || '自定义模型'),
      provider: preset ? preset.id : String(provider || 'custom'),
      providerName: preset ? preset.name : String(provider || '自定义'),
      providerCategory: preset ? preset.category : '',
      apiKeyUrl: preset ? preset.apiKeyUrl || '' : '',
      baseUrl: normalizeBaseUrl(config.baseUrl || (preset ? preset.baseUrl : '')),
      model: String(config.model || (preset ? preset.defaultModel : '')).trim(),
      apiKey: String(config.apiKey || '').trim(),
      isDefault: String(storage.getItem('qm_ai_provider') || DEFAULT_AI_PRESET_ID) === provider,
    }));
  }

  if (legacyKey && !profiles.some(profile => profile.provider === 'deepseek' && profile.apiKey)) {
    profiles.push(createProfileFromPreset('deepseek', { apiKey: legacyKey, isDefault: profiles.length === 0 }));
  }

  return profiles;
}

function ensureSingleDefault(profiles) {
  if (!profiles.length) return [];
  const defaultIndex = Math.max(0, profiles.findIndex(profile => profile.isDefault));
  return profiles.map((profile, index) => ({ ...profile, isDefault: index === defaultIndex }));
}

function loadAiProfilesForScope() {
  const scope = aiScope();
  const stored = readJson(aiProfilesKey(scope), 'null');
  let profiles = Array.isArray(stored) ? stored.map(normalizeProfile) : migrateLegacyAiProfiles();
  if (!profiles.length) profiles = [createProfileFromPreset(DEFAULT_AI_PRESET_ID, { isDefault: true })];
  profiles = ensureSingleDefault(profiles);
  state.aiProfiles = profiles;
  const activeId = storage.getItem(aiActiveProfileKey(scope));
  state.activeAiProfileId = profiles.some(profile => profile.id === activeId)
    ? activeId
    : (profiles.find(profile => profile.isDefault) || profiles[0]).id;
  state.editingAiProfileId = state.activeAiProfileId;
  state.loadedAiScope = scope;
  persistAiProfiles();
}

function persistAiProfiles() {
  const scope = aiScope();
  storage.setItem(aiProfilesKey(scope), JSON.stringify(ensureSingleDefault(state.aiProfiles)));
  if (state.activeAiProfileId) storage.setItem(aiActiveProfileKey(scope), state.activeAiProfileId);
}

function currentAiProfile() {
  return state.aiProfiles.find(profile => profile.id === state.activeAiProfileId)
    || state.aiProfiles.find(profile => profile.isDefault)
    || state.aiProfiles[0]
    || createProfileFromPreset(DEFAULT_AI_PRESET_ID, { isDefault: true });
}

function currentAiConfig() {
  const profile = currentAiProfile();
  return {
    profileId: profile.id,
    profileName: profile.name,
    provider: profile.provider || DEFAULT_AI_PRESET_ID,
    providerName: profile.providerName || profile.name || profile.provider || 'AI',
    providerType: profile.providerType || 'openai_compatible',
    apiKey: String(profile.apiKey || '').trim(),
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    model: String(profile.model || '').trim(),
    temperature: clampTemperature(profile.temperature),
    maxTokens: clampMaxTokens(profile.maxTokens),
  };
}

function hasUsableAiConfig(config = currentAiConfig()) {
  return Boolean(config.apiKey && config.baseUrl && config.model);
}

function aiHeadersFromConfig(config) {
  return {
    'X-AI-Provider': config.provider,
    'X-AI-Provider-Name': config.providerName || config.profileName || config.provider,
    'X-AI-Provider-Type': config.providerType || 'openai_compatible',
    'X-AI-Key': String(config.apiKey || '').trim(),
    'X-AI-Base-URL': String(config.baseUrl || '').trim(),
    'X-AI-Model': String(config.model || '').trim(),
    'X-AI-Temperature': String(config.temperature ?? ''),
    'X-AI-Max-Tokens': String(config.maxTokens ?? ''),
  };
}

function aiHeaders() {
  return aiHeadersFromConfig(currentAiConfig());
}

function translationAiConfig() {
  const config = currentAiConfig();
  if (hasUsableAiConfig(config)) return config;
  return {
    provider: 'deepseek',
    providerName: 'DeepSeek',
    providerType: 'openai_compatible',
    apiKey: '',
    baseUrl: '',
    model: '',
    temperature: 0.15,
    maxTokens: 4500,
  };
}

function rewriteAiConfig() {
  const config = currentAiConfig();
  if (hasUsableAiConfig(config)) return { ...config, temperature: config.temperature || 0.6, maxTokens: Math.max(config.maxTokens || 0, 7000) };
  return {
    provider: 'deepseek',
    providerName: 'DeepSeek',
    providerType: 'openai_compatible',
    apiKey: '',
    baseUrl: '',
    model: '',
    temperature: 0.6,
    maxTokens: 7000,
  };
}

async function api(path, opts) {
  const headers = { ...(opts && opts.headers ? opts.headers : {}) };
  if (opts && opts.aiConfig) Object.assign(headers, aiHeadersFromConfig(opts.aiConfig));
  else if (opts && opts.ai) Object.assign(headers, aiHeaders());
  const rest = { ...(opts || {}) };
  delete rest.ai;
  delete rest.aiConfig;
  const res = await fetch(path, { ...rest, headers });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* keep HTTP status */ }
    throw new Error(message);
  }
  return res.json();
}
async function loadSources() {
  const data = await api('/api/sources');
  state.sources = data.sources;
  return data;
}
async function loadEntries() {
  const p = new URLSearchParams();
  if (state.filterSource) p.set('source', state.filterSource);
  if (state.filterCategory) p.set('category', state.filterCategory);
  if (state.q) p.set('q', state.q);
  const data = await api('/api/entries?' + p.toString());
  state.entries = data.entries;
}

function applyGuestEntryStates() {
  state.read = new Set(state.guestRead);
  state.starred = new Set(state.guestStarred);
}

async function loadUserEntryStates() {
  if (!state.me) {
    applyGuestEntryStates();
    return;
  }
  const data = await api('/api/me/entry-states');
  state.read = new Set((data.states && data.states.read) || []);
  state.starred = new Set((data.states && data.states.starred) || []);
}

function renderEntryStateUi() {
  renderList();
  renderSidebar();
  if (state.activeEntry) {
    const starBtn = $('#reader-star');
    starBtn.classList.toggle('starred', state.starred.has(state.activeEntry.id));
    starBtn.textContent = state.starred.has(state.activeEntry.id) ? '★ 已收藏' : '★ 收藏';
  }
}

async function syncEntryState(entryId, patch) {
  if (!state.me) {
    persist();
    return;
  }
  try {
    await api('/api/me/entry-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, ...patch }),
    });
  } catch (err) {
    toast('同步阅读状态失败: ' + err.message, 4000);
  }
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user || null;
  await loadUserEntryStates();
  loadAiProfilesForScope();
  renderAuthState();
  renderEntryStateUi();
  renderComments();
  renderAgent();
  renderAiSettings();
  return state.me;
}

/* ---------- Sidebar ---------- */
function unreadCountFor(pred) {
  return state.entries.filter(e => pred(e) && !state.read.has(e.id)).length;
}

function renderSidebar() {
  const groups = { article: [], news: [], podcast: [] };
  for (const s of state.sources) if (s.enabled) groups[s.category]?.push(s);

  const wrap = $('#feed-groups');
  wrap.innerHTML = '';
  for (const [cat, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = CATEGORY_LABELS[cat];
    label.style.cursor = 'pointer';
    label.title = `查看全部${CATEGORY_LABELS[cat]}`;
    label.onclick = () => selectCategory(cat);
    wrap.appendChild(label);

    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'feed-item' + (state.filterSource === s.id ? ' active' : '');
      const unread = unreadCountFor(e => e.sourceId === s.id);
      btn.innerHTML = `${faviconHtml(s.siteUrl, s.name)}
        <span class="fname" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        ${s.status === 'error' ? '<span class="err-dot" title="抓取失败"></span>' : ''}
        <span class="fcount">${unread || ''}</span>`;
      btn.onclick = () => selectSource(s.id);
      wrap.appendChild(btn);
    }
  }

  $('#count-all').textContent = state.entries.length || '';
  $('#count-unread').textContent = unreadCountFor(() => true) || '';
  $('#count-starred').textContent = state.starred.size || '';
  $('#count-assets').textContent = state.entries.filter(hasEntryAssets).length || '';
  renderAssetDashboard();

  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view && !state.filterSource && !state.filterCategory));
}

/* ---------- Entry list ---------- */
function hasEntryAssets(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  return Boolean(assets.translation || assets.rewrite || assets.comments || assets.chatMessages);
}

function entryHasAssetType(entry, type) {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation') return Boolean(assets.translation);
  if (type === 'rewrite') return Boolean(assets.rewrite);
  if (type === 'comments') return Boolean(assets.comments);
  if (type === 'chat') return Boolean(assets.chatMessages);
  return hasEntryAssets(entry);
}

function visibleEntries() {
  let list = state.entries;
  if (state.view === 'unread') list = list.filter(e => !state.read.has(e.id));
  if (state.view === 'starred') list = list.filter(e => state.starred.has(e.id));
  if (state.view === 'assets') {
    list = list
      .filter(hasEntryAssets)
      .filter(entry => !state.assetFilter || entryHasAssetType(entry, state.assetFilter))
      .slice()
      .sort((a, b) => {
        const assetDelta = Number(b.assets?.latestAt || 0) - Number(a.assets?.latestAt || 0);
        return assetDelta || (b.publishedTs || 0) - (a.publishedTs || 0);
      });
  }
  return list;
}

function sourceById(id) { return state.sources.find(s => s.id === id); }

function entryAssetItems(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const items = [];
  if (assets.translation) items.push({ type: 'translation', label: '中译', title: '查看中文翻译' });
  if (assets.rewrite) items.push({ type: 'rewrite', label: '重写', title: '查看乔木风格重写' });
  if (assets.comments) items.push({ type: 'comments', label: `点评 ${assets.comments}`, title: '查看人工点评' });
  if (assets.chatMessages) items.push({ type: 'chat', label: `对话 ${assets.chatMessages}`, title: '查看文章对话' });
  return items;
}

function assetBadgesHtml(entry, { interactive = false, copyable = false } = {}) {
  return entryAssetItems(entry).map(item => {
    const cls = `asset-badge asset-${item.type}${interactive ? ' asset-jump' : ''}`;
    if (!interactive) return `<span class="${cls}">${escapeHtml(item.label)}</span>`;
    const badge = `<button type="button" class="${cls}" data-asset="${item.type}" title="${escapeHtml(item.title)}">${escapeHtml(item.label)}</button>`;
    if (!copyable) return badge;
    const label = ASSET_FOCUS_LABELS[item.type] || item.label;
    return `<span class="asset-badge-group">${badge}<button type="button" class="asset-badge-copy" data-asset-copy="${item.type}" title="复制${escapeHtml(label)}链接" aria-label="复制${escapeHtml(label)}链接">⧉</button></span>`;
  }).join('');
}

const ASSET_TYPE_LABELS = {
  translation: '中译',
  rewrite: '重写',
  comments: '点评',
  chat: '对话',
};

const ASSET_FILTERS = {
  translation: { label: '中译', count: entry => Number(entry.assets?.translation ? 1 : 0), title: '查看有中文翻译的文章' },
  rewrite: { label: '重写', count: entry => Number(entry.assets?.rewrite ? 1 : 0), title: '查看有乔木风格重写的文章' },
  comments: { label: '点评', count: entry => Number(entry.assets?.comments || 0), title: '查看有人工点评的文章' },
  chat: { label: '对话', count: entry => Number(entry.assets?.chatMessages || 0), title: '查看有文章对话的文章' },
};

function assetTypeCount(entries, type) {
  const def = ASSET_FILTERS[type];
  if (!def) return 0;
  return entries.reduce((sum, entry) => sum + def.count(entry), 0);
}

function assetDashboardStats() {
  const entries = state.entries.filter(hasEntryAssets);
  const latest = entries
    .slice()
    .sort((a, b) => Number(b.assets?.latestAt || 0) - Number(a.assets?.latestAt || 0))[0] || null;
  return {
    entries,
    latest,
    counts: Object.fromEntries(Object.keys(ASSET_FILTERS).map(type => [type, assetTypeCount(entries, type)])),
  };
}

function renderAssetDashboard() {
  const dashboard = $('#asset-dashboard');
  if (!dashboard) return;
  dashboard.classList.toggle('hidden', !state.entries.length);

  const { entries, latest, counts } = assetDashboardStats();
  const total = entries.length;
  $('#asset-dashboard-total').textContent = total ? `${total} 篇` : '0 篇';
  const recentTypes = latest && Array.isArray(latest.assets?.latestTypes)
    ? latest.assets.latestTypes.map(type => ASSET_TYPE_LABELS[type]).filter(Boolean)
    : [];
  $('#asset-dashboard-recent').textContent = latest && latest.assets?.latestAt
    ? `${recentTypes.length ? recentTypes.join(' / ') : '资产'} · ${formatAssetTime(latest.assets.latestAt)}`
    : '暂无沉淀';

  const open = $('#asset-dashboard-open');
  open.disabled = total === 0;
  open.classList.toggle('active', state.view === 'assets' && !state.assetFilter && !state.filterSource && !state.filterCategory);

  for (const [type, def] of Object.entries(ASSET_FILTERS)) {
    const btn = $(`[data-asset-filter="${type}"]`);
    const count = counts[type] || 0;
    if (!btn) continue;
    btn.disabled = count === 0;
    btn.title = count ? def.title : '暂无这类资产';
    btn.classList.toggle('active', state.view === 'assets' && state.assetFilter === type && !state.filterSource && !state.filterCategory);
    const value = btn.querySelector('strong');
    if (value) value.textContent = count;
  }
}

function assetActivityLabel(entry) {
  if (state.view !== 'assets') return '';
  const assets = entry && entry.assets ? entry.assets : {};
  if (!assets.latestAt) return '';
  const types = Array.isArray(assets.latestTypes) ? assets.latestTypes : [];
  const labels = types.map(type => ASSET_TYPE_LABELS[type]).filter(Boolean);
  const prefix = labels.length ? labels.join(' / ') : '资产';
  return `${prefix} · 最近沉淀 ${formatAssetTime(assets.latestAt)}`;
}

function entryPrimaryAssetType(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const latestTypes = Array.isArray(assets.latestTypes) ? assets.latestTypes : [];
  const latest = latestTypes.find(type => ASSET_FILTER_TYPES.includes(type) && entryHasAssetType(entry, type));
  if (latest) return latest;
  return ASSET_FILTER_TYPES.find(type => entryHasAssetType(entry, type)) || '';
}

function latestAssetActivity(limit = 4) {
  return state.entries
    .filter(entry => hasEntryAssets(entry) && Number(entry.assets?.latestAt || 0) > 0)
    .slice()
    .sort((a, b) => {
      const assetDelta = Number(b.assets?.latestAt || 0) - Number(a.assets?.latestAt || 0);
      return assetDelta || (b.publishedTs || 0) - (a.publishedTs || 0);
    })
    .slice(0, limit)
    .map(entry => {
      const type = entryPrimaryAssetType(entry);
      const latestTypes = Array.isArray(entry.assets?.latestTypes) ? entry.assets.latestTypes : [];
      const labels = latestTypes.map(item => ASSET_TYPE_LABELS[item]).filter(Boolean);
      return {
        entry,
        type,
        labels: labels.length ? labels.join(' / ') : (ASSET_TYPE_LABELS[type] || '资产'),
      };
    });
}

function renderAssetActivityStrip() {
  const el = $('#asset-activity-strip');
  if (!el) return;
  const shouldShow = state.view === 'all' && !state.filterSource && !state.filterCategory && !state.q;
  const items = shouldShow ? latestAssetActivity(4).filter(item => item.type) : [];
  el.classList.toggle('hidden', !items.length);
  if (!items.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="asset-activity-head">
      <span>公开资产动态</span>
      <button type="button" data-asset-open-all>全部资产</button>
    </div>
    <div class="asset-activity-list">
      ${items.map(({ entry, type, labels }) => {
        const src = sourceById(entry.sourceId);
        return `<button type="button" class="asset-activity-item asset-activity-${type}" data-asset-entry="${escapeHtml(entry.id)}" data-asset-focus="${escapeHtml(type)}">
          <span class="asset-activity-type">${escapeHtml(labels)}</span>
          <strong>${escapeHtml(entry.titleZh || entry.title || '无标题')}</strong>
          <span class="asset-activity-meta">${escapeHtml([src && src.name, formatAssetTime(entry.assets.latestAt)].filter(Boolean).join(' · '))}</span>
        </button>`;
      }).join('')}
    </div>`;
}

function mergeAssets(entry, patch = {}) {
  return {
    translation: false,
    rewrite: false,
    comments: 0,
    chatMessages: 0,
    latestAt: 0,
    latestTypes: [],
    ...(entry && entry.assets ? entry.assets : {}),
    ...patch,
  };
}

function renderReaderAssets(entry = state.activeEntry) {
  const el = $('#reader-assets');
  const html = assetBadgesHtml(entry, { interactive: true });
  el.innerHTML = html;
  el.classList.toggle('hidden', !html);
}

function assetMetaLine(parts) {
  return parts.filter(Boolean).join(' · ') || '正在加载详情';
}

function latestAssetItem(items, pickLast = false) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  return pickLast ? list[list.length - 1] : list[0];
}

function renderReaderAssetSummary(entry = state.activeEntry) {
  const el = $('#reader-asset-summary');
  if (!entry) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const assets = mergeAssets(entry);
  const rows = [];
  const translation = state.translation && state.translation.entryId === entry.id ? state.translation : null;
  const rewrite = state.rewrite && state.rewrite.entryId === entry.id ? state.rewrite : null;
  const comments = (state.comments || []).filter(comment => comment.entryId === entry.id);
  const messages = (state.agentMessages || []).filter(message => !message.entryId || message.entryId === entry.id);

  if (assets.translation) {
    rows.push({
      type: 'translation',
      label: '中文翻译',
      value: translation ? assetMetaLine([translation.createdBy, translation.model, formatAssetTime(translation.updatedAt)]) : '正在加载详情',
    });
  }
  if (assets.rewrite) {
    rows.push({
      type: 'rewrite',
      label: '乔木重写',
      value: rewrite ? assetMetaLine([rewrite.createdBy, rewrite.model, formatAssetTime(rewrite.updatedAt)]) : '正在加载详情',
    });
  }
  if (assets.comments) {
    const latest = latestAssetItem(comments);
    rows.push({
      type: 'comments',
      label: '人工点评',
      value: latest ? assetMetaLine([`${assets.comments} 条`, latest.author, formatAssetTime(latest.createdAt)]) : `${assets.comments} 条 · 正在加载详情`,
    });
  }
  if (assets.chatMessages) {
    const latest = latestAssetItem(messages, true);
    rows.push({
      type: 'chat',
      label: '文章对话',
      value: latest ? assetMetaLine([`${assets.chatMessages} 条`, latest.author, formatAssetTime(latest.createdAt)]) : `${assets.chatMessages} 条 · 正在加载详情`,
    });
  }

  el.innerHTML = rows.map(row => `
    <div class="asset-summary-row asset-summary-${row.type}">
      <button type="button" class="asset-summary-item" data-asset-summary="${row.type}">
        <span>${escapeHtml(row.label)}</span>
        <strong>${escapeHtml(row.value)}</strong>
      </button>
      <button type="button" class="asset-summary-copy" data-asset-copy="${row.type}" title="复制${escapeHtml(row.label)}链接" aria-label="复制${escapeHtml(row.label)}链接">⧉</button>
    </div>`).join('');
  el.classList.toggle('hidden', !rows.length);
}

function scrollReaderTarget(selector) {
  const target = $(selector);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function performArticleAssetJump(type, { syncUrl = true, replaceUrl = false } = {}) {
  if (!state.activeEntry) return;
  if (type === 'translation') {
    state.readerFocus = 'translation';
    handleReaderTab('translation', { preserveFocus: true, replaceUrl });
    scrollReaderTarget('#reader-translation');
    return;
  }
  if (type === 'rewrite') {
    state.readerFocus = 'rewrite';
    setReaderTab('rewrite', { syncUrl, replaceUrl });
    scrollReaderTarget('#reader-rewrite-panel');
    return;
  }
  if (type === 'comments') {
    state.readerFocus = 'comments';
    if (syncUrl) syncReaderUrl({ replace: replaceUrl });
    scrollReaderTarget('#reader-comments');
    return;
  }
  if (type === 'chat') {
    state.readerFocus = 'chat';
    if (syncUrl) syncReaderUrl({ replace: replaceUrl });
    setAgentCollapsed(false);
    if (highlightAgentMessageFromRoute()) return;
    const messages = $('#agent-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    scrollReaderTarget('#agent-pane');
  }
}

function settlePendingAssetJump(type, { clear = true } = {}) {
  if (state.pendingAssetJump !== type) return;
  const entryId = state.activeEntry && state.activeEntry.id;
  [0, 180, 520].forEach((delay, index, delays) => {
    setTimeout(() => {
      if (!state.activeEntry || state.activeEntry.id !== entryId || state.pendingAssetJump !== type) return;
      performArticleAssetJump(type, { syncUrl: false });
      if (clear && index === delays.length - 1) state.pendingAssetJump = null;
    }, delay);
  });
}

function jumpToArticleAsset(type) {
  state.pendingAssetJump = type;
  performArticleAssetJump(type);
}

function copyArticleAssetLink(type) {
  const url = readerAssetUrl(type);
  if (!url) {
    toast('没有可复制的资产链接');
    return;
  }
  const label = ASSET_FOCUS_LABELS[type] || '资产';
  copyText(url, `${label}链接已复制`);
}

function updateEntryAssets(entryId, patch = {}, { rerenderList = true } = {}) {
  if (!entryId) return;
  const idx = state.entries.findIndex(entry => entry.id === entryId);
  if (idx >= 0) {
    state.entries[idx] = { ...state.entries[idx], assets: mergeAssets(state.entries[idx], patch) };
  }
  if (state.activeEntry?.id === entryId) {
    state.activeEntry = { ...state.activeEntry, assets: mergeAssets(state.activeEntry, patch) };
    renderReaderAssets(state.activeEntry);
    renderReaderAssetSummary(state.activeEntry);
  }
  if (rerenderList) renderList();
}

function isAdmin() {
  return state.me && state.me.role === 'admin';
}

function renderAuthState() {
  const loggedIn = Boolean(state.me);
  $('#auth-open').classList.toggle('hidden', loggedIn);
  $('#account-info').classList.toggle('hidden', !loggedIn);
  $('#logout-btn').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    $('#account-info').textContent = `${state.me.displayName}${isAdmin() ? ' · 管理员' : ''}`;
  }
  $('#refresh-btn').classList.toggle('hidden', !isAdmin());
  $('#manage-btn').classList.toggle('hidden', !isAdmin());
  $('.sidebar-footer').classList.toggle('hidden', !isAdmin());
  renderSidebarAiSettings();
  updateAgentControls();
}

function renderSidebarAiSettings() {
  const btn = $('#sidebar-ai-settings');
  if (!btn) return;
  const loggedIn = Boolean(state.me);
  const config = currentAiConfig();
  const profile = currentAiProfile();
  const ready = loggedIn && hasUsableAiConfig(config);
  btn.classList.toggle('ready', ready);
  btn.textContent = ready ? '⚿ AI 已配置' : '⚿ AI 设置';
  btn.title = loggedIn
    ? (ready ? `${profile.name} · ${config.model}` : 'AI 模型配置')
    : '登录后配置自己的 API Key';
}

function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  $$('.auth-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.authMode));
  $('#auth-title').textContent = state.authMode === 'register' ? '注册账号' : '登录';
  $('#auth-submit').textContent = state.authMode === 'register' ? '注册并登录' : '登录';
  $('#auth-name').classList.toggle('hidden', state.authMode !== 'register');
  $('#auth-password').autocomplete = state.authMode === 'register' ? 'new-password' : 'current-password';
}

function openAuth(mode = 'login') {
  setAuthMode(mode);
  $('#auth-modal').classList.remove('hidden');
  setTimeout(() => $('#auth-email').focus(), 30);
}

function closeAuth() {
  $('#auth-modal').classList.add('hidden');
}

function requireAuth(mode = 'login') {
  if (state.me) return true;
  openAuth(mode);
  return false;
}

async function submitAuth() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const displayName = $('#auth-name').value.trim();
  $('#auth-submit').disabled = true;
  try {
    const data = await api(state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    });
    state.me = data.user || null;
    closeAuth();
    await loadUserEntryStates();
    loadAiProfilesForScope();
    renderAuthState();
    renderEntryStateUi();
    renderComments();
    renderAgent();
    renderAiSettings();
    toast(state.authMode === 'register' ? '注册成功' : '已登录');
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    $('#auth-submit').disabled = false;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
  state.me = null;
  applyGuestEntryStates();
  loadAiProfilesForScope();
  renderAuthState();
  renderEntryStateUi();
  renderComments();
  renderAgent();
  renderAiSettings();
  toast('已退出登录');
}

function renderList() {
  const list = visibleEntries();
  const el = $('#entry-list');
  el.innerHTML = '';
  renderAssetActivityStrip();
  if (!list.length) {
    const text = state.view === 'assets' && state.assetFilter
      ? `还没有${ASSET_TYPE_LABELS[state.assetFilter] || ''}资产<br/>换个类型或先沉淀一篇文章`
      : state.view === 'assets'
      ? '还没有沉淀资产<br/>先翻译、重写、点评或对话一篇文章'
      : '这里空空如也<br/>试试刷新或切换视图';
    el.innerHTML = `<div class="list-empty">${text}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const src = sourceById(e.sourceId);
    const assetsHtml = assetBadgesHtml(e, { interactive: true, copyable: true });
    const assetActivity = assetActivityLabel(e);
    const card = document.createElement('div');
    card.className = 'entry-card' + (state.read.has(e.id) ? ' read' : '') + (state.activeEntry?.id === e.id ? ' active' : '');
    card.dataset.id = e.id;
    card.innerHTML = `
      <div class="unread-dot"></div>
      <div class="entry-main">
        <div class="entry-top">
          ${src ? faviconHtml(src.siteUrl, src.name, 13) : ''}
          <span class="src">${escapeHtml(src ? src.name : e.sourceId)}</span>
          <span>·</span><span>${timeAgo(e.publishedTs)}</span>
          ${state.starred.has(e.id) ? '<span class="entry-star">★</span>' : ''}
        </div>
        <div class="entry-title">${escapeHtml(e.titleZh || e.title)}</div>
        ${e.titleZh ? `<div class="entry-original">${escapeHtml(e.title)}</div>` : ''}
        ${e.summary ? `<div class="entry-summary">${escapeHtml(e.summary)}</div>` : ''}
        ${assetsHtml ? `<div class="asset-badges entry-asset-badges">${assetsHtml}</div>` : ''}
        ${assetActivity ? `<div class="entry-asset-activity">${escapeHtml(assetActivity)}</div>` : ''}
      </div>
      ${e.image ? `<img class="entry-thumb" src="${escapeHtml(e.image)}" loading="lazy" onerror="this.remove()" />` : ''}`;
    card.onclick = (event) => {
      const copy = event.target.closest('[data-asset-copy]');
      if (copy) {
        event.preventDefault();
        event.stopPropagation();
        const url = readerAssetUrl(copy.dataset.assetCopy, e);
        const label = ASSET_FOCUS_LABELS[copy.dataset.assetCopy] || '资产';
        copyText(url, `${label}链接已复制`);
        return;
      }
      const asset = event.target.closest('[data-asset]');
      if (asset) {
        event.preventDefault();
        event.stopPropagation();
        openEntry(e, { focus: asset.dataset.asset });
        return;
      }
      openEntry(e);
    };
    frag.appendChild(card);
  }
  el.appendChild(frag);
}

function updateListTitle() {
  let title = '全部';
  if (state.filterSource) title = sourceById(state.filterSource)?.name || state.filterSource;
  else if (state.filterCategory) title = CATEGORY_LABELS[state.filterCategory];
  else if (state.view === 'unread') title = '未读';
  else if (state.view === 'starred') title = '收藏';
  else if (state.view === 'assets') title = state.assetFilter ? `资产 · ${ASSET_TYPE_LABELS[state.assetFilter] || '筛选'}` : '资产';
  if (state.q) title += ` · “${state.q}”`;
  $('#list-title').textContent = title;
}

/* ---------- Reader ---------- */
function sanitize(html) {
  if (window.DOMPurify) {
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], ADD_ATTR: ['target'] });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,form,iframe,object,embed').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }));
  return doc.body.innerHTML;
}

const contentCache = new Map();

function formatAssetTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderTitle(e) {
  $('#reader-title').textContent = e.titleZh || e.title;
  $('#reader-title-zh').classList.toggle('hidden', !e.titleZh);
  $('#reader-title-zh').textContent = e.titleZh ? e.title : '';
}

function updateFetchOriginalButton(entry = state.activeEntry) {
  const btn = $('#reader-fetch-original');
  const canFetch = Boolean(entry && /^https?:\/\//i.test(entry.link || ''));
  btn.classList.toggle('hidden', !canFetch);
  btn.disabled = !canFetch || state.fetchingOriginal;
  btn.textContent = state.fetchingOriginal ? '获取中…' : '获取原文';
}

function renderOriginalContent(entry, content) {
  const fallback = entry && entry.summary ? `<p>${escapeHtml(entry.summary)}</p>` : '<p>（无内容，请打开原文）</p>';
  $('#reader-content').innerHTML = sanitize(content || fallback);
  $$('#reader-content a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  if (state.pendingAssetJump) settlePendingAssetJump(state.pendingAssetJump, { clear: false });
}

function setReaderTab(tab, { syncUrl = true, replaceUrl = true } = {}) {
  const next = normalizeReaderTab(tab);
  state.readerTab = next;
  $$('.reader-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === next));
  $('#reader-original-panel').classList.toggle('hidden', next !== 'original');
  $('#reader-translation').classList.toggle('hidden', next !== 'translation');
  $('#reader-rewrite-panel').classList.toggle('hidden', next !== 'rewrite');
  if (syncUrl) syncReaderUrl({ replace: replaceUrl });
}

function handleReaderTab(tab, { preserveFocus = false, replaceUrl = true } = {}) {
  if (!preserveFocus) state.readerFocus = null;
  setReaderTab(tab, { replaceUrl });
  if (tab !== 'translation' || state.translation) return;
  if (state.translationLoading) {
    state.pendingTranslationGenerate = true;
    return;
  }
  generateTranslation();
}

function renderTranslation(translation, { loading = false } = {}) {
  const hasContent = Boolean(translation && Array.isArray(translation.content) && translation.content.length);
  state.translation = hasContent ? translation : null;
  const list = $('#translation-list');
  const empty = $('#translation-empty');
  const emptyText = empty.querySelector('p');
  const action = $('#reader-bilingual');
  const copy = $('#translation-copy');
  list.innerHTML = '';
  copy.classList.toggle('hidden', !hasContent);
  copy.disabled = !hasContent;
  if (loading) {
    empty.classList.remove('hidden');
    if (emptyText) emptyText.textContent = '正在检查这篇文章的翻译缓存…';
    action.disabled = true;
    action.textContent = '检查中…';
    $('#translation-meta').textContent = '检查中';
    return;
  }
  if (!hasContent) {
    empty.classList.remove('hidden');
    if (emptyText) emptyText.textContent = '这篇文章还没有中文翻译。';
    action.disabled = false;
    action.textContent = '生成中文翻译';
    $('#translation-meta').textContent = '暂无';
    return;
  }
  empty.classList.add('hidden');
  action.disabled = false;
  action.textContent = translation.stale ? '更新中文翻译' : '重新生成中文翻译';
  $('#translation-meta').textContent = [translation.stale ? '原文已更新' : '', translation.createdBy, translation.model, formatAssetTime(translation.updatedAt)].filter(Boolean).join(' · ');
  list.innerHTML = translation.content.map(pair => `
    <div class="translation-pair">
      <p class="translation-source">${escapeHtml(pair.source)}</p>
      <p class="translation-target">${escapeHtml(pair.target)}</p>
    </div>`).join('');
  renderReaderAssetSummary();
  settlePendingAssetJump('translation');
}

function copyTranslationText() {
  const translation = state.translation;
  const lines = translation && Array.isArray(translation.content)
    ? translation.content.map(pair => String(pair.target || '').trim()).filter(Boolean)
    : [];
  copyText(lines.join('\n\n'), '译文已复制');
}

async function loadTranslation(entry) {
  state.translationLoading = true;
  renderTranslation(null, { loading: true });
  try {
    const data = await api(`/api/entry/${entry.id}/translation`);
    if (state.activeEntry?.id !== entry.id) return;
    renderTranslation(data.translation);
    if (data.translation && Array.isArray(data.translation.content) && data.translation.content.length) {
      updateEntryAssets(entry.id, { translation: true });
    }
  } catch {
    renderTranslation(null);
  } finally {
    state.translationLoading = false;
    if (state.pendingTranslationGenerate && state.activeEntry?.id === entry.id && state.readerTab === 'translation' && !state.translation) {
      state.pendingTranslationGenerate = false;
      generateTranslation();
    }
  }
}

function renderRewrite(rewrite) {
  state.rewrite = rewrite || null;
  const content = $('#rewrite-content');
  const empty = $('#rewrite-empty');
  const copy = $('#rewrite-copy');
  content.innerHTML = '';
  copy.classList.toggle('hidden', !rewrite || !rewrite.body);
  copy.disabled = !rewrite || !rewrite.body;
  if (!rewrite || !rewrite.body) {
    empty.classList.remove('hidden');
    $('#rewrite-meta').textContent = '暂无';
    $('#reader-rewrite').textContent = '生成乔木风格重写';
    return;
  }
  empty.classList.add('hidden');
  $('#reader-rewrite').textContent = rewrite.stale ? '更新乔木风格重写' : '重新生成乔木风格重写';
  $('#rewrite-meta').textContent = [rewrite.stale ? '原文/链接已更新' : '', rewrite.createdBy, rewrite.model, formatAssetTime(rewrite.updatedAt)].filter(Boolean).join(' · ');
  content.innerHTML = renderMarkdownLite(rewrite.body);
  renderReaderAssetSummary();
  settlePendingAssetJump('rewrite');
}

function copyRewriteText() {
  copyText(state.rewrite && state.rewrite.body, '重写已复制');
}

async function loadRewrite(entry) {
  renderRewrite(null);
  try {
    const data = await api(`/api/entry/${entry.id}/rewrite`);
    if (state.activeEntry?.id !== entry.id) return;
    renderRewrite(data.rewrite);
    if (data.rewrite && data.rewrite.body) updateEntryAssets(entry.id, { rewrite: true });
  } catch {
    renderRewrite(null);
  }
}

async function generateTranslation({ force = false } = {}) {
  const entry = state.activeEntry;
  if (!entry) return;
  const btn = $('#reader-bilingual');
  if (state.translation && !force) {
    setReaderTab('translation');
    return;
  }
  if (state.translationLoading) {
    state.pendingTranslationGenerate = true;
    setReaderTab('translation');
    return;
  }
  if (state.translationGenerating) return;
  if (!requireAuth('login')) return;
  setReaderTab('translation');
  state.translationGenerating = true;
  btn.disabled = true;
  btn.textContent = '翻译中…';
  try {
    const data = await api(`/api/entry/${entry.id}/translation`, {
      method: 'POST',
      aiConfig: translationAiConfig(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    renderTranslation(data.translation);
    if (data.translation && Array.isArray(data.translation.content) && data.translation.content.length) {
      updateEntryAssets(entry.id, { translation: true });
    }
    setReaderTab('translation');
    toast(data.cached ? '已显示缓存翻译' : '双语翻译已保存');
  } catch (err) {
    if (/API Key|未配置|Authentication|authentication|invalid_request_error|401/i.test(err.message)) {
      openAiConfigModal('translation', 'translation');
    }
    toast('翻译失败: ' + err.message, 5000);
  } finally {
    state.translationGenerating = false;
    btn.disabled = false;
    if (!state.translation) btn.textContent = '生成中文翻译';
    else btn.textContent = state.translation.stale ? '更新中文翻译' : '重新生成中文翻译';
  }
}

async function generateRewrite({ force = false } = {}) {
  const entry = state.activeEntry;
  if (!entry) return;
  const btn = $('#reader-rewrite');
  if (state.rewrite && !force) {
    setReaderTab('rewrite');
    return;
  }
  if (state.rewriteGenerating) return;
  if (!requireAuth('login')) return;
  setReaderTab('rewrite');
  state.rewriteGenerating = true;
  btn.disabled = true;
  btn.textContent = '重写中…';
  try {
    const data = await api(`/api/entry/${entry.id}/rewrite`, {
      method: 'POST',
      aiConfig: rewriteAiConfig(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    renderRewrite(data.rewrite);
    if (data.rewrite && data.rewrite.body) updateEntryAssets(entry.id, { rewrite: true });
    setReaderTab('rewrite');
    toast(data.cached ? '已显示缓存重写' : '乔木风格重写已保存');
  } catch (err) {
    if (/API Key|未配置|Authentication|authentication|invalid_request_error|401/i.test(err.message)) {
      openAiConfigModal('settings');
    }
    toast('重写失败: ' + err.message, 5000);
  } finally {
    state.rewriteGenerating = false;
    btn.disabled = false;
    if (!state.rewrite) btn.textContent = '生成乔木风格重写';
    else btn.textContent = state.rewrite.stale ? '更新乔木风格重写' : '重新生成乔木风格重写';
  }
}

async function fetchOriginalContent() {
  const entry = state.activeEntry;
  if (!entry) return;
  if (!entry.link || !/^https?:\/\//i.test(entry.link)) {
    toast('这篇文章没有可抓取的原文链接');
    return;
  }
  if (!requireAuth('login')) return;
  state.fetchingOriginal = true;
  updateFetchOriginalButton(entry);
  setReaderTab('original');
  $('#reader-content').innerHTML = '<p style="color:var(--text-2)">正在获取原文内容…</p>';
  try {
    const data = await api(`/api/entry/${entry.id}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (state.activeEntry?.id !== entry.id) return;
    const updated = { ...entry, ...(data.entry || {}) };
    state.activeEntry = updated;
    const idx = state.entries.findIndex(item => item.id === updated.id);
    if (idx >= 0) state.entries[idx] = { ...state.entries[idx], ...updated, content: undefined };
    contentCache.set(updated.id, updated.content || '');
    renderTitle(updated);
    renderOriginalContent(updated, updated.content);
    renderList();
    state.translation = null;
    state.rewrite = null;
    loadTranslation(updated);
    loadRewrite(updated);
    toast('原文已获取并保存');
  } catch (err) {
    renderOriginalContent(entry, contentCache.get(entry.id) || entry.content || '');
    toast('获取原文失败: ' + err.message, 5000);
  } finally {
    state.fetchingOriginal = false;
    updateFetchOriginalButton(state.activeEntry);
  }
}

function renderComments() {
  const list = $('#comments-list');
  const comments = state.comments || [];
  const canWrite = Boolean(state.me);
  $('#comments-count').textContent = comments.length ? `${comments.length} 条` : '暂无';
  $('#comment-form').classList.toggle('hidden', !canWrite);
  $('#comment-gate').classList.toggle('hidden', canWrite);
  if (!comments.length) {
    list.innerHTML = '<div class="comments-empty">还没有人工点评</div>';
    return;
  }
  list.innerHTML = comments.map(comment => {
    const display = commentDisplayParts(comment.body);
    return `
      <div id="comment-${escapeHtml(comment.id)}" class="comment-item${display.type ? ` comment-type-${display.type}` : ''}">
        <div class="comment-head">
          <div class="comment-head-left">
            ${display.label ? `<span class="comment-kind">${escapeHtml(display.label)}</span>` : ''}
            <div class="comment-meta">${escapeHtml(comment.author)} · ${formatAssetTime(comment.createdAt)}</div>
          </div>
          <div class="comment-actions">
            <button type="button" class="comment-action comment-link-copy" data-comment-link="${escapeHtml(comment.id)}" title="复制这条点评链接" aria-label="复制这条点评链接">#</button>
            <button type="button" class="comment-action comment-copy" data-comment-copy="${escapeHtml(comment.id)}" title="复制这条点评" aria-label="复制这条点评">⧉</button>
          </div>
        </div>
        <div class="comment-body">${renderMarkdownLite(display.body)}</div>
      </div>`;
  }).join('');
  renderReaderAssetSummary();
  highlightCommentFromRoute();
  settlePendingAssetJump('comments');
}

function commentDisplayParts(body) {
  const raw = String(body || '');
  const trimmed = raw.trimStart();
  for (const [type, prefix] of Object.entries(COMMENT_TEMPLATES)) {
    if (trimmed.startsWith(prefix)) {
      return {
        type,
        label: COMMENT_TEMPLATE_LABELS[type] || prefix.replace(/：$/, ''),
        body: trimmed.slice(prefix.length).trimStart() || trimmed,
      };
    }
  }
  return { type: '', label: '', body: raw };
}

function copyComment(commentId) {
  const comment = (state.comments || []).find(item => item.id === commentId);
  if (!comment) {
    toast('找不到这条点评');
    return;
  }
  copyText(comment.body, '点评已复制');
}

function copyCommentLink(commentId) {
  const url = commentUrl(commentId);
  if (!url) {
    toast('找不到这条点评链接');
    return;
  }
  copyText(url, '点评链接已复制');
}

function highlightCommentFromRoute() {
  const commentId = state.pendingCommentId;
  if (!commentId) return;
  const target = document.getElementById(`comment-${commentId}`);
  if (!target) return;
  state.pendingCommentId = '';
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('comment-target');
  setTimeout(() => target.classList.remove('comment-target'), 2400);
}

function autosizeCommentInput() {
  const input = $('#comment-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function insertCommentTemplate(type) {
  const prefix = COMMENT_TEMPLATES[type];
  const input = $('#comment-input');
  if (!prefix || !input) return;
  const value = input.value;
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before && !before.endsWith('\n') ? '\n' : '';
  const insert = `${leading}${prefix}${selected ? selected : ' '}`;
  input.value = `${before}${insert}${after}`;
  const nextCursor = before.length + insert.length;
  input.focus();
  input.setSelectionRange(nextCursor, nextCursor);
  autosizeCommentInput();
}

async function loadComments(entry) {
  state.comments = [];
  renderComments();
  try {
    const data = await api(`/api/entry/${entry.id}/comments`);
    if (state.activeEntry?.id !== entry.id) return;
    state.comments = data.comments || [];
    updateEntryAssets(entry.id, { comments: state.comments.length });
    renderComments();
  } catch {
    renderComments();
  }
}

async function submitComment() {
  const entry = state.activeEntry;
  const body = $('#comment-input').value.trim();
  if (!entry || !body) return;
  if (!requireAuth('login')) return;
  $('#comment-send').disabled = true;
  try {
    const data = await api(`/api/entry/${entry.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    state.comments = data.comments || [];
    $('#comment-input').value = '';
    autosizeCommentInput();
    updateEntryAssets(entry.id, { comments: state.comments.length });
    renderComments();
    toast('点评已发布');
  } catch (err) {
    toast('点评失败: ' + err.message, 5000);
  } finally {
    $('#comment-send').disabled = false;
  }
}

function renderAgentMessages(extraPending = false) {
  const el = $('#agent-messages');
  const thread = state.agentMessages || [];
  const hadPendingChatMessage = Boolean(state.pendingChatMessageId);
  el.innerHTML = '';
  if (!state.activeEntry) {
    el.innerHTML = '<div class="agent-empty">未选择文章</div>';
    return;
  }
  if (!thread.length && !extraPending) {
    el.innerHTML = '<div class="agent-empty">当前对话为空</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  const messages = extraPending ? [...thread, { role: 'assistant', content: '思考中…', pending: true }] : thread;
  for (const message of messages) {
    const row = document.createElement('div');
    row.className = `agent-msg ${message.role}${message.pending ? ' pending' : ''}`;
    if (message.id) row.id = `chat-${message.id}`;
    const head = document.createElement('div');
    head.className = 'agent-msg-head';
    const role = document.createElement('div');
    role.className = 'agent-msg-role';
    role.textContent = agentMessageMeta(message);
    role.title = role.textContent;
    head.appendChild(role);
    if (!message.pending) {
      const actions = document.createElement('div');
      actions.className = 'agent-msg-actions';
      if (message.id) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'agent-msg-action agent-msg-link';
        link.title = '复制这条对话链接';
        link.textContent = '#';
        link.onclick = () => copyAgentMessageLink(message.id);
        actions.appendChild(link);
      }
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'agent-msg-action agent-msg-copy';
      copy.title = '复制这条消息';
      copy.textContent = '⧉';
      copy.onclick = () => copyText(message.content, '消息已复制');
      actions.appendChild(copy);
      head.appendChild(actions);
    }
    const body = document.createElement('div');
    body.className = 'agent-msg-body';
    body.innerHTML = renderMarkdownLite(message.content);
    row.appendChild(head);
    row.appendChild(body);
    frag.appendChild(row);
  }
  el.appendChild(frag);
  if (hadPendingChatMessage) {
    if (highlightAgentMessageFromRoute()) state.pendingAssetJump = null;
  } else {
    el.scrollTop = el.scrollHeight;
  }
  renderReaderAssetSummary();
  settlePendingAssetJump('chat');
}

function agentMessageMeta(message) {
  const author = message.author || (message.role === 'user' ? '读者' : 'AI');
  const parts = [author];
  if (message.role === 'assistant' && message.model) parts.push(message.model);
  const time = formatAssetTime(message.createdAt);
  if (time) parts.push(time);
  return parts.join(' · ');
}

function copyAgentMessageLink(messageId) {
  const url = chatMessageUrl(messageId);
  if (!url) {
    toast('找不到这条对话链接');
    return;
  }
  copyText(url, '对话链接已复制');
}

function highlightAgentMessageFromRoute() {
  const messageId = state.pendingChatMessageId;
  if (!messageId) return false;
  const target = document.getElementById(`chat-${messageId}`);
  if (!target) return false;
  state.pendingChatMessageId = '';
  setAgentCollapsed(false);
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('agent-msg-target');
  setTimeout(() => target.classList.remove('agent-msg-target'), 2400);
  return true;
}

function copyAgentThread() {
  const messages = (state.agentMessages || []).filter(message => message && message.content);
  if (!messages.length) {
    toast('当前文章还没有对话');
    return;
  }
  const text = messages.map(message => {
    const role = message.role === 'user' ? (message.author || '读者') : (message.author || 'AI');
    return `${role}:\n${message.content}`;
  }).join('\n\n---\n\n');
  copyText(text, '当前对话已复制');
}

function updateAgentControls() {
  const hasEntry = Boolean(state.activeEntry);
  const hasUser = Boolean(state.me);
  const hasKey = hasUsableAiConfig();
  const input = $('#agent-input');
  const send = $('#agent-send');
  if (!hasEntry) input.placeholder = '问当前文章…';
  else if (!hasUser) input.placeholder = '登录后围绕当前文章对话';
  else if (!hasKey) input.placeholder = '填写 API Key 后提问';
  else input.placeholder = '问当前文章…';
  input.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy;
  send.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy || !input.value.trim();
  $$('.agent-prompt').forEach(btn => { btn.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy; });
  $('#agent-copy-thread').disabled = !hasEntry || !(state.agentMessages || []).length;
  renderAiStatus();
}

function renderAgent() {
  if (!state.activeEntry) {
    $('#agent-title').textContent = '未选择文章';
    $('#agent-input').value = '';
  } else {
    $('#agent-title').textContent = state.activeEntry.titleZh || state.activeEntry.title || '无标题';
  }
  renderAgentMessages();
  updateAgentControls();
}

async function loadAgentMessages(entry) {
  state.agentMessages = [];
  renderAgent();
  try {
    const data = await api(`/api/entry/${entry.id}/chat`);
    if (state.activeEntry?.id !== entry.id) return;
    state.agentMessages = data.messages || [];
    updateEntryAssets(entry.id, { chatMessages: state.agentMessages.length });
    renderAgent();
  } catch {
    renderAgent();
  }
}

async function sendAgentMessage(text) {
  const entry = state.activeEntry;
  const content = String(text || '').trim();
  if (!entry || !content || state.agentBusy) return;
  if (!requireAuth('login')) return;
  if (!hasUsableAiConfig()) {
    openAiConfigModal('agent', 'agent', content);
    toast('请先保存一个可用的 AI 配置');
    return;
  }

  state.agentMessages.push({ role: 'user', author: state.me.displayName, content, createdAt: Date.now() });
  $('#agent-input').value = '';
  state.agentBusy = true;
  renderAgentMessages(true);
  updateAgentControls();

  try {
    const data = await api(`/api/entry/${entry.id}/chat`, {
      method: 'POST',
      ai: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    if (state.activeEntry?.id === entry.id) {
      state.agentMessages = [...state.agentMessages.filter(m => !m.pending), data.assistantMessage || { role: 'assistant', author: 'DeepSeek', content: data.answer }];
      await loadAgentMessages(entry);
    }
  } catch (err) {
    state.agentMessages.push({ role: 'assistant', author: '系统', content: `对话失败：${err.message}` });
    if (state.activeEntry?.id === entry.id) renderAgentMessages();
  } finally {
    state.agentBusy = false;
    updateAgentControls();
  }
}

async function openEntry(e, { tab = 'original', focus = null, commentId = '', chatMessageId = '', updateUrl = true, replaceUrl = false } = {}) {
  state.activeEntry = e;
  const requestedFocus = ASSET_FILTER_TYPES.includes(focus) ? focus : null;
  const requestedTab = requestedFocus === 'translation'
    ? 'translation'
    : requestedFocus === 'rewrite'
      ? 'rewrite'
      : normalizeReaderTab(tab);
  const wasRead = state.read.has(e.id);
  state.read.add(e.id);
  if (!wasRead) syncEntryState(e.id, { read: true });
  persist();

  const src = sourceById(e.sourceId);
  $('#reader-empty').classList.add('hidden');
  $('#reader').classList.remove('hidden');
  $('#reader-source').innerHTML = `${src ? faviconHtml(src.siteUrl, src.name, 14) : ''}<span>${escapeHtml(src ? src.name : '')}</span>`;
  renderTitle(e);
  document.title = readerRouteTitle(e, requestedFocus);
  const date = e.published ? new Date(e.published).toLocaleString('zh-CN') : '';
  $('#reader-meta').textContent = [e.author, date].filter(Boolean).join(' · ');
  $('#reader-open').href = e.link || '#';
  const starBtn = $('#reader-star');
  starBtn.classList.toggle('starred', state.starred.has(e.id));
  starBtn.textContent = state.starred.has(e.id) ? '★ 已收藏' : '★ 收藏';
  $('#comment-input').value = '';
  state.translation = null;
  state.translationLoading = false;
  state.translationGenerating = false;
  state.pendingTranslationGenerate = false;
  state.rewrite = null;
  state.rewriteGenerating = false;
  state.readerFocus = requestedFocus;
  state.pendingAssetJump = requestedFocus;
  state.pendingCommentId = commentId || '';
  state.pendingChatMessageId = chatMessageId || '';
  if (requestedFocus === 'chat') setAgentCollapsed(false);
  state.fetchingOriginal = false;
  renderReaderAssets(e);
  renderReaderAssetSummary(e);
  updateFetchOriginalButton(e);
  setReaderTab(requestedTab, { syncUrl: false });
  loadTranslation(e);
  loadRewrite(e);
  loadComments(e);
  loadAgentMessages(e);
  if (updateUrl) syncReaderUrl({ replace: replaceUrl, commentId, chatMessageId });

  $('#reader-audio').innerHTML = e.audio ? `<audio controls preload="none" src="${escapeHtml(e.audio.url)}"></audio>` : '';
  $('#reader-pane').scrollTop = 0;
  document.getElementById('app').classList.add('reading');
  renderAgent();

  renderEntryStateUi();

  // content is loaded lazily — the list API omits it to stay lightweight
  let content = e.content || contentCache.get(e.id);
  if (!content) {
    $('#reader-content').innerHTML = '<p style="color:var(--text-2)">加载内容中…</p>';
    try {
      const data = await api(`/api/entry/${e.id}`);
      content = data.entry.content;
      contentCache.set(e.id, content || '');
    } catch { /* fall through to summary */ }
    if (state.activeEntry?.id !== e.id) return; // user moved on
  }
  renderOriginalContent(e, content);
}

function closeReaderFromRoute() {
  state.activeEntry = null;
  state.agentMessages = [];
  state.comments = [];
  state.translation = null;
  state.translationLoading = false;
  state.translationGenerating = false;
  state.pendingTranslationGenerate = false;
  state.rewrite = null;
  state.rewriteGenerating = false;
  state.readerFocus = null;
  state.pendingAssetJump = null;
  state.pendingCommentId = '';
  state.pendingChatMessageId = '';
  state.fetchingOriginal = false;
  state.readerTab = 'original';
  $('#reader').classList.add('hidden');
  $('#reader-empty').classList.remove('hidden');
  document.getElementById('app').classList.remove('reading');
  document.title = 'QMReader · RSS 阅读器';
  renderList();
  renderAgent();
}

async function openEntryById(entryId, { tab = 'original', focus = null, commentId = '', chatMessageId = '', updateUrl = false, replaceUrl = true } = {}) {
  const id = String(entryId || '').trim();
  if (!id) return false;
  let entry = state.entries.find(item => item.id === id);
  if (!entry) {
    const data = await api(`/api/entry/${encodeURIComponent(id)}`);
    entry = data.entry;
  }
  if (!entry) return false;
  await openEntry(entry, { tab, focus, commentId, chatMessageId, updateUrl, replaceUrl });
  return true;
}

async function openEntryFromUrl() {
  const route = routeStateFromUrl();
  if (!route.entryId) {
    if (route.view === 'assets') {
      state.view = 'assets';
      state.filterSource = null;
      state.filterCategory = null;
      state.assetFilter = route.assetFilter;
    } else {
      state.view = 'all';
      state.filterSource = null;
      state.filterCategory = null;
      state.assetFilter = null;
    }
    updateListTitle();
    renderSidebar();
    closeReaderFromRoute();
    if (route.view === 'assets') document.title = listRouteTitle();
    return false;
  }
  try {
    return await openEntryById(route.entryId, { tab: route.tab, focus: route.focus, commentId: route.commentId, chatMessageId: route.chatMessageId, updateUrl: false });
  } catch (err) {
    toast('找不到这篇文章: ' + err.message, 4000);
    closeReaderFromRoute();
    clearReaderUrl({ replace: true });
    return false;
  }
}

/* ---------- Navigation ---------- */
async function reload({ keepReader = false, clearUrl = true } = {}) {
  await loadEntries();
  updateListTitle();
  renderList();
  renderSidebar();
  if (!keepReader) {
    state.activeEntry = null;
    state.agentMessages = [];
    state.comments = [];
    state.translation = null;
    state.translationLoading = false;
    state.translationGenerating = false;
    state.pendingTranslationGenerate = false;
    state.rewrite = null;
    state.rewriteGenerating = false;
    state.readerFocus = null;
    state.pendingAssetJump = null;
    state.fetchingOriginal = false;
    state.readerTab = 'original';
    $('#reader').classList.add('hidden');
    $('#reader-empty').classList.remove('hidden');
    document.getElementById('app').classList.remove('reading');
    if (clearUrl) clearReaderUrl({ replace: true });
    renderAgent();
  }
}

function selectSource(id) {
  state.filterSource = state.filterSource === id ? null : id;
  state.filterCategory = null;
  state.assetFilter = null;
  state.readerFocus = null;
  reload();
}
function selectCategory(cat) {
  state.filterCategory = state.filterCategory === cat ? null : cat;
  state.filterSource = null;
  state.assetFilter = null;
  state.readerFocus = null;
  reload();
}
function selectView(v) {
  state.view = v;
  state.filterSource = null;
  state.filterCategory = null;
  state.assetFilter = null;
  state.readerFocus = null;
  if (v === 'assets') {
    syncListUrl();
    reload({ clearUrl: false });
    return;
  }
  reload();
}

function selectAssetFilter(type = null) {
  state.view = 'assets';
  state.filterSource = null;
  state.filterCategory = null;
  state.assetFilter = type && ASSET_FILTERS[type] ? type : null;
  state.readerFocus = null;
  syncListUrl();
  reload({ clearUrl: false });
}

/* ---------- Refresh ---------- */
async function refreshAll() {
  if (!isAdmin()) {
    toast('需要管理员权限');
    return;
  }
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.textContent = '↻ 刷新中…';
  try {
    await api('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // poll until done
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const data = await loadSources();
      btn.textContent = data.refreshing ? `↻ ${data.progress.done}/${data.progress.total}` : '↻ 刷新全部';
      if (!data.refreshing) break;
    }
    await reload({ keepReader: true });
    toast('刷新完成');
  } catch (e) {
    toast('刷新失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ 刷新全部';
  }
}

/* ---------- Manage modal ---------- */
function renderManage() {
  const el = $('#manage-list');
  el.innerHTML = '';
  const sorted = [...state.sources].sort((a, b) => (b.enabled - a.enabled) || a.category.localeCompare(b.category));
  for (const s of sorted) {
    const row = document.createElement('div');
    row.className = 'manage-row';
    const statusTxt = s.enabled
      ? (s.status === 'ok' ? `${s.entryCount} 篇` : s.status === 'error' ? '抓取失败' : s.status === 'stale' ? '缓存' : '待抓取')
      : '已禁用';
    row.innerHTML = `
      ${faviconHtml(s.siteUrl, s.name)}
      <div class="m-info">
        <div class="m-name">${escapeHtml(s.name)} <span style="font-weight:400;color:var(--text-2);font-size:11px">${CATEGORY_LABELS[s.category]}</span></div>
        ${s.note || s.description ? `<div class="m-note">${escapeHtml(s.note || s.description)}</div>` : ''}
      </div>
      <span class="m-status ${s.status === 'error' ? 'error' : s.status === 'ok' ? 'ok' : ''}">${statusTxt}</span>
      <button class="switch ${s.enabled ? 'on' : ''}" title="${s.enabled ? '点击禁用' : '点击启用'}"></button>`;
    row.querySelector('.switch').onclick = async (ev) => {
      ev.stopPropagation();
      const r = await api(`/api/sources/${s.id}/toggle`, { method: 'POST' });
      s.enabled = r.enabled;
      toast(`${s.name} ${r.enabled ? '已启用（抓取中…）' : '已禁用'}`);
      renderManage();
      setTimeout(async () => { await loadSources(); reload({ keepReader: true }); }, r.enabled ? 4000 : 0);
    };
    el.appendChild(row);
  }
}

function getEditingAiProfile() {
  return state.aiProfiles.find(profile => profile.id === state.editingAiProfileId)
    || currentAiProfile();
}

function renderAiStatus() {
  const el = $('#agent-profile');
  renderSidebarAiSettings();
  if (!el) return;
  if (!state.me) {
    el.textContent = '登录后配置模型';
    return;
  }
  const profile = currentAiProfile();
  const config = currentAiConfig();
  el.textContent = hasUsableAiConfig(config)
    ? `${profile.name} · ${config.model}`
    : `${profile.name || 'AI 配置'} · 未填 API Key`;
}

function aiAlertText() {
  if (state.aiConfigReason === 'translation') return '生成双语对照翻译需要先保存一个可用的 AI 配置。';
  if (state.aiConfigReason === 'agent') return '文章对话需要先保存一个可用的 AI 配置，当前问题会保留。';
  return '';
}

function renderAiProfileList() {
  const list = $('#ai-profile-list');
  if (!list) return;
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const profile of state.aiProfiles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-profile-item' + (profile.id === state.editingAiProfileId ? ' active' : '');
    btn.innerHTML = `
      <span class="ai-profile-name">${escapeHtml(profile.name)}</span>
      <span class="ai-profile-meta">${escapeHtml(profile.providerName || profile.provider)} · ${escapeHtml(profile.model || '未填模型')}</span>
      <span class="ai-profile-key">${profile.apiKey ? escapeHtml(maskApiKey(profile.apiKey)) : '未填 API Key'}${profile.isDefault ? ' · 默认' : ''}</span>`;
    btn.onclick = () => {
      state.editingAiProfileId = profile.id;
      state.activeAiProfileId = profile.id;
      persistAiProfiles();
      renderAiSettings();
      updateAgentControls();
    };
    frag.appendChild(btn);
  }
  list.appendChild(frag);
}

function renderTemplateList() {
  const el = $('#ai-template-list');
  if (!el) return;
  const parts = [];
  for (const category of AI_PROVIDER_CATEGORIES) {
    const presets = AI_PROVIDER_PRESETS.filter(preset => preset.category === category);
    if (!presets.length) continue;
    parts.push(`<div class="ai-template-group"><div class="ai-template-category">${escapeHtml(category)}</div><div class="ai-template-buttons">`);
    for (const preset of presets) {
      parts.push(`<button type="button" class="ai-template" data-preset="${escapeHtml(preset.id)}" title="${escapeHtml(preset.description)}">
        <span>${escapeHtml(preset.name)}${preset.recommended ? ' · 推荐' : ''}</span>
      </button>`);
    }
    parts.push('</div></div>');
  }
  parts.push(`<div class="ai-template-group"><div class="ai-template-category">自定义</div><div class="ai-template-buttons"><button type="button" class="ai-template" data-preset="custom"><span>OpenAI 兼容</span></button></div></div>`);
  el.innerHTML = parts.join('');
}

function quickModelsForProfile(profile) {
  const preset = AI_PROVIDER_MAP[profile.provider];
  const models = preset && Array.isArray(preset.quickModels) ? preset.quickModels : [];
  return [...new Set([profile.model, ...models].filter(Boolean))];
}

function renderQuickModels(models) {
  const el = $('#ai-quick-models');
  if (!el) return;
  el.innerHTML = models.slice(0, 18).map(model => (
    `<button type="button" class="ai-model-chip" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`
  )).join('');
}

function fillAiProfileForm(profile) {
  $('#ai-profile-name').value = profile.name || '';
  $('#ai-provider-id').value = profile.provider || 'custom';
  $('#ai-provider-name').value = profile.providerName || profile.provider || '';
  $('#ai-provider-category').value = profile.providerCategory || '';
  $('#ai-provider-type').value = profile.providerType || 'openai_compatible';
  $('#ai-api-key-url').value = profile.apiKeyUrl || '';
  $('#ai-api-key').value = profile.apiKey || '';
  $('#ai-base-url').value = profile.baseUrl || '';
  $('#ai-model').value = profile.model || '';
  $('#ai-temperature').value = String(clampTemperature(profile.temperature));
  $('#ai-max-tokens').value = String(clampMaxTokens(profile.maxTokens));
  $('#ai-default-profile').checked = Boolean(profile.isDefault);
  const keyLink = $('#ai-key-link');
  keyLink.href = profile.apiKeyUrl || '#';
  keyLink.classList.toggle('hidden', !profile.apiKeyUrl);
  $('#ai-config-note').textContent = profile.apiKey
    ? `当前 API Key：${maskApiKey(profile.apiKey)}`
    : 'API Key 只保存在当前浏览器，不写入服务器数据库。';
  renderQuickModels(quickModelsForProfile(profile));
}

function renderAiSettings() {
  if (!state.aiProfiles.length) loadAiProfilesForScope();
  if (!state.editingAiProfileId) state.editingAiProfileId = currentAiProfile().id;
  renderAiStatus();
  renderAiProfileList();
  renderTemplateList();
  const profile = getEditingAiProfile();
  if (profile) fillAiProfileForm(profile);
  const alert = $('#ai-config-alert');
  const text = aiAlertText();
  if (alert) {
    alert.textContent = text;
    alert.classList.toggle('hidden', !text);
  }
  $('#ai-delete-profile').disabled = state.aiProfiles.length <= 1;
  updateAgentControls();
}

function readAiProfileForm() {
  const current = getEditingAiProfile() || createCustomProfile();
  return normalizeProfile({
    ...current,
    name: $('#ai-profile-name').value.trim(),
    provider: $('#ai-provider-id').value.trim() || 'custom',
    providerName: $('#ai-provider-name').value.trim() || $('#ai-provider-id').value.trim() || '自定义',
    providerType: $('#ai-provider-type').value.trim() || 'openai_compatible',
    providerCategory: $('#ai-provider-category').value.trim(),
    apiKeyUrl: $('#ai-api-key-url').value.trim(),
    baseUrl: normalizeBaseUrl($('#ai-base-url').value),
    model: $('#ai-model').value.trim(),
    temperature: clampTemperature($('#ai-temperature').value),
    maxTokens: clampMaxTokens($('#ai-max-tokens').value),
    apiKey: $('#ai-api-key').value.trim(),
    isDefault: $('#ai-default-profile').checked,
    updatedAt: Date.now(),
  });
}

function configFromProfile(profile) {
  return {
    profileId: profile.id,
    profileName: profile.name,
    provider: profile.provider,
    providerName: profile.providerName,
    providerType: profile.providerType,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    temperature: clampTemperature(profile.temperature),
    maxTokens: clampMaxTokens(profile.maxTokens),
  };
}

function applyAiPreset(presetId) {
  const current = getEditingAiProfile() || createCustomProfile();
  const profile = presetId === 'custom'
    ? createCustomProfile({ id: current.id, apiKey: current.apiKey, isDefault: current.isDefault })
    : createProfileFromPreset(presetId, { id: current.id, apiKey: current.apiKey, isDefault: current.isDefault });
  fillAiProfileForm(profile);
  $('#ai-config-note').textContent = presetId === 'custom'
    ? '自定义服务需要兼容 OpenAI Chat Completions 协议。'
    : (AI_PROVIDER_MAP[presetId]?.description || '');
}

function runPendingAiAction() {
  const action = state.pendingAiAction;
  const text = state.pendingAgentText;
  state.pendingAiAction = '';
  state.pendingAgentText = '';
  if (action === 'translation') setTimeout(() => generateTranslation(), 0);
  if (action === 'agent' && text) setTimeout(() => sendAgentMessage(text), 0);
}

function saveAiProfileFromForm({ silent = false } = {}) {
  const profile = readAiProfileForm();
  if (!profile.name || !profile.baseUrl || !profile.model) {
    toast('请填写配置名称、Base URL 和模型');
    return null;
  }

  const exists = state.aiProfiles.some(item => item.id === profile.id);
  let nextProfiles = exists
    ? state.aiProfiles.map(item => (item.id === profile.id ? profile : item))
    : [...state.aiProfiles, profile];
  if (profile.isDefault || !nextProfiles.some(item => item.isDefault)) {
    nextProfiles = nextProfiles.map(item => ({ ...item, isDefault: item.id === profile.id }));
  }
  state.aiProfiles = ensureSingleDefault(nextProfiles);
  state.activeAiProfileId = profile.id;
  state.editingAiProfileId = profile.id;
  persistAiProfiles();
  renderAiSettings();
  if (!silent) toast('AI 配置已保存');
  if (hasUsableAiConfig(currentAiConfig()) && state.pendingAiAction) {
    closeAiConfigModal();
    runPendingAiAction();
  }
  return profile;
}

function addAiProfile() {
  const profile = createProfileFromPreset(DEFAULT_AI_PRESET_ID, {
    name: `DeepSeek ${state.aiProfiles.length + 1}`,
    isDefault: state.aiProfiles.length === 0,
  });
  state.aiProfiles = ensureSingleDefault([...state.aiProfiles, profile]);
  state.activeAiProfileId = profile.id;
  state.editingAiProfileId = profile.id;
  persistAiProfiles();
  renderAiSettings();
}

function deleteAiProfile() {
  const profile = getEditingAiProfile();
  if (!profile || state.aiProfiles.length <= 1) return;
  if (!window.confirm(`确定删除「${profile.name}」吗？`)) return;
  state.aiProfiles = ensureSingleDefault(state.aiProfiles.filter(item => item.id !== profile.id));
  state.activeAiProfileId = (state.aiProfiles.find(item => item.isDefault) || state.aiProfiles[0]).id;
  state.editingAiProfileId = state.activeAiProfileId;
  persistAiProfiles();
  renderAiSettings();
  toast('AI 配置已删除');
}

function openAiConfigModal(reason = '', pendingAction = '', pendingText = '') {
  if (!requireAuth('login')) {
    toast('登录后可以配置自己的 API Key');
    return false;
  }
  state.aiConfigReason = reason;
  state.pendingAiAction = pendingAction || '';
  state.pendingAgentText = pendingText || '';
  renderAiSettings();
  $('#ai-config-modal').classList.remove('hidden');
  const config = currentAiConfig();
  setTimeout(() => {
    const target = hasUsableAiConfig(config) ? $('#ai-model') : $('#ai-api-key');
    if (target) target.focus();
  }, 30);
  return true;
}

function closeAiConfigModal() {
  $('#ai-config-modal').classList.add('hidden');
  state.aiConfigReason = '';
  renderAiSettings();
}

async function fetchAiModels() {
  if (!requireAuth('login')) return;
  const profile = readAiProfileForm();
  const config = configFromProfile(profile);
  if (!config.apiKey || !config.baseUrl) {
    toast('请先填写 API Key 和 Base URL');
    return;
  }
  const btn = $('#ai-fetch-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  $('#ai-config-note').textContent = '正在读取模型列表…';
  try {
    const data = await api('/api/ai/models', {
      method: 'POST',
      aiConfig: config,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const models = data.models || [];
    if (!models.length) {
      $('#ai-config-note').textContent = '连接成功，但接口没有返回模型列表。';
      return;
    }
    renderQuickModels(models);
    if (!$('#ai-model').value.trim()) $('#ai-model').value = models[0];
    $('#ai-config-note').textContent = `已获取 ${models.length} 个模型，点击下方模型可填入。`;
  } catch (err) {
    $('#ai-config-note').textContent = err.message;
    toast('获取模型失败: ' + err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '获取模型';
  }
}

async function testAiConnection() {
  if (!requireAuth('login')) return;
  const profile = readAiProfileForm();
  const config = configFromProfile(profile);
  if (!hasUsableAiConfig(config)) {
    toast('请先填写 API Key、Base URL 和模型');
    return;
  }
  const btn = $('#ai-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  $('#ai-config-note').textContent = '正在测试模型连接…';
  try {
    const data = await api('/api/ai/test', {
      method: 'POST',
      aiConfig: config,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    $('#ai-config-note').textContent = `连接成功：${data.model || config.model} · ${data.latencyMs || data.latency_ms || '-'}ms`;
    toast('连接成功');
  } catch (err) {
    $('#ai-config-note').textContent = err.message;
    toast('连接测试失败: ' + err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

function setAgentCollapsed(collapsed) {
  state.agentCollapsed = collapsed;
  storage.setItem('qm_agent_collapsed', collapsed ? '1' : '0');
  $('#app').classList.toggle('agent-collapsed', collapsed);
  $('#agent-open').classList.toggle('hidden', !collapsed);
}

/* ---------- Events ---------- */
$$('.view-btn').forEach(b => b.onclick = () => selectView(b.dataset.view));
$('#asset-dashboard-open').onclick = () => selectAssetFilter(null);
$('#asset-dashboard').onclick = (e) => {
  const btn = e.target.closest('[data-asset-filter]');
  if (!btn || btn.disabled) return;
  selectAssetFilter(btn.dataset.assetFilter);
};
$('#asset-activity-strip').onclick = async (e) => {
  const all = e.target.closest('[data-asset-open-all]');
  if (all) {
    selectAssetFilter(null);
    return;
  }
  const btn = e.target.closest('[data-asset-entry]');
  if (!btn) return;
  const entry = state.entries.find(item => item.id === btn.dataset.assetEntry);
  if (!entry) return;
  await openEntry(entry, { focus: btn.dataset.assetFocus });
};
$('#refresh-btn').onclick = refreshAll;
$('#mark-read-btn').onclick = async () => {
  const ids = visibleEntries().map(e => e.id);
  ids.forEach(id => state.read.add(id));
  persist();
  renderEntryStateUi();
  if (state.me && ids.length) {
    try {
      await api('/api/me/entry-states/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: ids }),
      });
    } catch (err) {
      toast('同步已读失败: ' + err.message, 4000);
      return;
    }
  }
  toast('已全部标为已读');
};
$('#reader-star').onclick = () => {
  const e = state.activeEntry;
  if (!e) return;
  const nextStarred = !state.starred.has(e.id);
  nextStarred ? state.starred.add(e.id) : state.starred.delete(e.id);
  persist();
  renderEntryStateUi();
  syncEntryState(e.id, { starred: nextStarred });
};
$('#reader-fetch-original').onclick = fetchOriginalContent;
$('#reader-copy-link').onclick = () => {
  copyReaderLink();
};
$('#reader-assets').onclick = (e) => {
  const btn = e.target.closest('[data-asset]');
  if (!btn) return;
  jumpToArticleAsset(btn.dataset.asset);
};
$('#reader-asset-summary').onclick = (e) => {
  const copy = e.target.closest('[data-asset-copy]');
  if (copy) {
    copyArticleAssetLink(copy.dataset.assetCopy);
    return;
  }
  const btn = e.target.closest('[data-asset-summary]');
  if (!btn) return;
  jumpToArticleAsset(btn.dataset.assetSummary);
};
$('#reader-bilingual').onclick = () => generateTranslation({ force: Boolean(state.translation) });
$('#reader-rewrite').onclick = () => generateRewrite({ force: Boolean(state.rewrite) });
$('#translation-copy').onclick = copyTranslationText;
$('#rewrite-copy').onclick = copyRewriteText;
$$('.reader-tab').forEach(btn => {
  btn.onclick = () => handleReaderTab(btn.dataset.tab);
});
$('#comment-form').onsubmit = (e) => {
  e.preventDefault();
  submitComment();
};
$('#comment-tools').onclick = (e) => {
  const btn = e.target.closest('[data-comment-template]');
  if (!btn) return;
  insertCommentTemplate(btn.dataset.commentTemplate);
};
$('#comment-input').oninput = autosizeCommentInput;
$('#comment-input').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitComment();
  }
};
$('#comments-list').onclick = (e) => {
  const link = e.target.closest('[data-comment-link]');
  if (link) {
    copyCommentLink(link.dataset.commentLink);
    return;
  }
  const btn = e.target.closest('[data-comment-copy]');
  if (!btn) return;
  copyComment(btn.dataset.commentCopy);
};
$('#comment-login').onclick = () => openAuth('login');
$('#agent-form').onsubmit = (e) => {
  e.preventDefault();
  sendAgentMessage($('#agent-input').value);
};
$('#agent-input').oninput = (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 130)}px`;
  updateAgentControls();
};
$('#agent-input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAgentMessage(e.currentTarget.value);
  }
};
$('#agent-close').onclick = () => setAgentCollapsed(true);
$('#agent-open').onclick = () => setAgentCollapsed(false);
$('#agent-copy-thread').onclick = copyAgentThread;
$('#agent-settings').onclick = () => openAiConfigModal('settings');
$('#sidebar-ai-settings').onclick = () => openAiConfigModal('settings');
$('#ai-config-close').onclick = closeAiConfigModal;
$('#ai-config-modal').onclick = (e) => { if (e.target.id === 'ai-config-modal') closeAiConfigModal(); };
$('#ai-add-profile').onclick = addAiProfile;
$('#ai-delete-profile').onclick = deleteAiProfile;
$('#ai-profile-form').onsubmit = (e) => {
  e.preventDefault();
  saveAiProfileFromForm();
};
$('#ai-template-list').onclick = (e) => {
  const btn = e.target.closest('.ai-template');
  if (btn) applyAiPreset(btn.dataset.preset);
};
$('#ai-quick-models').onclick = (e) => {
  const btn = e.target.closest('.ai-model-chip');
  if (!btn) return;
  $('#ai-model').value = btn.dataset.model || btn.textContent.trim();
};
$('#ai-max-tokens').oninput = (e) => { e.target.value = e.target.value.replace(/[^\d]/g, ''); };
$('#ai-fetch-models').onclick = fetchAiModels;
$('#ai-test').onclick = testAiConnection;
$$('.agent-prompt').forEach(btn => {
  btn.onclick = () => sendAgentMessage(btn.dataset.prompt || btn.textContent);
});
$('#manage-btn').onclick = () => { renderManage(); $('#manage-modal').classList.remove('hidden'); };
$('#manage-close').onclick = () => $('#manage-modal').classList.add('hidden');
$('#manage-modal').onclick = (e) => { if (e.target.id === 'manage-modal') $('#manage-modal').classList.add('hidden'); };
$('#auth-open').onclick = () => openAuth('login');
$('#logout-btn').onclick = logout;
$('#auth-close').onclick = closeAuth;
$('#auth-modal').onclick = (e) => { if (e.target.id === 'auth-modal') closeAuth(); };
$$('.auth-tab').forEach(btn => { btn.onclick = () => setAuthMode(btn.dataset.mode); });
$('#auth-form').onsubmit = (e) => {
  e.preventDefault();
  submitAuth();
};

let searchTimer = null;
$('#search').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); reload(); }, 350);
};

$('#theme-toggle').onclick = () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  storage.setItem('fr_theme', next);
};

window.addEventListener('error', (e) => {
  const list = $('#entry-list');
  if (list && !list.querySelector('.entry-card')) {
    list.innerHTML = `<div class="list-empty">页面脚本出错：${escapeHtml(e.message)}<br/>请刷新重试</div>`;
  }
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const list = visibleEntries();
  const idx = list.findIndex(x => x.id === state.activeEntry?.id);
  if (e.key === 'j' && idx < list.length - 1) openEntry(list[idx + 1]);
  if (e.key === 'k' && idx > 0) openEntry(list[idx - 1]);
  if (e.key === 'Escape') {
    document.getElementById('app').classList.remove('reading');
    $('#manage-modal').classList.add('hidden');
    $('#ai-config-modal').classList.add('hidden');
  }
});

window.addEventListener('popstate', () => {
  openEntryFromUrl();
});

/* ---------- Init ---------- */
(async function init() {
  document.body.dataset.theme = storage.getItem('fr_theme') || 'light';
  loadAiProfilesForScope();
  renderAiSettings();
  renderAuthState();
  setAgentCollapsed(state.agentCollapsed);
  $('#entry-list').innerHTML = '<div class="list-empty">正在加载订阅内容…</div>';
  try {
    await loadMe();
    const data = await loadSources();
    await reload({ clearUrl: false });
    renderAgent();
    // first boot: server may still be fetching — poll a few times
    if (data.refreshing || state.entries.length === 0) {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const d = await loadSources();
        await loadEntries();
        renderList(); renderSidebar(); updateListTitle();
        if (!d.refreshing && state.entries.length) break;
      }
    }
    await openEntryFromUrl();
  } catch (e) {
    toast('加载失败: ' + e.message, 5000);
    $('#entry-list').innerHTML = `<div class="list-empty">数据加载失败：${escapeHtml(e.message)}<br/><button class="ghost-btn" onclick="location.reload()" style="margin-top:10px">重新加载</button></div>`;
  }
})();
