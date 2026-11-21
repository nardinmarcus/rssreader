#!/usr/bin/env node

const backfill = require('../lib/source-backfill');
const store = require('../lib/store');

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function batchYieldMs() {
  const configured = Number(process.env.SOURCE_BACKFILL_BATCH_DELAY_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 25;
}

function send(message) {
  if (typeof process.send === 'function') {
    try { process.send(message); } catch { /* IPC channel closed */ }
  }
}

function safeLogLine(result) {
  const source = String(result && result.sourceId || '-').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const run = String(result && result.id || '-').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const status = String(result && result.status || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
  const processed = Number(result && result.processedCount) || 0;
  const total = Number(result && result.totalCount) || 0;
  const inserted = Number(result && result.insertedCount) || 0;
  const reused = Number(result && result.reusedCount) || 0;
  return `[source-backfill] source=${source} run=${run} status=${status} processed=${processed} total=${total} inserted=${inserted} reused=${reused}`;
}

async function main() {
  const singleRound = process.argv.includes('--once');
  const yieldMs = batchYieldMs();
  while (!stopping) {
    const result = await backfill.runNext({
      onBatchProgress(committed) {
        if (!committed || !committed.run) return;
        send({
          type: 'backfillProgress',
          sourceId: committed.run.sourceId,
          runId: committed.run.id,
          status: committed.run.status,
          processedCount: committed.run.processedCount,
          totalCount: committed.run.totalCount,
          insertedCount: committed.run.insertedCount,
          reusedCount: committed.run.reusedCount,
        });
      },
    });
    if (!result) {
      const wakeAt = store.sourceBackfill.getNextWakeAt();
      if (wakeAt === null) {
        return;
      }
      await delay(Math.max(20, Math.min(1000, wakeAt - Date.now())));
      continue;
    }
    console.log(safeLogLine(result));
    if (singleRound) return;
    if (yieldMs > 0) await delay(yieldMs);
  }
}

main().catch(error => {
  const code = String(error && error.code || 'ERR_BACKFILL_WORKER').replace(/[^a-zA-Z0-9_-]/g, '-');
  console.error(`[source-backfill] state=worker_failed code=${code}`);
  process.exitCode = 1;
});
