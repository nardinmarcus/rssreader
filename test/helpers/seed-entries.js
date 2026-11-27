const { execFileSync } = require('child_process');
const path = require('path');

const storePath = path.join(__dirname, '..', '..', 'lib', 'store.js');

// Startup no longer copies cache.json entries into SQLite, so server fixtures
// seed articles through the authoritative store in a separate process.
function seedEntries(dataDir, entries) {
  execFileSync(process.execPath, ['-e', `
    const fs = require('fs');
    const store = require(${JSON.stringify(storePath)});
    store.upsertEntries(JSON.parse(fs.readFileSync(0, 'utf8')));
  `], {
    env: { ...process.env, NAMOO_READER_DATA_DIR: dataDir, PERIODICALS_MODE: 'off' },
    input: JSON.stringify(entries),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function seedCacheFixture(dataDir, cache) {
  const fs = require('fs');
  fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify(cache));
  const entries = Object.values(cache).flatMap(source => (source && Array.isArray(source.entries) ? source.entries : []));
  if (entries.length) seedEntries(dataDir, entries);
}

module.exports = { seedCacheFixture, seedEntries };
