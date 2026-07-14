const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const rootDir = path.resolve(__dirname, '..');
const storePath = path.join(rootDir, 'lib', 'store.js');
const scriptPath = path.join(rootDir, 'scripts', 'backfill-translation-versions.js');

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

function seedCurrentDocument(dataDir, entryId) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const entryId = process.env.MIGRATION_ENTRY_ID;
    store.upsertEntries([{
      id: entryId,
      sourceId: 'translation-migration-test',
      title: 'Legacy translation article',
      link: 'https://example.com/' + entryId,
      summary: 'Source summary',
      content: '<p>Source body.</p>',
    }]);
    const document = store.insertArticleDocument({
      id: entryId + '-document',
      entryId,
      snapshotId: null,
      sourceComponents: [],
      provenance: 'legacy',
      rawStatus: 'unavailable',
      documentHash: entryId + '-document-hash',
      sourceHash: entryId + '-source-hash',
      extractorVersion: 'extractor-v1',
      sanitizerVersion: 'sanitizer-v1',
      segmenterVersion: 'segmenter-v1',
      title: 'Legacy translation article',
      summary: 'Source summary',
      normalizedHtml: '<p>Source body.</p>',
      plainText: 'Source body.',
      ast: [{ type: 'text', id: 's_body', role: 'paragraph', text: 'Source body.' }],
      resources: [],
      createdAt: 100,
    });
    store.setCurrentArticleDocument(entryId, document.id);
  `], { MIGRATION_ENTRY_ID: entryId });
  assert.equal(result.status, 0, result.stderr);
}

function seedLegacyTranslations(dataDir, entryId) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO users (
      id, email, display_name, default_reader_tab, role, password_hash, password_salt,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'rewrite', 'user', 'hash', 'salt', ?, ?)
  `).run('legacy-user', 'legacy-user@example.com', 'Legacy User', 10, 10);
  db.prepare(`
    INSERT INTO entry_translations (
      entry_id, user_id, title_zh, summary_zh, content_json, model, provider, created_by,
      content_hash, title_hash, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId,
    '系统旧标题',
    '系统旧摘要',
    JSON.stringify([{ source: 'Source body.', target: '系统旧译文。' }]),
    'legacy-system-model',
    'deepseek',
    'Legacy System',
    `${entryId}-source-hash`,
    'legacy-system-title-hash',
    111,
    112,
  );
  db.prepare(`
    INSERT INTO entry_ai_asset_contributions (
      id, entry_id, asset_type, user_id, author, title, summary, content_json, body,
      model, provider, content_hash, title_hash, created_at, updated_at
    ) VALUES (?, ?, 'translation', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-user-asset',
    entryId,
    'legacy-user',
    'Legacy User',
    '用户旧标题',
    '用户旧摘要',
    JSON.stringify([{ source: 'Source body.', target: '用户旧译文。' }]),
    'legacy-user-model',
    'byok',
    'unproven-user-content-hash',
    'legacy-user-title-hash',
    222,
    223,
  );
  db.close();
}

function seedLegacyCurrentTranslation(dataDir, entryId, overrides = {}) {
  const fixture = {
    titleZh: '系统旧标题',
    summaryZh: '系统旧摘要',
    content: [{ source: 'Source body.', target: '共享系统旧译文。' }],
    model: 'legacy-system-model',
    provider: 'deepseek',
    author: 'Legacy System',
    contentHash: `${entryId}-source-hash`,
    titleHash: 'legacy-system-title-hash',
    createdAt: 111,
    updatedAt: 112,
    ...overrides,
  };
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare(`
    INSERT INTO entry_translations (
      entry_id, user_id, title_zh, summary_zh, content_json, model, provider, created_by,
      content_hash, title_hash, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId,
    fixture.titleZh,
    fixture.summaryZh,
    JSON.stringify(fixture.content),
    fixture.model,
    fixture.provider,
    fixture.author,
    fixture.contentHash,
    fixture.titleHash,
    fixture.createdAt,
    fixture.updatedAt,
  );
  db.close();
}

function setLegacyTranslationCreatedAt(dataDir, entryId, createdAt) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE entry_translations SET created_at = ? WHERE entry_id = ?')
    .run(createdAt, entryId);
  db.close();
}

function saveLegacyRuntimeTranslation(dataDir, entryId, target) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const entryId = process.env.MIGRATION_ENTRY_ID;
    const entry = store.getEntry(entryId);
    store.saveTranslation(entryId, {
      titleZh: '运行时新标题',
      summaryZh: '运行时新摘要',
      content: [{ source: 'Source body.', target: process.env.MIGRATION_TARGET }],
      model: 'legacy-runtime-model',
      provider: 'byok',
      createdBy: 'Legacy Runtime',
      contentHash: store.hashText(entry.title + '\\n' + entry.content),
      titleHash: store.hashText(entry.title),
    });
  `], {
    MIGRATION_ENTRY_ID: entryId,
    MIGRATION_TARGET: target,
    VERSIONED_TRANSLATION_MODE: 'shadow',
  });
  assert.equal(result.status, 0, result.stderr);
}

function overwriteLegacyTranslationContent(dataDir, entryId, target) {
  const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
  db.prepare('UPDATE entry_translations SET content_json = ?, updated_at = updated_at + 1 WHERE entry_id = ?')
    .run(JSON.stringify([{ source: 'Source body.', target }]), entryId);
  db.close();
}

function publishCurrentV2Translation(dataDir, entryId, target) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const entryId = process.env.MIGRATION_ENTRY_ID;
    const document = store.getCurrentArticleDocument(entryId);
    store.publishTranslationVersion({
      id: 'migration-current-v2-version',
      entryId,
      documentId: document.id,
      ownerType: 'system',
      userId: null,
      author: 'Namoo Reader',
      sourceHash: document.sourceHash,
      pipelineHash: 'current-v2-pipeline',
      generationHash: 'migration-current-v2-generation',
      schemaVersion: 2,
      titleZh: 'V2 当前标题',
      summaryZh: '',
      content: {
        schemaVersion: 2,
        translations: [{ id: 's_body', target: process.env.MIGRATION_TARGET }],
      },
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      createdAt: 5000,
    }, { promotion: 'auto' });
  `], {
    MIGRATION_ENTRY_ID: entryId,
    MIGRATION_TARGET: target,
  });
  assert.equal(result.status, 0, result.stderr);
}

function runMigration(dataDir, args = [], expectedStatus = 0) {
  const result = runNode(dataDir, [scriptPath, ...args]);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function readMigrationState(dataDir, entryId) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const entryId = process.env.MIGRATION_ENTRY_ID;
    const userAsset = store.resolveTranslationVersionAsset(entryId, 'legacy-user-asset');
    console.log(JSON.stringify({
      current: store.getCurrentTranslationVersion(entryId),
      user: userAsset && userAsset.version,
      compatible: store.getTranslation(entryId),
      contribution: store.getAiAssetContribution('legacy-user-asset', 'translation'),
      stats: store.getVersionedDocumentStats(),
    }));
  `], { MIGRATION_ENTRY_ID: entryId });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function readCurrentVersions(dataDir, entryIds) {
  const result = runNode(dataDir, ['-e', `
    const store = require(${JSON.stringify(storePath)});
    const ids = JSON.parse(process.env.MIGRATION_ENTRY_IDS);
    console.log(JSON.stringify(ids.map(id => store.getCurrentTranslationVersion(id))));
  `], { MIGRATION_ENTRY_IDS: JSON.stringify(entryIds) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('migration CLI rejects unknown, missing, and out-of-range arguments', () => {
  const dataDir = createTempDataDir('translation-version-migration-args-');
  try {
    for (const args of [
      ['--unknown'],
      ['--after-id'],
      ['--batch-size'],
      ['--batch-size=0'],
      ['--batch-size=1001'],
      ['--batch-size=not-a-number'],
    ]) {
      const result = runNode(dataDir, [scriptPath, ...args]);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /error|requires|batch-size|unknown argument/i, args.join(' '));
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backfill preserves current and contributed legacy translations without duplicating versions', () => {
  const dataDir = createTempDataDir('translation-version-migration-');
  const entryId = 'migration-basic-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyTranslations(dataDir, entryId);

    const first = runMigration(dataDir, ['--batch-size=1']);
    const state = readMigrationState(dataDir, entryId);
    const second = runMigration(dataDir, ['--batch-size=1']);

    assert.deepEqual(first, {
      scanned: 2,
      created: 2,
      reused: 0,
      currentSources: 1,
      contributions: 1,
      matched: 0,
      legacyUnknown: 2,
      skippedDeleted: 0,
      skippedEmpty: 0,
      skippedNoDocument: 0,
      errors: 0,
      pointersSet: 1,
      cursor: `current:${entryId}`,
    });
    assert.match(state.current.id, /^legacy-current-version-[a-f0-9]{32}$/);
    assert.equal(state.current.ownerType, 'system');
    assert.equal(state.current.author, 'Legacy System');
    assert.equal(state.current.pipelineHash, 'legacy_unknown');
    assert.equal(state.current.createdAt, 111);
    assert.deepEqual(state.current.content, [{ source: 'Source body.', target: '系统旧译文。' }]);
    assert.match(state.user.id, /^legacy-contribution-version-[a-f0-9]{32}$/);
    assert.notEqual(state.user.id, 'legacy-user-asset');
    assert.equal(state.user.ownerType, 'user');
    assert.equal(state.user.userId, 'legacy-user');
    assert.equal(state.user.author, 'Legacy User');
    assert.equal(state.user.model, 'legacy-user-model');
    assert.equal(state.user.provider, 'byok');
    assert.equal(state.user.pipelineHash, 'legacy_unknown');
    assert.equal(state.user.createdAt, 222);
    assert.match(state.user.generationHash, /^[a-f0-9]{64}$/);
    assert.equal(state.compatible.createdBy, 'Legacy System');
    assert.equal(state.contribution.id, 'legacy-user-asset');
    assert.equal(state.stats.translationVersions, 2);
    assert.deepEqual(second, {
      scanned: 2,
      created: 0,
      reused: 2,
      currentSources: 1,
      contributions: 1,
      matched: 0,
      legacyUnknown: 2,
      skippedDeleted: 0,
      skippedEmpty: 0,
      skippedNoDocument: 0,
      errors: 0,
      pointersSet: 0,
      cursor: `current:${entryId}`,
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dry-run reports legacy translation work without reading cache or writing versions', () => {
  const dataDir = createTempDataDir('translation-version-migration-dry-run-');
  const entryId = 'migration-dry-run-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyCurrentTranslation(dataDir, entryId);
    fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({
      translations: [{ entryId: 'cache-only-translation' }],
    }));

    const stats = runMigration(dataDir, ['--dry-run', '--batch-size=1']);
    const state = readMigrationState(dataDir, entryId);

    assert.deepEqual(stats, {
      scanned: 1,
      created: 0,
      reused: 0,
      currentSources: 1,
      contributions: 0,
      matched: 0,
      legacyUnknown: 1,
      skippedDeleted: 0,
      skippedEmpty: 0,
      skippedNoDocument: 0,
      errors: 0,
      pointersSet: 0,
      cursor: `current:${entryId}`,
    });
    assert.equal(state.current, null);
    assert.equal(state.stats.translationVersions, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('identical legacy translations on different articles receive distinct generation hashes', () => {
  const dataDir = createTempDataDir('translation-version-migration-cross-entry-');
  const entryIds = ['migration-cross-entry-a', 'migration-cross-entry-b'];
  try {
    for (const entryId of entryIds) {
      seedCurrentDocument(dataDir, entryId);
      seedLegacyCurrentTranslation(dataDir, entryId, {
        contentHash: 'same-unproven-content-hash',
        content: [{ source: 'Same source.', target: '完全相同的旧译文。' }],
        createdAt: 500,
        updatedAt: 500,
      });
    }

    const stats = runMigration(dataDir, ['--batch-size=1']);
    const versions = readCurrentVersions(dataDir, entryIds);

    assert.equal(stats.scanned, 2);
    assert.equal(stats.created, 2);
    assert.equal(stats.currentSources, 2);
    assert.equal(stats.legacyUnknown, 2);
    assert.equal(stats.errors, 0);
    assert.notEqual(versions[0].generationHash, versions[1].generationHash);
    assert.notEqual(versions[0].documentId, versions[1].documentId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('after-id resumes strictly after the legacy asset cursor across small batches', () => {
  const dataDir = createTempDataDir('translation-version-migration-resume-');
  const entryIds = ['migration-resume-a', 'migration-resume-b'];
  try {
    for (const entryId of entryIds) {
      seedCurrentDocument(dataDir, entryId);
      seedLegacyCurrentTranslation(dataDir, entryId);
    }

    const stats = runMigration(dataDir, [
      '--after-id',
      `current:${entryIds[0]}`,
      '--batch-size',
      '1',
    ]);
    const versions = readCurrentVersions(dataDir, entryIds);

    assert.equal(stats.scanned, 1);
    assert.equal(stats.created, 1);
    assert.equal(stats.cursor, `current:${entryIds[1]}`);
    assert.equal(versions[0], null);
    assert.ok(versions[1]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only reports missing versions and current pointers without writing', () => {
  const dataDir = createTempDataDir('translation-version-migration-verify-');
  const migratedEntryId = 'migration-verify-a';
  const missingEntryId = 'migration-verify-b';
  try {
    seedCurrentDocument(dataDir, migratedEntryId);
    seedLegacyCurrentTranslation(dataDir, migratedEntryId);
    runMigration(dataDir);
    seedCurrentDocument(dataDir, missingEntryId);
    seedLegacyCurrentTranslation(dataDir, missingEntryId);

    const stats = runMigration(dataDir, ['--verify-only'], 1);
    const versions = readCurrentVersions(dataDir, [migratedEntryId, missingEntryId]);

    assert.equal(stats.scanned, 2);
    assert.equal(stats.created, 0);
    assert.equal(stats.reused, 1);
    assert.equal(stats.errors, 1);
    assert.equal(stats.pointersSet, 0);
    assert.ok(versions[0]);
    assert.equal(versions[1], null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a post-backfill legacy save advances the immutable pointer and verify-only compares its content', () => {
  const dataDir = createTempDataDir('translation-version-migration-runtime-sync-');
  const entryId = 'migration-runtime-sync-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyCurrentTranslation(dataDir, entryId);
    runMigration(dataDir);

    saveLegacyRuntimeTranslation(dataDir, entryId, '运行时第二版。');
    const verified = runMigration(dataDir, ['--verify-only']);
    const state = readMigrationState(dataDir, entryId);

    assert.equal(verified.errors, 0);
    assert.equal(verified.reused, 1);
    assert.equal(state.current.content[0].target, '运行时第二版。');
    assert.equal(state.current.ownerType, 'system');
    assert.equal(state.current.pipelineHash, 'legacy_runtime_v1');
    assert.equal(state.compatible.content[0].target, '运行时第二版。');
    assert.equal(state.stats.translationVersions, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only fails when the legacy projection diverges from its immutable current version', () => {
  const dataDir = createTempDataDir('translation-version-migration-divergence-');
  const entryId = 'migration-divergence-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyCurrentTranslation(dataDir, entryId);
    runMigration(dataDir);
    overwriteLegacyTranslationContent(dataDir, entryId, '未同步的新内容。');

    const verified = runMigration(dataDir, ['--verify-only'], 1);

    assert.equal(verified.errors, 1);
    assert.equal(verified.reused, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ordinary rerun refuses to overwrite either side of a legacy/version divergence', () => {
  const dataDir = createTempDataDir('translation-version-migration-divergence-rerun-');
  const entryId = 'migration-divergence-rerun-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyCurrentTranslation(dataDir, entryId);
    runMigration(dataDir);
    const before = readMigrationState(dataDir, entryId);
    overwriteLegacyTranslationContent(dataDir, entryId, '未同步的新内容。');

    const rerun = runMigration(dataDir, [], 1);
    const after = readMigrationState(dataDir, entryId);

    assert.equal(rerun.errors, 1);
    assert.equal(rerun.created, 0);
    assert.equal(after.current.id, before.current.id);
    assert.equal(after.current.content[0].target, before.current.content[0].target);
    assert.equal(after.compatible.content[0].target, '未同步的新内容。');
    assert.equal(after.stats.translationVersions, before.stats.translationVersions);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify-only accepts a schema-2 current version whose legacy projection matches', () => {
  const dataDir = createTempDataDir('translation-version-migration-v2-projection-');
  const entryId = 'migration-v2-projection-entry';
  try {
    seedCurrentDocument(dataDir, entryId);
    seedLegacyCurrentTranslation(dataDir, entryId);
    runMigration(dataDir);
    publishCurrentV2Translation(dataDir, entryId, 'V2 当前正文。');

    const verified = runMigration(dataDir, ['--verify-only']);
    const state = readMigrationState(dataDir, entryId);

    assert.equal(verified.errors, 0);
    assert.equal(verified.reused, 1);
    assert.equal(state.current.id, 'migration-current-v2-version');
    assert.equal(state.current.schemaVersion, 2);
    assert.equal(state.compatible.content[0].target, 'V2 当前正文。');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('failed legacy translation stops at a safe cursor and resumes after repair', () => {
  const dataDir = createTempDataDir('translation-version-migration-failure-');
  const entryIds = ['migration-failure-a', 'migration-failure-b', 'migration-failure-c'];
  try {
    for (const entryId of entryIds) {
      seedCurrentDocument(dataDir, entryId);
      seedLegacyCurrentTranslation(dataDir, entryId);
    }
    setLegacyTranslationCreatedAt(dataDir, entryIds[1], -1);

    const failed = runMigration(dataDir, ['--batch-size=3'], 1);
    const afterFailure = readCurrentVersions(dataDir, entryIds);

    assert.equal(failed.scanned, 2);
    assert.equal(failed.created, 1);
    assert.equal(failed.errors, 1);
    assert.equal(failed.pointersSet, 1);
    assert.equal(failed.cursor, `current:${entryIds[0]}`);
    assert.ok(afterFailure[0]);
    assert.equal(afterFailure[1], null);
    assert.equal(afterFailure[2], null);

    setLegacyTranslationCreatedAt(dataDir, entryIds[1], 50);
    const resumed = runMigration(dataDir, [
      `--after-id=current:${entryIds[0]}`,
      '--batch-size=1',
    ]);
    const afterResume = readCurrentVersions(dataDir, entryIds);

    assert.equal(resumed.scanned, 2);
    assert.equal(resumed.created, 2);
    assert.equal(resumed.errors, 0);
    assert.equal(resumed.cursor, `current:${entryIds[2]}`);
    assert.ok(afterResume.every(Boolean));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
