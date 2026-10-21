// destroyInstance must tolerate an already-removed backend (issue #1213).
//
// Observed during a stack teardown: the destroy of the paired
// eyevinn-encore-callback-listener "failed", and the teardown of the remaining
// Encore instances stopped there. Two causes, both fixed here:
//
//   1. The already-gone check substring-matched the error MESSAGE for '404' /
//      'not found'. @osaas/client-core surfaces the status structurally
//      (FetchError.httpCode) and puts the SERVER's body text in the message, so
//      a genuine 404 whose body says something else ("Instance mystack-1 has
//      been deleted") was re-thrown as a failure.
//   2. The pool-record cleanup (hdel) runs while the stack's OWN Valkey is being
//      deprovisioned, so it can reject with ECONNREFUSED. That rejection
//      escaped destroyInstance and aborted the teardown loop, leaving the
//      remaining Encore instances and their callback listeners running.
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/core.d.ts:46 removeInstance(context,
//     serviceId, name, token): Promise<void>; lib/core.js:106-116 DELETEs the
//     instance URL through createFetch, and lib/fetch.js defaultErrorFactory
//     throws `new FetchError({ message, httpCode: response.status })` on any
//     non-ok response — so an already-removed instance rejects with
//     httpCode 404 and an arbitrary message.
//   - lib/fetch.d.ts `class FetchError extends Error { httpCode?: number }` —
//     httpCode is OPTIONAL (a transport failure is re-wrapped without one),
//     which is why the duck-typed `{ httpCode }` double below is faithful.
//   - Context.getServiceAccessToken(serviceId): Promise<string>
//     (lib/context.d.ts:25).
//   - src/encore-scaler/instance-pool.ts destroyInstance(instanceId, config) and
//     ENCORE_SERVICE_ID / ENCORE_CALLBACK_LISTENER_SERVICE_ID; pool key
//     keys.pool(workspaceId) (src/encore-scaler/types.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  listInstances: vi.fn(async () => []),
  getInstance: vi.fn(),
  getInstanceHealth: vi.fn(async () => 'running')
}));

import {
  destroyInstance,
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID
} from './instance-pool.js';
import { keys, type EncoreScalerConfig } from './types.js';

// An OSC rejection in the exact shape @osaas/client-core throws: the server's
// body text as the message, the status as `httpCode`.
function fetchError(message: string, httpCode?: number): Error {
  const err = new Error(message);
  if (httpCode !== undefined) {
    (err as Error & { httpCode: number }).httpCode = httpCode;
  }
  return err;
}

function makeConfig(redis: Partial<EncoreScalerConfig['redis']>): EncoreScalerConfig {
  return {
    workspaceId: 'mystack',
    maxInstances: 2,
    idleTimeoutMs: 60_000,
    oscContext: {
      getServiceAccessToken: vi.fn(async () => 'test-sat')
    } as unknown as EncoreScalerConfig['oscContext'],
    redis: redis as EncoreScalerConfig['redis'],
    redisUrl: 'redis://valkey.example.osaas.io:6379',
    getToken: async () => 'test-sat'
  } as EncoreScalerConfig;
}

beforeEach(() => {
  removeInstance.mockReset();
});

describe('destroyInstance tolerates an already-removed backend (#1213)', () => {
  it('treats a 404 whose message never quotes the status as already gone', async () => {
    const hdel = vi.fn(async () => 1);
    removeInstance.mockImplementation(async () => {
      throw fetchError('Instance mystack-1 has been deleted', 404);
    });

    await expect(
      destroyInstance('mystack-1', makeConfig({ hdel } as never))
    ).resolves.toBeUndefined();

    // Both halves of the pair were attempted — the already-gone Encore instance
    // must not short-circuit its paired callback listener's removal.
    expect(removeInstance.mock.calls.map((c) => c[1])).toEqual([
      ENCORE_SERVICE_ID,
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    ]);
    // ...and the pool record is still dropped.
    expect(hdel).toHaveBeenCalledWith(keys.pool('mystack'), 'mystack-1');
  });

  it('still refuses to drop the pool record when the Encore removal really failed', async () => {
    const hdel = vi.fn(async () => 1);
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      if (serviceId === ENCORE_SERVICE_ID) {
        throw fetchError('ORCHESTRATOR_UNAVAILABLE', 503);
      }
    });

    await expect(
      destroyInstance('mystack-1', makeConfig({ hdel } as never))
    ).rejects.toThrow('ORCHESTRATOR_UNAVAILABLE');
    expect(hdel).not.toHaveBeenCalled();
  });

  it('completes when the stack Valkey holding the pool record is already gone', async () => {
    const hdel = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
    });
    removeInstance.mockResolvedValue(undefined);

    // The OSC instances are removed, so the teardown of THIS instance is done;
    // a failed bookkeeping delete on a Valkey that is itself being removed must
    // not propagate and abort the teardown of the remaining instances.
    await expect(
      destroyInstance('mystack-1', makeConfig({ hdel } as never))
    ).resolves.toBeUndefined();
    expect(removeInstance.mock.calls.map((c) => c[1])).toEqual([
      ENCORE_SERVICE_ID,
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    ]);
  });

  it('reports a listener removal that genuinely failed without failing the destroy', async () => {
    const hdel = vi.fn(async () => 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      if (serviceId === ENCORE_CALLBACK_LISTENER_SERVICE_ID) {
        throw fetchError('internal error', 500);
      }
    });

    await expect(
      destroyInstance('mystack-1', makeConfig({ hdel } as never))
    ).resolves.toBeUndefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('callback listener'))
    ).toBe(true);
    expect(hdel).toHaveBeenCalledWith(keys.pool('mystack'), 'mystack-1');
    warn.mockRestore();
  });
});
