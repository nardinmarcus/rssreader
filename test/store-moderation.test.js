const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');
const { resolveDataPaths } = require('../lib/data-paths');

const dataDir = createTempDataDir('namoo-reader-moderation-');
const storePath = path.join(__dirname, '..', 'lib', 'store.js');
const initEnv = { ...process.env, NAMOO_READER_DATA_DIR: dataDir };

execFileSync(process.execPath, ['-e', 'require(process.argv[1])', storePath], { env: initEnv });
execFileSync(process.execPath, ['-e', 'require(process.argv[1])', storePath], { env: initEnv });

process.env.NAMOO_READER_DATA_DIR = dataDir;
const store = require('../lib/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createReader(prefix, role = 'user') {
  return store.createUser({
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'password-123',
    displayName: prefix,
    role,
  });
}

function submittedEntry(id, title = id) {
  return {
    id,
    sourceId: 'user-submitted',
    title,
    link: `https://example.com/${id}`,
    author: 'reader',
    published: new Date().toISOString(),
    publishedTs: Date.now(),
    summary: `${title} summary`,
    content: `<p>${title} content</p>`,
  };
}

function saveSubmission(id, user) {
  return store.saveSubmittedEntry(submittedEntry(id), {
    userId: user.id,
    author: user.displayName,
  });
}

function databaseFacts() {
  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  try {
    return {
      users: Number(database.prepare('SELECT COUNT(*) AS count FROM users').get().count),
      admins: Number(database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count),
      entries: Number(database.prepare('SELECT COUNT(*) AS count FROM entries').get().count),
      adminPasswordHash: database.prepare("SELECT password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.password_hash || '',
    };
  } finally {
    database.close();
  }
}

test('admin action schema migrates idempotently without changing existing facts', () => {
  createReader('migration-admin', 'admin');
  const reader = createReader('migration-reader');
  saveSubmission('migration-reader-entry', reader);
  const before = databaseFacts();

  execFileSync(process.execPath, ['-e', 'require(process.argv[1])', storePath], { env: initEnv });
  execFileSync(process.execPath, ['-e', 'require(process.argv[1])', storePath], { env: initEnv });

  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_action_logs'").get();
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'admin_action_logs' ORDER BY name").all();
    assert.equal(table?.name, 'admin_action_logs');
    assert.deepEqual(indexes.map(row => row.name), [
      'idx_admin_action_logs_actor_created',
      'idx_admin_action_logs_target_created',
      'sqlite_autoindex_admin_action_logs_1',
    ]);
  } finally {
    database.close();
  }
  assert.deepEqual(databaseFacts(), before);
});

test('admin action schema rejects invalid records and exposes normalized history', () => {
  const admin = createReader('audit-admin', 'admin');
  const reader = createReader('audit-reader');
  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  const insert = database.prepare(`
    INSERT INTO admin_action_logs (
      id, actor_user_id, target_user_id, action, reason, impact_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    assert.throws(() => insert.run(
      crypto.randomUUID(), admin.id, reader.id, 'user.unknown', 'invalid action',
      JSON.stringify({ revokedSessionCount: 0, rejectedPendingCount: 0, hiddenSubmissionCount: 0 }),
      Date.now(),
    ));
    assert.throws(() => insert.run(
      crypto.randomUUID(), admin.id, reader.id, 'user.disable', 'invalid impact',
      JSON.stringify({ hiddenSubmissionCount: 1 }),
      Date.now(),
    ));
    insert.run(
      'audit-history-entry', admin.id, reader.id, 'user.submissions_hide', 'spam cleanup',
      JSON.stringify({ revokedSessionCount: 0, rejectedPendingCount: 0, hiddenSubmissionCount: 2 }),
      123456789,
    );
  } finally {
    database.close();
  }

  assert.deepEqual(store.getAdminActionLogs(reader.id, { limit: 20 }), [{
    id: 'audit-history-entry',
    actorUserId: admin.id,
    actorDisplayName: admin.displayName,
    actorEmail: admin.email,
    targetUserId: reader.id,
    action: 'user.submissions_hide',
    reason: 'spam cleanup',
    impact: {
      revokedSessionCount: 0,
      rejectedPendingCount: 0,
      hiddenSubmissionCount: 2,
    },
    createdAt: 123456789,
  }]);
});

test('admin user directory searches, filters, sorts, and paginates in SQLite', () => {
  const prefix = `directory-${Date.now()}`;
  const alpha = createReader(`${prefix}-alpha`);
  const beta = createReader(`${prefix}-beta`);
  const gamma = createReader(`${prefix}-gamma`);
  const delta = createReader(`${prefix}-delta`, 'admin');
  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  try {
    const update = database.prepare(`
      UPDATE users
      SET created_at = ?, updated_at = ?, last_login_at = ?, disabled_at = ?, disabled_by = ?, disabled_reason = ?
      WHERE id = ?
    `);
    update.run(100, 100, 1000, null, null, null, alpha.id);
    update.run(200, 200, null, 250, delta.id, 'policy violation', beta.id);
    update.run(300, 300, 2000, null, null, null, gamma.id);
    update.run(400, 400, 1500, null, null, null, delta.id);
  } finally {
    database.close();
  }

  const lastPage = store.getAdminUsersPage({ q: prefix, sort: 'created_desc', page: 99, limit: 2 });
  assert.deepEqual(lastPage.users.map(user => user.userId), [beta.id, alpha.id]);
  assert.deepEqual(lastPage.pagination, { page: 2, limit: 2, filteredTotal: 4, pageCount: 2 });

  const recentLogins = store.getAdminUsersPage({ q: prefix, sort: 'last_login_desc', page: 1, limit: 10 });
  assert.deepEqual(recentLogins.users.map(user => user.userId), [gamma.id, delta.id, alpha.id, beta.id]);
  assert.equal(recentLogins.users.at(-1).lastLoginAt, null);

  assert.deepEqual(
    store.getAdminUsersPage({ q: beta.email, status: 'disabled' }).users.map(user => user.userId),
    [beta.id],
  );
  assert.equal(store.getAdminUserDetail(beta.id).user.disabledByDisplayName, delta.displayName);
  assert.deepEqual(
    store.getAdminUsersPage({ q: prefix, role: 'admin' }).users.map(user => user.userId),
    [delta.id],
  );
  assert.equal(Object.hasOwn(lastPage.users[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(lastPage.users[0], 'passwordSalt'), false);

  const summaryDatabase = new DatabaseSync(databaseFile);
  try {
    const expected = summaryDatabase.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN COALESCE(disabled_at, 0) = 0 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN COALESCE(disabled_at, 0) <> 0 THEN 1 ELSE 0 END) AS disabled,
             SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
      FROM users
    `).get();
    assert.deepEqual(lastPage.summary, {
      total: Number(expected.total),
      active: Number(expected.active),
      disabled: Number(expected.disabled),
      admins: Number(expected.admins),
    });
  } finally {
    summaryDatabase.close();
  }
});

test('admin user detail aggregates current impact and recent history from SQLite', () => {
  const admin = createReader('detail-admin', 'admin');
  const reader = createReader('detail-reader');
  store.createSession(reader.id);
  store.createSession(reader.id, -1000);
  const pendingOne = store.createSubmissionRequest({ url: 'https://example.com/detail-pending-one', userId: reader.id });
  const pendingTwo = store.createSubmissionRequest({ url: 'https://example.com/detail-pending-two', userId: reader.id });
  saveSubmission('detail-public-entry', reader);
  saveSubmission('detail-hidden-entry', reader);
  store.softDeleteEntry('detail-hidden-entry', { userId: admin.id, reason: 'hide one' });

  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  try {
    database.prepare(`
      INSERT INTO admin_action_logs (
        id, actor_user_id, target_user_id, action, reason, impact_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'detail-audit-entry', admin.id, reader.id, 'user.submissions_hide', 'hide one',
      JSON.stringify({ revokedSessionCount: 0, rejectedPendingCount: 0, hiddenSubmissionCount: 1 }),
      987654321,
    );
  } finally {
    database.close();
  }

  let detail;
  try {
    detail = store.getAdminUserDetail(reader.id);
  } finally {
    store.reviewSubmissionRequest(pendingOne.id, { status: 'rejected', reviewedBy: admin.id, reason: 'test cleanup' });
    store.reviewSubmissionRequest(pendingTwo.id, { status: 'rejected', reviewedBy: admin.id, reason: 'test cleanup' });
  }
  assert.equal(detail.user.userId, reader.id);
  assert.equal(detail.user.activeSubmissionCount, 1);
  assert.equal(detail.user.deletedSubmissionCount, 1);
  assert.equal(detail.user.totalSubmissionCount, 2);
  assert.deepEqual(detail.impact, {
    revokedSessionCount: 1,
    rejectedPendingCount: 2,
    hiddenSubmissionCount: 1,
  });
  assert.deepEqual(
    detail.recentSubmissions.map(item => item.entryId).sort(),
    ['detail-hidden-entry', 'detail-public-entry'],
  );
  assert.deepEqual(detail.recentActions.map(item => item.id), ['detail-audit-entry']);
  assert.equal(detail.recentActions[0].actorDisplayName, admin.displayName);
  assert.equal(detail.recentActions[0].actorEmail, admin.email);
  assert.equal(Object.hasOwn(detail.user, 'passwordHash'), false);
  assert.throws(() => store.getAdminUserDetail('missing-user'), error => error.statusCode === 404);
});

test('submission requests remain quarantined and enforce durable pending limits', () => {
  const reader = createReader('queue-reader');
  const admin = createReader('queue-admin', 'admin');
  const first = store.createSubmissionRequest({
    url: 'https://example.com/queued-one',
    userId: reader.id,
    author: reader.displayName,
    note: 'review me',
  });

  assert.equal(first.status, 'pending');
  assert.equal(store.getSubmittedEntries().some(entry => entry.link === first.url), false);
  assert.deepEqual(store.getSubmissionRequests({ status: 'pending' }).map(item => item.id), [first.id]);

  const duplicate = store.createSubmissionRequest({
    url: first.url,
    userId: reader.id,
    author: reader.displayName,
    note: 'duplicate',
  });
  assert.equal(duplicate.id, first.id);

  const second = store.createSubmissionRequest({ url: 'https://example.com/queued-two', userId: reader.id });
  const third = store.createSubmissionRequest({ url: 'https://example.com/queued-three', userId: reader.id });
  assert.throws(
    () => store.createSubmissionRequest({ url: 'https://example.com/queued-four', userId: reader.id }),
    error => error.statusCode === 429 && /待审核/.test(error.message),
  );

  store.upsertEntries([submittedEntry('approved-entry')]);
  const approved = store.reviewSubmissionRequest(second.id, {
    status: 'approved',
    reviewedBy: admin.id,
    reason: 'safe',
    entryId: 'approved-entry',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.entryId, 'approved-entry');
  assert.equal(approved.reviewedBy, admin.id);

  const rejected = store.reviewSubmissionRequest(third.id, {
    status: 'rejected',
    reviewedBy: admin.id,
    reason: 'not an article',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewReason, 'not an article');
  assert.equal(store.reviewSubmissionRequest(third.id, {
    status: 'approved',
    reviewedBy: admin.id,
  }).status, 'rejected');
  assert.throws(
    () => store.reviewSubmissionRequest(first.id, { status: 'pending', reviewedBy: admin.id }),
    error => error.statusCode === 400,
  );
});

test('admin submission views and soft deletion stay scoped to the exact user', () => {
  const admin = createReader('submission-moderator', 'admin');
  const reader = createReader('same-name');
  const sameName = createReader('same-name');
  const other = createReader('other-reader');
  const readerSession = store.createSession(reader.id);
  saveSubmission('reader-entry-one', reader);
  saveSubmission('reader-entry-two', reader);
  saveSubmission('same-name-entry', sameName);
  saveSubmission('other-entry', other);

  const summary = store.getAdminSubmissionUsers({ q: 'same-name', limit: 20 });
  assert.deepEqual(summary.map(item => item.userId).sort(), [reader.id, sameName.id].sort());
  assert.equal(summary.find(item => item.userId === reader.id).activeSubmissionCount, 2);

  const preview = store.getAdminUserSubmissions(reader.id, { limit: 20 });
  assert.equal(preview.activeSubmissionCount, 2);
  assert.deepEqual(preview.submissions.map(item => item.entryId).sort(), ['reader-entry-one', 'reader-entry-two']);

  const paged = store.getAdminUserSubmissions(reader.id, { page: 99, limit: 1 });
  assert.deepEqual(paged.pagination, { page: 2, limit: 1, filteredTotal: 2, pageCount: 2 });
  assert.equal(paged.submissions.length, 1);
  assert.ok(['reader-entry-one', 'reader-entry-two'].includes(paged.submissions[0].entryId));

  let conflict;
  assert.throws(
    () => store.softDeleteUserSubmissions(reader.id, {
      deletedBy: admin.id,
      reason: 'stale batch moderation',
      expectedVisibleSubmissionCount: 1,
    }),
    error => {
      conflict = error;
      return error.statusCode === 409;
    },
  );
  assert.equal(conflict.currentVisibleSubmissionCount, 2);
  assert.equal(store.getAdminUserSubmissions(reader.id).activeSubmissionCount, 2);
  assert.deepEqual(store.getAdminActionLogs(reader.id), []);

  const deleted = store.softDeleteUserSubmissions(reader.id, {
    deletedBy: admin.id,
    reason: 'batch moderation',
    expectedVisibleSubmissionCount: 2,
  });
  assert.equal(deleted.deletedCount, 2);
  assert.equal(store.getEntry('reader-entry-one'), null);
  assert.equal(store.getEntry('reader-entry-two'), null);
  assert.ok(store.getEntry('same-name-entry'));
  assert.ok(store.getEntry('other-entry'));
  assert.equal(store.getUserBySessionToken(readerSession.token).id, reader.id);
  assert.equal(store.authenticateUser(reader.email, 'password-123').id, reader.id);

  const after = store.getAdminUserSubmissions(reader.id, { limit: 20 });
  assert.equal(after.activeSubmissionCount, 0);
  assert.equal(after.deletedSubmissionCount, 2);
  assert.ok(after.submissions.every(item => item.deletedAt));
  const log = store.getAdminActionLogs(reader.id)[0];
  assert.equal(log.action, 'user.submissions_hide');
  assert.equal(log.reason, 'batch moderation');
  assert.equal(log.impact.hiddenSubmissionCount, 2);
  const repeated = store.softDeleteUserSubmissions(reader.id, {
    deletedBy: admin.id,
    reason: 'no second audit',
    expectedVisibleSubmissionCount: 0,
  });
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(repeated.entryIds, []);
  assert.equal(store.getAdminActionLogs(reader.id).length, 1);
});

test('disable rejects stale impact confirmation without changing user data', () => {
  const admin = createReader('conflict-admin', 'admin');
  const reader = createReader('conflict-reader');
  const session = store.createSession(reader.id);
  const pending = store.createSubmissionRequest({
    url: 'https://example.com/conflict-pending',
    userId: reader.id,
  });
  saveSubmission('conflict-public-entry', reader);

  try {
    let conflict;
    assert.throws(
      () => store.disableUserForModeration(reader.id, {
        adminUserId: admin.id,
        reason: 'confirmed before counts changed',
        expectedImpact: {
          revokedSessionCount: 0,
          rejectedPendingCount: 0,
          hiddenSubmissionCount: 0,
        },
      }),
      error => {
        conflict = error;
        return error.statusCode === 409;
      },
    );
    assert.deepEqual(conflict.currentImpact, {
      revokedSessionCount: 1,
      rejectedPendingCount: 1,
      hiddenSubmissionCount: 1,
    });
    assert.equal(store.getAdminUserDetail(reader.id).user.disabled, false);
    assert.equal(store.getUserBySessionToken(session.token).id, reader.id);
    assert.equal(store.getSubmissionRequest(pending.id).status, 'pending');
    assert.ok(store.getEntry('conflict-public-entry'));
    assert.deepEqual(store.getAdminActionLogs(reader.id), []);
  } finally {
    if (store.getSubmissionRequest(pending.id).status === 'pending') {
      store.reviewSubmissionRequest(pending.id, { status: 'rejected', reviewedBy: admin.id, reason: 'test cleanup' });
    }
  }
});

test('disable rolls back every governance change when audit insertion fails', () => {
  const admin = createReader('rollback-admin', 'admin');
  const reader = createReader('rollback-reader');
  const session = store.createSession(reader.id);
  const pending = store.createSubmissionRequest({
    url: 'https://example.com/rollback-pending',
    userId: reader.id,
  });
  saveSubmission('rollback-public-entry', reader);
  const { databaseFile } = resolveDataPaths({ NAMOO_READER_DATA_DIR: dataDir });
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`
      CREATE TRIGGER fail_admin_action_log
      BEFORE INSERT ON admin_action_logs
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);
  } finally {
    database.close();
  }

  try {
    assert.throws(
      () => store.disableUserForModeration(reader.id, {
        adminUserId: admin.id,
        reason: 'must roll back',
        expectedImpact: {
          revokedSessionCount: 1,
          rejectedPendingCount: 1,
          hiddenSubmissionCount: 1,
        },
      }),
      /forced audit failure/,
    );
    assert.equal(store.getAdminUserDetail(reader.id).user.disabled, false);
    assert.equal(store.getUserBySessionToken(session.token).id, reader.id);
    assert.equal(store.getSubmissionRequest(pending.id).status, 'pending');
    assert.ok(store.getEntry('rollback-public-entry'));
    assert.deepEqual(store.getAdminActionLogs(reader.id), []);
  } finally {
    const cleanupDatabase = new DatabaseSync(databaseFile);
    try {
      cleanupDatabase.exec('DROP TRIGGER IF EXISTS fail_admin_action_log');
    } finally {
      cleanupDatabase.close();
    }
    if (store.getSubmissionRequest(pending.id).status === 'pending') {
      store.reviewSubmissionRequest(pending.id, { status: 'rejected', reviewedBy: admin.id, reason: 'test cleanup' });
    }
  }
});

test('moderation revokes access and sessions while restore only re-enables the account', () => {
  const admin = createReader('moderator', 'admin');
  const offender = createReader('offender');
  saveSubmission('offender-entry-one', offender);
  saveSubmission('offender-entry-two', offender);
  const session = store.createSession(offender.id);
  const pending = store.createSubmissionRequest({
    url: 'https://example.com/offender-pending',
    userId: offender.id,
  });
  assert.equal(store.getUserBySessionToken(session.token).id, offender.id);

  const result = store.disableUserForModeration(offender.id, {
    adminUserId: admin.id,
    reason: 'spam links',
    expectedImpact: {
      revokedSessionCount: 1,
      rejectedPendingCount: 1,
      hiddenSubmissionCount: 2,
    },
  });
  assert.equal(result.user.disabled, true);
  assert.equal(result.deletedSubmissionCount, 2);
  assert.equal(result.rejectedPendingCount, 1);
  assert.equal(result.revokedSessionCount, 1);
  assert.deepEqual(store.getAdminActionLogs(offender.id).map(log => ({
    action: log.action,
    reason: log.reason,
    impact: log.impact,
  })), [{
    action: 'user.disable',
    reason: 'spam links',
    impact: {
      revokedSessionCount: 1,
      rejectedPendingCount: 1,
      hiddenSubmissionCount: 2,
    },
  }]);
  assert.equal(store.getUserBySessionToken(session.token), null);
  assert.equal(store.getSubmissionRequest(pending.id).status, 'rejected');
  assert.equal(store.getEntry('offender-entry-one'), null);
  assert.throws(
    () => store.authenticateUser(offender.email, 'password-123'),
    error => error.statusCode === 403,
  );
  assert.throws(
    () => store.createSession(offender.id),
    error => error.statusCode === 403,
  );
  assert.throws(
    () => store.createSession('missing-user'),
    error => error.statusCode === 404,
  );
  const repeated = store.disableUserForModeration(offender.id, {
    adminUserId: admin.id,
    reason: 'must not replace the original reason',
    expectedImpact: {
      revokedSessionCount: 99,
      rejectedPendingCount: 99,
      hiddenSubmissionCount: 99,
    },
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.user.disabledReason, 'spam links');
  assert.equal(store.getAdminActionLogs(offender.id).length, 1);
  assert.throws(
    () => store.disableUserForModeration(admin.id, { adminUserId: admin.id }),
    error => error.statusCode === 403,
  );

  const restored = store.restoreModeratedUser(offender.id, {
    adminUserId: admin.id,
    reason: 'appeal approved',
  });
  assert.equal(restored.disabled, false);
  assert.equal(restored.idempotent, false);
  const restoreLog = store.getAdminActionLogs(offender.id).find(log => log.action === 'user.restore');
  assert.equal(restoreLog.reason, 'appeal approved');
  assert.deepEqual(restoreLog.impact, {
    revokedSessionCount: 0,
    rejectedPendingCount: 0,
    hiddenSubmissionCount: 0,
  });
  const repeatedRestore = store.restoreModeratedUser(offender.id, {
    adminUserId: admin.id,
    reason: 'must not create another log',
  });
  assert.equal(repeatedRestore.idempotent, true);
  assert.equal(store.getAdminActionLogs(offender.id).filter(log => log.action === 'user.restore').length, 1);
  assert.equal(store.authenticateUser(offender.email, 'password-123').id, offender.id);
  assert.equal(store.getUserBySessionToken(session.token), null);
  assert.equal(store.getEntry('offender-entry-one'), null);
});

test('admin bootstrap keeps the existing password instead of resetting it on restart', () => {
  const email = `bootstrap-${Date.now()}@example.com`;
  const original = store.ensureAdminUser({
    email,
    password: 'original-password',
    displayName: 'Original Admin',
  });
  store.ensureAdminUser({
    email,
    password: 'replacement-password',
    displayName: 'Renamed Admin',
  });

  assert.equal(store.authenticateUser(email, 'original-password').id, original.id);
  assert.throws(
    () => store.authenticateUser(email, 'replacement-password'),
    error => error.statusCode === 401,
  );
});
