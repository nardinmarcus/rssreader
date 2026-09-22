const { computeCanonicalHash } = require('./content-hashes');

// Published-revision seam shared by compilation, summary generation,
// storage reads and the shadow verifier's hash check.
//
// The content hash covers every field that changes rendered content or
// evidence interpretation. Observation metadata (the hash itself, input
// identity, build timestamps, selection snapshots) stays out of the hash.
function computeRevisionContentHash({
  issue,
  themes,
  events,
  evidence,
  inputs = [],
}) {
  const {
    contentHash,
    inputHash,
    lastBuiltAt,
    selectionContext,
    sourceInputHash,
    ...semanticIssue
  } = issue;
  return computeCanonicalHash({
    issue: semanticIssue,
    themes,
    events,
    evidence,
    inputs,
  });
}

// A stored finalizing Daily still carries the hash of the open revision it
// published: entering finalization changes workflow state, not published
// content. Rollups never store a finalizing revision beside an older hash,
// so only the Daily workflow state maps back.
function revisionHashDocument(document) {
  const issue = document && document.issue;
  if (!issue || issue.cadence !== 'daily' || issue.status !== 'finalizing') {
    return document;
  }
  return { ...document, issue: { ...issue, status: 'open' } };
}

// Hash of the published revision exactly as stored, applying the projection
// that production and verification share.
function revisionContentHash(document) {
  return computeRevisionContentHash(revisionHashDocument(document));
}

// Seal published content after an expression replacement: recompute the
// content hash once over the current revision.
function sealRevisionContentHash(revision) {
  return {
    ...revision,
    issue: {
      ...revision.issue,
      contentHash: computeRevisionContentHash(revision),
    },
  };
}

// Finalizing-to-frozen publish transition: advance the workflow state, then
// seal the frozen revision exactly once.
function freezeCompiledIssue(compiled, frozenAt) {
  return sealRevisionContentHash({
    ...compiled,
    issue: {
      ...compiled.issue,
      status: 'frozen',
      frozenAt,
    },
  });
}

module.exports = {
  computeRevisionContentHash,
  freezeCompiledIssue,
  revisionContentHash,
  revisionHashDocument,
  sealRevisionContentHash,
};
