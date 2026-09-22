// Integration test for the full success-then-drop FALSE-POSITIVE sequence
// (issue #710, lineage #677/#703; prerequisite fixes #707/#708/#709).
//
// This is the END-TO-END complement to the three per-fix unit tests already in
// this directory:
//   - poller-terminal-jobstatus.regression.test.ts (#707): poller stamps a
//     TERMINAL keys.jobStatus + hdel keys.jobInstance so reconcile's guard 2
//     short-circuits a completed job.
//   - reconcile-grace-period.test.ts (#708): reconcile skips a job whose
//     keys.jobCompletionSeen timestamp is within the grace window.
//   - scaler-dropped-settle.regression.test.ts (#709): the gone-from-active-set
//     settle is conditional/reversible.
//
// Each of those exercises ONE fix in isolation. Issue #710 wires all three
// together into a SINGLE deterministic test that drives the exact production
// ordering observed 2026-09-18 (workspace testsimon, BETA):
//
//   1. Encore completes the job successfully — it leaves the instance's live
//      QUEUED/IN_PROGRESS set (Encore no longer reports it active).
//   2. ScalerLoop.reconcile() fires (a simulated tick) WHILE the poller is
//      mid-settle — AFTER the poller has begun the success path but BEFORE it
//      has decremented record.activeJobs. This is the ~4.4s window the race
//      lived in: reconcile sees tracked activeJobs (still stale > 0) > actual
//      (0, the job left the active set) and runs its dropped-job diff.
//   3. The callback poller finishes processing the SUCCESSFUL message
//      (decrement, terminal settle).
//
// Assertion: the job settles as SUCCEEDED (durable status `done`), and
// onJobsDropped is NEVER raised for it — so main.ts never emits the
// "dropped by Encore" false-positive that permanently failed a succeeded job.
//
// Determinism: no real timers gate the ordering. The interleaved reconcile tick
// is fired synchronously from a HOOK on the fake Valkey, immediately BEFORE the
// poller's decrementActiveJobs pool-write lands (encore-callback-poller.ts:322) —
// the exact race point in the issue. That write exists in BOTH the patched and
// the unpatched af5ef705 code, so the anchor reproduces the race regardless of
// which fix writes precede it. At that instant the pool still shows the stale
// activeJobs=1 (the decrement has not landed), so reconcile's drop diff (guard 1:
// actual=0 < tracked=1) genuinely RUNS. On af5ef705 the poller had not yet
// stamped a terminal keys.jobStatus / hdel'd keys.jobInstance / written
// keys.jobCompletionSeen, so that diff raised the completed job as dropped; with
// #707/#708/#709 those writes precede this point and reconcile is a clean no-op —
// which is why this test fails on the unpatched code and passes with the fixes.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Poller success path ordering — src/pipeline/encore-callback-poller.ts:
//       * hset keys.jobStatus=SUCCESSFUL + hdel keys.jobInstance FIRST
//         (encore-callback-poller.ts:449-450), before completeTranscode.
//       * stamp keys.jobCompletionSeen (PX TTL) BEFORE decrementActiveJobs
//         (encore-callback-poller.ts:597-602, 610), then del it after
//         (encore-callback-poller.ts:614).
//       * decrementActiveJobs(redis, externalId, logger, knownInstanceId)
//         (encore-callback-poller.ts:296-326).
//   - startEncoreCallbackPoller(deps: PollerDeps): () => void; PollerDeps =
//     { redis, jobRepository, assetRepository, pipelineRepository?, oscContext,
//       queueKey?, reconcileGraceMs?, ... } — encore-callback-poller.ts:86-117,
//       1009. Success maps the durable Job to status `done` (verified by
//       poller-terminal-jobstatus.regression.test.ts:240,294).
//   - EncoreScalerLoop.reconcile() dropped-job diff + guards + grace window —
//     src/encore-scaler/scaler-loop.ts:515-677 (guard 1 actualCount<activeJobs
//     at :570; guard 2 terminal-status skip at :591-592; grace-window check via
//     keys.jobCompletionSeen at :599-610; onJobsDropped raise at :666-676).
//   - fetchRealActiveState hits /encoreJobs/search/findByStatus?status=QUEUED
//     and status=IN_PROGRESS returning a Spring HATEOAS page
//     { _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } } —
//     scaler-loop.ts:311-325 (verified against SVT Encore, 2026-07-07 in
//     reconcile-dropped-jobs.test.ts).
//   - onJobsDropped signature (drops: DroppedJob[]) => Promise<void>,
//     DroppedJob = { encoreJobId, reason? } — src/encore-scaler/types.ts:39-42,
//     133.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobCompletionSeen / keys.uuidToExternalId / keys.jobEncoreUrl —
//     src/encore-scaler/types.ts:205-252.
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt } —
//     types.ts:146-183.
//   - encodeEncoreJobId(workspaceId, jobLocalId) — src/data/job-repo.ts:287-289.
//   - InMemory{Job,Asset,Pipeline}Repository — src/data/{job,asset,pipeline}-repo.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startEncoreCallbackPoller } from '../pipeline/encore-callback-poller.js';
import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from './types.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';

// In-memory Valkey stand-in covering BOTH the poller's command surface (string
// get/set/del, hash get/set/getall/del, sorted-set zadd/zscore/zrem/
// zrangebyscore/bzpopmin, set sadd/srem/scard/pexpire, keys, duplicate/on/
// disconnect for the blocking loop) AND reconcile()'s (hgetall/hget/hset/get).
// Mirrors the FakeRedis in poller-terminal-jobstatus.regression.test.ts so both
// files exercise the same real modules without OSC or a live Valkey.
//
// Extension over that FakeRedis: an optional `beforeHset` hook so the test can
// fire the interleaved reconcile tick at the exact moment — and only the moment —
// the poller is ABOUT to write the DECREMENTED pool record (decrementActiveJobs,
// encore-callback-poller.ts:322). That is the precise race point issue #710
// describes ("reconcile tick fires before poller decrements activeJobs"), and it
// is a hook on a write that exists in BOTH the patched and the unpatched
// (af5ef705) code — so the test reproduces the race regardless of which fix
// writes precede it. No real timers gate the ordering.
class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private sets = new Map<string, Set<string>>();

  // Fired BEFORE an hset mutates the store, with the key/field/value about to be
  // written. Lets the test interleave a reconcile tick immediately before the
  // poller's activeJobs decrement pool-write lands.
  beforeHset?: (key: string, field: string, value: string) => Promise<void> | void;

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    return h;
  }
  private zset(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) { z = new Map(); this.zsets.set(key, z); }
    return z;
  }
  private set_(key: string): Set<string> {
    let s = this.sets.get(key);
    if (!s) { s = new Set(); this.sets.set(key, s); }
    return s;
  }

  async sadd(key: string, member: string): Promise<number> {
    const s = this.set_(key); const isNew = !s.has(member); s.add(member); return isNew ? 1 : 0;
  }
  async srem(key: string, member: string): Promise<number> { return this.set_(key).delete(member) ? 1 : 0; }
  async scard(key: string): Promise<number> { return this.set_(key).size; }
  async pexpire(): Promise<number> { return 1; }

  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  // Accepts the ('PX', ttl) variadic form the poller uses for jobCompletionSeen;
  // the fake ignores TTL (the test drives ordering explicitly, not via expiry).
  async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK'> {
    this.strings.set(key, value); return 'OK';
  }
  async del(...ks: string[]): Promise<number> {
    let removed = 0;
    for (const key of ks) {
      if (this.strings.delete(key)) removed++;
      if (this.hashes.delete(key)) removed++;
      if (this.zsets.delete(key)) removed++;
    }
    return removed;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...this.strings.keys(), ...this.hashes.keys(), ...this.zsets.keys()].filter((k) => re.test(k));
  }
  async hgetall(key: string): Promise<Record<string, string>> { return Object.fromEntries(this.hash(key)); }
  async hget(key: string, field: string): Promise<string | null> { return this.hash(key).get(field) ?? null; }
  async hset(key: string, field: string, value: string): Promise<number> {
    if (this.beforeHset) await this.beforeHset(key, field, value);
    this.hash(key).set(field, value); return 1;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.hash(key); let removed = 0;
    for (const f of fields) if (h.delete(f)) removed++;
    return removed;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zset(key); const had = z.has(member); z.set(member, score); return had ? 0 : 1;
  }
  async zscore(key: string, member: string): Promise<string | null> {
    const s = this.zset(key).get(member); return s === undefined ? null : String(s);
  }
  async zrem(key: string, member: string): Promise<number> { return this.zset(key).delete(member) ? 1 : 0; }
  async zrangebyscore(key: string, _min: string, _max: string, withScores?: string): Promise<string[]> {
    const entries = [...this.zset(key).entries()].sort((a, b) => a[1] - b[1]);
    if (withScores) return entries.flatMap(([m, s]) => [m, String(s)]);
    return entries.map(([m]) => m);
  }
  async bzpopmin(key: string, _timeout: number): Promise<[string, string, string] | null> {
    const z = this.zset(key);
    if (z.size === 0) { await new Promise((r) => setTimeout(r, 5)); return null; }
    const [member, score] = [...z.entries()].sort((a, b) => a[1] - b[1])[0]!;
    z.delete(member);
    return [key, member, String(score)];
  }

  // The blocking BZPOPMIN loop opens a dedicated connection via .duplicate();
  // sharing this instance keeps that connection reading/writing the same store.
  duplicate(): FakeRedis { return this; }
  on(): this { return this; }
  disconnect(): void {}
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-sat'
} as unknown as import('@osaas/client-core').Context;

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const QUEUE_KEY = 'ovc:transcode-done';
const WORKSPACE = 'ws710';
const INSTANCE_ID = 'inst-710';
const BASE_URL = 'https://encore-inst.example';

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: predicate never became true');
}

// reconcile()'s fetchRealActiveState hits findByStatus for QUEUED + IN_PROGRESS.
// Both empty models Encore having dropped the finished job from its active set —
// the trigger for guard 1's drop diff. status=FAILED empty too (#704): Encore
// reports no cause because the job actually SUCCEEDED (it did not fail), so any
// drop that leaked through would carry the generic gone-from-active-set wording —
// exactly the false positive this test proves does NOT happen.
function reconcileActiveSetFetch() {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/encoreJobs/search/findByStatus')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { _embedded: { encoreJobs: [] }, page: { totalElements: 0 } };
        }
      } as unknown as Response;
    }
    throw new Error(`unexpected reconcile fetch: ${url}`);
  });
}

describe('success-then-drop false-positive race, end-to-end (issue #710)', () => {
  let redis: FakeRedis;
  let jobs: InMemoryJobRepository;
  let assets: InMemoryAssetRepository;
  let pipelines: InMemoryPipelineRepository;

  beforeEach(() => {
    redis = new FakeRedis();
    jobs = new InMemoryJobRepository();
    assets = new InMemoryAssetRepository();
    pipelines = new InMemoryPipelineRepository();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles the job SUCCEEDED and never raises onJobsDropped when reconcile fires mid-settle', async () => {
    const encoreUuid = 'uuid-710-success';

    // Seed pool + dispatch-time mappings a real dispatch would have left, and the
    // local job/asset/pipeline in their pre-completion (running) states.
    const record: EncoreInstanceRecord = {
      instanceId: INSTANCE_ID,
      url: BASE_URL,
      activeJobs: 1,
      lastIdleAt: Date.now()
    };
    await redis.hset(keys.pool(WORKSPACE), INSTANCE_ID, JSON.stringify(record));

    const asset = await assets.create({ name: 'source.mp4' });
    await assets.update(asset.id, { status: 'processing' });

    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    const externalId = encodeEncoreJobId(WORKSPACE, job.id);
    await jobs.update(job.id, { encoreJobId: externalId, status: 'running' });

    // Dispatch-time Redis state (scaler-loop.ts dispatch): url mappings, the
    // job->instance ownership map, and the status flag left at 'running'.
    await redis.set(keys.uuidToExternalId(encoreUuid), externalId);
    await redis.set(keys.jobEncoreUrl(externalId), `${BASE_URL}/encoreJobs/${encoreUuid}`);
    await redis.hset(keys.jobInstance(WORKSPACE), externalId, INSTANCE_ID);
    await redis.hset(keys.jobStatus(WORKSPACE), externalId, 'running');

    // A single transcode-only pipeline execution bound to this job.
    const execution = await pipelines.create({
      assetId: asset.id,
      pipelineName: 'transcode',
      steps: ['transcode']
    });
    const steps = execution.steps.map((s) =>
      s.name === 'transcode'
        ? { ...s, status: 'running' as const, encoreJobId: externalId, jobId: job.id, startedAt: new Date().toISOString() }
        : s
    );
    await pipelines.update(execution.id, { steps, status: 'running' });

    // reconcile() config: a fresh EncoreScalerLoop wired to the SAME fake Valkey.
    // Collect every dropped id so the assertions can prove the completed job is
    // NEVER among them (no "dropped by Encore" false positive).
    const droppedJobs: DroppedJob[] = [];
    const scalerConfig: EncoreScalerConfig = {
      workspaceId: WORKSPACE,
      maxInstances: 2,
      idleTimeoutMs: 300_000,
      redisUrl: 'redis://fake',
      oscContext: {} as EncoreScalerConfig['oscContext'],
      redis: redis as unknown as EncoreScalerConfig['redis'],
      getToken: async () => 'test-token',
      onJobsDropped: async (drops) => { droppedJobs.push(...drops); }
    };
    const scaler = new EncoreScalerLoop(scalerConfig);

    // The interleave: fire ONE reconcile tick at the EXACT race point issue #710
    // describes — immediately BEFORE the poller's decrementActiveJobs pool-write
    // lands (encore-callback-poller.ts:322), which writes the record with
    // activeJobs decremented to 0. Anchoring on that write (present in BOTH the
    // patched and the unpatched af5ef705 code) reproduces the observed sequence:
    //   1. Encore completed the job -> it left the active set (findByStatus empty).
    //   2. reconcile fires HERE, while the pool still shows the STALE activeJobs=1
    //      (the decrement has not landed) -> guard 1 (actual=0 < tracked=1) runs
    //      the drop diff for a job that has, in fact, just succeeded.
    //   3. The poller then finishes: the decrement lands, the job settles `done`.
    // On the patched code the poller has ALREADY stamped terminal keys.jobStatus +
    // hdel'd keys.jobInstance (#707) and written keys.jobCompletionSeen (#708)
    // before this point, so reconcile is a clean no-op and NO drop is raised. On
    // af5ef705 none of those writes exist yet, so reconcile WOULD raise the
    // completed job via onJobsDropped and mis-settle it failed — which is exactly
    // what the assertions below forbid, making this test fail on the unpatched
    // code and pass with #707/#708/#709 applied. One tick only: the hook detaches
    // itself after firing.
    let reconcileFired = false;
    let reconcileError: unknown;
    redis.beforeHset = async (key, field, value) => {
      if (reconcileFired) return;
      if (key !== keys.pool(WORKSPACE) || field !== INSTANCE_ID) return;
      // Only the decrement write (activeJobs -> 0), never the seed write (=1).
      let parsed: EncoreInstanceRecord;
      try {
        parsed = JSON.parse(value) as EncoreInstanceRecord;
      } catch {
        return;
      }
      if (parsed.activeJobs !== 0) return;
      reconcileFired = true;
      // Swap fetch to the reconcile active-set stub for the duration of the tick,
      // then restore the poller's single-job fetch so the poller can continue.
      const pollerFetch = globalThis.fetch;
      vi.stubGlobal('fetch', reconcileActiveSetFetch());
      try {
        await scaler.reconcile();
      } catch (err) {
        reconcileError = err;
      } finally {
        vi.stubGlobal('fetch', pollerFetch);
      }
    };

    // Poller fetch: the single Encore job GET returns SUCCESSFUL.
    const pollerFetch = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const uuid = url.split('/encoreJobs/')[1];
      if (uuid === encoreUuid) {
        return { ok: true, status: 200, async json() { return { externalId, status: 'SUCCESSFUL', output: [] }; } } as unknown as Response;
      }
      return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
    });
    vi.stubGlobal('fetch', pollerFetch);

    const pollerDeps = {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      logger: NOOP_LOGGER
    };

    // Enqueue the SUCCESSFUL callback message and let the poller drive the full
    // success path. The onHdel hook fires the interleaved reconcile tick partway
    // through, reproducing complete -> reconcile-tick -> (poller finishes settle).
    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const stop = startEncoreCallbackPoller(pollerDeps);
    try {
      await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
    } finally {
      stop();
    }

    // The interleaved reconcile tick must have actually run mid-settle (otherwise
    // the test would not be exercising the race at all).
    expect(reconcileFired).toBe(true);
    expect(reconcileError).toBeUndefined();

    // CORE ASSERTION (#710): the job settled as SUCCEEDED, not failed. The
    // mid-settle reconcile tick did NOT flip a completed job to failed.
    const settled = await jobs.get(job.id);
    expect(settled?.status).toBe('done');
    expect(settled?.status).not.toBe('failed');

    // CORE ASSERTION (#710): onJobsDropped was NEVER raised for this job, so
    // main.ts never emits the "dropped by Encore" false-positive settle.
    expect(droppedJobs.map((d) => d.encoreJobId)).not.toContain(externalId);
    expect(droppedJobs).toHaveLength(0);

    // And the durable error field carries no dropped-by-Encore wording.
    expect(settled?.error ?? '').not.toContain('dropped by Encore');

    // The source asset and pipeline reached their success terminal states — no
    // spurious failure leaked in from the racing reconcile tick.
    expect((await assets.get(asset.id))?.status).toBe('ready');
    const finalExec = await pipelines.get(execution.id);
    expect(finalExec?.steps.find((s) => s.name === 'transcode')?.status).toBe('done');

    // Post-settle Valkey bookkeeping matches the #707 fix: terminal jobStatus and
    // the jobInstance mapping removed, so any LATER reconcile tick is a clean
    // no-op for this job as well.
    expect(await redis.hget(keys.jobStatus(WORKSPACE), externalId)).toBe('SUCCESSFUL');
    expect(await redis.hget(keys.jobInstance(WORKSPACE), externalId)).toBeNull();
  });
});
