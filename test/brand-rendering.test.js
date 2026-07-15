const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const projectDir = path.join(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(dataDir, env = {}) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      NAMOO_READER_DATA_DIR: dataDir,
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      UMAMI_SRC: '',
      UMAMI_WEBSITE_ID: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { child, baseUrl, logs };
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

test('homepage renders Namoo brand and does not load analytics by default', async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir);
    const html = await fetch(server.baseUrl).then(response => response.text());
    assert.match(html, /<title>Namoo Reader · RSS 阅读器<\/title>/);
    assert.match(html, /<img class="brand-logo" src="\/favicon\.svg"/);
    assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
    assert.doesNotMatch(html, />Q<|Q 登录/);
    assert.doesNotMatch(html, /data-website-id=/);
    assert.doesNotMatch(html, /umami\.qiaomu\.ai/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('homepage injects configured HTTPS Umami script for the Namoo domain', async () => {
  const dataDir = createTempDataDir();
  let server = null;
  try {
    server = await startServer(dataDir, {
      SITE_URL: 'https://reader.example.com',
      UMAMI_SRC: 'https://stats.example.com/script.js',
      UMAMI_WEBSITE_ID: '12345678-1234-1234-1234-123456789abc',
    });
    const html = await fetch(server.baseUrl).then(response => response.text());
    assert.match(html, /src="https:\/\/stats\.example\.com\/script\.js"/);
    assert.match(html, /data-website-id="12345678-1234-1234-1234-123456789abc"/);
    assert.match(html, /data-domains="reader\.example\.com"/);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('brand icons contain the expected formats and dimensions', () => {
  const svg = fs.readFileSync(path.join(projectDir, 'public', 'favicon.svg'), 'utf8');
  assert.match(svg, /<mask[^>]+maskUnits="userSpaceOnUse"[^>]+maskContentUnits="userSpaceOnUse"/);

  for (const [filename, expectedSize] of [['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
    const png = fs.readFileSync(path.join(projectDir, 'public', filename));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), expectedSize);
    assert.equal(png.readUInt32BE(20), expectedSize);
  }
});

test('expanded desktop sidebar has enough room for the full brand title and controls', () => {
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(styles, /#app\s*{[^}]*--sidebar-width:\s*264px/s);
  assert.match(styles, /@media \(max-width: 1380px\) and \(min-width: 1101px\)[\s\S]*?#app\s*{[^}]*--sidebar-width:\s*264px/);
  assert.match(styles, /#app\.reading:not\(\.sidebar-collapsed\):not\(\.left-collapsed\):not\(\.reader-immersive\)\s*{[^}]*--sidebar-width:\s*264px/s);
  assert.match(styles, /#app\.sidebar-collapsed\s*{[^}]*--sidebar-width:\s*64px/s);
});

test('sidebar uses subscription types as its primary navigation hierarchy', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const brand = html.slice(html.indexOf('<div class="brand">'), html.indexOf('<div class="views">'));
  const views = html.slice(html.indexOf('<nav class="views"'), html.indexOf('<div id="asset-dashboard"'));
  const account = html.slice(html.indexOf('<div class="account-strip">'), html.indexOf('</aside>'));

  assert.match(brand, /id="brand-home"[\s\S]*id="submit-link-open"[\s\S]*id="sidebar-toggle"/);
  assert.doesNotMatch(html, /class="sidebar-actions"/);
  assert.match(views, /class="sidebar-type-nav"[\s\S]*data-sidebar-category="all"[\s\S]*data-sidebar-category="article"[\s\S]*data-sidebar-category="news"[\s\S]*data-sidebar-category="podcast"/);
  assert.doesNotMatch(views, /data-view="(?:all|unread|hot)"/);
  assert.match(views, /class="sidebar-secondary-nav"[\s\S]*data-view="starred"[\s\S]*data-view="history"[\s\S]*data-view="contributors"/);
  assert.match(account, /id="account-info"[\s\S]*id="theme-toggle"[\s\S]*id="theme-menu"/);
  assert.match(styles, /\.sidebar-type-nav\s*\{/);
  assert.match(styles, /\.sidebar-secondary-nav\s*\{/);

  const sidebarWidths = [...styles.matchAll(/--sidebar-width:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.ok(sidebarWidths.length > 0);
  assert.ok(sidebarWidths.every(width => width === 64 || width === 264));
  assert.doesNotMatch(fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8'), /sidebarCollapsed \? 64 : 232/);
});

test('article list separates ordering, unread filtering, and contextual actions', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="list-title"[\s\S]*class="list-sort-toggle"[\s\S]*data-list-sort="latest"[\s\S]*data-list-sort="hot"/);
  assert.match(html, /id="source-refresh-btn"[\s\S]*id="unread-only-btn"[^>]*aria-pressed="false"[\s\S]*id="mark-read-btn"/);
  assert.doesNotMatch(html, /data-list-scope="unread"/);
  assert.match(app, /listSort:\s*'latest'/);
  assert.match(app, /unreadOnly:\s*false/);
  assert.match(app, /function selectListSort\(/);
  assert.match(app, /function toggleUnreadOnly\(/);
  assert.match(app, /function refreshCurrentScope\(/);
  assert.match(app, /sidebarCategory:\s*'all'/);
  assert.doesNotMatch(app, /qm_sidebar_type/);

  const selectSort = app.slice(app.indexOf('function selectListSort('), app.indexOf('function toggleUnreadOnly('));
  assert.doesNotMatch(selectSort, /filterSource\s*=|filterCategory\s*=/);
  const toggleUnread = app.slice(app.indexOf('function toggleUnreadOnly('), app.indexOf('function assetActivityItemHtml('));
  assert.doesNotMatch(toggleUnread, /filterSource\s*=|filterCategory\s*=/);
  const markRead = app.slice(app.indexOf("$('#mark-read-btn').onclick"), app.indexOf("$('#reader-star').onclick"));
  assert.match(markRead, /currentEntryScopeLabel\(\)/);
  assert.match(markRead, /visibleEntries\(\)\.map\(e => e\.id\)/);
});

test('sidebar theme picker supports system, light, and dark modes', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="theme-toggle"[^>]*aria-controls="theme-menu"/);
  assert.match(html, /id="theme-menu"[^>]*role="menu"/);
  assert.match(html, /data-theme-mode="light"[\s\S]*data-theme-mode="dark"[\s\S]*data-theme-mode="system"/);
  assert.match(app, /function applyThemeMode\(/);
  assert.match(app, /prefers-color-scheme:\s*dark/);
  assert.match(app, /fr_theme_mode/);
  assert.match(app, /aria-checked/);
});

test('sidebar exposes static type filters, source totals, and drag ordering without arrow controls', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(html, /id="count-type-all"[\s\S]*id="count-type-article"[\s\S]*id="count-type-news"[\s\S]*id="count-type-podcast"/);
  assert.doesNotMatch(app, /sidebar-category-tabs/);
  assert.match(app, /row\.draggable = true/);
  assert.match(app, /dragstart/);
  assert.match(app, /dragover/);
  assert.match(app, /drop/);
  assert.match(app, /entryCountForSource/);
  assert.doesNotMatch(app, /data-source-move=/);
  assert.match(styles, /\.feed-item \.fcount[^}]*flex:\s*none/s);
  assert.match(styles, /\.feed-row\.drag-before/);
  assert.match(styles, /\.feed-row\.drag-after/);
});

test('My Space is the sole account workspace and subscription management is not a modal', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(html, /<h1>我的空间<\/h1>/);
  assert.match(html, /data-dashboard-tab="security"/);
  assert.match(html, /data-dashboard-tab="sources"/);
  assert.doesNotMatch(html, /data-dashboard-tab="operations"|dashboard-operations-panel|workspace-refresh-btn/);
  assert.match(html, /id="custom-source-form"/);
  assert.doesNotMatch(html, /account-settings-open|account-menu|sidebar-footer|manage-modal|admin-page|change-password-modal/);
  assert.doesNotMatch(app, /account-settings-open|account-menu|sidebar-footer|manage-modal|dashboard-ai-panel/);
  assert.match(app, /data-managed-order/);
  assert.doesNotMatch(app, /DASHBOARD_TABS = \[[^\]]*'operations'/);
  assert.doesNotMatch(app, /lucideIcon\('chevron-/);
  assert.doesNotMatch(styles, /\.account-settings|\.account-menu|\.admin-page/);
  assert.match(styles, /\.dashboard-tabs\s*\{\s*display:\s*flex;/);
  assert.match(styles, /#app\.workspace-page-open #sidebar\s*\{\s*display:\s*none;/);
});

test('My Space separates user management from pending-content moderation', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const adminTabs = html.slice(
    html.indexOf('id="dashboard-admin-tab-group"'),
    html.indexOf('</div>', html.indexOf('id="dashboard-admin-tab-group"')),
  );
  const moderationPanel = html.slice(
    html.indexOf('id="dashboard-moderation-panel"'),
    html.indexOf('id="contributor-page"'),
  );

  assert.match(adminTabs, /data-dashboard-tab="users"[\s\S]*data-dashboard-tab="moderation"[\s\S]*data-dashboard-tab="sources"/);
  assert.match(html, /id="dashboard-users-panel"/);
  assert.match(html, /id="user-management-list"/);
  assert.match(html, /id="user-management-detail"/);
  assert.doesNotMatch(moderationPanel, /投稿账号|moderation-user-list|moderation-user-detail/);
  assert.match(app, /DASHBOARD_TABS = \[[^\]]*'users'/);
  assert.match(app, /function adminUrlFor\(\)[\s\S]{0,120}dashboardUrlFor\('users'/);
  assert.doesNotMatch(app, /api\/admin\/users\?limit=500/);
});

test('user management keeps server pagination and responsive selection in URL-backed state', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

  assert.match(app, /userManagement:\s*\{/);
  assert.match(app, /function applyUserManagementRoute\(/);
  assert.match(app, /function syncUserManagementUrl\(/);
  assert.match(app, /async function loadUserManagement\(/);
  assert.match(app, /async function loadUserManagementDetail\(/);
  assert.match(app, /directory\.requestSequence/);
  assert.match(app, /setTimeout\([\s\S]{0,300}250\)/);
  assert.match(app, /matchMedia\('\(max-width: 760px\)'\)/);
  assert.match(app, /replaceState[\s\S]{0,600}userManagement/);
  assert.match(app, /async function loadAllUserSubmissions\(/);
  assert.match(app, /\/submissions\?page=\$\{page\}&limit=50/);
  assert.match(styles, /\.user-management-layout\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*\.user-management-layout\.is-mobile-detail/s);
});

test('restricted dashboard routes normalize both the selected panel and browser URL', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const openDashboard = app.slice(
    app.indexOf('async function openMyCommentsModal'),
    app.indexOf('function closeMyCommentsModal'),
  );
  const openAdmin = app.slice(
    app.indexOf('async function openAdminPage'),
    app.indexOf('function closeAdminPage'),
  );

  assert.match(openDashboard, /requestedTab !== state\.dashboardTab[\s\S]*history\.replaceState/);
  assert.match(openAdmin, /openMyCommentsModal\(\{ push: false, tab: 'profile' \}\)[\s\S]*history\.replaceState/);
});

test('user management actions require confirmed snapshots and recover from conflicts without optimistic mutation', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="user-management-dialog"/);
  assert.match(html, /id="user-management-dialog-reason"[^>]*maxlength="300"/);
  assert.match(html, /id="user-management-dialog-check"/);
  assert.match(app, /function openUserManagementAction\(/);
  assert.match(app, /async function submitUserManagementAction\(/);
  assert.match(app, /expectedImpact:\s*action\.impact/);
  assert.match(app, /expectedVisibleSubmissionCount:\s*action\.impact\.hiddenSubmissionCount/);
  assert.match(app, /error\.status === 409/);
  assert.match(app, /action\.impact = error\.data\.currentImpact/);
  assert.match(app, /check\.checked = false/);
  assert.match(app, /await loadUserManagement\(\{ force: true \}\)/);
  assert.match(app, /item\.actorDisplayName \|\| item\.actorEmail \|\| item\.actorUserId/);
  assert.match(app, /user\.disabledByDisplayName \|\| user\.disabledByEmail \|\| user\.disabledBy/);
  assert.match(app, /if \(\$\('#user-management-dialog'\)\?\.open\) \{[\s\S]{0,160}e\.preventDefault\(\);[\s\S]{0,160}closeUserManagementAction\(\);[\s\S]{0,80}return;[\s\S]{0,40}\}/);
  assert.doesNotMatch(app, /detail\.user\.disabled\s*=/);
});

test('versioned translations expose a safe progress surface and render only server HTML', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const versionedRenderer = app.slice(
    app.indexOf('function renderVersionedTranslation'),
    app.indexOf('function scheduleTranslationJobPoll'),
  );

  assert.match(html, /id="translation-job-status"[^>]*role="status"/);
  assert.match(app, /function isVersionedTranslationEnvelope\(/);
  assert.match(app, /function sanitizeVersionedTranslationHtml\([\s\S]*?if \(!window\.DOMPurify\) return '';/);
  assert.match(app, /renderVersionedTranslation\([\s\S]*?data\.renderedHtml/);
  assert.match(app, /renderVersionedTranslation\([\s\S]*?sanitizeVersionedTranslationHtml\(data\.renderedHtml\)/);
  assert.match(app, /function renderTranslationEnvelopeState\(data, \{ rendered = true \} = \{\}\)[\s\S]{0,300}if \(rendered\) setTranslationJobStatus\(''\)/);
  assert.match(app, /const rendered = renderVersionedTranslation\(data\);\s*const job = renderTranslationEnvelopeState\(data, \{ rendered \}\);/);
  assert.doesNotMatch(app, /renderVersionedTranslation\([\s\S]{0,1600}enrichedTranslationBlocks\(/);
  assert.match(versionedRenderer, /renderAssetHelpfulButton\('translation', state\.translation\)/);
  assert.match(versionedRenderer, /copy\.classList\.toggle\('hidden', !hasContent\);\s*copy\.disabled = !hasContent/);
  assert.match(versionedRenderer, /mode\.classList\.add\('hidden'\);\s*mode\.disabled = true/);
  assert.match(app, /function renderTranslation\(translation[^)]*\) \{\s*if \(translation\?\.schemaVersion === 2 && translation\.renderedHtml\) return renderVersionedTranslation/);
  assert.match(styles, /\.translation-job-status\s*\{/);
});

test('superseded translation jobs are terminal and trigger a fresh translation read', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');

  assert.match(app, /function isTerminalTranslationJob\(job\)[\s\S]{0,160}\['failed', 'succeeded', 'superseded'\]/);
  assert.match(app, /if \(job\.status === 'superseded'\)[\s\S]{0,320}loadTranslation\(state\.activeEntry/);
});
