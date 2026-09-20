const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerRecovery } = require('../lib/worker-recovery');

function fixture() {
  const children = [], timers = new Map(), output = [], failures = [], checks = [];
  let remaining = true, enabled = true, checkError = null;
  const recovery = createWorkerRecovery({
    enabled: () => enabled,
    hasWork() { if (checkError) throw checkError; return remaining; },
    start() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      children.push(child); return child;
    },
    stdout: chunk => output.push(String(chunk)), stderr: chunk => output.push(String(chunk)),
    failed: (code, error) => failures.push({ code, error }),
    checkFailed: error => checks.push(error.message),
  }, {
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.set(timer, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  return { recovery, children, timers, output, failures, checks,
    remaining: value => { remaining = value; }, enabled: value => { enabled = value; },
    checkError: value => { checkError = value; },
    tick() { const timer = [...timers.values()][0]; assert.ok(timer); timers.delete(timer); timer.fn(); },
    delay: () => [...timers.values()][0]?.delay,
  };
}

test('worker crash deduplicates error and exit, cancels pending restart on explicit wake, and ignores old child events', () => {
  const f = fixture();
  assert.equal(f.recovery.wake(), true);
  assert.equal(f.recovery.wake(), false);
  const old = f.children[0];
  old.emit('error', new Error('crashed'));
  old.emit('exit', 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.delay(), 250);
  f.recovery.wake();
  assert.equal(f.timers.size, 0);
  old.stdout.emit('data', 'late output');
  old.emit('exit', 0);
  assert.deepEqual(f.output, []);
  assert.equal(f.children.length, 2);
  f.children[1].emit('exit', 1);
  assert.equal(f.delay(), 500);
});

test('worker restart is capped, current stdout resets backoff, and no remaining durable work stops recovery', () => {
  const f = fixture();
  f.recovery.wake();
  const delays = [];
  for (let index = 0; index < 8; index += 1) {
    f.children.at(-1).emit('exit', 1);
    delays.push(f.delay());
    f.tick();
  }
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  f.children.at(-1).stdout.emit('data', 'progress');
  f.children.at(-1).emit('exit', 0);
  assert.equal(f.delay(), 250);
  f.remaining(false);
  f.tick();
  assert.equal(f.children.length, 9);
  assert.equal(f.timers.size, 0);
  assert.equal(f.recovery.wakeIfNeeded(), false);
});

test('failed durable rechecks retain recovery, and disabled workers do not start', () => {
  const f = fixture();
  f.enabled(false);
  assert.equal(f.recovery.wake(), false);
  f.enabled(true);
  f.recovery.wake();
  f.checkError(new Error('check failed'));
  f.children[0].emit('exit', 1);
  f.tick();
  assert.deepEqual(f.checks, ['check failed', 'check failed']);
  assert.equal(f.children.length, 2);
});

test('real server parent bindings preserve periodical log privacy and translation diagnostics', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const start = source.indexOf('const translationRecovery =');
  assert.notEqual(start, -1, 'server must use shared parent recovery');
  const children = [], logs = [], warnings = [], forkOptions = [];
  const context = {
    createWorkerRecovery, __dirname: '/isolated', process: { env: {} },
    TRANSLATION_WORKER_PATH: 'translation', PERIODICAL_WORKER_PATH: 'periodical',
    store: { hasActiveTranslationJobs: () => false, periodicals: { mode: 'on', hasActiveBuildJobs: () => false } },
    console: { log: value => logs.push(value), warn: value => warnings.push(value) },
    fork(_path, _args, options) {
      forkOptions.push(options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      children.push(child); return child;
    },
  };
  vm.createContext(context);
  const safeLog = source.match(/^const PERIODICAL_WORKER_SAFE_LOG = .*;$/m)[0];
  vm.runInContext(safeLog + '\n' + source.slice(start, source.indexOf('const registerRateLimit', start)), context);
  context.wakePeriodicalWorker();
  children[0].stdout.emit('data', 'private fake payload');
  children[0].stderr.emit('data', 'private fake error');
  const allowed = '[periodical-build] issue=- job=- source=- input=- revision=0 candidates=0 events=0 state=running durationMs=0';
  children[0].stdout.emit('data', allowed);
  children[0].emit('error', new Error('private fake failure'));
  children[0].emit('exit', 1);
  assert.deepEqual(logs, [allowed]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('state=worker_failed'));
  assert.equal(warnings[0].includes('private'), false);
  assert.equal(forkOptions[0].stdio[2], 'ignore');
  context.wakeTranslationWorker();
  children[1].stdout.emit('data', 'translated');
  children[1].stderr.emit('data', 'diagnostic');
  assert.equal(logs.at(-1), '[translation-worker] translated');
  assert.equal(warnings.at(-1), '[translation-worker] diagnostic');
});
