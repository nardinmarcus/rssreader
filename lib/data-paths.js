const path = require('path');

const DATABASE_FILENAME = 'qmreader.sqlite';

function resolveDataDir(env = process.env) {
  const configured = String(env && env.NAMOO_READER_DATA_DIR || '').trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(__dirname, '..', 'data');
}

function resolveDataPaths(env = process.env) {
  const dataDir = resolveDataDir(env);
  return {
    dataDir,
    databaseFile: path.join(dataDir, DATABASE_FILENAME),
  };
}

module.exports = {
  DATABASE_FILENAME,
  resolveDataDir,
  resolveDataPaths,
};
