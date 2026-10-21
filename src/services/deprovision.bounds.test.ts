// Stack delete must be retryable, idempotent and BOUNDED (issue #1212).
//
// The reported failure: a second DELETE on a partially deleted stack sat in
// `running` for more than seven minutes and removed nothing more. Two causes —
// no bound on an OSC call (so one unanswered request blocked the whole run and
// every service after it) and no retry for the transient faults that strand a
// teardown (`ORCHESTRATOR_UNAVAILABLE`, `fetch failed`).
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/core.d.ts:46/56/65 —
//       removeInstance(context, serviceId, name, token): Promise<void>
//       getInstance(context, serviceId, name, token): Promise<any>   (resolves
//         undefined for a 404 AND for every other non-401 error, lib/core.js:127)
//       listInstances(context, serviceId, token): Promise<any>       (no catch,
//         so it REJECTS on error, lib/core.js:160)
//     None of the three accepts an options/signal argument, and lib/fetch.js
//     `createFetch` passes no `signal` to the global fetch — which is why the
//     bound has to live in this repo.
//   - @osaas/client-core@0.24.0 lib/context.d.ts
//       Context.getServiceAccessToken(serviceId): Promise<string>.
//   - src/encore-scaler/osc-error.ts `isTransientOscError` — the structural
//     classifier reused by services/teardown-bounds.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getInstance = vi.fn();
const listInstances = vi.fn();
const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  getInstance: (...args: unknown[]) => getInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args)
}));

import { deprovisionStackFromConfig } from './deprovision.js';
import {
  DEFAULT_OPERATION_TEARDOWN_TIMEOUT_MS,
  DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_TEARDOWN_BACKOFF_MS,
  DEFAULT_TEARDOWN_REMOVE_ATTEMPTS,
  isTransientTeardownError,
  resolveTeardownBounds
} from './teardown-bounds.js';

const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat')
} as never;

const NAME = 'mystack';
const STORAGE = 'minio-minio';

// Every test injects a fake sleep so a backoff costs no wall-clock time; the
// recorded waits are asserted instead.
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    }
  };
}

beforeEach(() => {
  getInstance.mockReset();
  listInstances.mockReset();
  removeInstance.mockReset();
  listInstances.mockResolvedValue([]);
});

describe('per-service teardown timeout (issue #1212)', () => {
  it('reaches a terminal state when an OSC call never answers', async () => {
    // The SDK call hangs forever — exactly what left the operation `running`.
    getInstance.mockImplementation(() => new Promise(() => {}));
    const { sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { serviceTimeoutMs: 25, sleep }
    );

    expect(result.status).toBe('failed');
    const service = result.services[0];
    expect(service?.status).toBe('failed');
    expect(service?.failure).toBe('timeout');
    expect(service?.error).toContain('timed out');
    // The hung instance is still named, so the operator knows what is left.
    expect(service?.serviceId).toBe(STORAGE);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('a hang on one service does not stop the services after it', async () => {
    getInstance.mockImplementation(async (_ctx: unknown, serviceId: string) => {
      if (serviceId === 'valkey-io-valkey') return new Promise(() => {});
      return { name: NAME };
    });
    removeInstance.mockResolvedValue(undefined);
    const { sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [
        { serviceId: 'valkey-io-valkey', instanceName: NAME },
        { serviceId: STORAGE, instanceName: NAME }
      ],
      undefined,
      { serviceTimeoutMs: 25, sleep }
    );

    expect(result.status).toBe('failed');
    expect(
      result.services.find((s) => s.serviceId === 'valkey-io-valkey')?.failure
    ).toBe('timeout');
    // The storage instance behind the stuck queue was still removed.
    expect(result.services.find((s) => s.serviceId === STORAGE)?.status).toBe(
      'removed'
    );
    expect(removeInstance).toHaveBeenCalledTimes(1);
  });

  it('bounds the removal itself, not just the probe', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockImplementation(() => new Promise(() => {}));
    const { sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { serviceTimeoutMs: 25, sleep }
    );

    expect(result.services[0]?.failure).toBe('timeout');
    expect(result.services[0]?.error).toContain('removeInstance');
  });
});

describe('bounded retry with backoff for transient OSC failures (issue #1212)', () => {
  it('retries ORCHESTRATOR_UNAVAILABLE with backoff and then succeeds', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance
      .mockRejectedValueOnce(new Error('ORCHESTRATOR_UNAVAILABLE'))
      .mockResolvedValueOnce(undefined);
    const { waits, sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { backoffMs: [40, 120], sleep }
    );

    expect(result.status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledTimes(2);
    // Backed off once, by the first entry of the table.
    expect(waits).toEqual([40]);
  });

  it('retries a transport-level "fetch failed" and reports it clearly when the bound is reached', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    // undici rejects a failed request with TypeError: fetch failed; the SDK
    // re-wraps it as a FetchError carrying that message and NO httpCode.
    removeInstance.mockRejectedValue(new TypeError('fetch failed'));
    const { waits, sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { removeAttempts: 3, backoffMs: [40, 120], sleep }
    );

    expect(removeInstance).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([40, 120]);
    const service = result.services[0];
    expect(service?.status).toBe('failed');
    expect(service?.failure).toBe('transient');
    // Clear reporting: the call, the attempt count and the underlying message.
    expect(service?.error).toContain('removeInstance');
    expect(service?.error).toContain('3 attempts');
    expect(service?.error).toContain('fetch failed');
    expect(service?.error).toContain('safe to retry');
  });

  it('does not retry a permanent failure', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockRejectedValue(new Error('instance is not deletable'));
    const { waits, sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { removeAttempts: 3, backoffMs: [40, 120], sleep }
    );

    expect(removeInstance).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(result.services[0]?.failure).toBe('permanent');
    expect(result.services[0]?.error).toContain('instance is not deletable');
  });

  it('never sleeps past the per-service deadline', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockRejectedValue(new Error('ORCHESTRATOR_UNAVAILABLE'));
    const { waits, sleep } = fakeSleep();

    await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      // A backoff longer than the whole budget must not be waited out.
      { serviceTimeoutMs: 50, removeAttempts: 3, backoffMs: [10_000], sleep }
    );

    expect(waits).toEqual([]);
    expect(removeInstance).toHaveBeenCalledTimes(1);
  });

  it('classifies the faults named in #1212 as transient, and a rejected request as not', () => {
    expect(isTransientTeardownError(new Error('ORCHESTRATOR_UNAVAILABLE'))).toBe(
      true
    );
    expect(isTransientTeardownError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isTransientTeardownError(
        Object.assign(new Error('upstream error'), { httpCode: 503 })
      )
    ).toBe(true);
    expect(
      isTransientTeardownError(
        Object.assign(new Error('bad request'), { httpCode: 400 })
      )
    ).toBe(false);
  });

  // The message marker is only consulted when the error carries no httpCode
  // (the invariant stated at src/encore-scaler/osc-error.ts:56-58). A 4xx that
  // relays an upstream "fetch failed" in its body — which reaches us verbatim
  // via @osaas/client-core@0.24.0 lib/fetch.js `defaultErrorFactory`, which
  // puts the response body in `message` and the status in `httpCode` — is a
  // definite answer from the control plane and must not be retried.
  it('does not retry a 4xx whose body quotes "fetch failed"', () => {
    expect(
      isTransientTeardownError(
        Object.assign(new Error('upstream fetch failed'), { httpCode: 400 })
      )
    ).toBe(false);
    expect(
      isTransientTeardownError(
        Object.assign(new Error('instance gone: fetch failed'), {
          httpCode: 404
        })
      )
    ).toBe(false);
    // A 5xx is still transient on its status, body text notwithstanding.
    expect(
      isTransientTeardownError(
        Object.assign(new Error('fetch failed'), { httpCode: 502 })
      )
    ).toBe(true);
    // And a true transport fault still carries no status, so it is retried.
    expect(isTransientTeardownError(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('a retry of a partial teardown skips what is already gone (issue #1212)', () => {
  it('removes only the instances that are still there', async () => {
    // Second DELETE: storage was removed by the first attempt, the queue and
    // the database survived it.
    const gone = new Set([STORAGE]);
    getInstance.mockImplementation(async (_ctx: unknown, serviceId: string) =>
      gone.has(serviceId) ? undefined : { name: NAME }
    );
    // The confirming read proves the storage instance really is absent.
    listInstances.mockImplementation(async (_ctx: unknown, serviceId: string) =>
      gone.has(serviceId) ? [] : [{ name: NAME }]
    );
    removeInstance.mockResolvedValue(undefined);
    const { sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [
        { serviceId: STORAGE, instanceName: NAME },
        { serviceId: 'apache-couchdb', instanceName: NAME },
        { serviceId: 'valkey-io-valkey', instanceName: NAME }
      ],
      undefined,
      { sleep }
    );

    // Already gone => not_found, and NO second DELETE was issued for it.
    expect(result.services.find((s) => s.serviceId === STORAGE)?.status).toBe(
      'not_found'
    );
    expect(
      removeInstance.mock.calls.some((c) => c[1] === STORAGE)
    ).toBe(false);
    // The remaining two were retried and removed, so the stack converges.
    expect(removeInstance).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('partial');
  });

  it('spends no retry budget on a service that is already gone', async () => {
    getInstance.mockResolvedValue(undefined);
    listInstances.mockResolvedValue([]);
    const { waits, sleep } = fakeSleep();

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      [{ serviceId: STORAGE, instanceName: NAME }],
      undefined,
      { backoffMs: [1000], sleep }
    );

    expect(result.status).toBe('not_found');
    expect(waits).toEqual([]);
    // One token mint, one probe, one confirming read — nothing repeated.
    expect(result.services[0]?.attempts).toBe(3);
  });
});

describe('resolveTeardownBounds (12-factor config)', () => {
  it('falls back to the documented defaults with an empty environment', () => {
    const bounds = resolveTeardownBounds({}, {});
    expect(bounds.serviceTimeoutMs).toBe(DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS);
    expect(bounds.operationTimeoutMs).toBe(
      DEFAULT_OPERATION_TEARDOWN_TIMEOUT_MS
    );
    expect(bounds.removeAttempts).toBe(DEFAULT_TEARDOWN_REMOVE_ATTEMPTS);
    expect(bounds.backoffMs).toEqual(DEFAULT_TEARDOWN_BACKOFF_MS);
  });

  it('reads the STACK_TEARDOWN_* environment variables', () => {
    const bounds = resolveTeardownBounds(
      {},
      {
        STACK_TEARDOWN_SERVICE_TIMEOUT_MS: '1234',
        STACK_TEARDOWN_OPERATION_TIMEOUT_MS: '45678',
        STACK_TEARDOWN_REMOVE_ATTEMPTS: '5',
        STACK_TEARDOWN_READ_ATTEMPTS: '4',
        STACK_TEARDOWN_RETRY_BACKOFF_MS: '100, 300 ,900'
      }
    );
    expect(bounds.serviceTimeoutMs).toBe(1234);
    expect(bounds.operationTimeoutMs).toBe(45678);
    expect(bounds.removeAttempts).toBe(5);
    expect(bounds.readAttempts).toBe(4);
    expect(bounds.backoffMs).toEqual([100, 300, 900]);
  });

  it('ignores unusable values rather than disabling the bound', () => {
    const bounds = resolveTeardownBounds(
      {},
      {
        STACK_TEARDOWN_SERVICE_TIMEOUT_MS: 'soon',
        STACK_TEARDOWN_REMOVE_ATTEMPTS: '0',
        STACK_TEARDOWN_RETRY_BACKOFF_MS: 'later'
      }
    );
    expect(bounds.serviceTimeoutMs).toBe(DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS);
    expect(bounds.removeAttempts).toBe(DEFAULT_TEARDOWN_REMOVE_ATTEMPTS);
    expect(bounds.backoffMs).toEqual(DEFAULT_TEARDOWN_BACKOFF_MS);
  });
});
