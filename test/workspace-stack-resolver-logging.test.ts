import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkspaceStackResolver,
  type StackResolverLogger
} from '../src/services/workspace-stack.js';
import type { ParamStore } from '../src/services/param-store.js';
import type { Context } from '@osaas/client-core';

// Env vars that would activate the env-override path and bypass the parameter
// store entirely (buildEnvConnections). Cleared so resolve() exercises the
// param-store branch under test (issue #419).
const OVERRIDE_ENV = ['COUCHDB_URL', 'MINIO_URL'] as const;

describe('WorkspaceStackResolver — logs param-store refresh failures (issue #419)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of OVERRIDE_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of OVERRIDE_ENV) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  function makeResolver(
    paramStore: ParamStore,
    log: StackResolverLogger
  ): WorkspaceStackResolver {
    return new WorkspaceStackResolver({
      paramStore,
      // The failing path never touches the OSC context, so a bare stub suffices.
      oscContext: {} as unknown as Context,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log
    });
  }

  it('logs the real error (message + stack) at error level and does NOT swallow it', async () => {
    const boom = new Error('param store read failed: 502 bad gateway');
    const paramStore: ParamStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(),
      deleteStackConfig: vi.fn(),
      // The default-stack path calls listStackNames() first; force it to reject.
      listStackNames: vi.fn(async () => {
        throw boom;
      })
    };
    const log: StackResolverLogger = { warn: vi.fn(), error: vi.fn() };

    const resolver = makeResolver(paramStore, log);

    // Fallback behaviour is unchanged: we still resolve to in-memory (no object
    // storage) connections rather than throwing.
    const connections = await resolver.resolve();
    expect(connections.storageFor).toBeUndefined();
    expect(connections.storageClient).toBeUndefined();

    // The error must be logged, not silently swallowed.
    expect(log.error).toHaveBeenCalledOnce();
    const [obj, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { err: { message: string; stack?: string }; stackName: string; fallback: string },
      string
    ];
    expect(obj.err.message).toBe(boom.message);
    expect(obj.err.stack).toBe(boom.stack);
    expect(obj.stackName).toBe('(workspace default)');
    expect(obj.fallback).toContain('in-memory');
    // Correlates with a subsequent 501 from the storage route.
    expect(msg).toMatch(/parameter-store refresh failed/i);
  });

  it('logs the requested stack name when an explicit stack is being resolved', async () => {
    const paramStore: ParamStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(async () => {
        throw new Error('TLS blip');
      }),
      deleteStackConfig: vi.fn(),
      listStackNames: vi.fn(async () => [])
    };
    const log: StackResolverLogger = { warn: vi.fn(), error: vi.fn() };

    const resolver = makeResolver(paramStore, log);
    await resolver.resolve('prod-stack');

    expect(log.error).toHaveBeenCalledOnce();
    const [obj] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { stackName: string }
    ];
    expect(obj.stackName).toBe('prod-stack');
  });
});
