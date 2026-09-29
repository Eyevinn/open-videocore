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

import {
  ACTIVE_PAGE_SIZE,
  fetchEncoreActiveState
} from './encore-active-state.js';
import {
  EncoreScalerLoop,
  PARTIAL_VISIBILITY_DROP_PASSES
} from './scaler-loop.js';
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

  // reconcile writes the #769 partial-visibility counter with a PX TTL; the
  // extra args are irrelevant to an in-memory stand-in but the signature has to
  // accept them.
  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const had = this.strings.delete(key);
    return had ? 1 : 0;
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

// A findByStatus page. `totalElements` is EXPLICIT rather than derived from
// `docs.length` so a TRUNCATED page — Encore reporting more active jobs than the
// one page it returned — can be modelled at all (#769 review finding 3: the old
// helper hardcoded totalElements = docs.length, so `truncated` was false in every
// test and the entire truncation path was unreachable).
//
// The `_links` set mirrors the recorded contract: Spring HATEOAS'
// PagedResourcesAssembler adds `next` (and `first`/`last`) if and only if the
// page has more — docs/contracts/encore-findbystatus-paging.json
// `truncation.rule` + `recordedResponses`.
function encorePage(
  docs: Array<{ externalId: string; message?: string }>,
  options: { totalElements?: number } = {}
): Response {
  const totalElements = options.totalElements ?? docs.length;
  const truncated = totalElements > docs.length;
  const links: Record<string, { href: string }> = {
    self: { href: 'https://encore.example/encoreJobs/search/findByStatus?page=0' }
  };
  if (truncated) {
    links.first = { href: 'https://encore.example/encoreJobs/search/findByStatus?page=0' };
    links.next = { href: 'https://encore.example/encoreJobs/search/findByStatus?page=1' };
    links.last = { href: 'https://encore.example/encoreJobs/search/findByStatus?page=1' };
  }
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: docs },
      _links: links,
      page: {
        size: ACTIVE_PAGE_SIZE,
        totalElements,
        totalPages: truncated ? 2 : 1,
        number: 0
      }
    })
  } as unknown as Response;
}

// Per-instance active sets keyed by the instance's base url. A url listed in
// `unreachable` answers 503 for every status query, which is how
// fetchRealActiveState reports "real state could not be confirmed" (undefined).
// A url present in `totalElementsByUrl` reports that many IN_PROGRESS jobs in
// total while still returning only the documents in `activeByUrl` — i.e. a
// truncated page.
// FAILED pages are always empty here — drop-reason recovery content is covered by
// drop-reason-observability.test.ts; what matters below is only WHETHER it runs.
function fetchMockByUrl(
  activeByUrl: Record<string, string[]>,
  unreachable: string[] = [],
  totalElementsByUrl: Record<string, number> = {}
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
      const totalKey = Object.keys(totalElementsByUrl).find((u) => url.startsWith(u));
      return encorePage(
        active.map((externalId) => ({ externalId })),
        totalKey ? { totalElements: totalElementsByUrl[totalKey] } : {}
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const OLD_URL = 'https://old.encore.example';
const NEW_URL = 'https://new.encore.example';
const BIG_URL = 'https://big.encore.example';

function readPoolRecord(
  redis: FakeRedis,
  instanceId: string
): Promise<EncoreInstanceRecord> {
  return redis
    .hget(keys.pool('ws1'), instanceId)
    .then((raw) => JSON.parse(raw!) as EncoreInstanceRecord);
}

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

    // inst-b is unreachable: its active set is UNKNOWN. The drop is not decided
    // on that partial view in one pass (#769 review finding 4 — see the
    // partial-visibility describe block below), but once it IS decided the
    // diagnostic must say visibility was partial and name who was missing.
    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [] }, [NEW_URL]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    const loop = new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    );
    for (let pass = 0; pass < PARTIAL_VISIBILITY_DROP_PASSES; pass += 1) {
      await loop.reconcile();
    }

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

// #769 review finding 2 + 3: the truncation guard is what stops a partial
// externalId set being read as "these jobs vanished". Until now no test could
// reach it — the page helper derived totalElements from the documents it
// returned, so `truncated` was false everywhere.
describe('#769: page-0 truncation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports truncated when Encore reports more active jobs than it returned, and asks for the clamp page size', async () => {
    const fetchMock = fetchMockByUrl({ [BIG_URL]: ['job-1'] }, [], {
      [BIG_URL]: 7
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = await fetchEncoreActiveState(BIG_URL, 'test-token');

    expect(state).toBeDefined();
    expect(state!.truncated).toBe(true);
    // page.totalElements is the ALL-PAGES total, so the count stays exact even
    // though the externalId set does not.
    expect(state!.count).toBe(7);
    expect(state!.activeExternalIds).toEqual(new Set(['job-1']));

    // Every active-state query asks for the recorded clamp, not the default 10.
    const requested = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(requested).toHaveLength(2);
    for (const url of requested) {
      expect(url).toContain(`size=${ACTIVE_PAGE_SIZE}`);
      expect(url).toContain('page=0');
    }
    expect(requested.some((u) => u.includes('status=QUEUED'))).toBe(true);
    expect(requested.some((u) => u.includes('status=IN_PROGRESS'))).toBe(true);
  });

  it('reports truncated=false when every active job fitted on the page', async () => {
    vi.stubGlobal('fetch', fetchMockByUrl({ [BIG_URL]: ['job-1', 'job-2'] }));

    const state = await fetchEncoreActiveState(BIG_URL, 'test-token');

    expect(state).toBeDefined();
    expect(state!.truncated).toBe(false);
    expect(state!.count).toBe(2);
  });

  it('names a truncated instance unchecked and skips its drop diff, but still corrects its count', async () => {
    const redis = new FakeRedis();
    // inst-big is tracked at 9 jobs. Encore says 4 are active but only returns
    // one document — the other three are off page 0. job-hidden is one of them.
    await seedInstance(redis, 'inst-big', BIG_URL, 9);

    await redis.hset(keys.jobInstance('ws1'), 'job-hidden', 'inst-big');
    await redis.hset(keys.jobStatus('ws1'), 'job-hidden', 'running');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ [BIG_URL]: ['job-visible'] }, [], { [BIG_URL]: 4 })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // The diff that would have called job-hidden dropped is withheld entirely.
    expect(dropped).toEqual([]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-hidden')).toBe('running');

    // The skip is reported, naming the instance and the page size we asked for.
    const truncWarn = warn.mock.calls.find((c) =>
      String(c[0]).includes('TRUNCATED active')
    );
    expect(truncWarn).toBeDefined();
    const truncArgs = truncWarn!.map((a) => String(a));
    expect(truncArgs).toContain('inst-big');
    expect(truncArgs).toContain(String(ACTIVE_PAGE_SIZE));

    // ...and the count correction still runs, because page.totalElements is
    // exact whether or not the document list is complete.
    expect((await readPoolRecord(redis, 'inst-big')).activeJobs).toBe(4);
  });

  it('names a truncated instance in poolInstancesUncheckedThisPass', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL, 1);
    await seedInstance(redis, 'inst-big', BIG_URL, 9);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ [OLD_URL]: [], [BIG_URL]: ['job-other'] }, [], {
        [BIG_URL]: 4
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    const loop = new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    );
    // A truncated instance makes pool visibility PARTIAL, so job-z's drop takes
    // the full gate to land (#769 review finding 4).
    for (let pass = 0; pass < PARTIAL_VISIBILITY_DROP_PASSES; pass += 1) {
      await loop.reconcile();
    }

    expect(dropped).toEqual([{ encoreJobId: 'job-z', reason: undefined }]);
    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    expect(diag!.map((a) => String(a))).toContain('inst-big(truncated)');
  });
});

// #769 review finding 3: the branch that REPAIRS the divergence it detects. A
// suppression that leaves keys.jobInstance pointing at the wrong instance and
// the real holder advertising capacity it does not have would re-fire, and keep
// mis-dispatching, every tick for the job's lifetime.
describe('#769: divergence repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('repoints keys.jobInstance at the instance actually running the job', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-new', NEW_URL, 1);
    await seedInstance(redis, 'inst-old', OLD_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
    await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');

    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: ['job-x'], [NEW_URL]: [] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await new EncoreScalerLoop(makeConfig(redis)).reconcile();

    // The mapping now names the real holder, so the next pass reconciles job-x
    // against inst-old and the stale-mapping branch does not re-fire.
    expect(await redis.hget(keys.jobInstance('ws1'), 'job-x')).toBe('inst-old');

    const notDropped = warn.mock.calls.find((c) =>
      String(c[0]).includes('is NOT dropped')
    );
    expect(notDropped).toBeDefined();
    // jobInstanceRepairedTo is the last positional arg.
    expect(String(notDropped![notDropped!.length - 1])).toBe('inst-old');
  });

  it('corrects the real holder’s tracked activeJobs to Encore’s count after a repair', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-new', NEW_URL, 1);
    // inst-old is tracked idle — the stale count that goes with the stale
    // mapping. Pass 2 skips activeJobs === 0 instances, so only the TARGETED
    // post-pass-2 repair loop can fix this.
    await seedInstance(redis, 'inst-old', OLD_URL, 0);

    await redis.hset(keys.jobInstance('ws1'), 'job-x', 'inst-new');
    await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');

    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: ['job-x'], [NEW_URL]: [] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await new EncoreScalerLoop(makeConfig(redis)).reconcile();

    expect((await readPoolRecord(redis, 'inst-old')).activeJobs).toBe(1);
    expect(
      warn.mock.calls.find((c) =>
        String(c[0]).includes('after a keys.jobInstance repair')
      )
    ).toBeDefined();
  });

  it('leaves the mapping alone and reports a duplicate dispatch when two instances report the same externalId', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-mapped', BIG_URL, 1);
    await seedInstance(redis, 'inst-one', OLD_URL, 1);
    await seedInstance(redis, 'inst-two', NEW_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-dup', 'inst-mapped');
    await redis.hset(keys.jobStatus('ws1'), 'job-dup', 'running');

    // BOTH inst-one and inst-two report job-dup active.
    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({
        [BIG_URL]: [],
        [OLD_URL]: ['job-dup'],
        [NEW_URL]: ['job-dup']
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // Still not dropped — it is demonstrably alive.
    expect(dropped).toEqual([]);
    // ...but the mapping is NOT guessed at: an owner picked at random would hide
    // the duplicate dispatch, which is a different bug.
    expect(await redis.hget(keys.jobInstance('ws1'), 'job-dup')).toBe('inst-mapped');

    const dup = warn.mock.calls.find((c) =>
      String(c[0]).includes('MORE THAN ONE')
    );
    expect(dup).toBeDefined();
    const dupArgs = dup!.map((a) => String(a));
    expect(dupArgs).toContain('job-dup');
    expect(dupArgs.some((a) => a.split(',').sort().join(',') === 'inst-one,inst-two')).toBe(
      true
    );

    const notDropped = warn.mock.calls.find((c) =>
      String(c[0]).includes('is NOT dropped')
    );
    expect(String(notDropped![notDropped!.length - 1])).toBe('(not-repaired)');
  });
});

// #769 review finding 4: "active on none of the instances we could READ" is only
// the same statement as "active nowhere in the pool" when we could read them
// all. While any instance is unreachable, unparseable or truncated, a job that
// looks dropped may be running on the instance we could not see — the exact
// false-drop class #769 exists to fix, merely relocated from a stale mapping to
// a blind spot. The drop is therefore withheld and re-examined, and only becomes
// terminal after PARTIAL_VISIBILITY_DROP_PASSES consecutive such passes so a
// permanently unreachable pool entry cannot strand jobs in `running` forever.
describe('#769: a drop decided under partial pool visibility is withheld first', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fail a job on the first pass while a pool instance is unreadable', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL, 1);
    await seedInstance(redis, 'inst-b', NEW_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [] }, [NEW_URL]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-z')).toBe('running');

    const withheld = warn.mock.calls.find((c) =>
      String(c[0]).includes('WITHHOLDING drop')
    );
    expect(withheld).toBeDefined();
    expect(withheld!.map((a) => String(a))).toContain('inst-b(unreachable)');

    // The tracked count must stay high, or the next pass sees tracked === actual,
    // skips classification altogether, and the withheld job is stranded.
    expect((await readPoolRecord(redis, 'inst-a')).activeJobs).toBe(1);
  });

  it('suppresses the drop permanently once the unreadable instance answers and owns the job', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL, 1);
    await seedInstance(redis, 'inst-b', NEW_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    // Pass 1: inst-b is down, so nothing can prove where job-z is.
    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [] }, [NEW_URL]));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    const loop = new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    );
    await loop.reconcile();
    expect(dropped).toEqual([]);

    // Pass 2: inst-b is back, and it was running job-z all along.
    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ [OLD_URL]: [], [NEW_URL]: ['job-z'] })
    );
    await loop.reconcile();

    expect(dropped).toEqual([]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-z')).toBe('running');
    // The mapping is repaired onto the instance that really holds it.
    expect(await redis.hget(keys.jobInstance('ws1'), 'job-z')).toBe('inst-b');
    // ...and the counter is cleared, so a later genuine drop is not fast-tracked
    // by a stale count from this episode.
    expect(await redis.get(keys.partialVisibilityDropPasses('job-z'))).toBeNull();
  });

  it('lets the drop land after the bounded number of consecutive partial-visibility passes', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL, 1);
    await seedInstance(redis, 'inst-b', NEW_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    // inst-b stays down for good.
    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [] }, [NEW_URL]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    const loop = new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    );
    for (let pass = 0; pass < PARTIAL_VISIBILITY_DROP_PASSES; pass += 1) {
      await loop.reconcile();
    }

    expect(dropped).toEqual([{ encoreJobId: 'job-z', reason: undefined }]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-z')).toBe('FAILED');
    // The gate's counter is cleared once the drop is raised.
    expect(await redis.get(keys.partialVisibilityDropPasses('job-z'))).toBeNull();
    // The operator log says the drop was taken on a degraded view, not a clean one.
    expect(
      warn.mock.calls.find((c) =>
        String(c[0]).includes('consecutive passes with only PARTIAL pool')
      )
    ).toBeDefined();
    // With the job settled, the deferred count correction finally runs.
    expect((await readPoolRecord(redis, 'inst-a')).activeJobs).toBe(0);
  });

  it('decides immediately when the whole pool was visible', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', OLD_URL, 1);
    await seedInstance(redis, 'inst-b', NEW_URL, 1);

    await redis.hset(keys.jobInstance('ws1'), 'job-z', 'inst-a');
    await redis.hset(keys.jobStatus('ws1'), 'job-z', 'running');

    vi.stubGlobal('fetch', fetchMockByUrl({ [OLD_URL]: [], [NEW_URL]: [] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-z', reason: undefined }]);
    expect(
      warn.mock.calls.find((c) => String(c[0]).includes('WITHHOLDING drop'))
    ).toBeUndefined();
  });
});
