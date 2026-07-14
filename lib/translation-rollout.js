const MODES = new Set(['off', 'shadow', 'canary', 'all']);

function mode() {
  const value = String(process.env.VERSIONED_TRANSLATION_MODE || 'off').trim().toLowerCase();
  return MODES.has(value) ? value : 'off';
}

function writesVersionedDocuments() {
  return mode() !== 'off';
}

function hasBrowserKey(req) {
  if (!req || typeof req.get !== 'function') return false;
  return Boolean(String(req.get('x-ai-key') || req.get('x-deepseek-key') || '').trim());
}

function canaryEntryIds() {
  return new Set(String(process.env.VERSIONED_TRANSLATION_CANARY_ENTRY_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean));
}

function autoQueuesSystemTranslation(entry) {
  const currentMode = mode();
  if (currentMode === 'all') return true;
  if (currentMode !== 'canary') return false;
  return Boolean(entry && entry.id && canaryEntryIds().has(String(entry.id)));
}

function usesV2Translation(req, entry) {
  if (hasBrowserKey(req)) return false;
  const currentMode = mode();
  if (currentMode === 'all') return true;
  if (currentMode !== 'canary') return false;
  if (req && req.user && req.user.role === 'admin') return true;
  return Boolean(entry && entry.id && canaryEntryIds().has(String(entry.id)));
}

module.exports = {
  autoQueuesSystemTranslation,
  mode,
  usesV2Translation,
  writesVersionedDocuments,
};
