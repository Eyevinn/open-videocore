// Regression lock for #770: reconcile() must resolve "is this job still running?"
// against the WHOLE instance pool, never against the single instance
// keys.jobInstance happens to name.
//
// THE SHAPE OF THE BUG (#769). keys.jobInstance is one value per job, written at
// dispatch and OVERWRITTEN on every re-dispatch (scaler-loop.ts dispatch:
// redis.hset(keys.jobInstance(workspaceId), encoreJobId, instanceId)). A job
// dispatched to instance A and then re-dispatched onto instance B therefore has a
// mapping that can name either one while Encore runs it on the other. The pre-fix
// classification asked only `activeExternalIds.has(jobId)` — the active set of the
// mapped instance — so "gone from the mapped instance" was read as "gone from the
// pool", and a healthy job was written terminally FAILED (non-retryable), with the
// drop-reason recovery then warning "no reason recovered" for a job that had never
// failed.
//
// WHAT THIS FILE PINS, AND WHY IT IS NOT A DUPLICATE. pool-wide-drop-resolution
// .test.ts covers the fix from the other direction (mapping names the re-dispatch
// target, the job is still on the older instance) plus truncation, repair and the
// partial-visibility gate. #770 asks for a lock on the pool-wide LOOKUP itself, so
// this file:
//   1. runs the issue's own scenario — dispatched to A, re-dispatched and running
//      on B, mapping still naming A;
//   2. makes the non-drop verdict attributable ONLY to positive pool-wide
//      evidence: the whole pool is reachable, untruncated and probed, so the
//      #769 partial-visibility gate (which also withholds drops) cannot be what
//      produced the pass — a test that passed via that gate would keep passing
//      after a regression to the single-instance lookup;
//   3. puts the real holder LAST in pool-hash order and tracked idle, so neither
//      iteration order nor the activeJobs === 0 skip can be what found it;
//   4. keeps a negative control in the same fixture: a job active on NO instance
//      of the same fully-visible pool is still dropped, so 1-3 cannot pass by the
//      drop path having become unreachable.
// Test 3 additionally pins that pass 1 enumerates every pool entry BEFORE
// classification reads the mapping — the pool-wide check can only be as wide as
// the index it answers over, so narrowing the enumeration would hollow out 1-2
// without failing them.
//
// Tests 1, 2 and 4 fail against the pre-fix single-instance lookup: with
// `activeElsewhere` unavailable (or emptied), job-redispatched is classified
// dropped, onJobsDropped fires and keys.jobStatus is overwritten FAILED — each of
// which is asserted against here.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - EncoreScalerLoop.reconcile() — src/encore-scaler/scaler-loop.ts:819. Pass 1
//     pool enumeration src/encore-scaler/scaler-loop.ts:899-947; the pool-wide
//     lookup instancesActiveFor() src/encore-scaler/scaler-loop.ts:954-960; the
//     load-bearing "active anywhere => not dropped" branch
//     src/encore-scaler/scaler-loop.ts:1121-1205; classification's mapping read
//     `redis.hgetall(keys.jobInstance(workspaceId))`
//     src/encore-scaler/scaler-loop.ts:1090; the drop raise
//     src/encore-scaler/scaler-loop.ts:1319 (jobStatus FAILED) and :1440-1442
//     (onJobsDropped).
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobAttempts — `export const keys`, src/encore-scaler/types.ts:260-266
//     and keys.jobAttempts src/encore-scaler/types.ts:317.
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt } and
//     DroppedJob { encoreJobId, reason? } + EncoreScalerConfig.onJobsDropped —
//     src/encore-scaler/types.ts.
//   - Active-state query + response reader: fetchEncoreActiveState / ACTIVE_PAGE_SIZE
//     — src/encore-scaler/encore-active-state.ts:67-129, which builds its URLs with
//     buildFindByStatusUrl and reads its bodies with readEncoreJobPage /
//     isTruncatedPage — src/encore-scaler/encore-paging-contract.ts:153-200. The
//     wire shape ({ _embedded: { encoreJobs: [{ externalId }] }, _links, page: {
//     size, totalElements, totalPages, number } }) is recorded as data in
//     docs/contracts/encore-findbystatus-paging.json and pinned by
//     test/encore-findbystatus-contract.test.ts — this file does not restate it.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_PAGE_SIZE } from './encore-active-state.js';
import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

const WS = 'ws1';

// Instance base urls. The pool-hash field name (inst-a…inst-d) and the url are
// kept aligned so a trace entry is readable, but nothing under test derives one
// from the other — reconcile only ever fetches record.url.
const URL_A = 'https://a.encore.example';
const URL_B = 'https://b.encore.example';
const URL_C = 'https://c.encore.example';
const URL_D = 'https://d.encore.example';

// In-memory stand-in for the subset of ioredis reconcile() touches: hash ops for
// keys.pool / keys.jobInstance / keys.jobStatus, plus string get/set/del for
// keys.jobAttempts / keys.jobCompletionSeen / keys.partialVisibilityDropPasses.
// Mirrors the FakeRedis in pool-wide-drop-resolution.test.ts, with one addition:
// every operation is appended to a shared trace so test 3 can assert ORDER
// between redis reads and Encore probes.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();

  constructor(private readonly trace: string[] = []) {}

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.trace.push(`redis:hgetall:${key}`);
    return Object.fromEntries(this.hash(key));
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.trace.push(`redis:hset:${key}`);
    this.hash(key).set(field, value);
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async get(key: string): Promise<string | null> {
    this.trace.push(`redis:get:${key}`);
    return this.strings.get(key) ?? null;
  }

  // reconcile writes the #769 partial-visibility counter as set(key, value, 'PX',
  // ms); the extra args are irrelevant in memory but the signature has to accept
  // them.
  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }
}

function makeConfig(
  redis: FakeRedis,
  onJobsDropped?: (drops: DroppedJob[]) => Promise<void>
): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 8,
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
  activeJobs: number
): Promise<number> {
  return redis.hset(
    keys.pool(WS),
    instanceId,
    JSON.stringify({
      instanceId,
      url,
      activeJobs,
      lastIdleAt: 0
    } satisfies EncoreInstanceRecord)
  );
}

// A complete (non-truncated) findByStatus page: page.totalElements equals the
// documents returned, and no `next` link — the two readings isTruncatedPage()
// ORs. Every instance in this file answers completely on purpose: a truncated or
// unreachable instance would make pool visibility PARTIAL and route the drop
// through the #769 withholding gate, which is exactly the "passes for the wrong
// reason" hazard these tests are built to exclude.
function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      _links: {
        self: { href: 'https://encore.example/encoreJobs/search/findByStatus?page=0' }
      },
      page: {
        size: ACTIVE_PAGE_SIZE,
        totalElements: externalIds.length,
        totalPages: 1,
        number: 0
      }
    })
  } as unknown as Response;
}

// Every instance is reachable and answers a complete page. `activeByUrl` lists the
// externalIds Encore reports IN_PROGRESS per instance base url; QUEUED and FAILED
// are empty everywhere (drop-reason content is drop-reason-observability.test.ts's
// subject — here only WHETHER a drop is raised matters).
function fetchMockByUrl(
  activeByUrl: Record<string, string[]>,
  trace: string[] = []
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    trace.push(`fetch:${url}`);
    if (url.includes('status=FAILED')) return encorePage([]);
    if (url.includes('status=QUEUED')) return encorePage([]);
    if (url.includes('status=IN_PROGRESS')) {
      const base = Object.keys(activeByUrl).find((u) => url.startsWith(u));
      return encorePage(base ? activeByUrl[base] : []);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function readPoolRecord(
  redis: FakeRedis,
  instanceId: string
): Promise<EncoreInstanceRecord> {
  return redis
    .hget(keys.pool(WS), instanceId)
    .then((raw) => JSON.parse(raw!) as EncoreInstanceRecord);
}

// The base urls an active-state probe was issued against this pass, deduplicated.
// Also asserts each probe is the page-0 / size=ACTIVE_PAGE_SIZE query the recorded
// contract describes, so "probed" cannot be satisfied by some other request.
function probedBaseUrls(trace: string[], expectedBases: string[]): Set<string> {
  const probed = new Set<string>();
  for (const entry of trace) {
    if (!entry.startsWith('fetch:')) continue;
    const url = entry.slice('fetch:'.length);
    if (!url.includes('status=QUEUED') && !url.includes('status=IN_PROGRESS')) continue;
    expect(url).toContain('page=0');
    expect(url).toContain(`size=${ACTIVE_PAGE_SIZE}`);
    const base = expectedBases.find((u) => url.startsWith(u));
    if (base) probed.add(base);
  }
  return probed;
}

describe('#770 regression: reconcile checks the whole pool before calling a job dropped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves a job dispatched to A and re-dispatched onto B running, on positive pool-wide evidence alone', async () => {
    const trace: string[] = [];
    const redis = new FakeRedis(trace);
    // inst-a: the original dispatch target, still tracked as holding the job.
    // inst-b: where the re-dispatch actually landed and where Encore runs it.
    // inst-c: unrelated busy instance — the pool is not just "mapped + holder".
    await seedInstance(redis, 'inst-a', URL_A, 1);
    await seedInstance(redis, 'inst-b', URL_B, 1);
    await seedInstance(redis, 'inst-c', URL_C, 1);

    // The mapping still names the FIRST dispatch target (the re-dispatch's hset
    // raced/was lost), and the job is locally `running` — the drop candidate
    // filter at scaler-loop.ts:1099-1100 admits RUNNING/QUEUED only.
    await redis.hset(keys.jobInstance(WS), 'job-redispatched', 'inst-a');
    await redis.hset(keys.jobStatus(WS), 'job-redispatched', 'running');
    // attempts > 1 is what makes this a re-dispatch rather than a first dispatch.
    await redis.set(keys.jobAttempts('job-redispatched'), '2');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl(
        {
          [URL_A]: [], // gone from the MAPPED instance — the pre-fix drop trigger
          [URL_B]: ['job-redispatched'], // …but alive here
          [URL_C]: ['job-unrelated']
        },
        trace
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const onJobsDropped = vi.fn(async (_drops: DroppedJob[]) => {});
    await new EncoreScalerLoop(makeConfig(redis, onJobsDropped)).reconcile();

    // AC: the job is not classified dropped. Asserted at the hook (nothing is
    // raised at all, not merely "raised without this id") and at the durable
    // side effect the drop path performs (scaler-loop.ts:1319).
    expect(onJobsDropped).not.toHaveBeenCalled();
    expect(await redis.hget(keys.jobStatus(WS), 'job-redispatched')).toBe('running');

    // The verdict came from POSITIVE pool-wide evidence, not from #769's
    // partial-visibility withholding gate: no instance was withheld on, and the
    // diagnostic reports the unchecked list as empty. Without this pair, a
    // regression to the single-instance lookup could still pass this test by
    // having the drop merely deferred.
    expect(
      warn.mock.calls.find((c) => String(c[0]).includes('WITHHOLDING drop'))
    ).toBeUndefined();
    const notDropped = warn.mock.calls.find((c) =>
      String(c[0]).includes('is NOT dropped')
    );
    expect(notDropped).toBeDefined();
    const args = notDropped!.map((a) => String(a));
    expect(args).toContain('job-redispatched');
    expect(args).toContain('inst-a'); // what keys.jobInstance claimed
    expect(args).toContain('inst-b'); // where Encore really reports it active
    expect(args).toContain('(none)'); // poolInstancesUncheckedThisPass — full view

    // Every pool instance was actually asked, so "checked the pool" is a fact
    // about the requests made and not only about the outcome.
    expect(probedBaseUrls(trace, [URL_A, URL_B, URL_C])).toEqual(
      new Set([URL_A, URL_B, URL_C])
    );

    // The pool-wide answer also identifies the real owner, so the divergence does
    // not recur every tick (scaler-loop.ts:1162-1170).
    expect(await redis.hget(keys.jobInstance(WS), 'job-redispatched')).toBe('inst-b');
  });

  it('finds the holder even when it sorts last in the pool hash and is tracked idle', async () => {
    const trace: string[] = [];
    const redis = new FakeRedis(trace);
    // The real holder is seeded LAST and tracked at activeJobs === 0 — the two
    // ways an instance historically fell out of the lookup: iteration order (the
    // index used to be built incrementally) and the pass-2 idle skip
    // (scaler-loop.ts:1034). Pass 1 must probe it regardless.
    await seedInstance(redis, 'inst-a', URL_A, 1);
    await seedInstance(redis, 'inst-b', URL_B, 1);
    await seedInstance(redis, 'inst-c', URL_C, 1);
    await seedInstance(redis, 'inst-d', URL_D, 0);

    await redis.hset(keys.jobInstance(WS), 'job-redispatched', 'inst-a');
    await redis.hset(keys.jobStatus(WS), 'job-redispatched', 'running');
    await redis.set(keys.jobAttempts('job-redispatched'), '2');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl(
        {
          [URL_A]: [],
          [URL_B]: ['job-other-1'],
          [URL_C]: ['job-other-2'],
          [URL_D]: ['job-redispatched']
        },
        trace
      )
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const onJobsDropped = vi.fn(async (_drops: DroppedJob[]) => {});
    await new EncoreScalerLoop(makeConfig(redis, onJobsDropped)).reconcile();

    expect(onJobsDropped).not.toHaveBeenCalled();
    expect(await redis.hget(keys.jobStatus(WS), 'job-redispatched')).toBe('running');
    expect(await redis.hget(keys.jobInstance(WS), 'job-redispatched')).toBe('inst-d');
    // The idle-tracked holder's count is corrected to Encore's, so dispatch stops
    // treating it as free capacity (scaler-loop.ts:1405-1427).
    expect((await readPoolRecord(redis, 'inst-d')).activeJobs).toBe(1);
    expect(probedBaseUrls(trace, [URL_A, URL_B, URL_C, URL_D])).toEqual(
      new Set([URL_A, URL_B, URL_C, URL_D])
    );
  });

  // Supporting pin (ordering, #839 — this one does NOT fail against the
  // single-instance lookup): the pool-wide check can only be as wide as the index
  // it answers over. If a future change moved the active-state probe back inside
  // the classification loop, or narrowed pass 1 to the mapped instance, the
  // lookup above would still be called and still return "nowhere" — hollowing out
  // tests 1 and 2 without failing them. Classification's first act is reading the
  // mapping (scaler-loop.ts:1090), so "every probe precedes that read" is the
  // observable form of "the index was complete before any classification".
  it('probes every pool instance before classification reads keys.jobInstance', async () => {
    const trace: string[] = [];
    const redis = new FakeRedis(trace);
    await seedInstance(redis, 'inst-a', URL_A, 1);
    await seedInstance(redis, 'inst-b', URL_B, 1);
    await seedInstance(redis, 'inst-c', URL_C, 1);

    await redis.hset(keys.jobInstance(WS), 'job-redispatched', 'inst-a');
    await redis.hset(keys.jobStatus(WS), 'job-redispatched', 'running');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl(
        {
          [URL_A]: [],
          [URL_B]: ['job-redispatched'],
          [URL_C]: ['job-unrelated']
        },
        trace
      )
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await new EncoreScalerLoop(makeConfig(redis)).reconcile();

    // The seeding hsets happen before reconcile runs, so slice the trace at the
    // pool read reconcile opens with (scaler-loop.ts:822).
    const poolRead = trace.indexOf(`redis:hgetall:${keys.pool(WS)}`);
    expect(poolRead).toBeGreaterThanOrEqual(0);
    const pass = trace.slice(poolRead);

    const firstMappingRead = pass.indexOf(`redis:hgetall:${keys.jobInstance(WS)}`);
    expect(firstMappingRead).toBeGreaterThan(0);
    expect(probedBaseUrls(pass.slice(0, firstMappingRead), [URL_A, URL_B, URL_C])).toEqual(
      new Set([URL_A, URL_B, URL_C])
    );
  });

  // Negative control in the SAME fixture: the assertions above must be
  // discriminating, i.e. this pool and harness can still produce a drop. Without
  // it, deleting the drop path outright would turn tests 1-2 green.
  it('still drops a job the fully-visible pool reports active nowhere', async () => {
    const trace: string[] = [];
    const redis = new FakeRedis(trace);
    await seedInstance(redis, 'inst-a', URL_A, 1);
    await seedInstance(redis, 'inst-b', URL_B, 1);
    await seedInstance(redis, 'inst-c', URL_C, 1);

    await redis.hset(keys.jobInstance(WS), 'job-vanished', 'inst-a');
    await redis.hset(keys.jobStatus(WS), 'job-vanished', 'running');
    await redis.set(keys.jobAttempts('job-vanished'), '2');

    vi.stubGlobal(
      'fetch',
      fetchMockByUrl({ [URL_A]: [], [URL_B]: [], [URL_C]: ['job-unrelated'] }, trace)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // Encore reports it on none of the three instances and all three answered,
    // so the drop is decided on a COMPLETE view and lands on this pass.
    expect(dropped).toEqual([{ encoreJobId: 'job-vanished', reason: undefined }]);
    expect(await redis.hget(keys.jobStatus(WS), 'job-vanished')).toBe('FAILED');
    expect(
      warn.mock.calls.find((c) => String(c[0]).includes('WITHHOLDING drop'))
    ).toBeUndefined();

    const diag = warn.mock.calls.find((c) =>
      String(c[0]).includes('drop-diagnostic (#768)')
    );
    expect(diag).toBeDefined();
    const diagArgs = diag!.map((a) => String(a));
    expect(diagArgs).toContain('job-vanished');
    // foundActiveOnPoolInstances AND poolInstancesUncheckedThisPass are both
    // (none): active nowhere, and nowhere unread — the only state in which this
    // classification is sound.
    expect(diagArgs.filter((a) => a === '(none)')).toHaveLength(2);
    expect(probedBaseUrls(trace, [URL_A, URL_B, URL_C])).toEqual(
      new Set([URL_A, URL_B, URL_C])
    );
  });
});
