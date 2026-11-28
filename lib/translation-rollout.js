const MODES = new Set(['off', 'shadow', 'all']);

function mode() {
  const value = String(process.env.VERSIONED_TRANSLATION_MODE || 'off').trim().toLowerCase();
  return MODES.has(value) ? value : 'off';
}

function writesVersionedDocuments() {
  return mode() !== 'off';
}

function hasBrowserKey(req) {
  if (!req || typeof req.get !== 'function') return false;
  return Boolean(String(req.get('x-ai-key') || '').trim());
}

function autoQueuesSystemTranslation() {
  return mode() === 'all';
}

function usesV2Translation(req) {
  return !hasBrowserKey(req) && mode() === 'all';
}

module.exports = {
  autoQueuesSystemTranslation,
  mode,
  usesV2Translation,
  writesVersionedDocuments,
};
