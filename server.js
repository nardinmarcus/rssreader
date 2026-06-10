const express = require('express');
const path = require('path');
const compression = require('compression');
const fetcher = require('./lib/fetcher');
const deepseek = require('./lib/deepseek');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 8080;
const DAILY_REFRESH_HOUR_SHANGHAI = 8;
const TITLE_TRANSLATION_LIMIT = parseInt(process.env.TITLE_TRANSLATION_LIMIT || '80', 10);
const SESSION_COOKIE = 'qm_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.user = store.getUserBySessionToken(cookieValue(req, SESSION_COOKIE));
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

let refreshing = false;
let refreshProgress = { done: 0, total: 0 };

function cookieValue(req, name) {
  const header = String(req.headers.cookie || '');
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return '';
}

function secureCookie(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https' || process.env.COOKIE_SECURE === '1';
}

function setSessionCookie(req, res, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}`,
  ];
  if (secureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function sendError(res, error, fallback = 'request failed') {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || fallback });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: '请先登录或注册账号' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: '需要管理员权限' });
}

function requestAiConfig(req) {
  return {
    apiKey: String(req.get('x-ai-key') || req.get('x-deepseek-key') || '').trim(),
    provider: String(req.get('x-ai-provider') || 'deepseek').trim(),
    providerName: String(req.get('x-ai-provider-name') || '').trim(),
    providerType: String(req.get('x-ai-provider-type') || 'openai_compatible').trim(),
    baseUrl: String(req.get('x-ai-base-url') || '').trim(),
    model: String(req.get('x-ai-model') || '').trim(),
    temperature: String(req.get('x-ai-temperature') || '').trim(),
    maxTokens: String(req.get('x-ai-max-tokens') || '').trim(),
  };
}

function requestAuthor(req) {
  return req.user ? req.user.displayName : '读者';
}

function translationResponse(entry) {
  const translation = store.getTranslation(entry.id);
  if (!translation) return null;
  const contentHash = store.hashText((entry.title || '') + '\n' + (entry.content || entry.summary || ''));
  return {
    ...translation,
    stale: Boolean(translation.contentHash && translation.contentHash !== contentHash),
  };
}

function rewriteResponse(entry) {
  const rewrite = store.getRewrite(entry.id);
  if (!rewrite) return null;
  const contentHash = deepseek.rewriteContentHash(entry);
  return {
    ...rewrite,
    stale: Boolean(rewrite.contentHash && rewrite.contentHash !== contentHash),
  };
}

async function translateMissingTitles(limit = TITLE_TRANSLATION_LIMIT) {
  if (!deepseek.getConfig().configured) return 0;
  const entries = fetcher.getEntries({ limit: 1000 })
    .filter(entry => deepseek.isLikelyEnglish(entry.title) && !entry.titleZh)
    .slice(0, limit);
  let translated = 0;
  for (let i = 0; i < entries.length; i += 20) {
    const result = await deepseek.translateTitleBatch(entries.slice(i, i + 20), { author: 'system' });
    translated += result.translations.length;
  }
  return translated;
}

function seedAdminFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!email || !password) return;
  try {
    store.ensureAdminUser({
      email,
      password,
      displayName: process.env.ADMIN_NAME || '向阳乔木',
    });
    console.log(`Admin user ready: ${email}`);
  } catch (error) {
    console.warn('Admin user seed skipped:', error.message || error);
  }
}

async function doRefreshAll() {
  if (refreshing) return;
  refreshing = true;
  refreshProgress = { done: 0, total: 0 };
  try {
    await fetcher.refreshAll((done, total) => { refreshProgress = { done, total }; });
    try {
      await translateMissingTitles();
    } catch (e) {
      console.warn('Title translation skipped:', e.message || e);
    }
  } catch (e) {
    console.error('Refresh failed:', e.message || e);
  } finally {
    refreshing = false;
  }
}

function nextShanghaiRefreshDelay() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now).map(part => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const addDay = hour >= DAILY_REFRESH_HOUR_SHANGHAI ? 1 : 0;
  const targetUtc = Date.UTC(year, month - 1, day + addDay, DAILY_REFRESH_HOUR_SHANGHAI - 8, 0, 0);
  return Math.max(targetUtc - now.getTime(), 60 * 1000);
}

function scheduleDailyRefresh() {
  const delay = nextShanghaiRefreshDelay();
  setTimeout(async () => {
    try {
      await doRefreshAll();
    } finally {
      scheduleDailyRefresh();
    }
  }, delay);
}

app.get('/api/sources', (req, res) => {
  res.json({ sources: fetcher.getSourcesMeta(), refreshing, progress: refreshProgress });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/register', (req, res) => {
  try {
    const user = store.createUser({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      displayName: req.body && req.body.displayName,
    });
    const session = store.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({ user });
  } catch (e) {
    sendError(res, e, 'register failed');
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = store.authenticateUser(req.body && req.body.email, req.body && req.body.password);
    const session = store.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({ user });
  } catch (e) {
    sendError(res, e, 'login failed');
  }
});

app.post('/api/auth/logout', (req, res) => {
  store.deleteSession(cookieValue(req, SESSION_COOKIE));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me/entry-states', requireLogin, (req, res) => {
  res.json({ states: store.getUserEntryStates(req.user.id) });
});

app.post('/api/me/entry-state', requireLogin, (req, res) => {
  const { entryId, read, starred } = req.body || {};
  const entry = fetcher.getEntryById(entryId);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const entryState = store.setUserEntryState(req.user.id, entry.id, {
      read: typeof read === 'boolean' ? read : undefined,
      starred: typeof starred === 'boolean' ? starred : undefined,
    });
    res.json({ entryState });
  } catch (e) {
    sendError(res, e, 'entry state update failed');
  }
});

app.post('/api/me/entry-states/read', requireLogin, (req, res) => {
  const requested = Array.isArray(req.body && req.body.entryIds) ? req.body.entryIds : [];
  const entryIds = requested
    .map(id => fetcher.getEntryById(id))
    .filter(Boolean)
    .map(entry => entry.id);
  try {
    res.json({ states: store.markEntriesRead(req.user.id, entryIds) });
  } catch (e) {
    sendError(res, e, 'entry states update failed');
  }
});

app.post('/api/ai/models', requireLogin, async (req, res) => {
  try {
    const result = await deepseek.listModels(requestAiConfig(req));
    res.json(result);
  } catch (e) {
    sendError(res, e, 'models request failed');
  }
});

app.post('/api/ai/test', requireLogin, async (req, res) => {
  try {
    const result = await deepseek.testConnection(requestAiConfig(req));
    res.json(result);
  } catch (e) {
    sendError(res, e, 'AI connection test failed');
  }
});

// List endpoint omits full content to keep the payload small; fetch it per-entry on open.
app.get('/api/entries', (req, res) => {
  const { source, category, q, limit } = req.query;
  const entries = fetcher.getEntries({
    sourceId: source || undefined,
    category: category || undefined,
    q: q || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  }).map(({ content, ...rest }) => rest);
  res.json({ entries });
});

app.get('/api/entry/:id', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ entry });
});

app.post('/api/entry/:id/content', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const updated = await fetcher.fetchEntryOriginal(entry);
    res.json({ entry: updated });
  } catch (e) {
    sendError(res, e, 'fetch original content failed');
  }
});

app.get('/api/entry/:id/translation', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ translation: translationResponse(entry) });
});

app.post('/api/entry/:id/translation', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const result = await deepseek.translateEntry(entry, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      force: Boolean(req.body && req.body.force),
    });
    res.json(result);
  } catch (e) {
    sendError(res, e, 'translation failed');
  }
});

app.get('/api/entry/:id/rewrite', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ rewrite: rewriteResponse(entry) });
});

app.post('/api/entry/:id/rewrite', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const result = await deepseek.rewriteEntry(entry, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      force: Boolean(req.body && req.body.force),
    });
    res.json(result);
  } catch (e) {
    sendError(res, e, 'rewrite failed');
  }
});

app.get('/api/entry/:id/comments', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ comments: require('./lib/store').getComments(entry.id) });
});

app.post('/api/entry/:id/comments', requireLogin, (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'comment body is required' });
  const comment = store.addComment(entry.id, {
    userId: req.user.id,
    author: requestAuthor(req),
    body,
  });
  res.json({ comment, comments: store.getComments(entry.id) });
});

app.post('/api/entry/:id/chat', requireLogin, async (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  try {
    const result = await deepseek.chatWithEntry(entry, req.body && req.body.messages, {
      ...requestAiConfig(req),
      author: requestAuthor(req),
      userId: req.user.id,
    });
    res.json(result);
  } catch (e) {
    sendError(res, e, 'chat failed');
  }
});

app.get('/api/entry/:id/chat', (req, res) => {
  const entry = fetcher.getEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  res.json({ messages: require('./lib/store').getChatMessages(entry.id) });
});

app.post('/api/translate-titles', requireAdmin, async (req, res) => {
  try {
    const translated = await translateMissingTitles(parseInt((req.body && req.body.limit) || TITLE_TRANSLATION_LIMIT, 10));
    res.json({ translated });
  } catch (e) {
    sendError(res, e, 'title translation failed');
  }
});

app.post('/api/refresh', requireAdmin, async (req, res) => {
  const { sourceId } = req.body || {};
  if (sourceId) {
    const src = fetcher.getSourceById(sourceId);
    if (!src) return res.status(404).json({ error: 'source not found' });
    const result = await fetcher.fetchSource(src);
    await translateMissingTitles(20);
    return res.json({ status: result.status, error: result.error, entryCount: result.entries ? result.entries.length : 0 });
  }
  doRefreshAll();
  res.json({ started: true });
});

app.post('/api/sources/:id/toggle', requireAdmin, async (req, res) => {
  const src = fetcher.getSourceById(req.params.id);
  if (!src) return res.status(404).json({ error: 'source not found' });
  const enabled = !fetcher.isEnabled(src);
  fetcher.setEnabled(src.id, enabled);
  if (enabled) fetcher.fetchSource(src);
  res.json({ id: src.id, enabled });
});

app.listen(PORT, () => {
  console.log(`QMReader listening on http://localhost:${PORT}`);
  seedAdminFromEnv();
  fetcher.loadDisk();
  doRefreshAll();
  scheduleDailyRefresh();
});
