#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

function loadCandidateModules() {
  const { resolveDataPaths } = require('../lib/data-paths');
  const { verifyDatabaseCopy } = require('../lib/periodicals-verification');
  return { resolveDataPaths, verifyDatabaseCopy };
}

async function runCandidateVerification({
  databaseFile,
  getCandidateIdentity = candidateIdentity,
  loadCandidateModules: loadModules = loadCandidateModules,
  verifyDatabaseCopy: verifyOverride = null,
}) {
  const candidateStart = getCandidateIdentity();
  if (!candidateStart.clean) throw cliError('ERR_PERIODICAL_CANDIDATE_DIRTY');

  const modules = loadModules();
  const candidateAfterLoad = getCandidateIdentity();
  if (!sameCandidateIdentity(candidateStart, candidateAfterLoad)) {
    throw cliError('ERR_PERIODICAL_CANDIDATE_CHANGED');
  }

  const activeDatabaseFile = realPathIfPresent(modules.resolveDataPaths().databaseFile);
  if (databaseFile === activeDatabaseFile) {
    throw cliError('ERR_PERIODICAL_LIVE_DATABASE_REFUSED');
  }
  const verifyDatabaseCopy = verifyOverride || modules.verifyDatabaseCopy;
  const verification = await verifyDatabaseCopy(databaseFile);
  const candidateEnd = getCandidateIdentity();
  if (!sameCandidateIdentity(candidateStart, candidateEnd)) {
    throw cliError('ERR_PERIODICAL_CANDIDATE_CHANGED');
  }
  return { candidateStart, candidateEnd, verification };
}

function publishReceiptAfterBarrier({ receiptFile, output, finalBarrier }) {
  const directory = path.dirname(receiptFile);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(receiptFile)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor = null;
  let temporaryPresent = false;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    temporaryPresent = true;
    fs.writeFileSync(descriptor, output, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    finalBarrier();
    fs.linkSync(temporaryFile, receiptFile);
    fs.unlinkSync(temporaryFile);
    temporaryPresent = false;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (temporaryPresent) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const projectDir = path.resolve(__dirname, '..');
  const databaseFile = realPathIfPresent(options.databaseCopy);
  const receiptFile = options.receiptFile ? path.resolve(options.receiptFile) : null;
  if (receiptFile && pathIsInside(projectDir, receiptFile)) {
    throw cliError('ERR_PERIODICAL_RECEIPT_INSIDE_WORKTREE');
  }

  const { candidateStart, candidateEnd, verification } = await runCandidateVerification({
    databaseFile,
  });
  const receipt = {
    ...verification,
    candidate: candidateEnd,
  };
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  const finalBarrier = () => {
    const candidateFinal = candidateIdentity();
    if (!sameCandidateIdentity(candidateStart, candidateFinal)) {
      throw cliError('ERR_PERIODICAL_CANDIDATE_CHANGED');
    }
  };
  if (receiptFile) {
    publishReceiptAfterBarrier({ receiptFile, output, finalBarrier });
  } else finalBarrier();
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

module.exports = {
  main,
  parseArgs,
  publishReceiptAfterBarrier,
  runCandidateVerification,
  sameCandidateIdentity,
};
