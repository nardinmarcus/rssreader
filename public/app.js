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

function readStoredNumber(key) {
  const n = parseInt(storage.getItem(key) || '', 10);
  return Number.isFinite(n) ? n : 0;
}

const CATEGORY_LABELS = { article: '文章', news: '资讯', podcast: '播客' };
const READER_TABS = ['original', 'translation', 'rewrite'];
const ASSET_FILTER_TYPES = ['translation', 'rewrite', 'comments', 'chat'];
const ASSET_FOCUS_LABELS = { translation: '中文翻译', rewrite: '乔木风格重写', comments: '人工点评', chat: '文章对话' };
const ENTRY_PANE_MIN_WIDTH = 260;
const ENTRY_PANE_MAX_WIDTH = 620;
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
const COMMENT_SORTS = ['helpful', 'latest'];
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

function normalizeHistory(raw) {
  const items = Array.isArray(raw) ? raw : [];
  const map = new Map();
  for (const item of items) {
    const entryId = String((item && (item.entryId || item.id)) || item || '').trim();
    if (!entryId) continue;
    const viewedAt = Number(item && (item.viewedAt || item.at)) || Date.now();
    map.set(entryId, viewedAt);
  }
  return new Map([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000));
}

function historyEntriesForStorage(map) {
  return [...(map || new Map()).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1000)
    .map(([entryId, viewedAt]) => ({ entryId, viewedAt }));
}

const state = {
  sources: [],
  entries: [],
  contributors: [],
  view: 'all',            // all | unread | starred | history | assets | contributors
  filterSource: null,
  filterCategory: null,
  assetFilter: null,
  assetSort: 'latest',
  contributorSort: 'latest',
  q: '',
  refreshing: false,
  refreshProgress: { done: 0, total: 0 },
  autoRewrite: { running: false, last: null },
  activeEntry: null,
  guestRead: new Set(readJson('fr_read', '[]')),
  guestStarred: new Set(readJson('fr_starred', '[]')),
  guestHistory: normalizeHistory(readJson('qm_history', '[]')),
  read: new Set(readJson('fr_read', '[]')),
  starred: new Set(readJson('fr_starred', '[]')),
  history: normalizeHistory(readJson('qm_history', '[]')),
  agentMessages: [],
  comments: [],
  myTranslations: [],
  myRewrites: [],
  myComments: [],
  myChatMessages: [],
  myAssetTab: 'translation',
  myAssetSort: storage.getItem('qm_my_asset_sort') === 'helpful' ? 'helpful' : 'latest',
  contributor: { id: '', profile: null, translations: [], rewrites: [], comments: [], messages: [], tab: 'translation', sort: 'latest', loading: false },
  commentSort: storage.getItem('qm_comment_sort') === 'latest' ? 'latest' : 'helpful',
  editingCommentId: '',
  translation: null,
  translationLoading: false,
  translationGenerating: false,
  pendingTranslationGenerate: false,
  rewrite: null,
  rewriteGenerating: false,
  readerTab: 'original',
  readerFocus: null,
  readerAssetId: '',
  pendingAssetJump: null,
  pendingCommentId: '',
  pendingChatMessageId: '',
  fetchingOriginal: false,
  agentBusy: false,
  agentCollapsed: storage.getItem('qm_agent_collapsed') === '1',
  sidebarCollapsed: storage.getItem('qm_sidebar_collapsed') === '1',
  entryPaneWidth: readStoredNumber('qm_entry_pane_width'),
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
  const pathMatch = window.location.pathname.match(/^\/assets(?:\/([^/.]+))?\/?$/);
  const contributorsPath = /^\/contributors\/?$/.test(window.location.pathname);
  const contributorMatch = window.location.pathname.match(/^\/contributors\/([^/?#]+)\/?$/);
  const pathAssetFilter = pathMatch ? (ASSET_FILTER_TYPES.includes(pathMatch[1]) ? pathMatch[1] : null) : null;
  const isAssetPath = Boolean(pathMatch);
  const queryAssetFilter = ASSET_FILTER_TYPES.includes(params.get('asset')) ? params.get('asset') : null;
  const hash = decodeURIComponent(String(window.location.hash || '').replace(/^#/, ''));
  const queryCommentId = String(params.get('comment') || '').trim();
  const queryChatMessageId = String(params.get('chat') || '').trim();
  const queryAssetId = String(params.get('assetId') || '').trim();
  const commentId = hash.startsWith('comment-') ? hash.slice('comment-'.length).trim() : queryCommentId;
  const chatMessageId = hash.startsWith('chat-') ? hash.slice('chat-'.length).trim() : queryChatMessageId;
  const focus = ASSET_FILTER_TYPES.includes(params.get('focus')) ? params.get('focus') : null;
  return {
    entryId: String(params.get('entry') || '').trim(),
    contributorId: contributorMatch ? decodeURIComponent(contributorMatch[1]).trim() : '',
    contributorAssetType: contributorMatch ? normalizeUserAssetTab(params.get('type')) : 'translation',
    contributorAssetSort: contributorMatch && params.get('sort') === 'helpful' ? 'helpful' : 'latest',
    tab: normalizeReaderTab(params.get('tab')),
    view: contributorsPath ? 'contributors' : (isAssetPath || params.get('view') === 'assets' ? 'assets' : ''),
    assetFilter: isAssetPath ? pathAssetFilter : queryAssetFilter,
    assetSort: params.get('sort') === 'helpful' ? 'helpful' : 'latest',
    contributorSort: contributorsPath ? normalizeContributorSort(params.get('sort')) : 'latest',
    focus: commentId ? 'comments' : chatMessageId ? 'chat' : focus,
    assetId: queryAssetId,
    commentId,
    chatMessageId,
    q: String(params.get('q') || '').trim(),
  };
}

function listRouteTitle(view = state.view, assetFilter = state.assetFilter, q = state.q) {
  if (view === 'contributors') {
    const sortPrefix = state.contributorSort === 'helpful' ? '有用 · ' : state.contributorSort === 'assets' ? '资产 · ' : '';
    return q ? `${sortPrefix}贡献者 · “${q}” · QMReader` : `${sortPrefix}贡献者 · QMReader`;
  }
  if (view === 'assets') {
    const sortPrefix = state.assetSort === 'helpful' ? '有用 · ' : '';
    const prefix = `${sortPrefix}${assetFilter ? `${assetDirectoryLabel(assetFilter)}资产` : '公开资产'}`;
    return q ? `${prefix} · “${q}” · QMReader` : `${prefix} · QMReader`;
  }
  return 'QMReader · RSS 阅读器';
}

function readerRouteTitle(entry = state.activeEntry, focus = state.readerFocus) {
  const title = entry ? (entry.titleZh || entry.title || '文章') : '文章';
  const prefix = focus && ASSET_FOCUS_LABELS[focus] ? `${ASSET_FOCUS_LABELS[focus]} · ` : '';
  return `${prefix}${title} · QMReader`;
}

function readerUrlFor(entry = state.activeEntry, tab = state.readerTab, focus = state.readerFocus, assetId = state.readerAssetId) {
  const url = new URL(window.location.href);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  if (entry && entry.id) {
    url.searchParams.set('entry', entry.id);
    const nextTab = normalizeReaderTab(tab);
    if (nextTab !== 'original') url.searchParams.set('tab', nextTab);
    if (focus && ASSET_FILTER_TYPES.includes(focus)) url.searchParams.set('focus', focus);
    if ((focus === 'translation' || focus === 'rewrite') && assetId) url.searchParams.set('assetId', assetId);
  }
  return url;
}

function readerAssetUrl(type, entry = state.activeEntry, assetId = '') {
  if (!entry || !ASSET_FILTER_TYPES.includes(type)) return '';
  const tab = type === 'translation' ? 'translation' : type === 'rewrite' ? 'rewrite' : 'original';
  return readerUrlFor(entry, tab, type, assetId).href;
}

function commentUrl(commentId, entry = state.activeEntry) {
  if (!entry || !commentId) return '';
  const url = readerUrlFor(entry, 'original', 'comments');
  url.searchParams.set('comment', commentId);
  url.hash = `comment-${encodeURIComponent(commentId)}`;
  return url.href;
}

function chatMessageUrl(messageId, entry = state.activeEntry) {
  if (!entry || !messageId) return '';
  const url = readerUrlFor(entry, 'original', 'chat');
  url.searchParams.set('chat', messageId);
  url.hash = `chat-${encodeURIComponent(messageId)}`;
  return url.href;
}

function assetItemUrl(type, entry, itemId = '') {
  if ((type === 'translation' || type === 'rewrite') && itemId) return readerAssetUrl(type, entry, itemId);
  if (type === 'comments' && itemId) return commentUrl(itemId, entry);
  if (type === 'chat' && itemId) return chatMessageUrl(itemId, entry);
  return readerAssetUrl(type, entry);
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
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  if (view === 'assets') {
    url.pathname = assetFilter && ASSET_FILTER_TYPES.includes(assetFilter)
      ? `/assets/${assetFilter}`
      : '/assets';
    if (state.q) url.searchParams.set('q', state.q);
    if (state.assetSort === 'helpful') url.searchParams.set('sort', 'helpful');
  } else if (view === 'contributors') {
    url.pathname = '/contributors';
    if (state.q) url.searchParams.set('q', state.q);
    if (state.contributorSort !== 'latest') url.searchParams.set('sort', state.contributorSort);
  }
  return url;
}

function contributorUrlFor(contributorId, { sort = 'latest', tab = '' } = {}) {
  const url = new URL(window.location.href);
  url.pathname = `/contributors/${encodeURIComponent(contributorId)}`;
  url.search = '';
  url.hash = '';
  const assetTab = normalizeUserAssetTab(tab);
  if (assetTab !== 'translation') url.searchParams.set('type', assetTab);
  if (sort === 'helpful') url.searchParams.set('sort', 'helpful');
  return url;
}

function contributorFeedUrlFor(contributorId) {
  const url = contributorUrlFor(contributorId);
  url.pathname = `/contributors/${encodeURIComponent(contributorId)}.xml`;
  return url;
}

function syncReaderUrl({ replace = false, commentId = '', chatMessageId = '' } = {}) {
  const entry = state.activeEntry;
  if (!entry || !entry.id) return;
  const url = readerUrlFor(entry, state.readerTab);
  if (commentId) {
    url.searchParams.set('comment', commentId);
    url.hash = `comment-${encodeURIComponent(commentId)}`;
  }
  if (chatMessageId) {
    url.searchParams.set('chat', chatMessageId);
    url.hash = `chat-${encodeURIComponent(chatMessageId)}`;
  }
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
  state.guestHistory = new Map(state.history);
  storage.setItem('fr_read', JSON.stringify([...state.guestRead].slice(-5000)));
  storage.setItem('fr_starred', JSON.stringify([...state.guestStarred]));
  storage.setItem('qm_history', JSON.stringify(historyEntriesForStorage(state.guestHistory)));
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

function faviconTargetUrl(siteUrl, domain) {
  const raw = String(siteUrl || '').trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch (error) {
    // Fall back to the extracted domain below.
  }
  return domain ? `https://${domain}` : '';
}

function faviconHtml(siteUrl, name, size = 17) {
  const d = domainOf(siteUrl);
  const letter = ((name || '?').trim()[0] || '?').toUpperCase();
  const safeSize = Math.max(12, Math.min(Number(size) || 17, 48));
  if (!d) return `<span class="letter-icon" style="--icon-size:${safeSize}px">${escapeHtml(letter)}</span>`;
  const src = `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(faviconTargetUrl(siteUrl, d))}&sz=${Math.max(32, safeSize * 4)}`;
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
  state.refreshing = Boolean(data.refreshing);
  state.refreshProgress = data.progress || { done: 0, total: 0 };
  state.autoRewrite = data.autoRewrite || { running: false, last: null };
  if (!$('#manage-modal')?.classList.contains('hidden')) renderManageStatus();
  return data;
}
async function loadEntries() {
  const p = new URLSearchParams();
  if (state.filterSource) p.set('source', state.filterSource);
  if (state.filterCategory) p.set('category', state.filterCategory);
  if (state.q && state.view !== 'assets' && state.view !== 'contributors') p.set('q', state.q);
  const data = await api('/api/entries?' + p.toString());
  state.entries = data.entries;
}
async function loadContributors() {
  const p = new URLSearchParams({ limit: '200' });
  if (state.contributorSort !== 'latest') p.set('sort', state.contributorSort);
  const data = await api('/api/contributors?' + p.toString());
  state.contributors = data.contributors || [];
}

function applyGuestEntryStates() {
  state.read = new Set(state.guestRead);
  state.starred = new Set(state.guestStarred);
  state.history = new Map(state.guestHistory);
}

async function loadUserEntryStates() {
  if (!state.me) {
    applyGuestEntryStates();
    return;
  }
  const data = await api('/api/me/entry-states');
  state.read = new Set((data.states && data.states.read) || []);
  state.starred = new Set((data.states && data.states.starred) || []);
  state.history = normalizeHistory((data.states && data.states.history) || []);
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

function recordEntryView(entryId) {
  const id = String(entryId || '').trim();
  if (!id) return;
  state.history.delete(id);
  state.history.set(id, Date.now());
  state.history = new Map(historyEntriesForStorage(state.history).map(item => [item.entryId, item.viewedAt]));
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
  $('#count-history').textContent = state.history.size || '';
  $('#count-assets').textContent = assetTotalCount(state.entries.filter(hasEntryAssets)) || '';
  $('#count-contributors').textContent = state.contributors.length || '';
  renderAssetDashboard();

  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view && !state.filterSource && !state.filterCategory));
}

/* ---------- Entry list ---------- */
function hasEntryAssets(entry) {
  return ASSET_FILTER_TYPES.some(type => assetCountForType(entry, type) > 0);
}

function assetCountForType(entry, type) {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation' || type === 'rewrite') {
    const count = Number(assets[`${type}Count`]) || 0;
    if (count) return count;
    const items = assets.items && Array.isArray(assets.items[type]) ? assets.items[type] : [];
    if (items.length) return items.length;
    return assets[type] ? 1 : 0;
  }
  if (type === 'comments') return Number(assets.comments) || 0;
  if (type === 'chat') return Number(assets.chatMessages) || 0;
  return 0;
}

function entryHasAssetType(entry, type) {
  if (ASSET_FILTER_TYPES.includes(type)) return assetCountForType(entry, type) > 0;
  return hasEntryAssets(entry);
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceNameForEntry(entry) {
  return sourceById(entry && entry.sourceId)?.name || (entry && entry.sourceId) || '';
}

function assetSearchText(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const previews = assets.previews || {};
  const items = assets.items || {};
  const parts = [];
  for (const type of ASSET_FILTER_TYPES) {
    const preview = previews[type];
    if (!entryHasAssetType(entry, type)) continue;
    if (preview) {
      const display = assetPreviewDisplay(preview);
      parts.push(
        ASSET_TYPE_LABELS[type],
        ASSET_FOCUS_LABELS[type],
        display.label,
        display.text,
        preview.author,
        preview.title,
        preview.model,
        preview.role,
      );
    }
    for (const item of items[type] || []) {
      const display = assetPreviewDisplay(item);
      parts.push(display.label, display.text, item.author, item.title, item.model, item.role);
    }
  }
  return parts.filter(Boolean).join(' ');
}

function entrySearchText(entry, { includeAssets = false } = {}) {
  return [
    entry.title,
    entry.titleZh,
    entry.summary,
    entry.summaryZh,
    sourceNameForEntry(entry),
    includeAssets ? assetSearchText(entry) : '',
  ].filter(Boolean).join(' ');
}

function entryMatchesSearch(entry, { includeAssets = false } = {}) {
  const needle = normalizeSearchText(state.q);
  if (!needle) return true;
  return normalizeSearchText(entrySearchText(entry, { includeAssets })).includes(needle);
}

function contributorSearchText(contributor) {
  return [
    contributor.displayName,
    `${contributor.assetCount || 0} 条`,
    `${contributor.helpfulCount || 0} 有用`,
    `${contributor.helpfulAssets || 0} 受认可`,
    `${contributor.translationCount || 0} 中译`,
    `${contributor.rewriteCount || 0} 重写`,
    `${contributor.commentCount || 0} 点评`,
    `${contributor.chatCount || 0} 对话`,
  ].filter(Boolean).join(' ');
}

function visibleContributors() {
  const needle = normalizeSearchText(state.q);
  return (state.contributors || [])
    .filter(contributor => !needle || normalizeSearchText(contributorSearchText(contributor)).includes(needle));
}

function visibleEntries() {
  let list = state.entries;
  if (state.view === 'unread') list = list.filter(e => !state.read.has(e.id));
  if (state.view === 'starred') list = list.filter(e => state.starred.has(e.id));
  if (state.view === 'history') {
    list = list
      .filter(e => state.history.has(e.id))
      .slice()
      .sort((a, b) => (Number(state.history.get(b.id)) || 0) - (Number(state.history.get(a.id)) || 0));
  }
  if (state.view === 'assets') {
    list = list
      .filter(hasEntryAssets)
      .filter(entry => !state.assetFilter || entryHasAssetType(entry, state.assetFilter))
      .filter(entry => entryMatchesSearch(entry, { includeAssets: true }))
      .slice()
      .sort(compareAssetEntries);
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

const ASSET_DIRECTORY_LABELS = {
  translation: '中文翻译',
  rewrite: '乔木风格重写',
  comments: '人工点评',
  chat: '文章对话',
};

function assetDirectoryLabel(type) {
  return ASSET_DIRECTORY_LABELS[type] || ASSET_TYPE_LABELS[type] || '公开';
}

const ASSET_FILTERS = {
  translation: { label: '中译', count: entry => assetCountForType(entry, 'translation'), title: '查看有中文翻译的文章' },
  rewrite: { label: '重写', count: entry => assetCountForType(entry, 'rewrite'), title: '查看有乔木风格重写的文章' },
  comments: { label: '点评', count: entry => assetCountForType(entry, 'comments'), title: '查看有人工点评的文章' },
  chat: { label: '对话', count: entry => assetCountForType(entry, 'chat'), title: '查看有文章对话的文章' },
};

const ASSET_SORTS = {
  latest: { label: '最新', title: '按最近沉淀时间排序' },
  helpful: { label: '有用', title: '优先显示被读者标记有用的 AI 资产、点评和对话' },
};

const CONTRIBUTOR_SORTS = {
  latest: { label: '最新', title: '按最近沉淀公开资产的时间排序' },
  helpful: { label: '有用', title: '优先显示获得读者有用反馈的贡献者' },
  assets: { label: '资产', title: '优先显示公开资产数量更多的贡献者' },
};

function normalizeContributorSort(sort = '') {
  return CONTRIBUTOR_SORTS[sort] ? sort : 'latest';
}

function normalizeAssetSort(sort = '') {
  return sort === 'helpful' ? 'helpful' : 'latest';
}

function normalizeContributorAssetSort(sort = '') {
  return normalizeAssetSort(sort);
}

function normalizeUserAssetSort(sort = '') {
  return normalizeAssetSort(sort);
}

function assetTypeCount(entries, type) {
  const def = ASSET_FILTERS[type];
  if (!def) return 0;
  return entries.reduce((sum, entry) => sum + def.count(entry), 0);
}

function assetTotalCount(entries) {
  return Object.keys(ASSET_FILTERS).reduce((sum, type) => sum + assetTypeCount(entries, type), 0);
}

function assetLatestAtForType(entry, type = '') {
  const assets = entry && entry.assets ? entry.assets : {};
  if (!type) return Number(assets.latestAt || 0);
  const itemAt = Number((assets.items && assets.items[type] && assets.items[type][0] && assets.items[type][0].at) || 0);
  const previewAt = Number((assets.previews && assets.previews[type] && assets.previews[type].at) || 0);
  return Math.max(itemAt, previewAt);
}

function assetHelpfulScoreForType(entry, type = '') {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation') return Number(assets.translationHelpfulCount) || 0;
  if (type === 'rewrite') return Number(assets.rewriteHelpfulCount) || 0;
  if (type === 'comments') return Number(assets.commentHelpfulCount ?? assets.helpfulCount) || 0;
  if (type === 'chat') return Number(assets.chatHelpfulCount) || 0;
  return Number(assets.helpfulCount) || 0;
}

function assetHelpfulItemCount(entry, type = '') {
  const assets = entry && entry.assets ? entry.assets : {};
  if (type === 'translation') return helpfulAiAssetItemCount(assets, 'translation');
  if (type === 'rewrite') return helpfulAiAssetItemCount(assets, 'rewrite');
  if (type === 'comments') return Number(assets.helpfulComments) || 0;
  if (type === 'chat') return Number(assets.helpfulChats) || 0;
  return helpfulAiAssetItemCount(assets, 'translation')
    + helpfulAiAssetItemCount(assets, 'rewrite')
    + (Number(assets.helpfulComments) || 0)
    + (Number(assets.helpfulChats) || 0);
}

function compareAssetEntries(a, b) {
  const latestDelta = assetLatestAtForType(b, state.assetFilter) - assetLatestAtForType(a, state.assetFilter);
  if (state.assetSort === 'helpful') {
    const helpfulDelta = assetHelpfulScoreForType(b, state.assetFilter) - assetHelpfulScoreForType(a, state.assetFilter);
    if (helpfulDelta) return helpfulDelta;
    const helpfulCommentDelta = assetHelpfulItemCount(b, state.assetFilter) - assetHelpfulItemCount(a, state.assetFilter);
    if (helpfulCommentDelta) return helpfulCommentDelta;
  }
  return latestDelta || (b.publishedTs || 0) - (a.publishedTs || 0);
}

function assetDashboardStats() {
  const entries = state.entries.filter(hasEntryAssets);
  const latest = entries
    .slice()
    .sort((a, b) => Number(b.assets?.latestAt || 0) - Number(a.assets?.latestAt || 0))[0] || null;
  const counts = Object.fromEntries(Object.keys(ASSET_FILTERS).map(type => [type, assetTypeCount(entries, type)]));
  const helpfulTotal = entries.reduce((sum, entry) => sum + assetHelpfulScoreForType(entry), 0);
  const helpfulEntries = entries.reduce((sum, entry) => sum + (assetHelpfulScoreForType(entry) > 0 ? 1 : 0), 0);
  return {
    entries,
    latest,
    counts,
    helpfulEntries,
    helpfulTotal,
    totalAssets: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

function renderAssetDashboard() {
  const dashboard = $('#asset-dashboard');
  if (!dashboard) return;
  dashboard.classList.toggle('hidden', !state.entries.length);

  const { entries, latest, counts, helpfulEntries, helpfulTotal, totalAssets } = assetDashboardStats();
  const total = entries.length;
  $('#asset-dashboard-total').textContent = totalAssets ? `${totalAssets} 条` : '0 条';
  const recentTypes = latest && Array.isArray(latest.assets?.latestTypes)
    ? latest.assets.latestTypes.map(type => ASSET_TYPE_LABELS[type]).filter(Boolean)
    : [];
  $('#asset-dashboard-recent').textContent = latest && latest.assets?.latestAt
    ? `${total} 篇文章 · ${recentTypes.length ? recentTypes.join(' / ') : '资产'} · ${formatAssetTime(latest.assets.latestAt)}`
    : '暂无沉淀';

  const open = $('#asset-dashboard-open');
  open.disabled = total === 0;
  open.classList.toggle('active', state.view === 'assets' && state.assetSort === 'latest' && !state.assetFilter && !state.filterSource && !state.filterCategory);

  const helpful = $('#asset-dashboard-helpful');
  if (helpful) {
    helpful.disabled = helpfulTotal === 0;
    helpful.title = helpfulTotal
      ? `查看 ${helpfulEntries} 篇被读者标记有用的公开资产`
      : '暂无读者标记有用的公开资产';
    helpful.classList.toggle('active', state.view === 'assets' && state.assetSort === 'helpful' && !state.assetFilter && !state.filterSource && !state.filterCategory);
    const value = $('#asset-dashboard-helpful-count');
    if (value) value.textContent = helpfulTotal ? `${helpfulTotal} 次` : '0';
  }

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
  if (state.assetSort === 'helpful' && assetHelpfulScoreForType(entry, state.assetFilter) > 0) {
    const helpful = assetHelpfulScoreForType(entry, state.assetFilter);
    const latest = assetLatestAtForType(entry, state.assetFilter);
    return `有用 ${helpful} 次${latest ? ` · 最近沉淀 ${formatAssetTime(latest)}` : ''}`;
  }
  if (state.assetFilter) {
    const filteredAt = assetLatestAtForType(entry, state.assetFilter);
    if (!filteredAt) return '';
    const filteredLabel = ASSET_TYPE_LABELS[state.assetFilter] || '资产';
    return `${filteredLabel} · 最近沉淀 ${formatAssetTime(filteredAt)}`;
  }
  if (!assets.latestAt) return '';
  const types = Array.isArray(assets.latestTypes) ? assets.latestTypes : [];
  const labels = types.map(type => ASSET_TYPE_LABELS[type]).filter(Boolean);
  const prefix = labels.length ? labels.join(' / ') : '资产';
  return `${prefix} · 最近沉淀 ${formatAssetTime(assets.latestAt)}`;
}

function entryHistoryLabel(entry) {
  if (state.view !== 'history' || !entry || !state.history.has(entry.id)) return '';
  return `最近阅读 ${formatAssetTime(state.history.get(entry.id))}`;
}

function assetPreviewForEntry(entry) {
  if (state.view !== 'assets') return null;
  if (
    state.assetSort === 'helpful'
    && !state.assetFilter
    && entry?.assets?.topHelpfulAsset
  ) {
    return entry.assets.topHelpfulAsset;
  }
  if (
    state.assetSort === 'helpful'
    && state.assetFilter === 'translation'
    && entry?.assets?.topHelpfulTranslation
  ) {
    return entry.assets.topHelpfulTranslation;
  }
  if (
    state.assetSort === 'helpful'
    && state.assetFilter === 'rewrite'
    && entry?.assets?.topHelpfulRewrite
  ) {
    return entry.assets.topHelpfulRewrite;
  }
  if (
    state.assetSort === 'helpful'
    && state.assetFilter === 'comments'
    && entry?.assets?.topHelpfulComment
  ) {
    return entry.assets.topHelpfulComment;
  }
  if (
    state.assetSort === 'helpful'
    && state.assetFilter === 'chat'
    && entry?.assets?.topHelpfulChat
  ) {
    return entry.assets.topHelpfulChat;
  }
  return assetPreviewForType(entry, state.assetFilter);
}

function assetPreviewForType(entry, type = '') {
  const assets = entry && entry.assets ? entry.assets : {};
  const previews = assets.previews || {};
  const preview = type && previews[type] ? previews[type] : assets.preview;
  if (!preview || !preview.type || !preview.text) return null;
  return preview;
}

function assetPreviewDisplay(preview) {
  const type = ASSET_FILTER_TYPES.includes(preview && preview.type) ? preview.type : 'comments';
  const baseLabel = ASSET_TYPE_LABELS[type] || '资产';
  if (type === 'comments') {
    const display = commentDisplayParts(preview.text);
    return {
      type,
      label: display.label ? `${baseLabel} · ${display.label}` : baseLabel,
      text: display.body || preview.text,
      commentType: display.type,
    };
  }
  if (type === 'chat') {
    const roleLabel = preview.role === 'user' ? '提问' : preview.role === 'assistant' ? '回答' : '';
    return {
      type,
      label: roleLabel ? `${baseLabel} · ${roleLabel}` : baseLabel,
      text: preview.text,
      commentType: '',
    };
  }
  return {
    type,
    label: baseLabel,
    text: preview.text,
    commentType: '',
  };
}

function assetPreviewHtml(preview) {
  const display = assetPreviewDisplay(preview);
  const { type, label } = display;
  const helpfulMeta = Number(preview.helpfulCount || 0) > 0
    ? `有用 ${Number(preview.helpfulCount || 0)}`
    : '';
  const meta = [preview.author, preview.model, helpfulMeta, formatAssetTime(preview.at)].filter(Boolean).join(' · ');
  const itemId = preview.id ? ` data-asset-item-id="${escapeHtml(preview.id)}"` : '';
  const copyItemId = preview.id ? ` data-asset-item-id="${escapeHtml(preview.id)}"` : '';
  return `
    <div class="entry-asset-preview-row">
      <button type="button" class="entry-asset-preview asset-preview-${type}" data-asset="${escapeHtml(type)}"${itemId} title="查看${escapeHtml(label)}资产">
        <span class="entry-asset-preview-type">${escapeHtml(label)}</span>
        <span class="entry-asset-preview-text">${escapeHtml(display.text)}</span>
        ${meta ? `<span class="entry-asset-preview-meta">${escapeHtml(meta)}</span>` : ''}
      </button>
      <button type="button" class="entry-asset-preview-copy" data-asset-preview-copy="${escapeHtml(type)}"${copyItemId} title="复制${escapeHtml(label)}链接" aria-label="复制${escapeHtml(label)}链接">⧉</button>
    </div>`;
}

function assetItemListHtml(entry) {
  if (state.view !== 'assets' || !ASSET_FILTER_TYPES.includes(state.assetFilter)) return '';
  const assets = entry && entry.assets ? entry.assets : {};
  let items = (assets.items && assets.items[state.assetFilter]) || [];
  if (state.assetSort === 'helpful') {
    const top = state.assetFilter === 'chat'
      ? assets.topHelpfulChat
      : state.assetFilter === 'translation'
        ? assets.topHelpfulTranslation
        : state.assetFilter === 'rewrite'
          ? assets.topHelpfulRewrite
          : assets.topHelpfulComment;
    const byId = new Map();
    for (const item of [top, ...items]) {
      const key = item && item.id ? item.id : `${item && item.at}:${item && item.text}`;
      if (item && key && !byId.has(key)) byId.set(key, item);
    }
    items = [...byId.values()]
      .sort((a, b) => (Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0)) || (Number(b.at || 0) - Number(a.at || 0)))
      .slice(0, 3);
  }
  if (!items.length) return '';
  const total = assetCountForType(entry, state.assetFilter);
  const label = ASSET_TYPE_LABELS[state.assetFilter] || '资产';
  const more = total > items.length && ['comments', 'chat'].includes(state.assetFilter)
    ? `<button type="button" class="entry-asset-more" data-asset="${escapeHtml(state.assetFilter)}">查看全部 ${total} 条${escapeHtml(label)}</button>`
    : total > items.length
      ? `<span class="entry-asset-more">还有 ${total - items.length} 条${escapeHtml(label)}</span>`
    : '';
  return `<div class="entry-asset-items">
    ${items.map(item => assetPreviewHtml(item)).join('')}
    ${more}
  </div>`;
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
      const preview = assetPreviewForType(entry, type);
      const previewMeta = preview
        ? [preview.author, preview.model].filter(Boolean).join(' · ')
        : '';
      return {
        entry,
        type,
        labels: labels.length ? labels.join(' / ') : (ASSET_TYPE_LABELS[type] || '资产'),
        preview,
        previewMeta,
      };
    });
}

function renderAssetActivityStrip() {
  const el = $('#asset-activity-strip');
  if (!el) return;
  el.classList.remove('asset-filter-strip');
  if (state.view === 'assets') {
    const { entries, latest, counts, totalAssets } = assetDashboardStats();
    const total = entries.length;
    const allActiveEntries = state.assetFilter
      ? entries.filter(entry => entryHasAssetType(entry, state.assetFilter))
      : entries;
    const scopedEntries = state.q
      ? allActiveEntries.filter(entry => entryMatchesSearch(entry, { includeAssets: true }))
      : allActiveEntries;
    const activeAssetCount = state.assetFilter ? assetTypeCount(scopedEntries, state.assetFilter) : assetTotalCount(scopedEntries);
    const activeEntryCount = scopedEntries.length;
    const activeLabel = state.assetFilter ? `${assetDirectoryLabel(state.assetFilter)}资产` : '公开资产';
    el.classList.toggle('hidden', !total && !state.assetFilter);
    if (!total && !state.assetFilter) {
      el.innerHTML = '';
      return;
    }
    el.classList.add('asset-filter-strip');
    const activeLatest = scopedEntries
      .slice()
      .sort((a, b) => assetLatestAtForType(b, state.assetFilter) - assetLatestAtForType(a, state.assetFilter))[0] || null;
    const activeLatestAt = activeLatest ? assetLatestAtForType(activeLatest, state.assetFilter) : 0;
    const latestTypes = !state.assetFilter && latest && Array.isArray(latest.assets?.latestTypes)
      ? latest.assets.latestTypes.map(type => ASSET_TYPE_LABELS[type]).filter(Boolean)
      : [];
    const latestLabel = state.assetFilter
      ? (ASSET_TYPE_LABELS[state.assetFilter] || '资产')
      : (latestTypes.length ? latestTypes.join(' / ') : '资产');
    const latestText = activeLatestAt
      ? `${latestLabel} · ${formatAssetTime(activeLatestAt)}`
      : '暂无沉淀';
    const activeHelpfulCount = scopedEntries.reduce((sum, entry) => sum + assetHelpfulScoreForType(entry, state.assetFilter), 0);
    const sortText = state.assetSort === 'helpful'
      ? (activeHelpfulCount ? `有用 ${activeHelpfulCount} 次` : '暂无有用标记')
      : '按最新沉淀';
    const scopeText = `${activeAssetCount} 条 · ${activeEntryCount} 篇文章`;
    const statusText = state.q
      ? `匹配 ${scopeText} · ${sortText} · ${latestText}`
      : `${scopeText} · ${sortText} · ${latestText}`;
    const feedHref = `${state.assetFilter ? `/assets/${state.assetFilter}.xml` : '/assets.xml'}${state.assetSort === 'helpful' ? '?sort=helpful' : ''}`;
    const sortButtons = Object.entries(ASSET_SORTS).map(([sort, def]) => `
      <button type="button" class="asset-sort-btn${state.assetSort === sort ? ' active' : ''}" data-asset-sort="${escapeHtml(sort)}" aria-pressed="${state.assetSort === sort ? 'true' : 'false'}" title="${escapeHtml(def.title)}">${escapeHtml(def.label)}</button>
    `).join('');
    const chips = [
      `<button type="button" class="asset-filter-chip${!state.assetFilter ? ' active' : ''}" data-asset-strip-filter="" title="查看全部公开资产">
        <span>全部</span><strong>${totalAssets}</strong>
      </button>`,
      ...Object.entries(ASSET_FILTERS).map(([type, def]) => {
        const count = counts[type] || 0;
        return `<button type="button" class="asset-filter-chip asset-filter-${type}${state.assetFilter === type ? ' active' : ''}" data-asset-strip-filter="${escapeHtml(type)}" ${count ? '' : 'disabled'} title="${escapeHtml(count ? def.title : '暂无这类资产')}">
          <span>${escapeHtml(def.label)}</span><strong>${count}</strong>
        </button>`;
      }),
    ];
    el.innerHTML = `
      <div class="asset-filter-head">
        <span>${escapeHtml(activeLabel)}</span>
        <strong>${activeAssetCount} 条</strong>
        <em>${escapeHtml(statusText)}</em>
        <button type="button" class="asset-copy-link" data-asset-copy-list title="复制当前资产页链接" aria-label="复制当前资产页链接">⧉</button>
        <a class="asset-feed-link" href="${escapeHtml(feedHref)}" target="_blank" rel="noopener" title="订阅公开资产 RSS">RSS</a>
      </div>
      <div class="asset-sort-row">
        <span>排序</span>
        <div class="asset-sort-toggle" role="group" aria-label="公开资产排序">${sortButtons}</div>
      </div>
      <div class="asset-filter-list" aria-label="资产类型筛选">
        ${chips.join('')}
      </div>`;
    return;
  }
  if (state.view === 'contributors') {
    const total = (state.contributors || []).length;
    const list = visibleContributors();
    const contributorCount = list.length;
    const assetCount = list.reduce((sum, contributor) => sum + (Number(contributor.assetCount) || 0), 0);
    const helpfulCount = list.reduce((sum, contributor) => sum + (Number(contributor.helpfulCount) || 0), 0);
    const helpfulContributors = list.reduce((sum, contributor) => sum + (Number(contributor.helpfulCount) > 0 ? 1 : 0), 0);
    const latestAt = list.reduce((latest, contributor) => Math.max(latest, Number(contributor.latestAt) || 0), 0);
    el.classList.toggle('hidden', !total && !state.q);
    if (!total && !state.q) {
      el.innerHTML = '';
      return;
    }
    el.classList.add('asset-filter-strip');
    const latestText = latestAt ? `最近 ${formatAssetTime(latestAt)}` : '暂无沉淀';
    const sortText = state.contributorSort === 'helpful'
      ? (helpfulCount ? `有用 ${helpfulCount} 次` : '暂无有用标记')
      : state.contributorSort === 'assets'
      ? '按资产数'
      : '按最新沉淀';
    const statusText = state.q
      ? `匹配 ${contributorCount} 人 · ${assetCount} 条资产 · ${sortText} · ${latestText}`
      : `${contributorCount} 人 · ${assetCount} 条资产 · ${helpfulContributors} 人获认可 · ${sortText} · ${latestText}`;
    const sortButtons = Object.entries(CONTRIBUTOR_SORTS).map(([sort, def]) => `
      <button type="button" class="asset-sort-btn${state.contributorSort === sort ? ' active' : ''}" data-contributor-sort="${escapeHtml(sort)}" aria-pressed="${state.contributorSort === sort ? 'true' : 'false'}" title="${escapeHtml(def.title)}">${escapeHtml(def.label)}</button>
    `).join('');
    el.innerHTML = `
      <div class="asset-filter-head">
        <span>贡献者</span>
        <strong>${contributorCount} 人</strong>
        <em>${escapeHtml(statusText)}</em>
        <button type="button" class="asset-copy-link" data-contributor-copy-list title="复制当前贡献者页链接" aria-label="复制当前贡献者页链接">⧉</button>
      </div>
      <div class="asset-sort-row">
        <span>排序</span>
        <div class="asset-sort-toggle" role="group" aria-label="贡献者排序">${sortButtons}</div>
      </div>`;
    return;
  }
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
      ${items.map(({ entry, type, labels, preview, previewMeta }) => {
        const src = sourceById(entry.sourceId);
        const itemId = preview && preview.id ? ` data-asset-item-id="${escapeHtml(preview.id)}"` : '';
        const previewDisplay = preview ? assetPreviewDisplay(preview) : null;
        const previewText = previewDisplay && previewDisplay.text ? previewDisplay.text : '';
        const labelText = previewDisplay && previewDisplay.commentType && labels === ASSET_TYPE_LABELS.comments
          ? previewDisplay.label
          : labels;
        const helpfulMeta = preview && Number(preview.helpfulCount || 0) > 0
          ? `有用 ${Number(preview.helpfulCount || 0)}`
          : '';
        const meta = [src && src.name, previewMeta, helpfulMeta, formatAssetTime(entry.assets.latestAt)].filter(Boolean).join(' · ');
        return `<button type="button" class="asset-activity-item asset-activity-${type}" data-asset-entry="${escapeHtml(entry.id)}" data-asset-focus="${escapeHtml(type)}"${itemId}>
          <span class="asset-activity-type">${escapeHtml(labelText)}</span>
          <strong>${escapeHtml(entry.titleZh || entry.title || '无标题')}</strong>
          ${previewText ? `<span class="asset-activity-preview">${escapeHtml(previewText)}</span>` : ''}
          <span class="asset-activity-meta">${escapeHtml(meta)}</span>
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
    preview: null,
    previews: {},
    items: {},
    translationCount: 0,
    rewriteCount: 0,
    helpfulCount: 0,
    commentHelpfulCount: 0,
    chatHelpfulCount: 0,
    translationHelpfulCount: 0,
    rewriteHelpfulCount: 0,
    helpfulComments: 0,
    helpfulChats: 0,
    helpfulAssets: 0,
    topHelpfulComment: null,
    topHelpfulChat: null,
    topHelpfulTranslation: null,
    topHelpfulRewrite: null,
    topHelpfulAsset: null,
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

function assetSummaryText(value, max = 150) {
  const text = String(value || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function readerAssetPreview(entry, type, fallback = '') {
  const direct = assetSummaryText(type === 'comments' ? commentDisplayParts(fallback).body : fallback);
  if (direct) return direct;
  const preview = assetPreviewForType(entry, type);
  return assetSummaryText(preview ? assetPreviewDisplay(preview).text : '');
}

function readerAssetPreviewMeta(entry, type, leading = []) {
  const preview = assetPreviewForType(entry, type);
  if (!preview) return '';
  const helpfulMeta = Number(preview.helpfulCount || 0) > 0
    ? `有用 ${Number(preview.helpfulCount || 0)}`
    : '';
  const meta = [preview.author, preview.model, helpfulMeta, formatAssetTime(preview.at)].filter(Boolean);
  return meta.length ? assetMetaLine([...leading, ...meta]) : '';
}

function assetHelpfulMeta(asset) {
  const count = Number(asset && asset.helpfulCount) || 0;
  return count > 0 ? `有用 ${count}` : '';
}

function readerAssetSummaryLabel(entry, type, fallback) {
  const preview = assetPreviewForType(entry, type);
  const display = preview ? assetPreviewDisplay(preview) : null;
  return display && display.commentType ? display.label : fallback;
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
    const total = assetCountForType(entry, 'translation');
    const firstTranslatedParagraph = translation && Array.isArray(translation.content)
      ? translation.content.map(pair => pair && pair.target).find(Boolean)
      : '';
    rows.push({
      type: 'translation',
      label: '中文翻译',
      value: translation ? assetMetaLine([total > 1 ? `${total} 条` : '', translation.createdBy, translation.model, assetHelpfulMeta(translation), formatAssetTime(translation.updatedAt)]) : (readerAssetPreviewMeta(entry, 'translation', [total > 1 ? `${total} 条` : '']) || '正在加载详情'),
      preview: readerAssetPreview(entry, 'translation', firstTranslatedParagraph),
    });
  }
  if (assets.rewrite) {
    const total = assetCountForType(entry, 'rewrite');
    rows.push({
      type: 'rewrite',
      label: '乔木重写',
      value: rewrite ? assetMetaLine([total > 1 ? `${total} 条` : '', rewrite.createdBy, rewrite.model, assetHelpfulMeta(rewrite), formatAssetTime(rewrite.updatedAt)]) : (readerAssetPreviewMeta(entry, 'rewrite', [total > 1 ? `${total} 条` : '']) || '正在加载详情'),
      preview: readerAssetPreview(entry, 'rewrite', rewrite && rewrite.body),
    });
  }
  if (assets.comments) {
    const latest = [...comments].sort((a, b) =>
      Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)
    )[0] || null;
    const helpfulMeta = latest && Number(latest.helpfulCount || 0) > 0 ? `有用 ${Number(latest.helpfulCount || 0)}` : '';
    rows.push({
      type: 'comments',
      label: readerAssetSummaryLabel(entry, 'comments', '人工点评'),
      value: latest ? assetMetaLine([`${assets.comments} 条`, latest.author, helpfulMeta, formatAssetTime(latest.updatedAt || latest.createdAt)]) : (readerAssetPreviewMeta(entry, 'comments', [`${assets.comments} 条`]) || `${assets.comments} 条 · 正在加载详情`),
      preview: readerAssetPreview(entry, 'comments', latest && latest.body),
    });
  }
  if (assets.chatMessages) {
    const latest = latestAssetItem(messages, true);
    const helpfulMeta = latest && Number(latest.helpfulCount || 0) > 0 ? `有用 ${Number(latest.helpfulCount || 0)}` : '';
    rows.push({
      type: 'chat',
      label: '文章对话',
      value: latest ? assetMetaLine([`${assets.chatMessages} 条`, latest.author, helpfulMeta, formatAssetTime(latest.createdAt)]) : (readerAssetPreviewMeta(entry, 'chat', [`${assets.chatMessages} 条`]) || `${assets.chatMessages} 条 · 正在加载详情`),
      preview: readerAssetPreview(entry, 'chat', latest && latest.content),
    });
  }

  el.innerHTML = rows.map(row => `
    <div class="asset-summary-row asset-summary-${row.type}">
      <button type="button" class="asset-summary-item" data-asset-summary="${row.type}">
        <span>${escapeHtml(row.label)}</span>
        <strong>${escapeHtml(row.value)}</strong>
        ${row.preview ? `<em class="asset-summary-preview">${escapeHtml(row.preview)}</em>` : ''}
      </button>
      <button type="button" class="asset-summary-copy" data-asset-copy="${row.type}" title="复制${escapeHtml(row.label)}链接" aria-label="复制${escapeHtml(row.label)}链接">⧉</button>
    </div>`).join('');
  el.classList.toggle('hidden', !rows.length);
}

function scrollReaderTarget(selector, { behavior = 'smooth', offset = 12 } = {}) {
  const target = $(selector);
  if (!target) return;
  const pane = $('#reader-pane');
  if (pane && pane.contains(target)) {
    const paneRect = pane.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = pane.scrollTop + targetRect.top - paneRect.top - offset;
    pane.scrollTo({ top: Math.max(0, top), behavior });
    return;
  }
  target.scrollIntoView({ behavior, block: 'start' });
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
  if (type === 'translation' || type === 'rewrite') state.readerAssetId = '';
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

function applyServerEntryUpdate(entry) {
  if (!entry || !entry.id) return null;
  const current = state.activeEntry && state.activeEntry.id === entry.id ? state.activeEntry : {};
  const updated = { ...current, ...entry };
  const idx = state.entries.findIndex(item => item.id === entry.id);
  if (idx >= 0) state.entries[idx] = { ...state.entries[idx], ...updated, content: undefined };
  if (updated.content) contentCache.set(updated.id, updated.content);
  if (state.activeEntry?.id === entry.id) {
    state.activeEntry = updated;
    renderTitle(updated);
    renderOriginalContent(updated, updated.content || contentCache.get(updated.id) || '');
    updateFetchOriginalButton(updated);
  }
  renderList();
  return updated;
}

function isAdmin() {
  return state.me && state.me.role === 'admin';
}

function renderAuthState() {
  const loggedIn = Boolean(state.me);
  $('#auth-open').classList.toggle('hidden', loggedIn);
  $('#account-info').classList.toggle('hidden', !loggedIn);
  $('#my-comments-btn').classList.toggle('hidden', !loggedIn);
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
  state.myComments = [];
  state.myChatMessages = [];
  applyGuestEntryStates();
  loadAiProfilesForScope();
  renderAuthState();
  renderEntryStateUi();
  renderComments();
  renderAgent();
  renderAiSettings();
  toast('已退出登录');
}

function renderContributorDirectory() {
  const list = visibleContributors();
  const el = $('#entry-list');
  el.innerHTML = '';
  renderAssetActivityStrip();
  if (!list.length) {
    const text = state.q
      ? `没有匹配“${escapeHtml(state.q)}”的贡献者<br/>换个关键词试试`
      : '还没有公开贡献者<br/>先发布点评或文章对话';
    el.innerHTML = `<div class="list-empty">${text}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const contributor of list) {
    const card = document.createElement('div');
    card.className = 'contributor-card';
    card.dataset.contributorId = contributor.id;
    const initials = String(contributor.displayName || '读者').trim().slice(0, 2) || '读';
    const assetCount = Number(contributor.assetCount || 0);
    const helpfulCount = Number(contributor.helpfulCount || 0);
    const helpfulAssets = Number(contributor.helpfulAssets || 0);
    const metaParts = [`${assetCount} 条公开资产`];
    if (helpfulCount > 0) metaParts.push(`有用 ${helpfulCount} 次`);
    metaParts.push(`最近 ${formatAssetTime(contributor.latestAt)}`);
    card.innerHTML = `
      <div class="contributor-avatar">${escapeHtml(initials)}</div>
      <div class="contributor-main">
        <div class="contributor-name">${escapeHtml(contributor.displayName || '读者')}</div>
        <div class="contributor-meta">${escapeHtml(metaParts.join(' · '))}</div>
        <div class="contributor-stats">
          <span>中译 ${Number(contributor.translationCount || 0)}</span>
          <span>重写 ${Number(contributor.rewriteCount || 0)}</span>
          <span>点评 ${Number(contributor.commentCount || 0)}</span>
          <span>对话 ${Number(contributor.chatCount || 0)}</span>
          ${helpfulCount > 0 ? `<span class="contributor-stat-helpful">认可 ${helpfulAssets || 1}</span>` : ''}
        </div>
      </div>
      <div class="contributor-actions">
        <a class="contributor-rss-button" data-contributor-rss="${escapeHtml(contributor.id)}" href="${escapeHtml(contributorFeedUrlFor(contributor.id).href)}" target="_blank" rel="noopener" title="订阅贡献者 RSS" aria-label="订阅贡献者 RSS">RSS</a>
        <button type="button" class="asset-copy-link contributor-copy" data-contributor-copy="${escapeHtml(contributor.id)}" title="复制贡献者链接" aria-label="复制贡献者链接">⧉</button>
      </div>
    `;
    card.onclick = (event) => {
      if (event.target.closest('[data-contributor-rss]')) return;
      const copy = event.target.closest('[data-contributor-copy]');
      if (copy) {
        copyText(contributorUrlFor(copy.dataset.contributorCopy).href, '贡献者链接已复制');
        return;
      }
      openContributor(contributor.id);
    };
    frag.appendChild(card);
  }
  el.appendChild(frag);
}

function renderList() {
  if (state.view === 'contributors') {
    renderContributorDirectory();
    return;
  }
  const list = visibleEntries();
  const el = $('#entry-list');
  el.innerHTML = '';
  renderAssetActivityStrip();
  if (!list.length) {
    const assetScope = state.assetFilter ? `${assetDirectoryLabel(state.assetFilter)}资产` : '公开资产';
    const text = state.view === 'assets' && state.q
      ? `没有匹配“${escapeHtml(state.q)}”的${assetScope}<br/>换个关键词试试`
      : state.view === 'assets' && state.assetFilter
      ? `还没有${assetScope}<br/>换个类型或先沉淀一篇文章`
      : state.view === 'assets'
      ? '还没有沉淀资产<br/>先翻译、重写、点评或对话一篇文章'
      : state.view === 'history'
      ? '还没有浏览记录<br/>打开几篇文章后会出现在这里'
      : '这里空空如也<br/>试试刷新或切换视图';
    el.innerHTML = `<div class="list-empty">${text}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const src = sourceById(e.sourceId);
    const assetsHtml = assetBadgesHtml(e, { interactive: true, copyable: true });
    const entryActivity = assetActivityLabel(e) || entryHistoryLabel(e);
    const assetPreview = assetPreviewForEntry(e);
    const assetItems = assetItemListHtml(e);
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
        ${assetItems || (assetPreview ? assetPreviewHtml(assetPreview) : '')}
        ${entryActivity ? `<div class="entry-asset-activity">${escapeHtml(entryActivity)}</div>` : ''}
      </div>
      ${e.image ? `<img class="entry-thumb" src="${escapeHtml(e.image)}" loading="lazy" onerror="this.remove()" />` : ''}`;
    card.onclick = (event) => {
      const previewCopy = event.target.closest('[data-asset-preview-copy]');
      if (previewCopy) {
        event.preventDefault();
        event.stopPropagation();
        const url = assetItemUrl(previewCopy.dataset.assetPreviewCopy, e, previewCopy.dataset.assetItemId || '');
        const label = ASSET_FOCUS_LABELS[previewCopy.dataset.assetPreviewCopy] || '资产';
        copyText(url, `${label}链接已复制`);
        return;
      }
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
        const itemId = asset.dataset.assetItemId || '';
        const focus = asset.dataset.asset;
        openEntry(e, {
          focus,
          aiAssetId: focus === 'translation' || focus === 'rewrite' ? itemId : '',
          commentId: focus === 'comments' ? itemId : '',
          chatMessageId: focus === 'chat' ? itemId : '',
        });
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
  else if (state.view === 'history') title = '浏览记录';
  else if (state.view === 'assets') {
    const prefix = state.assetSort === 'helpful' ? '有用 · ' : '';
    title = `${prefix}${state.assetFilter ? `${assetDirectoryLabel(state.assetFilter)}资产` : '公开资产'}`;
  }
  else if (state.view === 'contributors') title = '贡献者';
  if (state.q) title += ` · “${state.q}”`;
  $('#list-title').textContent = title;
  updateSearchPlaceholder();
}

function updateSearchPlaceholder() {
  const search = $('#search');
  if (!search) return;
  search.placeholder = state.view === 'contributors' ? '搜索贡献者…' : state.view === 'assets' ? '搜索资产…' : '搜索文章…';
  if (search.value !== state.q) search.value = state.q;
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
  if (!preserveFocus) {
    state.readerFocus = null;
    state.readerAssetId = '';
  }
  setReaderTab(tab, { replaceUrl });
  if (tab !== 'translation' || state.translation) return;
  if (state.translationLoading) {
    state.pendingTranslationGenerate = true;
    return;
  }
  generateTranslation();
}

function entryAssetHasContent(type, asset) {
  if (type === 'translation') return Boolean(asset && Array.isArray(asset.content) && asset.content.length);
  if (type === 'rewrite') return Boolean(asset && asset.body);
  return false;
}

function assetPreviewFromCurrent(type, asset) {
  if (!entryAssetHasContent(type, asset)) return null;
  const text = type === 'translation'
    ? asset.content.map(pair => pair && pair.target).find(Boolean)
    : asset.body;
  const previewText = assetSummaryText(text || '');
  if (!previewText) return null;
  return {
    type,
    id: asset.id || state.readerAssetId || '',
    role: '',
    author: asset.createdBy || '',
    title: type === 'translation' ? asset.titleZh || '' : asset.title || '',
    model: asset.model || '',
    text: previewText,
    at: Number(asset.updatedAt || asset.createdAt || 0) || Date.now(),
    helpfulCount: Number(asset.helpfulCount) || 0,
  };
}

function topHelpfulAssetPreview(items) {
  return items
    .filter(item => item && Number(item.helpfulCount || 0) > 0)
    .sort((a, b) => (Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0)) || (Number(b.at || 0) - Number(a.at || 0)))[0] || null;
}

function helpfulAiAssetItemCount(assets, type) {
  const items = assets && assets.items && Array.isArray(assets.items[type]) ? assets.items[type] : [];
  if (items.length) {
    return items.reduce((sum, item) => sum + (Number(item && item.helpfulCount) > 0 ? 1 : 0), 0);
  }
  const count = type === 'translation' ? assets && assets.translationHelpfulCount : assets && assets.rewriteHelpfulCount;
  return Number(count) > 0 ? 1 : 0;
}

function entryAssetHelpfulPatch(type, asset, entry = state.activeEntry) {
  const assets = mergeAssets(entry);
  const nextCount = Number(asset && asset.helpfulCount) || 0;
  const commentHelpfulCount = Number(assets.commentHelpfulCount) || 0;
  const chatHelpfulCount = Number(assets.chatHelpfulCount) || 0;
  const previews = { ...(assets.previews || {}) };
  const preview = assetPreviewFromCurrent(type, asset) || previews[type] || null;
  const assetId = String((asset && asset.id) || state.readerAssetId || '').trim();
  const items = { ...(assets.items || {}) };
  let typeItems = Array.isArray(items[type]) ? items[type].map(item => ({ ...item })) : [];
  if (preview && assetId) {
    let found = false;
    typeItems = typeItems.map(item => {
      if (item.id !== assetId) return item;
      found = true;
      return { ...item, ...preview, id: assetId, helpfulCount: nextCount };
    });
    if (!found) typeItems.unshift({ ...preview, id: assetId, helpfulCount: nextCount });
    items[type] = typeItems;
  }
  if (preview) {
    const currentPreview = previews[type];
    const shouldUpdatePreview = !assetId
      || !currentPreview
      || currentPreview.id === assetId
      || Number(preview.at || 0) >= Number(currentPreview.at || 0);
    if (shouldUpdatePreview) previews[type] = { ...preview, helpfulCount: nextCount };
  }
  const typeHelpfulCount = typeItems.length
    ? typeItems.reduce((sum, item) => sum + (Number(item.helpfulCount) || 0), 0)
    : nextCount;
  const translationHelpfulCount = type === 'translation' ? typeHelpfulCount : Number(assets.translationHelpfulCount) || 0;
  const rewriteHelpfulCount = type === 'rewrite' ? typeHelpfulCount : Number(assets.rewriteHelpfulCount) || 0;

  const topHelpfulTranslation = type === 'translation'
    ? topHelpfulAssetPreview(typeItems.length ? typeItems : [previews.translation])
    : assets.topHelpfulTranslation;
  const topHelpfulRewrite = type === 'rewrite'
    ? topHelpfulAssetPreview(typeItems.length ? typeItems : [previews.rewrite])
    : assets.topHelpfulRewrite;
  const topHelpfulAsset = topHelpfulAssetPreview([
    topHelpfulTranslation,
    topHelpfulRewrite,
    assets.topHelpfulComment,
    assets.topHelpfulChat,
  ]);
  const primaryPreview = preview && (
    !assets.preview
    || assets.preview.type === type
    || Number(preview.at || 0) >= Number(assets.preview.at || 0)
  ) ? previews[type] : assets.preview;

  return {
    [type]: entryAssetHasContent(type, asset) || Boolean(assets[type]),
    items,
    previews,
    preview: primaryPreview || null,
    translationHelpfulCount,
    rewriteHelpfulCount,
    helpfulAssets: helpfulAiAssetItemCount({ ...assets, items, translationHelpfulCount, rewriteHelpfulCount }, 'translation')
      + helpfulAiAssetItemCount({ ...assets, items, translationHelpfulCount, rewriteHelpfulCount }, 'rewrite'),
    helpfulCount: translationHelpfulCount + rewriteHelpfulCount + commentHelpfulCount + chatHelpfulCount,
    topHelpfulTranslation,
    topHelpfulRewrite,
    topHelpfulAsset,
  };
}

function renderAssetHelpfulButton(type, asset) {
  const btn = $(`#${type}-helpful`);
  if (!btn) return;
  const hasContent = entryAssetHasContent(type, asset);
  btn.classList.toggle('hidden', !hasContent);
  btn.disabled = !hasContent;
  if (!hasContent) {
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '有用';
    return;
  }
  const helpfulCount = Number(asset.helpfulCount) || 0;
  const active = Boolean(asset.helpfulByMe);
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.textContent = helpfulCount ? `有用 ${helpfulCount}` : '有用';
  btn.title = active ? '取消有用标记' : '觉得这个资产有用';
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
  renderAssetHelpfulButton('translation', state.translation);
  if (loading) {
    empty.classList.remove('hidden');
    if (emptyText) emptyText.textContent = '正在检查这篇文章的翻译缓存…';
    action.disabled = true;
    action.textContent = '检查中…';
    $('#translation-meta').textContent = '检查中';
    renderAssetHelpfulButton('translation', null);
    return;
  }
  if (!hasContent) {
    empty.classList.remove('hidden');
    if (emptyText) emptyText.textContent = '这篇文章还没有中文翻译。';
    action.disabled = false;
    action.textContent = '生成中文翻译';
    $('#translation-meta').textContent = '暂无';
    renderAssetHelpfulButton('translation', null);
    return;
  }
  empty.classList.add('hidden');
  action.disabled = false;
  action.textContent = translation.stale ? '更新中文翻译' : '重新生成中文翻译';
  $('#translation-meta').textContent = [translation.stale ? '原文已更新' : '', translation.createdBy, translation.model, formatAssetTime(translation.updatedAt)].filter(Boolean).join(' · ');
  renderAssetHelpfulButton('translation', state.translation);
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
    const assetId = state.readerFocus === 'translation' ? state.readerAssetId : '';
    const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
    const data = await api(`/api/entry/${entry.id}/translation${query}`);
    if (state.activeEntry?.id !== entry.id) return;
    renderTranslation(data.translation);
    if (data.translation && Array.isArray(data.translation.content) && data.translation.content.length) {
      updateEntryAssets(entry.id, entryAssetHelpfulPatch('translation', data.translation), { rerenderList: false });
      renderList();
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
  renderAssetHelpfulButton('rewrite', state.rewrite);
  if (!rewrite || !rewrite.body) {
    empty.classList.remove('hidden');
    $('#rewrite-meta').textContent = '暂无';
    $('#reader-rewrite').textContent = '生成乔木风格重写';
    renderAssetHelpfulButton('rewrite', null);
    return;
  }
  empty.classList.add('hidden');
  $('#reader-rewrite').textContent = rewrite.stale ? '更新乔木风格重写' : '重新生成乔木风格重写';
  $('#rewrite-meta').textContent = [rewrite.stale ? '原文/链接已更新' : '', rewrite.createdBy, rewrite.model, formatAssetTime(rewrite.updatedAt)].filter(Boolean).join(' · ');
  renderAssetHelpfulButton('rewrite', state.rewrite);
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
    const assetId = state.readerFocus === 'rewrite' ? state.readerAssetId : '';
    const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
    const data = await api(`/api/entry/${entry.id}/rewrite${query}`);
    if (state.activeEntry?.id !== entry.id) return;
    renderRewrite(data.rewrite);
    if (data.rewrite && data.rewrite.body) {
      updateEntryAssets(entry.id, entryAssetHelpfulPatch('rewrite', data.rewrite), { rerenderList: false });
      renderList();
    }
  } catch {
    renderRewrite(null);
  }
}

async function toggleEntryAssetHelpful(type) {
  const entry = state.activeEntry;
  const asset = type === 'translation' ? state.translation : type === 'rewrite' ? state.rewrite : null;
  if (!entry || !entryAssetHasContent(type, asset)) return;
  if (!requireAuth('login')) return;
  const btn = $(`#${type}-helpful`);
  const nextHelpful = !asset.helpfulByMe;
  const assetId = String(asset.id || state.readerAssetId || '').trim();
  if (btn) btn.disabled = true;
  try {
    const data = await api(`/api/entry/${entry.id}/assets/${encodeURIComponent(type)}/helpful`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helpful: nextHelpful, assetId }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    const nextAsset = state.readerAssetId && (type === 'translation' || type === 'rewrite')
      ? { ...asset, ...(data.reaction || {}) }
      : data[type] || { ...asset, ...(data.reaction || {}) };
    if (type === 'translation') renderTranslation(nextAsset);
    if (type === 'rewrite') renderRewrite(nextAsset);
    updateEntryAssets(entry.id, entryAssetHelpfulPatch(type, nextAsset, state.activeEntry), { rerenderList: false });
    renderList();
    toast(nextHelpful ? '已标记有用' : '已取消有用标记');
  } catch (err) {
    toast('反馈失败: ' + err.message, 5000);
  } finally {
    renderAssetHelpfulButton(type, type === 'translation' ? state.translation : state.rewrite);
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
  state.readerAssetId = '';
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
    if (data.entry) applyServerEntryUpdate(data.entry);
    renderTranslation(data.translation);
    if (data.translation && Array.isArray(data.translation.content) && data.translation.content.length) {
      updateEntryAssets(entry.id, entryAssetHelpfulPatch('translation', data.translation), { rerenderList: false });
      renderList();
    }
    setReaderTab('translation');
    toast(data.originalFetched ? '已获取原文并保存双语翻译' : data.cached ? '已显示缓存翻译' : '双语翻译已保存');
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
  state.readerAssetId = '';
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
    if (data.entry) applyServerEntryUpdate(data.entry);
    renderRewrite(data.rewrite);
    if (data.rewrite && data.rewrite.body) {
      updateEntryAssets(entry.id, entryAssetHelpfulPatch('rewrite', data.rewrite), { rerenderList: false });
      renderList();
    }
    setReaderTab('rewrite');
    toast(data.originalFetched ? '已获取原文并保存乔木风格重写' : data.cached ? '已显示缓存重写' : '乔木风格重写已保存');
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
  const sortedComments = sortComments(comments);
  const canWrite = Boolean(state.me);
  $('#comments-count').textContent = comments.length ? `${comments.length} 条` : '暂无';
  $$('.comment-sort-btn').forEach(btn => {
    const active = btn.dataset.commentSort === state.commentSort;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('#comment-form').classList.toggle('hidden', !canWrite);
  $('#comment-gate').classList.toggle('hidden', canWrite);
  if (!comments.length) {
    list.innerHTML = '<div class="comments-empty">还没有人工点评</div>';
    return;
  }
  list.innerHTML = sortedComments.map(comment => {
    const display = commentDisplayParts(comment.body);
    const isEditing = state.editingCommentId === comment.id;
    const editedAt = Number(comment.updatedAt || 0) > Number(comment.createdAt || 0)
      ? ` · 已编辑 ${formatAssetTime(comment.updatedAt)}`
      : '';
    const helpfulCount = Number(comment.helpfulCount || 0);
    const helpfulActive = Boolean(comment.helpfulByMe);
    const authorHtml = comment.contributorId
      ? `<button type="button" class="contributor-inline" data-contributor-id="${escapeHtml(comment.contributorId)}">${escapeHtml(comment.contributorName || comment.author)}</button>`
      : escapeHtml(comment.author);
    return `
      <div id="comment-${escapeHtml(comment.id)}" class="comment-item${display.type ? ` comment-type-${display.type}` : ''}">
        <div class="comment-head">
          <div class="comment-head-left">
            ${display.label ? `<span class="comment-kind">${escapeHtml(display.label)}</span>` : ''}
            <div class="comment-meta">${authorHtml} · ${formatAssetTime(comment.createdAt)}${escapeHtml(editedAt)}</div>
          </div>
          <div class="comment-actions">
            <button type="button" class="comment-action comment-link-copy" data-comment-link="${escapeHtml(comment.id)}" title="复制这条点评链接" aria-label="复制这条点评链接">#</button>
            <button type="button" class="comment-action comment-copy" data-comment-copy="${escapeHtml(comment.id)}" title="复制这条点评" aria-label="复制这条点评">⧉</button>
            ${comment.canEdit && !isEditing ? `<button type="button" class="comment-action comment-edit" data-comment-edit="${escapeHtml(comment.id)}" title="编辑这条点评" aria-label="编辑这条点评">✎</button>` : ''}
            ${comment.canDelete && !isEditing ? `<button type="button" class="comment-action comment-action-danger" data-comment-delete="${escapeHtml(comment.id)}" title="撤回这条点评" aria-label="撤回这条点评">×</button>` : ''}
          </div>
        </div>
        ${isEditing ? `
          <div class="comment-edit-box">
            <textarea class="comment-edit-input" data-comment-edit-input="${escapeHtml(comment.id)}" rows="4">${escapeHtml(comment.body)}</textarea>
            <div class="comment-edit-actions">
              <button type="button" class="comment-edit-save" data-comment-save="${escapeHtml(comment.id)}">保存</button>
              <button type="button" class="comment-edit-cancel" data-comment-cancel="${escapeHtml(comment.id)}">取消</button>
            </div>
          </div>
        ` : `<div class="comment-body">${renderMarkdownLite(display.body)}</div>`}
        <div class="comment-feedback">
          <button type="button" class="comment-helpful${helpfulActive ? ' active' : ''}" data-comment-helpful="${escapeHtml(comment.id)}" aria-pressed="${helpfulActive ? 'true' : 'false'}" title="${helpfulActive ? '取消有用标记' : '标记这条点评有用'}">有用${helpfulCount ? ` ${helpfulCount}` : ''}</button>
        </div>
      </div>`;
  }).join('');
  renderReaderAssetSummary();
  highlightCommentFromRoute();
  settlePendingAssetJump('comments');
}

function sortComments(comments) {
  const list = [...(comments || [])];
  if (state.commentSort === 'latest') {
    return list.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }
  return list.sort((a, b) => {
    const helpfulDelta = Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0);
    if (helpfulDelta) return helpfulDelta;
    const activityDelta = Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
    if (activityDelta) return activityDelta;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

function setCommentSort(sort) {
  if (!COMMENT_SORTS.includes(sort) || state.commentSort === sort) return;
  state.commentSort = sort;
  storage.setItem('qm_comment_sort', sort);
  renderComments();
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

function plainSnippet(value, max = 220) {
  const text = String(value || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
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

function myAssetUrl(type, item) {
  if (!item) return '';
  const entry = item.entry || { id: item.entryId };
  if (type === 'translation' || type === 'rewrite') return readerAssetUrl(type, entry, item.id);
  if (type === 'chat') return chatMessageUrl(item.id, entry);
  return commentUrl(item.id, entry);
}

function myPublicProfileUrl() {
  if (!state.me || !state.me.id) return '';
  return contributorUrlFor(state.me.id, {
    sort: state.myAssetSort,
    tab: state.myAssetTab,
  }).href;
}

function myPublicRssUrl() {
  if (!state.me || !state.me.id) return '';
  return contributorFeedUrlFor(state.me.id).href;
}

function normalizeUserAssetTab(type) {
  return ASSET_FILTER_TYPES.includes(type) ? type : 'translation';
}

function userAssetLabel(type) {
  return ASSET_DIRECTORY_LABELS[type] || ASSET_TYPE_LABELS[type] || '资产';
}

function myAssetCounts() {
  return {
    translation: (state.myTranslations || []).length,
    rewrite: (state.myRewrites || []).length,
    comments: (state.myComments || []).length,
    chat: (state.myChatMessages || []).length,
  };
}

function renderMyAssetTabs() {
  const counts = myAssetCounts();
  $('#my-translation-count').textContent = counts.translation;
  $('#my-rewrite-count').textContent = counts.rewrite;
  $('#my-comments-count').textContent = counts.comments;
  $('#my-chat-count').textContent = counts.chat;
  $$('#my-comments-modal [data-my-asset-tab]').forEach(btn => {
    const active = btn.dataset.myAssetTab === state.myAssetTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('#my-comments-modal [data-my-asset-sort]').forEach(btn => {
    const active = normalizeUserAssetSort(btn.dataset.myAssetSort) === state.myAssetSort;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  renderMyPublicProfileActions();
}

function renderMyPublicProfileActions() {
  const url = myPublicProfileUrl();
  const rssUrl = myPublicRssUrl();
  const link = $('#my-public-profile-link');
  const rss = $('#my-public-rss-link');
  const copy = $('#my-public-profile-copy');
  const rssCopy = $('#my-public-rss-copy');
  if (link) {
    link.classList.toggle('hidden', !url);
    link.href = url || '#';
  }
  if (rss) {
    rss.classList.toggle('hidden', !rssUrl);
    rss.href = rssUrl || '#';
  }
  if (copy) copy.classList.toggle('hidden', !url);
  if (rssCopy) rssCopy.classList.toggle('hidden', !rssUrl);
}

function renderMyAssets() {
  const list = $('#my-comments-list');
  if (!list) return;
  renderMyAssetTabs();
  const type = normalizeUserAssetTab(state.myAssetTab);
  const items = myAssetItemsForTab(type);
  if (!items.length) {
    list.innerHTML = `<div class="my-comments-empty">还没有沉淀过公开${escapeHtml(userAssetLabel(type))}</div>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const entry = item.entry || {};
    const display = userAssetDisplay(type, item);
    const title = type === 'translation'
      ? (item.titleZh || entry.titleZh || entry.title || '未命名文章')
      : type === 'rewrite'
        ? (item.title || entry.titleZh || entry.title || '未命名文章')
        : (entry.titleZh || entry.title || '未命名文章');
    const meta = type === 'chat' ? [
      sourceName(entry.sourceId),
      item.author,
      item.model,
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
      formatAssetTime(item.createdAt),
    ].filter(Boolean).join(' · ') : type === 'comments' ? [
      sourceName(entry.sourceId),
      Number(item.updatedAt || 0) > Number(item.createdAt || 0)
        ? `编辑 ${formatAssetTime(item.updatedAt)}`
        : formatAssetTime(item.createdAt),
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
    ].filter(Boolean).join(' · ') : [
      sourceName(entry.sourceId),
      item.author,
      item.model,
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
      Number(item.updatedAt || 0) > Number(item.createdAt || 0)
        ? formatAssetTime(item.updatedAt)
        : formatAssetTime(item.createdAt),
    ].filter(Boolean).join(' · ');
    return `
      <article class="my-comment-item">
        <div class="my-comment-head">
          <div class="my-comment-title">
            ${display.label ? `<span class="comment-kind">${escapeHtml(display.label)}</span>` : ''}
            <strong>${escapeHtml(title)}</strong>
          </div>
          <span class="my-comment-meta">${escapeHtml(meta)}</span>
        </div>
        <p class="my-comment-body">${escapeHtml(plainSnippet(display.body || item.bodySnippet || item.contentSnippet || item.body || item.content, 260))}</p>
        <div class="my-comment-actions">
          <button type="button" class="ghost-btn" data-my-asset-open="${escapeHtml(item.id)}">打开文章</button>
          <button type="button" class="ghost-btn" data-my-asset-copy-content="${escapeHtml(item.id)}">⧉ 复制内容</button>
          <button type="button" class="ghost-btn" data-my-asset-copy="${escapeHtml(item.id)}">⧉ 复制链接</button>
        </div>
      </article>`;
  }).join('');
}

async function openMyCommentsModal() {
  if (!requireAuth('login')) return;
  $('#my-comments-modal').classList.remove('hidden');
  renderMyAssetTabs();
  $('#my-comments-list').innerHTML = '<div class="my-comments-empty">正在读取我的资产…</div>';
  try {
    const [translationData, rewriteData, commentData, chatData] = await Promise.all([
      api('/api/me/translations?limit=100'),
      api('/api/me/rewrites?limit=100'),
      api('/api/me/comments?limit=100'),
      api('/api/me/chat-messages?limit=100'),
    ]);
    state.myTranslations = translationData.translations || [];
    state.myRewrites = rewriteData.rewrites || [];
    state.myComments = commentData.comments || [];
    state.myChatMessages = chatData.messages || [];
    renderMyAssets();
  } catch (err) {
    $('#my-comments-list').innerHTML = `<div class="my-comments-empty">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

function closeMyCommentsModal() {
  $('#my-comments-modal').classList.add('hidden');
}

function myAssetItemsForTab(type) {
  const items = type === 'translation'
    ? state.myTranslations || []
    : type === 'rewrite'
    ? state.myRewrites || []
    : type === 'chat'
    ? state.myChatMessages || []
    : state.myComments || [];
  return sortAssetItems(items, state.myAssetSort);
}

function myAssetItemsForCurrentTab() {
  return myAssetItemsForTab(normalizeUserAssetTab(state.myAssetTab));
}

function userAssetDisplay(type, item) {
  if (type === 'translation') return { label: '中文翻译', body: item.contentSnippet || item.summaryZh || '' };
  if (type === 'rewrite') return { label: '乔木重写', body: item.bodySnippet || '' };
  if (type === 'chat') return { label: item.role === 'assistant' ? '回答' : '提问', body: item.content || item.contentSnippet || '' };
  return commentDisplayParts(item.body || item.bodySnippet || '');
}

function translationAssetText(translation, item = {}) {
  const content = translation && Array.isArray(translation.content) ? translation.content : [];
  return [
    translation?.titleZh || item.titleZh || '',
    translation?.summaryZh || item.summaryZh || '',
    ...content.map(pair => String(pair && pair.target || '').trim()).filter(Boolean),
  ].map(part => String(part || '').trim()).filter(Boolean).join('\n\n');
}

function assetContentText(type, item, fullAsset = null) {
  if (!item) return '';
  const assetType = normalizeUserAssetTab(type);
  if (assetType === 'translation') return translationAssetText(fullAsset || item, item);
  if (assetType === 'rewrite') return String((fullAsset && fullAsset.body) || item.body || item.bodySnippet || '').trim();
  if (assetType === 'chat') {
    const label = item.role === 'assistant' ? '回答' : '提问';
    const content = String(item.content || item.contentSnippet || '').trim();
    return content ? `${label}：\n${content}` : '';
  }
  return String(item.body || item.bodySnippet || '').trim();
}

async function fullAiAssetForCopy(type, item) {
  const assetType = normalizeUserAssetTab(type);
  if (!item || !item.id || !['translation', 'rewrite'].includes(assetType)) return null;
  const entryId = item.entry?.id || item.entryId;
  if (!entryId) return null;
  const endpoint = assetType === 'translation' ? 'translation' : 'rewrite';
  const data = await api(`/api/entry/${encodeURIComponent(entryId)}/${endpoint}?assetId=${encodeURIComponent(item.id)}`);
  return data && data[endpoint] ? data[endpoint] : null;
}

async function copyAssetContent(type, item) {
  const assetType = normalizeUserAssetTab(type);
  if (!item) {
    toast('找不到这条资产');
    return;
  }
  try {
    const fullAsset = await fullAiAssetForCopy(assetType, item);
    const text = assetContentText(assetType, item, fullAsset);
    if (!text) {
      toast('这条资产没有可复制的内容');
      return;
    }
    copyText(text, `${userAssetLabel(assetType)}内容已复制`);
  } catch (err) {
    toast('复制内容失败: ' + err.message, 5000);
  }
}

async function openMyAsset(itemId) {
  const item = myAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  const entryId = item && (item.entry?.id || item.entryId);
  if (!entryId) {
    toast('找不到这条资产对应的文章');
    return;
  }
  closeMyCommentsModal();
  const type = normalizeUserAssetTab(state.myAssetTab);
  const ok = type === 'translation' || type === 'rewrite'
    ? await openEntryById(entryId, { focus: type, aiAssetId: item.id, updateUrl: true, replaceUrl: false })
    : type === 'chat'
    ? await openEntryById(entryId, { focus: 'chat', chatMessageId: itemId, updateUrl: true, replaceUrl: false })
    : await openEntryById(entryId, { focus: 'comments', commentId: itemId, updateUrl: true, replaceUrl: false });
  if (!ok) toast('找不到这篇文章');
}

function copyMyAssetLink(itemId) {
  const item = myAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  const url = myAssetUrl(state.myAssetTab, item);
  if (!url) {
    toast('找不到这条资产链接');
    return;
  }
  copyText(url, `${userAssetLabel(normalizeUserAssetTab(state.myAssetTab))}链接已复制`);
}

function copyMyAssetContent(itemId) {
  const item = myAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  copyAssetContent(state.myAssetTab, item);
}

function copyMyPublicProfileLink() {
  const url = myPublicProfileUrl();
  if (!url) {
    toast('还没有可复制的公开资产页');
    return;
  }
  copyText(url, '我的公开资产页已复制');
}

function copyMyPublicRssLink() {
  const url = myPublicRssUrl();
  if (!url) {
    toast('还没有可复制的公开资产 RSS');
    return;
  }
  copyText(url, '我的公开资产 RSS 已复制');
}

function contributorAssetItemsForCurrentTab() {
  const type = normalizeUserAssetTab(state.contributor.tab);
  const items = type === 'translation'
    ? state.contributor.translations || []
    : type === 'rewrite'
    ? state.contributor.rewrites || []
    : type === 'chat'
    ? state.contributor.messages || []
    : state.contributor.comments || [];
  return sortContributorAssets(items, state.contributor.sort);
}

function renderContributorTabs() {
  const translationCount = (state.contributor.translations || []).length;
  const rewriteCount = (state.contributor.rewrites || []).length;
  const commentCount = (state.contributor.comments || []).length;
  const chatCount = (state.contributor.messages || []).length;
  $('#contributor-translation-count').textContent = translationCount;
  $('#contributor-rewrite-count').textContent = rewriteCount;
  $('#contributor-comments-count').textContent = commentCount;
  $('#contributor-chat-count').textContent = chatCount;
  $$('#contributor-modal [data-contributor-tab]').forEach(btn => {
    const active = btn.dataset.contributorTab === state.contributor.tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('#contributor-modal [data-contributor-asset-sort]').forEach(btn => {
    const active = normalizeContributorAssetSort(btn.dataset.contributorAssetSort) === state.contributor.sort;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function assetItemTime(item) {
  return Math.max(Number(item && item.updatedAt) || 0, Number(item && item.createdAt) || 0, Number(item && item.at) || 0);
}

function sortContributorAssets(items, sort = 'latest') {
  return sortAssetItems(items, sort);
}

function sortAssetItems(items, sort = 'latest') {
  const assetSort = normalizeAssetSort(sort);
  return [...(items || [])].sort((a, b) => {
    if (assetSort === 'helpful') {
      const helpfulDelta = Number(b && b.helpfulCount || 0) - Number(a && a.helpfulCount || 0);
      if (helpfulDelta) return helpfulDelta;
    }
    return assetItemTime(b) - assetItemTime(a);
  });
}

function syncContributorUrl({ replace = true } = {}) {
  const id = state.contributor.id || (state.contributor.profile && state.contributor.profile.id);
  if (!id || !window.location.pathname.startsWith('/contributors/')) return;
  const url = contributorUrlFor(id, { sort: state.contributor.sort, tab: state.contributor.tab });
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ contributorId: id }, '', url);
}

function contributorPageTitle() {
  const profile = state.contributor.profile;
  if (!profile) return '贡献者资产 · QMReader';
  const sortPrefix = state.contributor.sort === 'helpful' ? '有用 · ' : '';
  const tab = normalizeUserAssetTab(state.contributor.tab);
  const label = tab === 'translation' ? '公开资产' : userAssetLabel(tab);
  return `${sortPrefix}${profile.displayName} 的${label} · QMReader`;
}

function renderContributorAssets() {
  const list = $('#contributor-list');
  if (!list) return;
  const profile = state.contributor.profile;
  const rssLink = $('#contributor-rss-link');
  const rssCopy = $('#contributor-rss-copy');
  const linkCopy = $('#contributor-link-copy');
  const rssUrl = profile ? contributorFeedUrlFor(profile.id).href : '';
  const helpfulCount = Number(profile && profile.helpfulCount) || 0;
  const helpfulAssets = Number(profile && profile.helpfulAssets) || 0;
  $('#contributor-title').textContent = profile ? `${profile.displayName} 的公开资产` : '贡献者资产';
  $('#contributor-subtitle').textContent = profile
    ? `公开沉淀的翻译、重写、点评和文章对话。${helpfulCount ? `获得 ${helpfulCount} 次有用反馈，覆盖 ${helpfulAssets} 条资产。` : ''}`
    : '正在读取公开资产…';
  if (rssLink) {
    rssLink.classList.toggle('hidden', !rssUrl);
    rssLink.href = rssUrl || '#';
  }
  if (rssCopy) rssCopy.classList.toggle('hidden', !rssUrl);
  if (linkCopy) linkCopy.classList.toggle('hidden', !profile);
  renderContributorTabs();
  if (state.contributor.loading) {
    list.innerHTML = '<div class="my-comments-empty">正在读取贡献者资产…</div>';
    return;
  }
  const type = normalizeUserAssetTab(state.contributor.tab);
  const items = contributorAssetItemsForCurrentTab();
  if (!items.length) {
    list.innerHTML = `<div class="my-comments-empty">还没有公开${escapeHtml(userAssetLabel(type))}</div>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const entry = item.entry || {};
    const display = userAssetDisplay(type, item);
    const title = type === 'translation'
      ? (item.titleZh || entry.titleZh || entry.title || '未命名文章')
      : type === 'rewrite'
        ? (item.title || entry.titleZh || entry.title || '未命名文章')
        : (entry.titleZh || entry.title || '未命名文章');
    const meta = type === 'chat' ? [
      sourceName(entry.sourceId),
      item.author,
      item.model,
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
      formatAssetTime(item.createdAt),
    ].filter(Boolean).join(' · ') : type === 'comments' ? [
      sourceName(entry.sourceId),
      Number(item.updatedAt || 0) > Number(item.createdAt || 0)
        ? `编辑 ${formatAssetTime(item.updatedAt)}`
        : formatAssetTime(item.createdAt),
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
    ].filter(Boolean).join(' · ') : [
      sourceName(entry.sourceId),
      item.author,
      item.model,
      Number(item.helpfulCount || 0) ? `有用 ${Number(item.helpfulCount)}` : '',
      Number(item.updatedAt || 0) > Number(item.createdAt || 0)
        ? formatAssetTime(item.updatedAt)
        : formatAssetTime(item.createdAt),
    ].filter(Boolean).join(' · ');
    return `
      <article class="my-comment-item">
        <div class="my-comment-head">
          <div class="my-comment-title">
            ${display.label ? `<span class="comment-kind">${escapeHtml(display.label)}</span>` : ''}
            <strong>${escapeHtml(title)}</strong>
          </div>
          <span class="my-comment-meta">${escapeHtml(meta)}</span>
        </div>
        <p class="my-comment-body">${escapeHtml(plainSnippet(display.body || item.bodySnippet || item.contentSnippet || item.body || item.content, 260))}</p>
        <div class="my-comment-actions">
          <button type="button" class="ghost-btn" data-contributor-asset-open="${escapeHtml(item.id)}">打开文章</button>
          <button type="button" class="ghost-btn" data-contributor-asset-copy-content="${escapeHtml(item.id)}">⧉ 复制内容</button>
          <button type="button" class="ghost-btn" data-contributor-asset-copy="${escapeHtml(item.id)}">⧉ 复制链接</button>
        </div>
      </article>`;
  }).join('');
}

async function openContributor(contributorId, { push = true, sort = state.contributor.sort, tab = state.contributor.tab } = {}) {
  const id = String(contributorId || '').trim();
  if (!id) return;
  const contributorAssetSort = normalizeContributorAssetSort(sort);
  const contributorAssetTab = normalizeUserAssetTab(tab);
  state.contributor = { id, profile: null, translations: [], rewrites: [], comments: [], messages: [], tab: contributorAssetTab, sort: contributorAssetSort, loading: true };
  $('#contributor-modal').classList.remove('hidden');
  renderContributorAssets();
  try {
    const data = await api(`/api/contributors/${encodeURIComponent(id)}?limit=100`);
    if (state.contributor.id !== id) return;
    state.contributor = {
      id,
      profile: data.contributor || null,
      translations: data.translations || [],
      rewrites: data.rewrites || [],
      comments: data.comments || [],
      messages: data.messages || [],
      tab: contributorAssetTab,
      sort: contributorAssetSort,
      loading: false,
    };
    renderContributorAssets();
    document.title = contributorPageTitle();
    if (push) history.pushState({ contributorId: id }, '', contributorUrlFor(id, { sort: state.contributor.sort, tab: state.contributor.tab }));
  } catch (err) {
    if (state.contributor.id !== id) return;
    state.contributor.loading = false;
    $('#contributor-list').innerHTML = `<div class="my-comments-empty">读取失败：${escapeHtml(err.message)}</div>`;
    toast('读取贡献者资产失败: ' + err.message, 5000);
  }
}

function closeContributorModal({ clearUrl = true } = {}) {
  $('#contributor-modal').classList.add('hidden');
  if (clearUrl && window.location.pathname.startsWith('/contributors/')) {
    const url = state.activeEntry ? readerUrlFor(state.activeEntry, state.readerTab, state.readerFocus) : listUrlFor();
    history.pushState({}, '', url);
    document.title = state.activeEntry ? readerRouteTitle() : listRouteTitle();
  }
}

async function openContributorAsset(itemId) {
  const item = contributorAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  const entryId = item && (item.entry?.id || item.entryId);
  if (!entryId) {
    toast('找不到这条资产对应的文章');
    return;
  }
  closeContributorModal({ clearUrl: false });
  const type = normalizeUserAssetTab(state.contributor.tab);
  const ok = type === 'translation' || type === 'rewrite'
    ? await openEntryById(entryId, { focus: type, aiAssetId: item.id, updateUrl: true, replaceUrl: false })
    : type === 'chat'
    ? await openEntryById(entryId, { focus: 'chat', chatMessageId: itemId, updateUrl: true, replaceUrl: false })
    : await openEntryById(entryId, { focus: 'comments', commentId: itemId, updateUrl: true, replaceUrl: false });
  if (!ok) toast('找不到这篇文章');
}

function copyContributorAssetLink(itemId) {
  const item = contributorAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  const url = myAssetUrl(state.contributor.tab, item);
  if (!url) {
    toast('找不到这条资产链接');
    return;
  }
  copyText(url, `${userAssetLabel(normalizeUserAssetTab(state.contributor.tab))}链接已复制`);
}

function copyContributorAssetContent(itemId) {
  const item = contributorAssetItemsForCurrentTab().find(asset => asset.id === itemId);
  copyAssetContent(state.contributor.tab, item);
}

function autosizeCommentEditInput(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
}

function editComment(commentId) {
  const comment = (state.comments || []).find(item => item.id === commentId);
  if (!comment || !comment.canEdit) {
    toast('没有权限编辑这条点评');
    return;
  }
  state.editingCommentId = commentId;
  renderComments();
  requestAnimationFrame(() => {
    const input = document.querySelector(`[data-comment-edit-input="${CSS.escape(commentId)}"]`);
    if (!input) return;
    autosizeCommentEditInput(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function cancelEditComment(commentId) {
  if (state.editingCommentId !== commentId) return;
  state.editingCommentId = '';
  renderComments();
}

async function saveCommentEdit(commentId) {
  const entry = state.activeEntry;
  const input = document.querySelector(`[data-comment-edit-input="${CSS.escape(commentId)}"]`);
  const body = input ? input.value.trim() : '';
  if (!entry || !commentId) return;
  if (!body) {
    toast('点评不能为空');
    return;
  }
  const btn = document.querySelector(`[data-comment-save="${CSS.escape(commentId)}"]`);
  if (btn) btn.disabled = true;
  try {
    const data = await api(`/api/entry/${entry.id}/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    state.comments = data.comments || [];
    state.editingCommentId = '';
    updateEntryAssets(entry.id, { comments: state.comments.length });
    renderComments();
    renderList();
    toast('点评已更新');
  } catch (err) {
    toast('更新点评失败: ' + err.message, 5000);
    if (btn) btn.disabled = false;
  }
}

async function toggleCommentHelpful(commentId) {
  const entry = state.activeEntry;
  const comment = (state.comments || []).find(item => item.id === commentId);
  if (!entry || !commentId || !comment) return;
  if (!state.me) {
    openAuth('login');
    toast('登录后可以标记有用');
    return;
  }
  const nextHelpful = !comment.helpfulByMe;
  try {
    const data = await api(`/api/entry/${entry.id}/comments/${encodeURIComponent(commentId)}/helpful`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helpful: nextHelpful }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    state.comments = data.comments || [];
    renderComments();
    renderReaderAssetSummary();
    toast(nextHelpful ? '已标记有用' : '已取消有用标记');
  } catch (err) {
    toast('反馈失败: ' + err.message, 5000);
  }
}

async function deleteComment(commentId) {
  const entry = state.activeEntry;
  if (!entry || !commentId) return;
  if (!window.confirm('确定撤回这条点评吗？撤回后公开资产页和 RSS 中也会移除。')) return;
  try {
    const data = await api(`/api/entry/${entry.id}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    if (state.activeEntry?.id !== entry.id) return;
    state.comments = data.comments || [];
    updateEntryAssets(entry.id, { comments: state.comments.length });
    renderComments();
    renderList();
    toast('点评已撤回');
  } catch (err) {
    toast('撤回点评失败: ' + err.message, 5000);
  }
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
  state.editingCommentId = '';
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

function renderAgentMessages(extraPending = false, { preserveScroll = false } = {}) {
  const el = $('#agent-messages');
  const thread = state.agentMessages || [];
  const hadPendingChatMessage = Boolean(state.pendingChatMessageId);
  const previousScrollTop = el.scrollTop;
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
    const metaText = agentMessageMeta(message);
    if (message.contributorId && message.role === 'user') {
      const author = message.author || message.contributorName || '读者';
      const authorBtn = document.createElement('button');
      authorBtn.type = 'button';
      authorBtn.className = 'contributor-inline agent-contributor-link';
      authorBtn.textContent = message.contributorName || author;
      authorBtn.onclick = () => openContributor(message.contributorId);
      role.appendChild(authorBtn);
      const rest = metaText.startsWith(author) ? metaText.slice(author.length) : '';
      role.appendChild(document.createTextNode(rest));
    } else {
      role.textContent = metaText;
    }
    role.title = metaText;
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
      const draft = document.createElement('button');
      draft.type = 'button';
      draft.className = 'agent-msg-action agent-msg-draft';
      draft.title = '放入人工点评';
      draft.setAttribute('aria-label', '放入人工点评');
      draft.textContent = '评';
      draft.onclick = () => draftCommentFromAgentMessage(message);
      actions.appendChild(draft);
      if (message.canDelete && message.id) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'agent-msg-action agent-msg-action-danger';
        del.title = '撤回这条对话';
        del.textContent = '×';
        del.onclick = () => deleteAgentMessage(message.id);
        actions.appendChild(del);
      }
      head.appendChild(actions);
    }
    const body = document.createElement('div');
    body.className = 'agent-msg-body';
    body.innerHTML = renderMarkdownLite(message.content);
    row.appendChild(head);
    row.appendChild(body);
    if (!message.pending && message.id) {
      const feedback = document.createElement('div');
      feedback.className = 'agent-msg-feedback';
      const helpfulCount = Number(message.helpfulCount || 0);
      const helpful = document.createElement('button');
      helpful.type = 'button';
      helpful.className = `agent-msg-helpful${message.helpfulByMe ? ' active' : ''}`;
      helpful.setAttribute('aria-pressed', message.helpfulByMe ? 'true' : 'false');
      helpful.title = message.helpfulByMe ? '取消有用标记' : '标记这条对话有用';
      helpful.textContent = `有用${helpfulCount ? ` ${helpfulCount}` : ''}`;
      helpful.onclick = () => toggleAgentHelpful(message.id);
      feedback.appendChild(helpful);
      row.appendChild(feedback);
    }
    frag.appendChild(row);
  }
  el.appendChild(frag);
  if (hadPendingChatMessage) {
    if (highlightAgentMessageFromRoute()) state.pendingAssetJump = null;
  } else if (preserveScroll) {
    el.scrollTop = previousScrollTop;
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

function draftCommentFromAgentMessage(message) {
  if (!state.activeEntry || !message || !String(message.content || '').trim()) return;
  if (!state.me) {
    openAuth('login');
    toast('登录后可放入点评草稿');
    return;
  }
  const input = $('#comment-input');
  if (!input) return;
  const content = String(message.content || '').trim();
  const prefix = message.role === 'user' ? '疑问：' : '观点：';
  const draft = `${prefix}${content.length > 1600 ? `${content.slice(0, 1599).trim()}…` : content}`;
  const current = input.value.trim();
  input.value = current ? `${current}\n\n${draft}` : draft;
  if (input.value.length > 5000) input.value = input.value.slice(0, 4999).trimEnd();
  state.readerFocus = 'comments';
  scrollReaderTarget('#comment-input', { behavior: 'auto', offset: 120 });
  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.selectionStart = input.selectionEnd = input.value.length;
    autosizeCommentInput();
    scrollReaderTarget('#comment-input', { behavior: 'auto', offset: 120 });
  }, 180);
  toast('已放入点评草稿，可编辑后发布');
}

function chatHelpfulAssetPatch(messages, entry = state.activeEntry) {
  const assets = mergeAssets(entry);
  const chatHelpfulCount = (messages || []).reduce((sum, message) => sum + (Number(message.helpfulCount) || 0), 0);
  const helpfulChats = (messages || []).filter(message => Number(message.helpfulCount || 0) > 0).length;
  const commentHelpfulCount = Number(assets.commentHelpfulCount ?? (Number(assets.helpfulCount || 0) - Number(assets.chatHelpfulCount || 0))) || 0;
  return {
    chatMessages: (messages || []).filter(message => message && message.id).length,
    chatHelpfulCount,
    helpfulChats,
    helpfulCount: Math.max(0, commentHelpfulCount) + chatHelpfulCount,
  };
}

async function toggleAgentHelpful(messageId) {
  const entry = state.activeEntry;
  const message = (state.agentMessages || []).find(item => item.id === messageId);
  if (!entry || !message) return;
  if (!requireAuth('login')) return;
  const nextHelpful = !message.helpfulByMe;
  try {
    const data = await api(`/api/entry/${entry.id}/chat/${encodeURIComponent(messageId)}/helpful`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helpful: nextHelpful }),
    });
    if (state.activeEntry?.id !== entry.id) return;
    state.agentMessages = data.messages || state.agentMessages || [];
    updateEntryAssets(entry.id, chatHelpfulAssetPatch(state.agentMessages, state.activeEntry), { rerenderList: false });
    renderAgentMessages(false, { preserveScroll: true });
    renderList();
    toast(nextHelpful ? '已标记有用' : '已取消有用标记');
  } catch (err) {
    toast('反馈失败: ' + err.message, 5000);
  }
}

async function deleteAgentMessage(messageId) {
  const entry = state.activeEntry;
  if (!entry || !messageId) return;
  if (!window.confirm('确定撤回这条对话吗？撤回后公开资产页和 RSS 中也会移除。')) return;
  try {
    const data = await api(`/api/entry/${entry.id}/chat/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    if (state.activeEntry?.id !== entry.id) return;
    state.agentMessages = data.messages || [];
    updateEntryAssets(entry.id, { chatMessages: state.agentMessages.length });
    renderAgentMessages();
    renderList();
    toast('对话已撤回');
  } catch (err) {
    toast('撤回对话失败: ' + err.message, 5000);
  } finally {
    updateAgentControls();
  }
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

async function openEntry(e, { tab = 'original', focus = null, aiAssetId = '', commentId = '', chatMessageId = '', updateUrl = true, replaceUrl = false } = {}) {
  state.activeEntry = e;
  const requestedFocus = ASSET_FILTER_TYPES.includes(focus) ? focus : null;
  const requestedAssetId = (requestedFocus === 'translation' || requestedFocus === 'rewrite') ? String(aiAssetId || '').trim() : '';
  const requestedTab = requestedFocus === 'translation'
    ? 'translation'
    : requestedFocus === 'rewrite'
      ? 'rewrite'
      : normalizeReaderTab(tab);
  state.read.add(e.id);
  recordEntryView(e.id);
  syncEntryState(e.id, { read: true, viewed: true });
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
  state.editingCommentId = '';
  state.translation = null;
  state.translationLoading = false;
  state.translationGenerating = false;
  state.pendingTranslationGenerate = false;
  state.rewrite = null;
  state.rewriteGenerating = false;
  state.readerFocus = requestedFocus;
  state.readerAssetId = requestedAssetId;
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
  state.readerAssetId = '';
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

async function openEntryById(entryId, { tab = 'original', focus = null, aiAssetId = '', commentId = '', chatMessageId = '', updateUrl = false, replaceUrl = true } = {}) {
  const id = String(entryId || '').trim();
  if (!id) return false;
  let entry = state.entries.find(item => item.id === id);
  if (!entry) {
    const data = await api(`/api/entry/${encodeURIComponent(id)}`);
    entry = data.entry;
  }
  if (!entry) return false;
  await openEntry(entry, { tab, focus, aiAssetId, commentId, chatMessageId, updateUrl, replaceUrl });
  return true;
}

async function openEntryFromUrl() {
  const route = routeStateFromUrl();
  if (route.contributorId) {
    state.view = 'all';
    state.filterSource = null;
    state.filterCategory = null;
    state.assetFilter = null;
    state.assetSort = 'latest';
    state.contributorSort = 'latest';
    state.q = '';
    updateListTitle();
    renderSidebar();
    closeReaderFromRoute();
    await openContributor(route.contributorId, { push: false, sort: route.contributorAssetSort, tab: route.contributorAssetType });
    return true;
  }
  $('#contributor-modal').classList.add('hidden');
  if (!route.entryId) {
    if (route.view === 'contributors') {
      state.view = 'contributors';
      state.filterSource = null;
      state.filterCategory = null;
      state.assetFilter = null;
      state.assetSort = 'latest';
      state.contributorSort = route.contributorSort;
      state.q = route.q;
    } else if (route.view === 'assets') {
      state.view = 'assets';
      state.filterSource = null;
      state.filterCategory = null;
      state.assetFilter = route.assetFilter;
      state.assetSort = route.assetSort;
      state.contributorSort = 'latest';
      state.q = route.q;
    } else {
      state.view = 'all';
      state.filterSource = null;
      state.filterCategory = null;
      state.assetFilter = null;
      state.assetSort = 'latest';
      state.contributorSort = 'latest';
      state.q = '';
    }
    await Promise.all([loadEntries(), loadContributors()]);
    updateListTitle();
    renderList();
    renderSidebar();
    closeReaderFromRoute();
    if (route.view === 'assets' || route.view === 'contributors') document.title = listRouteTitle();
    return false;
  }
  try {
    return await openEntryById(route.entryId, { tab: route.tab, focus: route.focus, aiAssetId: route.assetId, commentId: route.commentId, chatMessageId: route.chatMessageId, updateUrl: false });
  } catch (err) {
    toast('找不到这篇文章: ' + err.message, 4000);
    closeReaderFromRoute();
    clearReaderUrl({ replace: true });
    return false;
  }
}

/* ---------- Navigation ---------- */
async function reload({ keepReader = false, clearUrl = true } = {}) {
  await Promise.all([loadEntries(), loadContributors()]);
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
    state.readerAssetId = '';
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
  state.assetSort = 'latest';
  state.contributorSort = 'latest';
  state.readerFocus = null;
  state.readerAssetId = '';
  reload();
}
function selectCategory(cat) {
  state.filterCategory = state.filterCategory === cat ? null : cat;
  state.filterSource = null;
  state.assetFilter = null;
  state.assetSort = 'latest';
  state.contributorSort = 'latest';
  state.readerFocus = null;
  state.readerAssetId = '';
  reload();
}
function selectView(v) {
  state.view = v;
  state.filterSource = null;
  state.filterCategory = null;
  state.assetFilter = null;
  state.readerFocus = null;
  state.readerAssetId = '';
  if (v !== 'assets') state.assetSort = 'latest';
  if (v !== 'contributors') state.contributorSort = 'latest';
  if (v === 'assets' || v === 'contributors') {
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
  state.contributorSort = 'latest';
  state.readerFocus = null;
  state.readerAssetId = '';
  syncListUrl();
  reload({ clearUrl: false });
}

function selectAssetSort(sort = 'latest') {
  state.view = 'assets';
  state.assetSort = sort === 'helpful' ? 'helpful' : 'latest';
  state.filterSource = null;
  state.filterCategory = null;
  state.contributorSort = 'latest';
  state.readerFocus = null;
  state.readerAssetId = '';
  syncListUrl();
  reload({ clearUrl: false });
}

function selectContributorSort(sort = 'latest') {
  state.view = 'contributors';
  state.contributorSort = normalizeContributorSort(sort);
  state.assetSort = 'latest';
  state.filterSource = null;
  state.filterCategory = null;
  state.assetFilter = null;
  state.readerFocus = null;
  state.readerAssetId = '';
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
    if (!$('#manage-modal')?.classList.contains('hidden')) renderManage();
    toast('刷新完成');
  } catch (e) {
    toast('刷新失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ 刷新全部';
  }
}

/* ---------- Manage modal ---------- */
function sourceName(id) {
  const source = state.sources.find(item => item.id === id);
  return source ? source.name : id;
}

function manageStatusLine() {
  const total = state.sources.length;
  const enabled = state.sources.filter(source => source.enabled).length;
  const ok = state.sources.filter(source => source.enabled && source.status === 'ok').length;
  const errors = state.sources.filter(source => source.enabled && source.status === 'error').length;
  return { total, enabled, ok, errors };
}

function opsStatusText(value) {
  const text = String(value || '').trim();
  if (text === 'AI not configured') return '站点 API Key 未配置';
  if (text === 'already running') return '已有任务运行中';
  if (text === 'no sources configured') return '未配置重点源';
  return text;
}

function autoRewriteStatusParts() {
  const auto = state.autoRewrite || {};
  const last = auto.last || {};
  const running = Boolean(auto.running || last.running);
  const failed = [
    ...(last.error ? [{ title: '自动重写任务', error: last.error }] : []),
    ...(Array.isArray(last.failed) ? last.failed : []),
  ];
  if (running) {
    return {
      label: '自动重写中',
      value: '后台运行',
      meta: (last.sourceIds || []).map(sourceName).join('、') || '重点源',
      failed,
    };
  }
  if (!last.startedAt) {
    return { label: '自动重写', value: '待命', meta: '刷新后处理重点源', failed };
  }
  const value = last.error
    ? opsStatusText(last.error)
    : last.skipped
    ? opsStatusText(last.skipped)
    : `${Number(last.rewritten) || 0} 新 · ${Number(last.cached) || 0} 缓存 · ${failed.length} 失败`;
  return {
    label: '自动重写完成',
    value,
    meta: [formatAssetTime(last.finishedAt || last.startedAt), (last.sourceIds || []).map(sourceName).join('、')].filter(Boolean).join(' · '),
    failed,
  };
}

function renderManageStatus() {
  const el = $('#manage-status');
  if (!el) return;
  const counts = manageStatusLine();
  const progress = state.refreshProgress || { done: 0, total: 0 };
  const refreshValue = state.refreshing
    ? `${progress.done || 0}/${progress.total || counts.enabled}`
    : progress.total ? `完成 ${progress.done || 0}/${progress.total}` : '待刷新';
  const refreshMeta = state.refreshing ? '刷新中' : '最近刷新状态';
  const rewrite = autoRewriteStatusParts();
  const failures = rewrite.failed.slice(0, 3);
  el.innerHTML = `
    <div class="manage-status-grid">
      <div class="manage-status-item">
        <span>订阅源</span>
        <strong>${counts.enabled}/${counts.total}</strong>
        <em>${counts.ok} 正常${counts.errors ? ` · ${counts.errors} 失败` : ''}</em>
      </div>
      <div class="manage-status-item ${state.refreshing ? 'active' : ''}">
        <span>抓取刷新</span>
        <strong>${escapeHtml(refreshValue)}</strong>
        <em>${escapeHtml(refreshMeta)}</em>
      </div>
      <div class="manage-status-item ${state.autoRewrite?.running ? 'active' : failures.length ? 'error' : ''}">
        <span>${escapeHtml(rewrite.label)}</span>
        <div class="manage-status-action-row">
          <strong>${escapeHtml(rewrite.value)}</strong>
          <button id="manage-auto-rewrite" class="manage-status-action" type="button" ${state.autoRewrite?.running ? 'disabled' : ''}>运行</button>
        </div>
        <em title="${escapeHtml(rewrite.meta)}">${escapeHtml(rewrite.meta || '无运行记录')}</em>
      </div>
    </div>
    ${failures.length ? `<div class="manage-status-failures">${failures.map(item => `
      <div><strong>${escapeHtml(item.title || item.entryId || '未命名文章')}</strong><span>${escapeHtml(opsStatusText(item.error) || '未知错误')}</span></div>
    `).join('')}</div>` : ''}`;
  const runBtn = $('#manage-auto-rewrite');
  if (runBtn) runBtn.onclick = runAutoRewriteFromManage;
}

async function runAutoRewriteFromManage() {
  if (!isAdmin()) {
    toast('需要管理员权限');
    return;
  }
  const btn = $('#manage-auto-rewrite');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '运行中';
  }
  try {
    await api('/api/auto-rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    toast('自动重写已启动');
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const data = await loadSources();
      renderManageStatus();
      if (!data.autoRewrite?.running) break;
    }
    await reload({ keepReader: true });
    renderManage();
  } catch (error) {
    toast('启动自动重写失败: ' + error.message, 5000);
    await loadSources().catch(() => null);
    renderManageStatus();
  }
}

function renderManage() {
  renderManageStatus();
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
      setTimeout(async () => { await loadSources(); renderManage(); reload({ keepReader: true }); }, r.enabled ? 4000 : 0);
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

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  storage.setItem('qm_sidebar_collapsed', collapsed ? '1' : '0');
  $('#app').classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('#sidebar-toggle');
  toggle.textContent = collapsed ? '⇥' : '⇤';
  toggle.title = collapsed ? '展开左侧栏' : '收起左侧栏';
  toggle.setAttribute('aria-label', toggle.title);
}

function entryPaneWidthBounds() {
  const viewport = window.innerWidth || document.documentElement.clientWidth || 1280;
  const max = Math.min(ENTRY_PANE_MAX_WIDTH, Math.max(ENTRY_PANE_MIN_WIDTH, Math.floor(viewport * 0.45)));
  return { min: ENTRY_PANE_MIN_WIDTH, max };
}

function clampEntryPaneWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const bounds = entryPaneWidthBounds();
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

function setEntryPaneWidth(width, { persist: shouldPersist = true } = {}) {
  const next = clampEntryPaneWidth(width);
  state.entryPaneWidth = next;
  if (next) {
    $('#app').style.setProperty('--entry-width', `${next}px`);
    if (shouldPersist) storage.setItem('qm_entry_pane_width', String(next));
  } else {
    $('#app').style.removeProperty('--entry-width');
    if (shouldPersist) storage.removeItem('qm_entry_pane_width');
  }
}

function setupListResizer() {
  const resizer = $('#list-resizer');
  if (!resizer) return;
  let dragging = false;
  const resizeTo = (clientX) => {
    const entryRect = $('#entry-pane').getBoundingClientRect();
    setEntryPaneWidth(clientX - entryRect.left);
  };
  resizer.addEventListener('pointerdown', (e) => {
    if ((window.innerWidth || 0) <= 980) return;
    dragging = true;
    $('#app').classList.add('is-resizing');
    resizer.setPointerCapture?.(e.pointerId);
    resizeTo(e.clientX);
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    resizeTo(e.clientX);
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    $('#app').classList.remove('is-resizing');
  });
  resizer.addEventListener('dblclick', () => setEntryPaneWidth(0));
  resizer.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const bounds = entryPaneWidthBounds();
    const current = state.entryPaneWidth || $('#entry-pane').getBoundingClientRect().width;
    if (e.key === 'Home') setEntryPaneWidth(bounds.min);
    if (e.key === 'End') setEntryPaneWidth(bounds.max);
    if (e.key === 'ArrowLeft') setEntryPaneWidth(current - 24);
    if (e.key === 'ArrowRight') setEntryPaneWidth(current + 24);
  });
}

/* ---------- Events ---------- */
$$('.view-btn').forEach(b => b.onclick = () => selectView(b.dataset.view));
$('#sidebar-toggle').onclick = () => setSidebarCollapsed(!state.sidebarCollapsed);
$('#asset-dashboard-open').onclick = () => {
  state.assetSort = 'latest';
  selectAssetFilter(null);
};
$('#asset-dashboard-helpful').onclick = () => {
  state.assetFilter = null;
  selectAssetSort('helpful');
};
$('#asset-dashboard').onclick = (e) => {
  const btn = e.target.closest('[data-asset-filter]');
  if (!btn || btn.disabled) return;
  selectAssetFilter(btn.dataset.assetFilter);
};
$('#asset-activity-strip').onclick = async (e) => {
  const copy = e.target.closest('[data-asset-copy-list]');
  if (copy) {
    copyText(listUrlFor('assets', state.assetFilter).href, '资产页链接已复制');
    return;
  }
  const contributorCopy = e.target.closest('[data-contributor-copy-list]');
  if (contributorCopy) {
    copyText(listUrlFor('contributors').href, '贡献者页链接已复制');
    return;
  }
  const filter = e.target.closest('[data-asset-strip-filter]');
  if (filter && !filter.disabled) {
    selectAssetFilter(filter.dataset.assetStripFilter || null);
    return;
  }
  const sort = e.target.closest('[data-asset-sort]');
  if (sort) {
    selectAssetSort(sort.dataset.assetSort || 'latest');
    return;
  }
  const contributorSort = e.target.closest('[data-contributor-sort]');
  if (contributorSort) {
    selectContributorSort(contributorSort.dataset.contributorSort || 'latest');
    return;
  }
  const all = e.target.closest('[data-asset-open-all]');
  if (all) {
    selectAssetFilter(null);
    return;
  }
  const btn = e.target.closest('[data-asset-entry]');
  if (!btn) return;
  const entry = state.entries.find(item => item.id === btn.dataset.assetEntry);
  if (!entry) return;
  const focus = btn.dataset.assetFocus;
  const itemId = btn.dataset.assetItemId || '';
  await openEntry(entry, {
    focus,
    aiAssetId: focus === 'translation' || focus === 'rewrite' ? itemId : '',
    commentId: focus === 'comments' ? itemId : '',
    chatMessageId: focus === 'chat' ? itemId : '',
  });
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
$('#translation-helpful').onclick = () => toggleEntryAssetHelpful('translation');
$('#rewrite-helpful').onclick = () => toggleEntryAssetHelpful('rewrite');
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
  const contributor = e.target.closest('[data-contributor-id]');
  if (contributor) {
    openContributor(contributor.dataset.contributorId);
    return;
  }
  const helpful = e.target.closest('[data-comment-helpful]');
  if (helpful) {
    toggleCommentHelpful(helpful.dataset.commentHelpful);
    return;
  }
  const link = e.target.closest('[data-comment-link]');
  if (link) {
    copyCommentLink(link.dataset.commentLink);
    return;
  }
  const edit = e.target.closest('[data-comment-edit]');
  if (edit) {
    editComment(edit.dataset.commentEdit);
    return;
  }
  const save = e.target.closest('[data-comment-save]');
  if (save) {
    saveCommentEdit(save.dataset.commentSave);
    return;
  }
  const cancel = e.target.closest('[data-comment-cancel]');
  if (cancel) {
    cancelEditComment(cancel.dataset.commentCancel);
    return;
  }
  const del = e.target.closest('[data-comment-delete]');
  if (del) {
    deleteComment(del.dataset.commentDelete);
    return;
  }
  const btn = e.target.closest('[data-comment-copy]');
  if (!btn) return;
  copyComment(btn.dataset.commentCopy);
};
$('#comments-list').oninput = (e) => {
  const input = e.target.closest('[data-comment-edit-input]');
  if (input) autosizeCommentEditInput(input);
};
$('#comments-list').onkeydown = (e) => {
  const input = e.target.closest('[data-comment-edit-input]');
  if (!input) return;
  const commentId = input.dataset.commentEditInput;
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelEditComment(commentId);
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveCommentEdit(commentId);
  }
};
$$('.comment-sort-btn').forEach(btn => {
  btn.onclick = () => setCommentSort(btn.dataset.commentSort);
});
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
$('#my-comments-btn').onclick = openMyCommentsModal;
$('#my-comments-close').onclick = closeMyCommentsModal;
$('#my-public-profile-copy').onclick = copyMyPublicProfileLink;
$('#my-public-rss-copy').onclick = copyMyPublicRssLink;
$('#my-comments-modal').onclick = (e) => { if (e.target.id === 'my-comments-modal') closeMyCommentsModal(); };
$$('#my-comments-modal [data-my-asset-tab]').forEach(btn => {
  btn.onclick = () => {
    state.myAssetTab = normalizeUserAssetTab(btn.dataset.myAssetTab);
    renderMyAssets();
  };
});
$$('#my-comments-modal [data-my-asset-sort]').forEach(btn => {
  btn.onclick = () => {
    state.myAssetSort = normalizeUserAssetSort(btn.dataset.myAssetSort);
    storage.setItem('qm_my_asset_sort', state.myAssetSort);
    renderMyAssets();
  };
});
$('#my-comments-list').onclick = (e) => {
  const open = e.target.closest('[data-my-asset-open]');
  if (open) {
    openMyAsset(open.dataset.myAssetOpen);
    return;
  }
  const contentCopy = e.target.closest('[data-my-asset-copy-content]');
  if (contentCopy) {
    copyMyAssetContent(contentCopy.dataset.myAssetCopyContent);
    return;
  }
  const copy = e.target.closest('[data-my-asset-copy]');
  if (copy) copyMyAssetLink(copy.dataset.myAssetCopy);
};
$('#contributor-close').onclick = () => closeContributorModal();
$('#contributor-link-copy').onclick = () => {
  if (!state.contributor.profile) {
    toast('还没有可复制的贡献者页');
    return;
  }
  copyText(
    contributorUrlFor(state.contributor.profile.id, {
      sort: state.contributor.sort,
      tab: state.contributor.tab,
    }).href,
    '贡献者页链接已复制',
  );
};
$('#contributor-rss-copy').onclick = () => {
  if (!state.contributor.profile) {
    toast('还没有可复制的贡献者 RSS');
    return;
  }
  copyText(contributorFeedUrlFor(state.contributor.profile.id).href, '贡献者 RSS 已复制');
};
$('#contributor-modal').onclick = (e) => { if (e.target.id === 'contributor-modal') closeContributorModal(); };
$$('#contributor-modal [data-contributor-tab]').forEach(btn => {
  btn.onclick = () => {
    state.contributor.tab = normalizeUserAssetTab(btn.dataset.contributorTab);
    renderContributorAssets();
    syncContributorUrl();
    document.title = contributorPageTitle();
  };
});
$$('#contributor-modal [data-contributor-asset-sort]').forEach(btn => {
  btn.onclick = () => {
    state.contributor.sort = normalizeContributorAssetSort(btn.dataset.contributorAssetSort);
    renderContributorAssets();
    syncContributorUrl();
    document.title = contributorPageTitle();
  };
});
$('#contributor-list').onclick = (e) => {
  const open = e.target.closest('[data-contributor-asset-open]');
  if (open) {
    openContributorAsset(open.dataset.contributorAssetOpen);
    return;
  }
  const contentCopy = e.target.closest('[data-contributor-asset-copy-content]');
  if (contentCopy) {
    copyContributorAssetContent(contentCopy.dataset.contributorAssetCopyContent);
    return;
  }
  const copy = e.target.closest('[data-contributor-asset-copy]');
  if (copy) copyContributorAssetLink(copy.dataset.contributorAssetCopy);
};
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
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (state.view === 'assets' || state.view === 'contributors') {
      syncListUrl({ replace: true });
      reload({ clearUrl: false });
      return;
    }
    reload();
  }, 350);
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
    $('#my-comments-modal').classList.add('hidden');
    closeContributorModal();
  }
});

window.addEventListener('popstate', () => {
  openEntryFromUrl();
});

window.addEventListener('resize', () => {
  if (state.entryPaneWidth) setEntryPaneWidth(state.entryPaneWidth, { persist: false });
});

/* ---------- Init ---------- */
(async function init() {
  document.body.dataset.theme = storage.getItem('fr_theme') || 'light';
  loadAiProfilesForScope();
  renderAiSettings();
  renderAuthState();
  setSidebarCollapsed(state.sidebarCollapsed);
  setEntryPaneWidth(state.entryPaneWidth, { persist: false });
  setupListResizer();
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
        await Promise.all([loadEntries(), loadContributors()]);
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
