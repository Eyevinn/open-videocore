// Regression guard: replacing an asset's source through a DIRECT-TO-STORE path
// must not leave the length recorded by the previous ingest behind (issue #1059,
// review follow-up to PR #1061).
//
// WHY this is the one case the size check could get wrong. Source object keys
// are deterministic per asset — `sourceObjectKey(assetId) = sources/<assetId>`
// (src/routes/asset-upload.ts) — so a re-upload writes the SAME key. The
// recorded-size invariant in the repositories only drops a stale length when the
// patched key DIFFERS, which a same-key replacement never does. Before this fix
// the presigned single-part and multipart finalizes recorded no length at all,
// so a 4096-byte streamed upload followed by a 9000-byte presigned replacement
// left `sourceSizeBytes = 4096` on the asset and every later abr-vod execution
// was refused `409 source_unreadable` — permanently, since no route exposes
// `sourceSizeBytes` for an operator to correct.
//
//   1. PUT /:id/upload streams N bytes (records N).
//   2. The source is REPLACED via the presigned flow (or the multipart flow)
//      with M != N bytes, which the client writes straight to the store.
//   3. POST /:id/execute { abr-vod } must 202 and submit, because the finalize
//      re-recorded the true length M.
//
// Contract sources (CLAUDE.md rule 7):
//   - `sourceObjectKey(assetId)` and the finalize routes
//     POST /:id/upload-url -> POST /:id/upload-complete,
//     POST /:id/multipart/initiate -> .../complete -> POST /:id/upload-complete
//     (src/routes/asset-upload.ts).
//   - `WorkspaceStorage.putStream(key, stream, opts): Promise<{ etag: string;
//     bytesTransferred: number }>` and
//     `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//     string } | undefined>` — `undefined` is NotFound (src/data/storage.ts:146).
//   - `Asset.sourceSizeBytes` / `UpdateAssetInput.sourceSizeBytes`
//     (src/data/asset-repo.ts).
//   - The verified location is the transcoder's only input,
//     `s3://${sourceBucket}/${sourceObjectKey}` (src/pipeline/transcode.ts)
//     carried as `EncoreSubmitInput.inputUri` (src/pipeline/encore-client.ts).
//   - `BUILT_IN_PIPELINES['abr-vod'] = ['transcode', 'package']`
//     (src/pipeline/pipelines.ts).

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { assetUploadRouter, sourceObjectKey } from '../src/routes/asset-upload.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import type { WorkspaceStorage } from '../src/data/storage.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const SOURCE_BUCKET = 'src-bucket';

// Fake object store shared by the upload router (which writes) and the execute
// route's readiness check (which stats). `write()` stands in for the client's
// direct PUT to a presigned URL — bytes that never transit the API.
class FakeStore {
  readonly objects = new Map<string, number>();
  statObjectFails = false;

  write(key: string, size: number): void {
    this.objects.set(key, size);
  }
  async putStream(
    key: string,
    source: Readable,
    opts: { maxBytes: number; totalBytes?: number; onProgress?: (b: number, t?: number) => void }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    let transferred = 0;
    for await (const chunk of source) {
      transferred += (chunk as Buffer).length;
      opts.onProgress?.(transferred, opts.totalBytes);
    }
    this.objects.set(key, transferred);
    return { etag: 'etag-1', bytesTransferred: transferred };
  }
  async statObject(key: string): Promise<{ size: number; etag: string } | undefined> {
    if (this.statObjectFails) throw new Error('store unreachable');
    const size = this.objects.get(key);
    return size === undefined ? undefined : { size, etag: 'etag-1' };
  }
  async presignedPut(key: string, ttl: number): Promise<string> {
    return `https://store.example/put/${key}?ttl=${ttl}`;
  }
  async initiateMultipartUpload(_key: string): Promise<string> {
    return 'upload-xyz';
  }
  async presignedUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttl: number
  ): Promise<string> {
    return `https://store.example/part/${key}?u=${uploadId}&p=${partNumber}&ttl=${ttl}`;
  }
  async completeMultipartUpload(_key: string, _uploadId: string, _parts: unknown[]) {
    return { etag: 'final-etag' };
  }
  async abortMultipartUpload(_key: string, _uploadId: string): Promise<void> {
    /* no-op */
  }
  async removeObject(_key: string): Promise<void> {
    /* no-op */
  }
  async abortIncompleteMultipartUploads(): Promise<number> {
    return 0;
  }
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  store: FakeStore;
  submitted: EncoreSubmitInput[];
};

async function buildApp(): Promise<Harness> {
  const app = Fastify({ maxParamLength: 500 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Mirrors the production octet-stream parser wiring (src/main.ts) so the
  // proxied PUT reads its body as a stream.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  const submitted: EncoreSubmitInput[] = [];
  const encore: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'internal-1' };
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };

  const assets = new InMemoryAssetRepository();
  const store = new FakeStore();
  const storageFor = () => store as unknown as WorkspaceStorage;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: new InMemoryJobRepository(),
    pipelineRepository: new InMemoryPipelineRepository(),
    encore,
    sourceBucket: SOURCE_BUCKET,
    outputBucket: 'out-bucket',
    storageFor
  });
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    storageFor
  });
  await app.ready();
  return { app, assets, store, submitted };
}

// Step 1 for every case: a streamed upload that DOES record its length.
async function streamedUpload(h: Harness, bytes: number): Promise<string> {
  const asset = await h.assets.create({ name: 'clip' });
  const res = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/assets/${asset.id}/upload`,
    headers: { 'content-length': String(bytes), 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(bytes, 7)
  });
  expect(res.statusCode).toBe(200);
  expect((await h.assets.get(asset.id))?.sourceSizeBytes).toBe(bytes);
  return asset.id;
}

async function execute(h: Harness, assetId: string) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/execute`,
    payload: { pipeline: 'abr-vod', profile: 'program' }
  });
}

describe('replacing the source re-records its length (issue #1059)', () => {
  it('streamed upload then presigned replacement of a DIFFERENT length => 202, submitted', async () => {
    const h = await buildApp();
    const assetId = await streamedUpload(h, 4096);
    const key = sourceObjectKey(assetId);

    // The operator replaces the source through the presigned flow: the client
    // PUTs 9000 bytes straight to the store, to the SAME deterministic key.
    const urlRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/upload-url`
    });
    expect(urlRes.statusCode).toBe(200);
    h.store.write(key, 9000);
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/upload-complete`
    });
    expect(done.statusCode).toBe(200);

    // The finalize must have re-recorded the TRUE length of the replacement.
    expect((await h.assets.get(assetId))?.sourceSizeBytes).toBe(9000);

    const res = await execute(h, assetId);
    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.inputUri).toBe(`s3://${SOURCE_BUCKET}/${key}`);
    await h.app.close();
  });

  it('streamed upload then multipart replacement of a DIFFERENT length => 202, submitted', async () => {
    const h = await buildApp();
    const assetId = await streamedUpload(h, 4096);
    const key = sourceObjectKey(assetId);

    const initiate = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/multipart/initiate`
    });
    expect(initiate.statusCode).toBe(200);
    const uploadId = (initiate.json() as { uploadId: string }).uploadId;
    // Parts land directly in the store; the stitched object is 12_000 bytes.
    h.store.write(key, 12_000);
    const complete = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/multipart/${uploadId}/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'p1' }] }
    });
    expect(complete.statusCode).toBe(200);

    expect((await h.assets.get(assetId))?.sourceSizeBytes).toBe(12_000);

    const res = await execute(h, assetId);
    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.inputUri).toBe(`s3://${SOURCE_BUCKET}/${key}`);
    await h.app.close();
  });

  it('a finalize that cannot stat the object CLEARS the stale length instead of pinning it', async () => {
    // The length is unknowable at finalize (store unreachable for the stat). The
    // asset must fall back to "no recorded size" — presence only — rather than
    // keep a length that describes the object that was just replaced.
    const h = await buildApp();
    const assetId = await streamedUpload(h, 4096);
    const key = sourceObjectKey(assetId);

    h.store.write(key, 9000);
    h.store.statObjectFails = true;
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/upload-complete`
    });
    expect(done.statusCode).toBe(200);
    expect((await h.assets.get(assetId))?.sourceSizeBytes).toBeUndefined();

    // With the store reachable again the presence check passes and the size
    // comparison is skipped, so the replacement transcodes.
    h.store.statObjectFails = false;
    const res = await execute(h, assetId);
    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    await h.app.close();
  });
});
