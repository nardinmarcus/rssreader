// Parent-process recovery only. Durable task execution and leases stay in SQLite.
function createWorkerRecovery(policy, clock = { setTimeout, clearTimeout }) {
  let active = null;
  let timer = null;
  let attempts = 0;

  function workRemains() {
    try {
      return policy.hasWork();
    } catch (error) {
      policy.checkFailed?.(error);
      return true;
    }
  }

  function schedule() {
    if (active || timer) return;
    const delay = Math.min(5000, 250 * (2 ** Math.min(attempts, 8)));
    attempts += 1;
    timer = clock.setTimeout(() => {
      timer = null;
      if (workRemains()) wake();
      else attempts = 0;
    }, delay);
  }

  function wake() {
    if (!policy.enabled() || active) return false;
    if (timer) {
      clock.clearTimeout(timer);
      timer = null;
    }
    const child = policy.start();
    active = child;
    child.stdout.on('data', chunk => {
      if (active !== child) return;
      // Any current stdout is progress, even when its logging policy filters it.
      attempts = 0;
      policy.stdout(chunk);
    });
    if (child.stderr && policy.stderr) {
      child.stderr.on('data', chunk => {
        if (active === child) policy.stderr(chunk);
      });
    }
    const finish = (code, error = null) => {
      if (active !== child) return;
      active = null;
      policy.failed(code, error);
      if (workRemains()) schedule();
      else attempts = 0;
    };
    child.on('error', error => finish(1, error));
    child.on('exit', code => finish(code));
    return true;
  }

  return { wake, wakeIfNeeded: () => policy.hasWork() ? wake() : false };
}

module.exports = { createWorkerRecovery };
