// Regression test for issue #279.
//
// extractTechnicalMetadata is fire-and-forget: on a genuine extraction failure
// it records `technicalMetadataError` and MUST NOT change the asset's lifecycle
// state. Before #279 its asset write went straight to CouchDB with a single
// carried `_rev`, so a concurrent thumbnail write landing between the read and
// the put produced a `Document update conflict.` (HTTP 409). That 409 was
// swallowed by the extractor's catch and recorded as a terminal
// `technicalMetadataError: "Document update conflict."`, wedging the asset in
// `processing` even though extraction had actually succeeded.
//
// #279 routes the CouchAssetRepository read-modify-write through the shared
// conflict-retry wrapper (updateWithRetry, src/data/couchdb.ts). This test
// reproduces the concurrent thumbnail + metadata write race against a CouchDB
// test double that enforces CouchDB's real optimistic-concurrency rule (a put
// with a stale `_rev` is rejected with a 409) and asserts:
//   1. the metadata write survives the conflicting thumbnail write (retry), so
//      the asset reaches `ready` with intact technicalMetadata AND thumbnails,
//      and never records `technicalMetadataError: "Document update conflict."`;
//   2. a genuine extraction failure still records technicalMetadataError and
//      leaves the lifecycle status untouched (lifecycle-neutral error path).

import { describe, it, expect } from 'vitest';

import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';
import {
  extractTechnicalMetadata,
  type FfprobeResult,
  type ProbeRunner
} from '../src/pipeline/metadata-extractor.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// A nano-shaped CouchDB update conflict, matching the real RequestError nano
// throws from db.insert on a stale write (verified against nano.d.ts in #278):
//   { statusCode: 409, error: 'conflict', reason: 'Document update conflict.' }
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

// A stateful StackCouch test double that enforces CouchDB's optimistic
// concurrency: a put carrying a `_rev` that does not match the currently stored
// `_rev` is rejected with a 409, exactly like the real server. Revs advance
// monotonically on every accepted write. Only the StackCouch surface the
// repository exercises (get/put/find/count) is implemented.
class FakeConcurrentCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private revCounter = 0;
  // A one-shot hook fired immediately before the NEXT put commits. Used to inject
  // a concurrent writer that advances the stored _rev between the repository's
  // read and its write, deterministically reproducing the lost-revision race
  // (no reliance on async scheduling order).
  private beforeNextPut?: () => Promise<void>;

  onceBeforeNextPut(hook: () => Promise<void>): void {
    this.beforeNextPut = hook;
  }

  async get(id: string): Promise<StoredDoc | undefined> {
    const doc = this.docs.get(id);
    return doc ? { ...doc } : undefined;
  }

  async put(id: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const hook = this.beforeNextPut;
    if (hook) {
      // Consume the hook first so the interposed write it performs does not
      // re-enter it (that would recurse forever).
      this.beforeNextPut = undefined;
      await hook();
    }
    const incomingRev = body['_rev'] as string | undefined;
    const current = this.docs.get(id);
    // CouchDB rejects a stale write: the incoming _rev must match the stored one
    // (or be absent for a brand-new document).
    if (current && current._rev !== incomingRev) {
      throw conflictError();
    }
    this.revCounter += 1;
    const rev = `${this.revCounter}-rev`;
    const { _rev: _ignored, ...rest } = body;
    const stored: StoredDoc = {
      ...(rest as Record<string, unknown>),
      _id: id,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? current?.resourceType ?? 'asset')
    };
    this.docs.set(id, stored);
    return { id, rev };
  }

  async find(): Promise<StoredDoc[]> {
    // Only used by create() for the slug-uniqueness probe; nothing is ever taken.
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }
}

function fakeCouch(): { couch: StackCouch & FakeConcurrentCouch; impl: FakeConcurrentCouch } {
  const impl = new FakeConcurrentCouch();
  return { couch: impl as unknown as StackCouch & FakeConcurrentCouch, impl };
}

// Minimal fake storage: only presignedGet is exercised by the extractor.
function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: async (key: string) => `https://minio.example/${key}?sig=abc`
  } as unknown as WorkspaceStorage;
}

const PROBE_OK: FfprobeResult = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '10' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ],
  format: { format_name: 'mov,mp4,m4a', duration: '10', bit_rate: '4000000' }
};

describe('extractTechnicalMetadata conflict-retry (issue #279)', () => {
  it('survives a concurrent thumbnail write and reaches ready (no terminal conflict)', async () => {
    const { couch } = fakeCouch();
    const repo = new CouchAssetRepository(() => couch);

    // Seed an asset that has a stored object and is mid-processing.
    const asset = await repo.create({ name: 'clip', objectKey: 'sources/clip.mp4' });
    await repo.update(asset.id, { status: 'processing' });

    // Arm the race: right before the metadata extraction's put commits (so AFTER
    // its read of the current _rev), a concurrent thumbnail write lands and
    // advances the stored _rev. The extractor's first put therefore carries a
    // now-stale _rev and hits a 409 — the exact lost-revision race #279 fixes.
    // Without the retry wrapper this 409 would be swallowed and recorded as a
    // terminal technicalMetadataError, wedging the asset in `processing`.
    let thumbnailsWritten = false;
    couch.onceBeforeNextPut(async () => {
      await repo.update(asset.id, { thumbnails: ['thumbnails/clip/thumb_0s.jpg'] });
      thumbnailsWritten = true;
    });

    const probe: ProbeRunner = async () => PROBE_OK;

    let recordedError: unknown;
    await extractTechnicalMetadata(
      { assetId: asset.id, objectKey: 'sources/clip.mp4' },
      {
        assets: repo,
        storage: fakeStorage(),
        probe,
        onError: (err) => {
          recordedError = err;
        }
      }
    );

    expect(thumbnailsWritten).toBe(true);

    const after = await repo.get(asset.id);
    // The metadata write won after retry: extraction succeeded end-to-end.
    expect(after?.technicalMetadata?.codec).toBe('h264');
    // The concurrent thumbnail write was NOT clobbered by the retry re-read.
    expect(after?.thumbnails).toEqual(['thumbnails/clip/thumb_0s.jpg']);
    // The success path drives status to ready — the asset is not wedged.
    expect(after?.status).toBe('ready');
    // Crucially: extraction did NOT record a terminal update-conflict error.
    expect(after?.technicalMetadataError).toBeUndefined();
    expect(recordedError).toBeUndefined();
  });

  it('keeps the genuine-failure error path lifecycle-neutral', async () => {
    const { couch } = fakeCouch();
    const repo = new CouchAssetRepository(() => couch);

    const asset = await repo.create({ name: 'clip', objectKey: 'sources/clip.mp4' });
    await repo.update(asset.id, { status: 'processing' });

    // A genuine extraction failure (not a conflict): the probe throws.
    const probe: ProbeRunner = async () => {
      throw new Error('ffprobe job failed: container exited non-zero');
    };

    await extractTechnicalMetadata(
      { assetId: asset.id, objectKey: 'sources/clip.mp4' },
      { assets: repo, storage: fakeStorage(), probe }
    );

    const after = await repo.get(asset.id);
    // Error recorded, metadata nulled — and lifecycle status left untouched.
    expect(after?.technicalMetadata).toBeNull();
    expect(after?.technicalMetadataError).toContain('ffprobe job failed');
    expect(after?.status).toBe('processing');
  });
});
