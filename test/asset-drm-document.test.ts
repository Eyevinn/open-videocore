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
import { PRESERVED_DRM } from '../src/types/drm.js';

// Common-encryption System IDs. A DRM system is identified by this registered
// UUID and never by a product name (CLAUDE.md rule 1, ADR-008 §5.3).
//
// Contract sources (fetched 2026-11-03):
//   - CPIX 2.3 schema, Dash-Industry-Forum/CPIX@master `XmlSchema/cpix.xsd`:
//     `DRMSystemType/@systemId` is `type="cpix:UUIDType" use="required"`
//     (cpix.xsd:114); `UUIDType` is an `xs:string` restricted to
//     `[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}`
//     (cpix.xsd:6-10).
//   - Allocated values: DASH-IF Content Protection Identifiers registry,
//     https://dashif.org/identifiers/content_protection/ — the three ids below
//     are the registry entries for the three widely deployed key systems, taken
//     verbatim from that table.
const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const SYSTEM_ID_B = '9a04f079-9840-4286-ab92-e65be0885f95';
const SYSTEM_ID_C = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';

// A fully populated AssetDrm — every optional member present, so the round-trip
// test covers the whole ADR-008 §8 shape rather than just the required core.
const FULL_DRM: AssetDrm = {
  status: 'protected',
  providerId: 'primary',
  scheme: 'cbcs',
  systems: [SYSTEM_ID_A, SYSTEM_ID_B, SYSTEM_ID_C],
  keyIds: [
    { trackGroup: 'AUDIO', keyId: '6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70' },
    { trackGroup: 'SD', keyId: '7a2e1b8d-7eaf-4f8b-8b4d-2a3c5e6f7b81' },
    { trackGroup: 'HD', keyId: '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92' },
    { trackGroup: 'UHD1', keyId: '9c403da0-90c1-4bad-ad6f-4c5e70819da3' }
  ],
  licenceUrls: {
    [SYSTEM_ID_A]: 'https://licence.example/a',
    [SYSTEM_ID_B]: 'https://licence.example/b',
    [SYSTEM_ID_C]: 'https://licence.example/c'
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
      systems: [SYSTEM_ID_A],
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
      { systems: [SYSTEM_ID_A, 'somethingelse'] },
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

  // The kill switch must stop the FEATURE, not destroy persisted state. Every
  // CouchDB write seam is toDoc(patch(fromDoc(current))) with no merge of the
  // prior body (src/data/couch-asset-repo.ts update()), so a block the read gate
  // refuses to load would be deleted by the next unrelated write.
  it('writes an already-persisted drm block straight back with the flag off', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const persisted = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(FULL_DRM)));
    expect(persisted.structural.drm).toBeDefined();

    process.env['DRM_ENABLED'] = 'false';
    const back = fromAssetDocument(persisted);
    // Still invisible as domain state...
    expect(back.drm).toBeUndefined();
    // ...but the next write puts the block back byte-for-byte.
    const rewritten = toAssetDocument(back);
    expect(rewritten.structural.drm).toStrictEqual(persisted.structural.drm);
    expect(AssetDocumentSchema.safeParse(rewritten).success).toBe(true);
  });

  it('survives an unrelated patch with the flag off (rename, thumbnails, status)', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const persisted = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(FULL_DRM)));

    process.env['DRM_ENABLED'] = 'false';
    // The shape every patch helper uses: spread the asset, change a field.
    const patched = {
      ...fromAssetDocument(persisted),
      name: 'renamed while the flag was off',
      thumbnails: ['thumbs/asset-1/0001.jpg'],
      status: 'ready' as const
    };
    const rewritten = toAssetDocument(patched);
    expect(rewritten.descriptive.title).toBe('renamed while the flag was off');
    expect(rewritten.structural.drm).toStrictEqual(persisted.structural.drm);

    // And toggling the flag back on finds the asset exactly as it was.
    process.env['DRM_ENABLED'] = 'true';
    expect(fromAssetDocument(AssetDocumentSchema.parse(rewritten)).drm).toStrictEqual(FULL_DRM);
  });

  it('keeps the preserved block out of every string-keyed view of the asset', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const persisted = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(FULL_DRM)));

    process.env['DRM_ENABLED'] = 'false';
    const back = fromAssetDocument(persisted);
    // Routes send the domain object directly (reply.send(asset)), so the carrier
    // must not serialise: JSON.stringify ignores symbol-keyed properties.
    const serialised = JSON.stringify(back);
    expect(serialised).not.toContain('licence.example');
    expect(serialised).not.toContain('6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70');
    expect(serialised).not.toContain('drm');
    // `drm` itself is a declared member, present-but-undefined (and so dropped
    // by JSON.stringify above); what must NOT exist is a string-keyed carrier
    // holding the preserved block.
    expect(back.drm).toBeUndefined();
    expect(Object.values(back)).not.toContainEqual(FULL_DRM);
    // It is reachable only through the symbol, and only for the mappers.
    expect(back[PRESERVED_DRM]).toStrictEqual(FULL_DRM);
  });

  it('preserves nothing for an asset that never had a persisted block', async () => {
    const asset = await makeAsset(FULL_DRM);
    const back = fromAssetDocument(AssetDocumentSchema.parse(toAssetDocument(asset)));
    // Flag off throughout: nothing was ever persisted, so there is nothing to
    // preserve and the in-memory `drm` is still ignored on the way out.
    expect(back[PRESERVED_DRM]).toBeUndefined();
    expect('drm' in toAssetDocument(back).structural).toBe(false);
  });
});

// Validation of the system id and of provider-supplied URLs (review findings 3
// and 4 on PR #1317).
describe('ADR-008 structural.drm field validation (issue #1259)', () => {
  beforeEach(() => {
    process.env['DRM_ENABLED'] = 'true';
  });

  it('round-trips licenceUrls covering only a subset of the requested systems', async () => {
    const subset: AssetDrm = {
      ...FULL_DRM,
      systems: [SYSTEM_ID_A, SYSTEM_ID_B, SYSTEM_ID_C],
      // The provider returned a URL for one of the three requested systems.
      licenceUrls: { [SYSTEM_ID_B]: 'https://licence.example/b' }
    };
    const doc = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(subset)));
    expect(Object.keys(doc.structural.drm?.licenceUrls ?? {})).toEqual([SYSTEM_ID_B]);
    expect(fromAssetDocument(doc).drm).toStrictEqual(subset);
  });

  it('round-trips an empty licenceUrls map distinctly from an absent one', async () => {
    const none: AssetDrm = { ...FULL_DRM, licenceUrls: {} };
    const doc = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(none)));
    expect(doc.structural.drm?.licenceUrls).toStrictEqual({});
    expect(fromAssetDocument(doc).drm?.licenceUrls).toStrictEqual({});
  });

  it('rejects a system id that is not a common-encryption UUID', async () => {
    const base = await makeAsset(FULL_DRM);
    const bad = ['acme-key-system', '', 'edef8ba9-79d6-4ace-a3c8', `urn:uuid:${SYSTEM_ID_A}`];
    for (const value of bad) {
      const doc = toAssetDocument(base) as unknown as {
        structural: { drm: Record<string, unknown> };
      };
      doc.structural.drm = { ...doc.structural.drm, systems: [value] };
      expect(AssetDocumentSchema.safeParse(doc).success).toBe(false);
    }
  });

  it('rejects a licenceUrls key that is not a system id', async () => {
    const doc = toAssetDocument(await makeAsset(FULL_DRM)) as unknown as {
      structural: { drm: Record<string, unknown> };
    };
    doc.structural.drm = {
      ...doc.structural.drm,
      licenceUrls: { 'some-name': 'https://licence.example/x' }
    };
    expect(AssetDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('accepts an upper-case system id (cpix:UUIDType is case-insensitive)', async () => {
    const upper: AssetDrm = { ...FULL_DRM, systems: [SYSTEM_ID_A.toUpperCase()], licenceUrls: {} };
    const doc = AssetDocumentSchema.parse(toAssetDocument(await makeAsset(upper)));
    expect(doc.structural.drm?.systems).toEqual([SYSTEM_ID_A.toUpperCase()]);
  });

  it('rejects a licence or certificate URL that is not an absolute URL', async () => {
    const base = await makeAsset(FULL_DRM);
    const bad: Record<string, unknown>[] = [
      { licenceUrls: { [SYSTEM_ID_A]: '/relative/licence' } },
      { licenceUrls: { [SYSTEM_ID_A]: 'not a url at all' } },
      { certificateUrl: 'app.cer' }
    ];
    for (const override of bad) {
      const doc = toAssetDocument(base) as unknown as {
        structural: { drm: Record<string, unknown> };
      };
      doc.structural.drm = { ...doc.structural.drm, ...override };
      expect(AssetDocumentSchema.safeParse(doc).success).toBe(false);
    }
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
      drm: {
        requested: true,
        providerId: 'primary',
        systems: [SYSTEM_ID_A],
        scheme: 'cbcs'
      }
    });
    expect(execution.drm).toStrictEqual({
      requested: true,
      providerId: 'primary',
      systems: [SYSTEM_ID_A],
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
