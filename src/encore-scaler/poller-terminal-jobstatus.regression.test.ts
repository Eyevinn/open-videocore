// Regression coverage for issue #707: when the encore-callback-poller accepts a
// SUCCESSFUL (terminal) Encore callback it must, as its FIRST Redis write on the
// success path, stamp a TERMINAL value onto keys.jobStatus AND hdel
// keys.jobInstance — so that guard 2 in ScalerLoop.reconcile()
// (scaler-loop.ts:513 `if (st !== 'RUNNING' && st !== 'QUEUED') continue`) short-
// circuits the finished job on every subsequent reconcile tick.
//
// The bug: when Encore completes a job it leaves that instance's live
// QUEUED/IN_PROGRESS set, so the next reconcile tick sees tracked activeJobs >
// actual and runs its drop diff (scaler-loop.ts:505-521). That diff only spares a
// legitimately-completed job when its keys.jobStatus is already terminal. Until
// the poller wrote it, dispatch left that status at 'running' (scaler-loop.ts:699),
// guard 2 was inert, the completed job was raised via onJobsDropped, and
// main.ts:1152 settled it permanently `failed` with "dropped by Encore: gone from
// active set with no completion".
//
// This test drives the REAL poller (startEncoreCallbackPoller/handleMessage) over
// a SUCCESSFUL callback, then fires a real EncoreScalerLoop.reconcile() tick with
// the instance appearing idle to Encore (the completed job has left the active
// set), and asserts onJobsDropped is NOT raised for that job.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Terminal write requirement + guard 2 — scaler-loop.ts:505-521, esp. the
//     status guard at :513 and the trackedInstances iteration at :506-509.
//   - dispatch() writes keys.jobInstance + keys.jobStatus='running' —
//     scaler-loop.ts:698-699.
//   - EncoreScalerLoop.reconcile() + onJobsDropped raise — scaler-loop.ts:452-560.
//   - onJobsDropped signature (encoreJobIds: string[]) => Promise<void> —
//     types.ts:106.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus —
//     types.ts:181-183.
//   - Encore findByStatus HATEOAS page { _embedded: { encoreJobs: [{ id | externalId
//     }] } } — scaler-loop.ts:303-305 / encore-callback-poller.ts module doc,
//     verified 2026-07-07; single job GET fields { externalId, status, output }
//     from src/routes/internal.ts encoreCallbackSchema.
//   - startEncoreCallbackPoller / handleMessage success path (this change) —
//     src/pipeline/encore-callback-poller.ts.
//   - InMemory repositories — src/data/{job,asset,pipeline}-repo.ts;
//     encodeEncoreJobId — src/data/job-repo.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startEncoreCallbackPoller } from '../pipeline/encore-callback-poller.js';
import { EncoreScalerLoop } from './scaler-loop.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';

// In-memory Valkey stand-in covering both the poller's command surface (string
// get/set, hash get/set/getall/del, sorted-set zadd/zscore/zrem/zrangebyscore/
// bzpopmin, set sadd/srem/scard/pexpire, keys, duplicate/on/disconnect for the
// blocking loop) and reconcile()'s (hgetall/hget/hset). Mirrors the FakeRedis in
// encore-callback-poller.test.ts so both files exercise the same real modules
// without OSC or a live Valkey.
class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private sets = new Map<string, Set<string>>();

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
  async set(key: string, value: string): Promise<'OK'> { this.strings.set(key, value); return 'OK'; }
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
  async hset(key: string, field: string, value: string): Promise<number> { this.hash(key).set(field, value); return 1; }
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
const WORKSPACE = 'ws707';
const INSTANCE_ID = 'inst-707';
const BASE_URL = 'https://encore-inst.example';

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: predicate never became true');
}

describe('encore-callback-poller terminal jobStatus write (#707)', () => {
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

  it('stamps terminal jobStatus + hdel jobInstance so a later reconcile tick does NOT drop the completed job', async () => {
    const encoreUuid = 'uuid-707-success';

    // Seed the pool + dispatch-time mappings a real dispatch would have left, and
    // the local job/asset in their pre-completion (running) states.
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

    // Dispatch-time Redis state (scaler-loop.ts:698-699): the URL mapping, the
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

    // Poller fetch: the single Encore job GET returns SUCCESSFUL. (No findByStatus
    // needed — we enqueue the callback message directly.)
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const uuid = url.split('/encoreJobs/')[1];
      if (uuid === encoreUuid) {
        return { ok: true, status: 200, async json() { return { externalId, status: 'SUCCESSFUL', output: [] }; } } as unknown as Response;
      }
      return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchFn);

    const pollerDeps = {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      logger: NOOP_LOGGER
    };

    // Enqueue the SUCCESSFUL callback message and let the poller process it.
    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const stop = startEncoreCallbackPoller(pollerDeps);
    try {
      await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
    } finally {
      stop();
    }

    // AC1/AC2: on the success path the poller wrote a TERMINAL jobStatus and
    // hdel'd the jobInstance mapping.
    expect(await redis.hget(keys.jobStatus(WORKSPACE), externalId)).toBe('SUCCESSFUL');
    expect(await redis.hget(keys.jobInstance(WORKSPACE), externalId)).toBeNull();

    // Now simulate the reconcile tick firing AFTER the successful callback: Encore
    // no longer lists the finished job as active (tracked activeJobs=1 was
    // decremented to 0 by the poller — re-seed a >0 tracked count to force the
    // drop diff to run, exactly as a stale/uncorrected count would). Encore
    // reports zero active jobs for the instance.
    const poolAfter = JSON.parse((await redis.hget(keys.pool(WORKSPACE), INSTANCE_ID))!) as EncoreInstanceRecord;
    poolAfter.activeJobs = 1; // stale non-zero count forces reconcile's drop diff
    await redis.hset(keys.pool(WORKSPACE), INSTANCE_ID, JSON.stringify(poolAfter));

    // reconcile()'s fetchRealActiveState hits findByStatus for QUEUED + IN_PROGRESS
    // — both empty (the job is done and gone from the active set).
    const reconcileFetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/encoreJobs/search/findByStatus')) {
        return { ok: true, status: 200, async json() { return { _embedded: { encoreJobs: [] }, page: { totalElements: 0 } }; } } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', reconcileFetch);

    const droppedIds: string[] = [];
    const config: EncoreScalerConfig = {
      workspaceId: WORKSPACE,
      maxInstances: 2,
      idleTimeoutMs: 300_000,
      redisUrl: 'redis://fake',
      oscContext: {} as EncoreScalerConfig['oscContext'],
      redis: redis as unknown as EncoreScalerConfig['redis'],
      getToken: async () => 'test-token',
      onJobsDropped: async (ids) => { droppedIds.push(...ids); }
    };

    await new EncoreScalerLoop(config).reconcile();

    // AC3/AC4: guard 2 short-circuited the completed job (its jobStatus is terminal
    // AND its jobInstance mapping is gone), so onJobsDropped is NOT raised for it —
    // the job is never mis-settled as "dropped by Encore".
    expect(droppedIds).not.toContain(externalId);
    expect(droppedIds).toHaveLength(0);

    // The job stays terminal `done` — never flipped to failed.
    expect((await jobs.get(job.id))?.status).toBe('done');
  });
});
