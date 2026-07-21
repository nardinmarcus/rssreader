const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const rootDir = path.resolve(__dirname, '..');
const storePath = path.join(rootDir, 'lib', 'store.js');
const scriptPath = path.join(rootDir, 'scripts', 'verify-versioned-pipeline.js');

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

function runVerifier(dataDir, args = [], extraEnv = {}) {
  const result = runNode(dataDir, [scriptPath, '--data-dir', dataDir, ...args], extraEnv);
  const output = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
  return { ...result, output };
}

function initializeStore(dataDir) {
  const result = runNode(dataDir, ['-e', `require(${JSON.stringify(storePath)})`]);
  assert.equal(result.status, 0, result.stderr);
}

function seedHealthyPipeline(dataDir) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const snapshots = require('./lib/source-snapshots');
    (async () => {
      const entryId = 'observability-entry';
      const body = Buffer.from('<article>PRIVATE_HTML_BODY</article>');
      const rawHash = await snapshots.put(body);
      const { compileFetchedDocument } = require('./lib/article-documents');
      store.upsertEntries([{
        id: entryId,
        sourceId: 'observability',
        title: 'PRIVATE_TITLE',
        link: 'https://example.com/observability',
        summary: 'PRIVATE_PROMPT',
        content: body.toString('utf8'),
      }]);
      store.insertSourceSnapshot({
        id: 'observability-snapshot',
        entryId,
        rawHash,
        requestUrl: 'https://example.com/observability',
        finalUrl: 'https://example.com/observability',
        statusCode: 200,
        contentType: 'text/html',
        charset: 'utf-8',
        responseMeta: {},
        bodyPath: snapshots.relativePath(rawHash),
        sizeBytes: body.length,
        fetchedAt: 10,
      });
      const compiled = compileFetchedDocument({
        entry: {
          id: entryId,
          title: 'PRIVATE_TITLE',
          link: 'https://example.com/observability',
          summary: 'PRIVATE_PROMPT',
          content: body.toString('utf8'),
        },
        html: body.toString('utf8'),
        buffer: body,
        rawHash,
        finalUrl: 'https://example.com/observability',
        snapshotId: 'observability-snapshot',
      });
      const document = store.insertArticleDocument({
        ...compiled,
        id: 'observability-document',
        entryId,
        createdAt: 11,
      });
      store.setCurrentArticleDocument(entryId, document.id);
      store.publishTranslationVersion({
        id: 'observability-translation',
        entryId,
        documentId: document.id,
        ownerType: 'system',
        userId: null,
        author: 'system',
        sourceHash: document.sourceHash,
        pipelineHash: 'observability-pipeline',
        generationHash: 'observability-generation',
        schemaVersion: 2,
        titleZh: 'PRIVATE_TRANSLATION',
        summaryZh: '',
        content: { schemaVersion: 2, translations: [{ id: 's_1', target: 'PRIVATE_OUTPUT' }] },
        provider: 'deepseek',
        model: 'model',
        createdAt: 12,
      }, { promotion: 'auto' });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `]);
  assert.equal(result.status, 0, result.stderr);
}

function seedPointerFaults(dataDir) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    store.upsertEntries([{
      id: 'pointer-other-entry',
      sourceId: 'observability',
      title: 'Other',
      link: 'https://example.com/other',
      summary: '',
      content: 'Other',
    }]);
    store.insertArticleDocument({
      id: 'pointer-other-document',
      entryId: 'pointer-other-entry',
      snapshotId: null,
      sourceComponents: [],
      provenance: 'legacy',
      rawStatus: 'unavailable',
      documentHash: 'pointer-other-document-hash',
      sourceHash: 'pointer-other-source-hash',
      extractorVersion: 'e1',
      sanitizerVersion: 's1',
      segmenterVersion: 'g1',
      title: 'Other',
      summary: '',
      normalizedHtml: '<p>Other</p>',
      plainText: 'Other',
      ast: [],
      resources: [],
      createdAt: 20,
    });
  `]);
  assert.equal(result.status, 0, result.stderr);

  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`
    UPDATE entries
    SET current_document_id = 'pointer-other-document'
    WHERE id = 'observability-entry'
  `).run();
  db.prepare(`
    UPDATE entries
    SET current_document_id = 'missing-document', current_translation_id = 'missing-translation'
    WHERE id = 'pointer-other-entry'
  `).run();
  db.close();
}

function seedSnapshotFaults(dataDir) {
  const rawDir = path.join(dataDir, 'raw', 'faults');
  fs.mkdirSync(rawDir, { recursive: true });
  const fixtures = [
    { id: 'missing', hash: '0'.repeat(64), size: 1 },
    { id: 'invalid-gzip', hash: '1'.repeat(64), size: 1 },
    { id: 'hash-mismatch', hash: '2'.repeat(64), body: Buffer.from('hash body') },
    { id: 'too-large', body: Buffer.alloc((5 * 1024 * 1024) + 1, 97) },
    { id: 'invalid-path', hash: '3'.repeat(64), bodyPath: '../outside.html.gz', size: 1 },
    { id: 'size-mismatch', body: Buffer.from('size body'), size: 999 },
  ];
  for (const fixture of fixtures) {
    if (fixture.body) {
      fixture.hash ||= crypto.createHash('sha256').update(fixture.body).digest('hex');
      fixture.size ||= fixture.body.length;
    }
    if (!fixture.bodyPath) {
      fixture.bodyPath = `raw/sha256/${fixture.hash.slice(0, 2)}/${fixture.hash.slice(2, 4)}/${fixture.hash}.html.gz`;
    }
    if (fixture.id === 'invalid-gzip') {
      fs.mkdirSync(path.dirname(path.join(dataDir, fixture.bodyPath)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, fixture.bodyPath), 'not gzip');
    } else if (fixture.body) {
      fs.mkdirSync(path.dirname(path.join(dataDir, fixture.bodyPath)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, fixture.bodyPath), zlib.gzipSync(fixture.body));
    }
  }
  fs.writeFileSync(path.join(rawDir, 'orphan.html.gz'), zlib.gzipSync(Buffer.from('orphan')));

  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  const insert = db.prepare(`
    INSERT INTO source_snapshots (
      id, entry_id, raw_hash, request_url, final_url, status_code, content_type,
      charset, response_meta_json, body_path, size_bytes, fetched_at
    ) VALUES (?, 'observability-entry', ?, 'https://example.com', 'https://example.com',
      200, 'text/html', 'utf-8', '{}', ?, ?, 30)
  `);
  for (const fixture of fixtures) {
    insert.run(`fault-${fixture.id}`, fixture.hash, fixture.bodyPath, fixture.size);
  }
  db.close();
}

function seedTranslationAssetHeadFaults(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.exec(`
    INSERT INTO users (
      id, email, display_name, default_reader_tab, role, password_hash, password_salt,
      created_at, updated_at
    ) VALUES (
      'asset-head-user', 'asset-head-user@example.com', 'Asset Head User', 'translation',
      'user', 'hash', 'salt', 30, 30
    );
  `);
  const insert = db.prepare(`
    INSERT INTO entry_ai_asset_contributions (
      id, entry_id, asset_type, user_id, author, title, summary, content_json, body,
      model, provider, content_hash, title_hash, created_at, updated_at, translation_version_id
    ) VALUES (?, 'observability-entry', ?, 'asset-head-user', 'Asset Head User', '', '', ?, ?,
      'model', 'deepseek', '', '', 31, 31, 'observability-translation')
  `);
  insert.run('wrong-owner-translation-head', 'translation', '[]', null);
  insert.run('rewrite-with-translation-head', 'rewrite', null, 'Body');
  db.close();
}

test('read-only verification fails safely when the database is missing and does not create it', () => {
  const dataDir = createTempDataDir('versioned-observability-missing-');
  const databaseFile = path.join(dataDir, 'qmreader.sqlite');
  try {
    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.deepEqual(result.output, {
      ok: false,
      failures: [{ code: 'database_missing', count: 1 }],
    });
    assert.equal(fs.existsSync(databaseFile), false);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('read-only verification accepts an initialized empty data directory', () => {
  const dataDir = createTempDataDir('versioned-observability-empty-');
  try {
    initializeStore(dataDir);
    const result = runVerifier(dataDir, ['--read-only']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.output, {
      ok: true,
      database: { quickCheck: 'ok', foreignKeyViolations: 0 },
      migration: {
        entries: 0,
        entriesWithCurrentDocument: 0,
        entriesWithoutCurrentDocument: 0,
        entriesWithCurrentTranslation: 0,
        entriesWithoutCurrentTranslation: 0,
        sourceSnapshots: 0,
        articleDocuments: 0,
        translationVersions: 0,
        translationJobs: 0,
        translationJobChunks: 0,
        legacyTranslations: 0,
        legacyTranslationContributions: 0,
      },
      pointers: {
        staleDocuments: 0,
        missingDocuments: 0,
        mismatchedDocuments: 0,
        missingTranslations: 0,
        mismatchedTranslationEntries: 0,
        mismatchedTranslationDocuments: 0,
        mismatchedTranslationAssetHeads: 0,
      },
      snapshots: {
        records: 0,
        checked: 0,
        missing: 0,
        invalidPath: 0,
        pathMismatch: 0,
        invalidGzip: 0,
        hashMismatch: 0,
        sizeMismatch: 0,
        tooLarge: 0,
      },
      rawBlobs: { files: 0, orphaned: 0 },
      failures: [],
    });
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification reports healthy migration and raw snapshot counts without leaking stored content or keys', () => {
  const dataDir = createTempDataDir('versioned-observability-healthy-');
  try {
    seedHealthyPipeline(dataDir);
    const result = runVerifier(dataDir, ['--read-only'], {
      DEEPSEEK_API_KEY: 'PRIVATE_API_KEY',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.output.database, { quickCheck: 'ok', foreignKeyViolations: 0 });
    assert.deepEqual(result.output.migration, {
      entries: 1,
      entriesWithCurrentDocument: 1,
      entriesWithoutCurrentDocument: 0,
      entriesWithCurrentTranslation: 1,
      entriesWithoutCurrentTranslation: 0,
      sourceSnapshots: 1,
      articleDocuments: 1,
      translationVersions: 1,
      translationJobs: 0,
      translationJobChunks: 0,
      legacyTranslations: 1,
      legacyTranslationContributions: 0,
    });
    assert.deepEqual(result.output.snapshots, {
      records: 1,
      checked: 1,
      missing: 0,
      invalidPath: 0,
      pathMismatch: 0,
      invalidGzip: 0,
      hashMismatch: 0,
      sizeMismatch: 0,
      tooLarge: 0,
    });
    assert.deepEqual(result.output.rawBlobs, { files: 1, orphaned: 0 });
    assert.deepEqual(result.output.failures, []);
    assert.equal(result.output.ok, true);
    assert.doesNotMatch(result.stdout, /PRIVATE_|<article>|prompt|api.?key/i);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification fails on missing and cross-entry current pointers', () => {
  const dataDir = createTempDataDir('versioned-observability-pointers-');
  try {
    seedHealthyPipeline(dataDir);
    seedPointerFaults(dataDir);
    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.deepEqual(result.output.pointers, {
      staleDocuments: 0,
      missingDocuments: 1,
      mismatchedDocuments: 1,
      missingTranslations: 1,
      mismatchedTranslationEntries: 0,
      mismatchedTranslationDocuments: 1,
      mismatchedTranslationAssetHeads: 0,
    });
    assert.deepEqual(result.output.failures, [
      { code: 'database.foreign_key', count: 2 },
      { code: 'pointer.missingDocuments', count: 1 },
      { code: 'pointer.mismatchedDocuments', count: 1 },
      { code: 'pointer.missingTranslations', count: 1 },
      { code: 'pointer.mismatchedTranslationDocuments', count: 1 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification rejects a stale current document', () => {
  const dataDir = createTempDataDir('versioned-observability-stale-legacy-');
  try {
    const seeded = runNode(dataDir, ['-e', `
      const crypto = require('crypto');
      const store = require(${JSON.stringify(storePath)});
      const { compileLegacyDocument } = require('./lib/article-documents');
      const entry = {
        id: 'stale-legacy-entry',
        sourceId: 'observability',
        title: 'Old title',
        link: 'https://example.com/stale-legacy',
        summary: '',
        content: '<p>Old body.</p>',
      };
      store.upsertEntries([entry]);
      const scanned = store.scanEntriesForVersionedMigration({ limit: 1 })[0];
      const compiled = compileLegacyDocument({ entry: scanned });
      const document = store.insertArticleDocument({
        ...compiled,
        id: 'stale-legacy-document-' + crypto.randomUUID(),
        entryId: entry.id,
        createdAt: scanned.createdAt,
      });
      store.setCurrentArticleDocument(entry.id, document.id);
      store.upsertEntries([{ ...entry, title: 'New title', content: '<p>New body.</p>' }]);
    `]);
    assert.equal(seeded.status, 0, seeded.stderr);

    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.equal(result.output.pointers.staleDocuments, 1);
    assert.deepEqual(result.output.failures, [
      { code: 'pointer.staleDocuments', count: 1 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification rejects translation asset heads with mismatched type or ownership semantics', () => {
  const dataDir = createTempDataDir('versioned-observability-asset-heads-');
  try {
    seedHealthyPipeline(dataDir);
    seedTranslationAssetHeadFaults(dataDir);
    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.equal(result.output.database.foreignKeyViolations, 0);
    assert.equal(result.output.pointers.mismatchedTranslationAssetHeads, 2);
    assert.deepEqual(result.output.failures, [
      { code: 'pointer.mismatchedTranslationAssetHeads', count: 2 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification accepts a current translation from older raw evidence with the same source hash', () => {
  const dataDir = createTempDataDir('versioned-observability-same-source-');
  try {
    seedHealthyPipeline(dataDir);
    const moved = runNode(dataDir, ['-e', `
      const store = require(${JSON.stringify(storePath)});
      const previous = store.getCurrentArticleDocument('observability-entry');
      const current = store.insertArticleDocument({
        ...previous,
        id: 'observability-new-raw-document',
        documentHash: 'observability-new-raw-document-hash',
        createdAt: 13,
      });
      store.setCurrentArticleDocument('observability-entry', current.id);
    `]);
    assert.equal(moved.status, 0, moved.stderr);

    const result = runVerifier(dataDir, ['--read-only']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.output.ok, true);
    assert.equal(result.output.pointers.mismatchedTranslationDocuments, 0);
    assert.equal(result.output.migration.articleDocuments, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification rejects missing, unsafe, corrupt, mismatched, oversized, and orphaned raw blobs', () => {
  const dataDir = createTempDataDir('versioned-observability-snapshots-');
  try {
    seedHealthyPipeline(dataDir);
    seedSnapshotFaults(dataDir);
    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.deepEqual(result.output.snapshots, {
      records: 7,
      checked: 5,
      missing: 1,
      invalidPath: 1,
      pathMismatch: 0,
      invalidGzip: 1,
      hashMismatch: 1,
      sizeMismatch: 1,
      tooLarge: 1,
    });
    assert.deepEqual(result.output.rawBlobs, { files: 6, orphaned: 1 });
    assert.deepEqual(result.output.failures.slice(-7), [
      { code: 'snapshot.missing', count: 1 },
      { code: 'snapshot.invalidPath', count: 1 },
      { code: 'snapshot.invalidGzip', count: 1 },
      { code: 'snapshot.hashMismatch', count: 1 },
      { code: 'snapshot.sizeMismatch', count: 1 },
      { code: 'snapshot.tooLarge', count: 1 },
      { code: 'raw_blob.orphaned', count: 1 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification rejects a valid raw blob referenced through a non-canonical body path', () => {
  const dataDir = createTempDataDir('versioned-observability-canonical-path-');
  try {
    seedHealthyPipeline(dataDir);
    const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
    const snapshot = db.prepare(`
      SELECT raw_hash AS rawHash, body_path AS bodyPath
      FROM source_snapshots
      WHERE id = 'observability-snapshot'
    `).get();
    const misplaced = `raw/misplaced/${snapshot.rawHash}.html.gz`;
    fs.mkdirSync(path.dirname(path.join(dataDir, misplaced)), { recursive: true });
    fs.renameSync(path.join(dataDir, snapshot.bodyPath), path.join(dataDir, misplaced));
    db.prepare(`
      UPDATE source_snapshots SET body_path = ? WHERE id = 'observability-snapshot'
    `).run(misplaced);
    db.close();

    const result = runVerifier(dataDir, ['--read-only']);

    assert.notEqual(result.status, 0);
    assert.equal(result.output.snapshots.checked, 1);
    assert.equal(result.output.snapshots.pathMismatch, 1);
    assert.deepEqual(result.output.rawBlobs, { files: 1, orphaned: 0 });
    assert.deepEqual(result.output.failures, [
      { code: 'snapshot.pathMismatch', count: 1 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verification CLI accepts both data-dir forms and rejects malformed arguments', () => {
  const dataDir = createTempDataDir('versioned-observability-args-');
  try {
    initializeStore(dataDir);
    const equalsResult = runNode(dataDir, [scriptPath, `--data-dir=${dataDir}`, '--read-only']);
    assert.equal(equalsResult.status, 0, equalsResult.stderr || equalsResult.stdout);
    assert.equal(JSON.parse(equalsResult.stdout).ok, true);

    for (const args of [
      ['--unknown'],
      ['--data-dir'],
      ['--data-dir='],
      ['--read-only=true'],
    ]) {
      const result = runNode(dataDir, [scriptPath, ...args]);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        failures: [{ code: 'invalid_arguments', count: 1 }],
      });
      assert.equal(result.stderr, '');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('README documents rollout, BYOK, backup, backfill, verification, and rollback boundaries', () => {
  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

  for (const mode of ['off', 'shadow', 'canary', 'all']) {
    assert.match(readme, new RegExp(`\\b${mode}\\b`));
  }
  assert.match(readme, /BYOK[^\n]*(同步|synchronous)/i);
  assert.match(readme, /backup/i);
  assert.match(readme, /rollback/i);
  assert.match(readme, /backfill-article-documents\.js/);
  assert.match(readme, /backfill-translation-versions\.js/);
  assert.match(readme, /verify-versioned-pipeline\.js/);
  assert.match(readme, /--read-only/);
});
