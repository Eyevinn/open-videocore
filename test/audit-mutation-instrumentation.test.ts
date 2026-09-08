// Audit instrumentation of meaningful mutations (issue #564, parent #529).
//
// Verifies the v1 "meaningful mutations" each emit EXACTLY ONE audit entry via
// the append-only store's write primitive, and that a failing audit write never
// fails the primary operation (best-effort / fire-and-forget, issue #564).
//
// Contract grounding (verified before writing):
//   - AuditEmitter.record + emitAudit fire-and-forget wrapper — src/data/audit-emit.ts.
//   - RecordAuditInput shape (actor/action/targetType/targetId/detail) and the
//     closed AUDIT_TARGET_TYPES ['asset','collection','job'] — src/data/audit-repo.ts:40,76-85.
//   - assetsRouter / collectionsRouter `audit?` option — src/routes/assets.ts,
//     src/routes/collections.ts.
//   - submitTranscode / completeTranscode `audit` dep — src/pipeline/transcode.ts.
//   - PackagingService `audit` dep — src/pipeline/packaging.ts.
//   - Job terminal transitions + JobRepository — src/data/job-repo.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { submitTranscode, completeTranscode } from '../src/pipeline/transcode.js';
import { PackagingService, type PackageQueue, type PackagingJob } from '../src/pipeline/packaging.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import type { AuditEmitter } from '../src/data/audit-emit.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

// Records every emitted entry so a test can assert count + shape. A `failNext`
// toggle makes the NEXT record() reject, to prove the primary op survives.
class RecordingEmitter implements AuditEmitter {
  readonly entries: RecordAuditInput[] = [];
  failAlways = false;
  async record(input: RecordAuditInput): Promise<unknown> {
    if (this.failAlways) {
      throw new Error('simulated audit store failure');
    }
    this.entries.push(input);
    return { id: `entry-${this.entries.length}` };
  }
}

// Poll the emitter until at least `n` entries have landed. emitAudit is
// fire-and-forget (detached microtask), so a small await lets the chain settle.
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function buildAssetsApp(
  repo: InMemoryAssetRepository,
  audit: AuditEmitter
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo, audit });
  await app.ready();
  return app;
}

async function buildCollectionsApp(
  repo: InMemoryCollectionRepository,
  assets: InMemoryAssetRepository,
  audit: AuditEmitter
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: repo,
    assetRepository: assets,
    audit
  });
  await app.ready();
  return app;
}

describe('asset mutation audit instrumentation (issue #564)', () => {
  let repo: InMemoryAssetRepository;
  let audit: RecordingEmitter;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    audit = new RecordingEmitter();
    app = await buildAssetsApp(repo, audit);
  });

  it('create emits exactly one asset.created entry', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/assets', payload: { name: 'Clip' } });
    expect(res.statusCode).toBe(201);
    await settle();
    expect(audit.entries).toHaveLength(1);
    const [e] = audit.entries;
    expect(e.action).toBe('asset.created');
    expect(e.targetType).toBe('asset');
    expect(e.targetId).toBe((res.json() as { id: string }).id);
    expect(e.actor).toEqual({ principalId: null, origin: 'user' });
  });

  it('metadata edit emits exactly one asset.metadata_updated entry', async () => {
    const created = (await repo.create({ name: 'Clip' })).id;
    audit.entries.length = 0;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${created}/metadata`,
      payload: { genre: 'doc' }
    });
    expect(res.statusCode).toBe(200);
    await settle();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('asset.metadata_updated');
    expect(audit.entries[0].targetId).toBe(created);
  });

  it('lifecycle status transition emits exactly one asset.status_changed entry', async () => {
    const created = (await repo.create({ name: 'Clip' })).id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${created}`,
      payload: { status: 'processing' }
    });
    expect(res.statusCode).toBe(200);
    await settle();
    const statusEntries = audit.entries.filter((e) => e.action === 'asset.status_changed');
    expect(statusEntries).toHaveLength(1);
    expect(statusEntries[0].detail).toEqual({ from: 'uploading', to: 'processing' });
  });

  it('a same-status PATCH (no transition) emits NO status_changed entry', async () => {
    const created = (await repo.create({ name: 'Clip' })).id;
    audit.entries.length = 0;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${created}`,
      payload: { status: 'uploading' }
    });
    expect(res.statusCode).toBe(200);
    await settle();
    expect(audit.entries.filter((e) => e.action === 'asset.status_changed')).toHaveLength(0);
  });

  it('delete/archive emits exactly one asset.archived entry', async () => {
    const created = (await repo.create({ name: 'Clip' })).id;
    audit.entries.length = 0;
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${created}` });
    expect(res.statusCode).toBe(204);
    await settle();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('asset.archived');
    expect(audit.entries[0].targetId).toBe(created);
  });

  it('a failing audit write does not fail the primary create', async () => {
    audit.failAlways = true;
    const res = await app.inject({ method: 'POST', url: '/api/v1/assets', payload: { name: 'Resilient' } });
    // Primary op succeeds despite every audit write rejecting.
    expect(res.statusCode).toBe(201);
    await settle();
    expect(audit.entries).toHaveLength(0);
    // The asset really was persisted.
    expect(await repo.get((res.json() as { id: string }).id)).toBeDefined();
  });
});

describe('collection mutation audit instrumentation (issue #564)', () => {
  let repo: InMemoryCollectionRepository;
  let assets: InMemoryAssetRepository;
  let audit: RecordingEmitter;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryCollectionRepository();
    assets = new InMemoryAssetRepository();
    audit = new RecordingEmitter();
    app = await buildCollectionsApp(repo, assets, audit);
  });

  it('create emits exactly one collection.created entry', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Set A' } });
    expect(res.statusCode).toBe(201);
    await settle();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('collection.created');
    expect(audit.entries[0].targetType).toBe('collection');
  });

  it('membership add + remove each emit exactly one entry', async () => {
    const collection = await repo.create({ name: 'Set A' });
    const asset = await assets.create({ name: 'Clip' });
    audit.entries.length = 0;

    const addRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collection.id}/assets/${asset.id}`
    });
    expect(addRes.statusCode).toBe(200);
    await settle();
    expect(audit.entries.filter((e) => e.action === 'collection.member_added')).toHaveLength(1);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}/assets/${asset.id}`
    });
    expect(removeRes.statusCode).toBe(200);
    await settle();
    expect(audit.entries.filter((e) => e.action === 'collection.member_removed')).toHaveLength(1);
  });

  it('delete emits exactly one collection.deleted entry (and none for an unknown id)', async () => {
    const collection = await repo.create({ name: 'Set A' });
    audit.entries.length = 0;

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/collections/${collection.id}` });
    expect(res.statusCode).toBe(204);
    await settle();
    expect(audit.entries.filter((e) => e.action === 'collection.deleted')).toHaveLength(1);

    // Idempotent no-op on an unknown id emits nothing.
    audit.entries.length = 0;
    const noop = await app.inject({ method: 'DELETE', url: '/api/v1/collections/does-not-exist' });
    expect(noop.statusCode).toBe(204);
    await settle();
    expect(audit.entries).toHaveLength(0);
  });

  it('a failing audit write does not fail the primary create', async () => {
    audit.failAlways = true;
    const res = await app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Resilient' } });
    expect(res.statusCode).toBe(201);
    await settle();
    expect(audit.entries).toHaveLength(0);
  });
});

// A queue fake that records enqueues (submission path) and can be forced to
// throw so the failed-submission branch is exercised without emitting.
class RecordingQueue implements PackageQueue {
  readonly jobs: PackagingJob[] = [];
  fail = false;
  async enqueue(job: PackagingJob): Promise<void> {
    if (this.fail) throw new Error('queue down');
    this.jobs.push(job);
  }
}

// Minimal EncoreClient stub: submit returns a deterministic internal id.
const encoreStub: EncoreClient = {
  submit: async () => ({ encoreInternalId: 'enc-internal-1' }),
  getJobStatus: async () => undefined,
  cancel: async () => undefined
} as unknown as EncoreClient;

describe('job (transcode/package) mutation audit instrumentation (issue #564)', () => {
  it('transcode submission emits exactly one job.submitted entry targeting the new job', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const source = await assets.create({ name: 'Source' });
    const audit = new RecordingEmitter();

    const result = await submitTranscode(
      {
        workspaceId: 'ctx',
        sourceAssetId: source.id,
        sourceObjectKey: 'src/key',
        sourceBucket: 'source-bucket',
        outputBucket: 'output-bucket'
      },
      { jobs, assets, encore: encoreStub, audit }
    );
    await settle();
    const submitted = audit.entries.filter((e) => e.action === 'job.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].targetType).toBe('job');
    expect(submitted[0].targetId).toBe(result.jobId);
    expect(submitted[0].detail).toMatchObject({ jobType: 'transcode' });
  });

  it('transcode terminal success emits exactly one job.completed entry', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const source = await assets.create({ name: 'Source' });
    const job = await jobs.create({ type: 'transcode', assetId: source.id });
    // Advance to a non-terminal running state so completeTranscode applies.
    await jobs.update(job.id, { status: 'running' });
    await assets.update(source.id, { status: 'processing' });
    const audit = new RecordingEmitter();

    await completeTranscode(
      {
        jobId: job.id,
        sourceAssetId: source.id,
        success: true,
        renditions: [{ label: '720p', width: 1280, height: 720, objectKey: 'r/720' }]
      },
      { jobs, assets, audit }
    );
    await settle();
    const completed = audit.entries.filter((e) => e.action === 'job.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].targetId).toBe(job.id);
  });

  it('duplicate terminal callback emits NO second entry (idempotent)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const source = await assets.create({ name: 'Source' });
    const job = await jobs.create({ type: 'transcode', assetId: source.id });
    await jobs.update(job.id, { status: 'running' });
    await assets.update(source.id, { status: 'processing' });
    const audit = new RecordingEmitter();

    const params = {
      jobId: job.id,
      sourceAssetId: source.id,
      success: false,
      error: 'boom',
      renditions: []
    };
    await completeTranscode(params, { jobs, assets, audit });
    await completeTranscode(params, { jobs, assets, audit }); // late duplicate
    await settle();
    expect(audit.entries.filter((e) => e.action === 'job.failed')).toHaveLength(1);
  });

  it('package submission emits one job.submitted; success + failure callbacks each emit one entry', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'Source' });
    const queue = new RecordingQueue();
    const audit = new RecordingEmitter();
    const svc = new PackagingService({ assets, queue, audit });

    await svc.triggerPackaging(asset.id, 'http://encore/job/1');
    await settle();
    expect(audit.entries.filter((e) => e.action === 'job.submitted')).toHaveLength(1);
    expect(audit.entries[0].detail).toMatchObject({ jobType: 'package' });

    await svc.handleSuccess({ url: 'http://encore/job/1', jobId: asset.id, outputPath: '/pkg/asset/job/' });
    await settle();
    expect(audit.entries.filter((e) => e.action === 'job.completed')).toHaveLength(1);

    await svc.handleFailure(asset.id, 'packager error');
    await settle();
    expect(audit.entries.filter((e) => e.action === 'job.failed')).toHaveLength(1);
  });

  it('a failed enqueue emits no submission entry and does not throw', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'Source' });
    const queue = new RecordingQueue();
    queue.fail = true;
    const audit = new RecordingEmitter();
    const svc = new PackagingService({ assets, queue, audit });

    // triggerPackaging never throws (records packagingError on the asset).
    await expect(svc.triggerPackaging(asset.id, 'http://encore/job/1')).resolves.toBeUndefined();
    await settle();
    expect(audit.entries.filter((e) => e.action === 'job.submitted')).toHaveLength(0);
  });

  it('a failing audit write does not fail transcode submission', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const source = await assets.create({ name: 'Source' });
    const audit = new RecordingEmitter();
    audit.failAlways = true;

    await expect(
      submitTranscode(
        {
          workspaceId: 'ctx',
          sourceAssetId: source.id,
          sourceObjectKey: 'src/key',
          sourceBucket: 'source-bucket',
          outputBucket: 'output-bucket'
        },
        { jobs, assets, encore: encoreStub, audit }
      )
    ).resolves.toMatchObject({ jobId: expect.any(String) });
    await settle();
    expect(audit.entries).toHaveLength(0);
  });
});
