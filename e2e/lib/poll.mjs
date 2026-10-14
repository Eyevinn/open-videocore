const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call `fn` until it returns a non-undefined value, or time runs out.
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
    if (now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}
