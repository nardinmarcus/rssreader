const crypto = require('crypto');
const {
  ONEPAGE_SCHEMA_VERSION,
  normalizeOnepagePayload,
  renderOnepageHtml,
} = require('./onepage-contract');

const ONEPAGE_PIPELINE_VERSION = 'onepage-pipeline-v1';
const ONEPAGE_PROMPT_VERSION = 'onepage-prompt-v1';

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createOnepageModule({ store, generatePayload }) {
  if (!store) throw new TypeError('store is required');
  if (typeof generatePayload !== 'function') throw new TypeError('generatePayload is required');

  const pipelineHash = store.hashText([
    ONEPAGE_PIPELINE_VERSION,
    ONEPAGE_PROMPT_VERSION,
    `schema-${ONEPAGE_SCHEMA_VERSION}`,
  ].join('\n'));

  function hydrate(onepage) {
    if (!onepage) return null;
    const entry = store.getEntry(onepage.entryId);
    if (!entry) return null;
    const pinnedDocument = store.getArticleDocument(onepage.documentId);
    const currentDocument = store.getCurrentArticleDocument(onepage.entryId);
    const staleReasons = [];
    if (!currentDocument || currentDocument.id !== onepage.documentId) {
      staleReasons.push('source_document_changed');
    }
    if (!currentDocument || currentDocument.sourceHash !== onepage.sourceHash) {
      staleReasons.push('source_hash_changed');
    }
    return {
      ...onepage,
      stale: staleReasons.length > 0,
      staleReasons,
      html: renderOnepageHtml(onepage.payload, { entry, document: pinnedDocument }),
    };
  }

  function canRead(onepage, viewer) {
    if (!onepage) return false;
    if (onepage.visibility === 'public') return true;
    return Boolean(viewer && (viewer.id === onepage.userId || viewer.role === 'admin'));
  }

  async function generateOnepage(entry, { viewer, force = false, aiConfig = {} } = {}) {
    if (!viewer || !viewer.id) throw requestError('login required', 401);
    const authoritativeEntry = store.getEntry(entry && entry.id);
    if (!authoritativeEntry) throw requestError('entry not found', 404);
    const document = store.getCurrentArticleDocument(authoritativeEntry.id);
    if (!document) throw requestError('article document is not ready', 409);

    if (!force) {
      const cached = store.getCachedOnepageVersion({
        entryId: authoritativeEntry.id,
        documentId: document.id,
        userId: viewer.id,
        pipelineHash,
      });
      if (cached) return { cached: true, onepage: hydrate(cached) };
    }

    const result = await generatePayload({ entry: authoritativeEntry, document, aiConfig });
    const payload = normalizeOnepagePayload(result && result.payload, document);
    const id = crypto.randomUUID();
    const provider = String(result && result.provider || '').trim();
    const model = String(result && result.model || '').trim();
    if (!provider || !model) throw requestError('onepage provider metadata is incomplete', 502);
    const baseGenerationHash = store.hashText([
      document.id,
      document.sourceHash,
      pipelineHash,
      viewer.id,
      provider,
      model,
    ].join('\n'));
    const saved = store.insertOnepageVersion({
      id,
      entryId: authoritativeEntry.id,
      documentId: document.id,
      userId: viewer.id,
      author: viewer.displayName || viewer.email || 'Reader',
      sourceHash: document.sourceHash,
      pipelineHash,
      promptVersion: ONEPAGE_PROMPT_VERSION,
      generationHash: force ? store.hashText(`${baseGenerationHash}\n${id}`) : baseGenerationHash,
      schemaVersion: ONEPAGE_SCHEMA_VERSION,
      title: payload.title,
      previewText: payload.thesis.text,
      payload,
      provider,
      model,
      createdAt: Date.now(),
    });
    return { cached: saved.id !== id, onepage: hydrate(saved) };
  }

  function getOnepage(onepageId, { viewer } = {}) {
    const onepage = store.getOnepageVersion(onepageId);
    return canRead(onepage, viewer) ? hydrate(onepage) : null;
  }

  function getLatestOnepage(entryId, { viewer } = {}) {
    return hydrate(store.getLatestOnepageForEntry(entryId, { userId: viewer && viewer.id }));
  }

  function publishOnepage(onepageId, { viewer } = {}) {
    return hydrate(store.publishOnepageVersion(onepageId, { viewer }));
  }

  return {
    generateOnepage,
    getLatestOnepage,
    getOnepage,
    publishOnepage,
  };
}

module.exports = {
  ONEPAGE_PIPELINE_VERSION,
  ONEPAGE_PROMPT_VERSION,
  createOnepageModule,
};
