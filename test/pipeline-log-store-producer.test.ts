// LogStore producer wiring for pipeline steps (issue #995, parent #985).
//
// Before this, `LogStore.append()` had NO callers outside the store's own tests:
// `GET /api/v1/logs` and `public/logs-table.js` were a finished read path over a
// store nothing ever wrote to, so the Logs tab could only ever render an empty
// page. These tests drive a real ingest -> transcode -> package run through the
// real routers and assert the run itself populates the store the listing endpoint
// reads — i.e. they prove `append()` is called during a pipeline run, not in
// isolation.
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - Write primitive `LogStore.append(input: AppendLogInput)` and
//     `AppendLogInput = { message; level?; category?; timestamp? }` —
//     src/services/log-store.ts:112-122 and :43-48. `seq`/`timestamp` are
//     store-assigned, so nothing here supplies them.
//   - Level vocabulary `LOG_LEVELS = ['debug','info','warn','error']` —
//     src/services/log-store.ts:25, on the response contract as
//     `z.enum(LOG_LEVELS)` — src/routes/logs.ts:40.
//   - Read contract that MUST stay unchanged: the handler calls
//     `logStore.list({ limit, cursor, from, to, q, order })` —
//     src/routes/logs.ts:94, querystring `listLogsQuerySchema` —
//     src/routes/logs.ts:46-58, envelope `{ items, nextCursor }` —
//     src/routes/logs.ts:60-64. Asserted directly below (filters + cursor paging
//     still behave over producer-generated records).
//   - Renderer requirements: level badge reads `r.level`
//     (public/logs-table.js:241-248), category column reads `r.category`
//     (public/logs-table.js:250-253), and the `q` filter searches `message` only
//     (public/logs-table.js:145-147).
//   - `PIPELINE_STEPS` / `BUILT_IN_PIPELINES` (`ingest` = extract-metadata +
//     thumbnail, `abr-vod` = transcode + package) — src/pipeline/pipelines.ts:22,49-57.
//   - Encore completion callback body `{ externalId, status, message?, output? }`
//     — src/routes/internal.ts:98-103; packager success body
//     `{ url, jobId, outputPath? }` — src/routes/internal.ts:61-65.
//   - Packager work item `PackagingJob = { jobId, url }` —
//     src/pipeline/packaging.ts (PackagingJob).
//   - Encore job URL fast path the transcode->package handoff reads:
//     `keys.jobEncoreUrl(encoreJobId)` — src/encore-scaler/types.ts, read at
//     src/routes/internal.ts resolveEncoreJobUrl.
//   - `StepExecution.encoreJobId` (the correlation key the callback is posted
//     with) — src/data/pipeline-repo.ts:43-56.

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { internalRouter } from '../src/routes/internal.js';
import { logsRouter } from '../src/routes/logs.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import { LOG_LEVELS, LogStore } from '../src/services/log-store.js';
import { logPipelineEvent } from '../src/services/pipeline-log.js';
import { runPull } from '../src/pipeline/url-pull-worker.js';
import { PackagingService, type PackageQueue, type PackagingJob } from '../src/pipeline/packaging.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import { keys } from '../src/encore-scaler/types.js';

const A = { authorization: 'Bearer token-a' };

const ENCORE_JOB_URL = 'https://encore-1.osc.example/encoreJobs/6f1c0f6e-0000-4000-8000-000000000001';

type LogItem = {
  seq: number;
  timestamp: string;
  message: string;
  level?: string;
  category?: string;
};
type LogPage = { items: LogItem[]; nextCursor: string | null };

// Minimal Redis stand-in. Only the fast path of resolveEncoreJobUrl
// (src/routes/internal.ts) is exercised: `get(keys.jobEncoreUrl(id))` returns the
// stored Encore job URL, which is what makes the transcode->package handoff fire.
// Every other command answers "absent" so the best-effort pool bookkeeping
// (decrementActiveJobs, packaging pins) no-ops instead of throwing.
function makeRedis(): import('ioredis').Redis {
  const jobUrlPrefix = keys.jobEncoreUrl('');
  return {
    get: async (key: string) => (key.startsWith(jobUrlPrefix) ? ENCORE_JOB_URL : null),
    hget: async () => null,
    hset: async () => 1,
    hdel: async () => 1,
    sadd: async () => 1,
    srem: async () => 1,
    pexpire: async () => 1,
    smembers: async () => []
  } as unknown as import('ioredis').Redis;
}

function fakeQueue(opts: { fail?: boolean } = {}): {
  queue: PackageQueue;
  enqueued: PackagingJob[];
} {
  const enqueued: PackagingJob[] = [];
  return {
    enqueued,
    queue: {
      enqueue: vi.fn(async (job: PackagingJob) => {
        if (opts.fail) throw new Error('queue unreachable');
        enqueued.push(job);
      })
    }
  };
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  logStore: LogStore;
  enqueued: PackagingJob[];
};

async function buildApp(opts: { queueFails?: boolean } = {}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  // ONE store instance shared by every producer and by the listing router —
  // exactly how src/main.ts wires the single `logStore` const into the assets
  // router, the internal router, the packaging service and the callback poller.
  const logStore = new LogStore();
  const { queue, enqueued } = fakeQueue({ fail: opts.queueFails });
  const redis = makeRedis();

  const packaging = new PackagingService({
    assets,
    queue,
    jobs,
    pipeline: pipelines,
    publicBaseUrl: 'https://cdn.example/packaged',
    pipelineLog: logStore
  });
  const encore = {
    submit: vi.fn(async () => ({ encoreInternalId: 'encore-internal-1' })),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    packaging,
    packagingRedis: redis,
    pipelineLog: logStore
  });
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging,
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    redis,
    pipelineLog: logStore
  });
  await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
  await app.ready();
  return { app, assets, jobs, pipelines, logStore, enqueued };
}

async function seedAsset(h: Harness): Promise<string> {
  const asset = await h.assets.create({ name: 'my-video' });
  await h.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
  return asset.id;
}

function execute(app: FastifyInstance, assetId: string, pipeline: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/execute`,
    headers: A,
    payload: { pipeline }
  });
}

// The encoreJobId stamped on the running `transcode` step — the correlation key
// Encore posts its completion back with (src/data/pipeline-repo.ts:43-56).
//
// Also advances the step's Job `queued -> running`, which is what the scaler's
// onDispatched callback does at dispatch time in production (src/pipeline/
// transcode.ts submitTranscode only ENQUEUES, leaving the job `queued`). Without
// it `queued -> done` is an illegal Job transition (ALLOWED_JOB_TRANSITIONS,
// src/data/job-repo.ts:245-252) and the success callback 422s.
async function dispatchedTranscode(h: Harness, assetId: string): Promise<string> {
  const execution = (await h.pipelines.listByAsset(assetId)).find((e) => e.status === 'running');
  expect(execution).toBeDefined();
  const step = execution!.steps.find((s) => s.name === 'transcode');
  expect(step?.encoreJobId).toBeTruthy();
  expect(step?.jobId).toBeTruthy();
  await h.jobs.update(step!.jobId!, { status: 'running' });
  return step!.encoreJobId!;
}

function encoreCallback(app: FastifyInstance, externalId: string, status: string, message?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/internal/encore-callback',
    payload: {
      externalId,
      status,
      ...(message ? { message } : {}),
      ...(status === 'SUCCESSFUL'
        ? {
            output: [
              {
                file: 'transcode/rendition_1080p.mp4',
                type: 'VideoFile',
                videoStreams: [{ width: 1920, height: 1080 }],
                overallBitrate: 5_000_000
              }
            ]
          }
        : {})
    }
  });
}

function packagerSuccess(app: FastifyInstance, assetId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/internal/packagerCallback/success',
    payload: { url: ENCORE_JOB_URL, jobId: assetId, outputPath: `${assetId}/packager-job-1/` }
  });
}

// The logs listing is behind the 401 presence gate (src/routes/logs.ts, the
// `authGate(app)` preHandler added on the #995 review), so this harness — which
// calls registerAuth above — must send a bearer token like every other gated
// read in these tests.
async function listLogs(app: FastifyInstance, query = 'limit=200&order=asc'): Promise<LogPage> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/logs?${query}`, headers: A });
  expect(res.statusCode).toBe(200);
  return res.json() as LogPage;
}

// Drive a full ingest -> transcode -> package run through the real routers and
// callbacks. Returns the asset id.
async function runFullFlow(h: Harness): Promise<string> {
  const assetId = await seedAsset(h);

  // Stage 1 — ingest (BUILT_IN_PIPELINES.ingest = extract-metadata + thumbnail).
  const ingest = await execute(h.app, assetId, 'ingest');
  expect(ingest.statusCode).toBe(202);

  // Stage 2 — transcode, then stage 3 — package (BUILT_IN_PIPELINES['abr-vod']).
  const abr = await execute(h.app, assetId, 'abr-vod');
  expect(abr.statusCode).toBe(202);

  const externalId = await dispatchedTranscode(h, assetId);
  // Encore reports success: completeTranscode settles the transcode step and the
  // handoff enqueues the packaging job.
  const cb = await encoreCallback(h.app, externalId, 'SUCCESSFUL');
  expect(cb.statusCode).toBe(200);
  expect(cb.json().applied).toBe(true);

  // The packager signals completion.
  const pkg = await packagerSuccess(h.app, assetId);
  expect(pkg.statusCode).toBe(200);

  return assetId;
}

describe('LogStore producer: append() during a pipeline run (issue #995)', () => {
  it('calls LogStore.append() while a pipeline executes', async () => {
    const h = await buildApp();
    const appendSpy = vi.spyOn(h.logStore, 'append');
    expect(appendSpy).not.toHaveBeenCalled();

    const res = await execute(h.app, await seedAsset(h), 'ingest');
    expect(res.statusCode).toBe(202);

    // The core regression this issue exists for: the write path is reached by a
    // normal run, not only by the store's own tests.
    expect(appendSpy).toHaveBeenCalled();
    expect(h.logStore.size()).toBeGreaterThan(0);
    await h.app.close();
  });

  it('records at least one entry per stage of a full ingest -> transcode -> package run', async () => {
    const h = await buildApp();
    await runFullFlow(h);

    const page = await listLogs(h.app);
    const categories = page.items.map((r) => r.category);
    // Acceptance criterion: one entry MINIMUM per stage, all retrievable through
    // the listing endpoint.
    expect(categories).toContain('ingest');
    expect(categories).toContain('transcode');
    expect(categories).toContain('package');
    await h.app.close();
  });

  it('every entry carries a renderable level and message', async () => {
    const h = await buildApp();
    await runFullFlow(h);

    const page = await listLogs(h.app);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      // The level badge (public/logs-table.js:241-248) needs a value from the
      // store's own enum; the message is the filter + display target.
      expect(LOG_LEVELS).toContain(item.level as (typeof LOG_LEVELS)[number]);
      expect(item.message.length).toBeGreaterThan(0);
      // Stage-prefixed so the server-side `q` (message-only) filter can select a
      // whole stage — the listing endpoint has no `category` param.
      expect(item.message.startsWith(`${item.category}: `)).toBe(true);
    }
    await h.app.close();
  });

  it('reports a transcode failure at error level', async () => {
    const h = await buildApp();
    const assetId = await seedAsset(h);
    expect((await execute(h.app, assetId, 'abr-vod')).statusCode).toBe(202);
    const externalId = await dispatchedTranscode(h, assetId);

    const cb = await encoreCallback(h.app, externalId, 'FAILED', 'encoder crashed');
    expect(cb.statusCode).toBe(200);

    const page = await listLogs(h.app);
    const failures = page.items.filter((r) => r.level === 'error');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((r) => r.message.includes('encoder crashed'))).toBe(true);
    await h.app.close();
  });

  it('reports a failed packaging enqueue at error level', async () => {
    const h = await buildApp({ queueFails: true });
    const assetId = await seedAsset(h);
    expect((await execute(h.app, assetId, 'abr-vod')).statusCode).toBe(202);
    const externalId = await dispatchedTranscode(h, assetId);
    expect((await encoreCallback(h.app, externalId, 'SUCCESSFUL')).statusCode).toBe(200);

    const page = await listLogs(h.app);
    const pkgErrors = page.items.filter((r) => r.category === 'package' && r.level === 'error');
    expect(pkgErrors.length).toBeGreaterThan(0);
    await h.app.close();
  });
});

describe('LogStore read contract is unchanged by the producer (issue #995)', () => {
  it('still filters producer-written entries by q on message only', async () => {
    const h = await buildApp();
    await runFullFlow(h);

    // `q` is a case-insensitive substring match on `message`
    // (src/routes/logs.ts:54-55 -> src/services/log-store.ts:143).
    const page = await listLogs(h.app, 'limit=200&order=asc&q=TRANSCODE%3A');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((r) => r.category === 'transcode')).toBe(true);
    await h.app.close();
  });

  it('still pages producer-written entries with the opaque cursor envelope', async () => {
    const h = await buildApp();
    await runFullFlow(h);

    const all = await listLogs(h.app, 'limit=200&order=asc');
    expect(all.items.length).toBeGreaterThan(1);
    expect(all.nextCursor).toBeNull();

    const p1 = await listLogs(h.app, 'limit=1&order=asc');
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listLogs(
      h.app,
      `limit=1&order=asc&cursor=${encodeURIComponent(p1.nextCursor!)}`
    );
    expect(p2.items).toHaveLength(1);
    // Strictly after page 1's boundary — no repeat, no gap.
    expect(p2.items[0].seq).toBeGreaterThan(p1.items[0].seq);
    await h.app.close();
  });

  it('still honours the from/to time range over producer-written entries', async () => {
    const h = await buildApp();
    await runFullFlow(h);

    const all = await listLogs(h.app, 'limit=200&order=asc');
    const from = all.items[0].timestamp;
    const to = all.items[all.items.length - 1].timestamp;
    const ranged = await listLogs(
      h.app,
      `limit=200&order=asc&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    expect(ranged.items).toHaveLength(all.items.length);

    // A window entirely before the run returns nothing rather than everything.
    const empty = await listLogs(
      h.app,
      `limit=200&order=asc&to=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`
    );
    expect(empty.items).toHaveLength(0);
    await h.app.close();
  });
});

describe('LogStore producer: URL-pull ingest (issue #995)', () => {
  // The other `ingest`-stage producer: the detached URL-pull worker, which
  // outlives the request that started it, so its entries are the only record the
  // Logs tab gets of a URL ingest.
  // An `s3:` source so the pull is driven entirely through the injected
  // `openS3` reader (src/pipeline/source.ts openSource) — no DNS lookup, no
  // outbound request, no SSRF guard in the path.
  const params = {
    jobId: 'job-1',
    assetId: 'asset-1',
    objectKey: 'ingest/asset-1',
    sourceUrl: 's3://my-bucket/clip.mp4'
  };

  function openS3() {
    return async () => ({
      stream: Readable.from([Buffer.from('media-bytes')]),
      totalBytes: 1234
    });
  }

  it('appends ingest entries on a successful pull', async () => {
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const logStore = new LogStore();
    const asset = await assets.create({ name: 'pulled' });
    const job = await jobs.create({ type: 'ingest-url', assetId: asset.id });

    await runPull(
      { ...params, jobId: job.id, assetId: asset.id },
      {
        jobs,
        assets,
        storage: {
          putStream: async () => ({ bytesTransferred: 1234 }),
          // Orphaned-multipart cleanup the worker runs around each write
          // (issue #1088) — nothing in progress, so no log entry of its own.
          abortIncompleteMultipartUploads: async () => 0
        } as unknown as import('../src/data/storage.js').WorkspaceStorage,
        openS3: openS3(),
        pipelineLog: logStore
      }
    );

    const items = logStore.list({ limit: 200, order: 'asc' }).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((r) => r.category === 'ingest')).toBe(true);
    expect(items.some((r) => r.level === 'info' && r.message.includes('1234'))).toBe(true);
  });

  it('appends an error-level ingest entry on a terminal pull failure', async () => {
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const logStore = new LogStore();
    const asset = await assets.create({ name: 'pulled' });
    const job = await jobs.create({ type: 'ingest-url', assetId: asset.id });

    await runPull(
      { ...params, jobId: job.id, assetId: asset.id },
      {
        jobs,
        assets,
        storage: {
          putStream: async () => {
            throw new Error('storage offline');
          },
          abortIncompleteMultipartUploads: async () => 0
        } as unknown as import('../src/data/storage.js').WorkspaceStorage,
        openS3: openS3(),
        sleep: async () => undefined,
        pipelineLog: logStore
      }
    );

    const items = logStore.list({ limit: 200, order: 'asc' }).items;
    const errors = items.filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].category).toBe('ingest');
    expect(errors[0].message).toContain('storage offline');
  });
});

describe('logPipelineEvent never fails the step it reports on (issue #995)', () => {
  it('swallows a throwing sink and reports it to the error log', () => {
    const errors: unknown[] = [];
    expect(() =>
      logPipelineEvent(
        {
          append: () => {
            throw new Error('store exploded');
          }
        },
        { stage: 'transcode', level: 'info', message: 'submitted job j1' },
        { error: (obj) => errors.push(obj) }
      )
    ).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('is a no-op with no sink wired', () => {
    expect(() =>
      logPipelineEvent(undefined, { stage: 'package', level: 'info', message: 'enqueued' })
    ).not.toThrow();
  });
});
