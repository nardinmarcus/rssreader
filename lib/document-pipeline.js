const crypto = require('crypto');
const cheerio = require('cheerio');
const {
  compileFetchedDocument,
  compileFeedDocument,
} = require('./article-documents');
const snapshots = require('./source-snapshots');
const rollout = require('./translation-rollout');
const { enqueueDocumentTranslation } = require('./translation-job-request');
const store = require('./store');

function documentId(entryId, documentHash) {
  return `document-${crypto.createHash('sha256')
    .update(`${entryId}\n${documentHash}`, 'utf8')
    .digest('hex')}`;
}

function legacyProjection(entry = {}) {
  const html = String(entry.content || entry.summary || '');
  const baseUrl = String(entry.link || '');
  const $ = cheerio.load(html, { decodeEntities: false }, false);
  const resourceUrls = new Set();
  $('[href],[src]').each((_, element) => {
    for (const attribute of ['href', 'src']) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try {
        const url = new URL(value, baseUrl || undefined);
        if (['http:', 'https:'].includes(url.protocol)) resourceUrls.add(url.toString());
      } catch { /* ignore invalid legacy resource URL */ }
    }
  });
  return {
    plainText: $.root().text().replace(/\s+/g, ' ').trim(),
    resourceUrls: Array.from(resourceUrls).sort(),
  };
}

function comparisonFor(entry, document) {
  const legacy = legacyProjection(entry);
  const versionedPlainText = String(document.plainText || '');
  const legacyCharacters = legacy.plainText.length;
  const versionedCharacters = versionedPlainText.replace(/\s+/g, ' ').trim().length;
  return {
    legacyPlainText: legacy.plainText,
    versionedPlainText,
    legacyResourceUrls: legacy.resourceUrls,
    versionedResourceUrls: [...new Set((document.resources || [])
      .map(resource => resource && resource.url)
      .filter(Boolean))].sort(),
    bodyCoverage: {
      legacyCharacters,
      versionedCharacters,
      ratio: legacyCharacters ? Number((versionedCharacters / legacyCharacters).toFixed(4)) : null,
      deltaCharacters: versionedCharacters - legacyCharacters,
    },
  };
}

function insertCompiledDocument(entry, compiled, { setCurrent = true } = {}) {
  const previousDocument = store.getCurrentArticleDocument(entry.id);
  const previousTranslation = store.getCurrentTranslationVersion(entry.id);
  const inserted = store.insertArticleDocument({
    id: documentId(entry.id, compiled.documentHash),
    entryId: entry.id,
    snapshotId: compiled.snapshotId,
    sourceComponents: compiled.sourceComponents,
    provenance: compiled.provenance,
    rawStatus: compiled.rawStatus,
    documentHash: compiled.documentHash,
    sourceHash: compiled.sourceHash,
    extractorVersion: compiled.extractorVersion,
    sanitizerVersion: compiled.sanitizerVersion,
    segmenterVersion: compiled.segmenterVersion,
    title: compiled.title,
    summary: compiled.summary,
    normalizedHtml: compiled.normalizedHtml,
    plainText: compiled.plainText,
    ast: compiled.ast,
    resources: compiled.resources,
    createdAt: Date.now(),
  });
  const changed = Boolean(previousDocument && previousDocument.id !== inserted.id);
  const semanticChanged = Boolean(previousDocument && previousDocument.sourceHash !== inserted.sourceHash);
  let translationJob = null;
  if (setCurrent) {
    store.setCurrentArticleDocument(entry.id, inserted.id, { supersedeActiveJobs: semanticChanged });
  }
  if (setCurrent
    && changed
    && semanticChanged
    && previousTranslation
    && previousTranslation.ownerType === 'system'
    && previousTranslation.pipelineHash !== 'legacy_unknown'
    && previousTranslation.sourceHash !== inserted.sourceHash
    && rollout.autoQueuesSystemTranslation(entry)) {
    try {
      translationJob = enqueueDocumentTranslation({
        entryId: entry.id,
        document: inserted,
        ownerType: 'system',
        userId: null,
        author: previousTranslation.author || 'Namoo Reader',
        priority: 50,
      });
    } catch (error) {
      if (Number(error && error.statusCode) !== 503) {
        console.warn(JSON.stringify({
          event: 'versioned_translation_auto_enqueue_failed',
          entryId: entry.id,
          documentId: inserted.id,
          code: String(error && error.code || 'ERR_TRANSLATION_AUTO_ENQUEUE'),
        }));
      }
    }
  }
  return { document: inserted, translationJob };
}

async function captureFeed({ entry, finalUrl, sourceComponents = [], forceCapture = false } = {}) {
  if (!forceCapture && !rollout.writesVersionedDocuments()) {
    return { captured: false, mode: rollout.mode() };
  }
  if (!entry || !entry.id) throw new TypeError('entry is required');
  const compiled = compileFeedDocument({ entry, finalUrl, sourceComponents });
  const { document, translationJob } = insertCompiledDocument(entry, compiled);
  return {
    captured: true,
    mode: rollout.mode(),
    document,
    translationJob,
    comparison: comparisonFor(entry, document),
  };
}

async function captureFetched({ entry, response = {}, sourceComponents = [], setCurrent = true } = {}) {
  if (!rollout.writesVersionedDocuments()) {
    return { captured: false, mode: rollout.mode() };
  }
  if (!entry || !entry.id) throw new TypeError('entry is required');
  if (!Buffer.isBuffer(response.buffer)) throw new TypeError('response.buffer must be a Buffer');

  const rawHash = await snapshots.put(response.buffer);
  const snapshot = store.insertSourceSnapshot({
    id: `snapshot-${crypto.randomUUID()}`,
    entryId: entry.id,
    rawHash,
    requestUrl: String(response.requestUrl || entry.link || ''),
    finalUrl: String(response.finalUrl || entry.link || ''),
    statusCode: response.statusCode,
    contentType: String(response.contentType || ''),
    charset: String(response.charset || ''),
    responseMeta: response.responseMeta || {},
    bodyPath: snapshots.relativePath(rawHash),
    sizeBytes: response.buffer.length,
    fetchedAt: Date.now(),
  });
  const compiled = compileFetchedDocument({
    entry,
    html: String(entry.content || entry.summary || ''),
    buffer: response.buffer,
    rawHash,
    finalUrl: response.finalUrl || entry.link,
    snapshotId: snapshot.id,
    sourceComponents,
  });
  const { document, translationJob } = insertCompiledDocument(entry, compiled, { setCurrent });
  return {
    captured: true,
    mode: rollout.mode(),
    snapshot,
    document,
    translationJob,
    comparison: comparisonFor(entry, document),
  };
}

module.exports = {
  captureFetched,
  captureFeed,
};
