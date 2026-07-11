const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDataDir } = require('./helpers/temp-data-dir');

const dataDir = createTempDataDir();
const stateFile = path.join(dataDir, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({
  'qiaomu-blog': { enabled: false },
}, null, 2));
process.env.NAMOO_READER_DATA_DIR = dataDir;
const fetcher = require('../lib/fetcher');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('legacy state.json enabled overrides migrate into SQLite once', () => {
  fetcher.loadDisk({ upsert: false });
  assert.equal(fetcher.getSourceById('qiaomu-blog').enabled, false);

  fetcher.setEnabled('qiaomu-blog', true);
  assert.equal(fetcher.getSourceById('qiaomu-blog').enabled, true);

  fetcher.loadDisk({ upsert: false });
  assert.equal(fetcher.getSourceById('qiaomu-blog').enabled, true);
});

test('flushDisk does not rewrite legacy state.json', () => {
  const before = fs.readFileSync(stateFile, 'utf8');
  fetcher.flushDisk();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});
