const crypto = require('crypto');
const store = require('../lib/store');
const { compileLegacyDocument, matchesEntryProjection } = require('../lib/article-documents');

function parseBatchSize(value) {
  const text = String(value || '');
  const number = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(number) || number > 1000) {
    throw new Error('batch-size must be a positive integer no greater than 1000');
  }
  return number;
}

function parseArgs(argv) {
  let batchSize = 100;
  let dryRun = false;
  let afterId = '';
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--verify-only') {
      verifyOnly = true;
      continue;
    }
    if (arg === '--after-id') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('after-id requires a value');
      }
      index += 1;
      afterId = String(argv[index]);
      continue;
    }
    if (arg.startsWith('--after-id=')) {
      afterId = arg.slice('--after-id='.length);
      if (!afterId) throw new Error('after-id requires a value');
      continue;
    }
    if (arg === '--batch-size') {
      index += 1;
      batchSize = parseBatchSize(argv[index]);
      continue;
    }
    if (arg.startsWith('--batch-size=')) {
      batchSize = parseBatchSize(arg.slice('--batch-size='.length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (dryRun && verifyOnly) throw new Error('dry-run and verify-only cannot be combined');
  return { afterId, batchSize, dryRun, verifyOnly };
}

function documentId(entryId, documentHash) {
  const hash = crypto.createHash('sha256')
    .update(`${entryId}\n${documentHash}`, 'utf8')
    .digest('hex');
  return `article-document-${hash}`;
}

function main() {
  const { afterId, batchSize, dryRun, verifyOnly } = parseArgs(process.argv.slice(2));
  const stats = {
    scanned: 0,
    created: 0,
    reused: 0,
    skippedDeleted: 0,
    skippedEmpty: 0,
    summaryOnly: 0,
    errors: 0,
    pointersSet: 0,
    cursor: afterId,
  };
  let failure = null;

  migration:
  while (true) {
    const entries = store.scanEntriesForVersionedMigration({
      afterId: stats.cursor,
      limit: batchSize,
    });
    if (!entries.length) break;

    for (const entry of entries) {
      stats.scanned += 1;
      try {
        if (entry.deletedAt) {
          stats.skippedDeleted += 1;
          stats.cursor = entry.id;
          continue;
        }
        if (!String(entry.content || '').trim()) {
          if (!String(entry.summary || '').trim()) {
            stats.skippedEmpty += 1;
            stats.cursor = entry.id;
            continue;
          }
          stats.summaryOnly += 1;
        }
        const compiled = compileLegacyDocument({ entry });
        const current = entry.currentDocumentId
          ? store.getCurrentArticleDocument(entry.id)
          : null;
        if (current && matchesEntryProjection(current, compiled)) {
          stats.reused += 1;
          stats.cursor = entry.id;
          continue;
        }
        if (verifyOnly) {
          stats.errors += 1;
          stats.cursor = entry.id;
          continue;
        }
        if (dryRun) {
          stats.cursor = entry.id;
          continue;
        }
        const stored = store.backfillArticleDocument(entry, {
          ...compiled,
          id: documentId(entry.id, compiled.documentHash),
          entryId: entry.id,
          createdAt: entry.createdAt,
        });
        if (stored.created) stats.created += 1;
        else stats.reused += 1;
        if (stored.pointerChanged) stats.pointersSet += 1;
        stats.cursor = entry.id;
      } catch (error) {
        stats.errors += 1;
        failure = {
          entryId: entry.id,
          error: String(error && error.message || error),
        };
        break migration;
      }
    }

    if (entries.length < batchSize) break;
  }

  process.stdout.write(`${JSON.stringify(stats)}\n`);
  if (failure) process.stderr.write(`${JSON.stringify(failure)}\n`);
  if (stats.errors) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error && error.message || error) })}\n`);
  process.exitCode = 1;
}
