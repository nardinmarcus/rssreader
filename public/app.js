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
const AI_PROVIDERS = {
  deepseek: {
    title: 'DeepSeek',
    subtitle: '默认用于标题、正文翻译和文章对话。',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    keyPlaceholder: 'sk-...',
    models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  'openai-compatible': {
    title: 'OpenAI 兼容',
    subtitle: '适合 OpenAI 协议的中转或自定义模型。',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'gpt-5.4-mini',
    keyPlaceholder: 'sk-...',
    models: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'codex-auto-review'],
  },
  'anthropic-compatible': {
    title: 'Claude 兼容',
    subtitle: '适合兼容 Chat Completions 的 Claude 中转。',
    defaultBaseUrl: 'https://api.aigocode.app',
    defaultModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'sk-ant-... 或第三方 token',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  },
};

function normalizeProvider(provider) {
  return AI_PROVIDERS[provider] ? provider : 'deepseek';
}

function defaultAiConfig(provider) {
  const p = AI_PROVIDERS[normalizeProvider(provider)];
  return { apiKey: '', baseUrl: p.defaultBaseUrl, model: p.defaultModel };
}

function loadAiConfigs() {
  const configs = readJson('qm_ai_configs', '{}');
  for (const provider of Object.keys(AI_PROVIDERS)) {
    configs[provider] = { ...defaultAiConfig(provider), ...(configs[provider] || {}) };
  }
  const legacyKey = storage.getItem('qm_deepseek_key');
  if (legacyKey && !configs.deepseek.apiKey) {
    configs.deepseek.apiKey = legacyKey;
    storage.removeItem('qm_deepseek_key');
    storage.setItem('qm_ai_configs', JSON.stringify(configs));
  }
  return configs;
}

const state = {
  sources: [],
  entries: [],
  view: 'all',            // all | unread | starred
  filterSource: null,
  filterCategory: null,
  q: '',
  activeEntry: null,
  read: new Set(readJson('fr_read', '[]')),
  starred: new Set(readJson('fr_starred', '[]')),
  agentMessages: [],
  comments: [],
  translation: null,
  agentBusy: false,
  agentCollapsed: storage.getItem('qm_agent_collapsed') === '1',
  me: null,
  authMode: 'login',
  aiProvider: normalizeProvider(storage.getItem('qm_ai_provider') || 'deepseek'),
  aiConfigs: loadAiConfigs(),
};

function persist() {
  storage.setItem('fr_read', JSON.stringify([...state.read].slice(-5000)));
  storage.setItem('fr_starred', JSON.stringify([...state.starred]));
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

function renderMarkdownLite(value) {
  const escaped = escapeHtml(value).replace(/\r\n/g, '\n');
  const blocks = escaped.split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    if (lines.every(line => /^[-*]\s+/.test(line.trim()))) {
      return `<ul>${lines.map(line => `<li>${line.trim().replace(/^[-*]\s+/, '')}</li>`).join('')}</ul>`;
    }
    if (lines.every(line => /^\d+\.\s+/.test(line.trim()))) {
      return `<ol>${lines.map(line => `<li>${line.trim().replace(/^\d+\.\s+/, '')}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');

  return blocks
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
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
function currentAiConfig() {
  const provider = normalizeProvider(state.aiProvider);
  return { provider, ...defaultAiConfig(provider), ...(state.aiConfigs[provider] || {}) };
}

function aiHeaders() {
  const config = currentAiConfig();
  return {
    'X-AI-Provider': config.provider,
    'X-AI-Key': String(config.apiKey || '').trim(),
    'X-AI-Base-URL': String(config.baseUrl || '').trim(),
    'X-AI-Model': String(config.model || '').trim(),
  };
}

function persistAiConfig() {
  storage.setItem('qm_ai_provider', state.aiProvider);
  storage.setItem('qm_ai_configs', JSON.stringify(state.aiConfigs));
}

async function api(path, opts) {
  const headers = { ...(opts && opts.headers ? opts.headers : {}) };
  if (opts && opts.ai) Object.assign(headers, aiHeaders());
  const rest = { ...(opts || {}) };
  delete rest.ai;
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
async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user || null;
  renderAuthState();
  renderComments();
  renderAgent();
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

  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view && !state.filterSource && !state.filterCategory));
}

/* ---------- Entry list ---------- */
function visibleEntries() {
  let list = state.entries;
  if (state.view === 'unread') list = list.filter(e => !state.read.has(e.id));
  if (state.view === 'starred') list = list.filter(e => state.starred.has(e.id));
  return list;
}

function sourceById(id) { return state.sources.find(s => s.id === id); }

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
    renderAuthState();
    renderComments();
    renderAgent();
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
  renderAuthState();
  renderComments();
  renderAgent();
  toast('已退出登录');
}

function renderList() {
  const list = visibleEntries();
  const el = $('#entry-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="list-empty">这里空空如也<br/>试试刷新或切换视图</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const src = sourceById(e.sourceId);
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

function renderTranslation(translation) {
  state.translation = translation || null;
  const wrap = $('#reader-translation');
  const list = $('#translation-list');
  list.innerHTML = '';
  if (!translation || !Array.isArray(translation.content) || !translation.content.length) {
    wrap.classList.add('hidden');
    $('#reader-bilingual').textContent = '双语翻译';
    return;
  }
  wrap.classList.remove('hidden');
  $('#reader-bilingual').textContent = '查看双语';
  $('#translation-meta').textContent = [translation.createdBy, translation.model, formatAssetTime(translation.updatedAt)].filter(Boolean).join(' · ');
  list.innerHTML = translation.content.map(pair => `
    <div class="translation-pair">
      <p class="translation-source">${escapeHtml(pair.source)}</p>
      <p class="translation-target">${escapeHtml(pair.target)}</p>
    </div>`).join('');
}

async function loadTranslation(entry) {
  renderTranslation(null);
  try {
    const data = await api(`/api/entry/${entry.id}/translation`);
    if (state.activeEntry?.id !== entry.id) return;
    renderTranslation(data.translation);
  } catch {
    renderTranslation(null);
  }
}

async function generateTranslation() {
  const entry = state.activeEntry;
  if (!entry) return;
  const btn = $('#reader-bilingual');
  if (state.translation) {
    $('#reader-translation').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (!requireAuth('login')) return;
  if (!currentAiConfig().apiKey.trim()) {
    $('#agent-settings-panel').classList.remove('hidden');
    toast('请先填写你的 API Key');
    return;
  }
  btn.disabled = true;
  btn.textContent = '翻译中…';
  try {
    const data = await api(`/api/entry/${entry.id}/translation`, {
      method: 'POST',
      ai: true,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (state.activeEntry?.id !== entry.id) return;
    renderTranslation(data.translation);
    toast(data.cached ? '已显示缓存翻译' : '双语翻译已保存');
  } catch (err) {
    toast('翻译失败: ' + err.message, 5000);
  } finally {
    btn.disabled = false;
    if (!state.translation) btn.textContent = '双语翻译';
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
    row.innerHTML = `
      <div class="agent-msg-role">${escapeHtml(message.author || (message.role === 'user' ? '读者' : 'DeepSeek'))}</div>
      <div class="agent-msg-body">${renderMarkdownLite(message.content)}</div>`;
    frag.appendChild(row);
  }
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
}

function updateAgentControls() {
  const hasEntry = Boolean(state.activeEntry);
  const hasUser = Boolean(state.me);
  const hasKey = Boolean(currentAiConfig().apiKey.trim());
  const input = $('#agent-input');
  const send = $('#agent-send');
  if (!hasEntry) input.placeholder = '问当前文章…';
  else if (!hasUser) input.placeholder = '登录后围绕当前文章对话';
  else if (!hasKey) input.placeholder = '填写 API Key 后提问';
  else input.placeholder = '问当前文章…';
  input.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy;
  send.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy || !input.value.trim();
  $$('.agent-prompt').forEach(btn => { btn.disabled = !hasEntry || !hasUser || !hasKey || state.agentBusy; });
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
  if (!currentAiConfig().apiKey.trim()) {
    $('#agent-settings-panel').classList.remove('hidden');
    toast('请先填写你的 API Key');
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
  state.read.add(e.id);
  persist();

  const src = sourceById(e.sourceId);
  $('#reader-empty').classList.add('hidden');
  $('#reader').classList.remove('hidden');
  $('#reader-source').innerHTML = `${src ? faviconHtml(src.siteUrl, src.name, 14) : ''}<span>${escapeHtml(src ? src.name : '')}</span>`;
  renderTitle(e);
  const date = e.published ? new Date(e.published).toLocaleString('zh-CN') : '';
  $('#reader-meta').textContent = [e.author, date].filter(Boolean).join(' · ');
  $('#reader-open').href = e.link || '#';
  const starBtn = $('#reader-star');
  starBtn.classList.toggle('starred', state.starred.has(e.id));
  starBtn.textContent = state.starred.has(e.id) ? '★ 已收藏' : '★ 收藏';
  $('#comment-input').value = '';
  loadTranslation(e);
  loadComments(e);
  loadAgentMessages(e);

  $('#reader-audio').innerHTML = e.audio ? `<audio controls preload="none" src="${escapeHtml(e.audio.url)}"></audio>` : '';
  $('#reader-pane').scrollTop = 0;
  document.getElementById('app').classList.add('reading');
  renderAgent();

  renderList();
  renderSidebar();

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
  $('#reader-content').innerHTML = sanitize(content || `<p>${e.summary || '（无内容，请打开原文）'}</p>`);
  $$('#reader-content a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
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

function renderAiSettings() {
  const providerSelect = $('#ai-provider');
  providerSelect.innerHTML = Object.entries(AI_PROVIDERS)
    .map(([id, p]) => `<option value="${escapeHtml(id)}">${escapeHtml(p.title)}</option>`)
    .join('');
  providerSelect.value = state.aiProvider;
  const provider = AI_PROVIDERS[state.aiProvider];
  const config = currentAiConfig();
  $('#profile-api-key').placeholder = provider.keyPlaceholder;
  $('#profile-api-key').value = config.apiKey || '';
  $('#ai-base-url').value = config.baseUrl || provider.defaultBaseUrl;
  $('#ai-model').value = config.model || provider.defaultModel;
  $('#ai-config-note').textContent = provider.subtitle;
}

function saveCurrentAiSettings() {
  const provider = normalizeProvider(state.aiProvider);
  state.aiConfigs[provider] = {
    apiKey: $('#profile-api-key').value.trim(),
    baseUrl: $('#ai-base-url').value.trim() || AI_PROVIDERS[provider].defaultBaseUrl,
    model: $('#ai-model').value.trim() || AI_PROVIDERS[provider].defaultModel,
  };
  persistAiConfig();
  updateAgentControls();
}

function switchAiProvider(provider) {
  saveCurrentAiSettings();
  state.aiProvider = normalizeProvider(provider);
  persistAiConfig();
  renderAiSettings();
  updateAgentControls();
}

async function testAiConnection() {
  saveCurrentAiSettings();
  if (!requireAuth('login')) return;
  if (!currentAiConfig().apiKey.trim()) {
    toast('请先填写 API Key');
    return;
  }
  const btn = $('#ai-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    const data = await api('/api/ai/models', {
      method: 'POST',
      ai: true,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const models = data.models || [];
    if (models.length && !models.includes(currentAiConfig().model)) {
      $('#ai-config-note').textContent = `连接可用，发现 ${models.length} 个模型`;
    } else {
      $('#ai-config-note').textContent = '连接可用';
    }
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
$('#mark-read-btn').onclick = () => {
  visibleEntries().forEach(e => state.read.add(e.id));
  persist(); renderList(); renderSidebar();
  toast('已全部标为已读');
};
$('#reader-star').onclick = () => {
  const e = state.activeEntry;
  if (!e) return;
  state.starred.has(e.id) ? state.starred.delete(e.id) : state.starred.add(e.id);
  persist(); openEntry(e);
};
$('#reader-bilingual').onclick = generateTranslation;
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
$('#agent-settings').onclick = () => {
  renderAiSettings();
  $('#agent-settings-panel').classList.toggle('hidden');
};
$('#ai-provider').onchange = (e) => switchAiProvider(e.target.value);
$('#profile-api-key').oninput = saveCurrentAiSettings;
$('#ai-base-url').oninput = saveCurrentAiSettings;
$('#ai-model').oninput = saveCurrentAiSettings;
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
  }
});

/* ---------- Init ---------- */
(async function init() {
  document.body.dataset.theme = storage.getItem('fr_theme') || 'light';
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
