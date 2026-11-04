// The single heavy-work slot (Task 11).
//
// One process-wide decision — is a heavy operation running or not — lives here,
// so 故障排查 (card `start` → repo sync + model analysis) and 需求拆分 (document
// read, model decomposition, TAPD story writes) cannot run two heavy operations
// at once. Nothing else may keep a second busy flag: `isBusy()` and `whenIdle()`
// read the very same record that `tryStart` writes.
//
// Contract, fixed by the callers that already exist:
//   - `tryStart(owner, work)` returns *synchronously*, either `{accepted:false}`
//     or `{accepted:true, done}`. The reservation is final the moment it returns;
//     `work` itself is entered on the next microtask, so a caller never gets
//     re-entered and a `handleMessage` can resolve while the work has only been
//     reserved (src/requirement-requests.js relies on this).
//   - A rejection of `done` belongs to the caller. It is never swallowed: the
//     extra branch below only stops a forgotten `done` from crashing the process
//     as an unhandled rejection, and `await done` still rejects.
//   - The slot is released in a finally-equivalent on both paths, so a throwing
//     operation cannot leak the reservation forever.
//   - Review drafts are *not* held here: reading a card page is light work, and
//     a long review must never occupy the slot.

export function createWorkSlot({ log = null } = {}) {
  // The one and only busy record. `null` means idle.
  let running = null;
  const idleWaiters = [];

  const describe = (value) => (typeof value === 'string' && value !== '' ? value : 'unknown');

  // A logger is injected for observability only; a broken one must not cost a
  // reservation, and no slot decision depends on it.
  function note(message) {
    const write = log?.warn ?? log?.info;
    if (typeof write !== 'function') return;
    try {
      write.call(log, message);
    } catch {
      // Ignored on purpose: the slot's state is the product, the log is an extra.
    }
  }

  function isBusy() {
    return running !== null;
  }

  function tryStart(owner, work) {
    const who = describe(owner);
    if (typeof work !== 'function') {
      note(`work slot refused ${who}: no work to run`);
      return { accepted: false };
    }
    if (running !== null) {
      // Explicit and immediate: the caller tells the group, and nothing is queued
      // silently behind the running operation.
      note(`work slot busy for ${running.owner}, refused ${who}`);
      return { accepted: false };
    }
    const reservation = { owner: who, done: null };
    running = reservation;

    const done = Promise.resolve().then(work);
    // `done` keeps rejecting for the caller; this branch only marks it observed.
    done.catch(() => {});
    done.then(release, release);
    reservation.done = done;
    note(`work slot held by ${who}`);
    return { accepted: true, done };

    function release() {
      // Only the run that still owns the slot may clear it: a late settle of an
      // old work must not release a newer reservation.
      if (running !== reservation) return;
      running = null;
      const waiters = idleWaiters.splice(0);
      for (const settle of waiters) settle();
    }
  }

  // Resolves when the slot is currently free. Callers that need quiescence (the
  // shutdown path) re-check `isBusy()` and wait again.
  function whenIdle() {
    if (running === null) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  return { tryStart, isBusy, whenIdle };
}
