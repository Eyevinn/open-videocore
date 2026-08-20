// Thumbnail writer conflict-resilience test (issue #280).
//
// The thumbnail writer (pipeline/thumbnail.ts, extractThumbnails) persists its
// result via the AssetRepository.update boundary — deps.assets.update(assetId,
// { thumbnails }). Issue #279 routed CouchAssetRepository.update through the
// shared conflict-retry wrapper (updateWithRetry, src/data/couchdb.ts), so the
// thumbnail write inherits conflict resilience at that boundary.
//
// This test proves that resilience end-to-end THROUGH the real repository: it
// drives extractThumbnails -> CouchAssetRepository.update -> updateWithRetry
// against a fake StackCouch whose put() raises one CouchDB update conflict
// (HTTP 409) on the first attempt — exactly what a concurrent metadata write
// landing between the thumbnail write's read and put would cause — then succeeds
// on retry. The assertion: the thumbnails land, the conflict is not surfaced,
// and the racing metadata write is not lost.
//
// Contract sources verified for this test:
//   - extractThumbnails / ExtractThumbnailsDeps / FrameExtractor
//     (src/pipeline/thumbnail.ts) — the writer under test.
//   - CouchAssetRepository (src/data/couch-asset-repo.ts): update() routes through
//     updateWithRetry; create()/get() use couch.get/put/find.
//   - StackCouch / StoredDoc / isUpdateConflict (src/data/couchdb.ts): the fake
//     couch mirrors get/put/find and the nano 409 conflict shape.

import { describe, it, expect, vi } from 'vitest';

import { CouchAssetRepository } from '../data/couch-asset-repo.js';
import type { StoredDoc, StackCouch } from '../data/couchdb.js';
import type { WorkspaceStorage } from '../data/storage.js';
import { extractThumbnails, thumbnailObjectKey, type FrameExtractor } from './thumbnail.js';

// A nano-shaped CouchDB update conflict (issue #278/#279), matching the real
// RequestError nano throws from db.insert on a stale write. Mirrors the shape
// asserted in src/data/couchdb-update-retry.test.ts.
function conflictError(): Error {
  const err = new Error('Document update conflict.') as Error & {
    statusCode: number;
    error: string;
    reason: string;
  };
  err.statusCode = 409;
  err.error = 'conflict';
  err.reason = 'Document update conflict.';
  return err;
}

// A stateful in-memory StackCouch double. Stores one document per id, bumps a
// monotonic _rev on every accepted put, and rejects a put carrying a stale _rev
// with a 409 (the real CouchDB semantic). `failNextPutFor` injects exactly one
// forced conflict on the next put targeting a given id, simulating a concurrent
// writer (a metadata write) winning the race for the current _rev.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private revCounter = 0;
  private forcedConflictId: string | undefined;

  failNextPutFor(id: string): void {
    this.forcedConflictId = id;
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const doc = this.docs.get(localId);
    return doc ? { ...doc } : undefined;
  }

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const incomingRev = body['_rev'] as string | undefined;
    const existing = this.docs.get(localId);

    if (this.forcedConflictId === localId) {
      // One-shot forced conflict: a concurrent writer advanced the doc's _rev
      // between this writer's read and this put. Clear the flag AND advance the
      // stored _rev so the writer's carried _rev is now genuinely stale — the
      // retry must re-read the new _rev to win.
      this.forcedConflictId = undefined;
      if (existing) {
        this.revCounter += 1;
        this.docs.set(localId, { ...existing, _rev: `${this.revCounter}-rev` });
      }
      throw conflictError();
    }

    // Optimistic concurrency: a put carrying a _rev that does not match the
    // stored one loses with a 409, exactly like CouchDB.
    if (existing && incomingRev !== existing._rev) {
      throw conflictError();
    }

    this.revCounter += 1;
    const rev = `${this.revCounter}-rev`;
    const { _rev: _ignored, ...rest } = body;
    const stored: StoredDoc = {
      ...(rest as Record<string, unknown>),
      _id: localId,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? existing?.resourceType ?? 'asset')
    };
    this.docs.set(localId, stored);
    return { id: localId, rev };
  }

  async find(): Promise<StoredDoc[]> {
    // Only slug-uniqueness / getBySlug use find during create(); an empty result
    // means "slug free", which is all this test needs.
    return [];
  }

  asStackCouch(): StackCouch {
    return this as unknown as StackCouch;
  }
}

// A WorkspaceStorage stub exposing the methods extractThumbnails calls. The
// no-op extractor in this test "writes" every requested frame, so statObject
// reports every key as present — mirroring a successful extraction so the writer
// records all keys (issue #332 record-only-stored verification is satisfied).
function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://example.invalid/get/${key}`),
    presignedPut: vi.fn(async (key: string) => `https://example.invalid/put/${key}`),
    statObject: vi.fn(async (_key: string) => ({ size: 1024, etag: 'etag' }))
  } as unknown as WorkspaceStorage;
}

describe('thumbnail writer conflict resilience (issue #280)', () => {
  it('persists thumbnails through a metadata-write conflict via the retry-enabled boundary', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch.asStackCouch());

    // Seed a real asset document through the repository so the persisted shape is
    // exactly what the writer's update() will read-modify-write.
    const created = await repo.create({ name: 'clip.mp4', objectKey: 'sources/clip.mp4' });

    // Simulate a concurrent metadata write landing first: force the NEXT put on
    // this asset (the thumbnail write's first attempt) to lose with a 409.
    couch.failNextPutFor(created.id);

    // The extractor is a no-op that reports success — the OSC frame job is out of
    // scope here; we exercise the write path, not the frame extraction.
    const extractor = vi.fn<FrameExtractor>(async () => undefined);

    const keys = await extractThumbnails(
      { assetId: created.id, objectKey: created.objectKey!, timecodes: [1, 5] },
      { assets: repo, storage: fakeStorage(), extractor }
    );

    // The extractor ran once for the two requested frames.
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([
      thumbnailObjectKey(created.id, 1),
      thumbnailObjectKey(created.id, 5)
    ]);

    // Despite the injected conflict, the thumbnails were persisted: the boundary
    // refetched the fresh _rev and retried rather than surfacing the 409.
    const after = await repo.get(created.id);
    expect(after?.thumbnails).toEqual(keys);
  });

  it('surfaces the thumbnails write as retried, not as a terminal conflict', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch.asStackCouch());
    const created = await repo.create({ name: 'movie.mov', objectKey: 'sources/movie.mov' });

    couch.failNextPutFor(created.id);
    const extractor = vi.fn<FrameExtractor>(async () => undefined);

    // extractThumbnails does NOT swallow write errors (it throws on failure); a
    // successful resolve here proves the conflict was retried away rather than
    // propagated.
    await expect(
      extractThumbnails(
        { assetId: created.id, objectKey: created.objectKey!, timecodes: [3] },
        { assets: repo, storage: fakeStorage(), extractor }
      )
    ).resolves.toEqual([thumbnailObjectKey(created.id, 3)]);
  });
});
