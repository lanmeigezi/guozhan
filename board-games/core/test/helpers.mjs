// helpers.mjs — shared test utilities.
//
// Transports here are asynchronous (a byte written now surfaces on the other
// side a tick later), so tests must wait for a *condition* rather than sleep a
// fixed number of milliseconds — a fixed sleep is a flaky test on a busy machine.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `predicate` until it is truthy, or throw after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try { value = predicate(); } catch (_) { value = false; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    await sleep(intervalMs);
  }
}
