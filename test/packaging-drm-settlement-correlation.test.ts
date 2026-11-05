// DRM settlement is correlated with the run that carried the encryption, and the
// failure settlement is wired into the paths where a packager failure is really
// attributed (issue #1265 review; ADR-008 §8, §12, C7).
//
// Why this file exists (both are REGRESSIONS the first cut of #1265 allowed):
//   1. `drm.status === 'pending'` alone was enough to settle `protected`. The
//      production enqueue path (`PackagingService.triggerPackaging`) enqueues a
//      CLEAR job — `{ jobId, url }`, no `encryption` — so an asset left pending
//      by an earlier protected run and then re-packaged clear was stamped
//      `protected` + a fresh `protectedAt` for UNENCRYPTED output: a false
//      protection claim. Settlement now requires the completing `package` Job to
//      be the one the encrypted enqueue stamped on the block
//      (`AssetDrm.packageJobId`, written at `enqueuePackagingStep` STEP 4).
//   2. `PackagingService.handleFailure` had NO production call site: the
//      packager's failure callback carries no jobId of ours, so
//      POST /api/v1/internal/packagerCallback/failure correlates by execution
//      state and calls `failPackageJob` directly, and the stalled-package sweep
//      does the same. A real packager failure therefore left `pending` forever.
//      Both paths now settle the protection beside their `failPackageJob`.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `AssetDrm` incl. the new `packageJobId?: string` — src/data/asset-repo.ts
//     (`export type AssetDrm`); persisted shape `AssetDrmSchema.packageJobId`
//     with `drmToDoc` / `drmFromDoc` pass-through — src/data/asset-document.ts.
//   - `settleDrmOnPackagerSuccess(drm, protectedAt, completingPackageJobId?)`,
//     `settleDrmOnPackagerFailure(drm, failingPackageJobId?)`,
//     `PackagingService.settleProtectionFailure(assetId, failingPackageJobId?)`,
//     `PackagingStepRequest.packageJobId`, `enqueuePackagingStep`,
//     `PackagerSuccessPayload = { url, jobId, outputPath? }`, `PackagingDeps`
//     (`assets`, `queue`, `jobs`, `pipeline`, `now`) — src/pipeline/packaging.ts.
//   - `resolvePackageJobId(deps, { jobId?, assetId })` and `failPackageJob`'s
//     returned job id — src/pipeline/package-job.ts.
//   - `ReconcileStalledPackagesDeps.settleProtectionFailure` —
//     src/pipeline/stalled-package-reconciler.ts.
//   - `internalRouter` options (`packaging`, `repository`, `jobRepository`,
//     `pipelineRepository`) and the failure route's body `{ message }` —
//     src/routes/internal.ts.
//   - `JobRepository.findActiveByAssetId`, `Job.type` — src/data/job-repo.ts.
//
// ADDITIVE ONLY: no pre-existing test file or assertion is touched.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { internalRouter } from '../src/routes/internal.js';
import { InMemoryAssetRepository, type AssetDrm } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  PackagingService,
  enqueuePackagingStep,
  settleDrmOnPackagerFailure,
  settleDrmOnPackagerSuccess,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import { reconcileStalledPackages } from '../src/pipeline/stalled-package-reconciler.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import type { ContentKey, KeyProvider, KeyRequest } from '../src/drm/key-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';
import { keys } from '../src/encore-scaler/types.js';

const A = { authorization: 'Bearer token-a' };
const KEY_ID = '11111111-2222-3333-4444-555555555555';

// Encore pool coordinates the package-only execute path resolves the packager's
// input URL from (same shape as test/package-job-record.test.ts).
const CTX = 'ctx';
const INSTANCE_ID = 'encore-instance-1';
const INSTANCE_URL = 'https://encore-1.osc.example';

function makeRedis(): import('ioredis').Redis {
  const hashes: Record<string, Record<string, string>> = {
    [keys.pool(CTX)]: {
      [INSTANCE_ID]: JSON.stringify({ id: INSTANCE_ID, url: INSTANCE_URL, activeJobs: 0 })
    }
  };
  return {
    hget: async (key: string, field: string) => hashes[key]?.[field] ?? null,
    get: async () => null,
    sadd: async () => 1,
    pexpire: async () => 1,
    srem: async () => 1
  } as unknown as import('ioredis').Redis;
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  packaging: PackagingService;
  enqueued: PackagingJob[];
};

async function buildHarness(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const enqueued: PackagingJob[] = [];
  const queue: PackageQueue = {
    enqueue: vi.fn(async (job: PackagingJob) => {
      enqueued.push(job);
    })
  };
  const packaging = new PackagingService({
    assets,
    queue,
    jobs,
    pipeline: pipelines,
    publicBaseUrl: 'https://cdn.example/packaged',
    now: () => '2026-11-05T12:00:00.000Z'
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
    packagingRedis: makeRedis()
  });
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging,
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines
  });
  await app.ready();
  return { app, assets, jobs, pipelines, packaging, enqueued };
}

// An asset with a RUNNING `package` step and its `package` Job, i.e. the state
// both failure-attribution paths correlate against. Returns the package Job id,
// which is what a protection run stamps on the DRM block.
async function startPackageRun(h: Harness): Promise<{ assetId: string; packageJobId: string }> {
  const asset = await h.assets.create({ name: 'clip', objectKey: 'ingest/clip' });
  const execution = await h.pipelines.create({
    assetId: asset.id,
    pipelineName: 'package',
    steps: ['package']
  });
  await h.pipelines.update(execution.id, {
    status: 'running',
    steps: [
      {
        name: 'package',
        status: 'running',
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      }
    ]
  });
  const packageJobId = await h.packaging.triggerPackaging(
    asset.id,
    `${INSTANCE_URL}/encoreJobs/job-1`
  );
  expect(packageJobId).toBeDefined();
  return { assetId: asset.id, packageJobId: packageJobId! };
}

function pendingDrm(overrides: Partial<AssetDrm> = {}): AssetDrm {
  return {
    status: 'pending',
    providerId: 'primary',
    scheme: 'cbcs',
    systems: [CLEAR_KEY_SYSTEM_ID],
    keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
    requestedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  };
}

describe('the enqueued encrypted run is stamped on the DRM block (issue #1265 review)', () => {
  it('STEP 4 records the caller-supplied `package` Job id as `drm.packageJobId`', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
    const runner: EncryptingPackagingRunner = {
      async capabilities() {
        return { encryption: true, schemes: ['cbcs' as const], systems: [CLEAR_KEY_SYSTEM_ID] };
      },
      async enqueue(job) {
        seen.push(job);
      }
    };
    const keyProvider: KeyProvider = {
      id: 'primary',
      kind: 'clearkey-dev',
      async acquire(req: KeyRequest) {
        const contentKeys: ContentKey[] = req.trackGroups.map((trackGroup) => ({
          trackGroup,
          keyId: KEY_ID,
          key: new Uint8Array(16).fill(0x5a)
        }));
        return {
          keys: contentKeys,
          signalling: {
            pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' },
            licenceUrls: {},
            dev: true as const
          }
        };
      }
    };

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider, assets },
      {
        job: { jobId: asset.id, url: 'http://encore/job/abc' },
        packageJobId: 'pkg-job-1',
        drm: { requested: true, scheme: 'cbcs', systems: [CLEAR_KEY_SYSTEM_ID] }
      }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(seen[0].encryption).toBeDefined();
    const stored = (await assets.get(asset.id))?.drm;
    expect(stored?.status).toBe('pending');
    // The correlation the callbacks match against — identifiers only, no key.
    expect(stored?.packageJobId).toBe('pkg-job-1');
    expect(JSON.stringify(stored)).not.toContain('"key"');
  });
});

describe('a CLEAR run can never settle a pending protection (issue #1265 review)', () => {
  it('leaves the block pending when the completing package job is not the encrypted one', async () => {
    const h = await buildHarness();
    const { assetId } = await startPackageRun(h);
    // The pending protection belongs to an EARLIER run (a different package
    // job); this asset has since been re-packaged CLEAR (triggerPackaging above
    // enqueued `{ jobId, url }` with no `encryption`).
    await h.assets.update(assetId, { drm: pendingDrm({ packageJobId: 'pkg-job-earlier' }) });
    expect(h.enqueued.every((j) => !('encryption' in j))).toBe(true);

    const applied = await h.packaging.handleSuccess({
      url: `${INSTANCE_URL}/encoreJobs/job-1`,
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });

    expect(applied).toBe(true);
    const stored = await h.assets.get(assetId);
    // The manifests are still recorded — that part of the callback is unchanged.
    expect(stored?.manifestUrls?.hls).toContain('index.m3u8');
    // But NO protection claim for unencrypted output.
    expect(stored?.drm?.status).toBe('pending');
    expect(stored?.drm?.protectedAt).toBeUndefined();
  });

  it('settles when the completing package job IS the run that carried encryption', async () => {
    const h = await buildHarness();
    const { assetId, packageJobId } = await startPackageRun(h);
    await h.assets.update(assetId, { drm: pendingDrm({ packageJobId }) });

    await h.packaging.handleSuccess({
      url: `${INSTANCE_URL}/encoreJobs/job-1`,
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });

    const stored = await h.assets.get(assetId);
    expect(stored?.drm?.status).toBe('protected');
    expect(stored?.drm?.protectedAt).toBe('2026-11-05T12:00:00.000Z');
    expect(stored?.drm?.packageJobId).toBe(packageJobId);
  });

  it('refuses in the pure helpers too: stamped block, different or unknown run', () => {
    const stamped = pendingDrm({ packageJobId: 'pkg-job-1' });
    expect(
      settleDrmOnPackagerSuccess(stamped, '2026-11-05T12:00:00.000Z', 'pkg-job-2')
    ).toBeUndefined();
    expect(settleDrmOnPackagerSuccess(stamped, '2026-11-05T12:00:00.000Z')).toBeUndefined();
    expect(settleDrmOnPackagerFailure(stamped, 'pkg-job-2')).toBeUndefined();
    expect(settleDrmOnPackagerFailure(stamped)).toBeUndefined();
    // Matching run: both settle.
    expect(
      settleDrmOnPackagerSuccess(stamped, '2026-11-05T12:00:00.000Z', 'pkg-job-1')?.status
    ).toBe('protected');
    expect(settleDrmOnPackagerFailure(stamped, 'pkg-job-1')?.status).toBe('failed');
  });

  it('refuses an UNSTAMPED block once the completing run has a package job id', () => {
    // The clear-re-package case on a normal deployment: the completing run
    // recorded a `package` Job, the block never did, so they are different runs.
    expect(
      settleDrmOnPackagerSuccess(pendingDrm(), '2026-11-05T12:00:00.000Z', 'pkg-job-1')
    ).toBeUndefined();
  });
});

describe('the failure settlement is wired where a packager failure is attributed', () => {
  it('POST /packagerCallback/failure settles the pending protection as failed', async () => {
    const h = await buildHarness();
    const { assetId, packageJobId } = await startPackageRun(h);
    await h.assets.update(assetId, { drm: pendingDrm({ packageJobId }) });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/failure',
      payload: { message: 'packager exited with code 1' }
    });

    expect(res.statusCode).toBe(200);
    const stored = await h.assets.get(assetId);
    expect(stored?.drm?.status).toBe('failed');
    expect(stored?.drm?.errorCode).toBe('packaging_failed');
    // The packager's own text never reaches the DRM block (ADR-008 §10).
    expect(stored?.drm?.error).not.toContain('exited with code 1');
    expect(stored?.drm?.protectedAt).toBeUndefined();
    // The `package` Job is settled with the reason exactly as before.
    const job = (await h.jobs.get(packageJobId))!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('packager exited with code 1');
  });

  it("the stalled-package sweep settles it too when no completion signal ever arrives", async () => {
    const h = await buildHarness();
    const { assetId, packageJobId } = await startPackageRun(h);
    await h.assets.update(assetId, { drm: pendingDrm({ packageJobId }) });

    const result = await reconcileStalledPackages({
      pipeline: h.pipelines,
      jobs: h.jobs,
      packagerPresent: async () => false,
      stallTimeoutMs: 15 * 60 * 1000,
      settleProtectionFailure: async (id, failingPackageJobId) =>
        h.packaging.settleProtectionFailure(id, failingPackageJobId)
    });

    expect(result.failed).toBe(1);
    const stored = await h.assets.get(assetId);
    expect(stored?.drm?.status).toBe('failed');
    expect(stored?.drm?.errorCode).toBe('packaging_failed');
  });

  it('leaves a clear asset (no drm block) untouched on both failure paths', async () => {
    const h = await buildHarness();
    const { assetId } = await startPackageRun(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/failure',
      payload: { message: 'packager exited with code 1' }
    });
    expect(res.statusCode).toBe(200);
    expect((await h.assets.get(assetId))?.drm).toBeUndefined();

    await reconcileStalledPackages({
      pipeline: h.pipelines,
      jobs: h.jobs,
      stallTimeoutMs: 15 * 60 * 1000,
      settleProtectionFailure: async (id, failingPackageJobId) =>
        h.packaging.settleProtectionFailure(id, failingPackageJobId)
    });
    expect((await h.assets.get(assetId))?.drm).toBeUndefined();
  });

  it('settleProtectionFailure never throws and reports whether it settled', async () => {
    const h = await buildHarness();
    const { assetId, packageJobId } = await startPackageRun(h);

    // No drm block at all.
    await expect(h.packaging.settleProtectionFailure(assetId, packageJobId)).resolves.toBe(
      false
    );
    // Unknown asset.
    await expect(h.packaging.settleProtectionFailure('missing', packageJobId)).resolves.toBe(
      false
    );
    // Already terminal.
    await h.assets.update(assetId, {
      drm: pendingDrm({ status: 'protected', protectedAt: '2026-11-02T10:00:00.000Z', packageJobId })
    });
    await expect(h.packaging.settleProtectionFailure(assetId, packageJobId)).resolves.toBe(
      false
    );
    expect((await h.assets.get(assetId))?.drm?.status).toBe('protected');
  });
});

describe('the persisted DRM block carries the correlation (issue #1265 review)', () => {
  it('round-trips `packageJobId` through the document mapper', async () => {
    const { toAssetDocument, fromAssetDocument } = await import(
      '../src/data/asset-document.js'
    );
    const previous = process.env['DRM_ENABLED'];
    process.env['DRM_ENABLED'] = 'true';
    try {
      const assets = new InMemoryAssetRepository();
      const asset = await assets.create({ name: 'clip' });
      await assets.update(asset.id, { drm: pendingDrm({ packageJobId: 'pkg-job-1' }) });
      const stored = (await assets.get(asset.id))!;
      const doc = toAssetDocument(stored);
      expect(doc.structural?.drm?.packageJobId).toBe('pkg-job-1');
      expect(fromAssetDocument(doc).drm?.packageJobId).toBe('pkg-job-1');
    } finally {
      if (previous === undefined) delete process.env['DRM_ENABLED'];
      else process.env['DRM_ENABLED'] = previous;
    }
  });
});
