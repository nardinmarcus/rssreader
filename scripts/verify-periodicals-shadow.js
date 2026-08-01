#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataPaths } = require('../lib/data-paths');

function cliError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  const options = {
    databaseCopy: null,
    confirmReadOnlyCopy: false,
    receiptFile: null,
    requireClean: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database-copy') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw cliError('ERR_PERIODICAL_DATABASE_COPY_REQUIRED');
      }
      options.databaseCopy = value;
      index += 1;
    } else if (argument === '--confirm-read-only-copy') {
      options.confirmReadOnlyCopy = true;
    } else if (argument === '--receipt') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw cliError('ERR_PERIODICAL_RECEIPT_PATH_REQUIRED');
      }
      options.receiptFile = value;
      index += 1;
    } else if (argument === '--require-clean') {
      options.requireClean = true;
    } else {
      throw cliError('ERR_PERIODICAL_VERIFICATION_ARGUMENT');
    }
  }
  if (!options.databaseCopy) throw cliError('ERR_PERIODICAL_DATABASE_COPY_REQUIRED');
  if (!options.confirmReadOnlyCopy) {
    throw cliError('ERR_PERIODICAL_COPY_CONFIRMATION_REQUIRED');
  }
  return options;
}

function realPathIfPresent(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function candidateIdentity() {
  const cwd = path.resolve(__dirname, '..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() !== '';
  return { head, tree, clean: !dirty };
}

function sameCandidateIdentity(left, right) {
  return Boolean(left && right)
    && left.clean === true
    && right.clean === true
    && left.head === right.head
    && left.tree === right.tree;
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const projectDir = path.resolve(__dirname, '..');
  const databaseFile = realPathIfPresent(options.databaseCopy);
  const activeDatabaseFile = realPathIfPresent(resolveDataPaths().databaseFile);
  if (databaseFile === activeDatabaseFile) {
    throw cliError('ERR_PERIODICAL_LIVE_DATABASE_REFUSED');
  }
  const receiptFile = options.receiptFile ? path.resolve(options.receiptFile) : null;
  if (receiptFile && pathIsInside(projectDir, receiptFile)) {
    throw cliError('ERR_PERIODICAL_RECEIPT_INSIDE_WORKTREE');
  }

  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  const candidateStart = candidateIdentity();
  if (!candidateStart.clean) {
    throw cliError('ERR_PERIODICAL_CANDIDATE_DIRTY');
  }
  const verification = await verifyDatabaseCopy(databaseFile);
  const candidateEnd = candidateIdentity();
  if (!sameCandidateIdentity(candidateStart, candidateEnd)) {
    throw cliError('ERR_PERIODICAL_CANDIDATE_CHANGED');
  }
  const receipt = {
    ...verification,
    candidate: candidateEnd,
  };
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptFile) {
    fs.writeFileSync(receiptFile, output, { encoding: 'utf8', flag: 'wx' });
  }
  const candidateFinal = candidateIdentity();
  if (!sameCandidateIdentity(candidateStart, candidateFinal)) {
    if (receiptFile) fs.unlinkSync(receiptFile);
    throw cliError('ERR_PERIODICAL_CANDIDATE_CHANGED');
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main().catch(error => {
    const code = String(error && error.code || 'ERR_PERIODICAL_VERIFICATION');
    const errorCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'ERR_PERIODICAL_VERIFICATION';
    process.stderr.write(`${JSON.stringify({ passed: false, errorCode })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, sameCandidateIdentity };
