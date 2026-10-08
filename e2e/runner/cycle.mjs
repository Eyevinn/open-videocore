// One runner cycle (ADR-007 §2). Pure orchestration over injected adapters so every branch is testable
// offline. Result statuses: green | red | stale | infra-error. The runner never promotes anything.
//
// Results are keyed by the COMMIT the tested image was built from, read from the `:latest` image's label
// io.osaas.repo.commit in the registry. GET /health cannot supply it: the platform builds the image without git
// metadata, so build.commit and build.sourceDigest are "unknown" (verified on a live beta instance). The label is read
// before the instance is restarted and again once it is ready; if :latest moved in between, the pod may have pulled a
// different image, so the result is `stale`. The promote workflow reads the same label from the image it retags.
import { poll } from '../lib/poll.mjs';
import { redact } from '../lib/redact.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} Deps
 * @property {{ latest(): Promise<{ digest: string, commit: string }> }} registry   what `:latest` points at and the commit it was built from
 * @property {{ ensureFresh(): Promise<{ baseUrl: string, token: string }> }} instance   create-or-restart the beta-based instance
 * @property {(inst: { baseUrl: string, token: string }, expected: { commit: string }) => Promise<any>} runSuite
 * @property {(inst: { baseUrl: string, token: string }) => Promise<{ commit?: string, sourceDigest?: string, version?: string } | undefined>} health   GET /health build info, undefined if not up
 * @property {{ get(commit: string): Promise<any>, put(commit: string, record: any): Promise<void> }} store
 * @property {(inst: { baseUrl: string, token: string }) => Promise<any>} [prepare]   make the instance ready for the suite (provision its stack); a failure is infra-error
 * @property {string[]} [secrets]    exact values to mask in anything stored or printed
 * @property {{ waitMs?: number, pollMs?: number, retries?: number, backoffMs?: number }} [opts]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {() => string} [clock]  ISO timestamp
 */

/** @param {Deps} d */
export async function runCycle(d) {
  const { registry, instance, store } = d;
  const o = { waitMs: 15 * 60_000, pollMs: 10_000, retries: 2, backoffMs: 30_000, ...d.opts };
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const clock = d.clock ?? (() => new Date().toISOString());
  const clean = (v) => redact(v, d.secrets).slice(0, 300);

  const before = await registry.latest(); // a registry failure aborts the cycle: without a commit there is no key
  const head = before.commit;
  const expected = { commit: head };

  // Only a green or red result is final. stale and infra-error say nothing about the image, so the next
  // cycle must try the same commit again; treating them as done would leave it untested forever.
  const prior = await store.get(head);
  if (prior && (prior.status === 'green' || prior.status === 'red')) {
    return { action: 'skip', reason: 'already tested', commit: head, status: prior.status };
  }

  const startedAt = clock();
  const finish = async (record) => {
    const full = { commit: head, startedAt, finishedAt: clock(), ...record };
    await store.put(head, full);
    return { action: 'recorded', ...full };
  };

  // Create or restart, up to `retries` extra attempts. A third failure is infra-error, not red.
  let inst; let lastErr;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try { inst = await instance.ensureFresh(); break; } catch (e) {
      lastErr = e;
      if (attempt < o.retries) await sleep(o.backoffMs * (attempt + 1));
    }
  }
  if (!inst) return finish({ status: 'infra-error', suiteVersion: null, cases: [], detail: clean(`instance create/restart failed: ${lastErr?.message ?? lastErr}`) });

  // /health only tells us the instance is up (it cannot identify the build, see the header). Wait for it.
  let build;
  try {
    build = await poll(async () => (await d.health(inst)) ?? undefined,
      { timeoutMs: o.waitMs, intervalMs: o.pollMs, sleep, now, what: 'the instance to answer GET /health' });
  } catch (e) {
    return finish({ status: 'stale', suiteVersion: null, cases: [], detail: clean(e.message) });
  }

  // :latest must not have moved since we read it, or the pod may be running a different image from the one we keyed.
  const ready = await registry.latest();
  if (ready.digest !== before.digest) {
    return finish({ status: 'stale', suiteVersion: null, cases: [], detail: clean(`:latest moved from ${before.digest} to ${ready.digest} while the instance restarted`) });
  }

  if (d.prepare) {
    try { await d.prepare(inst); } catch (e) {
      return finish({ status: 'infra-error', suiteVersion: null, cases: [], detail: clean(`preparing the instance failed: ${e?.message ?? e}`) });
    }
  }

  let suite;
  try { suite = await d.runSuite(inst, expected); } catch (e) {
    return finish({ status: 'infra-error', suiteVersion: null, cases: [], detail: clean(`suite crashed: ${e?.message ?? e}`) });
  }

  return finish({
    status: suite.status, // green | red
    suiteVersion: suite.suiteVersion,
    imageDigest: before.digest,
    version: build?.version ?? suite.build?.version,
    cases: suite.cases,
    swept: suite.swept,
  });
}
