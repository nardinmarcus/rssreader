#!/usr/bin/env node

const store = require('../lib/store');

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (store.periodicals.mode === 'off') {
    return;
  }
  const singleRound = process.argv.includes('--once');
  while (!stopping) {
    const result = await store.periodicals.runNextBuild();
    if (!result) {
      const wakeAt = store.periodicals.getNextBuildWakeAt();
      if (wakeAt === null) {
        return;
      }
      await delay(Math.max(25, Math.min(1000, wakeAt - Date.now())));
      continue;
    }
    if (singleRound) return;
  }
}

main().catch(() => {
  console.error('[periodical-build] issue=- job=- source=- input=- revision=0 candidates=0 events=0 state=worker_failed durationMs=0');
  process.exitCode = 1;
});
