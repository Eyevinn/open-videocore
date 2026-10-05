import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OSC client-core surface used by the deprovision service.
//
// CONTRACT (node_modules/@osaas/client-core/lib/core.js, SDK 0.24.0):
//   getInstance(context, serviceId, name, token)  (core.js:127)  — resolves the
//     instance, or `undefined` for a 404 AND for every other non-401 error.
//   listInstances(context, serviceId, token)      (core.js:160)  — resolves the
//     raw JSON array of instances (elements carry `name`); REJECTS on any error.
//   removeInstance(context, serviceId, name, token) (core.js:106) — resolves void.
// Because getInstance cannot tell absence from a fault, teardown confirms an
// empty probe against listInstances (issue #1039); the default below is an
// empty list, i.e. "confirmed absent".
const getInstance = vi.fn();
const listInstances = vi.fn();
const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  getInstance: (...args: unknown[]) => getInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args)
}));

import { deprovisionStack } from './deprovision.js';
import { TEARDOWN_ORDER } from './stack.js';

// Minimal Context stub — only getServiceAccessToken is exercised.
const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat')
} as never;

const NAME = 'mystack';

beforeEach(() => {
  getInstance.mockReset();
  listInstances.mockReset();
  removeInstance.mockReset();
  // Default: the confirming read succeeds and shows no instance, so an empty
  // probe means "really gone".
  listInstances.mockResolvedValue([]);
});

describe('deprovisionStack', () => {
  it('happy path: removes every instance and reports status=removed', async () => {
    getInstance.mockResolvedValue({ name: NAME, url: 'https://x' });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('removed');
    expect(result.services).toHaveLength(TEARDOWN_ORDER.length);
    expect(result.services.every((s) => s.status === 'removed')).toBe(true);
    expect(removeInstance).toHaveBeenCalledTimes(TEARDOWN_ORDER.length);
  });

  it('removes in dependency-safe order (packager before storage)', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    await deprovisionStack(osc, NAME);

    const order = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(order[0]).toBe('eyevinn-encore-packager');
    expect(order[order.length - 1]).toBe('minio-minio');
    // consumer before producer it depends on
    expect(order.indexOf('encore')).toBeLessThan(order.indexOf('valkey-io-valkey'));
    expect(order.indexOf('valkey-io-valkey')).toBeLessThan(order.indexOf('minio-minio'));
  });

  it('already-deleted stack: all not_found -> status=not_found', async () => {
    getInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('not_found');
    expect(result.services.every((s) => s.status === 'not_found')).toBe(true);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('partial removal (retry after earlier teardown): status=partial', async () => {
    // Some instances still exist, others already gone — no errors.
    getInstance.mockImplementation(async (_ctx, serviceId: string) =>
      serviceId === 'minio-minio' ? { name: NAME } : undefined
    );
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('partial');
    expect(result.services.find((s) => s.serviceId === 'minio-minio')?.status).toBe(
      'removed'
    );
    expect(removeInstance).toHaveBeenCalledTimes(1);
  });

  it('partial failure: a failing service is reported and others still attempted', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      if (serviceId === 'eyevinn-encore-packager') {
        throw new Error('OSC 503 service unavailable');
      }
      return undefined;
    });

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('failed');
    const packager = result.services.find((s) => s.serviceId === 'eyevinn-encore-packager');
    expect(packager?.status).toBe('failed');
    expect(packager?.error).toContain('503');
    // Every service was still attempted despite the failure.
    expect(getInstance).toHaveBeenCalledTimes(TEARDOWN_ORDER.length);
    // The other services removed successfully.
    expect(
      result.services.filter((s) => s.status === 'removed').length
    ).toBe(TEARDOWN_ORDER.length - 1);
  });

  // Issue #1039: an empty probe is only believed when a second read confirms it.
  it('an unconfirmable probe reports failed and never skips the removal silently', async () => {
    // getInstance resolves undefined because the request errored (the SDK
    // swallows everything but a 401), and the confirming read errors too.
    getInstance.mockResolvedValue(undefined);
    listInstances.mockRejectedValue(new Error('fetch failed'));

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('failed');
    expect(result.services.every((s) => s.status === 'failed')).toBe(true);
    expect(result.services[0]?.error).toContain('fetch failed');
    // Nothing was deleted on the strength of an unverified probe...
    expect(removeInstance).not.toHaveBeenCalled();
    // ...and nothing was written off as already gone.
    expect(result.services.some((s) => s.status === 'not_found')).toBe(false);
  });

  it('removes an instance the confirming read still lists despite an empty probe', async () => {
    getInstance.mockResolvedValue(undefined);
    listInstances.mockResolvedValue([{ name: NAME, url: 'https://live' }]);
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME);

    expect(result.status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledTimes(TEARDOWN_ORDER.length);
  });

  it('is idempotent: a second run after success reports not_found', async () => {
    getInstance.mockResolvedValueOnce({ name: NAME }); // not used across runs cleanly
    // First run: everything exists.
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);
    const first = await deprovisionStack(osc, NAME);
    expect(first.status).toBe('removed');

    // Second run: everything gone.
    getInstance.mockReset();
    removeInstance.mockReset();
    getInstance.mockResolvedValue(undefined);
    const second = await deprovisionStack(osc, NAME);
    expect(second.status).toBe('not_found');
    expect(removeInstance).not.toHaveBeenCalled();
  });
});
