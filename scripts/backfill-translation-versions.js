const {
  canonicalSerialize,
  computeRawHash,
} = require('../lib/content-hashes');
const store = require('../lib/store');

const LEGACY_UNKNOWN_PIPELINE = 'legacy_unknown';

function parseBatchSize(value) {
  const text = String(value || '');
  const number = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(number) || number > 1000) {
    throw new Error('batch-size must be a positive integer no greater than 1000');
  }
  return number;
}

function digest(value) {
  return computeRawHash(Buffer.from(canonicalSerialize(value), 'utf8'));
}

function parseArgs(argv) {
  let batchSize = 100;
  let afterId = '';
  let dryRun = false;
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
    if (arg === '--batch-size') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('batch-size requires a value');
      }
      index += 1;
      batchSize = parseBatchSize(argv[index]);
      continue;
    }
    if (arg.startsWith('--batch-size=')) {
      batchSize = parseBatchSize(arg.slice('--batch-size='.length));
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
    throw new Error(`unknown argument: ${arg}`);
  }
  if (dryRun && verifyOnly) throw new Error('dry-run and verify-only cannot be combined');
  return { afterId, batchSize, dryRun, verifyOnly };
}

function hasTranslatedContent(content) {
  return Array.isArray(content)
    && content.some(item => item && String(item.target || item.targetHtml || '').trim());
}

function pipelineHash() {
  return LEGACY_UNKNOWN_PIPELINE;
}

function recordIdentity(record) {
  const ownerType = record.userId ? 'user' : 'system';
  return {
    migration: 'legacy-translation-version-v2',
    cursor: record.cursor,
    entryId: record.entryId,
    documentId: record.currentDocumentId,
    ownerType,
    userId: record.userId || null,
    author: record.author || (ownerType === 'system' ? 'system' : '读者'),
    sourceHash: record.documentSourceHash,
    pipelineHash: pipelineHash(record),
    titleZh: record.titleZh || '',
    summaryZh: record.summaryZh || '',
    content: record.content,
    provider: record.provider || 'deepseek',
    model: record.model || '',
    createdAt: record.createdAt,
  };
}

function versionId(record) {
  const prefix = record.sourceType === 'contribution'
    ? 'legacy-contribution-version'
    : 'legacy-current-version';
  return `${prefix}-${digest(recordIdentity(record)).slice(0, 32)}`;
}

function buildVersion(record) {
  const ownerType = record.userId ? 'user' : 'system';
  const pipeline = pipelineHash(record);
  const id = versionId(record);
  const identity = recordIdentity(record);
  return {
    id,
    entryId: record.entryId,
    documentId: record.currentDocumentId,
    ownerType,
    userId: record.userId,
    author: record.author || (ownerType === 'system' ? 'system' : '读者'),
    sourceHash: record.documentSourceHash,
    pipelineHash: pipeline,
    generationHash: digest(identity),
    schemaVersion: 1,
    titleZh: record.titleZh,
    summaryZh: record.summaryZh,
    content: record.content,
    provider: record.provider || 'deepseek',
    model: record.model || '',
    createdAt: record.createdAt,
  };
}

function legacyProjection(content) {
  if (Array.isArray(content)) return content;
  const translations = content && Array.isArray(content.translations)
    ? content.translations
    : [];
  return translations.map(item => ({
    segmentId: String(item && item.id || ''),
    source: '',
    target: String(item && item.target || ''),
  })).filter(item => item.target);
}

function versionMatchesRecord(version, record) {
  if (!version) return false;
  const ownerType = record.userId ? 'user' : 'system';
  return version.entryId === record.entryId
    && version.ownerType === ownerType
    && (version.userId || null) === (record.userId || null)
    && version.author === (record.author || (ownerType === 'system' ? 'system' : '读者'))
    && (record.sourceType === 'contribution' || version.sourceHash === record.documentSourceHash)
    && version.titleZh === (record.titleZh || '')
    && version.summaryZh === (record.summaryZh || '')
    && canonicalSerialize(legacyProjection(version.content)) === canonicalSerialize(record.content)
    && version.provider === (record.provider || 'deepseek')
    && version.model === (record.model || '');
}

function resolvedRecordVersion(record) {
  if (record.sourceType === 'current') {
    return {
      stable: true,
      version: store.getTranslationVersion(record.currentTranslationId),
    };
  }
  return store.resolveTranslationVersionAsset(record.entryId, record.assetId);
}

function main() {
  const { afterId, batchSize, dryRun, verifyOnly } = parseArgs(process.argv.slice(2));
  const stats = {
    scanned: 0,
    created: 0,
    reused: 0,
    currentSources: 0,
    contributions: 0,
    matched: 0,
    legacyUnknown: 0,
    skippedDeleted: 0,
    skippedEmpty: 0,
    skippedNoDocument: 0,
    errors: 0,
    pointersSet: 0,
    cursor: afterId,
  };
  let failure = null;

  migration:
  while (true) {
    const records = store.scanLegacyTranslationsForVersionedMigration({
      afterId: stats.cursor,
      limit: batchSize,
    });
    if (!records.length) break;

    for (const record of records) {
      stats.scanned += 1;
      if (record.sourceType === 'current') stats.currentSources += 1;
      else stats.contributions += 1;
      try {
        if (record.deletedAt) {
          stats.skippedDeleted += 1;
          stats.cursor = record.cursor;
          continue;
        }
        if (!record.currentDocumentId || !record.documentSourceHash) {
          stats.skippedNoDocument += 1;
          stats.cursor = record.cursor;
          continue;
        }
        if (!hasTranslatedContent(record.content)) {
          stats.skippedEmpty += 1;
          stats.cursor = record.cursor;
          continue;
        }
        const desiredVersion = buildVersion(record);
        const resolved = resolvedRecordVersion(record);
        const projectionMatches = Boolean(resolved && resolved.stable
          && versionMatchesRecord(resolved.version, record));
        const classifiedVersion = projectionMatches ? resolved.version : desiredVersion;
        if (classifiedVersion.pipelineHash === LEGACY_UNKNOWN_PIPELINE) stats.legacyUnknown += 1;
        else stats.matched += 1;
        if (verifyOnly) {
          if (projectionMatches) stats.reused += 1;
          else stats.errors += 1;
          stats.cursor = record.cursor;
          continue;
        }
        if (dryRun) {
          if (resolved && resolved.version && !projectionMatches) stats.errors += 1;
          if (projectionMatches) stats.reused += 1;
          stats.cursor = record.cursor;
          continue;
        }
        if (resolved && resolved.version && !projectionMatches) {
          const error = new Error('legacy projection diverges from its immutable version head');
          error.code = 'ERR_LEGACY_TRANSLATION_DIVERGED';
          throw error;
        }
        if (projectionMatches) {
          stats.reused += 1;
          stats.cursor = record.cursor;
          continue;
        }
        const existing = store.getTranslationVersion(desiredVersion.id);
        const version = existing || desiredVersion;
        let published = null;
        if (record.sourceType === 'current') {
          published = store.publishTranslationVersion(version, {
            promotion: 'legacy',
            legacyProjectionFence: record,
          });
        } else {
          published = store.publishTranslationVersion(version, {
            promotion: 'never',
            legacyProjectionFence: record,
          });
        }
        if (existing) stats.reused += 1;
        else if (published && published.created) stats.created += 1;
        else stats.reused += 1;
        if (published && published.pointerChanged) stats.pointersSet += 1;
        stats.cursor = record.cursor;
      } catch (error) {
        stats.errors += 1;
        failure = {
          cursor: record.cursor,
          error: String(error && error.message || error),
        };
        break migration;
      }
    }

    if (records.length < batchSize) break;
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
