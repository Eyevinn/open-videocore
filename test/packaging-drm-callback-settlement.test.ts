// Encryption params on the package job + callback settlement of `drm.status`
// (issue #1265; ADR-008 §7.1, §8, §12, C7).
//
// What this covers:
//   1. the enqueue carries the derived `EncryptionParams` as the OPTIONAL
//      `encryption` field on the job handed to `EncryptingPackagingRunner.enqueue`
//      (the existing `{ jobId, url }` members unchanged),
//   2. the packager SUCCESS callback settles a pending protection to
//      `protected` + `protectedAt`, idempotently,
//   3. the packager FAILURE callback settles it to `failed` beside the existing
//      `packagingError` write,
//   4. the clear path (no `drm` on the execution, no `encryption` on the job)
//      enqueues and settles without touching any `drm` field.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `PackagingJob` (`{ jobId, url }`), `EncryptionParams`
//     (`{ scheme, keys[{label,keyId,key}], pssh, hlsKeyUri?, protectionSystems }`),
//     `EncryptingPackagingRunner.enqueue(job, options?)`, `enqueuePackagingStep`,
//     `PackagingStepDeps`, `AssetDrmStore`, `PackagingService.handleSuccess`
//     / `handleFailure`, `PackagerSuccessPayload` (`{ url, jobId, outputPath? }`),
//     `PackagingDeps` (`assets`, `queue`, `publicBaseUrl`, `now`),
//     `settleDrmOnPackagerSuccess` / `settleDrmOnPackagerFailure`,
//     `DRM_PACKAGER_FAILED_MESSAGE` — src/pipeline/packaging.ts.
//   - `AssetDrm` (`status`, `providerId`, `scheme`, `systems`, `keyIds[]`,
//     `licenceUrls?`, `certificateUrl?`, `requestedAt`, `protectedAt?`,
//     `error?`, `errorCode?`) and `UpdateAssetInput.drm` (wholesale replacement,
//     never changes `status`) — src/data/asset-repo.ts:494-511, :976, :2011.
//   - `DRM_STATUSES` / `DRM_ERROR_CODES` (`packaging_failed`) —
//     src/types/drm.ts:87-101.
//   - `KeyProvider.acquire(req, signal)`, `ContentKey`
//     (`{ trackGroup, keyId, key: Uint8Array }`), `DrmSignalling`
//     (`pssh`, `licenceUrls`, `certificateUrl?`, `hlsKeyUri?`),
//     `CLEAR_KEY_SYSTEM_ID` — src/drm/key-provider.ts.
//
// ADDITIVE ONLY: no pre-existing test file or assertion is touched.

import { describe, it, expect, vi } from 'vitest';
import {
  PackagingService,
  enqueuePackagingStep,
  settleDrmOnPackagerFailure,
  settleDrmOnPackagerSuccess,
  DRM_PACKAGER_FAILED_MESSAGE,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { AssetDrm } from '../src/data/asset-repo.js';
import type { ContentKey, KeyProvider, KeyRequest } from '../src/drm/key-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';

const KEY_ID = '11111111-2222-3333-4444-555555555555';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeQueue(): { queue: PackageQueue; jobs: PackagingJob[] } {
  const jobs: PackagingJob[] = [];
  return {
    jobs,
    queue: {
      enqueue: vi.fn(async (job: PackagingJob) => {
        jobs.push(job);
      })
    }
  };
}

// A runner that reports encryption support and records exactly what it was
// handed, so the presence (or absence) of `encryption` on the job is assertable.
function recordingRunner(): {
  runner: EncryptingPackagingRunner;
  seen: (PackagingJob & { encryption?: EncryptionParams })[];
} {
  const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
  return {
    seen,
    runner: {
      async capabilities() {
        return {
          encryption: true,
          schemes: ['cbcs' as const],
          systems: [CLEAR_KEY_SYSTEM_ID]
        };
      },
      async enqueue(job) {
        seen.push(job);
      }
    }
  };
}

function keyProvider(): KeyProvider {
  return {
    id: 'primary',
    kind: 'clearkey-dev',
    async acquire(req: KeyRequest) {
      const keys: ContentKey[] = req.trackGroups.map((trackGroup) => ({
        trackGroup,
        keyId: req.keyIds?.[trackGroup] ?? KEY_ID,
        key: new Uint8Array(16).fill(0x5a)
      }));
      return {
        keys,
        signalling: {
          pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' },
          licenceUrls: { [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/' },
          hlsKeyUri: 'skd://key',
          dev: true as const
        }
      };
    }
  };
}

// A protection block in the state the key-acquisition step leaves behind
// (`enqueuePackagingStep` STEP 4): keys acquired, package enqueued, outcome not
// yet known.
function pendingDrm(overrides: Partial<AssetDrm> = {}): AssetDrm {
  return {
    status: 'pending',
    providerId: 'primary',
    scheme: 'cbcs',
    systems: [CLEAR_KEY_SYSTEM_ID],
    keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
    licenceUrls: { [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/' },
    requestedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  };
}

// A PackagingService over an in-memory repository, with a scripted clock so
// `protectedAt` is deterministic and a SECOND callback can be given a LATER
// time than the first.
async function harness(options?: { drm?: AssetDrm; clock?: string[] }) {
  const assets = new InMemoryAssetRepository();
  const asset = await assets.create({ name: 'clip' });
  if (options?.drm) {
    await assets.update(asset.id, { drm: options.drm });
  }
  const times = [...(options?.clock ?? ['2026-11-02T10:00:00.000Z'])];
  const { queue, jobs } = fakeQueue();
  const service = new PackagingService({
    assets,
    queue,
    publicBaseUrl: 'https://cdn.example/packaged',
    now: () => times.shift() ?? '2026-11-09T23:59:59.000Z'
  });
  return { assets, assetId: asset.id, service, jobs };
}

describe('encryption params on the package job (issue #1265 part 1)', () => {
  it('passes the derived EncryptionParams as the optional `encryption` field, leaving jobId/url unchanged', async () => {
    const { runner, seen } = recordingRunner();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const outcome = await enqueuePackagingStep(
      { runner, keyProvider: keyProvider(), assets },
      {
        job: { jobId: asset.id, url: 'http://encore/job/abc' },
        drm: { requested: true, scheme: 'cbcs', systems: [CLEAR_KEY_SYSTEM_ID] }
      }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].jobId).toBe(asset.id);
    expect(seen[0].url).toBe('http://encore/job/abc');
    const encryption = seen[0].encryption;
    expect(encryption).toBeDefined();
    expect(encryption?.scheme).toBe('cbcs');
    expect(encryption?.protectionSystems).toEqual([CLEAR_KEY_SYSTEM_ID]);
    expect(encryption?.keys).toEqual([
      { label: 'SD', keyId: KEY_ID, key: expect.any(String) }
    ]);
    expect(encryption?.pssh).toEqual({ [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' });
    // The step left the asset pending — the state the callbacks settle below.
    expect((await assets.get(asset.id))?.drm?.status).toBe('pending');
  });

  it('enqueues NO `encryption` field on the clear path', async () => {
    const { runner, seen } = recordingRunner();
    const outcome = await enqueuePackagingStep(
      { runner },
      { job: { jobId: 'asset-clear', url: 'http://encore/job/clear' } }
    );

    expect(outcome).toEqual({ ok: true, encrypted: false });
    expect(seen).toEqual([{ jobId: 'asset-clear', url: 'http://encore/job/clear' }]);
    expect('encryption' in seen[0]).toBe(false);
  });
});

describe('packager success callback settles drm.status (issue #1265 part 2)', () => {
  it('transitions pending -> protected and records protectedAt', async () => {
    const { assets, assetId, service } = await harness({
      drm: pendingDrm(),
      clock: ['2026-11-02T10:00:00.000Z']
    });

    const applied = await service.handleSuccess({
      url: 'http://encore/job/abc',
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });

    expect(applied).toBe(true);
    const drm = (await assets.get(assetId))?.drm;
    expect(drm?.status).toBe('protected');
    expect(drm?.protectedAt).toBe('2026-11-02T10:00:00.000Z');
    // Everything else about the protection is carried through untouched.
    expect(drm?.providerId).toBe('primary');
    expect(drm?.scheme).toBe('cbcs');
    expect(drm?.systems).toEqual([CLEAR_KEY_SYSTEM_ID]);
    expect(drm?.keyIds).toEqual([{ trackGroup: 'SD', keyId: KEY_ID }]);
    expect(drm?.requestedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(drm?.licenceUrls).toEqual({ [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/' });
    // The manifests are still written in the same callback (unchanged behaviour).
    expect((await assets.get(assetId))?.manifestUrls?.hls).toContain('index.m3u8');
  });

  it('is idempotent: a duplicate success callback does not error and does not re-stamp protectedAt', async () => {
    const { assets, assetId, service } = await harness({
      drm: pendingDrm(),
      // The second callback sees a LATER clock, so a re-stamp would be visible.
      clock: ['2026-11-02T10:00:00.000Z', '2026-11-03T20:00:00.000Z']
    });

    const first = await service.handleSuccess({
      url: 'http://encore/job/abc',
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });
    const second = await service.handleSuccess({
      url: 'http://encore/job/abc',
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    const drm = (await assets.get(assetId))?.drm;
    expect(drm?.status).toBe('protected');
    expect(drm?.protectedAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('leaves an already-failed protection alone (no resurrection to protected)', async () => {
    const { assets, assetId, service } = await harness({
      drm: pendingDrm({ status: 'failed', errorCode: 'key_provider_rejected' })
    });

    await service.handleSuccess({ url: 'http://encore/job/abc', jobId: assetId });

    const drm = (await assets.get(assetId))?.drm;
    expect(drm?.status).toBe('failed');
    expect(drm?.errorCode).toBe('key_provider_rejected');
    expect(drm?.protectedAt).toBeUndefined();
  });
});

describe('packager failure callback settles drm.status (issue #1265 part 3)', () => {
  it('transitions pending -> failed and writes packagingError', async () => {
    const { assets, assetId, service } = await harness({ drm: pendingDrm() });
    const statusBefore = (await assets.get(assetId))?.status;

    const applied = await service.handleFailure(assetId, 'packager exited 1');

    expect(applied).toBe(true);
    const stored = await assets.get(assetId);
    expect(stored?.packagingError).toBe('packager exited 1');
    expect(stored?.drm?.status).toBe('failed');
    expect(stored?.drm?.errorCode).toBe('packaging_failed');
    // The DRM block carries the FIXED message, never the packager's own text —
    // that is recorded verbatim on `packagingError` above (ADR-008 §10).
    expect(stored?.drm?.error).toBe(DRM_PACKAGER_FAILED_MESSAGE);
    expect(stored?.drm?.error).not.toContain('exited 1');
    expect(stored?.drm?.protectedAt).toBeUndefined();
    // No new top-level lifecycle value: the asset's own status is untouched by
    // a DRM failure (ADR-008 §8, the `packagingError` convention).
    expect(stored?.status).toBe(statusBefore);
  });

  it('does not rewrite an already-protected block when a late failure arrives', async () => {
    const { assets, assetId, service } = await harness({
      drm: pendingDrm({ status: 'protected', protectedAt: '2026-11-02T10:00:00.000Z' })
    });

    await service.handleFailure(assetId, 'packager exited 1');

    const stored = await assets.get(assetId);
    expect(stored?.packagingError).toBe('packager exited 1');
    expect(stored?.drm?.status).toBe('protected');
    expect(stored?.drm?.protectedAt).toBe('2026-11-02T10:00:00.000Z');
  });
});

describe('clear packaging path is untouched (issue #1265 part 4)', () => {
  it('enqueues and settles both callbacks without introducing any drm field', async () => {
    const { assets, assetId, service, jobs } = await harness();

    await service.triggerPackaging(assetId, 'http://encore/job/abc');
    expect(jobs).toEqual([{ jobId: assetId, url: 'http://encore/job/abc' }]);

    await service.handleSuccess({
      url: 'http://encore/job/abc',
      jobId: assetId,
      outputPath: `/${assetId}/pkg-1/`
    });
    let stored = await assets.get(assetId);
    expect(stored?.drm).toBeUndefined();
    expect(stored?.manifestUrls?.hls).toContain('index.m3u8');

    await service.handleFailure(assetId, 'packager exited 1');
    stored = await assets.get(assetId);
    expect(stored?.drm).toBeUndefined();
    expect(stored?.packagingError).toBe('packager exited 1');
  });
});

describe('settlement helpers (pure transitions)', () => {
  it('return undefined for a clear asset, so the caller omits `drm` from the patch', () => {
    expect(settleDrmOnPackagerSuccess(undefined, '2026-11-02T10:00:00.000Z')).toBeUndefined();
    expect(settleDrmOnPackagerFailure(undefined)).toBeUndefined();
  });

  it('only act on `pending`', () => {
    for (const status of ['protected', 'failed', 'unsupported'] as const) {
      expect(
        settleDrmOnPackagerSuccess(pendingDrm({ status }), '2026-11-02T10:00:00.000Z')
      ).toBeUndefined();
      expect(settleDrmOnPackagerFailure(pendingDrm({ status }))).toBeUndefined();
    }
  });

  it('drop a stale error from an earlier attempt when protection succeeds', () => {
    const settled = settleDrmOnPackagerSuccess(
      pendingDrm({ error: 'an earlier attempt failed', errorCode: 'packaging_failed' }),
      '2026-11-02T10:00:00.000Z'
    );
    expect(settled?.status).toBe('protected');
    expect(settled?.error).toBeUndefined();
    expect(settled?.errorCode).toBeUndefined();
  });

  it('never carry key material (AssetDrm has no key member) nor mutate the input', () => {
    const input = pendingDrm();
    const settled = settleDrmOnPackagerSuccess(input, '2026-11-02T10:00:00.000Z');
    expect(JSON.stringify(settled)).not.toContain('"key"');
    expect(input.status).toBe('pending');
    expect(input.protectedAt).toBeUndefined();
    // The carried arrays are copies, so a later mutation of the settled block
    // cannot reach the asset the caller read.
    settled?.keyIds.push({ trackGroup: 'HD', keyId: KEY_ID });
    expect(input.keyIds).toHaveLength(1);
  });
});
