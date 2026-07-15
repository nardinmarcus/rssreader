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
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
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
      COOKIE_SECURE: '0',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: '大月 Namoo',
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
      const response = await fetch(`${baseUrl}/api/sources`);
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

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function loginCookie(baseUrl, email, password) {
  const { response, body } = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('user management distinguishes unauthenticated and non-admin access', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-user-access-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const anonymous = await jsonRequest(server.baseUrl, '/api/admin/users');
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ordinary-user@example.com',
        password: 'reader-password-123',
        displayName: 'Ordinary User',
      }),
    });
    const userCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const nonAdmin = await jsonRequest(server.baseUrl, '/api/admin/users', {
      headers: { Cookie: userCookie },
    });

    assert.equal(anonymous.response.status, 401);
    assert.equal(nonAdmin.response.status, 403);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('administrator user directory exposes paginated list and SQLite detail contracts', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-user-directory-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'directory-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Directory Reader',
      }),
    });
    const userId = registration.body.user.id;
    const adminCookie = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const list = await jsonRequest(
      server.baseUrl,
      '/api/admin/users?q=directory-reader%40example.com&status=active&role=user&sort=created_desc&page=1&limit=1',
      { headers: { Cookie: adminCookie } },
    );
    const detail = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}`, {
      headers: { Cookie: adminCookie },
    });
    const submissions = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${userId}/submissions?page=99&limit=1`,
      { headers: { Cookie: adminCookie } },
    );
    const nullSubmissionConfirmation = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${userId}/submissions`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          confirmUserId: userId,
          reason: 'Null is not an explicit count.',
          expectedVisibleSubmissionCount: null,
        }),
      },
    );
    const invalid = await jsonRequest(server.baseUrl, '/api/admin/users?status=unknown', {
      headers: { Cookie: adminCookie },
    });

    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.pagination, { page: 1, limit: 1, filteredTotal: 1, pageCount: 1 });
    assert.equal(list.body.users[0].userId, userId);
    assert.equal(list.body.summary.total, 2);
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.user.userId, userId);
    assert.deepEqual(detail.body.impact, {
      revokedSessionCount: 1,
      rejectedPendingCount: 0,
      hiddenSubmissionCount: 0,
    });
    assert.deepEqual(detail.body.recentSubmissions, []);
    assert.deepEqual(detail.body.recentActions, []);
    assert.equal(submissions.response.status, 200, JSON.stringify(submissions.body));
    assert.deepEqual(submissions.body.pagination, { page: 1, limit: 1, filteredTotal: 0, pageCount: 1 });
    assert.equal(nullSubmissionConfirmation.response.status, 400);
    assert.equal(invalid.response.status, 400);
    assert.doesNotMatch(JSON.stringify({ list: list.body, detail: detail.body }), /password_hash|passwordHash|password_salt|passwordSalt|token/i);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('authenticated submissions stay quarantined without DNS or HTTP access', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-moderation-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reader@example.com',
        password: 'reader-password-123',
        displayName: 'Reader',
      }),
    });
    assert.equal(registration.response.status, 200, JSON.stringify(registration.body));
    const readerCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const submitted = await jsonRequest(server.baseUrl, '/api/submit-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
      body: JSON.stringify({
        url: 'https://pending.invalid/articles/quarantined',
        note: 'Please review this article.',
      }),
    });
    const adminCookie = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const pending = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=pending', {
      headers: { Cookie: adminCookie },
    });

    assert.deepEqual({
      submitStatus: submitted.response.status,
      pending: submitted.body && submitted.body.pending,
      requestStatus: submitted.body && submitted.body.request && submitted.body.request.status,
      queueStatus: pending.response.status,
      queueLength: pending.body && pending.body.requests && pending.body.requests.length,
      queuedUrl: pending.body && pending.body.requests && pending.body.requests[0] && pending.body.requests[0].url,
    }, {
      submitStatus: 202,
      pending: true,
      requestStatus: 'pending',
      queueStatus: 200,
      queueLength: 1,
      queuedUrl: 'https://pending.invalid/articles/quarantined',
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('administrators can reject a pending submission without fetching it', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-moderation-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reject-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Reject Reader',
      }),
    });
    const readerCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const submitted = await jsonRequest(server.baseUrl, '/api/submit-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
      body: JSON.stringify({ url: 'https://pending.invalid/articles/rejected' }),
    });
    const requestId = submitted.body.request.id;
    const adminCookie = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const rejected = await jsonRequest(server.baseUrl, `/api/admin/submission-requests/${requestId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Not suitable for this reader.' }),
    });
    const pending = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=pending', {
      headers: { Cookie: adminCookie },
    });
    const rejectedQueue = await jsonRequest(server.baseUrl, '/api/admin/submission-requests?status=rejected', {
      headers: { Cookie: adminCookie },
    });

    assert.deepEqual({
      status: rejected.response.status,
      reviewStatus: rejected.body && rejected.body.request && rejected.body.request.status,
      reason: rejected.body && rejected.body.request && rejected.body.request.reviewReason,
      pendingCount: pending.body.requests.length,
      rejectedCount: rejectedQueue.body.requests.length,
    }, {
      status: 200,
      reviewStatus: 'rejected',
      reason: 'Not suitable for this reader.',
      pendingCount: 0,
      rejectedCount: 1,
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('administrator approval performs the first fetch and publishes one entry', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-moderation-');
  const capturePath = path.join(dataDir, 'submission-fetches.json');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-submission-preload.js');
  let server = null;
  try {
    server = await startServer(dataDir, {
      NODE_OPTIONS: `--require=${preloadPath}`,
      MOCK_SUBMISSION_CAPTURE_PATH: capturePath,
    });
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'approve-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Approve Reader',
      }),
    });
    const readerCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const submitted = await jsonRequest(server.baseUrl, '/api/submit-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
      body: JSON.stringify({ url: 'https://approved.example/articles/one' }),
    });
    assert.equal(fs.existsSync(capturePath), false);
    const adminCookie = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const approved = await jsonRequest(
      server.baseUrl,
      `/api/admin/submission-requests/${submitted.body.request.id}/approve`,
      { method: 'POST', headers: { Cookie: adminCookie } },
    );
    const publicEntry = approved.body && approved.body.entry
      ? await jsonRequest(server.baseUrl, `/api/entry/${approved.body.entry.id}`)
      : { response: { status: 0 }, body: null };
    const capture = fs.existsSync(capturePath)
      ? JSON.parse(fs.readFileSync(capturePath, 'utf8'))
      : { fetches: [] };

    assert.deepEqual({
      status: approved.response.status,
      reviewStatus: approved.body && approved.body.request && approved.body.request.status,
      entryTitle: approved.body && approved.body.entry && approved.body.entry.title,
      entryLink: approved.body && approved.body.entry && approved.body.entry.link,
      publicStatus: publicEntry.response.status,
      fetches: capture.fetches,
    }, {
      status: 200,
      reviewStatus: 'approved',
      entryTitle: 'Approved Article',
      entryLink: 'https://approved.example/articles/one',
      publicStatus: 200,
      fetches: ['https://approved.example/articles/one'],
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('administrator moderation revokes sessions, removes submissions, and requires a new login after restore', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-moderation-');
  const preloadPath = path.join(__dirname, 'helpers', 'mock-submission-preload.js');
  let server = null;
  try {
    server = await startServer(dataDir, { NODE_OPTIONS: `--require=${preloadPath}` });
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'moderated-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Moderated Reader',
      }),
    });
    const userId = registration.body.user.id;
    const readerCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const compatibilityRegistration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'compatibility-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Compatibility Reader',
      }),
    });
    const compatibilityUserId = compatibilityRegistration.body.user.id;
    const submitted = await jsonRequest(server.baseUrl, '/api/submit-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
      body: JSON.stringify({ url: 'https://approved.example/articles/moderated' }),
    });
    const adminCookie = await loginCookie(server.baseUrl, 'admin@example.com', 'test-password-123');
    const approved = await jsonRequest(
      server.baseUrl,
      `/api/admin/submission-requests/${submitted.body.request.id}/approve`,
      { method: 'POST', headers: { Cookie: adminCookie } },
    );
    const usersBefore = await jsonRequest(server.baseUrl, '/api/admin/users?q=moderated-reader', {
      headers: { Cookie: adminCookie },
    });
    const submissionsBefore = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}/submissions`, {
      headers: { Cookie: adminCookie },
    });
    const detailBefore = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}`, {
      headers: { Cookie: adminCookie },
    });
    const concurrentLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'moderated-reader@example.com', password: 'reader-password-123' }),
    });
    const weakCompatibility = await jsonRequest(server.baseUrl, `/api/admin/users/${compatibilityUserId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ confirmUserId: compatibilityUserId, reason: 'Missing impact must fail.' }),
    });
    const staleDisable = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        confirmUserId: userId,
        reason: 'Repeated policy violations.',
        expectedImpact: detailBefore.body.impact,
      }),
    });
    const disabled = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        confirmUserId: userId,
        reason: 'Repeated policy violations.',
        expectedImpact: staleDisable.body.currentImpact,
      }),
    });
    const oldSessionAfterDisable = await jsonRequest(server.baseUrl, '/api/me', {
      headers: { Cookie: readerCookie },
    });
    const disabledLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'moderated-reader@example.com', password: 'reader-password-123' }),
    });
    const removedEntry = await jsonRequest(server.baseUrl, `/api/entry/${approved.body.entry.id}`);
    const restored = await jsonRequest(server.baseUrl, `/api/admin/users/${userId}/restore`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    const oldSessionAfterRestore = await jsonRequest(server.baseUrl, '/api/me', {
      headers: { Cookie: readerCookie },
    });
    const freshLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'moderated-reader@example.com', password: 'reader-password-123' }),
    });

    assert.deepEqual({
      usersStatus: usersBefore.response.status,
      listedUserId: usersBefore.body && usersBefore.body.users && usersBefore.body.users[0] && usersBefore.body.users[0].userId,
      submissionsStatus: submissionsBefore.response.status,
      activeBefore: submissionsBefore.body && submissionsBefore.body.activeSubmissionCount,
      concurrentLoginStatus: concurrentLogin.response.status,
      weakCompatibilityStatus: weakCompatibility.response.status,
      staleDisableStatus: staleDisable.response.status,
      currentSessionImpact: staleDisable.body && staleDisable.body.currentImpact && staleDisable.body.currentImpact.revokedSessionCount,
      disableStatus: disabled.response.status,
      disabled: disabled.body && disabled.body.result && disabled.body.result.user && disabled.body.result.user.disabled,
      revokedSessions: disabled.body && disabled.body.result && disabled.body.result.revokedSessionCount,
      oldSessionUser: oldSessionAfterDisable.body && oldSessionAfterDisable.body.user,
      disabledLoginStatus: disabledLogin.response.status,
      removedEntryStatus: removedEntry.response.status,
      restoreStatus: restored.response.status,
      restoredDisabled: restored.body && restored.body.user && restored.body.user.disabled,
      restoredOldSessionUser: oldSessionAfterRestore.body && oldSessionAfterRestore.body.user,
      freshLoginStatus: freshLogin.response.status,
    }, {
      usersStatus: 200,
      listedUserId: userId,
      submissionsStatus: 200,
      activeBefore: 1,
      concurrentLoginStatus: 200,
      weakCompatibilityStatus: 400,
      staleDisableStatus: 409,
      currentSessionImpact: 2,
      disableStatus: 200,
      disabled: true,
      revokedSessions: 2,
      oldSessionUser: null,
      disabledLoginStatus: 403,
      removedEntryStatus: 404,
      restoreStatus: 200,
      restoredDisabled: false,
      restoredOldSessionUser: null,
      freshLoginStatus: 200,
    });
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('submission endpoint limits repeated attempts per authenticated user', { timeout: 30000 }, async () => {
  const dataDir = createTempDataDir('namoo-reader-moderation-');
  let server = null;
  try {
    server = await startServer(dataDir);
    const registration = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'limited-reader@example.com',
        password: 'reader-password-123',
        displayName: 'Limited Reader',
      }),
    });
    const readerCookie = String(registration.response.headers.get('set-cookie') || '').split(';')[0];
    const statuses = [];
    let lastResponse = null;
    for (let attempt = 0; attempt < 7; attempt++) {
      lastResponse = await jsonRequest(server.baseUrl, '/api/submit-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
        body: JSON.stringify({ url: 'https://pending.invalid/articles/rate-limited' }),
      });
      statuses.push(lastResponse.response.status);
    }
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 202, 429]);
    assert.match(lastResponse.body.error, /频繁|稍后/);
    assert.ok(Number(lastResponse.response.headers.get('retry-after')) >= 1);
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
