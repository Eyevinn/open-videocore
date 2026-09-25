// Live transcode progress — Encore's `progress` is read off the IN_PROGRESS
// findByStatus page the sweep already fetches, persisted onto the local job, and
// surfaced on the running transcode step of GET /api/v1/pipelines (issue #830).
//
// Runs WITHOUT OSC or a real Redis, in the style of encore-callback-poller.test.ts:
// a minimal in-memory FakeRedis stands in for Valkey, the codebase's own
// in-memory repositories stand in for CouchDB, and global fetch is stubbed to
// emulate the Encore instance HTTP API.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7) — Encore's own
// OpenAPI document, fetched live from a running OSC Encore instance at
// GET /v3/api-docs (2026-09-25, instance scalerovctestmtvumibi):
//   - path `/encoreJobs/search/findByStatus` (operationId
//     `executeSearch-encorejob-get`), `status` query enum includes IN_PROGRESS;
//     200 schema `PagedModelEntityModelEncoreJob` =
//     { _embedded: { encoreJobs: EntityModelEncoreJob[] }, page, _links }.
//   - `EntityModelEncoreJob.progress` — {"type":"integer","format":"int32",
//     "default":"0","description":"The EncoreJob progress","example":57,
//     "readOnly":true}.
//   - `EntityModelEncoreJob.externalId` — {"type":"string","description":
//     "External id - for external backreference"}; submitted by us as
//     `externalId: encoreJobId` (src/pipeline/transcode.ts:146) and resolved via
//     JobRepository.findByEncoreJobId (src/data/job-repo.ts:257).
//   - Write target UpdateJobInput.progress (src/data/job-repo.ts:176); read side
//     enrichWithProgress + stepExecutionSchema.progress (src/routes/pipelines.ts).
//   - keys.pool (src/encore-scaler/types.ts); encodeEncoreJobId (job-repo.ts:144).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { sweepTerminalJobs, syncInProgressJobProgress } from './encore-callback-poller.js';
import { pipelinesRouter } from '../routes/pipelines.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';

const WORKSPACE = 'ws-progress';
const INSTANCE_ID = 'inst-progress';
const BASE_URL = 'https://encore-progress.example';
const QUEUE_KEY = 'ovc:transcode-done';

// Only the Redis surface the sweep touches: pool discovery (keys/hgetall) plus
// the uuid/queue reads the terminal pass makes (empty here — no terminal jobs).
class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    return h;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...this.strings.keys(), ...this.hashes.keys(), ...this.zsets.keys()].filter((k) => re.test(k));
  }
  async zscore(): Promise<string | null> {
    return null;
  }
  async zadd(): Promise<number> {
    return 1;
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-sat'
} as unknown as import('@osaas/client-core').Context;

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const INSTANCE_RECORD: EncoreInstanceRecord = {
  instanceId: INSTANCE_ID,
  url: BASE_URL,
  activeJobs: 1,
  lastIdleAt: 0
};

// Answer findByStatus for any status; IN_PROGRESS returns the supplied job
// documents, the terminal statuses return empty pages.
function makeFetch(inProgress: () => Array<{ externalId: string; progress?: number }>) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const jsonRes = (body: unknown) =>
      ({ ok: true, status: 200, async json() { return body; } }) as unknown as Response;
    if (url.includes('/encoreJobs/search/findByStatus')) {
      const status = new URL(url).searchParams.get('status');
      const jobs = status === 'IN_PROGRESS' ? inProgress() : [];
      return jsonRes({ _embedded: { encoreJobs: jobs }, page: { totalElements: jobs.length } });
    }
    return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
  });
}

type Scenario = {
  redis: FakeRedis;
  jobs: InMemoryJobRepository;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  jobId: string;
  externalId: string;
  executionId: string;
};

// A transcode job mid-flight: local job `running` at progress 0 (the defect's
// starting state) with a running `transcode` step bound to it.
async function seedRunningTranscode(): Promise<Scenario> {
  const redis = new FakeRedis();
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipelines = new InMemoryPipelineRepository();

  await redis.hset(keys.pool(WORKSPACE), INSTANCE_ID, JSON.stringify(INSTANCE_RECORD));

  const asset = await assets.create({ name: 'source.mp4' });
  await assets.update(asset.id, { status: 'processing' });

  const job = await jobs.create({ type: 'transcode', assetId: asset.id });
  const externalId = encodeEncoreJobId(WORKSPACE, job.id);
  await jobs.update(job.id, { encoreJobId: externalId, status: 'running' });

  const execution = await pipelines.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  await pipelines.update(execution.id, {
    status: 'running',
    steps: execution.steps.map((s) =>
      s.name === 'transcode'
        ? { ...s, status: 'running' as const, jobId: job.id, encoreJobId: externalId, startedAt: new Date().toISOString() }
        : s
    )
  });

  return { redis, jobs, assets, pipelines, jobId: job.id, externalId, executionId: execution.id };
}

function makeDeps(s: Scenario, extra: Record<string, unknown> = {}) {
  return {
    redis: s.redis as unknown as import('ioredis').Redis,
    jobRepository: s.jobs,
    assetRepository: s.assets,
    pipelineRepository: s.pipelines,
    oscContext: OSC_CONTEXT_STUB,
    logger: NOOP_LOGGER,
    ...extra
  } as unknown as Parameters<typeof sweepTerminalJobs>[0];
}

async function buildPipelinesApp(s: Scenario) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(pipelinesRouter, {
    prefix: '/api/v1/pipelines',
    pipelineRepository: s.pipelines,
    jobRepository: s.jobs,
    assetRepository: s.assets
  });
  await app.ready();
  return app;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('#830 — transcode progress is read from Encore and surfaced', () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await seedRunningTranscode();
  });

  it('copies Encore progress onto the local job and surfaces it on the running transcode step', async () => {
    globalThis.fetch = makeFetch(() => [{ externalId: scenario.externalId, progress: 75 }]) as never;
    const deps = makeDeps(scenario);

    // Before: the defect's observable state — Encore says 75, we say 0.
    const app = await buildPipelinesApp(scenario);
    const before = await app.inject({ method: 'GET', url: '/api/v1/pipelines' });
    expect(before.statusCode).toBe(200);
    expect(before.json().items[0].steps[0].progress ?? 0).toBe(0);

    await sweepTerminalJobs(deps, QUEUE_KEY);

    expect((await scenario.jobs.get(scenario.jobId))?.progress).toBe(75);

    const after = await app.inject({ method: 'GET', url: '/api/v1/pipelines' });
    const step = after.json().items[0].steps.find((x: { name: string }) => x.name === 'transcode');
    expect(step.status).toBe('running');
    expect(step.progress).toBe(75);
    await app.close();
  });

  it('tracks Encore as it advances across sweeps', async () => {
    let reported = 8;
    globalThis.fetch = makeFetch(() => [{ externalId: scenario.externalId, progress: reported }]) as never;
    // No throttle window: every changed value is persisted immediately.
    const deps = makeDeps(scenario, { progressWriteIntervalMs: 0 });

    const seen: number[] = [];
    for (const next of [8, 27, 47, 75]) {
      reported = next;
      await sweepTerminalJobs(deps, QUEUE_KEY);
      seen.push((await scenario.jobs.get(scenario.jobId))!.progress);
    }
    expect(seen).toEqual([8, 27, 47, 75]);
  });

  it('throttles writes: a changed value inside the interval is not persisted, a later one is', async () => {
    let reported = 10;
    globalThis.fetch = makeFetch(() => [{ externalId: scenario.externalId, progress: reported }]) as never;
    const deps = makeDeps(scenario, { progressWriteIntervalMs: 10_000 });

    const updateSpy = vi.spyOn(scenario.jobs, 'update');
    let clock = 1_000_000;
    const now = () => clock;

    // t=0: first sighting is written.
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(1);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(10);

    // t=+3s and t=+6s: Encore has moved, but the interval has not elapsed — no write.
    reported = 20;
    clock += 3_000;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(0);
    reported = 30;
    clock += 3_000;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(0);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(10);

    // t=+11s: the interval has elapsed — the latest value is written.
    reported = 40;
    clock += 5_000;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(1);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(40);

    // Four polls, two writes.
    expect(updateSpy.mock.calls.filter((c) => 'progress' in (c[1] as object)).length).toBe(2);
  });

  it('does not write when Encore repeats the same value, however long the interval', async () => {
    globalThis.fetch = makeFetch(() => [{ externalId: scenario.externalId, progress: 42 }]) as never;
    const deps = makeDeps(scenario, { progressWriteIntervalMs: 0 });
    const updateSpy = vi.spyOn(scenario.jobs, 'update');

    let clock = 2_000_000;
    const now = () => clock;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(1);
    for (let i = 0; i < 5; i++) {
      clock += 60_000;
      expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100, now })).toBe(0);
    }
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(42);
  });

  it('leaves a job that already settled alone', async () => {
    await scenario.jobs.update(scenario.jobId, { status: 'done', progress: 100 });
    globalThis.fetch = makeFetch(() => [{ externalId: scenario.externalId, progress: 55 }]) as never;
    const deps = makeDeps(scenario, { progressWriteIntervalMs: 0 });

    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100 })).toBe(0);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(100);
  });

  it('ignores unknown external ids, absent progress, and a non-ok Encore response', async () => {
    const deps = makeDeps(scenario, { progressWriteIntervalMs: 0 });

    globalThis.fetch = makeFetch(() => [
      { externalId: 'someone-elses__job-x', progress: 90 },
      { externalId: scenario.externalId }
    ]) as never;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100 })).toBe(0);
    expect((await scenario.jobs.get(scenario.jobId))!.progress).toBe(0);

    globalThis.fetch = vi.fn(async () =>
      ({ ok: false, status: 503, async json() { return {}; } }) as unknown as Response
    ) as never;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100 })).toBe(0);

    globalThis.fetch = vi.fn(async () => { throw new Error('connreset'); }) as never;
    expect(await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'sat', { pageSize: 100 })).toBe(0);
  });

  it('queries IN_PROGRESS on the same sweep, honouring the sweep page-size bound', async () => {
    const fetchStub = makeFetch(() => []);
    globalThis.fetch = fetchStub as never;
    await sweepTerminalJobs(makeDeps(scenario, { sweepPageSize: 25 }), QUEUE_KEY);

    const urls = fetchStub.mock.calls.map((c) => String(c[0]));
    const inProgress = urls.filter((u) => u.includes('status=IN_PROGRESS'));
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]).toContain('/encoreJobs/search/findByStatus');
    expect(inProgress[0]).toContain('size=25');
    // Still the same single sweep: the terminal statuses are queried too.
    expect(urls.filter((u) => u.includes('status=SUCCESSFUL'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('status=FAILED'))).toHaveLength(1);
  });
});
