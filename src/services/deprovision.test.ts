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
  deprovisionStackFromConfig,
  unmatchedSkipServiceIds
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

// Opt-in selective teardown (issue #738).
describe('selective teardown (skipServiceIds)', () => {
  const STORED = [
    { serviceId: 'minio-minio', instanceName: NAME },
    { serviceId: 'apache-couchdb', instanceName: NAME },
    { serviceId: 'valkey-io-valkey', instanceName: NAME }
  ];

  it('deprovisionStack: reports the skipped service and never touches it', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStack(osc, NAME, {
      skipServiceIds: ['minio-minio']
    });

    // Not fully torn down: something is still running on purpose.
    expect(result.status).toBe('partial');
    const storage = result.services.find((s) => s.serviceId === 'minio-minio');
    expect(storage?.status).toBe('skipped');
    expect(storage?.role).toBe('storage');
    // Never probed, never removed.
    expect(getInstance.mock.calls.map((c) => c[1])).not.toContain('minio-minio');
    expect(removeInstance.mock.calls.map((c) => c[1])).not.toContain(
      'minio-minio'
    );
    // Everything else was still attempted.
    expect(removeInstance).toHaveBeenCalledTimes(TEARDOWN_ORDER.length - 1);
  });

  it('deprovisionStackFromConfig: skips by serviceId and removes the rest', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: ['minio-minio'] }
    );

    expect(result.status).toBe('partial');
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('skipped');
    expect(removeInstance).toHaveBeenCalledTimes(STORED.length - 1);
  });

  it('deprovisionStackFromConfig: can skip an optional opt-in service', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      { autoSubtitlesInstanceName: NAME },
      { skipServiceIds: ['eyevinn-auto-subtitles'] }
    );

    expect(result.status).toBe('partial');
    expect(
      result.services.find((s) => s.serviceId === 'eyevinn-auto-subtitles')
        ?.status
    ).toBe('skipped');
    expect(removeInstance).toHaveBeenCalledTimes(STORED.length);
  });

  it('an all-skipped teardown is partial, not not_found', async () => {
    const result = await deprovisionStackFromConfig(
      osc,
      NAME,
      STORED,
      undefined,
      { skipServiceIds: STORED.map((s) => s.serviceId) }
    );

    expect(result.status).toBe('partial');
    expect(result.services.every((s) => s.status === 'skipped')).toBe(true);
    expect(getInstance).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('a failure elsewhere still wins over a skip', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
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
  });

  it('an empty / omitted skip list is an unchanged full teardown', async () => {
    getInstance.mockResolvedValue({ name: NAME });
    removeInstance.mockResolvedValue(undefined);

    const result = await deprovisionStackFromConfig(osc, NAME, STORED, undefined, {
      skipServiceIds: []
    });

    expect(result.status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledTimes(STORED.length);
  });

  it('unmatchedSkipServiceIds names skip targets the teardown cannot honour', () => {
    expect(unmatchedSkipServiceIds(['minio-minio'], STORED)).toEqual([]);
    expect(
      unmatchedSkipServiceIds(['minio-minio', 'not-in-stack'], STORED)
    ).toEqual(['not-in-stack']);
    // Deduped, and an empty request matches nothing by definition.
    expect(unmatchedSkipServiceIds(['x', 'x'], STORED)).toEqual(['x']);
    expect(unmatchedSkipServiceIds([], STORED)).toEqual([]);
  });
});
