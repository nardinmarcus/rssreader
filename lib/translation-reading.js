const store = require('./store');
const translationJobs = require('./translation-jobs');
const { articleDocumentSegments } = require('./article-documents');
const {
  buildTranslationInputV2,
  translationPipelineHash,
} = require('./translation-contract');
const { renderTranslation } = require('./translation-renderer');

// Translation reading seam shared by the read route, the generation POST
// response, the BYOK sync fallback and the helpful-contribution route.
//
// One interface assembles the public translation state: legacy or versioned
// resolution, stable-asset selection, freshness, pinned-document rendering,
// schema compatibility projection and job progress. Callers pass an entry, a
// viewer and optional read hints; HTTP concerns (authentication, status
// codes, rollout gating and canary logging) stay in server.js.

function translationResponse(entry, viewer = null, assetId = '') {
  const exactAssetId = String(assetId || '').trim();
  const translation = exactAssetId
    ? store.getAiAssetContribution(exactAssetId, 'translation')
    : store.getTranslation(entry.id);
  if (translation && exactAssetId && translation.entryId !== entry.id) return null;
  if (!translation) return null;
  const contentHash = store.hashText((entry.title || '') + '\n' + (entry.content || entry.summary || ''));
  const reaction = store.getEntryAssetReaction(entry.id, 'translation', viewer, exactAssetId);
  return {
    ...translation,
    ...reaction,
    stale: Boolean(translation.contentHash && translation.contentHash !== contentHash),
  };
}

function publicTranslationJob(job) {
  if (!job) return null;
  const completed = (job.chunks || []).filter(chunk => chunk.status === 'succeeded').length;
  return {
    id: job.id,
    status: job.status,
    progress: { completed, total: (job.chunks || []).length },
    error: job.status === 'failed'
      ? { code: job.errorCode || 'ERR_TRANSLATION_JOB_FAILED', message: '翻译任务失败，请稍后重试' }
      : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function currentTranslationJob(entry, viewer) {
  const jobId = store.getLatestTranslationJobForEntry(entry.id, {
    userId: viewer && viewer.id,
    includeSystem: true,
  });
  return jobId ? translationJobs.getStatus(jobId) : null;
}

function legacyTranslationState(entry, viewer = null, job = null, assetId = '') {
  const translation = translationResponse(entry, viewer, assetId);
  const document = store.getCurrentArticleDocument(entry.id);
  const stale = Boolean(translation && translation.stale);
  return {
    translation,
    schemaVersion: null,
    documentId: document ? document.id : null,
    versionId: null,
    status: stale ? 'stale_source' : (translation ? 'legacy_unknown' : 'missing'),
    staleReasons: translation
      ? [...(stale ? ['source_hash_changed'] : []), 'legacy_hash_unknown']
      : [],
    job: publicTranslationJob(job),
    renderedHtml: null,
  };
}

function translationVersionFreshness(version, currentDocument) {
  const staleReasons = [];
  const sourceChanged = version.sourceHash !== currentDocument.sourceHash;
  if (sourceChanged && version.documentId !== currentDocument.id) staleReasons.push('source_document_changed');
  if (sourceChanged) staleReasons.push('source_hash_changed');
  const legacyUnknown = version.pipelineHash === 'legacy_unknown';
  if (!legacyUnknown && version.pipelineHash !== translationPipelineHash()) {
    staleReasons.push('pipeline_hash_changed');
  }
  return {
    status: staleReasons.some(reason => reason.startsWith('source_'))
      ? 'stale_source'
      : legacyUnknown ? 'legacy_unknown'
        : staleReasons.includes('pipeline_hash_changed') ? 'stale_pipeline' : 'fresh',
    staleReasons: legacyUnknown ? [...staleReasons, 'legacy_hash_unknown'] : staleReasons,
  };
}

function versionedTranslationState(entry, viewer = null, { assetId = '', job = null } = {}) {
  const exactAssetId = String(assetId || '').trim();
  const resolvedAsset = exactAssetId
    ? store.resolveTranslationVersionAsset(entry.id, exactAssetId)
    : null;
  const version = resolvedAsset && resolvedAsset.version
    || (!exactAssetId ? store.getCurrentTranslationVersion(entry.id) : null);
  if (!version) return legacyTranslationState(entry, viewer, job, exactAssetId);
  const document = store.getArticleDocument(version.documentId);
  const currentDocument = store.getCurrentArticleDocument(entry.id);
  if (!document || !currentDocument) {
    const error = new Error('versioned translation document is unavailable');
    error.code = 'ERR_TRANSLATION_DOCUMENT_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }
  const freshness = translationVersionFreshness(version, currentDocument);
  const publicAssetId = resolvedAsset && resolvedAsset.stable
    ? resolvedAsset.assetId
    : (!exactAssetId && version.ownerType === 'user'
      ? store.getTranslationAssetIdForVersion(version.id)
      : '') || version.id;
  const reaction = store.getEntryAssetReaction(entry.id, 'translation', viewer, publicAssetId);
  if (version.schemaVersion === 1) {
    if (!Array.isArray(version.content)) {
      const error = new Error('legacy translation version content is invalid');
      error.code = 'ERR_TRANSLATION_VERSION_INVALID';
      error.statusCode = 409;
      throw error;
    }
    return {
      translation: {
        id: publicAssetId,
        entryId: version.entryId,
        contributorId: version.userId || '',
        contributorName: version.userId ? version.author : '',
        titleZh: version.titleZh,
        summaryZh: version.summaryZh,
        content: version.content,
        model: version.model,
        provider: version.provider,
        createdBy: version.author,
        contentHash: version.sourceHash,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
        ...reaction,
        stale: freshness.status === 'stale_source',
      },
      schemaVersion: version.schemaVersion,
      documentId: version.documentId,
      versionId: version.id,
      ...freshness,
      job: publicTranslationJob(job),
      renderedHtml: null,
    };
  }
  if (version.schemaVersion !== 2) {
    const error = new Error(`unsupported translation schema version ${version.schemaVersion}`);
    error.code = 'ERR_TRANSLATION_VERSION_UNSUPPORTED';
    error.statusCode = 409;
    throw error;
  }
  const translations = version.content && Array.isArray(version.content.translations)
    ? version.content.translations
    : [];
  const segmentMap = Object.fromEntries(translations.map(item => [item.id, item.target]));
  const rendered = renderTranslation(document, segmentMap);
  const input = buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: articleDocumentSegments(document.ast),
  });
  const sources = new Map(input.segments.map(segment => [segment.id, segment.text]));
  return {
    translation: {
      id: publicAssetId,
      entryId: version.entryId,
      contributorId: version.userId || '',
      contributorName: version.userId ? version.author : '',
      titleZh: version.titleZh,
      summaryZh: version.summaryZh,
      content: translations.map(item => ({
        segmentId: item.id,
        source: sources.get(item.id) || '',
        target: item.target,
      })),
      model: version.model,
      provider: version.provider,
      createdBy: version.author,
      contentHash: version.sourceHash,
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
      ...reaction,
      stale: freshness.status === 'stale_source',
    },
    schemaVersion: version.schemaVersion,
    documentId: version.documentId,
    versionId: version.id,
    ...freshness,
    job: publicTranslationJob(job),
    renderedHtml: rendered.renderedHtml,
  };
}

module.exports = {
  currentTranslationJob,
  legacyTranslationState,
  publicTranslationJob,
  translationResponse,
  versionedTranslationState,
};
