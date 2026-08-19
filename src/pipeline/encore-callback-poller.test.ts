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

import { sweepTerminalJobs, startEncoreCallbackPoller } from './encore-callback-poller.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';

// --- Minimal in-memory Redis --------------------------------------------------
// Extends the FakeRedis idea from test/encore-scaler-idle-timeout.test.ts with
// the string-key (get/set/keys), hash (hget/hset/hgetall) and sorted-set
// (zadd/zscore/zrem/zrangebyscore/bzpopmin) commands this module touches.
class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();

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

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
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
  async zrangebyscore(key: string, _min: string, _max: string, withScores?: string): Promise<string[]> {
    const entries = [...this.zset(key).entries()].sort((a, b) => a[1] - b[1]);
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
  opts: { encoreUuid: string; jobStatus?: 'queued' | 'failed' | 'done' }
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

  // Pipeline with a running `transcode` step bound to this Encore job.
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

  // The InMemoryJobRepository assigns sequential ids; recover the local id from
  // the encoreJobId we embedded so assertions don't depend on that counter.
  function findLocalJobId(externalId: string): string {
    // encodeEncoreJobId is `${workspaceId}__${jobLocalId}`.
    const sep = externalId.indexOf('__');
    return externalId.slice(sep + 2);
  }
});
