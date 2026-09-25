import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OSC client-core surface used by the deprovision service.
const getInstance = vi.fn();
const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  getInstance: (...args: unknown[]) => getInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args)
}));

import {
  deprovisionStack,
  deprovisionStackFromConfig
} from './deprovision.js';
import { TEARDOWN_ORDER } from './stack.js';

// Minimal Context stub — only getServiceAccessToken is exercised.
const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat')
} as never;

const NAME = 'mystack';

beforeEach(() => {
  getInstance.mockReset();
  removeInstance.mockReset();
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

// Selective teardown (issue #738): skipServiceIds names the services to KEEP.
// Every assertion here is about the same invariant — the named service is left
// completely untouched (not even probed) and every OTHER service is still
// removed.
describe('selective teardown (skipServiceIds, issue #738)', () => {
  // A stored services[] list as persisted by provision (StackConfig.services[]:
  // { serviceId, instanceName }, services/param-store.ts).
  const STORED = [
    { serviceId: 'minio-minio', instanceName: NAME },
    { serviceId: 'apache-couchdb', instanceName: NAME },
    { serviceId: 'valkey-io-valkey', instanceName: NAME }
  ];

  it('keeps ONLY the named service and removes the rest (stored config)', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: ['minio-minio'] }
    );

    // Storage kept, and kept ON PURPOSE (skipped, not failed).
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('skipped');
    // Never touched: no existence probe and no removal for the kept service.
    const probed = getInstance.mock.calls.map((c) => c[1] as string);
    const removed = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(probed).not.toContain('minio-minio');
    expect(removed).not.toContain('minio-minio');
    // Everything else was removed.
    expect(removed.sort()).toEqual(['apache-couchdb', 'valkey-io-valkey']);
    expect(
      result.services
        .filter((s) => s.serviceId !== 'minio-minio')
        .every((s) => s.status === 'removed')
    ).toBe(true);
    // The stack is not fully gone, so it can never report 'removed'.
    expect(result.status).toBe('partial');
  });

  it('keeps several named services at once', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: ['minio-minio', 'apache-couchdb'] }
    );

    const removed = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(removed).toEqual(['valkey-io-valkey']);
    expect(
      result.services
        .filter((s) => s.status === 'skipped')
        .map((s) => s.serviceId)
        .sort()
    ).toEqual(['apache-couchdb', 'minio-minio']);
    expect(result.status).toBe('partial');
  });

  it('keeps an OPTIONAL service (auto-subtitles) merged in from the config', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      { autoSubtitlesInstanceName: NAME },
      { skipServiceIds: ['eyevinn-auto-subtitles'] }
    );

    const removed = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(removed).not.toContain('eyevinn-auto-subtitles');
    expect(removed.sort()).toEqual([
      'apache-couchdb',
      'minio-minio',
      'valkey-io-valkey'
    ]);
    expect(
      result.services.find((s) => s.serviceId === 'eyevinn-auto-subtitles')
        ?.status
    ).toBe('skipped');
  });

  it('an unknown skip id matches nothing: the whole stack is still removed', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: ['not-a-service-in-this-stack'] }
    );

    expect(result.status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledTimes(STORED.length);
    expect(result.services.some((s) => s.status === 'skipped')).toBe(false);
  });

  it('no skip list: unchanged whole-stack teardown', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(osc, NAME, STORED);

    expect(result.status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledTimes(STORED.length);
  });

  it('a failure elsewhere still reports failed, and the kept service stays skipped', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      if (serviceId === 'apache-couchdb') throw new Error('OSC 503');
      return undefined;
    });

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: ['minio-minio'] }
    );

    expect(result.status).toBe('failed');
    // 'skipped' is never conflated with 'failed'.
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('skipped');
    expect(
      result.services.find((s) => s.serviceId === 'apache-couchdb')?.status
    ).toBe('failed');
  });

  it('skipping everything removes nothing and reports partial (not not_found)', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      {
        skipServiceIds: STORED.map((s) => s.serviceId)
      }
    );

    expect(removeInstance).not.toHaveBeenCalled();
    expect(getInstance).not.toHaveBeenCalled();
    // Instances are all still running — 'not_found' would be a lie.
    expect(result.status).toBe('partial');
  });

  it('the legacy (no param store) path honours the skip list too', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME, {
      skipServiceIds: ['minio-minio']
    });

    const removed = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(removed).not.toContain('minio-minio');
    expect(removed).toHaveLength(TEARDOWN_ORDER.length - 1);
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('skipped');
    expect(result.status).toBe('partial');
  });
});
