// Regression: a retried URL pull must not resume the multipart upload its failed
// attempt left open (issue #1088, spun out of #1058).
//
// The defect: a pull that dies mid-stream leaves the multipart upload open
// server-side, and nothing used to clear it. The storage client's streaming
// write looks for an existing upload for the same key before it starts
// (`findUploadId` + `listParts`) and resumes it, but on that resume path it
// increments its part counter BEFORE using it in the part request
// (node_modules/minio/dist/esm/internal/client.mjs:1480 vs :1486), so its part
// numbers are keyed one off the numbers the server staged the parts under. A
// chunk whose bytes happen to repeat the previous chunk's then matches the
// WRONG staged part, is "resumed" instead of uploaded, and the object is
// assembled from a duplicated part — a silent content-corruption risk on any
// source large enough to go multipart.
//
// The fix under test is in our code, not upstream: the worker discards the
// orphaned upload before the next attempt (`WorkspaceStorage
// .abortIncompleteMultipartUploads`), so every attempt starts from a fresh
// uploadId and the resume path is never entered.
//
// This runs the REAL storage client and the REAL WorkspaceStorage against an
// in-process S3-compatible store that implements the multipart protocol
// (test/s3-multipart-store.ts) — the numbering bug lives inside the client, so
// a faked WorkspaceStorage could not see it.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `runPull(params: PullParams, deps)` with `deps.storage: WorkspaceStorage`
//     and `deps.openS3` (from `SourceDeps`) — src/pipeline/url-pull-worker.ts:119
//     and src/pipeline/source.ts:122-127. `MAX_ATTEMPTS = 3` —
//     src/pipeline/url-pull-worker.ts:47.
//   - `new WorkspaceStorage(client, bucket)` — src/data/storage.ts:118;
//     `abortIncompleteMultipartUploads(localKey): Promise<number>` —
//     src/data/storage.ts:260; `getObject(localKey): Promise<Readable>` —
//     src/data/storage.ts:164.
//   - `new Client({ endPoint, port, useSSL, accessKey, secretKey, region,
//     partSize })`: `partSize` overrides the computed part size and must be at
//     least 5 MiB — node_modules/minio/dist/esm/internal/client.mjs:144-152;
//     a body larger than the part size takes the multipart path, a body at or
//     below it is written in one PUT — client.mjs:1399-1404.
//   - Wire shapes of the fixture are cited in test/s3-multipart-store.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { WorkspaceStorage } from '../src/data/storage.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { runPull } from '../src/pipeline/url-pull-worker.js';
import {
  startMultipartObjectStore,
  type MultipartObjectStore
} from './s3-multipart-store.js';

const BUCKET = 'open-videocore-source';

// The smallest part size the storage client accepts (client.mjs:148).
const PART_SIZE = 5 * 1024 * 1024;

// A source larger than the computed part size, so the write really goes
// multipart. Parts 1 and 2 are byte-identical and part 3 differs: that is the
// shape that makes the off-by-one resume match the wrong staged part (a run of
// identical blocks is ordinary in media — black frames, silence, padding).
const SOURCE = Buffer.concat([
  Buffer.alloc(PART_SIZE, 0x11),
  Buffer.alloc(PART_SIZE, 0x11),
  Buffer.alloc(2 * 1024 * 1024, 0x22)
]);

// Hand the source over in network-sized chunks rather than one 12 MiB buffer.
// The storage client's block splitter pushes every block it can from a single
// write before the upload loop reads again, and a stream read with no size
// argument returns the WHOLE buffered queue concatenated — so one giant write
// would be uploaded as one oversized part and never exercise multipart part
// numbering at all. A remote source arrives in socket-sized chunks, and so does
// this one.
const WIRE_CHUNK = 64 * 1024;

function sourceStream(): Readable {
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < SOURCE.length; offset += WIRE_CHUNK) {
        yield SOURCE.subarray(offset, Math.min(offset + WIRE_CHUNK, SOURCE.length));
      }
    })()
  );
}

let store: MultipartObjectStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
});

async function readObject(storage: WorkspaceStorage, key: string): Promise<Buffer> {
  const stream = await storage.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe('retried URL pull of a multipart-sized source (issue #1088)', () => {
  it('commits bytes identical to the source after a mid-transfer failure', async () => {
    // Break the SECOND part transfer of the first attempt: part one is already
    // staged, so the failed attempt leaves an upload holding exactly one part —
    // the orphan state that used to be resumed under shifted part numbers.
    store = await startMultipartObjectStore({
      bucket: BUCKET,
      failUploadPart: (seq) => seq === 2
    });

    const client = new MinioClient({
      endPoint: store.host,
      port: store.port,
      useSSL: false,
      accessKey: store.accessKey,
      secretKey: store.secretKey,
      region: store.region,
      partSize: PART_SIZE
    });
    const storage = new WorkspaceStorage(client, BUCKET);

    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await assets.create({ name: 'large-source' });
    const job = await jobs.create({ type: 'ingest-url', assetId: asset.id });
    const objectKey = `ingest/${asset.id}`;

    const attempts: number[] = [];
    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey,
        sourceUrl: `s3://${BUCKET}/remote/large-source.mp4`
      },
      {
        jobs,
        assets,
        storage,
        // A fresh stream over the same bytes per attempt, as a real re-fetch of
        // the remote source would give.
        openS3: async () => ({ stream: sourceStream(), totalBytes: SOURCE.length }),
        sleep: async () => undefined,
        baseBackoffMs: 0,
        onAttemptError: (attempt) => attempts.push(attempt)
      }
    );

    // The first attempt failed mid-transfer; the retry carried the pull to a
    // successful terminal state.
    expect(attempts).toEqual([1]);
    const settled = await jobs.get(job.id);
    expect(settled?.status).toBe('done');
    expect(settled?.bytesTransferred).toBe(SOURCE.length);
    expect((await assets.get(asset.id))?.status).toBe('processing');

    // The committed object is byte-for-byte the source — read back through the
    // real client, not out of the fixture's map.
    const committed = await readObject(storage, objectKey);
    expect(committed.length).toBe(SOURCE.length);
    expect(committed.equals(SOURCE)).toBe(true);

    // The retry started from a fresh upload rather than resuming: two uploads
    // were initiated, the orphan from attempt one was aborted, and the staged
    // part numbers of the successful upload are distinct and ascending.
    const initiated = store.requests.filter((r) => r.op === 'CreateMultipartUpload');
    expect(initiated).toHaveLength(2);
    expect(store.requests.some((r) => r.op === 'AbortMultipartUpload' && r.status === 204)).toBe(
      true
    );
    const completed = store.requests.filter((r) => r.op === 'CompleteMultipartUpload');
    expect(completed.map((r) => r.status)).toEqual([200]);
    const staged = store.requests
      .filter((r) => r.op === 'UploadPart' && r.uploadId === initiated[1]!.uploadId)
      .map((r) => r.partNumber);
    expect(new Set(staged).size).toBe(staged.length);
    expect([...staged].sort((a, b) => a! - b!)).toEqual(staged);

    // Nothing is left holding staged bytes.
    expect(store.liveUploads()).toEqual([]);
  }, 30_000);

  it('leaves no orphaned upload behind when every attempt fails', async () => {
    // Every part transfer breaks, so the pull exhausts MAX_ATTEMPTS. The job
    // fails — and the storage backend must not be left holding staged parts for
    // a later write to resume.
    store = await startMultipartObjectStore({
      bucket: BUCKET,
      failUploadPart: () => true
    });

    const client = new MinioClient({
      endPoint: store.host,
      port: store.port,
      useSSL: false,
      accessKey: store.accessKey,
      secretKey: store.secretKey,
      region: store.region,
      partSize: PART_SIZE
    });
    const storage = new WorkspaceStorage(client, BUCKET);

    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await assets.create({ name: 'large-source' });
    const job = await jobs.create({ type: 'ingest-url', assetId: asset.id });
    const objectKey = `ingest/${asset.id}`;

    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey,
        sourceUrl: `s3://${BUCKET}/remote/large-source.mp4`
      },
      {
        jobs,
        assets,
        storage,
        openS3: async () => ({ stream: sourceStream(), totalBytes: SOURCE.length }),
        sleep: async () => undefined,
        baseBackoffMs: 0
      }
    );

    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect(store.objects.has(objectKey)).toBe(false);
    expect(store.liveUploads()).toEqual([]);
  }, 30_000);
});

describe('WorkspaceStorage.abortIncompleteMultipartUploads (issue #1088)', () => {
  it('aborts the upload the storage client would otherwise resume, and no-ops when there is none', async () => {
    store = await startMultipartObjectStore({ bucket: BUCKET });
    const client = new MinioClient({
      endPoint: store.host,
      port: store.port,
      useSSL: false,
      accessKey: store.accessKey,
      secretKey: store.secretKey,
      region: store.region,
      partSize: PART_SIZE
    });
    const storage = new WorkspaceStorage(client, BUCKET);

    // Nothing in progress: a no-op, and cheap enough to call on every attempt.
    expect(await storage.abortIncompleteMultipartUploads('ingest/none')).toBe(0);

    const uploadId = await storage.initiateMultipartUpload('ingest/orphan');
    expect(store.liveUploads().map((u) => u.uploadId)).toEqual([uploadId]);

    expect(await storage.abortIncompleteMultipartUploads('ingest/orphan')).toBe(1);
    expect(store.liveUploads()).toEqual([]);

    // Uploads for other keys are untouched.
    const keep = await storage.initiateMultipartUpload('ingest/other');
    expect(await storage.abortIncompleteMultipartUploads('ingest/orphan')).toBe(0);
    expect(store.liveUploads().map((u) => u.uploadId)).toEqual([keep]);
  });
});
