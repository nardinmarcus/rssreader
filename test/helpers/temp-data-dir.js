const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempDataDir(prefix = 'namoo-reader-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { createTempDataDir };
