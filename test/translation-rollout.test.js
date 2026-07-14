const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rollout = require('../lib/translation-rollout');

function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('unconfigured rollout mode defaults to off', () => {
  withEnv({ VERSIONED_TRANSLATION_MODE: undefined }, () => {
    assert.equal(rollout.mode(), 'off');
    assert.equal(rollout.writesVersionedDocuments(), false);
    assert.equal(rollout.autoQueuesSystemTranslation({ id: 'entry-one' }), false);
    assert.equal(rollout.usesV2Translation(request({ role: 'admin' }), { id: 'entry-one' }), false);
  });
});

function request({ role = '', headers = {} } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    user: role ? { role } : null,
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
  };
}

test('unknown modes fail closed instead of enabling the rollout', () => {
  withEnv({ VERSIONED_TRANSLATION_MODE: 'unexpected' }, () => {
    assert.equal(rollout.mode(), 'off');
  });
});

test('shadow writes versioned documents without selecting V2 translation', () => {
  withEnv({ VERSIONED_TRANSLATION_MODE: 'shadow' }, () => {
    assert.equal(rollout.writesVersionedDocuments(), true);
    assert.equal(rollout.autoQueuesSystemTranslation({ id: 'entry-one' }), false);
    assert.equal(rollout.usesV2Translation(request({ role: 'admin' }), { id: 'entry-one' }), false);
  });
});

test('canary selects V2 only for administrators or allowlisted entries', () => {
  withEnv({
    VERSIONED_TRANSLATION_MODE: 'canary',
    VERSIONED_TRANSLATION_CANARY_ENTRY_IDS: 'entry-one, entry-two',
  }, () => {
    assert.equal(rollout.usesV2Translation(request(), { id: 'entry-three' }), false);
    assert.equal(rollout.usesV2Translation(request({ role: 'admin' }), { id: 'entry-three' }), true);
    assert.equal(rollout.usesV2Translation(request(), { id: 'entry-two' }), true);
    assert.equal(rollout.autoQueuesSystemTranslation({ id: 'entry-three' }), false);
    assert.equal(rollout.autoQueuesSystemTranslation({ id: 'entry-two' }), true);
  });
});

test('all selects V2 site AI while every BYOK request stays on the legacy path', () => {
  withEnv({ VERSIONED_TRANSLATION_MODE: 'all' }, () => {
    assert.equal(rollout.usesV2Translation(request(), { id: 'entry-one' }), true);
    assert.equal(rollout.autoQueuesSystemTranslation({ id: 'entry-one' }), true);
    assert.equal(rollout.usesV2Translation(request({
      role: 'admin',
      headers: { 'x-ai-key': 'browser-owned-key' },
    }), { id: 'entry-one' }), false);
    assert.equal(rollout.usesV2Translation(request({
      headers: { 'x-deepseek-key': 'legacy-browser-key' },
    }), { id: 'entry-one' }), false);
  });
});

test('rollout module exposes only the approved seam', () => {
  assert.deepEqual(Object.keys(rollout).sort(), [
    'autoQueuesSystemTranslation',
    'mode',
    'usesV2Translation',
    'writesVersionedDocuments',
  ]);
});

test('example environment keeps the rollout off with an empty canary allowlist', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(example, /^VERSIONED_TRANSLATION_MODE=off$/m);
  assert.match(example, /^VERSIONED_TRANSLATION_CANARY_ENTRY_IDS=$/m);
});
