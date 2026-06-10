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

  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view && !state.filterSource && !state.filterCategory));
}

/* ---------- Entry list ---------- */
function hasEntryAssets(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  return Boolean(assets.translation || assets.rewrite || assets.comments || assets.chatMessages);
}

function visibleEntries() {
  let list = state.entries;
  if (state.view === 'unread') list = list.filter(e => !state.read.has(e.id));
  if (state.view === 'starred') list = list.filter(e => state.starred.has(e.id));
  if (state.view === 'assets') list = list.filter(hasEntryAssets);
  return list;
}

function sourceById(id) { return state.sources.find(s => s.id === id); }

function assetBadgesHtml(entry) {
  const assets = entry && entry.assets ? entry.assets : {};
  const badges = [];
  if (assets.translation) badges.push({ type: 'translation', label: '中译' });
  if (assets.rewrite) badges.push({ type: 'rewrite', label: '重写' });
  if (assets.comments) badges.push({ type: 'comments', label: `点评 ${assets.comments}` });
  if (assets.chatMessages) badges.push({ type: 'chat', label: `对话 ${assets.chatMessages}` });
  return badges.map(badge => `<span class="asset-badge asset-${badge.type}">${escapeHtml(badge.label)}</span>`).join('');
}

function mergeAssets(entry, patch = {}) {
  return {
    translation: false,
    rewrite: false,
    comments: 0,
    chatMessages: 0,
    ...(entry && entry.assets ? entry.assets : {}),
    ...patch,
  };
}

function renderReaderAssets(entry = state.activeEntry) {
  const el = $('#reader-assets');
  const html = assetBadgesHtml(entry);
  el.innerHTML = html;
  el.classList.toggle('hidden', !html);
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
  updateAgentControls();
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
  if (!list.length) {
    const text = state.view === 'assets'
      ? '还没有沉淀资产<br/>先翻译、重写、点评或对话一篇文章'
      : '这里空空如也<br/>试试刷新或切换视图';
    el.innerHTML = `<div class="list-empty">${text}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const src = sourceById(e.sourceId);
    const assetsHtml = assetBadgesHtml(e);
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
      </div>
      ${e.image ? `<img class="entry-thumb" src="${escapeHtml(e.image)}" loading="lazy" onerror="this.remove()" />` : ''}`;
    card.onclick = () => openEntry(e);
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
  else if (state.view === 'assets') title = '资产';
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
}

function setReaderTab(tab) {
  const next = ['original', 'translation', 'rewrite'].includes(tab) ? tab : 'original';
  state.readerTab = next;
  $$('.reader-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === next));
  $('#reader-original-panel').classList.toggle('hidden', next !== 'original');
  $('#reader-translation').classList.toggle('hidden', next !== 'translation');
  $('#reader-rewrite-panel').classList.toggle('hidden', next !== 'rewrite');
}

function handleReaderTab(tab) {
  setReaderTab(tab);
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
  list.innerHTML = '';
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
  content.innerHTML = '';
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
  list.innerHTML = comments.map(comment => `
    <div class="comment-item">
      <div class="comment-meta">${escapeHtml(comment.author)} · ${formatAssetTime(comment.createdAt)}</div>
      <div class="comment-body">${renderMarkdownLite(comment.body)}</div>
    </div>`).join('');
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
    const head = document.createElement('div');
    head.className = 'agent-msg-head';
    const role = document.createElement('div');
    role.className = 'agent-msg-role';
    role.textContent = message.author || (message.role === 'user' ? '读者' : 'AI');
    head.appendChild(role);
    if (!message.pending) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'agent-msg-copy';
      copy.title = '复制这条消息';
      copy.textContent = '⧉';
      copy.onclick = () => copyText(message.content, '消息已复制');
      head.appendChild(copy);
    }
    const body = document.createElement('div');
    body.className = 'agent-msg-body';
    body.innerHTML = renderMarkdownLite(message.content);
    row.appendChild(head);
    row.appendChild(body);
    frag.appendChild(row);
  }
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
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

async function openEntry(e) {
  state.activeEntry = e;
  const wasRead = state.read.has(e.id);
  state.read.add(e.id);
  if (!wasRead) syncEntryState(e.id, { read: true });
  persist();

  const src = sourceById(e.sourceId);
  $('#reader-empty').classList.add('hidden');
  $('#reader').classList.remove('hidden');
  $('#reader-source').innerHTML = `${src ? faviconHtml(src.siteUrl, src.name, 14) : ''}<span>${escapeHtml(src ? src.name : '')}</span>`;
  renderTitle(e);
  const date = e.published ? new Date(e.published).toLocaleString('zh-CN') : '';
  $('#reader-meta').textContent = [e.author, date].filter(Boolean).join(' · ');
  renderReaderAssets(e);
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
  state.fetchingOriginal = false;
  updateFetchOriginalButton(e);
  setReaderTab('original');
  loadTranslation(e);
  loadRewrite(e);
  loadComments(e);
  loadAgentMessages(e);

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

/* ---------- Navigation ---------- */
async function reload({ keepReader = false } = {}) {
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
    state.fetchingOriginal = false;
    state.readerTab = 'original';
    $('#reader').classList.add('hidden');
    $('#reader-empty').classList.remove('hidden');
    document.getElementById('app').classList.remove('reading');
    renderAgent();
  }
}

function selectSource(id) {
  state.filterSource = state.filterSource === id ? null : id;
  state.filterCategory = null;
  reload();
}
function selectCategory(cat) {
  state.filterCategory = state.filterCategory === cat ? null : cat;
  state.filterSource = null;
  reload();
}
function selectView(v) {
  state.view = v;
  state.filterSource = null;
  state.filterCategory = null;
  reload();
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
$('#reader-bilingual').onclick = () => generateTranslation({ force: Boolean(state.translation) });
$('#reader-rewrite').onclick = () => generateRewrite({ force: Boolean(state.rewrite) });
$$('.reader-tab').forEach(btn => {
  btn.onclick = () => handleReaderTab(btn.dataset.tab);
});
$('#comment-form').onsubmit = (e) => {
  e.preventDefault();
  submitComment();
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
    await reload();
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
  } catch (e) {
    toast('加载失败: ' + e.message, 5000);
    $('#entry-list').innerHTML = `<div class="list-empty">数据加载失败：${escapeHtml(e.message)}<br/><button class="ghost-btn" onclick="location.reload()" style="margin-top:10px">重新加载</button></div>`;
  }
})();
