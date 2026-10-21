// Unit tests for the pre-dispatch transcode source readiness check (issue
// #1059).
//
// The failure these lock down: the asset is `ready`, execute is accepted, and
// the transcode fails ~2 minutes later with an opaque probe 404 because the
// source object is gone from the bucket named in the job input (#1057 / #1058).
// The check must turn that into an immediate, actionable refusal that NAMES the
// bucket, the key and the storage endpoint.
//
// Contract sources (CLAUDE.md rule 7):
//   - `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//     string } | undefined>`, `undefined` == NotFound (src/data/storage.ts:
//     136-146). The fakes below implement exactly that `{ size }` subset.
//   - The location under test is the transcoder's only input,
//     `s3://${sourceBucket}/${sourceObjectKey}` (src/pipeline/transcode.ts:120)
//     -> `EncoreSubmitInput.inputUri` (src/pipeline/encore-client.ts:25) ->
//     `inputs: [{ uri, type: 'AudioVideo' }]` (encore-client.ts:95).

import { describe, it, expect } from 'vitest';

import {
  checkTranscodeSourceReadable,
  type SourceStatReader,
  type TranscodeSourceTarget
} from './source-readiness.js';

// Minimal stat reader over a key -> size map. A key that is not in the map stats
// as `undefined`, mirroring WorkspaceStorage.statObject's NotFound behaviour.
function fakeStore(objects: Record<string, number>): SourceStatReader {
  return {
    async statObject(objectKey: string) {
      if (Object.prototype.hasOwnProperty.call(objects, objectKey)) {
        return { size: objects[objectKey]! };
      }
      return undefined;
    }
  };
}

const TARGET: TranscodeSourceTarget = {
  bucket: 'openvideocore-source',
  objectKey: 'sources/asset-1.mxf',
  endpoint: 'https://store-abc.minio-minio.auto.prod.example.io'
};

describe('checkTranscodeSourceReadable — object present', () => {
  it('reports readable with the observed size when the object exists and is non-empty', async () => {
    const readiness = await checkTranscodeSourceReadable(
      TARGET,
      fakeStore({ 'sources/asset-1.mxf': 251_658_240 })
    );
    expect(readiness).toEqual({ readable: true, sizeBytes: 251_658_240 });
  });

  it('reports readable when the observed size MATCHES the size recorded at ingest completion', async () => {
    const readiness = await checkTranscodeSourceReadable(
      { ...TARGET, expectedSizeBytes: 251_658_240 },
      fakeStore({ 'sources/asset-1.mxf': 251_658_240 })
    );
    expect(readiness).toEqual({ readable: true, sizeBytes: 251_658_240 });
  });
});

describe('checkTranscodeSourceReadable — deleted / missing source object (#1057 / #1058)', () => {
  it('reports `absent` and names the bucket, key and endpoint when the object was deleted', async () => {
    // The object store no longer holds the key the asset records — exactly the
    // reported failure, caught BEFORE the job is submitted.
    const readiness = await checkTranscodeSourceReadable(TARGET, fakeStore({}));
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.reason).toBe('absent');
    expect(readiness.message).toContain('sources/asset-1.mxf');
    expect(readiness.message).toContain('openvideocore-source');
    expect(readiness.message).toContain('store-abc.minio-minio.auto.prod.example.io');
  });

  it('reports `empty` when the key exists but the object is zero-length', async () => {
    const readiness = await checkTranscodeSourceReadable(
      TARGET,
      fakeStore({ 'sources/asset-1.mxf': 0 })
    );
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.reason).toBe('empty');
    expect(readiness.sizeBytes).toBe(0);
    expect(readiness.message).toContain('zero-length');
  });

  it('still names the bucket and key when no storage endpoint is resolvable (env-override path)', async () => {
    const { endpoint: _endpoint, ...noEndpoint } = TARGET;
    const readiness = await checkTranscodeSourceReadable(noEndpoint, fakeStore({}));
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.message).toContain('sources/asset-1.mxf');
    expect(readiness.message).toContain('openvideocore-source');
    expect(readiness.message).toContain('the configured storage endpoint');
  });
});

describe('checkTranscodeSourceReadable — size does not match the recorded size', () => {
  it('reports `size-mismatch` naming both sizes when the stored object is truncated', async () => {
    const readiness = await checkTranscodeSourceReadable(
      { ...TARGET, expectedSizeBytes: 251_658_240 },
      // Partially-written / replaced object: present, non-empty, wrong length.
      fakeStore({ 'sources/asset-1.mxf': 15_728_640 })
    );
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.reason).toBe('size-mismatch');
    expect(readiness.sizeBytes).toBe(15_728_640);
    expect(readiness.message).toContain('15728640');
    expect(readiness.message).toContain('251658240');
    expect(readiness.message).toContain('openvideocore-source');
  });

  it('does not treat a recorded size of 0 as a mismatch (no size was really recorded)', async () => {
    const readiness = await checkTranscodeSourceReadable(
      { ...TARGET, expectedSizeBytes: 0 },
      fakeStore({ 'sources/asset-1.mxf': 1024 })
    );
    expect(readiness).toEqual({ readable: true, sizeBytes: 1024 });
  });
});

describe('checkTranscodeSourceReadable — the object store cannot be asked', () => {
  it('reports `probe-failed` (never readable) when the stat throws', async () => {
    const store: SourceStatReader = {
      async statObject() {
        throw new Error('connection refused');
      }
    };
    const readiness = await checkTranscodeSourceReadable(TARGET, store);
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.reason).toBe('probe-failed');
    expect(readiness.message).toContain('sources/asset-1.mxf');
  });

  it('reports `probe-failed` on the bounded deadline instead of hanging the submission', async () => {
    const store: SourceStatReader = {
      statObject() {
        // Never settles: without the bounded deadline this would stall the
        // request until the inbound socket is dropped.
        return new Promise(() => {});
      }
    };
    const readiness = await checkTranscodeSourceReadable(TARGET, store, { timeoutMs: 5 });
    expect(readiness.readable).toBe(false);
    if (readiness.readable) throw new Error('expected an unreadable source');
    expect(readiness.reason).toBe('probe-failed');
    expect(readiness.message).toContain('statObject openvideocore-source/sources/asset-1.mxf');
  });
});
