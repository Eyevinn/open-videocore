// ADR-005 four-namespace asset document + ULID + provenance (issues #52, #53).

import { describe, it, expect } from 'vitest';
import {
  InMemoryAssetRepository,
  initialProvenance,
  provenanceForPatch
} from '../src/data/asset-repo.js';
import {
  AssetDocumentSchema,
  ASSET_SCHEMA_VERSION,
  toAssetDocument,
  fromAssetDocument
} from '../src/data/asset-document.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ADR-005 asset document model', () => {
  it('mints a ULID _id, type discriminator, schemaVersion=1, four-namespace shape', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create('workspace-a', { name: 'Clip', tags: ['news'] });
    expect(asset.id).toMatch(ULID_RE);
    const parsed = AssetDocumentSchema.parse(toAssetDocument(asset));
    expect(parsed.type).toBe('asset');
    expect(parsed.schemaVersion).toBe(ASSET_SCHEMA_VERSION);
    expect(parsed._id).toMatch(ULID_RE);
    expect(parsed.descriptive.title).toBe('Clip');
    expect(parsed.descriptive.tags).toEqual(['news']);
    expect(parsed.administrative.source.method).toBe('upload');
    expect(parsed.administrative.provenance.length).toBeGreaterThan(0);
    expect(parsed.structural.renditions).toEqual([]);
    expect('workspaceId' in parsed).toBe(false);
  });

  it('round-trips technical / structural / descriptive namespaces through the mappers', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create('workspace-a', { name: 'Source' });
    await repo.update('workspace-a', created.id, { objectKey: 'sources/x' });
    await repo.update('workspace-a', created.id, {
      technicalMetadata: {
        codec: 'h264', width: 1920, height: 1080, durationSeconds: 12.5,
        bitrateBps: 5_000_000, containerFormat: 'matroska',
        audioTracks: [
          { index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 },
          { index: 2, codec: 'aac', channels: 6, sampleRateHz: 48000 }
        ],
        extractedAt: new Date().toISOString()
      }
    });
    const asset = await repo.update('workspace-a', created.id, {
      manifestUrls: { hls: 'https://x/master.m3u8' }, thumbnails: ['thumbs/0.jpg']
    });
    const parsed = AssetDocumentSchema.parse(
      toAssetDocument(asset!, { storageBucket: 'openvideocore-source', storageSizeBytes: 42 })
    );
    expect(parsed.technical.container).toBe('matroska');
    expect(parsed.technical.durationMs).toBe(12500);
    expect(parsed.technical.video?.[0]?.codec).toBe('h264');
    expect(parsed.technical.audio).toHaveLength(2);
    expect(parsed.administrative.storage).toEqual({
      bucket: 'openvideocore-source', key: 'sources/x', sizeBytes: 42
    });
    expect(parsed.structural.manifests?.hls).toBe('https://x/master.m3u8');
    expect(parsed.structural.thumbnails?.[0]?.objectKey).toBe('thumbs/0.jpg');

    const back = fromAssetDocument(parsed, 'workspace-a');
    expect(back.technicalMetadata?.codec).toBe('h264');
    expect(back.technicalMetadata?.containerFormat).toBe('matroska');
    expect(back.technicalMetadata?.audioTracks).toHaveLength(2);
    expect(back.manifestUrls?.hls).toBe('https://x/master.m3u8');
    expect(back.thumbnails).toEqual(['thumbs/0.jpg']);
    expect(back.objectKey).toBe('sources/x');
  });

  it('records creation provenance and grows the log per namespace write (issue #53)', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create('workspace-a', { name: 'A', sourceMethod: 'url-pull' });
    expect(created.provenance?.[0]).toMatchObject({ by: 'user', op: 'create' });
    const afterState = await repo.update('workspace-a', created.id, { status: 'processing' });
    const ops = (afterState!.provenance ?? []).map((p) => p.op);
    expect(ops).toContain('create');
    expect(ops).toContain('state');
    const afterTech = await repo.update('workspace-a', created.id, { technicalMetadataError: 'boom' });
    expect((afterTech!.provenance ?? []).some((p) => p.op === 'technical' && p.by === 'system')).toBe(true);
  });

  it('classifies patch writers correctly', () => {
    const now = new Date().toISOString();
    expect(provenanceForPatch({ status: 'ready' }, now)).toEqual([
      { at: now, by: 'system', op: 'state', detail: 'ready' }
    ]);
    expect(provenanceForPatch({ name: 'new' }, now)).toEqual([{ at: now, by: 'user', op: 'descriptive' }]);
    expect(provenanceForPatch({ renditions: [] }, now)).toEqual([{ at: now, by: 'system', op: 'rendition' }]);
    expect(initialProvenance(now, 'watch-folder')).toEqual([
      { at: now, by: 'user', op: 'create', detail: 'source=watch-folder' }
    ]);
  });
});
