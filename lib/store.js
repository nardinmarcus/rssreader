const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'qmreader.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    author TEXT,
    published TEXT,
    published_ts INTEGER DEFAULT 0,
    summary TEXT,
    content TEXT,
    image TEXT,
    audio_json TEXT,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_source_published
    ON entries(source_id, published_ts DESC);

  CREATE TABLE IF NOT EXISTS entry_translations (
    entry_id TEXT PRIMARY KEY,
    title_zh TEXT,
    summary_zh TEXT,
    content_json TEXT,
    model TEXT,
    provider TEXT DEFAULT 'deepseek',
    created_by TEXT,
    content_hash TEXT,
    title_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entry_rewrites (
    entry_id TEXT PRIMARY KEY,
    title TEXT,
    body TEXT NOT NULL,
    model TEXT,
    provider TEXT DEFAULT 'deepseek',
    created_by TEXT,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS commentaries (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    user_id TEXT,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    model TEXT,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_commentaries_entry
    ON commentaries(entry_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    user_id TEXT,
    role TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_entry
    ON chat_messages(entry_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_users_email
    ON users(email);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(user_id, expires_at DESC);

  CREATE TABLE IF NOT EXISTS user_entry_states (
    user_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    read_at INTEGER,
    starred_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, entry_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_entry_states_starred
    ON user_entry_states(user_id, starred_at DESC);

  CREATE INDEX IF NOT EXISTS idx_user_entry_states_read
    ON user_entry_states(user_id, read_at DESC);

  CREATE TABLE IF NOT EXISTS refresh_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
`);

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn('commentaries', 'user_id', 'user_id TEXT');
ensureColumn('chat_messages', 'user_id', 'user_id TEXT');

const upsertEntryStmt = db.prepare(`
  INSERT INTO entries (
    id, source_id, title, link, author, published, published_ts, summary,
    content, image, audio_json, content_hash, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    source_id = excluded.source_id,
    title = excluded.title,
    link = excluded.link,
    author = excluded.author,
    published = excluded.published,
    published_ts = excluded.published_ts,
    summary = excluded.summary,
    content = excluded.content,
    image = excluded.image,
    audio_json = excluded.audio_json,
    content_hash = excluded.content_hash,
    updated_at = excluded.updated_at
`);
const existingEntryForUpsertStmt = db.prepare('SELECT content, summary, image FROM entries WHERE id = ?');

function plainTextLength(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function assetSnippet(value, max = 180) {
  const text = String(value || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

function translationSnippet(content) {
  const pairs = Array.isArray(content) ? content : [];
  const hit = pairs.find(pair => pair && pair.target);
  return hit ? assetSnippet(hit.target) : '';
}

function now() {
  return Date.now();
}

function publicAuthor(author) {
  const clean = String(author || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 40) || '读者';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function assertPassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128) {
    const err = new Error('密码长度需要在 8 到 128 个字符之间');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: passwordHash(password, salt) };
}

function verifyPassword(password, salt, hash) {
  const actual = Buffer.from(passwordHash(password, salt), 'hex');
  const expected = Buffer.from(hash || '', 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  };
}

function createUser({ email, password, displayName = '', role = 'user' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    const err = new Error('请输入有效邮箱');
    err.statusCode = 400;
    throw err;
  }
  const cleanPassword = assertPassword(password);
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) {
    const err = new Error('这个邮箱已经注册');
    err.statusCode = 409;
    throw err;
  }
  const id = crypto.randomUUID();
  const t = now();
  const record = createPasswordRecord(cleanPassword);
  db.prepare(`
    INSERT INTO users (id, email, display_name, role, password_hash, password_salt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizedEmail,
    publicAuthor(displayName || normalizedEmail.split('@')[0]),
    role === 'admin' ? 'admin' : 'user',
    record.hash,
    record.salt,
    t,
    t,
  );
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function ensureAdminUser({ email, password, displayName = '向阳乔木' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) return null;
  if (!isValidEmail(normalizedEmail)) throw new Error('ADMIN_EMAIL is invalid');
  const cleanPassword = assertPassword(password);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  const record = createPasswordRecord(cleanPassword);
  const t = now();
  if (row) {
    db.prepare(`
      UPDATE users
      SET display_name = ?, role = 'admin', password_hash = ?, password_salt = ?, updated_at = ?
      WHERE email = ?
    `).run(publicAuthor(displayName), record.hash, record.salt, t, normalizedEmail);
  } else {
    db.prepare(`
      INSERT INTO users (id, email, display_name, role, password_hash, password_salt, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)
    `).run(crypto.randomUUID(), normalizedEmail, publicAuthor(displayName), record.hash, record.salt, t, t);
  }
  return publicUser(db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail));
}

function authenticateUser(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!row || !verifyPassword(String(password || ''), row.password_salt, row.password_hash)) {
    const err = new Error('邮箱或密码不正确');
    err.statusCode = 401;
    throw err;
  }
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), row.id);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createSession(userId, ttlMs = 1000 * 60 * 60 * 24 * 30) {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  const expiresAt = t + ttlMs;
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(hashSessionToken(token), userId, expiresAt, t);
  return { token, expiresAt };
}

function getUserBySessionToken(token) {
  if (!token) return null;
  cleanupExpiredSessions();
  return publicUser(db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashSessionToken(token), now()));
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
}

function normalizeEntryId(entryId) {
  return String(entryId || '').trim().slice(0, 80);
}

function getUserEntryStates(userId) {
  const rows = db.prepare(`
    SELECT entry_id, read_at, starred_at
    FROM user_entry_states
    WHERE user_id = ? AND (read_at IS NOT NULL OR starred_at IS NOT NULL)
  `).all(userId);
  return {
    read: rows.filter(row => row.read_at).map(row => row.entry_id),
    starred: rows.filter(row => row.starred_at).map(row => row.entry_id),
  };
}

function getUserEntryState(userId, entryId) {
  const row = db.prepare(`
    SELECT entry_id, read_at, starred_at
    FROM user_entry_states
    WHERE user_id = ? AND entry_id = ?
  `).get(userId, normalizeEntryId(entryId));
  return {
    entryId: normalizeEntryId(entryId),
    read: Boolean(row && row.read_at),
    starred: Boolean(row && row.starred_at),
    readAt: row && row.read_at ? row.read_at : null,
    starredAt: row && row.starred_at ? row.starred_at : null,
  };
}

function setUserEntryState(userId, entryId, { read, starred } = {}) {
  const id = normalizeEntryId(entryId);
  if (!userId || !id) {
    const err = new Error('entryId is required');
    err.statusCode = 400;
    throw err;
  }

  const existing = db.prepare(`
    SELECT read_at, starred_at
    FROM user_entry_states
    WHERE user_id = ? AND entry_id = ?
  `).get(userId, id);
  const t = now();
  const readAt = read === true ? (existing && existing.read_at) || t : read === false ? null : existing && existing.read_at;
  const starredAt = starred === true ? (existing && existing.starred_at) || t : starred === false ? null : existing && existing.starred_at;

  if (!readAt && !starredAt) {
    db.prepare('DELETE FROM user_entry_states WHERE user_id = ? AND entry_id = ?').run(userId, id);
  } else {
    db.prepare(`
      INSERT INTO user_entry_states (user_id, entry_id, read_at, starred_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, entry_id) DO UPDATE SET
        read_at = excluded.read_at,
        starred_at = excluded.starred_at,
        updated_at = excluded.updated_at
    `).run(userId, id, readAt || null, starredAt || null, t);
  }
  return getUserEntryState(userId, id);
}

function markEntriesRead(userId, entryIds) {
  const ids = [...new Set((entryIds || []).map(normalizeEntryId).filter(Boolean))].slice(0, 1000);
  const stmt = db.prepare(`
    INSERT INTO user_entry_states (user_id, entry_id, read_at, starred_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(user_id, entry_id) DO UPDATE SET
      read_at = COALESCE(user_entry_states.read_at, excluded.read_at),
      updated_at = excluded.updated_at
  `);
  const t = now();
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(userId, id, t, t);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getUserEntryStates(userId);
}

function normalizeEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    titleZh: row.title_zh || null,
    link: row.link || '',
    author: row.author || '',
    published: row.published || null,
    publishedTs: row.published_ts || 0,
    summary: row.summary || '',
    summaryZh: row.summary_zh || null,
    content: row.content || '',
    image: row.image || null,
    audio: safeJsonParse(row.audio_json, null),
    contentHash: row.content_hash || null,
  };
}

function upsertEntries(entries) {
  db.exec('BEGIN');
  try {
    const t = now();
    for (const entry of entries || []) {
      const existing = existingEntryForUpsertStmt.get(entry.id);
      const incomingContent = entry.content || '';
      const existingContent = existing && existing.content ? existing.content : '';
      const content = existingContent && plainTextLength(existingContent) > plainTextLength(incomingContent) + 240
        ? existingContent
        : incomingContent;
      const summary = entry.summary || (existing && existing.summary) || '';
      const image = entry.image || (existing && existing.image) || null;
      upsertEntryStmt.run(
        entry.id,
        entry.sourceId,
        entry.title || '(无标题)',
        entry.link || '',
        entry.author || '',
        entry.published || null,
        entry.publishedTs || 0,
        summary,
        content,
        image,
        entry.audio ? JSON.stringify(entry.audio) : null,
        hashText((entry.title || '') + '\n' + (content || summary || '')),
        t,
        t,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getEntry(id) {
  return normalizeEntry(db.prepare(`
    SELECT e.*, t.title_zh, t.summary_zh
    FROM entries e
    LEFT JOIN entry_translations t ON t.entry_id = e.id
    WHERE e.id = ?
  `).get(id));
}

function updateEntryContent(entryId, { content = '', summary = '', image = null } = {}) {
  const id = normalizeEntryId(entryId);
  const entry = getEntry(id);
  if (!entry) return null;
  const nextContent = String(content || '').trim();
  if (!nextContent) return entry;
  const nextSummary = String(summary || '').trim().slice(0, 320) || entry.summary || '';
  const nextImage = image || entry.image || null;
  const t = now();
  db.prepare(`
    UPDATE entries
    SET content = ?,
        summary = ?,
        image = ?,
        content_hash = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextContent,
    nextSummary,
    nextImage,
    hashText((entry.title || '') + '\n' + (nextContent || nextSummary || '')),
    t,
    id,
  );
  return getEntry(id);
}

function getTitleTranslations(ids) {
  if (!ids.length) return {};
  const out = {};
  const stmt = db.prepare("SELECT entry_id, title_zh FROM entry_translations WHERE entry_id = ? AND title_zh IS NOT NULL AND title_zh <> ''");
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) out[id] = row.title_zh;
  }
  return out;
}

function getEntryAssetSummaries(ids) {
  const cleanIds = [...new Set((ids || []).map(normalizeEntryId).filter(Boolean))];
  const out = {};
  for (const id of cleanIds) {
    out[id] = {
      translation: false,
      rewrite: false,
      comments: 0,
      chatMessages: 0,
      latestAt: 0,
      latestTypes: [],
      preview: null,
      previews: {},
      items: {},
    };
  }
  if (!cleanIds.length) return out;
  const placeholders = cleanIds.map(() => '?').join(',');

  function markAsset(entryId, type, timestamp) {
    const asset = out[entryId];
    if (!asset) return;
    const t = Number(timestamp) || 0;
    if (t > asset.latestAt) {
      asset.latestAt = t;
      asset.latestTypes = [type];
      return;
    }
    if (t && t === asset.latestAt && !asset.latestTypes.includes(type)) {
      asset.latestTypes.push(type);
    }
  }

  function setPreview(entryId, type, timestamp, data = {}) {
    const asset = out[entryId];
    if (!asset) return;
    const text = assetSnippet(data.text);
    if (!text) return;
    const preview = {
      type,
      id: data.id || '',
      role: data.role || '',
      author: data.author || '',
      model: data.model || '',
      text,
      at: Number(timestamp) || 0,
    };
    asset.previews[type] = preview;
    if (!asset.preview || preview.at >= Number(asset.preview.at || 0)) {
      asset.preview = preview;
    }
  }

  function addItemPreview(entryId, type, timestamp, data = {}) {
    const asset = out[entryId];
    if (!asset) return;
    const text = assetSnippet(data.text);
    if (!text) return;
    if (!asset.items[type]) asset.items[type] = [];
    if (asset.items[type].length >= 3) return;
    asset.items[type].push({
      type,
      id: data.id || '',
      role: data.role || '',
      author: data.author || '',
      model: data.model || '',
      text,
      at: Number(timestamp) || 0,
    });
  }

  for (const row of db.prepare(`
    SELECT entry_id, content_json, model, created_by, updated_at
    FROM entry_translations
    WHERE entry_id IN (${placeholders})
  `).all(...cleanIds)) {
    const content = safeJsonParse(row.content_json, []);
    if (out[row.entry_id] && Array.isArray(content) && content.length > 0) {
      out[row.entry_id].translation = true;
      markAsset(row.entry_id, 'translation', row.updated_at);
      setPreview(row.entry_id, 'translation', row.updated_at, {
        author: row.created_by || '',
        model: row.model || '',
        text: translationSnippet(content),
      });
    }
  }

  for (const row of db.prepare(`
    SELECT entry_id, body, model, created_by, updated_at
    FROM entry_rewrites
    WHERE entry_id IN (${placeholders}) AND body IS NOT NULL AND body <> ''
  `).all(...cleanIds)) {
    if (out[row.entry_id]) {
      out[row.entry_id].rewrite = true;
      markAsset(row.entry_id, 'rewrite', row.updated_at);
      setPreview(row.entry_id, 'rewrite', row.updated_at, {
        author: row.created_by || '',
        model: row.model || '',
        text: row.body || '',
      });
    }
  }

  for (const row of db.prepare(`
    SELECT entry_id, COUNT(*) AS count, MAX(updated_at) AS latest_at
    FROM commentaries
    WHERE entry_id IN (${placeholders}) AND is_public = 1
    GROUP BY entry_id
  `).all(...cleanIds)) {
    if (out[row.entry_id]) {
      out[row.entry_id].comments = row.count || 0;
      markAsset(row.entry_id, 'comments', row.latest_at);
    }
  }

  for (const row of db.prepare(`
    SELECT c.entry_id, c.id, c.author, c.body, c.model, c.created_at, c.updated_at
    FROM commentaries c
    JOIN (
      SELECT entry_id, MAX(updated_at) AS latest_at
      FROM commentaries
      WHERE entry_id IN (${placeholders}) AND is_public = 1
      GROUP BY entry_id
    ) latest ON latest.entry_id = c.entry_id AND latest.latest_at = c.updated_at
    WHERE c.is_public = 1
  `).all(...cleanIds)) {
    setPreview(row.entry_id, 'comments', row.updated_at || row.created_at, {
      id: row.id,
      author: row.author,
      model: row.model || '',
      text: row.body,
    });
  }

  for (const row of db.prepare(`
    SELECT entry_id, id, author, body, model, created_at, updated_at
    FROM commentaries
    WHERE entry_id IN (${placeholders}) AND is_public = 1
    ORDER BY entry_id, updated_at DESC
  `).all(...cleanIds)) {
    addItemPreview(row.entry_id, 'comments', row.updated_at || row.created_at, {
      id: row.id,
      author: row.author,
      model: row.model || '',
      text: row.body,
    });
  }

  for (const row of db.prepare(`
    SELECT entry_id, COUNT(*) AS count, MAX(created_at) AS latest_at
    FROM chat_messages
    WHERE entry_id IN (${placeholders}) AND is_public = 1
    GROUP BY entry_id
  `).all(...cleanIds)) {
    if (out[row.entry_id]) {
      out[row.entry_id].chatMessages = row.count || 0;
      markAsset(row.entry_id, 'chat', row.latest_at);
    }
  }

  for (const row of db.prepare(`
    SELECT m.entry_id, m.id, m.role, m.author, m.content, m.model, m.created_at
    FROM chat_messages m
    JOIN (
      SELECT entry_id, MAX(created_at) AS latest_at
      FROM chat_messages
      WHERE entry_id IN (${placeholders}) AND is_public = 1
      GROUP BY entry_id
    ) latest ON latest.entry_id = m.entry_id AND latest.latest_at = m.created_at
    WHERE m.is_public = 1
  `).all(...cleanIds)) {
    setPreview(row.entry_id, 'chat', row.created_at, {
      id: row.id,
      role: row.role,
      author: row.author,
      model: row.model || '',
      text: row.content,
    });
  }

  for (const row of db.prepare(`
    SELECT entry_id, id, role, author, content, model, created_at
    FROM chat_messages
    WHERE entry_id IN (${placeholders}) AND is_public = 1
    ORDER BY entry_id, created_at DESC
  `).all(...cleanIds)) {
    addItemPreview(row.entry_id, 'chat', row.created_at, {
      id: row.id,
      role: row.role,
      author: row.author,
      model: row.model || '',
      text: row.content,
    });
  }

  return out;
}

function saveTitleTranslations(items, { model = '', provider = 'deepseek', author = 'system' } = {}) {
  const stmt = db.prepare(`
    INSERT INTO entry_translations (
      entry_id, title_zh, model, provider, created_by, title_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      title_zh = excluded.title_zh,
      model = excluded.model,
      provider = excluded.provider,
      created_by = COALESCE(entry_translations.created_by, excluded.created_by),
      title_hash = excluded.title_hash,
      updated_at = excluded.updated_at
  `);
  db.exec('BEGIN');
  try {
    const t = now();
    for (const item of items || []) {
      if (!item || !item.entryId || !item.titleZh) continue;
      stmt.run(item.entryId, item.titleZh, model, provider, publicAuthor(author), item.titleHash || '', t, t);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getTranslation(entryId) {
  const row = db.prepare('SELECT * FROM entry_translations WHERE entry_id = ?').get(entryId);
  if (!row) return null;
  return {
    entryId: row.entry_id,
    titleZh: row.title_zh || '',
    summaryZh: row.summary_zh || '',
    content: safeJsonParse(row.content_json, null),
    model: row.model || '',
    provider: row.provider || 'deepseek',
    createdBy: row.created_by || 'system',
    contentHash: row.content_hash || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveTranslation(entryId, translation) {
  const t = now();
  db.prepare(`
    INSERT INTO entry_translations (
      entry_id, title_zh, summary_zh, content_json, model, provider, created_by,
      content_hash, title_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      title_zh = COALESCE(NULLIF(excluded.title_zh, ''), entry_translations.title_zh),
      summary_zh = excluded.summary_zh,
      content_json = excluded.content_json,
      model = excluded.model,
      provider = excluded.provider,
      created_by = excluded.created_by,
      content_hash = excluded.content_hash,
      title_hash = excluded.title_hash,
      updated_at = excluded.updated_at
  `).run(
    entryId,
    translation.titleZh || '',
    translation.summaryZh || '',
    JSON.stringify(translation.content || []),
    translation.model || '',
    translation.provider || 'deepseek',
    publicAuthor(translation.createdBy || 'system'),
    translation.contentHash || '',
    translation.titleHash || '',
    t,
    t,
  );
  return getTranslation(entryId);
}

function getRewrite(entryId) {
  const row = db.prepare('SELECT * FROM entry_rewrites WHERE entry_id = ?').get(entryId);
  if (!row) return null;
  return {
    entryId: row.entry_id,
    title: row.title || '',
    body: row.body || '',
    model: row.model || '',
    provider: row.provider || 'deepseek',
    createdBy: row.created_by || 'system',
    contentHash: row.content_hash || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveRewrite(entryId, rewrite) {
  const t = now();
  db.prepare(`
    INSERT INTO entry_rewrites (
      entry_id, title, body, model, provider, created_by, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      model = excluded.model,
      provider = excluded.provider,
      created_by = excluded.created_by,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(
    entryId,
    rewrite.title || '',
    rewrite.body || '',
    rewrite.model || '',
    rewrite.provider || 'deepseek',
    publicAuthor(rewrite.createdBy || 'system'),
    rewrite.contentHash || '',
    t,
    t,
  );
  return getRewrite(entryId);
}

function canDeleteAsset(row, viewer = null) {
  if (!row || !viewer) return false;
  if (viewer.role === 'admin') return true;
  return Boolean(row.user_id && viewer.id && row.user_id === viewer.id);
}

function getComments(entryId, viewer = null) {
  return db.prepare(`
    SELECT id, entry_id, user_id, author, body, model, created_at, updated_at
    FROM commentaries
    WHERE entry_id = ? AND is_public = 1
    ORDER BY created_at DESC
  `).all(entryId).map(row => ({
    id: row.id,
    entryId: row.entry_id,
    author: row.author,
    body: row.body,
    model: row.model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canDelete: canDeleteAsset(row, viewer),
    canEdit: canDeleteAsset(row, viewer),
  }));
}

function getComment(entryId, commentId) {
  const row = db.prepare(`
    SELECT id, entry_id, author, body, model, created_at, updated_at
    FROM commentaries
    WHERE entry_id = ? AND id = ? AND is_public = 1
  `).get(entryId, String(commentId || '').trim());
  if (!row) return null;
  return {
    id: row.id,
    entryId: row.entry_id,
    author: row.author,
    body: row.body,
    model: row.model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addComment(entryId, { userId = null, author, body, model = '' }) {
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(`
    INSERT INTO commentaries (id, entry_id, user_id, author, body, model, is_public, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, entryId, userId, publicAuthor(author), String(body || '').trim().slice(0, 5000), model || '', t, t);
  return getComments(entryId).find(comment => comment.id === id);
}

function updateComment(entryId, commentId, { body = '' } = {}, viewer = null) {
  const id = String(commentId || '').trim();
  const row = db.prepare(`
    SELECT id, user_id
    FROM commentaries
    WHERE entry_id = ? AND id = ? AND is_public = 1
  `).get(entryId, id);
  if (!row) return false;
  if (!canDeleteAsset(row, viewer)) {
    const err = new Error('没有权限编辑这条点评');
    err.statusCode = 403;
    throw err;
  }
  const nextBody = String(body || '').trim().slice(0, 5000);
  if (!nextBody) {
    const err = new Error('comment body is required');
    err.statusCode = 400;
    throw err;
  }
  db.prepare('UPDATE commentaries SET body = ?, updated_at = ? WHERE entry_id = ? AND id = ?').run(nextBody, now(), entryId, id);
  return getComment(entryId, id);
}

function deleteComment(entryId, commentId, viewer = null) {
  const id = String(commentId || '').trim();
  const row = db.prepare(`
    SELECT id, user_id
    FROM commentaries
    WHERE entry_id = ? AND id = ? AND is_public = 1
  `).get(entryId, id);
  if (!row) return false;
  if (!canDeleteAsset(row, viewer)) {
    const err = new Error('没有权限撤回这条点评');
    err.statusCode = 403;
    throw err;
  }
  db.prepare('UPDATE commentaries SET is_public = 0, updated_at = ? WHERE entry_id = ? AND id = ?').run(now(), entryId, id);
  return true;
}

function getChatMessages(entryId, viewer = null) {
  return db.prepare(`
    SELECT id, entry_id, user_id, role, author, content, model, created_at
    FROM chat_messages
    WHERE entry_id = ? AND is_public = 1
    ORDER BY created_at ASC
  `).all(entryId).map(row => ({
    id: row.id,
    entryId: row.entry_id,
    role: row.role,
    author: row.author,
    content: row.content,
    model: row.model || '',
    createdAt: row.created_at,
    canDelete: canDeleteAsset(row, viewer),
  }));
}

function getChatMessage(entryId, messageId) {
  const row = db.prepare(`
    SELECT id, entry_id, role, author, content, model, created_at
    FROM chat_messages
    WHERE entry_id = ? AND id = ? AND is_public = 1
  `).get(entryId, String(messageId || '').trim());
  if (!row) return null;
  return {
    id: row.id,
    entryId: row.entry_id,
    role: row.role,
    author: row.author,
    content: row.content,
    model: row.model || '',
    createdAt: row.created_at,
  };
}

function addChatMessage(entryId, { userId = null, role, author, content, model = '' }) {
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(`
    INSERT INTO chat_messages (id, entry_id, user_id, role, author, content, model, is_public, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    entryId,
    userId,
    role === 'assistant' ? 'assistant' : 'user',
    publicAuthor(author),
    String(content || '').trim().slice(0, 6000),
    model || '',
    t,
  );
  return getChatMessages(entryId).find(message => message.id === id);
}

function deleteChatMessage(entryId, messageId, viewer = null) {
  const id = String(messageId || '').trim();
  const row = db.prepare(`
    SELECT id, user_id
    FROM chat_messages
    WHERE entry_id = ? AND id = ? AND is_public = 1
  `).get(entryId, id);
  if (!row) return false;
  if (!canDeleteAsset(row, viewer)) {
    const err = new Error('没有权限撤回这条对话');
    err.statusCode = 403;
    throw err;
  }
  db.prepare('UPDATE chat_messages SET is_public = 0 WHERE entry_id = ? AND id = ?').run(entryId, id);
  return true;
}

function logRefreshJob(kind, status, message = '') {
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(`
    INSERT INTO refresh_jobs (id, kind, status, message, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, kind, status, String(message || '').slice(0, 500), t, status === 'started' ? null : t);
  return id;
}

module.exports = {
  addChatMessage,
  addComment,
  authenticateUser,
  createSession,
  createUser,
  deleteChatMessage,
  deleteComment,
  deleteSession,
  ensureAdminUser,
  getChatMessages,
  getChatMessage,
  getComment,
  getComments,
  getEntry,
  getEntryAssetSummaries,
  getRewrite,
  getTitleTranslations,
  getTranslation,
  getUserEntryState,
  getUserEntryStates,
  getUserBySessionToken,
  hashText,
  logRefreshJob,
  markEntriesRead,
  saveTitleTranslations,
  saveTranslation,
  saveRewrite,
  setUserEntryState,
  updateComment,
  updateEntryContent,
  upsertEntries,
};
