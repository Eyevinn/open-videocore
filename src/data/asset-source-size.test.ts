// Recorded ingest size on the asset (issue #1059).
//
// The pre-dispatch source readiness check compares what the object store
// reports NOW against the length we recorded when ingest completed. That only
// works if the length is actually persisted on the asset AND always describes
// the key it is stored next to. This suite pins both.
//
// Contract sources (CLAUDE.md rule 7):
//   - `Asset.sourceSizeBytes?: number` and
//     `UpdateAssetInput.sourceSizeBytes?: number` (src/data/asset-repo.ts).
//   - Persisted slot: `AssetDocument.administrative.storage` =
//     `{ bucket: string; key: string; sizeBytes: number }`
//     (AssetDocumentSchema, src/data/asset-document.ts) — a pre-existing,
//     required-number field, so no schemaVersion bump is involved.
//   - Round-trip functions `toAssetDocument(asset, opts)` /
//     `fromAssetDocument(doc)` (src/data/asset-document.ts).

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository, type Asset } from './asset-repo.js';
import { toAssetDocument, fromAssetDocument } from './asset-document.js';

describe('Asset.sourceSizeBytes persistence (issue #1059)', () => {
  it('round-trips through the asset document', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', objectKey: 'ingest/abc' });
    const updated = await repo.update(created.id, { sourceSizeBytes: 251_658_240 });
    expect(updated?.sourceSizeBytes).toBe(251_658_240);

    const doc = toAssetDocument(updated as Asset);
    expect(doc.administrative.storage?.sizeBytes).toBe(251_658_240);
    expect(fromAssetDocument(doc).sourceSizeBytes).toBe(251_658_240);
  });

  it('reads a pre-#1059 document (sizeBytes 0 placeholder) back as "no recorded size"', async () => {
    // Every document written before this issue stored `sizeBytes: 0` because no
    // caller ever supplied one. That must not be read back as "this source
    // should be zero bytes" — it would make every legacy asset fail the size
    // comparison.
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'legacy', objectKey: 'ingest/legacy' });
    const doc = toAssetDocument(created);
    expect(doc.administrative.storage?.sizeBytes).toBe(0);
    expect(fromAssetDocument(doc).sourceSizeBytes).toBeUndefined();
  });

  it('patching objectKey without a new size CLEARS the recorded size', async () => {
    // The invariant that stops a false size-mismatch: the recorded length
    // belongs to the recorded key, so relocating/replacing the object drops the
    // length with it and the readiness check falls back to presence only.
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', objectKey: 'ingest/abc' });
    await repo.update(created.id, { sourceSizeBytes: 1_000 });

    const relocated = await repo.update(created.id, { objectKey: 'ingest/abc-relocated' });

    expect(relocated?.objectKey).toBe('ingest/abc-relocated');
    expect(relocated?.sourceSizeBytes).toBeUndefined();
  });

  it('patching objectKey WITH a new size keeps the new size', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', objectKey: 'ingest/abc' });
    await repo.update(created.id, { sourceSizeBytes: 1_000 });

    const rewritten = await repo.update(created.id, {
      objectKey: 'ingest/abc-v2',
      sourceSizeBytes: 2_000
    });

    expect(rewritten?.sourceSizeBytes).toBe(2_000);
  });

  it('re-patching the SAME objectKey leaves the recorded size alone', async () => {
    // An idempotent re-write of the same key (e.g. a backfill) is not a
    // relocation and must not discard a perfectly good recorded length.
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', objectKey: 'ingest/abc' });
    await repo.update(created.id, { sourceSizeBytes: 1_000 });

    const same = await repo.update(created.id, { objectKey: 'ingest/abc' });

    expect(same?.sourceSizeBytes).toBe(1_000);
  });
});
