const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The budget ran out. Its own class so a caller can tell "the wait ran out of time" from "the wait itself broke"
 * (a transport or TLS error out of `fn`), which mean different things about what is at fault. The message is
 * unchanged from before this class existed.
 */
export class PollTimeout extends Error {}

/**
 * Call `fn` until it returns a non-undefined value, or time runs out. An error out of `fn` is NOT caught here: a
 * caller that wants to ride out a transient failure has to catch it inside its own `fn` and return undefined (see
 * `waitForJob` in ../suite/cases.mjs).
 * @template T
 * @param {() => Promise<T | undefined>} fn
 * @param {{ timeoutMs: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number, what?: string }} opts
 * @returns {Promise<T>}
 */
export async function poll(fn, { timeoutMs, intervalMs = 2_000, sleep = realSleep, now = Date.now, what = 'condition' }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (now() >= deadline) throw new PollTimeout(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}
