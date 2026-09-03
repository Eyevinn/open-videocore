// Encore callback poller — terminal-job reconciliation sweep tests.
//
// Sibling in spirit to test/encore-scaler-idle-timeout.test.ts: runs WITHOUT OSC
// or a real Redis. A minimal in-memory FakeRedis (matching that file's stub
// style, extended with the sorted-set + string-key commands this module uses)
// stands in for Valkey, the codebase's own in-memory repositories stand in for
// CouchDB, and global fetch is stubbed to emulate the Encore instance HTTP API.
//
// Focus: the sweep must now discover terminal-but-unreconciled FAILED jobs (not
// just SUCCESSFUL ones) whose completion message never reached the queue, and
// funnel them through the SAME handleMessage -> completeTranscode path so the
// local job, source asset, and pipeline `transcode` step all reach `failed`.
// This closes the "job looks stuck running after an Encore failure" gap.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - sweepTerminalJobs / startEncoreCallbackPoller (this module).
//   - Encore /encoreJobs/search/findByStatus HATEOAS page shape
//     { _embedded: { encoreJobs: [{ id }] } } (module doc comment, verified
//     2026-07-07) and job document { externalId, status, message } fields
//     (src/routes/internal.ts encoreCallbackSchema).
//   - keys.pool / keys.uuidToExternalId / keys.jobEncoreUrl (src/encore-scaler/types.ts:93-108).
//   - encodeEncoreJobId (src/data/job-repo.ts:144); EncoreInstanceRecord (types.ts).
//   - InMemoryJobRepository / InMemoryAssetRepository (src/data/*-repo.ts),
//     InMemoryPipelineRepository (src/data/pipeline-repo.ts:65).
//   - completeTranscode failure semantics: job->failed, asset->failed
//     (src/pipeline/transcode.ts:155-161).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepTerminalJobs, startEncoreCallbackPoller, purgeStalePackagingJobs } from './encore-callback-poller.js';
import { DEFAULT_PACKAGE_STALL_TIMEOUT_MS } from './stalled-package-reconciler.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';

// Parse a ZRANGEBYSCORE score bound the way Valkey does: '-inf'/'+inf' and the
// exclusive '(' prefix (e.g. '(1700000000000'). Kept alongside FakeRedis so its
// zrangebyscore can honour the #498 stale-purge query's exclusive upper bound.
function parseScoreBound(b: string): { value: number; exclusive: boolean } {
  if (b === '-inf') return { value: -Infinity, exclusive: false };
  if (b === '+inf') return { value: Infinity, exclusive: false };
  const exclusive = b.startsWith('(');
  return { value: Number(exclusive ? b.slice(1) : b), exclusive };
}

// --- Minimal in-memory Redis --------------------------------------------------
// Extends the FakeRedis idea from test/encore-scaler-idle-timeout.test.ts with
// the string-key (get/set/keys), hash (hget/hset/hgetall) and sorted-set
// (zadd/zscore/zrem/zrangebyscore/bzpopmin) commands this module touches.
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
  // #525 pt.2: handleMessage now pins/unpins the transcode instance for
  // packaging (packaging-pin.ts) via SADD/SREM/SCARD + a defensive PEXPIRE.
  async sadd(key: string, member: string): Promise<number> {
    const s = this.set_(key);
    const isNew = !s.has(member);
    s.add(member);
    return isNew ? 1 : 0;
  }
  async srem(key: string, member: string): Promise<number> {
    return this.set_(key).delete(member) ? 1 : 0;
  }
  async scard(key: string): Promise<number> {
    return this.set_(key).size;
  }
  async pexpire(): Promise<number> {
    return 1;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed++;
      if (this.hashes.delete(key)) removed++;
      if (this.zsets.delete(key)) removed++;
    }
    return removed;
  }
  async keys(pattern: string): Promise<string[]> {
    // Only '*'-suffix globs are used by the sweep (e.g. 'encore:pool:*').
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...this.strings.keys(), ...this.hashes.keys(), ...this.zsets.keys()].filter((k) => re.test(k));
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zset(key);
    const had = z.has(member);
    z.set(member, score);
    return had ? 0 : 1;
  }
  async zscore(key: string, member: string): Promise<string | null> {
    const s = this.zset(key).get(member);
    return s === undefined ? null : String(s);
  }
  async zrem(key: string, member: string): Promise<number> {
    return this.zset(key).delete(member) ? 1 : 0;
  }
  async zrangebyscore(key: string, min: string, max: string, withScores?: string): Promise<string[]> {
    // Honour the score bounds (including '-inf'/'+inf' and the exclusive '(' form
    // ioredis passes, e.g. `(1700000000000`) so the #498 stale-purge query can be
    // exercised. Prior callers passed ('-inf','+inf') and still get every member.
    const lo = parseScoreBound(min);
    const hi = parseScoreBound(max);
    const entries = [...this.zset(key).entries()]
      .filter(([, s]) => (lo.exclusive ? s > lo.value : s >= lo.value) && (hi.exclusive ? s < hi.value : s <= hi.value))
      .sort((a, b) => a[1] - b[1]);
    if (withScores) return entries.flatMap(([m, s]) => [m, String(s)]);
    return entries.map(([m]) => m);
  }
  async bzpopmin(key: string, _timeout: number): Promise<[string, string, string] | null> {
    const z = this.zset(key);
    if (z.size === 0) {
      // Emulate the blocking timeout returning null, yielding to the event loop
      // so the poller's abort signal can be observed between iterations.
      await new Promise((r) => setTimeout(r, 5));
      return null;
    }
    const [member, score] = [...z.entries()].sort((a, b) => a[1] - b[1])[0]!;
    z.delete(member);
    return [key, member, String(score)];
  }

  // Test helpers.
  zmembers(key: string): string[] {
    return [...this.zset(key).keys()];
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-sat'
} as unknown as import('@osaas/client-core').Context;

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const QUEUE_KEY = 'ovc:transcode-done';
const PROCESSING_KEY = `${QUEUE_KEY}:processing`;
const WORKSPACE = 'ws-test';
const INSTANCE_ID = 'inst-abc';
const BASE_URL = 'https://encore-inst.example';

// Build a fetch stub that answers findByStatus searches and single-job GETs.
// `failedUuids`/`successfulUuids` are returned from the matching search; the
// job document GET replies with the status implied by which set the uuid is in.
function makeFetch(opts: {
  failedUuids?: string[];
  successfulUuids?: string[];
  jobDocs: Record<string, { externalId: string; status: string; message?: string; output?: unknown[] }>;
}): ReturnType<typeof vi.fn> {
  const { failedUuids = [], successfulUuids = [], jobDocs } = opts;
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const jsonRes = (body: unknown) =>
      ({ ok: true, status: 200, async json() { return body; } }) as unknown as Response;

    if (url.includes('/encoreJobs/search/findByStatus')) {
      const status = new URL(url).searchParams.get('status');
      const ids = status === 'FAILED' ? failedUuids : status === 'SUCCESSFUL' ? successfulUuids : [];
      return jsonRes({ _embedded: { encoreJobs: ids.map((id) => ({ id })) } });
    }
    // Single Encore job document fetch: `${BASE_URL}/encoreJobs/${uuid}`.
    const uuid = url.split('/encoreJobs/')[1];
    const doc = uuid ? jobDocs[uuid] : undefined;
    if (doc) return jsonRes(doc);
    return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
  });
}

// Seed the Redis pool + dispatch-time mappings a real dispatch would have left,
// and create the local job/asset/pipeline in their pre-completion states.
async function seedScenario(
  redis: FakeRedis,
  jobs: InMemoryJobRepository,
  assets: InMemoryAssetRepository,
  pipelines: InMemoryPipelineRepository,
  opts: { encoreUuid: string; jobStatus?: 'queued' | 'failed' | 'done'; withPackageStep?: boolean }
): Promise<{ externalId: string; assetId: string; pipelineId: string }> {
  const record: EncoreInstanceRecord = {
    instanceId: INSTANCE_ID,
    url: BASE_URL,
    activeJobs: 1,
    lastIdleAt: Date.now()
  };
  await redis.hset(keys.pool(WORKSPACE), INSTANCE_ID, JSON.stringify(record));

  // Asset in `processing` (the state a source sits in while its transcode runs).
  const asset = await assets.create({ name: 'source.mp4' });
  await assets.update(asset.id, { status: 'processing' });

  // Local transcode job; encoreJobId embeds the workspace so decodeEncoreJobId works.
  const job = await jobs.create({ type: 'transcode', assetId: asset.id });
  const externalId = encodeEncoreJobId(WORKSPACE, job.id);
  await jobs.update(job.id, { encoreJobId: externalId, status: 'queued' });
  if (opts.jobStatus === 'failed') {
    await jobs.update(job.id, { status: 'failed', error: 'already terminal' });
  } else if (opts.jobStatus === 'done') {
    await jobs.update(job.id, { status: 'running' });
    await jobs.update(job.id, { status: 'done' });
  }

  // Dispatch-time Redis mappings the poller relies on to resolve the job URL.
  await redis.set(keys.uuidToExternalId(opts.encoreUuid), externalId);
  await redis.set(keys.jobEncoreUrl(externalId), `${BASE_URL}/encoreJobs/${opts.encoreUuid}`);
  // jobInstance is written unconditionally at dispatch (scaler-loop.ts
  // dispatch(), outside the `if (encoreUuid && ...)` guard the other two
  // mappings live in) — the #525 pt.2 packaging pin resolves the instance to
  // pin/unpin through this same mapping.
  await redis.hset(keys.jobInstance(WORKSPACE), externalId, INSTANCE_ID);

  // Pipeline with a running `transcode` step bound to this Encore job. When
  // withPackageStep is set, a pending `package` step follows so the SUCCESSFUL
  // completion path exercises the transcode->package handoff (#496).
  const execution = await pipelines.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: opts.withPackageStep ? ['transcode', 'package'] : ['transcode']
  });
  const steps = execution.steps.map((s) =>
    s.name === 'transcode'
      ? { ...s, status: 'running' as const, encoreJobId: externalId, jobId: job.id, startedAt: new Date().toISOString() }
      : s
  );
  await pipelines.update(execution.id, { steps, status: 'running' });

  return { externalId, assetId: asset.id, pipelineId: execution.id };
}

// Poll a predicate until true or a deadline elapses.
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: predicate never became true');
}

describe('encore-callback-poller sweep — FAILED job reconciliation', () => {
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

  function deps(fetchFn: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchFn);
    return {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      logger: NOOP_LOGGER
    };
  }

  it('discovers a FAILED job and drives job, asset, and pipeline step to failed with Encore error', async () => {
    const encoreUuid = 'uuid-failed-1';
    const errorMsg = 'Error parsing ProbeResult from output';
    const { externalId, assetId, pipelineId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'FAILED', message: errorMsg } }
    });
    const d = deps(fetchFn);

    // 1. Sweep discovers the unreconciled FAILED job and enqueues a synthetic message.
    await sweepTerminalJobs(d, QUEUE_KEY);
    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(1);
    const enqueued = JSON.parse(redis.zmembers(QUEUE_KEY)[0]!);
    expect(enqueued).toEqual({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });

    // 2. The poller drains the queue through the unchanged handleMessage path.
    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await jobs.get(findLocalJobId(externalId)))?.status === 'failed');
    } finally {
      stop();
    }

    // 3. Local job failed, carrying Encore's error message.
    const localJob = await jobs.get(findLocalJobId(externalId));
    expect(localJob?.status).toBe('failed');
    expect(localJob?.error).toBe(errorMsg);

    // 4. Source asset failed.
    const asset = await assets.get(assetId);
    expect(asset?.status).toBe('failed');

    // 5. Pipeline transcode step + execution failed, with the error recorded.
    const execution = await pipelines.get(pipelineId);
    expect(execution?.status).toBe('failed');
    const transcodeStep = execution?.steps.find((s) => s.name === 'transcode');
    expect(transcodeStep?.status).toBe('failed');
    expect(transcodeStep?.error).toBe(errorMsg);
  });

  it('skips a FAILED job whose local job is already terminal (no enqueue)', async () => {
    const encoreUuid = 'uuid-failed-terminal';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid, jobStatus: 'failed' });

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'FAILED', message: 'x' } }
    });
    const d = deps(fetchFn);

    await sweepTerminalJobs(d, QUEUE_KEY);

    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(0);
  });

  it('does not re-enqueue a FAILED job already present in the queue', async () => {
    const encoreUuid = 'uuid-failed-dup';
    await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });

    // Pre-seed the exact synthetic message the sweep would produce.
    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId: 'ignored', status: 'FAILED' } }
    });
    const d = deps(fetchFn);
    const zaddSpy = vi.spyOn(redis, 'zadd');

    await sweepTerminalJobs(d, QUEUE_KEY);

    // Still exactly one copy, and the sweep never issued a (duplicate) enqueue.
    expect(redis.zmembers(QUEUE_KEY)).toEqual([message]);
    expect(zaddSpy).not.toHaveBeenCalled();
  });

  it('does not re-enqueue a FAILED job already in the processing set', async () => {
    const encoreUuid = 'uuid-failed-processing';
    await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });

    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(PROCESSING_KEY, Date.now(), message);

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId: 'ignored', status: 'FAILED' } }
    });
    const d = deps(fetchFn);
    const zaddSpy = vi.spyOn(redis, 'zadd');

    await sweepTerminalJobs(d, QUEUE_KEY);

    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(0);
    expect(zaddSpy).not.toHaveBeenCalled();
  });

  it('regression: still discovers SUCCESSFUL jobs and enqueues them unchanged', async () => {
    const encoreUuid = 'uuid-success-1';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });

    const fetchFn = makeFetch({
      successfulUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'SUCCESSFUL', output: [] } }
    });
    const d = deps(fetchFn);

    await sweepTerminalJobs(d, QUEUE_KEY);

    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(1);
    const enqueued = JSON.parse(redis.zmembers(QUEUE_KEY)[0]!);
    expect(enqueued).toEqual({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
  });

  // #464 AC: "a job whose completion callback is dropped entirely reaches the
  // correct terminal state via reconciliation within one bounded interval." The
  // FAILED direction is proven by the first test in this block; this proves the
  // SUCCESSFUL direction end-to-end (sweep discovery -> shared handleMessage ->
  // completeTranscode) rather than only asserting the enqueue.
  it('#464: a dropped SUCCESSFUL callback reaches terminal `done` via one reconciliation pass', async () => {
    const encoreUuid = 'uuid-success-e2e';
    const { externalId, assetId, pipelineId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });
    // The scaler advances a dispatched job queued->running; completeTranscode only
    // settles a running job to done (mirrors the #381 successful-metrics test).
    await jobs.update(findLocalJobId(externalId), { status: 'running' });

    const fetchFn = makeFetch({
      successfulUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'SUCCESSFUL', output: [] } }
    });
    const d = deps(fetchFn);

    // One sweep discovers the unreconciled SUCCESSFUL job and enqueues it; the
    // poller then drains it through the unchanged handleMessage path.
    await sweepTerminalJobs(d, QUEUE_KEY);
    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(1);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await jobs.get(findLocalJobId(externalId)))?.status === 'done');
    } finally {
      stop();
    }

    expect((await jobs.get(findLocalJobId(externalId)))?.status).toBe('done');
    expect((await assets.get(assetId))?.status).toBe('ready');
    const execution = await pipelines.get(pipelineId);
    expect(execution?.steps.find((s) => s.name === 'transcode')?.status).toBe('done');
  });

  // #464 idempotency AC: a job that ALSO received its real callback (already
  // terminal `done` locally) must not be double-processed by the sweep. Companion
  // to the FAILED-terminal skip test above, covering the SUCCESSFUL direction.
  it('#464: does not re-enqueue a SUCCESSFUL job already terminal (`done`) locally', async () => {
    const encoreUuid = 'uuid-success-done';
    await seedScenario(redis, jobs, assets, pipelines, { encoreUuid, jobStatus: 'done' });

    const fetchFn = makeFetch({
      successfulUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId: 'ignored', status: 'SUCCESSFUL', output: [] } }
    });
    const d = deps(fetchFn);

    await sweepTerminalJobs(d, QUEUE_KEY);

    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(0);
  });

  // #464 fan-out bound: sweepMaxInstances caps Encore instances scanned per cycle.
  // With the cap at 0, no instance is scanned and nothing is enqueued (the job is
  // simply reconciled on a later cycle — no job is stranded).
  it('#464: honours the sweepMaxInstances per-cycle fan-out bound', async () => {
    const encoreUuid = 'uuid-bounded';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'FAILED', message: 'x' } }
    });
    const d = { ...deps(fetchFn), sweepMaxInstances: 0 };

    await sweepTerminalJobs(d, QUEUE_KEY);

    // No instance scanned this cycle -> no findByStatus fetch, nothing enqueued.
    expect(redis.zmembers(QUEUE_KEY)).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // The InMemoryJobRepository assigns sequential ids; recover the local id from
  // the encoreJobId we embedded so assertions don't depend on that counter.
  function findLocalJobId(externalId: string): string {
    // encodeEncoreJobId is `${workspaceId}__${jobLocalId}`.
    const sep = externalId.indexOf('__');
    return externalId.slice(sep + 2);
  }
});

// #381: on completion the poller must close out the durable encode-attempt log
// (endedAt + classification for failures) so the never-retried job reads exactly
// one attempt with one timing pair and the successful attempt's elapsed time is
// derivable.
//
// Contracts verified (CLAUDE.md rule 7):
//   - JobRepository.appendEncodeAttempt / finalizeEncodeAttempt + Job.encodeAttempts /
//     encodeAttemptLog (src/data/job-repo.ts).
//   - decideRetry deterministic-failure => settle 'not-retryable', class
//     'deterministic' (src/encore-scaler/retry-store.ts / retry-policy.ts).
describe('encore-callback-poller — durable encode-attempt finalisation (#381)', () => {
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

  function deps(fetchFn: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchFn);
    return {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      logger: NOOP_LOGGER
    };
  }

  function findLocalJobId(externalId: string): string {
    const sep = externalId.indexOf('__');
    return externalId.slice(sep + 2);
  }

  it('records one finalised attempt (endedAt, no class) for a successful job', async () => {
    const encoreUuid = 'uuid-succ-metrics';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });
    const localId = findLocalJobId(externalId);
    // The scaler advances a dispatched job queued->running (main.ts onDispatched);
    // completeTranscode only settles a running job to done.
    await jobs.update(localId, { status: 'running' });
    // Simulate the #380 dispatch-time append (one open attempt).
    await jobs.appendEncodeAttempt(localId, { index: 1 });

    const fetchFn = makeFetch({
      successfulUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'SUCCESSFUL', output: [] } }
    });
    const d = deps(fetchFn);

    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await jobs.get(localId))?.status === 'done');
    } finally {
      stop();
    }

    const job = await jobs.get(localId);
    expect(job?.encodeAttempts).toBe(1);
    expect(job?.encodeAttemptLog).toHaveLength(1);
    const attempt = job!.encodeAttemptLog![0];
    expect(attempt.startedAt).toBeDefined();
    expect(attempt.endedAt).toBeDefined();
    expect(attempt.classification).toBeUndefined();
  });

  it('records the failure classification on the settled terminal attempt', async () => {
    const encoreUuid = 'uuid-fail-metrics';
    // A deterministic failure message => settle 'not-retryable', class 'deterministic'.
    const errorMsg = 'Error parsing ProbeResult from output';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, { encoreUuid });
    const localId = findLocalJobId(externalId);
    await jobs.appendEncodeAttempt(localId, { index: 1 });

    const fetchFn = makeFetch({
      failedUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'FAILED', message: errorMsg } }
    });
    const d = deps(fetchFn);

    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await jobs.get(localId))?.status === 'failed');
    } finally {
      stop();
    }

    const job = await jobs.get(localId);
    expect(job?.encodeAttempts).toBe(1);
    const attempt = job!.encodeAttemptLog![0];
    expect(attempt.endedAt).toBeDefined();
    expect(attempt.classification).toBe('deterministic');
  });
});

// #496: on the automatic transcode->package handoff the poller must call the SAME
// on-demand packager provisioning hook the manual package-start path uses
// (src/routes/assets.ts:1484) BEFORE enqueueing the packaging job — otherwise, on
// a stack where the packager was never provisioned, the job lands on a queue with
// no consumer and reconcileStalledPackages (#336) fails the step 15 minutes later.
describe('encore-callback-poller — transcode->package handoff provisioning (#496)', () => {
  const PACKAGING_QUEUE_KEY = 'encore-packager:jobs';
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

  function findLocalJobId(externalId: string): string {
    const sep = externalId.indexOf('__');
    return externalId.slice(sep + 2);
  }

  // A SUCCESSFUL Encore job whose pipeline has a pending `package` step next.
  function successFetch(externalId: string, encoreUuid: string) {
    return makeFetch({
      successfulUuids: [encoreUuid],
      jobDocs: { [encoreUuid]: { externalId, status: 'SUCCESSFUL', output: [] } }
    });
  }

  function baseDeps(
    fetchFn: ReturnType<typeof vi.fn>,
    ensurePackaging?: () => Promise<void>
  ) {
    vi.stubGlobal('fetch', fetchFn);
    return {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      packagingQueueKey: PACKAGING_QUEUE_KEY,
      ensurePackaging,
      logger: NOOP_LOGGER
    };
  }

  // Seed a transcode+package pipeline in the running-transcode state, then enqueue
  // the completion message the callback listener would have written.
  async function seedAndEnqueue(encoreUuid: string) {
    const seeded = await seedScenario(redis, jobs, assets, pipelines, {
      encoreUuid,
      withPackageStep: true
    });
    // completeTranscode only settles a running job to done (mirrors the #464 test).
    await jobs.update(findLocalJobId(seeded.externalId), { status: 'running' });
    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);
    return seeded;
  }

  it('calls ensurePackaging BEFORE enqueueing the packaging job', async () => {
    const encoreUuid = 'uuid-handoff-ensure';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    // The ensure hook asserts, at call time, that the packaging queue is still
    // empty — proving provisioning is awaited before the ZADD.
    const ensurePackaging = vi.fn(async () => {
      expect(redis.zmembers(PACKAGING_QUEUE_KEY)).toHaveLength(0);
    });
    const d = baseDeps(successFetch(externalId, encoreUuid), ensurePackaging);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(() => redis.zmembers(PACKAGING_QUEUE_KEY).length === 1);
    } finally {
      stop();
    }

    expect(ensurePackaging).toHaveBeenCalledTimes(1);
    // The packaging job was enqueued (jobId = assetId) and the step is running.
    const enqueued = JSON.parse(redis.zmembers(PACKAGING_QUEUE_KEY)[0]!);
    expect(enqueued.jobId).toBe((await pipelines.get(pipelineId))!.assetId);
    const execution = await pipelines.get(pipelineId);
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('running');
  });

  it('fails the package step with a diagnostic and does NOT enqueue when ensurePackaging throws', async () => {
    const encoreUuid = 'uuid-handoff-throw';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    const ensurePackaging = vi.fn(async () => {
      throw new Error('packager provisioning blew up');
    });
    const d = baseDeps(successFetch(externalId, encoreUuid), ensurePackaging);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await pipelines.get(pipelineId))?.status === 'failed');
    } finally {
      stop();
    }

    expect(ensurePackaging).toHaveBeenCalledTimes(1);
    // Nothing was pushed onto the packager's input queue.
    expect(redis.zmembers(PACKAGING_QUEUE_KEY)).toHaveLength(0);
    const execution = await pipelines.get(pipelineId);
    expect(execution?.status).toBe('failed');
    const pkg = execution?.steps.find((s) => s.name === 'package');
    expect(pkg?.status).toBe('failed');
    expect(pkg?.error).toContain('packager provisioning blew up');
    expect(pkg?.error).toContain('provisioning failed before packaging handoff');
    // The transcode step still completed — the failure is isolated to `package`.
    expect(execution?.steps.find((s) => s.name === 'transcode')?.status).toBe('done');
  });

  it('preserves prior behaviour (enqueues) when ensurePackaging is undefined', async () => {
    const encoreUuid = 'uuid-handoff-noop';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    // No ensure hook wired — the queue stack path where packaging was pre-provisioned.
    const d = baseDeps(successFetch(externalId, encoreUuid), undefined);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(() => redis.zmembers(PACKAGING_QUEUE_KEY).length === 1);
    } finally {
      stop();
    }

    expect(redis.zmembers(PACKAGING_QUEUE_KEY)).toHaveLength(1);
    const execution = await pipelines.get(pipelineId);
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('running');
  });

  // #525 regression: reproduces a bulk-cleanup-triggered dispatch gap where
  // Encore's POST /encoreJobs response omitted `id` (or the pool record was
  // wiped by scale-down before completion). scaler-loop.ts dispatch() only
  // writes jobUuid / uuidToExternalId / jobEncoreUrl inside the
  // `if (encoreUuid && ...)` branch, so none of those Redis keys exist here —
  // yet the callback listener still observed Encore's own webhook independently
  // and delivered a working `message.url`. Before the #525 fix this made
  // resolveEncoreJobUrl(externalId, redis) come back empty at the packaging
  // handoff (both the direct key AND the pool+UUID fallback miss), silently
  // failing the `package` step with "Encore instance no longer available for
  // packaging" even though the instance was fine — with nothing logged between
  // "completing transcode" and "applied encore completion" to explain it. The
  // fix reuses the `url` already resolved (and proven reachable) earlier in
  // handleMessage instead of re-deriving it from those dispatch-time keys.
  it('#525: still packages when dispatch never captured the Encore UUID, using the callback message URL', async () => {
    const encoreUuid = 'uuid-handoff-no-dispatch-mapping';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    // Simulate the dispatch-time capture gap: no jobEncoreUrl, no
    // uuidToExternalId mapping — exactly what happens when scaler-loop.ts's
    // dispatch() `if (encoreUuid && ...)` guard was skipped.
    await redis.del(keys.jobEncoreUrl(externalId));
    await redis.del(keys.uuidToExternalId(encoreUuid));

    const d = baseDeps(successFetch(externalId, encoreUuid), undefined);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(() => redis.zmembers(PACKAGING_QUEUE_KEY).length === 1);
    } finally {
      stop();
    }

    // Packaging was enqueued using the callback message's own URL, not a
    // Redis-reconstructed one.
    const enqueued = JSON.parse(redis.zmembers(PACKAGING_QUEUE_KEY)[0]!);
    expect(enqueued).toEqual({
      jobId: (await pipelines.get(pipelineId))!.assetId,
      url: `${BASE_URL}/encoreJobs/${encoreUuid}`
    });
    const execution = await pipelines.get(pipelineId);
    expect(execution?.status).toBe('running');
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('running');
  });

  // #525 pt.2: the transcode->package handoff must pin the instance that ran
  // the job (encore:pending-packaging:{instanceId}) BEFORE the packaging job
  // is enqueued, and leave it pinned — the scaler must not be able to tear the
  // instance down while the packager still needs to reach it, and this poller
  // has no way of knowing when the packager (an external, async OSC service)
  // actually finishes; that release happens via the packager's success
  // callback in routes/internal.ts, which this test cannot reach, so the pin
  // is asserted to still be held once the packaging job is on the queue.
  it('#525 pt.2: pins the transcode instance for packaging and does not release it once enqueued', async () => {
    const encoreUuid = 'uuid-handoff-pin';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    const d = baseDeps(successFetch(externalId, encoreUuid), undefined);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(() => redis.zmembers(PACKAGING_QUEUE_KEY).length === 1);
    } finally {
      stop();
    }

    expect(await redis.scard(keys.pendingPackaging(INSTANCE_ID))).toBe(1);
    const execution = await pipelines.get(pipelineId);
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('running');
  });

  // #525 pt.2: when packaging is never actually attempted (no package step
  // follows in this pipeline), any pin taken on the success path must be
  // released immediately rather than held for its full TTL for nothing.
  it('#525 pt.2: releases the pin immediately when the pipeline has no package step', async () => {
    const encoreUuid = 'uuid-handoff-pin-no-package';
    const { externalId } = await seedScenario(redis, jobs, assets, pipelines, {
      encoreUuid,
      withPackageStep: false
    });
    await jobs.update(findLocalJobId(externalId), { status: 'running' });
    const message = JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` });
    await redis.zadd(QUEUE_KEY, Date.now(), message);

    const d = baseDeps(successFetch(externalId, encoreUuid), undefined);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await jobs.get(findLocalJobId(externalId)))?.status === 'done');
    } finally {
      stop();
    }

    expect(await redis.scard(keys.pendingPackaging(INSTANCE_ID))).toBe(0);
  });

  // #525 pt.2: a provisioning failure aborts packaging entirely — the pin must
  // be released here too, not held until its TTL expires.
  it('#525 pt.2: releases the pin when ensurePackaging throws', async () => {
    const encoreUuid = 'uuid-handoff-pin-ensure-throws';
    const { externalId, pipelineId } = await seedAndEnqueue(encoreUuid);

    const ensurePackaging = vi.fn(async () => {
      throw new Error('packager provisioning blew up');
    });
    const d = baseDeps(successFetch(externalId, encoreUuid), ensurePackaging);

    const stop = startEncoreCallbackPoller(d);
    try {
      await waitFor(async () => (await pipelines.get(pipelineId))?.status === 'failed');
    } finally {
      stop();
    }

    expect(await redis.scard(keys.pendingPackaging(INSTANCE_ID))).toBe(0);
  });
});

// #498: a packaging job ZADD'd onto encore-packager:jobs while no packager exists
// sits there indefinitely (nothing expires unconsumed entries). When a packager is
// later provisioned on-demand it drains EVERY queued member in arrival order,
// including ancient ghosts referencing dead Encore jobs. Because the packager's
// failure callback carries no jobId, that ghost's failure is misattributed to
// WHATEVER execution currently has a running `package` step — killing an unrelated
// fresh run. purgeStalePackagingJobs removes any entry older than the stall bound
// BEFORE every enqueue so a newly-provisioned packager can never drain such a ghost.
describe('encore-callback-poller — stale packaging-job purge (#498)', () => {
  const PACKAGING_QUEUE_KEY = 'encore-packager:jobs';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('purges (ZREM) and logs a queue entry older than the stall bound', async () => {
    const redis = new FakeRedis();
    const now = 1_700_000_000_000;
    const ghost = JSON.stringify({ jobId: 'ancient-asset', url: `${BASE_URL}/encoreJobs/dead` });
    // Enqueued just past the 15-minute stall bound ago -> a ghost.
    await redis.zadd(PACKAGING_QUEUE_KEY, now - (DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 60_000), ghost);

    const warnings: Array<Record<string, unknown>> = [];
    const logger = { warn: (o: Record<string, unknown>) => warnings.push(o) };

    await purgeStalePackagingJobs(redis as unknown as import('ioredis').Redis, PACKAGING_QUEUE_KEY, {
      logger,
      now: () => now
    });

    // The ghost is gone and its removal was logged (no silent drops) with content + age.
    expect(redis.zmembers(PACKAGING_QUEUE_KEY)).toHaveLength(0);
    const purgeLog = warnings.find((w) => w.entry === ghost);
    expect(purgeLog).toBeDefined();
    expect(purgeLog!.ageMs).toBe(DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 60_000);
  });

  it('does NOT purge an entry still within the stall bound', async () => {
    const redis = new FakeRedis();
    const now = 1_700_000_000_000;
    const fresh = JSON.stringify({ jobId: 'fresh-asset', url: `${BASE_URL}/encoreJobs/live` });
    // Enqueued one minute ago -> well within the 15-minute bound, must survive.
    await redis.zadd(PACKAGING_QUEUE_KEY, now - 60_000, fresh);

    const warnings: unknown[] = [];
    await purgeStalePackagingJobs(redis as unknown as import('ioredis').Redis, PACKAGING_QUEUE_KEY, {
      logger: { warn: (o: unknown) => warnings.push(o) },
      now: () => now
    });

    expect(redis.zmembers(PACKAGING_QUEUE_KEY)).toEqual([fresh]);
    expect(warnings).toHaveLength(0);
  });

  it('never throws when the purge scan errors — the real enqueue is not blocked', async () => {
    // A redis whose scan rejects. purgeStalePackagingJobs must swallow + log it and
    // resolve, so the caller's subsequent ZADD still runs.
    const boom = {
      zrangebyscore: vi.fn(async () => {
        throw new Error('valkey unreachable');
      }),
      zrem: vi.fn(async () => 1)
    };
    const warnings: unknown[] = [];

    await expect(
      purgeStalePackagingJobs(boom as unknown as import('ioredis').Redis, PACKAGING_QUEUE_KEY, {
        logger: { warn: (o: unknown) => warnings.push(o) }
      })
    ).resolves.toBeUndefined();

    // Scan failed before any removal; the failure was logged, not thrown.
    expect(boom.zrem).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });

  it('purges the ghost BEFORE ZADDing the fresh job at the real handoff (ordering)', async () => {
    const redis = new FakeRedis();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const pipelines = new InMemoryPipelineRepository();
    const encoreUuid = 'uuid-498-order';

    const seeded = await seedScenario(redis, jobs, assets, pipelines, {
      encoreUuid,
      withPackageStep: true
    });
    // completeTranscode only settles a running job to done.
    const localJobId = seeded.externalId.slice(seeded.externalId.indexOf('__') + 2);
    await jobs.update(localJobId, { status: 'running' });

    // A ghost from ~20 minutes ago already sitting on the packager queue.
    const ghost = JSON.stringify({ jobId: 'ancient-asset', url: `${BASE_URL}/encoreJobs/ghost` });
    await redis.zadd(
      PACKAGING_QUEUE_KEY,
      Date.now() - (DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 5 * 60_000),
      ghost
    );

    // The completion message that drives the transcode->package handoff.
    await redis.zadd(
      QUEUE_KEY,
      Date.now(),
      JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` })
    );

    const zaddSpy = vi.spyOn(redis, 'zadd');
    const zremSpy = vi.spyOn(redis, 'zrem');

    vi.stubGlobal(
      'fetch',
      makeFetch({
        successfulUuids: [encoreUuid],
        jobDocs: { [encoreUuid]: { externalId: seeded.externalId, status: 'SUCCESSFUL', output: [] } }
      })
    );

    const stop = startEncoreCallbackPoller({
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipelines,
      oscContext: OSC_CONTEXT_STUB,
      queueKey: QUEUE_KEY,
      packagingQueueKey: PACKAGING_QUEUE_KEY,
      logger: NOOP_LOGGER
    });
    try {
      await waitFor(() =>
        redis.zmembers(PACKAGING_QUEUE_KEY).some((m) => JSON.parse(m).jobId === seeded.assetId)
      );
    } finally {
      stop();
    }

    // The ghost was purged; only the fresh job remains on the packager queue.
    const members = redis.zmembers(PACKAGING_QUEUE_KEY);
    expect(members).toHaveLength(1);
    expect(JSON.parse(members[0]!).jobId).toBe(seeded.assetId);

    // Ordering: the ZREM that removed the ghost ran BEFORE the ZADD of the fresh job.
    const ghostZremIdx = zremSpy.mock.calls.findIndex(
      (c) => c[0] === PACKAGING_QUEUE_KEY && c[1] === ghost
    );
    const freshZaddIdx = zaddSpy.mock.calls.findIndex(
      (c) => c[0] === PACKAGING_QUEUE_KEY && typeof c[2] === 'string' && JSON.parse(c[2] as string).jobId === seeded.assetId
    );
    expect(ghostZremIdx).toBeGreaterThanOrEqual(0);
    expect(freshZaddIdx).toBeGreaterThanOrEqual(0);
    expect(zremSpy.mock.invocationCallOrder[ghostZremIdx]!).toBeLessThan(
      zaddSpy.mock.invocationCallOrder[freshZaddIdx]!
    );
  });
});
