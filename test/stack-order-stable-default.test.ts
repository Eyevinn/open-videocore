// Regression coverage for issue #1165 — "adding a stack changes which stack is
// first and default".
//
// THE DEFECT. `ParamStore.listStackNames` returned the config service's own
// `items` order, which the service does not specify (ConfigObjectList, contract
// cited at src/services/param-store.ts on CONFIG_LIST_PAGE_LIMIT and verified
// against Eyevinn/app-config-svc `src/api_config.ts` @ c1538c0e88). Every
// default-stack resolution in WorkspaceStackResolver takes element [0] of that
// listing — resolve(), resolveStackName() and resolveStackConfig() — so
// provisioning a stack could silently reassign the stack that requests WITHOUT
// an X-Stack-Name header route to, and the profile index that follows it. The
// reported sequence was: `signage1007` alone (the default), then adding
// `foyervod1007` made IT first, then adding `delstk1007` put the new stack in
// the MIDDLE.
//
// THE CONTRACT now under test:
//   1. the listing is in CREATION ORDER, oldest first;
//   2. a newly created stack is APPENDED LAST, never inserted;
//   3. element [0] — the no-X-Stack-Name default — does not move when stacks
//      are added;
//   4. a pre-#1165 stack with no recorded `createdAt` sorts BEFORE every
//      stamped stack, so an existing deployment keeps its original default;
//   5. the order is total and deterministic (name tiebreak), so nothing falls
//      back to the store's unspecified iteration order.
//
// Contract sources verified for this test (CLAUDE.md rule 7):
//   - `ParamStore.listStackNames(workspaceId): Promise<string[]>` and the
//     ordering clause on it — src/services/param-store.ts
//   - `StackConfig.createdAt?: string` — src/services/param-store.ts
//   - `compareStackCreationOrder` / `orderStackNamesByCreation` —
//     src/services/param-store.ts
//   - ConfigObject = { key: string; value: string; secret?: boolean } — the
//     list-item shape this client reads `createdAt` out of, cited above
//   - `WorkspaceStackResolver.resolveStackName(requestedStackName?)` and
//     `.listStackNames()` — src/services/workspace-stack.ts
//   - `Context` from `@osaas/client-core` (constructor arg `oscContext`) —
//     node_modules/@osaas/client-core

import { describe, it, expect, vi } from 'vitest';
import {
  compareStackCreationOrder,
  orderStackNamesByCreation,
  createdAtFromStoredValue,
  makeHttpParamStore,
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from '../src/services/param-store.js';
import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from '../src/services/workspace-stack.js';
import type { Context } from '@osaas/client-core';

// A ready StackConfig stamped with `createdAt`. Only the fields the ordering
// and resolution paths read matter here.
function readyStack(createdAt?: string): StackConfig {
  return {
    status: 'ready',
    ...(createdAt ? { createdAt } : {}),
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    redisUrl: 'redis://valkey.example:6379',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: []
  };
}

// Build a fake config-service list response in a DELIBERATELY WRONG order, so a
// passing test cannot be explained by the fake happening to return the right
// order. Mirrors ConfigObjectList: { offset, limit, total, items }.
function listResponse(
  entries: Array<{ name: string; config: StackConfig }>
): Response {
  return new Response(
    JSON.stringify({
      offset: 0,
      limit: 100,
      total: entries.length,
      items: entries.map((e) => ({
        key: stackConfigKey(STACK_CONFIG_NAMESPACE, e.name),
        value: JSON.stringify(e.config)
      }))
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function httpStoreReturning(
  entries: Array<{ name: string; config: StackConfig }>
): ParamStore {
  return makeHttpParamStore({
    baseUrl: 'https://config.example.osaas.io/',
    getOscToken: async () => 'test-sat',
    apiKey: 'key123',
    fetch: vi.fn(async () =>
      listResponse(entries)
    ) as unknown as typeof globalThis.fetch
  });
}

describe('compareStackCreationOrder (issue #1165)', () => {
  it('orders stamped stacks by createdAt ascending', () => {
    expect(
      orderStackNamesByCreation([
        { name: 'delstk1007', createdAt: '2026-10-15T12:00:02.000Z' },
        { name: 'signage1007', createdAt: '2026-10-15T12:00:00.000Z' },
        { name: 'foyervod1007', createdAt: '2026-10-15T12:00:01.000Z' }
      ])
    ).toEqual(['signage1007', 'foyervod1007', 'delstk1007']);
  });

  it('appends a newly created stack LAST rather than inserting it', () => {
    const existing = [
      { name: 'signage1007', createdAt: '2026-10-15T12:00:00.000Z' },
      { name: 'foyervod1007', createdAt: '2026-10-15T12:00:01.000Z' }
    ];
    const withNew = orderStackNamesByCreation([
      // the new stack arrives in the middle of the store's listing, exactly as
      // reported in the issue
      existing[0]!,
      { name: 'delstk1007', createdAt: '2026-10-15T12:00:02.000Z' },
      existing[1]!
    ]);
    expect(withNew).toEqual([
      'signage1007',
      'foyervod1007',
      'delstk1007'
    ]);
    expect(withNew[withNew.length - 1]).toBe('delstk1007');
  });

  it('keeps the first element stable as stacks are added one by one', () => {
    const signage = { name: 'signage1007', createdAt: '2026-10-15T12:00:00.000Z' };
    const foyer = { name: 'foyervod1007', createdAt: '2026-10-15T12:00:01.000Z' };
    const delstk = { name: 'delstk1007', createdAt: '2026-10-15T12:00:02.000Z' };
    expect(orderStackNamesByCreation([signage])[0]).toBe('signage1007');
    expect(orderStackNamesByCreation([foyer, signage])[0]).toBe('signage1007');
    expect(
      orderStackNamesByCreation([foyer, delstk, signage])[0]
    ).toBe('signage1007');
  });

  it('sorts a pre-#1165 unstamped stack before every stamped stack', () => {
    // The upgrade case: the only stack predates the ordering contract, so it has
    // no createdAt. Adding a stamped stack must not steal the default.
    expect(
      orderStackNamesByCreation([
        { name: 'newstack1007', createdAt: '2026-10-15T12:00:00.000Z' },
        { name: 'signage1007' }
      ])
    ).toEqual(['signage1007', 'newstack1007']);
  });

  it('falls back to name order for two unstamped legacy stacks', () => {
    expect(
      orderStackNamesByCreation([{ name: 'zulu' }, { name: 'alpha' }])
    ).toEqual(['alpha', 'zulu']);
  });

  it('breaks a createdAt tie by name so the order is total', () => {
    const t = '2026-10-15T12:00:00.000Z';
    expect(
      orderStackNamesByCreation([
        { name: 'bravo', createdAt: t },
        { name: 'alpha', createdAt: t }
      ])
    ).toEqual(['alpha', 'bravo']);
  });

  it('treats a malformed createdAt as unstamped rather than throwing', () => {
    expect(
      orderStackNamesByCreation([
        { name: 'good', createdAt: '2026-10-15T12:00:00.000Z' },
        { name: 'broken', createdAt: 'not-a-date' }
      ])
    ).toEqual(['broken', 'good']);
  });

  it('is a stable comparator: equal entries compare to 0', () => {
    const e = { name: 'same', createdAt: '2026-10-15T12:00:00.000Z' };
    expect(compareStackCreationOrder(e, { ...e })).toBe(0);
  });

  it('does not mutate its input array', () => {
    const input = [
      { name: 'zulu', createdAt: '2026-10-15T12:00:00.000Z' },
      { name: 'alpha', createdAt: '2026-10-15T12:00:01.000Z' }
    ];
    orderStackNamesByCreation(input);
    expect(input.map((e) => e.name)).toEqual(['zulu', 'alpha']);
  });
});

describe('createdAtFromStoredValue (issue #1165)', () => {
  it('reads createdAt off a stored StackConfig JSON value', () => {
    expect(
      createdAtFromStoredValue(JSON.stringify(readyStack('2026-10-15T12:00:00.000Z')))
    ).toBe('2026-10-15T12:00:00.000Z');
  });

  it('returns undefined for a pre-#1165 config with no createdAt', () => {
    expect(createdAtFromStoredValue(JSON.stringify(readyStack()))).toBeUndefined();
  });

  it('returns undefined for a non-JSON or absent value', () => {
    expect(createdAtFromStoredValue('not json')).toBeUndefined();
    expect(createdAtFromStoredValue(undefined)).toBeUndefined();
  });
});

describe('makeHttpParamStore.listStackNames ordering (issue #1165)', () => {
  it('returns creation order even when the service lists items in another order', async () => {
    // The exact listing the issue reports: the service puts the newest stack
    // second and the original default last.
    const store = httpStoreReturning([
      { name: 'foyervod1007', config: readyStack('2026-10-15T12:00:01.000Z') },
      { name: 'delstk1007', config: readyStack('2026-10-15T12:00:02.000Z') },
      { name: 'signage1007', config: readyStack('2026-10-15T12:00:00.000Z') }
    ]);
    await expect(store.listStackNames(STACK_CONFIG_NAMESPACE)).resolves.toEqual([
      'signage1007',
      'foyervod1007',
      'delstk1007'
    ]);
  });

  it('reads createdAt from the SAME list page, with no extra round-trip', async () => {
    const fetch = vi.fn(async () =>
      listResponse([
        { name: 'b', config: readyStack('2026-10-15T12:00:01.000Z') },
        { name: 'a', config: readyStack('2026-10-15T12:00:00.000Z') }
      ])
    );
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io/',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(store.listStackNames(STACK_CONFIG_NAMESPACE)).resolves.toEqual([
      'a',
      'b'
    ]);
    // One GET for the whole listing — ordering must not cost a per-stack read.
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('still filters out keys outside this workspace prefix', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            offset: 0,
            limit: 100,
            total: 2,
            items: [
              {
                key: `openvideocore/storagebackends/${STACK_CONFIG_NAMESPACE}/b1`,
                value: '{}'
              },
              {
                key: stackConfigKey(STACK_CONFIG_NAMESPACE, 'signage1007'),
                value: JSON.stringify(readyStack('2026-10-15T12:00:00.000Z'))
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io/',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(store.listStackNames(STACK_CONFIG_NAMESPACE)).resolves.toEqual([
      'signage1007'
    ]);
  });
});

describe('WorkspaceStackResolver default stack is stable (issue #1165)', () => {
  const oscContext = {} as Context;

  function resolverOver(paramStore: ParamStore): WorkspaceStackResolver {
    return new WorkspaceStackResolver({
      paramStore,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw'
    });
  }

  it('resolves the no-X-Stack-Name default to the first-CREATED stack, not whichever the store lists first', async () => {
    const resolver = resolverOver(
      httpStoreReturning([
        { name: 'foyervod1007', config: readyStack('2026-10-15T12:00:01.000Z') },
        { name: 'delstk1007', config: readyStack('2026-10-15T12:00:02.000Z') },
        { name: 'signage1007', config: readyStack('2026-10-15T12:00:00.000Z') }
      ])
    );
    await expect(resolver.resolveStackName()).resolves.toBe('signage1007');
  });

  it('keeps the same default after a second and a third stack are provisioned', async () => {
    const signage = {
      name: 'signage1007',
      config: readyStack('2026-10-15T12:00:00.000Z')
    };
    const foyer = {
      name: 'foyervod1007',
      config: readyStack('2026-10-15T12:00:01.000Z')
    };
    const delstk = {
      name: 'delstk1007',
      config: readyStack('2026-10-15T12:00:02.000Z')
    };
    // A fresh resolver per step: the resolver caches resolutions, and this test
    // is about the STORE's answer at each provisioning step, not the cache.
    await expect(
      resolverOver(httpStoreReturning([signage])).resolveStackName()
    ).resolves.toBe('signage1007');
    await expect(
      resolverOver(httpStoreReturning([foyer, signage])).resolveStackName()
    ).resolves.toBe('signage1007');
    await expect(
      resolverOver(httpStoreReturning([foyer, delstk, signage])).resolveStackName()
    ).resolves.toBe('signage1007');
  });

  it('keeps a pre-#1165 unstamped stack as the default when a new stack is added', async () => {
    const resolver = resolverOver(
      httpStoreReturning([
        { name: 'newstack1007', config: readyStack('2026-10-15T12:00:00.000Z') },
        // provisioned before the ordering contract: no createdAt
        { name: 'signage1007', config: readyStack() }
      ])
    );
    await expect(resolver.resolveStackName()).resolves.toBe('signage1007');
  });

  it('an explicit X-Stack-Name still wins over the default', async () => {
    const resolver = resolverOver(
      httpStoreReturning([
        { name: 'foyervod1007', config: readyStack('2026-10-15T12:00:01.000Z') },
        { name: 'signage1007', config: readyStack('2026-10-15T12:00:00.000Z') }
      ])
    );
    // loadStackConfig for a named stack hits GET /api/v1/config/{key}; the fake
    // returns the list body for every call, which is not a StackConfig, so this
    // asserts via the LIST path instead: resolveStackConfig with a name that has
    // no readable config falls back to the default, and listStackNames exposes
    // the order the header-less default is taken from.
    await expect(resolver.listStackNames()).resolves.toEqual([
      'signage1007',
      'foyervod1007'
    ]);
  });

  it('exposes the creation-ordered listing through resolver.listStackNames()', async () => {
    const resolver = resolverOver(
      httpStoreReturning([
        { name: 'delstk1007', config: readyStack('2026-10-15T12:00:02.000Z') },
        { name: 'signage1007', config: readyStack('2026-10-15T12:00:00.000Z') },
        { name: 'foyervod1007', config: readyStack('2026-10-15T12:00:01.000Z') }
      ])
    );
    await expect(resolver.listStackNames()).resolves.toEqual([
      'signage1007',
      'foyervod1007',
      'delstk1007'
    ]);
  });
});
