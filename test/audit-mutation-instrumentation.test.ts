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
//   - runPull params/deps (`jobs`/`assets`/`storage`/`openS3`/`sleep`/
//     `onAttemptError` + the `audit`/`auditLog` pair added by #1000) and its
//     single terminal settle points — src/pipeline/url-pull-worker.ts.
//   - WorkspaceStorage.putStream result `{ etag, bytesTransferred }` —
//     src/data/storage.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { submitTranscode, completeTranscode } from '../src/pipeline/transcode.js';
import { PackagingService, type PackageQueue, type PackagingJob } from '../src/pipeline/packaging.js';
import { runPull } from '../src/pipeline/url-pull-worker.js';
import type { WorkspaceStorage } from '../src/data/storage.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import type { AuditEmitter } from '../src/data/audit-emit.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';
import type { StorageFactory } from '../src/routes/assets.js';
import type {
  SourceBackendJobCredentials,
  StorageBackendRegistry
} from '../src/services/storage-backend-registry.js';

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

// Ingest-by-URL creates an asset down TWO branches (issue #999): the default
// OSC-managed pull and the registered-external-backend source (#548, ADR-017
// D4). Both call AssetRepository.create, so both owe the trail the same single
// `asset.created` entry POST / records — previously neither emitted one, so an
// asset that appeared via ingest-url had no accountable creation record.
//
// Contract grounding (verified before writing):
//   - the emission shape copied from POST / — src/routes/assets.ts:2762-2772
//     (actor originActor('user') / action 'asset.created' / targetType 'asset' /
//     targetId / detail).
//   - `detail` is a free-form `z.record(z.string(), z.unknown())` bag, so the
//     added `sourceUrl` key needs no schema change — src/data/audit-repo.ts:65.
//   - `sourceUrl` is the ingest job's own field name — src/data/job-repo.ts:100.
//   - `resolveSourceCredentials(workspaceId, ref) => SourceBackendJobCredentials`
//     — src/services/storage-backend-registry.ts:901-904, type at :398-405.
//   - assetsRouter `storageBackendRegistry` / `storageFor` / `runPull` options —
//     src/routes/assets.ts:930-963.
describe('ingest-url asset.created audit instrumentation (issue #999)', () => {
  // URL-pull ingest 501s without a storage factory; the stubbed pull worker
  // never touches it, so an empty object satisfies the check.
  const storageFor: StorageFactory = () => ({}) as never;

  // A registry stub that resolves one registered source backend. Typed against
  // the real SourceBackendJobCredentials contract so the shape cannot drift;
  // the route only ever calls resolveSourceCredentials on this path.
  const registryStub = {
    resolveSourceCredentials: async (): Promise<SourceBackendJobCredentials> => ({
      bucket: 'ext-bkt',
      awsAccessKeyId: 'AKIA',
      // The route never inlines this; it is a `{{secrets.<name>}}` reference in
      // production and must not reach the audit entry either.
      awsSecretAccessKey: '{{secrets.storagebackend.b1.source.awssecretaccesskey}}',
      s3EndpointUrl: 'https://s3.example.com'
    })
  } as unknown as StorageBackendRegistry;

  async function buildIngestApp(
    repo: InMemoryAssetRepository,
    audit: AuditEmitter,
    withRegistry: boolean
  ): Promise<FastifyInstance> {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(assetsRouter, {
      prefix: '/api/v1/assets',
      repository: repo,
      audit,
      storageFor,
      // Stubbed in-process pull worker: the accepted request returns 202 without
      // any network / S3 work.
      runPull: (async () => undefined) as never,
      ...(withRegistry ? { storageBackendRegistry: registryStub } : {})
    });
    await app.ready();
    return app;
  }

  let repo: InMemoryAssetRepository;
  let audit: RecordingEmitter;

  beforeEach(() => {
    repo = new InMemoryAssetRepository();
    audit = new RecordingEmitter();
  });

  it('the default (OSC-managed pull) branch emits exactly one asset.created entry', async () => {
    const app = await buildIngestApp(repo, audit, false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      // s3:// avoids the SSRF DNS lookup (only http/https hosts are resolved).
      payload: { sourceUrl: 's3://ingest-bucket/clip.mp4', title: 'Pulled Clip' }
    });
    expect(res.statusCode).toBe(202);
    const { assetId } = res.json() as { assetId: string };
    await settle();

    const created = audit.entries.filter((e) => e.action === 'asset.created');
    expect(created).toHaveLength(1);
    expect(created[0].targetType).toBe('asset');
    expect(created[0].targetId).toBe(assetId);
    expect(created[0].actor).toEqual({ principalId: null, origin: 'user' });
    expect(created[0].detail).toMatchObject({
      name: 'Pulled Clip',
      sourceUrl: 's3://ingest-bucket/clip.mp4'
    });
    // Same `status` key POST / records, read off the asset as created.
    expect(typeof created[0].detail?.['status']).toBe('string');
  });

  it('the registered-external-backend branch emits exactly one asset.created entry', async () => {
    const app = await buildIngestApp(repo, audit, true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: {
        sourceUrl: 's3://ext-bkt/path/to/clip.mp4',
        title: 'External Clip',
        sourceBackend: 'my-bucket'
      }
    });
    expect(res.statusCode).toBe(202);
    const { assetId } = res.json() as { assetId: string };
    await settle();

    const created = audit.entries.filter((e) => e.action === 'asset.created');
    expect(created).toHaveLength(1);
    expect(created[0].targetType).toBe('asset');
    expect(created[0].targetId).toBe(assetId);
    expect(created[0].actor).toEqual({ principalId: null, origin: 'user' });
    // The credential-free `s3://bucket/key` locator — the same value stored on
    // the ingest job — and never the resolved credential reference.
    expect(created[0].detail).toMatchObject({
      name: 'External Clip',
      sourceUrl: 's3://ext-bkt/path/to/clip.mp4'
    });
    expect(JSON.stringify(created[0])).not.toContain('secrets.');
    expect(JSON.stringify(created[0])).not.toContain('AKIA');
  });

  it('a failing audit write does not fail either ingest-url branch', async () => {
    audit.failAlways = true;

    const defaultApp = await buildIngestApp(repo, audit, false);
    const defaultRes = await defaultApp.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: { sourceUrl: 's3://ingest-bucket/clip.mp4' }
    });
    expect(defaultRes.statusCode).toBe(202);

    const externalApp = await buildIngestApp(repo, audit, true);
    const externalRes = await externalApp.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: { sourceUrl: 's3://ext-bkt/path/to/clip.mp4', sourceBackend: 'my-bucket' }
    });
    expect(externalRes.statusCode).toBe(202);

    await settle();
    expect(audit.entries).toHaveLength(0);
    // Both assets really were persisted despite every audit write rejecting.
    expect(await repo.get((defaultRes.json() as { assetId: string }).assetId)).toBeDefined();
    expect(await repo.get((externalRes.json() as { assetId: string }).assetId)).toBeDefined();
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

// ---------------------------------------------------------------------------
// ingest-url job audit instrumentation (issue #1000)
//
// The ingest-url job used to be the ONE pipeline job with no audit entries at
// all, so an asset's history started mid-pipeline (first entry = the transcode
// submission). These tests lock both ends of its trail:
//   - `job.submitted` at creation, in BOTH ingest-url branches (the default
//     byte-pull and the external-backend in-place source, src/routes/assets.ts).
//   - a terminal `job.completed` / `job.failed`, emitted where the job actually
//     settles (src/pipeline/url-pull-worker.ts for the pull; inline in the route
//     for the external-backend branch, which never runs the worker).
// Shape is asserted against the transcode/packaging entries above, not invented.
// ---------------------------------------------------------------------------

// A storage stub whose putStream reports the declared remote size as transferred.
// `fail` makes every attempt throw so the worker's retry loop exhausts and the
// job settles terminally `failed`.
function pullStorage(opts: { fail?: boolean } = {}): WorkspaceStorage {
  return {
    async putStream(_key: string, _src: Readable, o: { totalBytes?: number }) {
      if (opts.fail) throw new Error('minio unreachable');
      return { etag: 'e', bytesTransferred: o.totalBytes ?? 0 };
    }
  } as unknown as WorkspaceStorage;
}

// An injected s3:// reader keeps the worker hermetic (no network, and only
// http/https hosts go through the SSRF DNS lookup).
function openS3For(totalBytes: number) {
  return async () => ({ stream: Readable.from([]), totalBytes });
}

async function buildIngestApp(
  audit: AuditEmitter,
  extra: Record<string, unknown> = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    audit,
    // URL-pull ingest responds 501 without a storage factory; the stubbed runner
    // below never touches it.
    storageFor: (() => ({}) as never) as never,
    // Stub the detached worker so the route test asserts only the submission
    // entry (the worker's own terminal entries are covered directly below).
    runPull: (async () => undefined) as never,
    ...extra
  });
  await app.ready();
  return app;
}

describe('ingest-url job audit instrumentation (issue #1000)', () => {
  it('POST /ingest-url emits exactly one job.submitted targeting the returned job', async () => {
    const audit = new RecordingEmitter();
    const app = await buildIngestApp(audit);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: { sourceUrl: 's3://ingest-bucket/clip.mp4', title: 'Clip' }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { assetId: string; jobId: string };
    await settle();

    const submitted = audit.entries.filter((e) => e.action === 'job.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].targetType).toBe('job');
    expect(submitted[0].targetId).toBe(body.jobId);
    expect(submitted[0].actor.origin).toBe('system');
    expect(submitted[0].detail).toMatchObject({
      jobType: 'ingest-url',
      assetId: body.assetId
    });
    // The submitted source URL is never copied into the queryable audit detail
    // (it may be a pre-signed URL carrying credentials).
    expect(JSON.stringify(submitted[0].detail)).not.toContain('ingest-bucket');
  });

  it('a failing audit write does not fail the ingest submission', async () => {
    const audit = new RecordingEmitter();
    audit.failAlways = true;
    const app = await buildIngestApp(audit);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: { sourceUrl: 's3://ingest-bucket/clip.mp4' }
    });
    expect(res.statusCode).toBe(202);
    await settle();
    expect(audit.entries).toHaveLength(0);
  });

  it('an external-backend ingest emits job.submitted AND the inline terminal job.completed', async () => {
    const audit = new RecordingEmitter();
    const app = await buildIngestApp(audit, {
      storageBackendRegistry: {
        resolveSourceCredentials: async () => ({
          bucket: 'ext-bkt',
          awsAccessKeyId: 'id',
          awsSecretAccessKey: 'secret'
        })
      } as never
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: { sourceUrl: 's3://ext-bkt/path/clip.mp4', sourceBackend: 'ext-bkt' }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { assetId: string; jobId: string };
    await settle();

    const submitted = audit.entries.filter((e) => e.action === 'job.submitted');
    const completed = audit.entries.filter((e) => e.action === 'job.completed');
    expect(submitted).toHaveLength(1);
    expect(completed).toHaveLength(1);
    // Both ends of the trail target the SAME job object.
    expect(submitted[0].targetId).toBe(body.jobId);
    expect(completed[0].targetId).toBe(body.jobId);
    expect(completed[0].detail).toMatchObject({
      jobType: 'ingest-url',
      assetId: body.assetId
    });
  });

  it('a successful pull emits exactly one job.completed for the ingest job', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'Pulled' });
    const job = await jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 's3://b/clip.mp4'
    });
    const audit = new RecordingEmitter();

    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey: `ingest/${asset.id}`,
        sourceUrl: 's3://b/clip.mp4'
      },
      { jobs, assets, storage: pullStorage(), openS3: openS3For(120), audit }
    );
    await settle();

    expect((await jobs.get(job.id))?.status).toBe('done');
    const completed = audit.entries.filter((e) => e.action === 'job.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].targetType).toBe('job');
    expect(completed[0].targetId).toBe(job.id);
    expect(completed[0].actor.origin).toBe('system');
    expect(completed[0].detail).toMatchObject({
      jobType: 'ingest-url',
      assetId: asset.id,
      bytesTransferred: 120
    });
    expect(audit.entries.filter((e) => e.action === 'job.failed')).toHaveLength(0);
  });

  it('a terminally failed pull emits exactly one job.failed (not one per retry)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'Broken' });
    const job = await jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 's3://b/clip.mp4'
    });
    const audit = new RecordingEmitter();
    const attempts: number[] = [];

    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey: `ingest/${asset.id}`,
        sourceUrl: 's3://b/clip.mp4'
      },
      {
        jobs,
        assets,
        storage: pullStorage({ fail: true }),
        openS3: openS3For(120),
        sleep: async () => undefined,
        onAttemptError: (attempt) => attempts.push(attempt),
        audit
      }
    );
    await settle();

    // Every attempt failed, so the retry loop ran to exhaustion...
    expect(attempts.length).toBeGreaterThan(1);
    expect((await jobs.get(job.id))?.status).toBe('failed');
    // ...but only the single TERMINAL failure is audited.
    const failed = audit.entries.filter((e) => e.action === 'job.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].targetId).toBe(job.id);
    expect(failed[0].detail).toMatchObject({ jobType: 'ingest-url', assetId: asset.id });
    expect(String((failed[0].detail as Record<string, unknown>)['error'])).toMatch(/minio/i);
    expect(audit.entries.filter((e) => e.action === 'job.completed')).toHaveLength(0);
  });

  it('no emitter wired => the pull still settles (emission is opt-in)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'Unaudited' });
    const job = await jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 's3://b/clip.mp4'
    });

    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey: `ingest/${asset.id}`,
        sourceUrl: 's3://b/clip.mp4'
      },
      { jobs, assets, storage: pullStorage(), openS3: openS3For(1) }
    );
    expect((await jobs.get(job.id))?.status).toBe('done');
  });
});
