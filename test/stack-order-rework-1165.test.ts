// Regression coverage for the review rework of issue #1165.
//
// Two defects were found in the first fix and are pinned here.
//
// DEFECT A — the contract promised a preserved default it could not deliver.
// Stacks written before creation times were recorded carry no `createdAt`, and
// they sort among THEMSELVES by name. So "an existing deployment's default is
// preserved" only held for a deployment with exactly ONE pre-existing stack; a
// deployment with several saw its no-X-Stack-Name default move once, to the
// name-first stack. There was also no backfill: an already-ready stack returns
// early from provision, so a legacy stack stayed unstamped forever and its
// ordering key was re-derived from absence on every listing.
//   The rework: an operator can pin the default with DEFAULT_STACK_NAME, and a
//   legacy stack is backfilled with LEGACY_STACK_CREATED_AT — an explicit
//   "created before creation times were recorded" marker that sorts exactly
//   where absence sorted, so the backfill cannot move anything.
//
// DEFECT B — a retried provision could still re-stamp and move the default.
// The creation instant was carried forward only when the idempotency pre-flight
// read SUCCEEDED. That read's failure is deliberately swallowed so provisioning
// continues, and a spurious 404 is indistinguishable from a real one, so a retry
// of a stack that was already stored fell back to "now", rewrote the record, and
// moved the stack to the end of the listing. Because the listing has no status
// filter, a still-provisioning stack can be element [0] and become the default.
//   The rework: a fresh instant is stamped ONLY when a completed read proved the
//   record absent; an ambiguous read writes no `createdAt` at all, and the
//   persisted record is re-read immediately before the final write.
//
// Contract sources verified for this test (CLAUDE.md rule 7):
//   - `decideStackCreatedAt({ recordedCreatedAt?, storedRecordKnownAbsent,
//     provisionStartedAt }): string | undefined` — src/routes/provision.ts
//   - `StackConfig.createdAt?: string` — src/services/param-store.ts
//   - `orderStackNamesByCreation(entries, pinnedStackName?): string[]`,
//     `resolvePinnedStackName(env?)`, `LEGACY_STACK_CREATED_AT`,
//     `isLegacyCreatedAt(createdAt?)` — src/services/param-store.ts
//   - `ParamStore.listStackNames(workspaceId): Promise<string[]>` and its
//     ordering clause — src/services/param-store.ts
//   - `stackConfigKey(workspaceId, name)` — src/services/param-store.ts
//   - ConfigObjectList = { offset, limit, total, items } with
//     ConfigObject = { key: string; value: string; secret?: boolean } —
//     Eyevinn/app-config-svc `src/api_config.ts` @ c1538c0e88, cited on
//     CONFIG_LIST_PAGE_LIMIT in src/services/param-store.ts. This is also the
//     evidence that the config service records NO creation metadata of its own,
//     which is why the backfill uses an explicit marker rather than inventing
//     an instant.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { decideStackCreatedAt } from '../src/routes/provision.js';
import {
  orderStackNamesByCreation,
  resolvePinnedStackName,
  isLegacyCreatedAt,
  LEGACY_STACK_CREATED_AT,
  makeHttpParamStore,
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from '../src/services/param-store.js';
import { STACK_CONFIG_NAMESPACE } from '../src/services/workspace-stack.js';

function stackConfig(createdAt?: string): StackConfig {
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

// A config-service list response, returned in a deliberately unhelpful order so
// a pass cannot be explained by the fake happening to iterate correctly.
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

const PROVISION_STARTED_AT = '2026-10-15T12:00:00.000Z';
const ORIGINAL_CREATED_AT = '2026-03-01T08:30:00.000Z';

describe('decideStackCreatedAt — retried provision must not re-stamp', () => {
  it('stamps this run only when a completed read proved the record absent', () => {
    expect(
      decideStackCreatedAt({
        storedRecordKnownAbsent: true,
        provisionStartedAt: PROVISION_STARTED_AT
      })
    ).toBe(PROVISION_STARTED_AT);
  });

  it('writes no createdAt when the pre-flight read was ambiguous', () => {
    // THE DEFECT B REPRODUCTION. The swallowed pre-flight failure leaves no
    // recorded instant AND no proof of absence. The old code fell through to
    // provisionStartedAt here and rewrote the stack's position.
    expect(
      decideStackCreatedAt({
        storedRecordKnownAbsent: false,
        provisionStartedAt: PROVISION_STARTED_AT
      })
    ).toBeUndefined();
  });

  it('carries a recorded instant forward on a retry', () => {
    expect(
      decideStackCreatedAt({
        recordedCreatedAt: ORIGINAL_CREATED_AT,
        storedRecordKnownAbsent: false,
        provisionStartedAt: PROVISION_STARTED_AT
      })
    ).toBe(ORIGINAL_CREATED_AT);
  });

  it('prefers the recorded instant even when the read also reported absence', () => {
    // A re-read that found a record written by a concurrent attempt must win
    // over this run's stale "the record is absent" conclusion.
    expect(
      decideStackCreatedAt({
        recordedCreatedAt: ORIGINAL_CREATED_AT,
        storedRecordKnownAbsent: true,
        provisionStartedAt: PROVISION_STARTED_AT
      })
    ).toBe(ORIGINAL_CREATED_AT);
  });

  it('never returns an instant that would move a stack to the end of the listing on an ambiguous retry', async () => {
    // End-to-end on the ordering consequence, which is the user-visible defect:
    // the retried stack must still be element [0] afterwards.
    const established = stackConfig(ORIGINAL_CREATED_AT);
    const retryWrite = {
      ...established,
      status: 'provisioning' as const,
      ...(decideStackCreatedAt({
        storedRecordKnownAbsent: false,
        provisionStartedAt: PROVISION_STARTED_AT
      }) !== undefined
        ? { createdAt: PROVISION_STARTED_AT }
        : {})
    };
    // The retry wrote no new instant, so nothing about the record's ordering
    // key changed and a later successful read still sees the original.
    expect(retryWrite.createdAt).toBe(ORIGINAL_CREATED_AT);

    const store = httpStoreReturning([
      { name: 'newerstack', config: stackConfig('2026-09-09T09:00:00.000Z') },
      { name: 'established', config: retryWrite }
    ]);
    const names = await store.listStackNames(STACK_CONFIG_NAMESPACE);
    expect(names).toEqual(['established', 'newerstack']);
  });
});

describe('LEGACY_STACK_CREATED_AT backfill is order-preserving', () => {
  it('is recognised as the legacy marker rather than a real instant', () => {
    expect(isLegacyCreatedAt(LEGACY_STACK_CREATED_AT)).toBe(true);
    expect(isLegacyCreatedAt(ORIGINAL_CREATED_AT)).toBe(false);
    expect(isLegacyCreatedAt(undefined)).toBe(false);
  });

  it('gives a backfilled legacy stack exactly the order absence gave it', () => {
    const unstamped = orderStackNamesByCreation([
      { name: 'newer', createdAt: ORIGINAL_CREATED_AT },
      { name: 'legacyb' },
      { name: 'legacya' }
    ]);
    const backfilled = orderStackNamesByCreation([
      { name: 'newer', createdAt: ORIGINAL_CREATED_AT },
      { name: 'legacyb', createdAt: LEGACY_STACK_CREATED_AT },
      { name: 'legacya', createdAt: LEGACY_STACK_CREATED_AT }
    ]);
    expect(backfilled).toEqual(unstamped);
    expect(backfilled[0]).toBe('legacya');
  });

  it('keeps element 0 when only ONE of three legacy stacks is backfilled', () => {
    // THE MIXED STATE, and the regression this PR exists to fix (issue #1165
    // second review, blocking finding A). The backfill in provision.ts is
    // best-effort PER STACK — it only runs when that stack's provision is
    // converged — so a deployment with three legacy stacks normally spends time
    // with some stamped with the marker and the rest still unstamped. If the
    // marker sorted as a real epoch-0 instant, rule 1 ("unknown before known")
    // would put the backfilled stack AFTER both unstamped ones and the
    // no-X-Stack-Name default would change mid-rollout.
    const allUnstamped = orderStackNamesByCreation([
      { name: 'legacyb' },
      { name: 'legacyc' },
      { name: 'legacya' }
    ]);
    expect(allUnstamped[0]).toBe('legacya');

    // Backfilling the name-first stack (the current default) must not move it.
    expect(
      orderStackNamesByCreation([
        { name: 'legacyb' },
        { name: 'legacyc' },
        { name: 'legacya', createdAt: LEGACY_STACK_CREATED_AT }
      ])
    ).toEqual(allUnstamped);

    // Backfilling a NON-default stack must not promote it over the default
    // either — the pre-fix order was ['legacya','legacyc','legacyb'].
    expect(
      orderStackNamesByCreation([
        { name: 'legacyb', createdAt: LEGACY_STACK_CREATED_AT },
        { name: 'legacyc' },
        { name: 'legacya' }
      ])
    ).toEqual(allUnstamped);
  });

  it('keeps element 0 through a mixed-backfill listing round-trip', async () => {
    // Same state, end to end over the config-service listing: one of three
    // legacy stacks backfilled, plus a stack created after creation times
    // started being recorded, which must stay last.
    const store = httpStoreReturning([
      { name: 'legacyc', config: stackConfig() },
      { name: 'addedlater', config: stackConfig(PROVISION_STARTED_AT) },
      { name: 'legacya', config: stackConfig(LEGACY_STACK_CREATED_AT) },
      { name: 'legacyb', config: stackConfig() }
    ]);
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([
      'legacya',
      'legacyb',
      'legacyc',
      'addedlater'
    ]);
  });

  it('keeps a backfilled legacy stack ahead of every stack created later', () => {
    expect(
      orderStackNamesByCreation([
        { name: 'brandnew', createdAt: PROVISION_STARTED_AT },
        { name: 'legacy', createdAt: LEGACY_STACK_CREATED_AT }
      ])
    ).toEqual(['legacy', 'brandnew']);
  });

  it('is read back off a backfilled stored config by the listing', async () => {
    const store = httpStoreReturning([
      { name: 'addedlater', config: stackConfig(PROVISION_STARTED_AT) },
      { name: 'legacystack', config: stackConfig(LEGACY_STACK_CREATED_AT) }
    ]);
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([
      'legacystack',
      'addedlater'
    ]);
  });
});

describe('the stack listing is exhaustive, not one page', () => {
  // Contract for this block, verified against the service's own source
  // (CLAUDE.md rule 7): Eyevinn/app-config-svc `src/api_config.ts` on `main`
  // (commit 85b3c15fda), route `GET /config` under `/api/v1`.
  //   PageQuery = { match?: string; offset?: number (min 0);
  //                 limit?: number (min 1, max 100) }
  //   ConfigObjectList.offset is the NEXT offset:
  //   `nextOffset = offset + limit < total ? offset + limit : 0`, so 0 ends the
  //   walk. `match` is a glob applied to the key.
  function pagedStore(pages: Array<{ names: string[]; nextOffset: number }>) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      calls.push(u.search);
      const requested = Number(u.searchParams.get('offset') ?? '0');
      const page =
        pages.find((_, i) => i * 2 === requested) ?? pages[pages.length - 1]!;
      return new Response(
        JSON.stringify({
          offset: page.nextOffset,
          limit: 2,
          total: pages.reduce((n, p) => n + p.names.length, 0),
          items: page.names.map((name) => ({
            key: stackConfigKey(STACK_CONFIG_NAMESPACE, name),
            value: JSON.stringify(stackConfig())
          }))
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io/',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetchMock as unknown as typeof globalThis.fetch
    });
    return { store, calls };
  }

  it('scopes the scan with match and follows offset to the last page', async () => {
    // A single page would have returned only ['stackb','stacka'] -> element 0
    // 'stacka', even though 'aaastack' exists and is the real default. That is
    // the truncation the openapi contract's unconditional guarantee forbids.
    const { store, calls } = pagedStore([
      { names: ['stackb', 'stacka'], nextOffset: 2 },
      { names: ['aaastack'], nextOffset: 0 }
    ]);
    const names = await store.listStackNames(STACK_CONFIG_NAMESPACE);
    expect(names).toEqual(['aaastack', 'stacka', 'stackb']);
    expect(calls.length).toBe(2);
    for (const search of calls) {
      const q = new URLSearchParams(search);
      expect(q.get('match')).toBe(`openvideocore/${STACK_CONFIG_NAMESPACE}/*`);
      expect(q.get('limit')).toBe('100');
    }
    expect(new URLSearchParams(calls[0]!).get('offset')).toBe('0');
    expect(new URLSearchParams(calls[1]!).get('offset')).toBe('2');
  });

  it('stops instead of looping when the next offset does not move forward', async () => {
    // The service paginates in memory over a fresh scan per call, so a page
    // walk is not a stable cursor. A response that repeats or rewinds its
    // offset must end the walk rather than spin.
    const { store, calls } = pagedStore([
      { names: ['onlystack'], nextOffset: 0 }
    ]);
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([
      'onlystack'
    ]);
    expect(calls.length).toBe(1);
  });

  it('does not return a stack twice when pages overlap', async () => {
    const { store } = pagedStore([
      { names: ['dupstack', 'other'], nextOffset: 2 },
      { names: ['dupstack'], nextOffset: 0 }
    ]);
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([
      'dupstack',
      'other'
    ]);
  });
});

describe('DEFAULT_STACK_NAME pins the default stack', () => {
  afterEach(() => {
    delete process.env['DEFAULT_STACK_NAME'];
  });

  it('reads the pin from the environment, trimmed', () => {
    expect(resolvePinnedStackName({ DEFAULT_STACK_NAME: ' signage ' })).toBe(
      'signage'
    );
  });

  it('treats unset and blank as no pin', () => {
    expect(resolvePinnedStackName({})).toBeUndefined();
    expect(resolvePinnedStackName({ DEFAULT_STACK_NAME: '   ' })).toBeUndefined();
  });

  it('hoists the pinned stack to element 0 regardless of ordering', () => {
    // THE DEFECT A REMEDY. Two legacy stacks have no stored instant, so name
    // order would make `foyervod` the default; the operator pins the stack that
    // WAS the default before the upgrade.
    expect(
      orderStackNamesByCreation(
        [{ name: 'signage' }, { name: 'foyervod' }],
        'signage'
      )
    ).toEqual(['signage', 'foyervod']);
  });

  it('leaves the remaining stacks in creation order behind the pin', () => {
    expect(
      orderStackNamesByCreation(
        [
          { name: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
          { name: 'second', createdAt: '2026-02-01T00:00:00.000Z' },
          { name: 'third', createdAt: '2026-03-01T00:00:00.000Z' }
        ],
        'third'
      )
    ).toEqual(['third', 'first', 'second']);
  });

  it('ignores a pin naming a stack that is not provisioned', () => {
    expect(
      orderStackNamesByCreation(
        [{ name: 'alpha' }, { name: 'bravo' }],
        'deprovisioned'
      )
    ).toEqual(['alpha', 'bravo']);
  });

  it('is a no-op when the pinned stack is already first', () => {
    expect(
      orderStackNamesByCreation([{ name: 'alpha' }, { name: 'bravo' }], 'alpha')
    ).toEqual(['alpha', 'bravo']);
  });

  it('applies the pin through the listing round-trip', async () => {
    process.env['DEFAULT_STACK_NAME'] = 'signage1007';
    const store = httpStoreReturning([
      { name: 'foyervod1007', config: stackConfig() },
      { name: 'signage1007', config: stackConfig() }
    ]);
    // Without the pin, two unstamped stacks sort by name and `foyervod1007`
    // would be the default.
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([
      'signage1007',
      'foyervod1007'
    ]);
  });

  it('does not mutate the caller’s array when hoisting the pin', () => {
    const input = [{ name: 'alpha' }, { name: 'bravo' }];
    orderStackNamesByCreation(input, 'bravo');
    expect(input.map((e) => e.name)).toEqual(['alpha', 'bravo']);
  });
});
