const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const rootDir = path.resolve(__dirname, '..');
const storePath = path.join(rootDir, 'lib', 'store.js');
const scriptPath = path.join(rootDir, 'scripts', 'backfill-article-documents.js');

function runNode(dataDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      NAMOO_READER_DATA_DIR: dataDir,
      NODE_NO_WARNINGS: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function seedEntries(dataDir, entries, deletedIds = []) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const fixture = JSON.parse(process.env.MIGRATION_FIXTURE);
    store.upsertEntries(fixture.entries);
    for (const id of fixture.deletedIds) store.softDeleteEntry(id, { reason: 'migration fixture' });
  `], {
    MIGRATION_FIXTURE: JSON.stringify({ entries, deletedIds }),
  });
  assert.equal(result.status, 0, result.stderr);
}

function runMigration(dataDir, args = [], expectedStatus = 0) {
  const result = runNode(dataDir, [scriptPath, ...args]);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function readCurrentDocuments(dataDir, entryIds) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const ids = JSON.parse(process.env.MIGRATION_ENTRY_IDS);
    console.log(JSON.stringify(ids.map(id => store.getCurrentArticleDocument(id))));
  `], {
    MIGRATION_ENTRY_IDS: JSON.stringify(entryIds),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function setEntryCreatedAt(dataDir, entryId, createdAt) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(createdAt, entryId);
  db.close();
}

function insertLegacyDocumentWithoutPointer(dataDir, entryId) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const { compileLegacyDocument } = require(${JSON.stringify(path.join(rootDir, 'lib', 'article-documents.js'))});
    const entry = store.scanEntriesForVersionedMigration({ limit: 1000 })
      .find(item => item.id === process.env.MIGRATION_ENTRY_ID);
    const document = compileLegacyDocument({ entry });
    store.insertArticleDocument({
      ...document,
      id: 'interrupted-document',
      entryId: entry.id,
      createdAt: entry.createdAt,
    });
  `], {
    MIGRATION_ENTRY_ID: entryId,
  });
  assert.equal(result.status, 0, result.stderr);
}

function insertCurrentFeedDocument(dataDir, entryId) {
  const result = runNode(dataDir, ['-e', `
    const crypto = require('crypto');
    const store = require(${JSON.stringify(storePath)});
    const { compileFeedDocument } = require(${JSON.stringify(path.join(rootDir, 'lib', 'article-documents.js'))});
    const entry = store.scanEntriesForVersionedMigration({ limit: 1000 })
      .find(item => item.id === process.env.MIGRATION_ENTRY_ID);
    const document = compileFeedDocument({ entry });
    const stored = store.insertArticleDocument({
      ...document,
      id: 'feed-document-' + crypto.randomUUID(),
      entryId: entry.id,
      createdAt: entry.createdAt,
    });
    store.setCurrentArticleDocument(entry.id, stored.id);
  `], {
    MIGRATION_ENTRY_ID: entryId,
  });
  assert.equal(result.status, 0, result.stderr);
}

function entry(id, overrides = {}) {
  return {
    id,
    sourceId: 'migration-test',
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    summary: 'Legacy summary',
    content: '<p>Legacy body.</p>',
    ...overrides,
  };
}

test('backfill creates legacy documents once and reuses them on repeated runs', () => {
  const dataDir = createTempDataDir('article-document-migration-');
  try {
    seedEntries(dataDir, [entry('migration-001')]);

    const first = runMigration(dataDir, ['--batch-size=1']);
    const [document] = readCurrentDocuments(dataDir, ['migration-001']);
    const second = runMigration(dataDir, ['--batch-size=1']);

    assert.deepEqual(first, {
      scanned: 1,
      created: 1,
      reused: 0,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 0,
      pointersSet: 1,
      cursor: 'migration-001',
    });
    assert.equal(document.provenance, 'legacy');
    assert.equal(document.rawStatus, 'unavailable');
    assert.equal(document.snapshotId, null);
    assert.match(document.normalizedHtml, /Legacy body/);
    assert.deepEqual(second, {
      scanned: 1,
      created: 0,
      reused: 1,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 0,
      pointersSet: 0,
      cursor: 'migration-001',
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dry-run classifies deleted, empty, and summary-only entries without writing', () => {
  const dataDir = createTempDataDir('article-document-migration-dry-run-');
  try {
    seedEntries(dataDir, [
      entry('classify-001-active'),
      entry('classify-002-deleted'),
      entry('classify-003-empty', { summary: '', content: '' }),
      entry('classify-004-summary', { summary: 'Summary is the only source.', content: '' }),
    ], ['classify-002-deleted']);
    fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
      entries: [entry('cache-only-entry')],
    }));

    const stats = runMigration(dataDir, ['--dry-run', '--batch-size=2']);
    const documents = readCurrentDocuments(dataDir, [
      'classify-001-active',
      'classify-002-deleted',
      'classify-003-empty',
      'classify-004-summary',
    ]);

    assert.deepEqual(stats, {
      scanned: 4,
      created: 0,
      reused: 0,
      skippedDeleted: 1,
      skippedEmpty: 1,
      summaryOnly: 1,
      errors: 0,
      pointersSet: 0,
      cursor: 'classify-004-summary',
    });
    assert.deepEqual(documents, [null, null, null, null]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backfill skips deleted and empty entries while preserving summary-only and relative resources', () => {
  const dataDir = createTempDataDir('article-document-migration-classification-');
  try {
    seedEntries(dataDir, [
      entry('actual-001-active', { content: '<p><a href="/guide">Guide</a></p>' }),
      entry('actual-002-deleted'),
      entry('actual-003-empty', { summary: '', content: '' }),
      entry('actual-004-summary', { summary: 'Summary is the only source.', content: '' }),
    ], ['actual-002-deleted']);

    const stats = runMigration(dataDir, ['--batch-size=2']);
    const documents = readCurrentDocuments(dataDir, [
      'actual-001-active',
      'actual-002-deleted',
      'actual-003-empty',
      'actual-004-summary',
    ]);

    assert.deepEqual(stats, {
      scanned: 4,
      created: 2,
      reused: 0,
      skippedDeleted: 1,
      skippedEmpty: 1,
      summaryOnly: 1,
      errors: 0,
      pointersSet: 2,
      cursor: 'actual-004-summary',
    });
    assert.equal(documents[0].resources[0].url, 'https://example.com/guide');
    assert.equal(documents[1], null);
    assert.equal(documents[2], null);
    assert.equal(documents[3].summary, 'Summary is the only source.');
    assert.equal(documents[3].plainText, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('after-id resumes strictly after the cursor across small batches', () => {
  const dataDir = createTempDataDir('article-document-migration-resume-');
  try {
    seedEntries(dataDir, [
      entry('resume-001'),
      entry('resume-002'),
      entry('resume-003'),
    ]);

    const stats = runMigration(dataDir, ['--after-id', 'resume-001', '--batch-size', '1']);
    const documents = readCurrentDocuments(dataDir, ['resume-001', 'resume-002', 'resume-003']);

    assert.deepEqual(stats, {
      scanned: 2,
      created: 2,
      reused: 0,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 0,
      pointersSet: 2,
      cursor: 'resume-003',
    });
    assert.equal(documents[0], null);
    assert.ok(documents[1]);
    assert.ok(documents[2]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only reports missing current documents and never writes', () => {
  const dataDir = createTempDataDir('article-document-migration-verify-');
  try {
    seedEntries(dataDir, [entry('verify-001')]);
    runMigration(dataDir);
    seedEntries(dataDir, [entry('verify-002')]);

    const stats = runMigration(dataDir, ['--verify-only'], 1);
    const documents = readCurrentDocuments(dataDir, ['verify-001', 'verify-002']);

    assert.deepEqual(stats, {
      scanned: 2,
      created: 0,
      reused: 1,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 1,
      pointersSet: 0,
      cursor: 'verify-002',
    });
    assert.ok(documents[0]);
    assert.equal(documents[1], null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only rejects a stale legacy document and backfill replaces it', () => {
  const dataDir = createTempDataDir('article-document-migration-stale-');
  try {
    seedEntries(dataDir, [entry('stale-001', {
      title: 'Old title',
      content: '<p>Old body.</p>',
    })]);
    runMigration(dataDir);

    seedEntries(dataDir, [entry('stale-001', {
      title: 'New title',
      content: '<p>New body.</p>',
    })]);

    const stale = runMigration(dataDir, ['--verify-only'], 1);
    assert.equal(stale.errors, 1);
    assert.equal(stale.reused, 0);

    const repaired = runMigration(dataDir);
    const [document] = readCurrentDocuments(dataDir, ['stale-001']);
    const verified = runMigration(dataDir, ['--verify-only']);

    assert.equal(repaired.created, 1);
    assert.equal(repaired.reused, 0);
    assert.equal(repaired.pointersSet, 1);
    assert.equal(document.title, 'New title');
    assert.equal(document.plainText, 'New body.');
    assert.equal(verified.errors, 0);
    assert.equal(verified.reused, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only rejects a stale non-legacy current document and backfill replaces it', () => {
  const dataDir = createTempDataDir('article-document-migration-stale-feed-');
  try {
    seedEntries(dataDir, [entry('stale-feed-001', {
      title: 'Old title',
      content: '<p>Old body.</p>',
    })]);
    insertCurrentFeedDocument(dataDir, 'stale-feed-001');

    seedEntries(dataDir, [entry('stale-feed-001', {
      title: 'New title',
      content: '<p>New body with updated facts.</p>',
    })]);

    const stale = runMigration(dataDir, ['--verify-only'], 1);
    assert.equal(stale.errors, 1);
    assert.equal(stale.reused, 0);

    const repaired = runMigration(dataDir);
    const [document] = readCurrentDocuments(dataDir, ['stale-feed-001']);
    const verified = runMigration(dataDir, ['--verify-only']);

    assert.equal(repaired.created, 1);
    assert.equal(repaired.reused, 0);
    assert.equal(repaired.pointersSet, 1);
    assert.equal(document.provenance, 'legacy');
    assert.equal(document.title, 'New title');
    assert.equal(document.plainText, 'New body with updated facts.');
    assert.equal(verified.errors, 0);
    assert.equal(verified.reused, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a failed entry stops at the last safe cursor and can resume after repair', () => {
  const dataDir = createTempDataDir('article-document-migration-failure-');
  try {
    seedEntries(dataDir, [
      entry('failure-001'),
      entry('failure-002'),
      entry('failure-003'),
    ]);
    setEntryCreatedAt(dataDir, 'failure-002', -1);

    const failed = runMigration(dataDir, ['--batch-size=3'], 1);
    const afterFailure = readCurrentDocuments(dataDir, ['failure-001', 'failure-002', 'failure-003']);

    assert.deepEqual(failed, {
      scanned: 2,
      created: 1,
      reused: 0,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 1,
      pointersSet: 1,
      cursor: 'failure-001',
    });
    assert.ok(afterFailure[0]);
    assert.equal(afterFailure[1], null);
    assert.equal(afterFailure[2], null);

    setEntryCreatedAt(dataDir, 'failure-002', 1);
    const resumed = runMigration(dataDir, ['--after-id=failure-001', '--batch-size=1']);
    const afterResume = readCurrentDocuments(dataDir, ['failure-001', 'failure-002', 'failure-003']);

    assert.deepEqual(resumed, {
      scanned: 2,
      created: 2,
      reused: 0,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 0,
      pointersSet: 2,
      cursor: 'failure-003',
    });
    assert.ok(afterResume.every(Boolean));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backfill reuses a document left behind before its current pointer was set', () => {
  const dataDir = createTempDataDir('article-document-migration-pointer-resume-');
  try {
    seedEntries(dataDir, [entry('pointer-resume-001')]);
    insertLegacyDocumentWithoutPointer(dataDir, 'pointer-resume-001');
    assert.deepEqual(readCurrentDocuments(dataDir, ['pointer-resume-001']), [null]);

    const stats = runMigration(dataDir);
    const [document] = readCurrentDocuments(dataDir, ['pointer-resume-001']);

    assert.deepEqual(stats, {
      scanned: 1,
      created: 0,
      reused: 1,
      skippedDeleted: 0,
      skippedEmpty: 0,
      summaryOnly: 0,
      errors: 0,
      pointersSet: 1,
      cursor: 'pointer-resume-001',
    });
    assert.equal(document.id, 'interrupted-document');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid batch size and missing after-id fail closed before scanning', () => {
  const dataDir = createTempDataDir('article-document-migration-arguments-');
  try {
    for (const args of [
      ['--batch-size=0'],
      ['--batch-size=not-a-number'],
      ['--after-id'],
      ['--dry-run', '--verify-only'],
    ]) {
      const result = runNode(dataDir, [scriptPath, ...args]);
      assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}`);
      assert.match(result.stderr, /batch-size must be a positive integer|after-id requires a value|dry-run and verify-only cannot be combined/i);
      assert.equal(result.stdout, '');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
