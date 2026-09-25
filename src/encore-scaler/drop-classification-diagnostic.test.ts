// #768 (diagnostic-only): reconcile()'s drop classification resolves a job's
// owning instance from keys.jobInstance — a single value overwritten on each
// re-dispatch. The hypothesis is that after a re-dispatch this mapping can point
// to an instance the job is no longer on, so reconcile flags the job dropped off
// that instance while the job is in fact still active on a DIFFERENT pool
// instance. These tests pin the diagnostic log this issue adds: at the exact
// drop-classification site it must emit keys.jobInstance, the reconciled
// instance, the pool instance(s) where the externalId is actually still active,
// and whether the job had been re-dispatched — enough to confirm or refute the
// stale-mapping hypothesis for a real drop event. This issue adds NO decision
// change, so the dropped signal itself must be identical to today.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() drop-classification loop + the diagnostic
//     warn added at the droppedForInstance.push site —
//     src/encore-scaler/scaler-loop.ts (reconcile).
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobAttempts / keys.jobCompletionSeen —
//     src/encore-scaler/types.ts:208-242.
//   - DroppedJob { encoreJobId, reason? } + EncoreScalerConfig.onJobsDropped —
//     src/encore-scaler/types.ts.
//   - Encore findByStatus HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId }] }, page: { totalElements } } — scaler-loop.ts
//     fetchRealActiveState (per-instance record.url).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

// In-memory stand-in for the subset of ioredis reconcile() uses: hash ops plus a
// plain string get (keys.jobAttempts / keys.jobCompletionSeen are string keys).
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
}

function makeConfig(
  redis: FakeRedis,
  onJobsDropped?: (drops: DroppedJob[]) => Promise<void>
): EncoreScalerConfig {
  return {
    workspaceId: 'ws1',
    maxInstances: 4,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    onJobsDropped
  };
}

function seedInstance(
  redis: FakeRedis,
  instanceId: string,
  url: string
): Promise<number> {
  return redis.hset(
    keys.pool('ws1'),
    instanceId,
    JSON.stringify({
      instanceId,
      url,
      activeJobs: 1,
      lastIdleAt: 0
    } satisfies EncoreInstanceRecord)
  );
}

function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Per-instance active sets keyed by the instance's base url, plus an always-empty
// FAILED page (drop-reason recovery is out of scope for this diagnostic).
function fetchMockByUrl(activeByUrl: Record<string, string[]>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=FAILED')) return encorePage([]);
    const base = Object.keys(activeByUrl).find((u) => url.startsWith(u));
    const active = base ? activeByUrl[base] : [];
    // Model everything active as IN_PROGRESS; QUEUED empty for both instances.
    if (url.includes('status=QUEUED')) return encorePage([]);
    if (url.includes('status=IN_PROGRESS')) return encorePage(active);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('#768: drop-classification stale keys.jobInstance diagnostic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs where the "dropped" externalId is actually still active and that it was re-dispatched', async () => {
    const redis = new FakeRedis();
    // inst-old is seeded first so it is reconciled + indexed before inst-new.
    await seedInstance(redis, 'inst-old', 'https://old.encore.example');
    await seedInstance(redis, 'inst-new', 'https://new.encore.example');

    // keys.jobInstance was OVERWRITTEN by the re-dispatch to point at inst-new,
    // even though Encore still lists job-x active on inst-old (the re-dispatched
    // copy has not landed on inst-new yet).
    await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
    await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');
    await redis.set(keys.jobAttempts('job-x'), '2');

    // inst-old still has job-x active; inst-new has nothing yet.
    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({
        'https://old.encore.example': ['job-x'],
        'https://new.encore.example': []
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // Decision behaviour is unchanged: job-x is still classified dropped.
    expect(dropped).toEqual([{ encoreJobId: 'job-x', reason: undefined }]);

    // The diagnostic captures the stale-mapping evidence.
    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    // console.warn is called with a format string + positional args; assert the
    // load-bearing fields are present as arguments.
    const args = diag!.map((a) => String(a));
    expect(args).toContain('job-x'); // externalId
    expect(args).toContain('inst-new'); // keys.jobInstance mapping + reconciled instance
    expect(args).toContain('inst-old'); // where the externalId is ACTUALLY active
    expect(args).toContain('true'); // reDispatched (attempts > 1)
  });

  it('reports reDispatched=false and no active instance for a first-attempt genuine drop', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-1', 'https://one.encore.example');

    await redis.hset(keys.jobInstance('ws1'), 'job-y', 'inst-1');
    await redis.hset(keys.jobStatus('ws1'), 'job-y', 'running');
    await redis.set(keys.jobAttempts('job-y'), '1');

    // job-y is active nowhere in the pool.
    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ 'https://one.encore.example': [] })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-y', reason: undefined }]);

    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    const args = diag!.map((a) => String(a));
    expect(args).toContain('job-y');
    expect(args).toContain('inst-1');
    expect(args).toContain('(none)'); // foundActiveOnPoolInstances is empty
    expect(args).toContain('false'); // reDispatched
  });
});

// #839: the #768 index was populated incrementally INSIDE the same loop that
// classified drops, so at classification time it only held instances iterated
// before or at the current one. Pool-hash iteration order is uncontrolled, so
// the stale-mapping signature was invisible whenever the mapped instance sorted
// before the instance actually holding the job — a false negative
// indistinguishable from a genuine drop, which is exactly the outcome the
// diagnostic exists to rule out. The index is now built in a full pass over
// every pool entry (including idle-tracked and unreachable ones, handled
// explicitly) BEFORE any classification runs, so the signal is order-independent.
describe('#839: pool-active index is order-independent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Same genuine stale-mapping scenario as the first #768 test, with the pool
  // seeded in the REVERSE order: the mapped instance (inst-new) is iterated
  // first, so under the incremental index inst-old had not been indexed yet and
  // the diagnostic logged foundActiveOnPoolInstances=(none).
  it('finds the externalId active on another instance when that instance is iterated LAST', async () => {
    const redis = new FakeRedis();
    // inst-new (the stale mapping target) seeded FIRST — reversed vs the #768 test.
    await seedInstance(redis, 'inst-new', 'https://new.encore.example');
    await seedInstance(redis, 'inst-old', 'https://old.encore.example');

    await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
    await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');
    await redis.set(keys.jobAttempts('job-x'), '2');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({
        'https://old.encore.example': ['job-x'],
        'https://new.encore.example': []
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // Decision behaviour is still unchanged (#839 is diagnostic-only; #769's
    // behavioural fix stays out of scope).
    expect(dropped).toEqual([{ encoreJobId: 'job-x', reason: undefined }]);

    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    // console.warn is called with a format string + positional args:
    // [format, jobId, keys.jobInstance, reconciledInstance,
    //  foundActiveOnPoolInstances, poolInstancesChecked, poolInstancesUnchecked,
    //  reDispatched].
    const args = diag!.map((a) => String(a));
    expect(args).toContain('job-x');
    // The stale-mapping signature must be reported regardless of seeding order.
    expect(args[4]).toBe('inst-old');
    // Both instances were checked before any classification ran.
    expect(args[5].split(',').sort()).toEqual(['inst-new', 'inst-old']);
  });

  // An instance tracked at activeJobs === 0 is skipped by the classification
  // loop (nothing to correct downward), but it can still be the instance that
  // actually holds the job — the tracked count is precisely what is suspected of
  // being stale. It must therefore be in the index.
  it('indexes an idle-tracked instance that actually still holds the job', async () => {
    const redis = new FakeRedis();
    await redis.hset(
      keys.pool('ws1'),
      'inst-idle-tracked',
      JSON.stringify({
        instanceId: 'inst-idle-tracked',
        url: 'https://idle.encore.example',
        activeJobs: 0, // tracked idle — never fetched under the #768 index
        lastIdleAt: 0
      } satisfies EncoreInstanceRecord)
    );
    await seedInstance(redis, 'inst-mapped', 'https://mapped.encore.example');

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-mapped');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');
    await redis.set(keys.jobAttempts('job-z'), '2');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({
        'https://idle.encore.example': ['job-z'],
        'https://mapped.encore.example': []
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-z', reason: undefined }]);

    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    const args = diag!.map((a) => String(a));
    expect(args[4]).toBe('inst-idle-tracked'); // foundActiveOnPoolInstances
  });

  // An instance whose real state could not be fetched is NOT evidence of
  // absence: "active nowhere in the pool" is only meaningful over the instances
  // we actually checked. The diagnostic must name the unchecked ones so a
  // foundActiveOnPoolInstances=(none) line is interpretable.
  it('names instances whose real state could not be checked this pass', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-mapped', 'https://mapped.encore.example');
    await seedInstance(redis, 'inst-unreachable', 'https://down.encore.example');

    await redis.hset(keys.jobInstance('ws1'), 'job-u', 'inst-mapped');
    await redis.hset(keys.jobStatus('ws1'), 'job-u', 'running');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('https://down.encore.example')) {
          throw new Error('ECONNREFUSED');
        }
        if (url.includes('status=FAILED')) return encorePage([]);
        return encorePage([]);
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-u', reason: undefined }]);

    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    const args = diag!.map((a) => String(a));
    expect(args[4]).toBe('(none)'); // not found active on any CHECKED instance
    expect(args[6]).toContain('inst-unreachable'); // ...but one was unchecked
  });
});
