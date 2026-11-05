// DRM exposure on the delivery and asset APIs (ADR-008 §9/§10, issue #1266).
//
// Covers the four surfaces the issue adds, and the flag-off behaviour that is
// the whole point of the kill switch (ADR-008 D9):
//   - GET /:id/delivery with DRM_ENABLED off  -> no `drm` KEY at all
//   - GET /:id/delivery with a protected asset -> `drm` { scheme, systems, keyIds }
//     and no `key` anywhere in the raw payload
//   - GET /:id/delivery for a pending/failed protection -> still no `drm` key
//   - GET /:id/drm -> the persisted `AssetDrm` shape; 404 without a record; 501 off
//   - POST /:id/package and POST /:id/execute -> the `drm` member is ACCEPTED by
//     the body schema and answered `501 not_configured` while the flag is off,
//     `409 drm_unsupported` when the packaging runner cannot encrypt
//
// CONTRACT SOURCES (CLAUDE.md rule 7), verified before writing these fixtures:
//   - `AssetDrm` (`status, providerId, scheme, systems, keyIds[{trackGroup,keyId}],
//     licenceUrls?, certificateUrl?, requestedAt, protectedAt?, error?,
//     errorCode?, packageJobId?`) — src/data/asset-repo.ts:494-522.
//   - `DRM_STATUSES`, `PROTECTION_SCHEMES`, `TRACK_TYPE_GROUPS`,
//     `DRM_SYSTEM_ID_PATTERN`, `drmEnabled()` — src/types/drm.ts:66-117.
//   - `DRM_NOT_CONFIGURED_STATUS` / `DRM_NOT_CONFIGURED_PAYLOAD` (the uniform
//     `501 not_configured`) — src/drm/drm-config.ts:515-519.
//   - `DRM_UNSUPPORTED_REFUSAL` (`409 drm_unsupported`) and
//     `NO_ENCRYPTION_CAPABILITY` — src/pipeline/packaging.ts:344-413.
//   - `PipelineExecution['drm']` (`{ requested: true; providerId?; systems?;
//     scheme? }`) — src/data/pipeline-repo.ts:100.

import { afterEach, describe, it, expect, vi } from 'vitest';
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
import { InMemoryAssetRepository, type AssetDrm } from '../src/data/asset-repo.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../src/data/job-repo.js';
import { keys } from '../src/encore-scaler/types.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS
} from '../src/drm/drm-config.js';
import {
  DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL,
  NO_ENCRYPTION_CAPABILITY,
  type EncryptingPackagingRunner,
  type PackagingService
} from '../src/pipeline/packaging.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// Registered common-encryption system ids, shaped as `cpix:UUIDType` — the same
// fixtures test/asset-drm-document.test.ts:34-36 uses. Identifiers, never
// product names (CLAUDE.md rule 1 / ADR-008 §5.3).
const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const SYSTEM_ID_B = '9a04f079-9840-4286-ab92-e65be0885f95';

const A = { authorization: 'Bearer token-a' };

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`)
  } as unknown as WorkspaceStorage;
}

// A complete protected block: every optional member populated, so the
// projection is exercised at its widest and a leak would have somewhere to hide.
function protectedDrm(overrides: Partial<AssetDrm> = {}): AssetDrm {
  return {
    status: 'protected',
    providerId: 'primary',
    scheme: 'cbcs',
    systems: [SYSTEM_ID_A, SYSTEM_ID_B],
    keyIds: [
      { trackGroup: 'SD', keyId: '0f4d6a2e-6c17-4f4c-9f2a-2f3b9a1c5d61' },
      // Same key id for a second group: the delivery block deduplicates.
      { trackGroup: 'HD', keyId: '0f4d6a2e-6c17-4f4c-9f2a-2f3b9a1c5d61' },
      { trackGroup: 'AUDIO', keyId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e' }
    ],
    licenceUrls: {
      [SYSTEM_ID_A]: 'https://licence.example/a',
      [SYSTEM_ID_B]: 'https://licence.example/b'
    },
    certificateUrl: 'https://cert.example/app.cer',
    requestedAt: '2026-11-05T10:00:00.000Z',
    protectedAt: '2026-11-05T10:02:00.000Z',
    packageJobId: 'job-1',
    ...overrides
  };
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
};

async function buildApp(
  opts: { packagingRunner?: EncryptingPackagingRunner } = {}
): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const pipelines = new InMemoryPipelineRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    pipelineRepository: pipelines,
    storageFor: () => fakeStorage(),
    outputBucket: 'openvideocore-packaged',
    // Only presence matters for the routes under test: every DRM refusal below
    // happens before packaging is used, and the 501 for an unconfigured
    // packaging surface would otherwise mask the DRM 501/409.
    packaging: {} as unknown as PackagingService,
    ...(opts.packagingRunner ? { packagingRunner: opts.packagingRunner } : {})
  });
  await app.ready();
  return { app, assets, pipelines };
}

// An asset with packaged manifests — the delivery path the `drm` block travels
// with (ADR-008 §9: `urls.hls` / `urls.dash` are unchanged).
async function packagedAsset(
  h: Harness,
  drm?: AssetDrm
): Promise<string> {
  const asset = await h.assets.create({ name: 'clip' });
  await h.assets.update(asset.id, {
    manifestUrls: {
      hls: 'https://cdn.example/packaged/x/index.m3u8',
      dash: 'https://cdn.example/packaged/x/manifest.mpd'
    },
    ...(drm ? { drm } : {})
  });
  return asset.id;
}

afterEach(() => {
  delete process.env['DRM_ENABLED'];
});

describe('GET /:id/delivery — DRM block (issue #1266)', () => {
  it('omits the drm key entirely with DRM_ENABLED unset, even for a protected asset', async () => {
    const h = await buildApp();
    const id = await packagedAsset(h, protectedDrm());

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/delivery`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    // STRICT: the KEY must be absent — not null, not {} (issue #1266
    // constraint). Asserted on the parsed raw payload so a `drm: undefined`
    // that happened to serialise would still be caught.
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'drm')).toBe(false);
    expect('drm' in body).toBe(false);
    // The clear contract is untouched.
    expect(body['assetId']).toBe(id);
    expect((body['urls'] as Record<string, string>)['hls']).toBe(
      'https://cdn.example/packaged/x/index.m3u8'
    );
  });

  it('omits the drm key with DRM_ENABLED=false explicitly', async () => {
    process.env['DRM_ENABLED'] = 'false';
    const h = await buildApp();
    const id = await packagedAsset(h, protectedDrm());

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/delivery`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect('drm' in (JSON.parse(res.payload) as Record<string, unknown>)).toBe(false);
  });

  it('includes scheme, systems and keyIds for a protected asset with DRM_ENABLED=true', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const id = await packagedAsset(h, protectedDrm());

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/delivery`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    const drm = body['drm'] as {
      scheme: string;
      systems: { system: string; licenceUrl?: string; certificateUrl?: string }[];
      keyIds: string[];
    };
    expect(drm.scheme).toBe('cbcs');
    expect(drm.systems.map((s) => s.system)).toEqual([SYSTEM_ID_A, SYSTEM_ID_B]);
    expect(drm.systems[0]?.licenceUrl).toBe('https://licence.example/a');
    expect(drm.systems[1]?.licenceUrl).toBe('https://licence.example/b');
    expect(drm.systems[0]?.certificateUrl).toBe('https://cert.example/app.cer');
    // Identifiers only, deduplicated across track groups.
    expect(drm.keyIds).toEqual([
      '0f4d6a2e-6c17-4f4c-9f2a-2f3b9a1c5d61',
      'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
    ]);
    // NO KEY MATERIAL (ADR-008 D4): no `key` property anywhere in the response,
    // asserted over the RAW payload rather than a parsed sub-object.
    expect(res.payload).not.toMatch(/"key"\s*:/);
    expect(res.payload).not.toMatch(/"iv"\s*:/);
    // `urls` is unchanged by the addition (ADR-008 §9).
    const urls = body['urls'] as Record<string, string>;
    expect(urls['hls']).toBe('https://cdn.example/packaged/x/index.m3u8');
    expect(urls['dash']).toBe('https://cdn.example/packaged/x/manifest.mpd');
  });

  it('omits the drm key for a pending, failed or unsupported protection', async () => {
    process.env['DRM_ENABLED'] = 'true';
    for (const status of ['pending', 'failed', 'unsupported'] as const) {
      const h = await buildApp();
      const id = await packagedAsset(h, protectedDrm({ status }));
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/delivery`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect('drm' in (JSON.parse(res.payload) as Record<string, unknown>)).toBe(
        false
      );
    }
  });

  it('omits the drm key for a clear asset with DRM_ENABLED=true', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const id = await packagedAsset(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/delivery`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect('drm' in (JSON.parse(res.payload) as Record<string, unknown>)).toBe(false);
  });
});

describe('GET /:id/drm (issue #1266)', () => {
  it('returns the AssetDrm shape for a known asset', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const block = protectedDrm();
    const id = await packagedAsset(h, block);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/drm`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('protected');
    expect(body.providerId).toBe('primary');
    expect(body.scheme).toBe('cbcs');
    expect(body.systems).toEqual([SYSTEM_ID_A, SYSTEM_ID_B]);
    expect(body.keyIds).toEqual(block.keyIds);
    expect(body.licenceUrls).toEqual(block.licenceUrls);
    expect(body.certificateUrl).toBe(block.certificateUrl);
    expect(body.requestedAt).toBe(block.requestedAt);
    expect(body.protectedAt).toBe(block.protectedAt);
    expect(body.packageJobId).toBe('job-1');
    // No key material on this surface either (ADR-008 D4/§10).
    expect(res.payload).not.toMatch(/"key"\s*:/);
  });

  it('reports a failed protection with its error code', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const id = await packagedAsset(
      h,
      protectedDrm({
        status: 'failed',
        errorCode: 'key_provider_unreachable',
        error: 'key provider did not respond'
      })
    );
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/drm`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('failed');
    expect(res.json().errorCode).toBe('key_provider_unreachable');
  });

  it('returns 404 when the asset has no DRM record', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const id = await packagedAsset(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/drm`,
      headers: A
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 404 for an unknown asset', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/assets/nope/drm',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 501 not_configured while DRM_ENABLED is off, without reading the asset', async () => {
    const h = await buildApp();
    const id = await packagedAsset(h, protectedDrm());
    const getSpy = vi.spyOn(h.assets, 'get');

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/drm`,
      headers: A
    });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json()).toEqual({
      error: DRM_NOT_CONFIGURED_PAYLOAD.error,
      message: DRM_NOT_CONFIGURED_PAYLOAD.message
    });
    // The gate is checked before any I/O (ADR-008 D9).
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });
});

describe('POST /:id/package and /:id/execute — drm member (issue #1266)', () => {
  const drmRequest = { requested: true as const, scheme: 'cbcs' as const };

  it('accepts the drm member and answers 501 while DRM_ENABLED is off (package)', async () => {
    const h = await buildApp();
    const id = await packagedAsset(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/package`,
      headers: A,
      payload: { drm: drmRequest }
    });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
  });

  it('accepts the drm member and answers 501 while DRM_ENABLED is off (execute)', async () => {
    const h = await buildApp();
    const id = await packagedAsset(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', drm: drmRequest }
    });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
    // Nothing was started.
    expect(await h.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('answers 409 drm_unsupported when the runner cannot encrypt', async () => {
    process.env['DRM_ENABLED'] = 'true';
    // No runner wired: the deployment's honest capability answer is
    // NO_ENCRYPTION_CAPABILITY (src/pipeline/packaging.ts:344).
    expect(NO_ENCRYPTION_CAPABILITY.encryption).toBe(false);
    const h = await buildApp();
    const id = await packagedAsset(h);

    const pkg = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/package`,
      headers: A,
      payload: { drm: drmRequest }
    });
    expect(pkg.statusCode).toBe(409);
    expect(pkg.json().error).toBe('drm_unsupported');
    // The message names no system id, scheme or key material (ADR-008 §10).
    expect(pkg.json().message).not.toContain(SYSTEM_ID_A);

    const exec = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', drm: drmRequest }
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe('drm_unsupported');
    expect(await h.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('answers 409 drm_unsupported for a scheme or system the runner does not report', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const runner: EncryptingPackagingRunner = {
      capabilities: async () => ({
        encryption: true,
        schemes: ['cenc'],
        systems: [SYSTEM_ID_A]
      }),
      enqueue: async () => {}
    };
    const h = await buildApp({ packagingRunner: runner });
    const id = await packagedAsset(h);

    const wrongScheme = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', drm: { requested: true, scheme: 'cbcs' } }
    });
    expect(wrongScheme.statusCode).toBe(409);
    expect(wrongScheme.json().error).toBe('drm_unsupported');

    const wrongSystem = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: A,
      payload: {
        pipeline: 'abr-vod',
        drm: { requested: true, scheme: 'cenc', systems: [SYSTEM_ID_B] }
      }
    });
    expect(wrongSystem.statusCode).toBe(409);
    expect(wrongSystem.json().error).toBe('drm_unsupported');
    expect(await h.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('rejects a malformed drm member at the edge', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const id = await packagedAsset(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: A,
      // `systems` must be `cpix:UUIDType` values (src/types/drm.ts
      // DRM_SYSTEM_ID_PATTERN), never a free-text name.
      payload: {
        pipeline: 'abr-vod',
        drm: { requested: true, systems: ['not-a-system-id'] }
      }
    });
    expect(res.statusCode).toBe(400);
  });

  it('leaves the clear path untouched (no drm member)', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildApp();
    const asset = await h.assets.create({ name: 'clip' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod' }
    });
    // Whatever the pre-existing outcome for this fixture is, it is NOT a DRM
    // refusal: the gate never runs without a `drm` member. (This harness wires
    // no transcoder, so the pre-existing answer is the router's own
    // "transcoding is not configured" 501 — a DIFFERENT message from the DRM
    // gate's, which is what distinguishes them.)
    expect(res.statusCode).not.toBe(409);
    expect(res.json().message).not.toBe(DRM_NOT_CONFIGURED_PAYLOAD.message);
  });

  // ---------------------------------------------------------------------------
  // The DIRECT `encoreJobId` enqueue must REFUSE a `drm` request, never drop it.
  //
  // Passing the capability gate is not sufficient on that path: it hands the job
  // to `PackagingTrigger.triggerPackaging(assetId, encoreJobUrl)`, whose envelope
  // is the fixed `PackagingJob = { jobId, url }` with no `encryption` member, and
  // unlike pipeline mode it persists NEITHER an execution record carrying the
  // request NOR `asset.drm`. Accepting it would answer `202 { ok: true }` for
  // protection that is never applied and nowhere recorded.
  //
  // CONTRACT SOURCES (CLAUDE.md rule 7), verified before writing these cases:
  //   - `DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL` — `{ status: 409, error:
  //     'drm_unsupported', errorCode: 'drm_unsupported', message }`, the
  //     `DrmUnsupportedRefusal` shape — src/pipeline/packaging.ts.
  //   - `PackagingTrigger.triggerPackaging(assetId: string, encoreJobUrl: string)
  //     : Promise<string | undefined>` and `PackagingJob = { jobId, url }` —
  //     src/pipeline/packaging.ts.
  //   - `JobRepository.findByEncoreJobId(encoreJobId): Promise<{ job: Job } |
  //     undefined>` — src/data/job-repo.ts:392, the first I/O the direct branch
  //     would reach. Asserted NOT called, so the refusal precedes every lookup.
  //   - The `409` response body on POST /:id/package is `{ error, message }`
  //     (route schema; openapi.json `/api/v1/assets/{id}/package` -> 409).
  // ---------------------------------------------------------------------------

  // A runner that CAN encrypt with the requested scheme, so `drmRequestRefused`
  // passes and the only thing left that can refuse is the direct-path check.
  const encryptingRunner: EncryptingPackagingRunner = {
    capabilities: async () => ({
      encryption: true,
      schemes: ['cenc', 'cbcs'],
      systems: [SYSTEM_ID_A]
    }),
    enqueue: async () => {}
  };

  // Like `buildApp`, plus the two things the direct branch would touch: a job
  // repository (whose lookup is spied on) and a `triggerPackaging` spy standing
  // in for the packaging service.
  async function buildAppWithTrigger(): Promise<{
    app: FastifyInstance;
    assets: InMemoryAssetRepository;
    pipelines: InMemoryPipelineRepository;
    jobs: InMemoryJobRepository;
    triggerPackaging: ReturnType<typeof vi.fn>;
  }> {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    const assets = new InMemoryAssetRepository();
    const pipelines = new InMemoryPipelineRepository();
    const jobs = new InMemoryJobRepository();
    const triggerPackaging = vi.fn(async () => undefined);
    await app.register(assetsRouter, {
      prefix: '/api/v1/assets',
      repository: assets,
      pipelineRepository: pipelines,
      jobRepository: jobs,
      storageFor: () => fakeStorage(),
      outputBucket: 'openvideocore-packaged',
      packaging: { triggerPackaging } as unknown as PackagingService,
      packagingRunner: encryptingRunner
    });
    await app.ready();
    return { app, assets, pipelines, jobs, triggerPackaging };
  }

  it('refuses 409 drm_unsupported for drm + encoreJobId, instead of enqueueing a clear job', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildAppWithTrigger();
    const asset = await h.assets.create({ name: 'clip' });
    const lookup = vi.spyOn(h.jobs, 'findByEncoreJobId');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId: 'ctx__job-1', drm: drmRequest }
    });

    // NOT 202: a protection request on this path is answered, not swallowed.
    expect(res.statusCode).toBe(DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL.status);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL.error,
      message: DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL.message
    });
    expect(res.json().error).toBe('drm_unsupported');
    // The runner CAN encrypt, so the capability gate passed: the refusal is the
    // direct path's own, not `DRM_UNSUPPORTED_REFUSAL`'s.
    expect((await encryptingRunner.capabilities()).encryption).toBe(true);
    // No clear job was enqueued for a protected request, and the refusal landed
    // before any I/O on the job repository.
    expect(h.triggerPackaging).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    // The message names the member/mode, never a system id or key material
    // (ADR-008 §10).
    expect(res.json().message).not.toContain(SYSTEM_ID_A);
    expect(res.payload).not.toMatch(/"key"\s*:/);
    lookup.mockRestore();
  });

  it('writes no drm state when the direct enqueue is refused, so GET /:id/drm still 404s', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildAppWithTrigger();
    const asset = await h.assets.create({ name: 'clip' });

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId: 'ctx__job-1', drm: drmRequest }
    });

    // Refused means refused: no half-written protection claim anywhere.
    expect((await h.assets.get(asset.id))?.drm).toBeUndefined();
    expect(await h.pipelines.listByAsset(asset.id)).toHaveLength(0);
    const drm = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/drm`,
      headers: A
    });
    expect(drm.statusCode).toBe(404);
  });

  it('leaves the clear direct enqueue untouched (encoreJobId, no drm member)', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const h = await buildAppWithTrigger();
    const asset = await h.assets.create({ name: 'clip' });
    const lookup = vi.spyOn(h.jobs, 'findByEncoreJobId');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId: 'ctx__job-1' }
    });

    // Without a `drm` member the direct branch behaves exactly as before: it
    // reaches its own job lookup (and answers that unknown job 409
    // `job_not_found` for this fixture) rather than any DRM refusal.
    expect(lookup).toHaveBeenCalledWith('ctx__job-1');
    expect(res.json().error).not.toBe('drm_unsupported');
    lookup.mockRestore();
  });

  it('still answers 501 for drm + encoreJobId while DRM_ENABLED is off', async () => {
    const h = await buildAppWithTrigger();
    const asset = await h.assets.create({ name: 'clip' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId: 'ctx__job-1', drm: drmRequest }
    });

    // Flag gate FIRST and unchanged: which feature is off is reported before the
    // path-specific refusal, exactly as for pipeline mode.
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
    expect(h.triggerPackaging).not.toHaveBeenCalled();
  });

  // The same refusal against a FULLY ENQUEUEABLE direct request: a matching
  // transcode job AND a resolvable packaging target, so every precondition the
  // direct branch checks is satisfied and the pre-fix answer was
  // `202 { ok: true }` with a CLEAR `triggerPackaging` call. This is the exact
  // silent-drop this case exists to keep closed.
  //
  // CONTRACT SOURCES for the fixture (CLAUDE.md rule 7):
  //   - `encodeEncoreJobId(contextId, jobLocalId)` =>
  //     `<workspace>__<job local id>`, and `decodeEncoreJobId` reads it back —
  //     src/data/job-repo.ts:422-439.
  //   - `resolvePackagingTarget(redis, encoreJobId)` reads, in order,
  //     `keys.jobTerminalInstance(encoreJobId)` (GET), `keys.pool(workspaceId)`
  //     (HGET -> a JSON `EncoreInstanceRecord`), then
  //     `keys.jobEncoreUrl(encoreJobId)` (GET) — src/encore-scaler/
  //     packaging-target.ts, keys at src/encore-scaler/types.ts:475/490/501.
  //     Only `get` and `hget` are used (`ReadRedis`), which is all this fake has.
  it('refuses even when the direct enqueue would otherwise have succeeded (was 202 + clear enqueue)', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const triggerPackaging = vi.fn(async () => undefined);

    const asset = await assets.create({ name: 'clip' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    const encoreJobId = encodeEncoreJobId('workspace-a', job.id);
    await jobs.update(job.id, { encoreJobId, status: 'running' });

    const instanceId = 'instance-1';
    const store: Record<string, string> = {
      [keys.jobTerminalInstance(encoreJobId)]: instanceId,
      [keys.jobEncoreUrl(encoreJobId)]: 'https://encore-1.example/encoreJobs/uuid-1'
    };
    const pool: Record<string, string> = {
      [instanceId]: JSON.stringify({ url: 'https://encore-1.example' })
    };
    const packagingRedis = {
      get: async (key: string) => store[key] ?? null,
      hget: async (key: string, field: string) =>
        key === keys.pool('workspace-a') ? (pool[field] ?? null) : null
    } as unknown as import('ioredis').Redis;

    await app.register(assetsRouter, {
      prefix: '/api/v1/assets',
      repository: assets,
      pipelineRepository: new InMemoryPipelineRepository(),
      jobRepository: jobs,
      storageFor: () => fakeStorage(),
      outputBucket: 'openvideocore-packaged',
      packaging: { triggerPackaging } as unknown as PackagingService,
      packagingRunner: encryptingRunner,
      packagingRedis
    });
    await app.ready();

    // The fixture really is enqueueable: the same request WITHOUT `drm` is
    // accepted and enqueued clear, which is the behaviour that must not change.
    const clear = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId }
    });
    expect(clear.statusCode).toBe(202);
    expect(clear.json()).toEqual({ ok: true });
    expect(triggerPackaging).toHaveBeenCalledWith(
      asset.id,
      'https://encore-1.example/encoreJobs/uuid-1'
    );
    triggerPackaging.mockClear();

    // Same request WITH `drm`: refused, and nothing enqueued.
    const protectedReq = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/package`,
      headers: A,
      payload: { encoreJobId, drm: drmRequest }
    });
    expect(protectedReq.statusCode).toBe(409);
    expect(protectedReq.json()).toEqual({
      error: DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL.error,
      message: DRM_DIRECT_ENQUEUE_UNSUPPORTED_REFUSAL.message
    });
    expect(triggerPackaging).not.toHaveBeenCalled();
    expect((await assets.get(asset.id))?.drm).toBeUndefined();
  });
});
