#!/usr/bin/env node

const jobs = require('../lib/translation-jobs');
const store = require('../lib/store');

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const singleRound = process.argv.includes('--once');
  while (!stopping) {
    const result = await jobs.runNext();
    if (!result) {
      const wakeAt = store.getNextTranslationJobWakeAt();
      if (wakeAt === null) {
        console.log('translation worker: queue empty');
        return;
      }
      await delay(Math.max(25, Math.min(1000, wakeAt - Date.now())));
      continue;
    }
    console.log(`translation worker: ${result.id} ${result.status}`);
    if (singleRound) return;
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
