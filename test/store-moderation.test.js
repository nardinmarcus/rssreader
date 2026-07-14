const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

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
  const reader = createReader('same-name');
  const sameName = createReader('same-name');
  const other = createReader('other-reader');
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

  const deleted = store.softDeleteUserSubmissions(reader.id, {
    deletedBy: 'admin-id',
    reason: 'batch moderation',
  });
  assert.equal(deleted.deletedCount, 2);
  assert.equal(store.getEntry('reader-entry-one'), null);
  assert.equal(store.getEntry('reader-entry-two'), null);
  assert.ok(store.getEntry('same-name-entry'));
  assert.ok(store.getEntry('other-entry'));

  const after = store.getAdminUserSubmissions(reader.id, { limit: 20 });
  assert.equal(after.activeSubmissionCount, 0);
  assert.equal(after.deletedSubmissionCount, 2);
  assert.ok(after.submissions.every(item => item.deletedAt));
  assert.deepEqual(store.softDeleteUserSubmissions(reader.id).entryIds, []);
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
  });
  assert.equal(result.user.disabled, true);
  assert.equal(result.deletedSubmissionCount, 2);
  assert.equal(result.revokedSessionCount, 1);
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
  assert.throws(
    () => store.disableUserForModeration(admin.id, { adminUserId: admin.id }),
    error => error.statusCode === 403,
  );

  const restored = store.restoreModeratedUser(offender.id, { adminUserId: admin.id });
  assert.equal(restored.disabled, false);
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
