// DRM domain model + asset document round-trip (ADR-008 §8, issue #1259).
//
// Contract sources exercised here:
//   - `AssetDrm` / `Asset.drm`            — src/data/asset-repo.ts
//   - `AssetDrmSchema` / `structural.drm` — src/data/asset-document.ts
//   - `PipelineExecution.drm`             — src/data/pipeline-repo.ts
//   - the enums + `drmEnabled()`          — src/types/drm.ts
//
// Everything here is additive: no existing asset or pipeline test is touched.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { InMemoryAssetRepository, type Asset, type AssetDrm } from '../src/data/asset-repo.js';
import {
  AssetDocumentSchema,
  toAssetDocument,
  fromAssetDocument
} from '../src/data/asset-document.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';

// A fully populated AssetDrm — every optional member present, so the round-trip
// test covers the whole ADR-008 §8 shape rather than just the required core.
const FULL_DRM: AssetDrm = {
  status: 'protected',
  providerId: 'primary',
  scheme: 'cbcs',
  systems: ['widevine', 'playready', 'fairplay'],
  keyIds: [
    { trackGroup: 'AUDIO', keyId: '6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70' },
    { trackGroup: 'SD', keyId: '7a2e1b8d-7eaf-4f8b-8b4d-2a3c5e6f7b81' },
    { trackGroup: 'HD', keyId: '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92' },
    { trackGroup: 'UHD1', keyId: '9c403da0-90c1-4bad-ad6f-4c5e70819da3' }
  ],
  licenceUrls: {
    widevine: 'https://licence.example/wv',
    playready: 'https://licence.example/pr',
    fairplay: 'https://licence.example/fp'
  },
  certificateUrl: 'https://licence.example/app.cer',
  requestedAt: '2026-11-01T10:00:00.000Z',
  protectedAt: '2026-11-01T10:04:30.000Z',
  error: 'previous attempt rejected by key provider',
  errorCode: 'key_provider_rejected'
};

async function makeAsset(drm?: AssetDrm): Promise<Asset> {
  const repo = new InMemoryAssetRepository();
  const created = await repo.create({ name: 'Protected clip' });
  return drm ? { ...created, drm } : created;
}

afterEach(() => {
  delete process.env['DRM_ENABLED'];
});

describe('ADR-008 §8 DRM asset document slot (issue #1259), DRM_ENABLED=true', () => {
  beforeEach(() => {
    process.env['DRM_ENABLED'] = 'true';
  });

  it('round-trips a fully populated AssetDrm through toAssetDocument/fromAssetDocument', async () => {
    const asset = await makeAsset(FULL_DRM);
    const parsed = AssetDocumentSchema.parse(toAssetDocument(asset));
    // Persisted under `structural` beside packagedOutput / packagingError (D7).
    expect(parsed.structural.drm).toBeDefined();
    const back = fromAssetDocument(parsed);
    // toStrictEqual, so a member that came back as an explicit `undefined` key
    // rather than being absent would fail: the value must be the SAME value.
    expect(back.drm).toStrictEqual(FULL_DRM);
  });

  it('returns a copy, not a shared reference, for the nested keyIds / licenceUrls', async () => {
    const asset = await makeAsset(FULL_DRM);
    const back = fromAssetDocument(AssetDocumentSchema.parse(toAssetDocument(asset)));
    expect(back.drm?.keyIds).not.toBe(FULL_DRM.keyIds);
    expect(back.drm?.keyIds[0]).not.toBe(FULL_DRM.keyIds[0]);
    expect(back.drm?.licenceUrls).not.toBe(FULL_DRM.licenceUrls);
    expect(back.drm?.systems).not.toBe(FULL_DRM.systems);
  });

  it('round-trips a minimal AssetDrm with every optional member absent', async () => {
    const minimal: AssetDrm = {
      status: 'pending',
      providerId: 'primary',
      scheme: 'cenc',
      systems: ['widevine'],
      keyIds: [],
      requestedAt: '2026-11-01T10:00:00.000Z'
    };
    const asset = await makeAsset(minimal);
    const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
    // No `"protectedAt": undefined`-style keys land in the document.
    expect(Object.keys(doc.structural.drm ?? {}).sort()).toEqual([
      'keyIds',
      'providerId',
      'requestedAt',
      'scheme',
      'status',
      'systems'
    ]);
    expect(fromAssetDocument(doc).drm).toStrictEqual(minimal);
  });

  it('persists NO key material — only key identifiers (ADR-008 D4)', async () => {
    const asset = await makeAsset({
      ...FULL_DRM,
      // A caller smuggling a content key onto the object must not reach the
      // document: the mapper copies contracted members only, and Zod strips
      // anything unknown on top of that.
      ...({ key: 'AAECAwQFBgcICQoLDA0ODw==', iv: '00112233445566778899aabbccddeeff' } as object)
    } as AssetDrm);
    const serialised = JSON.stringify(AssetDocumentSchema.parse(toAssetDocument(asset)));
    expect(serialised).not.toContain('AAECAwQFBgcICQoLDA0ODw==');
    expect(serialised).not.toContain('"key"');
    expect(serialised).not.toContain('"iv"');
    // The identifiers themselves are still there.
    expect(serialised).toContain('6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70');
  });

  it('rejects a document whose structural.drm.status is not in the enum', async () => {
    const asset = await makeAsset(FULL_DRM);
    const doc = toAssetDocument(asset) as unknown as {
      structural: { drm: { status: string } };
    };
    doc.structural.drm.status = 'encrypted';
    const result = AssetDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('status');
  });

  it('rejects out-of-enum scheme, system and trackGroup values', async () => {
    const base = await makeAsset(FULL_DRM);
    const bad: Record<string, unknown>[] = [
      { scheme: 'cbc1' },
      { systems: ['widevine', 'somethingelse'] },
      { keyIds: [{ trackGroup: 'UHD2', keyId: 'x' }] },
      { errorCode: 'provider_exploded' }
    ];
    for (const override of bad) {
      const doc = toAssetDocument(base) as unknown as {
        structural: { drm: Record<string, unknown> };
      };
      doc.structural.drm = { ...doc.structural.drm, ...override };
      expect(AssetDocumentSchema.safeParse(doc).success).toBe(false);
    }
  });

  it('accepts a pre-existing document that has no structural.drm field', async () => {
    const asset = await makeAsset();
    const doc = toAssetDocument(asset);
    expect('drm' in doc.structural).toBe(false);
    const parsed = AssetDocumentSchema.parse(doc);
    expect(parsed.structural.drm).toBeUndefined();
    expect(fromAssetDocument(parsed).drm).toBeUndefined();
  });
});

describe('ADR-008 D9 kill switch: DRM_ENABLED off (issue #1259)', () => {
  it('writes no drm key to the document with DRM_ENABLED unset (the default)', async () => {
    const asset = await makeAsset(FULL_DRM);
    const doc = toAssetDocument(asset);
    expect('drm' in doc.structural).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('drm');
    // And the document is still a valid v1 document.
    expect(AssetDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('writes no drm key with DRM_ENABLED=false explicitly', async () => {
    process.env['DRM_ENABLED'] = 'false';
    const asset = await makeAsset(FULL_DRM);
    expect('drm' in toAssetDocument(asset).structural).toBe(false);
  });

  it('does not read back a drm block left by an earlier flag-on run', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const asset = await makeAsset(FULL_DRM);
    const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
    expect(doc.structural.drm).toBeDefined();
    process.env['DRM_ENABLED'] = 'false';
    expect(fromAssetDocument(doc).drm).toBeUndefined();
  });

  it('leaves a pre-existing document round-trip untouched with the flag off', async () => {
    const asset = await makeAsset();
    const doc = toAssetDocument(asset);
    expect(fromAssetDocument(AssetDocumentSchema.parse(doc)).drm).toBeUndefined();
  });
});

describe('ADR-008 §8 PipelineExecution.drm (issue #1259)', () => {
  it('records the per-execution DRM request with DRM_ENABLED=true', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const repo = new InMemoryPipelineRepository();
    const execution = await repo.create({
      assetId: 'asset-1',
      pipelineName: 'full',
      steps: ['transcode'],
      drm: { requested: true, providerId: 'primary', systems: ['widevine'], scheme: 'cbcs' }
    });
    expect(execution.drm).toStrictEqual({
      requested: true,
      providerId: 'primary',
      systems: ['widevine'],
      scheme: 'cbcs'
    });
    const read = await repo.get(execution.id);
    expect(read?.drm).toStrictEqual(execution.drm);
    // Cloned out of the store, like resolvedOutputLocation.
    expect(read?.drm).not.toBe(execution.drm);
  });

  it('accepts a bare request with no per-execution overrides', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const repo = new InMemoryPipelineRepository();
    const execution = await repo.create({
      assetId: 'asset-1',
      pipelineName: 'full',
      steps: ['transcode'],
      drm: { requested: true }
    });
    expect(execution.drm).toStrictEqual({ requested: true });
  });

  it('drops the request entirely with DRM_ENABLED off (the default)', async () => {
    const repo = new InMemoryPipelineRepository();
    const execution = await repo.create({
      assetId: 'asset-1',
      pipelineName: 'full',
      steps: ['transcode'],
      drm: { requested: true, providerId: 'primary' }
    });
    expect('drm' in execution).toBe(false);
    expect(await repo.get(execution.id)).toBeDefined();
    expect((await repo.get(execution.id))?.drm).toBeUndefined();
  });

  it('leaves an execution created without a DRM request unchanged', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const repo = new InMemoryPipelineRepository();
    const execution = await repo.create({
      assetId: 'asset-1',
      pipelineName: 'full',
      steps: ['transcode'],
      destinationBucket: 'packaged-bucket/'
    });
    expect('drm' in execution).toBe(false);
    expect(execution.destinationBucket).toBe('packaged-bucket/');
  });
});
