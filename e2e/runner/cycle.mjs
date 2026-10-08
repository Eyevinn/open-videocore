// One runner cycle (ADR-007 §2). Pure orchestration over injected adapters so every branch is testable
// offline. Result statuses: green | red | stale | infra-error. The runner never promotes anything.
//
// Results are keyed by the COMMIT the tested image was built from. The image records it as the label
// io.osaas.repo.commit and the running instance reports it at GET /health build.commit, so a result is bound to
// the image by that commit; the promote workflow reads the label from the :latest image it is about to retag.
import { poll } from '../lib/poll.mjs';
import { redact } from '../lib/redact.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} Deps
 * @property {{ headSha(): Promise<string> }} github                 main's head commit
 * @property {{ ensureFresh(): Promise<{ baseUrl: string, token: string }> }} instance   create-or-restart the beta-based instance
 * @property {(inst: { baseUrl: string, token: string }, expectCommit: string) => Promise<any>} runSuite
 * @property {(baseUrl: string) => Promise<{ commit?: string, sourceDigest?: string, version?: string } | undefined>} health   GET /health build info, undefined if not up
 * @property {{ get(commit: string): Promise<any>, put(commit: string, record: any): Promise<void> }} store
 * @property {string[]} [secrets]    exact values to mask in anything stored or printed
 * @property {{ waitMs?: number, pollMs?: number, retries?: number, backoffMs?: number }} [opts]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {() => string} [clock]  ISO timestamp
 */

/** @param {Deps} d */
export async function runCycle(d) {
  const { github, instance, store } = d;
  const o = { waitMs: 15 * 60_000, pollMs: 10_000, retries: 2, backoffMs: 30_000, ...d.opts };
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const clock = d.clock ?? (() => new Date().toISOString());
  const clean = (v) => redact(v, d.secrets).slice(0, 300);

  const head = await github.headSha();

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

  // The instance must report the commit we meant to test, else the image has not landed yet.
  let build;
  try {
    build = await poll(async () => {
      const h = await d.health(inst.baseUrl);
      return h?.commit === head ? h : undefined;
    }, { timeoutMs: o.waitMs, intervalMs: o.pollMs, sleep, now, what: `/health build.commit == ${head}` });
  } catch (e) {
    return finish({ status: 'stale', suiteVersion: null, cases: [], detail: clean(e.message) });
  }

  let suite;
  try { suite = await d.runSuite(inst, head); } catch (e) {
    return finish({ status: 'infra-error', suiteVersion: null, cases: [], detail: clean(`suite crashed: ${e?.message ?? e}`) });
  }

  // The instance must still be on the tested commit afterwards (a restart onto a newer image mid-run would
  // make the cases a mix of two builds). main moving on is fine: the result is for `head` and stays valid for it.
  const after = await d.health(inst.baseUrl);
  if (after?.commit !== head) {
    return finish({ status: 'stale', suiteVersion: suite.suiteVersion, cases: suite.cases, detail: clean(`instance reported ${after?.commit ?? 'no build'} after the suite, expected ${head}`) });
  }

  return finish({
    status: suite.status, // green | red
    suiteVersion: suite.suiteVersion,
    sourceDigest: build.sourceDigest ?? suite.build?.sourceDigest,
    version: build.version ?? suite.build?.version,
    cases: suite.cases,
    swept: suite.swept,
  });
}
