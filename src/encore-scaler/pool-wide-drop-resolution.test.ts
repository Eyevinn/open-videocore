// #769: reconcile()'s drop classification used to resolve a job's owning instance
// solely from keys.jobInstance — a SINGLE value overwritten on every re-dispatch
// (dispatch: redis.hset(keys.jobInstance, jobId, instanceId)). When that mapping
// went stale, a job Encore was still happily running on another pool instance was
// judged gone from the mapped instance's active set and classified as a silent
// drop (terminal, not retryable), and the drop-reason recovery then warned "no
// reason recovered" for a job that had never failed.
//
// reconcile now builds the pool-wide active index in a FULL pass over every pool
// instance BEFORE any classification, and checks the job's externalId across that
// whole index before concluding it dropped. These tests pin:
//   AC1  a job active on instance B is not judged dropped while reconciling A;
//   AC2  the "drop-reason recovery: ... no reason recovered" warn does not fire
//        for a job still QUEUED/IN_PROGRESS on another instance;
//   #839 the answer is ORDER-INDEPENDENT — pool-hash iteration order is
//        uncontrolled, so the same scenario must resolve identically whichever
//        instance is iterated first (the incremental index this replaces gave a
//        false "active nowhere" when the mapped instance sorted first);
//   a genuine drop (active on no confirmed instance) is still raised unchanged,
//   and an instance whose real state could not be confirmed is reported as
//   UNRESOLVED rather than silently counted as empty.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() two-phase pass + instancesActiveFor() —
//     src/encore-scaler/scaler-loop.ts (reconcile).
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobAttempts / keys.jobCompletionSeen —
//     src/encore-scaler/types.ts:220-259 (`export const keys`).
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt } —
//     src/encore-scaler/types.ts.
//   - DroppedJob { encoreJobId, reason? } + EncoreScalerConfig.onJobsDropped —
//     src/encore-scaler/types.ts:39-42.
//   - Encore findByStatus HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId, message? }] }, page: { totalElements } } — scaler-loop.ts
//     fetchRealActiveState / fetchDroppedFailureReasons (per-instance record.url).

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
  url: string,
  activeJobs = 1
): Promise<number> {
  return redis.hset(
    keys.pool('ws1'),
    instanceId,
    JSON.stringify({
      instanceId,
      url,
      activeJobs,
      lastIdleAt: 0
    } satisfies EncoreInstanceRecord)
  );
}

function encorePage(
  docs: Array<{ externalId: string; message?: string }>
): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: docs },
      page: { totalElements: docs.length }
    })
  } as unknown as Response;
}

// Per-instance active sets keyed by the instance's base url. A url listed in
// `unreachable` answers 503 for every status query, which is how
// fetchRealActiveState reports "real state could not be confirmed" (undefined).
// FAILED pages are always empty here — drop-reason recovery content is covered by
// drop-reason-observability.test.ts; what matters below is only WHETHER it runs.
function fetchMockByUrl(
  activeByUrl: Record<string, string[]>,
  unreachable: string[] = []
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (unreachable.some((u) => url.startsWith(u))) {
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    }
    if (url.includes('status=FAILED')) return encorePage([]);
    const base = Object.keys(activeByUrl).find((u) => url.startsWith(u));
    const active = base ? activeByUrl[base] : [];
    // Model everything active as IN_PROGRESS; QUEUED empty for every instance.
    if (url.includes('status=QUEUED')) return encorePage([]);
    if (url.includes('status=IN_PROGRESS')) {
      return encorePage(active.map((externalId) => ({ externalId })));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const OLD_URL = 'https://old.encore.example';
const NEW_URL = 'https://new.encore.example';

describe('#769: drop resolution checks externalId across all pool instances', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #839: pool-hash iteration order is uncontrolled, so run the identical
  // stale-mapping scenario under BOTH seeding orders. The instance the job is
  // really on (inst-old) sorts after the mapped instance (inst-new) in the second
  // case — exactly the order that made the pre-#769 incremental index report
  // "active nowhere" and classify a false drop.
  for (const order of [
    ['inst-old', 'inst-new'],
    ['inst-new', 'inst-old']
  ] as const) {
    it(`leaves a job running when it is active on another pool instance (seed order: ${order.join(
      ', '
    )})`, async () => {
      const redis = new FakeRedis();
      const urls: Record<string, string> = {
        'inst-old': OLD_URL,
        'inst-new': NEW_URL
      };
      for (const instanceId of order) {
        await seedInstance(redis, instanceId, urls[instanceId]);
      }

      // keys.jobInstance was OVERWRITTEN by the re-dispatch to point at inst-new,
      // but Encore still lists job-x active on inst-old (the re-dispatched copy
      // has not landed on inst-new yet).
      await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
      await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');
      await redis.set(keys.jobAttempts('job-x'), '2');

      vi.stubGlobal(
        'fetch',
        fetchMockByUrl({ [OLD_URL]: ['job-x'], [NEW_URL]: [] })
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dropped: DroppedJob[] = [];
      await new EncoreScalerLoop(
        makeConfig(redis, async (drops) => {
          dropped.push(...drops);
        })
      ).reconcile();

      // AC1: not judged dropped while reconciling the instance it is NOT on.
      expect(dropped).toEqual([]);
      // The local status must stay `running` — no terminal overwrite.
      expect(await redis.hget(keys.jobStatus('ws1'), 'job-x')).toBe('running');

      // AC2: the drop-reason recovery never runs for it, so its "no reason
      // recovered" warn cannot fire.
      const messages = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(
        messages.find(
          (m) => m.includes('drop-reason recovery') && m.includes('no reason recovered')
        )
      ).toBeUndefined();

      // The stale mapping itself is observable. console.warn is called with a
      // format string + positional args, so match the format string and assert the
      // load-bearing values are present as arguments.
      const notDropped = warn.mock.calls.find((c) =>
        String(c[0]).includes('is NOT dropped')
      );
      expect(notDropped).toBeDefined();
      const args = notDropped!.map((a) => String(a));
      expect(args).toContain('job-x');
      expect(args).toContain('inst-new'); // what keys.jobInstance claimed
      expect(args).toContain('inst-old'); // where it is ACTUALLY active
    });
  }

  it('checks instances tracked as idle too — a job active on one is not dropped', async () => {
    const redis = new FakeRedis();
    // inst-idle is tracked at activeJobs=0 (the stale count that goes hand in hand
    // with the stale mapping) yet Encore still reports job-x running on it. Phase 1
    // must fetch it anyway, or the pool-wide answer is wrong.
    await seedInstance(redis, 'inst-new', NEW_URL, 1);
    await seedInstance(redis, 'inst-idle', OLD_URL, 0);

    await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
    await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ [OLD_URL]: ['job-x'], [NEW_URL]: [] })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-x')).toBe('running');
  });

  it('still raises a genuine drop when the job is active on no pool instance', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL);
    await seedInstance(redis, 'inst-b', NEW_URL);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [], [NEW_URL]: [] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-z', reason: undefined }]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-z')).toBe('FAILED');
  });

  it('reports an instance whose real state could not be confirmed as UNRESOLVED, not empty', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL);
    await seedInstance(redis, 'inst-b', NEW_URL);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    // inst-b is unreachable: its active set is UNKNOWN. The drop still goes
    // through (suppressing it on `unknown` would strand jobs behind a permanently
    // unreachable pool entry), but the diagnostic must say visibility was partial.
    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [] }, [NEW_URL]));
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
    expect(String(diag![0])).toContain('poolInstancesUncheckedThisPass=%s');
    const args = diag!.map((a) => String(a));
    // The unchecked list names the instance AND why it could not be confirmed:
    // scaler-loop.ts pushes `${instanceId}(unreachable)` / `(unparseable)` /
    // `(truncated)` rather than the bare id, so the reason survives into the log.
    expect(args).toContain('inst-b(unreachable)'); // the instance we could not confirm
    expect(args).toContain('inst-a'); // the instance we did confirm
    expect(args).toContain('(none)'); // foundActiveOnPoolInstances
  });
});
